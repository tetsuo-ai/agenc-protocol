//! Reject a Task Validation V2 submission and return the task to active work.

use crate::errors::CoordinationError;
use crate::events::TaskResultRejected;
#[cfg(not(feature = "mainnet-canary"))]
use crate::instructions::agent_stats_helpers::{apply_track_record, Counter};
#[cfg(not(feature = "mainnet-canary"))]
use crate::instructions::bid_settlement_helpers::{
    bid_settlement_offset, settle_accepted_bid, AcceptedBidBondDisposition,
    AcceptedBidBookDisposition,
};
use crate::instructions::task_validation_helpers::{
    decrement_pending_submission_count, ensure_validation_config, ensure_validation_mode,
    is_manual_validation_task, note_submission_left_review, release_claim_slot,
    sync_task_validation_status, validate_contest_reject_window,
};
#[cfg(not(feature = "mainnet-canary"))]
use crate::state::AgentStats;
use crate::state::{
    AgentRegistration, ProtocolConfig, SubmissionStatus, Task, TaskClaim, TaskStatus,
    TaskSubmission, TaskValidationConfig, ValidationMode, HASH_SIZE, RESULT_DATA_SIZE,
};
use crate::utils::version::check_version_compatible_for_exit;
use anchor_lang::prelude::*;

#[cfg(not(feature = "mainnet-canary"))]
fn remaining_account_info<'info>(
    remaining_accounts: &[AccountInfo<'info>],
    index: usize,
) -> &'info AccountInfo<'info> {
    unsafe { std::mem::transmute(&remaining_accounts[index]) }
}

#[derive(Accounts)]
pub struct RejectTaskResult<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        constraint = task.creator == creator.key() @ CoordinationError::UnauthorizedTaskAction
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        mut,
        seeds = [b"claim", task.key().as_ref(), claim.worker.as_ref()],
        bump = claim.bump,
        constraint = claim.task == task.key() @ CoordinationError::NotClaimed
    )]
    pub claim: Box<Account<'info, TaskClaim>>,

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
        constraint = task_submission.claim == claim.key() @ CoordinationError::TaskSubmissionRequired
    )]
    pub task_submission: Box<Account<'info, TaskSubmission>>,

    #[account(
        mut,
        seeds = [b"agent", worker.agent_id.as_ref()],
        bump = worker.bump,
        constraint = worker.key() == claim.worker @ CoordinationError::UnauthorizedAgent
    )]
    pub worker: Box<Account<'info, AgentRegistration>>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(mut)]
    pub creator: Signer<'info>,

    /// CHECK: Claim rent is returned to the worker wallet that funded it.
    #[account(
        mut,
        constraint = worker_authority.key() == worker.authority @ CoordinationError::UnauthorizedAgent
    )]
    pub worker_authority: UncheckedAccount<'info>,

    /// OPTIONAL (P6.6): the worker agent's track-record aggregate. When supplied, this
    /// rejection bumps `tasks_rejected`. Created lazily on first write (`init_if_needed`),
    /// bound to the canonical `["agent_stats", worker]` PDA. Full-surface only — gated so
    /// the frozen canary account list for `reject_task_result` is unchanged.
    #[cfg(not(feature = "mainnet-canary"))]
    #[account(
        init_if_needed,
        payer = creator,
        space = AgentStats::SIZE,
        seeds = [b"agent_stats", worker.key().as_ref()],
        bump
    )]
    pub agent_stats: Option<Box<Account<'info, AgentStats>>>,

    /// Required only when `agent_stats` is supplied (for `init_if_needed`).
    #[cfg(not(feature = "mainnet-canary"))]
    pub system_program: Option<Program<'info, System>>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, RejectTaskResult<'info>>,
    rejection_hash: [u8; HASH_SIZE],
) -> Result<()> {
    // Settlement path: rejecting a submission resolves an in-flight, already-
    // escrowed task (routes it to review / refund). It must work while the
    // protocol is paused or the type is disabled (both gate ENTRY only — spec §7,
    // Decision #4 "money never locks"); a pause must not strand escrowed funds.
    check_version_compatible_for_exit(&ctx.accounts.protocol_config)?;
    let clock = Clock::get()?;

    require!(
        ctx.accounts.task.status == TaskStatus::PendingValidation,
        CoordinationError::TaskNotPendingValidation
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
    // Temporal partition, REJECT side (fix round — symmetric with the accept
    // window): for contests the creator may reject strictly BEFORE `ghost_at`;
    // from `ghost_at` onward every live submission belongs to the ghost crank.
    // Without this a creator could front-run the cranks after ghosting, reject
    // every entry, drive the task to Open, cancel, and claw back the prize.
    validate_contest_reject_window(&ctx.accounts.task, clock.unix_timestamp)?;
    require!(
        rejection_hash != [0u8; HASH_SIZE],
        CoordinationError::InvalidEvidenceHash
    );

    let claim = &mut ctx.accounts.claim;
    let claim_key = claim.key();
    let worker_key = claim.worker;
    claim.proof_hash = [0u8; HASH_SIZE];
    claim.result_data = [0u8; RESULT_DATA_SIZE];
    claim.is_completed = false;
    claim.is_validated = false;
    claim.completed_at = 0;

    decrement_pending_submission_count(&mut ctx.accounts.task_validation_config)?;

    let task = &mut ctx.accounts.task;
    note_submission_left_review(task)?;
    let worker = &mut ctx.accounts.worker;
    release_claim_slot(task, worker, clock.unix_timestamp)?;

    let submission = &mut ctx.accounts.task_submission;
    submission.status = SubmissionStatus::Rejected;
    submission.accepted_at = 0;
    submission.rejected_at = clock.unix_timestamp;
    submission.rejection_hash = rejection_hash;

    #[cfg(not(feature = "mainnet-canary"))]
    if task.task_type == crate::state::TaskType::BidExclusive {
        // Audit F-14: honor the Proof-dependency offset exactly like the accept paths.
        let offset = bid_settlement_offset(task);
        require!(
            ctx.remaining_accounts.len() >= offset.checked_add(3).ok_or(CoordinationError::ArithmeticOverflow)?,
            CoordinationError::BidSettlementAccountsRequired
        );

        let bid_book_info = remaining_account_info(ctx.remaining_accounts, offset);
        let accepted_bid_info = remaining_account_info(
            ctx.remaining_accounts,
            offset.checked_add(1).ok_or(CoordinationError::ArithmeticOverflow)?,
        );
        let bidder_market_state_info = remaining_account_info(
            ctx.remaining_accounts,
            offset.checked_add(2).ok_or(CoordinationError::ArithmeticOverflow)?,
        );

        settle_accepted_bid(
            &task.key(),
            claim,
            bid_book_info,
            accepted_bid_info,
            bidder_market_state_info,
            ctx.accounts.worker_authority.to_account_info(),
            None,
            clock.unix_timestamp,
            AcceptedBidBookDisposition::Reopen,
            AcceptedBidBondDisposition::Refund,
        )?;
    }

    sync_task_validation_status(task, &ctx.accounts.task_validation_config);

    emit!(TaskResultRejected {
        task: task.key(),
        claim: claim_key,
        worker: worker_key,
        rejected_by: ctx.accounts.creator.key(),
        rejection_hash,
        rejected_at: clock.unix_timestamp,
    });

    // P6.6: fold this rejection into the worker agent's track record (no-op when the
    // optional `agent_stats` account is not supplied). Telemetry only — never gates the
    // settlement above.
    #[cfg(not(feature = "mainnet-canary"))]
    apply_track_record(
        &mut ctx.accounts.agent_stats,
        worker_key,
        ctx.bumps.agent_stats,
        Counter::TasksRejected,
        clock.unix_timestamp,
    )?;

    ctx.accounts
        .claim
        .close(ctx.accounts.worker_authority.to_account_info())?;

    // Batch 3 WS-CONTEST §1 (submission-rent return, ALL task types): the claim is
    // closed above, so this submission round is over — return the worker-funded
    // TaskSubmission rent to the worker instead of stranding it for the close_task
    // sweep. A resubmission re-claims and re-inits both PDAs.
    ctx.accounts
        .task_submission
        .close(ctx.accounts.worker_authority.to_account_info())?;

    Ok(())
}
