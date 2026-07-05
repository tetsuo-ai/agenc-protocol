//! Batch 3 WS-CONTEST: permissionless per-submission ghost-split crank
//! (docs/design/batch-3-contest-tasks.md §3 — the 99designs rule).
//!
//! If a contest (schema-1 `Competitive`, CreatorReview) creator never picks a
//! winner, the prize is distributed among the non-rejected submitters after the
//! selection window: from `ghost_at = deadline + SELECTION_WINDOW_SECS` onward,
//! anyone may crank one `Submitted` submission per call. Each crank pays
//! `remaining_worker_pool / live_submissions_remaining` — self-consistent equal
//! shares with no snapshot account: the counter decrements with each crank, so
//! the LAST slice is `remaining / 1` and sweeps every remaining lamport of the
//! pool (rounding dust never strands). Fee legs are preserved per slice with the
//! SAME split helpers the accept path uses (protocol fee w/ reputation discount,
//! operator + referrer legs when the task carries them).
//!
//! A task that received work is never silently refunded: `cancel_task` requires
//! `live_submissions == 0` for contests, and accept is forbidden from `ghost_at`
//! (temporal partition — the judge and the crank can never interleave).
//!
//! Idempotence: the paid submission is flipped `Accepted` AND closed (rent to
//! the worker) in the same instruction, and the claim closes with it — a
//! submission can be ghost-paid at most once.

use crate::errors::CoordinationError;
use crate::events::{
    reputation_reason, GhostShareDistributed, OperatorFeePaid, ReferrerFeePaid, ReputationChanged,
    RewardDistributed, TaskCompleted,
};
use crate::instructions::completion_helpers::{
    build_referrer_leg, calculate_combined_fees, calculate_fee_with_reputation,
    calculate_reward_split_for_amount, transfer_rewards, update_claim_state, update_worker_state,
};
use crate::instructions::task_validation_helpers::{
    contest_ghost_at, decrement_pending_submission_count, ensure_validation_config,
    ensure_validation_mode, is_manual_validation_task, note_submission_left_review,
};
use crate::state::{
    AgentRegistration, ProtocolConfig, SubmissionStatus, Task, TaskClaim, TaskEscrow, TaskStatus,
    TaskSubmission, TaskValidationConfig, ValidationMode,
};
use crate::utils::version::check_version_compatible_for_exit;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct DistributeGhostShare<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        mut,
        seeds = [b"claim", task.key().as_ref(), worker.key().as_ref()],
        bump = claim.bump,
        constraint = claim.task == task.key() @ CoordinationError::NotClaimed,
        constraint = claim.worker == worker.key() @ CoordinationError::NotClaimed
    )]
    pub claim: Box<Account<'info, TaskClaim>>,

    #[account(
        mut,
        seeds = [b"escrow", task.key().as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Box<Account<'info, TaskEscrow>>,

    #[account(
        mut,
        seeds = [b"task_validation", task.key().as_ref()],
        bump = task_validation_config.bump
    )]
    pub task_validation_config: Box<Account<'info, TaskValidationConfig>>,

    #[account(
        mut,
        seeds = [b"task_submission", claim.key().as_ref()],
        bump = task_submission.bump,
        constraint = task_submission.task == task.key() @ CoordinationError::TaskSubmissionRequired,
        constraint = task_submission.claim == claim.key() @ CoordinationError::TaskSubmissionRequired,
        constraint = task_submission.worker == worker.key() @ CoordinationError::TaskSubmissionRequired
    )]
    pub task_submission: Box<Account<'info, TaskSubmission>>,

    #[account(
        mut,
        seeds = [b"agent", worker.agent_id.as_ref()],
        bump = worker.bump
    )]
    pub worker: Box<Account<'info, AgentRegistration>>,

    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// CHECK: Protocol treasury account, validated against protocol config.
    #[account(
        mut,
        constraint = treasury.key() == protocol_config.treasury @ CoordinationError::InvalidInput
    )]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: Receives escrow rent when the FINAL slice closes the escrow,
    /// validated against task.creator. Never receives pool funds.
    #[account(
        mut,
        constraint = creator.key() == task.creator @ CoordinationError::InvalidCreator
    )]
    pub creator: UncheckedAccount<'info>,

    /// CHECK: Receives the slice payout + submission/claim rent, validated
    /// against worker.authority (stored pubkey — spec invariant 2).
    #[account(
        mut,
        constraint = worker_authority.key() == worker.authority @ CoordinationError::UnauthorizedAgent
    )]
    pub worker_authority: UncheckedAccount<'info>,

    /// CHECK: operator payee — validated == the task's stamped operator. Required
    /// only when the task carries a non-zero operator fee. (A contest can never be
    /// a hire — configure_task_validation rejects live-HireRecord tasks — so the
    /// terms come from the Task alone; no HireRecord fallback.)
    #[account(mut)]
    pub operator: Option<UncheckedAccount<'info>>,

    /// CHECK: referrer payee — validated == the task's stamped referrer (§4 4-way
    /// split). Required only when the task carries a non-zero referrer fee.
    #[account(mut)]
    pub referrer: Option<UncheckedAccount<'info>>,

    /// Permissionless cranker; pays only the transaction fee.
    pub cranker: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Pure slice math: one crank pays `remaining_pool / live_submissions` (floor).
/// Because `live_submissions` decrements with every crank, the final call divides
/// by 1 and sweeps the whole remaining pool — Σ(slices) == pool exactly, dust
/// lands on the last slice. Unit-tested + revert-sensitive.
pub(crate) fn compute_ghost_slice(remaining_pool: u64, live_submissions: u8) -> Result<u64> {
    require!(live_submissions > 0, CoordinationError::CorruptedData);
    remaining_pool
        .checked_div(live_submissions as u64)
        .ok_or_else(|| error!(CoordinationError::ArithmeticOverflow))
}

pub fn handler(ctx: Context<DistributeGhostShare>) -> Result<()> {
    // Settlement/exit path: the ghost-split resolves an in-flight, already-escrowed
    // contest. It must work while the protocol is paused or the type is disabled
    // (both gate ENTRY only — "money never locks"); a pause must not strand a
    // ghosted contest's escrow.
    check_version_compatible_for_exit(&ctx.accounts.protocol_config)?;
    let clock = Clock::get()?;

    require!(
        ctx.accounts.task.status == TaskStatus::PendingValidation,
        CoordinationError::TaskNotPendingValidation
    );
    require!(
        ctx.accounts.task.is_contest_task(),
        CoordinationError::ContestGhostShareUnavailable
    );
    require!(
        is_manual_validation_task(&ctx.accounts.task),
        CoordinationError::TaskValidationConfigRequired
    );
    ensure_validation_config(
        &ctx.accounts.task_validation_config,
        &ctx.accounts.task.key(),
        &ctx.accounts.task,
    )?;
    ensure_validation_mode(
        &ctx.accounts.task_validation_config,
        ValidationMode::CreatorReview,
    )?;
    require!(
        ctx.accounts.task_submission.status == SubmissionStatus::Submitted,
        CoordinationError::SubmissionNotPending
    );
    // Temporal partition (spec §3): the crank owns settlement from ghost_at onward;
    // accept_task_result owns it strictly before (validate_contest_accept_window).
    require!(
        clock.unix_timestamp >= contest_ghost_at(&ctx.accounts.task)?,
        CoordinationError::ContestGhostWindowNotReached
    );
    // Contests are SOL-only at creation; fail closed if a token contest ever
    // slipped through (an SPL contest must never reach a ghost state it cannot exit).
    require!(
        ctx.accounts.task.reward_mint.is_none(),
        CoordinationError::ContestSolRewardOnly
    );

    // --- Slice math (reuses the accept-path split helpers; spec §3) ---
    let live = ctx.accounts.task.live_submissions();
    let remaining_pool = ctx
        .accounts
        .escrow
        .amount
        .checked_sub(ctx.accounts.escrow.distributed)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let slice_total = compute_ghost_slice(remaining_pool, live)?;

    let protocol_fee_bps = calculate_fee_with_reputation(
        ctx.accounts.task.protocol_fee_bps,
        ctx.accounts.worker.reputation,
    );
    // A dust-drained pool (e.g. expire_claim cleanup rewards ate the last lamports)
    // can floor a slice to 0. The crank must still complete — pay 0 but return the
    // worker's rent and free the counters — or the contest could never exit.
    let (mut worker_reward, protocol_fee) = if slice_total > 0 {
        calculate_reward_split_for_amount(slice_total, protocol_fee_bps)?
    } else {
        (0, 0)
    };

    // §4 operator/referrer legs, same combined-cap math as settlement. Terms come
    // from program-owned Task fields (stamped at creation), payees validated
    // against those stored pubkeys — no cranker-supplied-account trust.
    let operator_pubkey = ctx.accounts.task.operator;
    let operator_fee_bps = ctx.accounts.task.operator_fee_bps;
    let operator_leg_active = operator_fee_bps > 0 && operator_pubkey != Pubkey::default();
    let operator_account = if operator_leg_active {
        let op = ctx
            .accounts
            .operator
            .as_ref()
            .ok_or(CoordinationError::MissingOperatorAccount)?;
        require!(
            op.key() == operator_pubkey,
            CoordinationError::InvalidOperatorAccount
        );
        Some(op.to_account_info())
    } else {
        None
    };
    let referrer_leg = build_referrer_leg(
        ctx.accounts.task.referrer,
        ctx.accounts.task.referrer_fee_bps,
        ctx.accounts.referrer.as_ref().map(|r| r.as_ref()),
    )?;
    let referrer_fee_bps = referrer_leg.as_ref().map(|l| l.fee_bps).unwrap_or(0);

    let (operator_fee, referrer_fee) =
        if slice_total > 0 && (operator_leg_active || referrer_fee_bps > 0) {
            let (op_fee, ref_fee) = calculate_combined_fees(
                slice_total,
                protocol_fee_bps,
                if operator_leg_active { operator_fee_bps } else { 0 },
                referrer_fee_bps,
            )?;
            let total_legs = op_fee
                .checked_add(ref_fee)
                .ok_or(CoordinationError::ArithmeticOverflow)?;
            worker_reward = worker_reward
                .checked_sub(total_legs)
                .ok_or(CoordinationError::ArithmeticOverflow)?;
            require!(worker_reward > 0, CoordinationError::RewardTooSmall);
            (op_fee, ref_fee)
        } else {
            (0, 0)
        };

    // Checks: the escrow must actually hold the slice before any state mutation.
    let slice_paid_total = worker_reward
        .checked_add(protocol_fee)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_add(operator_fee)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_add(referrer_fee)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    require!(
        ctx.accounts.escrow.to_account_info().lamports() >= slice_paid_total,
        CoordinationError::InsufficientEscrowBalance
    );

    // Effects: all internal state BEFORE transfers (checks-effects-interactions).
    ctx.accounts.claim.proof_hash = ctx.accounts.task_submission.proof_hash;
    ctx.accounts.claim.result_data = ctx.accounts.task_submission.result_data;
    ctx.accounts.claim.is_completed = true;
    ctx.accounts.claim.is_validated = true;
    ctx.accounts.claim.completed_at = clock.unix_timestamp;
    update_claim_state(
        &mut ctx.accounts.claim,
        &mut ctx.accounts.escrow,
        worker_reward,
        protocol_fee,
    )?;
    let extra_legs = operator_fee
        .checked_add(referrer_fee)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    if extra_legs > 0 {
        ctx.accounts.escrow.distributed = ctx
            .accounts
            .escrow
            .distributed
            .checked_add(extra_legs)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
    }

    let task = &mut ctx.accounts.task;
    task.current_workers = task
        .current_workers
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    task.completions = task
        .completions
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    decrement_pending_submission_count(&mut ctx.accounts.task_validation_config)?;
    note_submission_left_review(task)?;
    let remaining_live = task.live_submissions();

    // A ghost-split IS a paid completion (spec §3): credit the submitter's stats
    // and reputation exactly like accept does. (No new farming vector: the same
    // credit is already mintable more cheaply via an instant creator accept.)
    let (old_rep, new_rep) = update_worker_state(
        &mut ctx.accounts.worker,
        worker_reward,
        clock.unix_timestamp,
    )?;
    if old_rep != new_rep {
        emit!(ReputationChanged {
            agent_id: ctx.accounts.worker.agent_id,
            old_reputation: old_rep,
            new_reputation: new_rep,
            reason: reputation_reason::COMPLETION,
            timestamp: clock.unix_timestamp,
        });
    }
    ctx.accounts.protocol_config.total_value_distributed = ctx
        .accounts
        .protocol_config
        .total_value_distributed
        .checked_add(slice_total)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    ctx.accounts.task_submission.status = SubmissionStatus::Accepted;
    ctx.accounts.task_submission.accepted_at = clock.unix_timestamp;
    ctx.accounts.task_submission.rejected_at = 0;
    ctx.accounts.task_submission.rejection_hash = [0u8; 32];

    // FINAL slice: the contest is fully distributed — the task completes and the
    // escrow closes (rent to the creator, standard settle disposition). The pool
    // itself is exhausted by construction (`remaining / 1` swept everything).
    let is_final_slice = remaining_live == 0;
    if is_final_slice {
        let task = &mut ctx.accounts.task;
        task.status = TaskStatus::Completed;
        task.completed_at = clock.unix_timestamp;
        ctx.accounts.escrow.is_closed = true;
        ctx.accounts.protocol_config.completed_tasks = ctx
            .accounts
            .protocol_config
            .completed_tasks
            .checked_add(1)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
    }

    emit!(TaskCompleted {
        task_id: ctx.accounts.task.task_id,
        worker: ctx.accounts.worker.key(),
        proof_hash: ctx.accounts.claim.proof_hash,
        result_data: ctx.accounts.claim.result_data,
        reward_paid: worker_reward,
        timestamp: clock.unix_timestamp,
    });
    emit!(RewardDistributed {
        task_id: ctx.accounts.task.task_id,
        recipient: ctx.accounts.worker.key(),
        amount: worker_reward,
        protocol_fee,
        timestamp: clock.unix_timestamp,
    });
    if operator_fee > 0 {
        emit!(OperatorFeePaid {
            task_id: ctx.accounts.task.task_id,
            operator: operator_pubkey,
            amount: operator_fee,
            operator_fee_bps,
            timestamp: clock.unix_timestamp,
        });
    }
    if referrer_fee > 0 {
        if let Some(leg) = referrer_leg.as_ref() {
            emit!(ReferrerFeePaid {
                task_id: ctx.accounts.task.task_id,
                referrer: leg.payee.key(),
                amount: referrer_fee,
                referrer_fee_bps: leg.fee_bps,
                timestamp: clock.unix_timestamp,
            });
        }
    }
    emit!(GhostShareDistributed {
        task: ctx.accounts.task.key(),
        worker_agent: ctx.accounts.worker.key(),
        lamports: worker_reward,
        remaining: remaining_live,
    });

    // Interactions: transfers AFTER all state updates.
    let operator_xfer: Option<(&AccountInfo, u64)> = operator_account
        .as_ref()
        .filter(|_| operator_fee > 0)
        .map(|info| (info, operator_fee));
    let referrer_xfer: Option<(&AccountInfo, u64)> = referrer_leg
        .as_ref()
        .filter(|_| referrer_fee > 0)
        .map(|leg| (&leg.payee, referrer_fee));
    transfer_rewards(
        &mut ctx.accounts.escrow,
        &ctx.accounts.worker_authority.to_account_info(),
        &ctx.accounts.treasury.to_account_info(),
        worker_reward,
        protocol_fee,
        operator_xfer,
        referrer_xfer,
    )?;
    if is_final_slice {
        ctx.accounts
            .escrow
            .close(ctx.accounts.creator.to_account_info())?;
    }

    // Rent return (spec §1): submission + claim both close to the worker — nobody
    // loses money by entering and losing... or by entering and being ghosted.
    ctx.accounts
        .task_submission
        .close(ctx.accounts.worker_authority.to_account_info())?;
    ctx.accounts
        .claim
        .close(ctx.accounts.worker_authority.to_account_info())?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Revert-sensitive: the remaining/remaining recurrence must conserve the pool
    // exactly, with all dust landing on the LAST slice.
    #[test]
    fn ghost_slices_conserve_pool_exactly() {
        for (pool, entrants) in [
            (10u64, 3u8),
            (1_000_000, 3),
            (999_999_999, 7),
            (1, 3),
            (0, 2),
            (5_000_000_000, 100),
        ] {
            let mut remaining = pool;
            let mut live = entrants;
            let mut paid_total = 0u64;
            let mut last_slice = 0u64;
            while live > 0 {
                let slice = compute_ghost_slice(remaining, live).unwrap();
                paid_total += slice;
                remaining -= slice;
                last_slice = slice;
                live -= 1;
            }
            assert_eq!(
                paid_total, pool,
                "pool {pool} across {entrants} entrants must be fully distributed"
            );
            assert_eq!(remaining, 0, "nothing strands after the last slice");
            // The last slice is the largest (it sweeps the dust).
            assert!(last_slice >= pool / entrants as u64);
        }
    }

    #[test]
    fn ghost_slice_equal_shares_when_divisible() {
        // 9_000_000 across 3 entrants -> exactly 3_000_000 each.
        let mut remaining = 9_000_000u64;
        for live in [3u8, 2, 1] {
            let slice = compute_ghost_slice(remaining, live).unwrap();
            assert_eq!(slice, 3_000_000);
            remaining -= slice;
        }
        assert_eq!(remaining, 0);
    }

    #[test]
    fn ghost_slice_zero_live_fails_closed() {
        // live_submissions == 0 with a Submitted submission is counter corruption.
        assert!(compute_ghost_slice(1_000, 0).is_err());
    }

    #[test]
    fn ghost_slice_zero_pool_pays_zero_but_succeeds() {
        // A dust-drained pool still cranks (pays 0, frees the counters) so the
        // contest can always exit.
        assert_eq!(compute_ghost_slice(0, 2).unwrap(), 0);
    }
}
