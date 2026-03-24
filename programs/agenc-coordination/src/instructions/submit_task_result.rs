//! Submit a task result for Task Validation V2 creator review.

use crate::errors::CoordinationError;
use crate::events::TaskResultSubmitted;
use crate::instructions::task_validation_helpers::{
    ensure_creator_review_config, is_manual_validation_task,
};
use crate::state::{
    AgentRegistration, ProtocolConfig, SubmissionStatus, Task, TaskClaim, TaskStatus,
    TaskSubmission, TaskValidationConfig, HASH_SIZE, RESULT_DATA_SIZE,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SubmitTaskResult<'info> {
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
        seeds = [b"task_validation", task.key().as_ref()],
        bump = task_validation_config.bump
    )]
    pub task_validation_config: Box<Account<'info, TaskValidationConfig>>,

    #[account(
        init_if_needed,
        payer = authority,
        space = TaskSubmission::SIZE,
        seeds = [b"task_submission", claim.key().as_ref()],
        bump
    )]
    pub task_submission: Box<Account<'info, TaskSubmission>>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        seeds = [b"agent", worker.agent_id.as_ref()],
        bump = worker.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub worker: Box<Account<'info, AgentRegistration>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<SubmitTaskResult>,
    proof_hash: [u8; HASH_SIZE],
    result_data: Option<[u8; RESULT_DATA_SIZE]>,
) -> Result<()> {
    check_version_compatible(&ctx.accounts.protocol_config)?;
    let clock = Clock::get()?;

    require!(
        ctx.accounts.task.status == TaskStatus::InProgress,
        CoordinationError::TaskNotInProgress
    );
    require!(
        ctx.accounts
            .task
            .status
            .can_transition_to(TaskStatus::PendingValidation),
        CoordinationError::InvalidStatusTransition
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

    let task = &mut ctx.accounts.task;
    let claim = &mut ctx.accounts.claim;
    let submission = &mut ctx.accounts.task_submission;

    require!(
        proof_hash != [0u8; HASH_SIZE],
        CoordinationError::InvalidProofHash
    );
    if let Some(data) = result_data {
        require!(
            data.iter().any(|&byte| byte != 0),
            CoordinationError::InvalidResultData
        );
    }
    if task.deadline > 0 {
        require!(
            clock.unix_timestamp <= task.deadline,
            CoordinationError::DeadlinePassed
        );
    }
    require!(
        clock.unix_timestamp <= claim.expires_at,
        CoordinationError::ClaimExpired
    );
    require!(
        !claim.is_completed,
        CoordinationError::ClaimAlreadyCompleted
    );
    require!(
        submission.status != SubmissionStatus::Submitted,
        CoordinationError::SubmissionAlreadyPending
    );
    require!(
        submission.status != SubmissionStatus::Accepted,
        CoordinationError::SubmissionAlreadyResolved
    );

    let review_window_secs = ctx.accounts.task_validation_config.review_window_secs;
    let next_submission_count = submission
        .submission_count
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let result_bytes = result_data.unwrap_or([0u8; RESULT_DATA_SIZE]);

    claim.proof_hash = proof_hash;
    claim.result_data = result_bytes;
    claim.completed_at = 0;
    claim.is_completed = false;
    claim.is_validated = false;

    submission.task = task.key();
    submission.claim = claim.key();
    submission.worker = ctx.accounts.worker.key();
    submission.status = SubmissionStatus::Submitted;
    submission.proof_hash = proof_hash;
    submission.result_data = result_bytes;
    submission.submission_count = next_submission_count;
    submission.submitted_at = clock.unix_timestamp;
    submission.review_deadline_at = clock
        .unix_timestamp
        .checked_add(review_window_secs)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    submission.accepted_at = 0;
    submission.rejected_at = 0;
    submission.rejection_hash = [0u8; HASH_SIZE];
    submission.bump = ctx.bumps.task_submission;

    task.status = TaskStatus::PendingValidation;

    emit!(TaskResultSubmitted {
        task: task.key(),
        claim: claim.key(),
        worker: ctx.accounts.worker.key(),
        proof_hash,
        result_data: result_bytes,
        submission_count: next_submission_count,
        submitted_at: submission.submitted_at,
        review_deadline_at: submission.review_deadline_at,
    });

    Ok(())
}
