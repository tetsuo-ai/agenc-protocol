//! Record a moderation decision for a task/job-spec hash.

use anchor_lang::prelude::*;

use crate::errors::CoordinationError;
use crate::events::TaskModerationRecorded;
use crate::state::{
    is_valid_task_moderation_status, ModerationConfig, Task, TaskModeration, HASH_SIZE,
    TASK_MODERATION_RISK_SCORE_MAX,
};

#[derive(Accounts)]
#[instruction(job_spec_hash: [u8; HASH_SIZE])]
pub struct RecordTaskModeration<'info> {
    #[account(
        seeds = [b"moderation_config"],
        bump = moderation_config.bump
    )]
    pub moderation_config: Account<'info, ModerationConfig>,

    #[account(
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Account<'info, Task>,

    #[account(
        init_if_needed,
        payer = moderator,
        space = TaskModeration::SIZE,
        seeds = [b"task_moderation", task.key().as_ref(), job_spec_hash.as_ref()],
        bump
    )]
    pub task_moderation: Account<'info, TaskModeration>,

    #[account(
        mut,
        constraint = moderator.key() == moderation_config.moderation_authority
            @ CoordinationError::UnauthorizedTaskModerator
    )]
    pub moderator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RecordTaskModeration>,
    job_spec_hash: [u8; HASH_SIZE],
    status: u8,
    risk_score: u8,
    category_mask: u64,
    policy_hash: [u8; HASH_SIZE],
    scanner_hash: [u8; HASH_SIZE],
    expires_at: i64,
) -> Result<()> {
    validate_record_task_moderation_inputs(&job_spec_hash, status, risk_score, expires_at)?;
    require!(
        ctx.accounts.moderation_config.enabled,
        CoordinationError::TaskModerationRequired
    );

    let clock = Clock::get()?;
    if expires_at != 0 {
        require!(
            expires_at > clock.unix_timestamp,
            CoordinationError::TaskModerationExpired
        );
    }

    let task_key = ctx.accounts.task.key();
    let task = &ctx.accounts.task;
    let moderation = &mut ctx.accounts.task_moderation;
    moderation.task = task_key;
    moderation.creator = task.creator;
    moderation.job_spec_hash = job_spec_hash;
    moderation.status = status;
    moderation.risk_score = risk_score;
    moderation.category_mask = category_mask;
    moderation.policy_hash = policy_hash;
    moderation.scanner_hash = scanner_hash;
    moderation.recorded_at = clock.unix_timestamp;
    moderation.expires_at = expires_at;
    moderation.moderator = ctx.accounts.moderator.key();
    moderation.bump = ctx.bumps.task_moderation;

    emit!(TaskModerationRecorded {
        task: task_key,
        creator: task.creator,
        job_spec_hash,
        status,
        risk_score,
        category_mask,
        policy_hash,
        scanner_hash,
        expires_at,
        moderator: ctx.accounts.moderator.key(),
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

pub fn validate_record_task_moderation_inputs(
    job_spec_hash: &[u8; HASH_SIZE],
    status: u8,
    risk_score: u8,
    expires_at: i64,
) -> Result<()> {
    require!(
        job_spec_hash.iter().any(|byte| *byte != 0),
        CoordinationError::InvalidTaskJobSpecHash
    );
    require!(
        is_valid_task_moderation_status(status),
        CoordinationError::InvalidTaskModerationStatus
    );
    require!(
        risk_score <= TASK_MODERATION_RISK_SCORE_MAX,
        CoordinationError::InvalidTaskModerationRiskScore
    );
    require!(expires_at >= 0, CoordinationError::TaskModerationExpired);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::task_moderation_status;

    #[test]
    fn validates_clean_record_inputs() {
        let mut hash = [0u8; HASH_SIZE];
        hash[0] = 1;

        assert!(
            validate_record_task_moderation_inputs(&hash, task_moderation_status::CLEAN, 0, 0)
                .is_ok()
        );
    }

    #[test]
    fn rejects_zero_hash() {
        let err = validate_record_task_moderation_inputs(
            &[0u8; HASH_SIZE],
            task_moderation_status::CLEAN,
            0,
            0,
        )
        .unwrap_err();

        assert_eq!(err, CoordinationError::InvalidTaskJobSpecHash.into());
    }

    #[test]
    fn rejects_unknown_status() {
        let mut hash = [0u8; HASH_SIZE];
        hash[0] = 1;
        let err = validate_record_task_moderation_inputs(&hash, 255, 0, 0).unwrap_err();

        assert_eq!(err, CoordinationError::InvalidTaskModerationStatus.into());
    }

    #[test]
    fn rejects_oversized_risk_score() {
        let mut hash = [0u8; HASH_SIZE];
        hash[0] = 1;
        let err = validate_record_task_moderation_inputs(
            &hash,
            task_moderation_status::SUSPICIOUS,
            TASK_MODERATION_RISK_SCORE_MAX + 1,
            0,
        )
        .unwrap_err();

        assert_eq!(
            err,
            CoordinationError::InvalidTaskModerationRiskScore.into()
        );
    }
}
