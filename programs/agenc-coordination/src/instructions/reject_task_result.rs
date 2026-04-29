//! Reject a Task Validation V2 submission and return the task to active work.

use crate::errors::CoordinationError;
use crate::events::TaskResultRejected;
use crate::instructions::bid_settlement_helpers::{
    settle_accepted_bid, AcceptedBidBondDisposition, AcceptedBidBookDisposition,
};
use crate::instructions::launch_controls::require_task_type_enabled;
use crate::instructions::task_validation_helpers::{
    decrement_pending_submission_count, ensure_validation_config, ensure_validation_mode,
    is_manual_validation_task, release_claim_slot, sync_task_validation_status,
};
use crate::state::{
    AgentRegistration, ProtocolConfig, SubmissionStatus, Task, TaskClaim, TaskStatus,
    TaskSubmission, TaskValidationConfig, ValidationMode, HASH_SIZE, RESULT_DATA_SIZE,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

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
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, RejectTaskResult<'info>>,
    rejection_hash: [u8; HASH_SIZE],
) -> Result<()> {
    check_version_compatible(&ctx.accounts.protocol_config)?;
    require_task_type_enabled(&ctx.accounts.protocol_config, ctx.accounts.task.task_type)?;
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
    let worker = &mut ctx.accounts.worker;
    release_claim_slot(task, worker, clock.unix_timestamp)?;

    let submission = &mut ctx.accounts.task_submission;
    submission.status = SubmissionStatus::Rejected;
    submission.accepted_at = 0;
    submission.rejected_at = clock.unix_timestamp;
    submission.rejection_hash = rejection_hash;

    if task.task_type == crate::state::TaskType::BidExclusive {
        require!(
            ctx.remaining_accounts.len() >= 3,
            CoordinationError::BidSettlementAccountsRequired
        );

        let bid_book_info = remaining_account_info(ctx.remaining_accounts, 0);
        let accepted_bid_info = remaining_account_info(ctx.remaining_accounts, 1);
        let bidder_market_state_info = remaining_account_info(ctx.remaining_accounts, 2);

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

    claim.close(ctx.accounts.worker_authority.to_account_info())?;

    Ok(())
}
