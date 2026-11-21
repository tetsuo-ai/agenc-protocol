//! Clean up a terminal task and compact it into a 56-byte `TaskMarker`.
//!
//! Revision 9 (C): `close_task` on a terminal `Task` closes every supplied child,
//! frees hired-listing capacity, and then compacts the Task in place into a
//! `TaskMarker` at the same address. The creator gets back every lamport above
//! the marker's rent minimum. The marker keeps what the full tombstone protected:
//! - It is a program-owned account at the task PDA, so `init` of a Task with the
//!   same id keeps failing, and every `Account<Task>` loader rejects its
//!   discriminator, so no new child can attach to it.
//! - Children whose exits need a parent keep one. A task can have children whose
//!   addresses are not enumerable from the `Task` (historical submissions and
//!   per-hash/per-moderator attestations). Later `close_task` passes accept the
//!   marker and sweep them, `reclaim_completion_bond` accepts it, and
//!   `reclaim_orphan_task_child` treats it as a closed parent.
//! - Exits that still need the full Task block compaction while they can run:
//!   live claims, a pending worker slash, peer settlement, live bids, and a live
//!   creator completion bond.
//!
//! The task account is loaded by hand (`load_task_or_marker`): a Task, checked
//! at its canonical PDA with its stored bump, is closed and compacted; a
//! TaskMarker is swept only; anything else fails with `InvalidTaskMarker`. Both
//! forms must belong to the signer.
//!
//! Escrow handling: SOL terminal paths and `expire_dispute` close the escrow PDA,
//! so the caller normally passes `escrow = None` for a SOL task. A settled escrow
//! left out of the compacting call is closed on the marker later (review R3-1). `resolve_dispute`
//! deliberately retains a token task's `TaskEscrow` state while token-slash
//! settlement is being distinguished from an already-settled token outcome. Once
//! that account is drained and marked `is_closed = true`, it is closed here. A
//! token-reward task must pass its canonical escrow address before it can be
//! compacted (`TaskNotCompactable` otherwise), so a retained escrow can never be
//! stranded: a live closed escrow is closed in the same call, and an empty
//! address proves it is already gone. A pending reserve remains
//! `is_closed = false` and cannot be reclaimed until the required slash finalizer
//! has settled it.
//!
//! Hire/capacity handling: the `hire_record` PDA is ALWAYS a required account (the
//! caller passes the derived `["hire", task]` address even for non-hired tasks,
//! where it is an empty system account). If it is a live program-owned record, the
//! task came from `hire_from_listing`, and `close_task` frees the source listing's
//! `open_jobs` capacity slot and closes the link. Making it required (not optional)
//! is deliberate: a caller cannot skip the decrement to inflate a provider's
//! capacity counter.
//!
//! Runtime order: this instruction makes no CPI. Every lamport moves directly,
//! and the compaction (resize, marker write, surplus refund) runs last.

use crate::errors::CoordinationError;
use crate::events::{TaskClosed, TaskCompacted};
use crate::instructions::program_account_helpers::{
    close_program_account, deserialize_program_account,
};
use crate::instructions::task_parent_helpers::{load_task_or_marker, TaskOrMarker};
use crate::state::{
    AgentRegistration, HireRecord, ProtocolConfig, ServiceListing, Task, TaskAttestorConfig,
    TaskEscrow, TaskJobSpec, TaskMarker, TaskModeration, TaskStatus, TaskSubmission,
    TaskValidationConfig,
};
use anchor_lang::prelude::*;

const CLOSED_ACCOUNT_TOMBSTONE: [u8; 8] = [255u8; 8];

/// Pure guard: a task is closable only in a terminal state with no live workers.
/// Extracted so the terminal-only rule is unit-testable and revert-sensitive.
pub(crate) fn validate_task_closable(
    status: TaskStatus,
    current_workers: u8,
    worker_slash_pending: bool,
) -> Result<()> {
    require!(
        matches!(status, TaskStatus::Completed | TaskStatus::Cancelled),
        CoordinationError::TaskNotClosable
    );
    // Defensive: a terminal task should never still reference a live worker; on
    // both terminal paths current_workers is driven to 0 before settlement.
    require!(current_workers == 0, CoordinationError::TaskNotClosable);
    require!(!worker_slash_pending, CoordinationError::ClaimSlashPending);
    Ok(())
}

/// Revision 9 (C) compaction preconditions, checked after `validate_task_closable`.
/// Peers that are still settling need the full Task, and a token-reward task must
/// pass its canonical escrow address so a retained `TaskEscrow` closes in the same
/// call instead of losing its parent.
pub(crate) fn validate_task_compactable(
    peer_settlement_pending: bool,
    token_reward: bool,
    escrow_passed: bool,
) -> Result<()> {
    require!(
        !peer_settlement_pending,
        CoordinationError::TaskNotCompactable
    );
    require!(
        !token_reward || escrow_passed,
        CoordinationError::TaskNotCompactable
    );
    Ok(())
}

/// A live HireRecord consumes exactly one listing-capacity slot. Underflow is
/// state corruption, not an idempotent cleanup condition: silently clamping to
/// zero would close the only durable link and permanently hide the mismatch.
fn decrement_listing_open_jobs(open_jobs: u16) -> Result<u16> {
    open_jobs
        .checked_sub(1)
        .ok_or_else(|| error!(CoordinationError::ArithmeticOverflow))
}

/// LiteSVM deliberately retains drained account images, and a zero-lamport
/// account can remain observable until runtime cleanup. Treat only the exact
/// tombstone written by this instruction as an already-swept hire link. Any
/// other program-owned image remains live and must deserialize successfully,
/// preserving the fail-closed capacity invariant for malformed state.
fn is_drained_hire_record_tombstone(lamports: u64, data: &[u8]) -> bool {
    lamports == 0
        && data.len() >= CLOSED_ACCOUNT_TOMBSTONE.len()
        && data[..CLOSED_ACCOUNT_TOMBSTONE.len()] == CLOSED_ACCOUNT_TOMBSTONE
}

#[derive(Accounts)]
pub struct CloseTask<'info> {
    /// The task PDA `["task", creator, task_id]`: a terminal Task (closed and
    /// compacted by this call) or the TaskMarker an earlier close left there.
    /// It is loaded by hand in the handler (`load_task_or_marker`): owner,
    /// discriminator, the Task's canonical PDA with its stored bump, and
    /// creator == authority are all checked before anything moves.
    /// CHECK: validated in the handler, as described above.
    #[account(mut)]
    pub task: UncheckedAccount<'info>,

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

    /// Optional escrow PDA. `resolve_dispute` can leave a token task's state
    /// escrow open after draining it and setting `is_closed = true`; provide it
    /// here to reclaim its rent. A pending token reserve is still marked open and
    /// is rejected until its slash finalizer runs. A token-reward task must pass
    /// this address to be compacted; an empty address proves the escrow is gone.
    /// A program-owned account must deserialize as this task's closed
    /// `TaskEscrow`; anything else must be an empty system account.
    /// CHECK: address fixed by seeds; content validated in the handler.
    #[account(
        mut,
        seeds = [b"escrow", task.key().as_ref()],
        bump
    )]
    pub escrow: Option<UncheckedAccount<'info>>,

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
    /// REFUSES to compact the Task while this is a live program-owned bond, so a
    /// bond's parent can never be compacted out from under an unsettled creator
    /// bond. The party is the creator, and the handler requires
    /// `creator == authority`, so the seeds use the signer. For an already-settled
    /// / un-bonded task it is an empty system PDA.
    /// CHECK: address fixed by seeds; liveness checked in the handler.
    #[account(
        seeds = [b"completion_bond", task.key().as_ref(), authority.key().as_ref()],
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

    /// Task creator; receives child rent and every Task lamport above the
    /// marker's rent minimum.
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
    let authority = ctx.accounts.authority.key();
    match load_task_or_marker(&ctx.accounts.task.to_account_info())? {
        TaskOrMarker::Task(task) => {
            require_keys_eq!(
                task.creator,
                authority,
                CoordinationError::UnauthorizedTaskAction
            );
            close_and_compact_task(ctx, task)
        }
        TaskOrMarker::Marker(marker) => {
            require_keys_eq!(
                marker.creator,
                authority,
                CoordinationError::UnauthorizedTaskAction
            );
            sweep_marker_children(ctx)
        }
    }
}

/// Full Task path: today's checks and sweeps, then the compaction.
fn close_and_compact_task<'info>(
    ctx: Context<'_, '_, '_, 'info, CloseTask<'info>>,
    task: Box<Task>,
) -> Result<()> {
    let clock = Clock::get()?;
    let task_info = ctx.accounts.task.to_account_info();
    let task_key = task_info.key();
    // Terminal status and zero live workers are the cleanup boundary.
    validate_task_closable(
        task.status,
        task.current_workers,
        task.worker_slash_pending(),
    )?;
    validate_task_compactable(
        task.peer_settlement_pending(),
        task.reward_mint.is_some(),
        ctx.accounts.escrow.is_some(),
    )?;

    // Audit F12: never compact the Task while a completion bond is still live.
    // Force the caller to settle (reclaim) first. The creator bond is canonically
    // seeds-pinned; the worker bond is checked best-effort here and is additionally
    // guaranteed settled by the required+pinned Completed-path settlement. A worker
    // bond that is not derivable here can still be reclaimed against the marker.
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
    // (expire_bid / cancel_bid) loads the Task by seeds. Compacting the Task while
    // any bid is active permanently locks those bidders out of their bonds, with no
    // admin sweep. Require the canonical book (fail-closed when a BidExclusive task
    // omits it) and refuse while it reports active bids — bidders must withdraw
    // first, exactly like the completion-bond liveness guard above. The book rides
    // in remaining_accounts[0] for BidExclusive tasks; the child sweep below skips it
    // (it is closed to the creator explicitly, right after the escrow close).
    let (child_start, bid_book_info) = if task.task_type == crate::state::TaskType::BidExclusive {
        let book_info = ctx
            .remaining_accounts
            .first()
            .ok_or(CoordinationError::BidSettlementAccountsRequired)?;
        let (expected_book, _) =
            Pubkey::find_program_address(&[b"bid_book", task_key.as_ref()], &crate::ID);
        require!(
            book_info.key() == expected_book,
            CoordinationError::InvalidInput
        );
        if book_info.owner == &crate::ID {
            let book = {
                let data = book_info.try_borrow_data()?;
                crate::state::TaskBidBook::try_deserialize(&mut &data[..])?
            };
            require!(book.active_bids == 0, CoordinationError::TaskNotClosable);
            (1, Some(book_info.clone()))
        } else {
            // After an earlier cleanup swept the canonical book, the same PDA is
            // an empty system account.
            require!(
                book_info.owner == &anchor_lang::system_program::ID && book_info.data_is_empty(),
                CoordinationError::InvalidAccountOwner
            );
            (1, None)
        }
    } else {
        (0, None)
    };

    let job_spec_closed = ctx.accounts.task_job_spec.is_some();
    // A live hire link is one owned by this program; an empty/absent PDA (non-hired
    // task) is system-owned. The caller cannot omit it (it is a required account).
    let hire_record_info = ctx.accounts.hire_record.to_account_info();
    let hire_record_live = if hire_record_info.owner == &crate::ID {
        let data = hire_record_info.try_borrow_data()?;
        !is_drained_hire_record_tombstone(hire_record_info.lamports(), &data)
    } else {
        // An absent or merely pre-funded PDA is system-owned with no data. No
        // other owner is a valid representation of the canonical hire link.
        require!(
            hire_record_info.owner == &anchor_lang::system_program::ID
                && hire_record_info.data_is_empty(),
            CoordinationError::InvalidAccountOwner
        );
        false
    };

    let authority_info = ctx.accounts.authority.to_account_info();

    // Close the optional children in-handler. The task address survives as the
    // marker, the durable parent needed by any child omitted from this pass.
    if let Some(job_spec) = ctx.accounts.task_job_spec.as_ref() {
        job_spec.close(authority_info.clone())?;
    }
    let escrow_closed = match ctx.accounts.escrow.as_ref() {
        Some(escrow) => {
            close_settled_escrow(&escrow.to_account_info(), &task_key, &authority_info)?
        }
        None => false,
    };

    emit!(TaskClosed {
        task_id: task.task_id,
        creator: task.creator,
        status: task.status as u8,
        job_spec_closed,
        escrow_closed,
        hire_record_closed: hire_record_live,
        timestamp: clock.unix_timestamp,
    });

    // Sweep the bid book too: the guard above proved active_bids == 0, and the
    // book is creator-funded (initialize_bid_book, payer = creator), so its rent
    // returns to the creator rather than stranding on the terminal task. Same
    // blast radius as compacting the Task itself, which the guard already gates.
    if let Some(book_info) = bid_book_info {
        close_child_to(&book_info, &authority_info)?;
    }
    // If a live hire link is present, free the listing's capacity slot and close the
    // link. Because hire_record is a required, seeds-fixed account, the caller cannot
    // skip this for a hired task — closing the capacity decrement loophole.
    if hire_record_live {
        let hire_info = hire_record_info;
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
        listing.open_jobs = decrement_listing_open_jobs(listing.open_jobs)?;
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
        data[..8].copy_from_slice(&CLOSED_ACCOUNT_TOMBSTONE);
    }

    sweep_task_children(
        ctx.remaining_accounts,
        child_start,
        &task_key,
        task.live_submissions(),
        &authority_info,
        ctx.accounts
            .protocol_config
            .as_ref()
            .map(|config| config.treasury),
    )?;

    // Compaction, last: flags, resize to 56 bytes, write the marker, and return
    // every lamport above the marker's rent minimum to the creator (every create
    // path makes the creator pay the Task rent; old-rate and odd-rate tasks
    // refund everything above the minimum too).
    let mut flags = 0u8;
    if hire_record_live {
        flags |= TaskMarker::FLAG_ENDED_LIVE_HIRE;
    }
    if task.rating_fee_qualified() {
        flags |= TaskMarker::FLAG_FEE_QUALIFIED;
    }
    let marker =
        TaskMarker::for_closed_task(task.creator, task.status, flags, clock.unix_timestamp)?;
    let (refunded_lamports, marker_lamports) =
        compact_task_into_marker(&task_info, &authority_info, &marker)?;

    emit!(TaskCompacted {
        task: task_key,
        creator: task.creator,
        status: marker.status,
        refunded_lamports,
        marker_lamports,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

/// Marker path: the task was compacted by an earlier close. Only children are
/// swept; the listing and hire-record branches are skipped because neither can
/// exist after compaction (each was closed, or proven absent, in the compacting
/// call). A leftover job-spec pointer is still closed when passed, and so is a
/// settled escrow: a SOL task may be compacted without its escrow (review R3-1).
fn sweep_marker_children<'info>(ctx: Context<'_, '_, '_, 'info, CloseTask<'info>>) -> Result<()> {
    let task_key = ctx.accounts.task.key();
    let authority_info = ctx.accounts.authority.to_account_info();
    if let Some(job_spec) = ctx.accounts.task_job_spec.as_ref() {
        job_spec.close(authority_info.clone())?;
    }
    // Review R3-1: live Completed SOL tasks can still keep a settled TaskEscrow,
    // and compaction does not require a SOL task to pass it. The canonical
    // address is seeds-pinned to this task; `close_settled_escrow` closes it to
    // the creator only when it is this task's escrow and `is_closed`.
    if let Some(escrow) = ctx.accounts.escrow.as_ref() {
        close_settled_escrow(&escrow.to_account_info(), &task_key, &authority_info)?;
    }
    // After compaction no exit that needs the full Task can run, so the Task's
    // live-submission counter no longer guards anything; a validation config's
    // own pending count still blocks its sweep.
    sweep_task_children(
        ctx.remaining_accounts,
        0,
        &task_key,
        0,
        &authority_info,
        ctx.accounts
            .protocol_config
            .as_ref()
            .map(|config| config.treasury),
    )
}

/// Close this task's escrow state when it is still open and settled. Returns
/// whether this call closed it. A program-owned account must be this task's
/// `TaskEscrow` with `is_closed`; an empty system account means it is gone.
fn close_settled_escrow<'info>(
    escrow_info: &AccountInfo<'info>,
    task_key: &Pubkey,
    authority_info: &AccountInfo<'info>,
) -> Result<bool> {
    if escrow_info.owner == &crate::ID {
        let escrow: TaskEscrow = deserialize_program_account(escrow_info)?;
        require!(escrow.task == *task_key, CoordinationError::InvalidInput);
        // Only ever reclaim rent from an already-settled escrow; refuse to touch
        // one that still holds undistributed funds (would strand/misdirect them).
        require!(escrow.is_closed, CoordinationError::InvalidInput);
        close_program_account(escrow_info, authority_info)?;
        return Ok(true);
    }
    require!(
        escrow_info.owner == &anchor_lang::system_program::ID && escrow_info.data_is_empty(),
        CoordinationError::InvalidAccountOwner
    );
    Ok(false)
}

/// Compact a closed Task in place: shrink the data to `TaskMarker::SIZE`, write
/// the marker, and move every lamport above the marker's rent minimum to the
/// creator. Returns `(refunded, kept)`.
fn compact_task_into_marker<'info>(
    task_info: &AccountInfo<'info>,
    creator_info: &AccountInfo<'info>,
    marker: &TaskMarker,
) -> Result<(u64, u64)> {
    task_info.resize(TaskMarker::SIZE)?;
    {
        let mut data = task_info.try_borrow_mut_data()?;
        marker.write_to(&mut data)?;
    }
    let kept = Rent::get()?.minimum_balance(TaskMarker::SIZE);
    let refunded = task_info
        .lamports()
        .checked_sub(kept)
        .ok_or(CoordinationError::TaskNotRentExempt)?;
    if refunded > 0 {
        **task_info.try_borrow_mut_lamports()? = kept;
        **creator_info.try_borrow_mut_lamports()? = creator_info
            .lamports()
            .checked_add(refunded)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
    }
    Ok((refunded, kept))
}

/// Reclaim rent from explicitly supplied auxiliary child PDAs. Each child is
/// bound to THIS task by stored state. Third-party-funded records are paid only
/// to their stored funder; a creator can never harvest another party's rent.
///
/// Batch 3 WS-CONTEST §1 (submission-rent return): a straggler `TaskSubmission`
/// was funded by its WORKER, so its rent goes back to the submission's stored
/// worker. The caller must follow each TaskSubmission child with that worker's
/// `AgentRegistration` (resolves agent PDA -> authority wallet) and the writable
/// authority wallet itself, both validated against stored pubkeys. FAIL-CLOSED:
/// if the matching accounts are not supplied the instruction errors, so the
/// creator is NEVER paid a worker's submission rent (kills the rent-farming
/// sink where junk tasks harvested ~0.00286 SOL from every submitter).
fn sweep_task_children<'info>(
    remaining_accounts: &[AccountInfo<'info>],
    start: usize,
    task_key: &Pubkey,
    task_live_submissions: u8,
    authority_info: &AccountInfo<'info>,
    treasury: Option<Pubkey>,
) -> Result<()> {
    let mut idx = start;
    while idx < remaining_accounts.len() {
        let child = &remaining_accounts[idx];
        idx = idx
            .checked_add(1)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        match classify_task_child(child, task_key, task_live_submissions)? {
            TaskChild::CreatorFunded => close_child_to(child, authority_info)?,
            TaskChild::NamedRecipient { recipient } => {
                let recipient_info = remaining_accounts
                    .get(idx)
                    .ok_or(CoordinationError::TaskChildRentRecipientRequired)?;
                idx = idx
                    .checked_add(1)
                    .ok_or(CoordinationError::ArithmeticOverflow)?;
                require!(
                    recipient_info.key() == recipient && recipient_info.is_writable,
                    CoordinationError::TaskChildRentRecipientRequired
                );
                close_child_to(child, recipient_info)?;
            }
            TaskChild::WorkerSubmission {
                worker_agent,
                submitted_at,
            } => {
                let agent_info = remaining_accounts
                    .get(idx)
                    .ok_or(CoordinationError::SubmissionRentAccountsRequired)?;
                let worker_wallet_info = remaining_accounts
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
                    submitted_at,
                    agent_info,
                    worker_wallet_info,
                    treasury,
                )?;
            }
        }
    }
    Ok(())
}

/// A recognized auxiliary child of a terminal task, classified by who funded it —
/// which decides who gets its rent back.
enum TaskChild {
    /// Creator-funded records (`TaskValidationConfig` / `TaskAttestorConfig`).
    CreatorFunded,
    /// A record funded by a stored wallet (currently `TaskModeration`, whose
    /// payer role names the creator or the moderator). The next remaining account
    /// must be this writable recipient.
    NamedRecipient { recipient: Pubkey },
    /// A worker-funded `TaskSubmission` straggler: rent returns to the submission's
    /// stored worker (Batch 3 WS-CONTEST §1). Carries the stored worker AGENT PDA
    /// the payee accounts must be validated against.
    WorkerSubmission {
        worker_agent: Pubkey,
        submitted_at: i64,
    },
}

/// Identify a child by trying each known type's discriminator, validate it is bound
/// to THIS task, and classify its rent destination. An unrecognized program-owned
/// account (or another task's record) is rejected so a caller cannot close an
/// unrelated account.
fn classify_task_child(
    child: &AccountInfo,
    task_key: &Pubkey,
    task_live_submissions: u8,
) -> Result<TaskChild> {
    require!(
        child.owner == &crate::ID,
        CoordinationError::InvalidAccountOwner
    );
    let data = child.try_borrow_data()?;
    let (bound_task, child_kind) = if let Ok(m) = TaskModeration::try_deserialize(&mut &data[..]) {
        // Revision 9 (C): the rent goes back to whoever paid it (the creator when
        // the payer role says so, else the moderator).
        (
            m.task,
            TaskChild::NamedRecipient {
                recipient: m.rent_recipient(),
            },
        )
    } else if let Ok(v) = TaskValidationConfig::try_deserialize(&mut &data[..]) {
        require!(
            v.pending_submission_count() == 0 && task_live_submissions == 0,
            CoordinationError::TaskChildRequiresDedicatedCleanup
        );
        (v.task, TaskChild::CreatorFunded)
    } else if let Ok(s) = TaskSubmission::try_deserialize(&mut &data[..]) {
        require!(
            matches!(
                s.status,
                crate::state::SubmissionStatus::Accepted | crate::state::SubmissionStatus::Rejected
            ),
            CoordinationError::TaskChildRequiresDedicatedCleanup
        );
        (
            s.task,
            TaskChild::WorkerSubmission {
                worker_agent: s.worker,
                submitted_at: s.submitted_at,
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
fn close_child_to<'info>(child: &AccountInfo<'info>, recipient: &AccountInfo<'info>) -> Result<()> {
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
/// A program-owned account at the expected PDA is not sufficient by itself:
/// revision 4 could close and re-create the identity. Strict timestamp continuity
/// (`registered_at < submitted_at`) proves the registration predates the child;
/// equality is deliberately discontinuous because same-second bundles existed.
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
    submission_submitted_at: i64,
    agent_info: &AccountInfo<'info>,
    worker_wallet_info: &AccountInfo<'info>,
    treasury: Option<Pubkey>,
) -> Result<()> {
    require!(
        agent_info.key() == *stored_worker_agent,
        CoordinationError::SubmissionRentAccountsRequired
    );
    let expected_payee = if agent_info.owner == &crate::ID {
        require!(
            agent_info.data_len() == AgentRegistration::SIZE,
            CoordinationError::CorruptedData
        );
        let data = agent_info.try_borrow_data()?;
        let worker = AgentRegistration::try_deserialize(&mut &data[..])
            .map_err(|_| error!(CoordinationError::CorruptedData))?;
        let (expected_agent, expected_bump) =
            Pubkey::find_program_address(&[b"agent", worker.agent_id.as_ref()], &crate::ID);
        require!(
            expected_agent == agent_info.key()
                && worker.bump == expected_bump
                && worker.authority != Pubkey::default(),
            CoordinationError::SubmissionRentAccountsRequired
        );
        require!(
            worker.validate_reserved_fields(),
            CoordinationError::CorruptedData
        );
        if worker.registered_at < submission_submitted_at {
            worker.authority
        } else {
            // A same-time or later registration is an unauthenticated clone. The
            // original wallet is unrecoverable; never pay the clone.
            treasury.ok_or(CoordinationError::SubmissionRentAccountsRequired)?
        }
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
        assert!(validate_task_closable(TaskStatus::Completed, 0, false).is_ok());
        assert!(validate_task_closable(TaskStatus::Cancelled, 0, false).is_ok());
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
            assert!(validate_task_closable(status, 0, false).is_err());
        }
    }

    // Revert-sensitive: removing the current_workers require! turns this red.
    #[test]
    fn rejects_terminal_with_live_worker() {
        assert!(validate_task_closable(TaskStatus::Completed, 1, false).is_err());
    }

    #[test]
    fn rejects_terminal_with_pending_worker_slash() {
        assert!(validate_task_closable(TaskStatus::Cancelled, 0, true).is_err());
    }

    // Revision 9 (C): peers still settling and a token task without its escrow
    // address refuse compaction. Revert-sensitive: dropping either require! turns
    // the matching assertion red.
    #[test]
    fn compaction_preconditions_refuse_peer_settlement_and_a_missing_token_escrow() {
        assert!(validate_task_compactable(false, false, false).is_ok());
        assert!(validate_task_compactable(false, false, true).is_ok());
        assert!(validate_task_compactable(false, true, true).is_ok());
        for (peer, token, escrow) in [
            (true, false, false),
            (true, true, true),
            (false, true, false),
        ] {
            let err = validate_task_compactable(peer, token, escrow).unwrap_err();
            assert_eq!(err, CoordinationError::TaskNotCompactable.into());
        }
    }

    #[test]
    fn listing_capacity_decrement_fails_closed_on_underflow() {
        assert_eq!(decrement_listing_open_jobs(2).unwrap(), 1);
        assert_eq!(decrement_listing_open_jobs(1).unwrap(), 0);
        assert!(decrement_listing_open_jobs(0).is_err());
    }

    #[test]
    fn only_exact_drained_hire_tombstone_is_already_swept() {
        let mut tombstone = vec![0u8; HireRecord::SIZE];
        tombstone[..8].copy_from_slice(&CLOSED_ACCOUNT_TOMBSTONE);

        assert!(is_drained_hire_record_tombstone(0, &tombstone));
        assert!(!is_drained_hire_record_tombstone(1, &tombstone));
        assert!(!is_drained_hire_record_tombstone(0, &[255u8; 7]));
        assert!(!is_drained_hire_record_tombstone(
            0,
            &[0u8; HireRecord::SIZE]
        ));
    }
}
