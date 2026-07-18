//! Reclaim a terminal task's account rent (embeddable marketplace, Batch 1).
//!
//! Neither `complete_task` (via completion_helpers) nor `cancel_task` closes the
//! `Task` PDA itself — they close the escrow + claims and set a terminal status,
//! leaving the `Task` account (and its rent) stranded. `close_task` lets the task
//! creator reclaim that rent once the task is terminal (`Completed` or
//! `Cancelled`), and also closes the leftover `TaskJobSpec` pointer in the same
//! transaction.
//!
//! Escrow handling: most terminal paths (`cancel_task`, completion, and
//! `resolve_dispute`) fully close the escrow PDA before the task becomes terminal,
//! so the caller passes `escrow = None`. The one exception is `expire_dispute`,
//! which marks `escrow.is_closed = true` and drains the funds but does NOT close
//! the escrow account — leaving its rent stranded. For that path the caller passes
//! the still-alive escrow and `close_task` reclaims its rent too (only ever an
//! already-settled `is_closed` escrow, never one still holding funds).
//!
//! Hire/capacity handling: the `hire_record` PDA is ALWAYS a required account (the
//! caller passes the derived `["hire", task]` address even for non-hired tasks,
//! where it is an empty system account). If it is a live program-owned record, the
//! task came from `hire_from_listing`, and `close_task` frees the source listing's
//! `open_jobs` capacity slot and closes the link. Making it required (not optional)
//! is deliberate: a caller cannot skip the decrement to inflate a provider's
//! capacity counter.

use crate::errors::CoordinationError;
use crate::events::TaskClosed;
use crate::state::{
    AgentRegistration, HireRecord, ProtocolConfig, ServiceListing, Task, TaskAttestorConfig,
    TaskEscrow, TaskJobSpec, TaskModeration, TaskStatus, TaskSubmission, TaskValidationConfig,
};
use anchor_lang::prelude::*;

/// Pure guard: a task is closable only in a terminal state with no live workers.
/// Extracted so the terminal-only rule is unit-testable and revert-sensitive.
pub(crate) fn validate_task_closable(status: TaskStatus, current_workers: u8) -> Result<()> {
    require!(
        matches!(status, TaskStatus::Completed | TaskStatus::Cancelled),
        CoordinationError::TaskNotClosable
    );
    // Defensive: a terminal task should never still reference a live worker; on
    // both terminal paths current_workers is driven to 0 before settlement.
    require!(current_workers == 0, CoordinationError::TaskNotClosable);
    Ok(())
}

#[derive(Accounts)]
pub struct CloseTask<'info> {
    #[account(
        mut,
        close = authority,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        constraint = task.creator == authority.key() @ CoordinationError::UnauthorizedTaskAction
    )]
    pub task: Account<'info, Task>,

    /// Optional leftover job-spec pointer for this task. When provided it is closed
    /// alongside the task so its rent is reclaimed too. Bound to this task by seeds
    /// + constraint so a caller cannot close another task's pointer.
    // Boxed: an unboxed `Account<TaskJobSpec>` here deserializes the full struct onto
    // the stack and overflows the 4KB SBF frame of `CloseTask::try_accounts` (the
    // full-surface trampoline accreted several heavy accounts over the feature batches).
    // Box moves the deserialized copy to the heap; all Anchor constraints
    // (mut/seeds/bump/constraint) and close behavior are byte-identical. Mirrors the
    // cancel_task SPL-account boxing fix.
    #[account(
        mut,
        seeds = [b"task_job_spec", task.key().as_ref()],
        bump = task_job_spec.bump,
        constraint = task_job_spec.task == task.key() @ CoordinationError::TaskJobSpecTaskMismatch
    )]
    pub task_job_spec: Option<Box<Account<'info, TaskJobSpec>>>,

    /// Optional still-alive escrow PDA. Only `expire_dispute` leaves the escrow
    /// account open (drained, `is_closed = true`) on a terminal task; provide it
    /// here to reclaim its rent. Bound to this task by seeds + constraint.
    // Boxed for the same SBF stack-frame reason as `task_job_spec` above — moves the
    // deserialized escrow off the stack; constraints and close behavior unchanged.
    #[account(
        mut,
        seeds = [b"escrow", task.key().as_ref()],
        bump = escrow.bump,
        constraint = escrow.task == task.key() @ CoordinationError::InvalidInput
    )]
    pub escrow: Option<Box<Account<'info, TaskEscrow>>>,

    /// Hire link PDA for this task. ALWAYS required — the caller passes the derived
    /// ["hire", task] address even for non-hired tasks (where it is an empty system
    /// account). close_task decides from the on-chain owner whether a live hire must
    /// be settled, so a caller cannot dodge the capacity decrement by omitting it.
    /// CHECK: address is fixed by seeds; live-vs-absent is determined by `owner` in
    /// the handler, and a live record is deserialized + validated there.
    #[account(
        mut,
        seeds = [b"hire", task.key().as_ref()],
        bump
    )]
    pub hire_record: UncheckedAccount<'info>,

    /// Source listing, required when a live hire link is present, so its `open_jobs`
    /// capacity counter can be decremented. Verified against `hire_record.listing`.
    // Boxed for the same SBF stack-frame reason as `task_job_spec` above — moves the
    // deserialized listing off the stack; constraints and the open_jobs/updated_at
    // write-back behavior are unchanged.
    #[account(
        mut,
        seeds = [b"service_listing", listing.provider_agent.as_ref(), listing.listing_id.as_ref()],
        bump = listing.bump
    )]
    pub listing: Option<Box<Account<'info, ServiceListing>>>,

    /// Creator completion bond PDA — REQUIRED + seeds-pinned (audit F12). close_task
    /// REFUSES to close the Task while this is a live program-owned bond, so the Task PDA
    /// (which reclaim_completion_bond needs) can never be destroyed out from under an
    /// unsettled creator bond. The party is the creator, so this PDA is canonically
    /// derivable here. For an already-settled / un-bonded task it is an empty system PDA.
    /// CHECK: address fixed by seeds; liveness checked in the handler.
    #[account(
        seeds = [b"completion_bond", task.key().as_ref(), task.creator.as_ref()],
        bump
    )]
    pub creator_completion_bond: UncheckedAccount<'info>,

    /// Worker completion bond PDA — OPTIONAL (defense-in-depth). close_task cannot
    /// canonically pin this (the worker authority is not recorded on the Task after the
    /// claim closes), so it is checked only when supplied: if a live program-owned bond is
    /// passed, close is REFUSED. The hard guarantee for the worker bond comes from the
    /// Completed settlement paths (accept/auto_accept/complete), which are now required +
    /// pinned so a worker bond can never be live on a Completed task; reclaim_completion_bond
    /// (now also valid on Cancelled) is the worker's permissionless recovery on the cancel
    /// path. CHECK: liveness checked in the handler when present.
    #[account(mut)]
    pub worker_completion_bond: Option<UncheckedAccount<'info>>,

    /// Task creator; receives the reclaimed rent. Mutable to credit lamports.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Protocol config (fix round, FIX 5) — supplies the canonical treasury
    /// pubkey for the deregistered-worker straggler path below. Optional so
    /// existing close paths (no stragglers, or stragglers with live agents)
    /// keep working without it; REQUIRED (fail-closed) whenever a straggler
    /// submission's worker agent is provably closed.
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Option<Box<Account<'info, ProtocolConfig>>>,
}

/// A program-owned, non-tombstoned account at the bond PDA means a completion bond is
/// still live and must be settled (reclaim_completion_bond) before the Task can be closed.
fn completion_bond_is_live(info: &AccountInfo) -> Result<bool> {
    if info.owner != &crate::ID {
        return Ok(false);
    }
    let data = info.try_borrow_data()?;
    // < 8 bytes or the [255; 8] tombstone written by settle_completion_bond => not live.
    Ok(data.len() >= 8 && data[..8] != [255u8; 8])
}

pub fn handler<'info>(ctx: Context<'_, '_, '_, 'info, CloseTask<'info>>) -> Result<()> {
    let clock = Clock::get()?;
    let task_key = ctx.accounts.task.key();
    let task = &ctx.accounts.task;
    require!(task.bump > 0, CoordinationError::CorruptedData);
    // Terminal status is the safety boundary: every path that reaches Completed or
    // Cancelled (cancel_task, completion_helpers, and dispute resolution) closes the
    // escrow + claims first, so a closable task never has an open escrow/claim to
    // orphan. close_task therefore does not take the escrow account (it is already
    // gone) and only reclaims the leftover Task (+ optional TaskJobSpec).
    validate_task_closable(task.status, task.current_workers)?;

    // Audit F12: never close the Task PDA while a completion bond is still live, because
    // reclaim_completion_bond needs a live Task to refund it — closing first would strand
    // the bond principal forever. Force the caller to settle (reclaim) first. The creator
    // bond is canonically seeds-pinned; the worker bond is checked best-effort here and is
    // additionally guaranteed settled by the required+pinned Completed-path settlement.
    require!(
        !completion_bond_is_live(&ctx.accounts.creator_completion_bond.to_account_info())?,
        CoordinationError::TaskHasLiveCompletionBond
    );
    if let Some(worker_bond) = ctx.accounts.worker_completion_bond.as_ref() {
        require!(
            !completion_bond_is_live(&worker_bond.to_account_info())?,
            CoordinationError::TaskHasLiveCompletionBond
        );
    }

    // Audit (2026-07 swarm): a BidExclusive task's book may still hold live bids —
    // each bid locks its bond + rent on a per-bid PDA, and EVERY withdrawal path
    // (expire_bid / cancel_bid) loads the Task by seeds. Closing the Task PDA while
    // any bid is active permanently locks those bidders out of their bonds, with no
    // admin sweep. Require the canonical book (fail-closed when a BidExclusive task
    // omits it) and refuse while it reports active bids — bidders must withdraw
    // first, exactly like the completion-bond liveness guard above. The book rides
    // in remaining_accounts[0] for BidExclusive tasks; the child sweep below skips it.
    let child_start = if task.task_type == crate::state::TaskType::BidExclusive {
        let book_info = ctx
            .remaining_accounts
            .first()
            .ok_or(CoordinationError::BidSettlementAccountsRequired)?;
        require!(
            book_info.owner == &crate::ID,
            CoordinationError::InvalidAccountOwner
        );
        let (expected_book, _) = Pubkey::find_program_address(
            &[b"bid_book", task_key.as_ref()],
            &crate::ID,
        );
        require!(
            book_info.key() == expected_book,
            CoordinationError::InvalidInput
        );
        let book = {
            let data = book_info.try_borrow_data()?;
            crate::state::TaskBidBook::try_deserialize(&mut &data[..])?
        };
        require!(
            book.active_bids == 0,
            CoordinationError::TaskNotClosable
        );
        1
    } else {
        0
    };

    let job_spec_closed = ctx.accounts.task_job_spec.is_some();
    let escrow_closed = ctx.accounts.escrow.is_some();
    // A live hire link is one owned by this program; an empty/absent PDA (non-hired
    // task) is system-owned. The caller cannot omit it (it is a required account).
    let hire_record_closed = ctx.accounts.hire_record.owner == &crate::ID;

    emit!(TaskClosed {
        task_id: task.task_id,
        creator: task.creator,
        status: task.status as u8,
        job_spec_closed,
        escrow_closed,
        hire_record_closed,
        timestamp: clock.unix_timestamp,
    });

    let authority_info = ctx.accounts.authority.to_account_info();

    // Close the optional children in-handler; the Task PDA itself is closed via the
    // `close = authority` account constraint after this returns Ok.
    if let Some(job_spec) = ctx.accounts.task_job_spec.as_ref() {
        job_spec.close(authority_info.clone())?;
    }
    if let Some(escrow) = ctx.accounts.escrow.as_ref() {
        // Only ever reclaim rent from an already-settled escrow; refuse to touch
        // one that still holds undistributed funds (would strand/misdirect them).
        require!(escrow.is_closed, CoordinationError::InvalidInput);
        escrow.close(authority_info.clone())?;
    }
    // If a live hire link is present, free the listing's capacity slot and close the
    // link. Because hire_record is a required, seeds-fixed account, the caller cannot
    // skip this for a hired task — closing the capacity decrement loophole.
    if hire_record_closed {
        let hire_info = ctx.accounts.hire_record.to_account_info();
        let hire = {
            let data = hire_info.try_borrow_data()?;
            HireRecord::try_deserialize(&mut &data[..])?
        };
        require!(hire.task == task_key, CoordinationError::InvalidInput);

        let listing = ctx
            .accounts
            .listing
            .as_mut()
            .ok_or(CoordinationError::InvalidInput)?;
        require!(
            listing.key() == hire.listing,
            CoordinationError::InvalidInput
        );
        // saturating_sub: a capacity counter must never underflow.
        listing.open_jobs = listing.open_jobs.saturating_sub(1);
        listing.updated_at = clock.unix_timestamp;

        // Close the hire link: drain rent to the creator, then zero + tombstone the
        // data (mirrors cancel_task's claim-close pattern). The 0-lamport account is
        // garbage-collected by the runtime at end of transaction.
        let lamports = hire_info.lamports();
        **hire_info.try_borrow_mut_lamports()? = 0;
        **authority_info.try_borrow_mut_lamports()? = authority_info
            .lamports()
            .checked_add(lamports)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        let mut data = hire_info.try_borrow_mut_data()?;
        data.fill(0);
        data[..8].copy_from_slice(&[255u8; 8]);
    }

    // Reclaim rent from any auxiliary child PDAs (task_moderation / task_validation /
    // task_submission / task_attestor) passed via remaining_accounts. Each is bound to
    // THIS task by its stored `task` field, so a caller cannot close an unrelated
    // account; the task is already terminal, so these records are no longer needed.
    //
    // Batch 3 WS-CONTEST §1 (submission-rent return): a straggler `TaskSubmission`
    // was funded by its WORKER, so its rent goes back to the submission's stored
    // worker — the caller must follow each TaskSubmission child with that worker's
    // `AgentRegistration` (resolves agent PDA -> authority wallet) and the writable
    // authority wallet itself, both validated against stored pubkeys. FAIL-CLOSED:
    // if the matching accounts are not supplied the instruction errors — the
    // creator is NEVER paid a worker's submission rent (kills the rent-farming
    // sink where junk tasks harvested ~0.00286 SOL from every submitter).
    let mut idx = child_start;
    while idx < ctx.remaining_accounts.len() {
        let child = &ctx.remaining_accounts[idx];
        idx = idx
            .checked_add(1)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        match classify_task_child(child, &task_key)? {
            TaskChild::CreatorFunded => close_child_to(child, &authority_info)?,
            TaskChild::WorkerSubmission { worker_agent } => {
                let agent_info = ctx
                    .remaining_accounts
                    .get(idx)
                    .ok_or(CoordinationError::SubmissionRentAccountsRequired)?;
                let worker_wallet_info = ctx
                    .remaining_accounts
                    .get(
                        idx.checked_add(1)
                            .ok_or(CoordinationError::ArithmeticOverflow)?,
                    )
                    .ok_or(CoordinationError::SubmissionRentAccountsRequired)?;
                idx = idx
                    .checked_add(2)
                    .ok_or(CoordinationError::ArithmeticOverflow)?;
                close_submission_child_to_worker(
                    child,
                    &worker_agent,
                    agent_info,
                    worker_wallet_info,
                    ctx.accounts
                        .protocol_config
                        .as_ref()
                        .map(|config| config.treasury),
                )?;
            }
        }
    }

    Ok(())
}

/// A recognized auxiliary child of a terminal task, classified by who funded it —
/// which decides who gets its rent back.
enum TaskChild {
    /// Creator-funded records (`TaskModeration` / `TaskValidationConfig` /
    /// `TaskAttestorConfig`): rent returns to the creator, as before.
    CreatorFunded,
    /// A worker-funded `TaskSubmission` straggler: rent returns to the submission's
    /// stored worker (Batch 3 WS-CONTEST §1). Carries the stored worker AGENT PDA
    /// the payee accounts must be validated against.
    WorkerSubmission { worker_agent: Pubkey },
}

/// Identify a child by trying each known type's discriminator, validate it is bound
/// to THIS task, and classify its rent destination. An unrecognized program-owned
/// account (or another task's record) is rejected so a caller cannot close an
/// unrelated account.
fn classify_task_child(child: &AccountInfo, task_key: &Pubkey) -> Result<TaskChild> {
    require!(
        child.owner == &crate::ID,
        CoordinationError::InvalidAccountOwner
    );
    let data = child.try_borrow_data()?;
    let (bound_task, child_kind) = if let Ok(m) = TaskModeration::try_deserialize(&mut &data[..]) {
        (m.task, TaskChild::CreatorFunded)
    } else if let Ok(v) = TaskValidationConfig::try_deserialize(&mut &data[..]) {
        (v.task, TaskChild::CreatorFunded)
    } else if let Ok(s) = TaskSubmission::try_deserialize(&mut &data[..]) {
        (
            s.task,
            TaskChild::WorkerSubmission {
                worker_agent: s.worker,
            },
        )
    } else if let Ok(a) = TaskAttestorConfig::try_deserialize(&mut &data[..]) {
        (a.task, TaskChild::CreatorFunded)
    } else {
        return err!(CoordinationError::InvalidInput);
    };
    require!(bound_task == *task_key, CoordinationError::InvalidInput);
    Ok(child_kind)
}

/// Drain a child's rent to `recipient` and tombstone the account (mirrors the
/// cancel_task claim-close pattern; the 0-lamport account is GC'd at end of tx).
fn close_child_to<'info>(
    child: &AccountInfo<'info>,
    recipient: &AccountInfo<'info>,
) -> Result<()> {
    let lamports = child.lamports();
    **child.try_borrow_mut_lamports()? = 0;
    **recipient.try_borrow_mut_lamports()? = recipient
        .lamports()
        .checked_add(lamports)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let mut data = child.try_borrow_mut_data()?;
    data.fill(0);
    data[..8].copy_from_slice(&[255u8; 8]);
    Ok(())
}

/// Close a straggler `TaskSubmission` to its worker. Every payee is validated
/// against program-owned stored pubkeys (spec invariant 2 — no cranker-supplied
/// account trust): the supplied agent account must BE the submission's stored
/// worker agent, and the writable wallet must BE that agent's stored authority.
///
/// FIX 5 (deregistered-agent orphan): the worker's `AgentRegistration` may have
/// been legitimately closed (`deregister_agent` is allowed once
/// `active_tasks == 0`, while a Rejected quorum-straggler submission survives).
/// The stored agent ADDRESS is still unfakeable, so when the account at that
/// exact address is provably closed (system-owned, zero data) the worker wallet
/// is unrecoverable on-chain — route the rent to the protocol TREASURY
/// (validated against `protocol_config`; NEVER the creator) instead of
/// fail-closing `close_task` permanently.
fn close_submission_child_to_worker<'info>(
    child: &AccountInfo<'info>,
    stored_worker_agent: &Pubkey,
    agent_info: &AccountInfo<'info>,
    worker_wallet_info: &AccountInfo<'info>,
    treasury: Option<Pubkey>,
) -> Result<()> {
    require!(
        agent_info.key() == *stored_worker_agent,
        CoordinationError::SubmissionRentAccountsRequired
    );
    let expected_payee = if agent_info.owner == &crate::ID {
        let data = agent_info.try_borrow_data()?;
        AgentRegistration::try_deserialize(&mut &data[..])
            .map_err(|_| error!(CoordinationError::SubmissionRentAccountsRequired))?
            .authority
    } else if agent_info.owner == &anchor_lang::system_program::ID && agent_info.data_is_empty() {
        // Provably-closed agent at the stored address: the only safe payee is
        // the protocol treasury (fail-closed if protocol_config was omitted).
        treasury.ok_or(CoordinationError::SubmissionRentAccountsRequired)?
    } else {
        return err!(CoordinationError::SubmissionRentAccountsRequired);
    };
    require!(
        worker_wallet_info.key() == expected_payee,
        CoordinationError::SubmissionRentAccountsRequired
    );
    require!(
        worker_wallet_info.is_writable,
        CoordinationError::SubmissionRentAccountsRequired
    );
    close_child_to(child, worker_wallet_info)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_terminal_with_no_workers() {
        assert!(validate_task_closable(TaskStatus::Completed, 0).is_ok());
        assert!(validate_task_closable(TaskStatus::Cancelled, 0).is_ok());
    }

    // Revert-sensitive: removing the terminal-status require! turns these red.
    #[test]
    fn rejects_non_terminal_status() {
        for status in [
            TaskStatus::Open,
            TaskStatus::InProgress,
            TaskStatus::PendingValidation,
            TaskStatus::Disputed,
        ] {
            assert!(validate_task_closable(status, 0).is_err());
        }
    }

    // Revert-sensitive: removing the current_workers require! turns this red.
    #[test]
    fn rejects_terminal_with_live_worker() {
        assert!(validate_task_closable(TaskStatus::Completed, 1).is_err());
    }
}
