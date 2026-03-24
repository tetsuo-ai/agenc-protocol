//! Reject a Task Validation V2 submission and return the task to active work.

use crate::errors::CoordinationError;
use crate::events::TaskResultRejected;
use crate::instructions::task_validation_helpers::{
    ensure_creator_review_config, is_manual_validation_task,
};
use crate::state::{
    ProtocolConfig, SubmissionStatus, Task, TaskClaim, TaskStatus, TaskSubmission,
    TaskValidationConfig, HASH_SIZE, RESULT_DATA_SIZE,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RejectTaskResult<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        constraint = task.creator == creator.key() @ CoordinationError::UnauthorizedTaskAction
    )]
    pub task: Account<'info, Task>,

    #[account(
        mut,
        seeds = [b"claim", task.key().as_ref(), claim.worker.as_ref()],
        bump = claim.bump,
        constraint = claim.task == task.key() @ CoordinationError::NotClaimed
    )]
    pub claim: Account<'info, TaskClaim>,

    #[account(
        seeds = [b"task_validation", task.key().as_ref()],
        bump = task_validation_config.bump
    )]
    pub task_validation_config: Account<'info, TaskValidationConfig>,

    #[account(
        mut,
        seeds = [b"task_submission", claim.key().as_ref()],
        bump = task_submission.bump,
        constraint = task_submission.task == task.key() @ CoordinationError::TaskSubmissionRequired,
        constraint = task_submission.claim == claim.key() @ CoordinationError::TaskSubmissionRequired
    )]
    pub task_submission: Account<'info, TaskSubmission>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub creator: Signer<'info>,
}

pub fn handler(ctx: Context<RejectTaskResult>, rejection_hash: [u8; HASH_SIZE]) -> Result<()> {
    check_version_compatible(&ctx.accounts.protocol_config)?;
    let clock = Clock::get()?;

    require!(
        ctx.accounts.task.status == TaskStatus::PendingValidation,
        CoordinationError::TaskNotPendingValidation
    );
    require!(
        is_manual_validation_task(&ctx.accounts.task),
        CoordinationError::TaskValidationConfigRequired
    );
    ensure_creator_review_config(
        &ctx.accounts.task_validation_config,
        &ctx.accounts.task.key(),
        &ctx.accounts.task,
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
    claim.proof_hash = [0u8; HASH_SIZE];
    claim.result_data = [0u8; RESULT_DATA_SIZE];
    claim.is_completed = false;
    claim.is_validated = false;
    claim.completed_at = 0;

    let task = &mut ctx.accounts.task;
    task.status = TaskStatus::InProgress;

    let submission = &mut ctx.accounts.task_submission;
    submission.status = SubmissionStatus::Rejected;
    submission.accepted_at = 0;
    submission.rejected_at = clock.unix_timestamp;
    submission.rejection_hash = rejection_hash;

    emit!(TaskResultRejected {
        task: task.key(),
        claim: claim.key(),
        worker: claim.worker,
        rejected_by: ctx.accounts.creator.key(),
        rejection_hash,
        rejected_at: clock.unix_timestamp,
    });

    Ok(())
}
