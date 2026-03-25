//! Submit a task result for Task Validation V2 review or attestation.

use crate::errors::CoordinationError;
use crate::events::TaskResultSubmitted;
use crate::instructions::task_validation_helpers::{
    ensure_validation_config, increment_pending_submission_count, is_manual_validation_task,
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
        mut,
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
        ctx.accounts.task.status == TaskStatus::InProgress
            || ctx.accounts.task.status == TaskStatus::PendingValidation,
        CoordinationError::TaskNotInProgress
    );
    require!(
        ctx.accounts.task.status == TaskStatus::PendingValidation
            || ctx
                .accounts
                .task
                .status
                .can_transition_to(TaskStatus::PendingValidation),
        CoordinationError::InvalidStatusTransition
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

    let review_window_secs = ctx.accounts.task_validation_config.review_window_secs;
    let task = &mut ctx.accounts.task;
    let claim = &mut ctx.accounts.claim;
    let validation_config = &mut ctx.accounts.task_validation_config;
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
    require!(claim.claimed_at > 0, CoordinationError::NotClaimed);
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

    let next_submission_count = submission
        .submission_count
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let result_bytes = result_data.unwrap_or([0u8; RESULT_DATA_SIZE]);
    increment_pending_submission_count(validation_config)?;

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
    submission.clear_validation_counts();
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

#[cfg(test)]
mod tests {
    use anchor_lang::prelude::Pubkey;
    use anchor_lang::ToAccountMetas;

    #[test]
    fn test_submit_task_result_marks_validation_config_writable() {
        let task_validation_config = Pubkey::new_unique();
        let accounts = crate::__client_accounts_submit_task_result::SubmitTaskResult {
            task: Pubkey::new_unique(),
            claim: Pubkey::new_unique(),
            task_validation_config,
            task_submission: Pubkey::new_unique(),
            protocol_config: Pubkey::new_unique(),
            worker: Pubkey::new_unique(),
            authority: Pubkey::new_unique(),
            system_program: Pubkey::new_unique(),
        };

        let validation_meta = accounts
            .to_account_metas(None)
            .into_iter()
            .find(|meta| meta.pubkey == task_validation_config)
            .expect("task validation config meta should be present");

        assert!(
            validation_meta.is_writable,
            "submit_task_result must keep task_validation_config writable so pending submissions persist",
        );
    }
}
