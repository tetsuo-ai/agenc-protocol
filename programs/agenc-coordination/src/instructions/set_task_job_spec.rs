//! Attach or update a content-addressed job specification pointer for a task.

use crate::errors::CoordinationError;
use crate::events::TaskJobSpecSet;
use crate::instructions::launch_controls::require_task_type_enabled;
use crate::state::{
    is_publishable_task_moderation_status, ModerationConfig, ProtocolConfig, Task, TaskJobSpec,
    TaskModeration, TaskStatus, HASH_SIZE, TASK_JOB_SPEC_URI_MAX_LEN,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(job_spec_hash: [u8; HASH_SIZE])]
pub struct SetTaskJobSpec<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        constraint = task.creator == creator.key() @ CoordinationError::UnauthorizedTaskAction
    )]
    pub task: Account<'info, Task>,

    #[account(
        seeds = [b"moderation_config"],
        bump = moderation_config.bump
    )]
    pub moderation_config: Account<'info, ModerationConfig>,

    #[account(
        seeds = [b"task_moderation", task.key().as_ref(), job_spec_hash.as_ref()],
        bump = task_moderation.bump,
        constraint = task_moderation.task == task.key()
            @ CoordinationError::TaskModerationTaskMismatch,
        constraint = task_moderation.creator == task.creator
            @ CoordinationError::TaskModerationTaskMismatch,
        constraint = task_moderation.job_spec_hash == job_spec_hash
            @ CoordinationError::TaskModerationHashMismatch
    )]
    pub task_moderation: Account<'info, TaskModeration>,

    #[account(
        init_if_needed,
        payer = creator,
        space = TaskJobSpec::SIZE,
        seeds = [b"task_job_spec", task.key().as_ref()],
        bump
    )]
    pub task_job_spec: Account<'info, TaskJobSpec>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<SetTaskJobSpec>,
    job_spec_hash: [u8; HASH_SIZE],
    job_spec_uri: String,
) -> Result<()> {
    validate_task_job_spec_inputs(&job_spec_hash, &job_spec_uri)?;
    check_version_compatible(&ctx.accounts.protocol_config)?;

    let clock = Clock::get()?;
    let task_key = ctx.accounts.task.key();
    let task = &ctx.accounts.task;
    require_task_type_enabled(&ctx.accounts.protocol_config, task.task_type)?;
    validate_task_job_spec_mutable(task)?;
    validate_task_moderation_for_job_spec(
        &ctx.accounts.moderation_config,
        &ctx.accounts.task_moderation,
        task_key,
        task,
        &job_spec_hash,
        clock.unix_timestamp,
    )?;
    let task_job_spec = &mut ctx.accounts.task_job_spec;

    if task_job_spec.task != Pubkey::default() {
        require!(
            task_job_spec.task == task_key,
            CoordinationError::TaskJobSpecTaskMismatch
        );
        require!(
            task_job_spec.creator == task.creator,
            CoordinationError::UnauthorizedTaskAction
        );
    }

    task_job_spec.task = task_key;
    task_job_spec.creator = task.creator;
    task_job_spec.job_spec_hash = job_spec_hash;
    task_job_spec.job_spec_uri = job_spec_uri.clone();
    if task_job_spec.created_at == 0 {
        task_job_spec.created_at = clock.unix_timestamp;
    }
    task_job_spec.updated_at = clock.unix_timestamp;
    task_job_spec.bump = ctx.bumps.task_job_spec;

    emit!(TaskJobSpecSet {
        task: task_key,
        creator: task.creator,
        job_spec_hash,
        job_spec_uri,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

pub fn validate_task_job_spec_mutable(task: &Task) -> Result<()> {
    require!(
        task.status == TaskStatus::Open && task.current_workers == 0 && task.completions == 0,
        CoordinationError::TaskValidationImmutableAfterClaim
    );

    Ok(())
}

pub fn validate_task_job_spec_inputs(
    job_spec_hash: &[u8; HASH_SIZE],
    job_spec_uri: &str,
) -> Result<()> {
    require!(
        job_spec_hash.iter().any(|byte| *byte != 0),
        CoordinationError::InvalidTaskJobSpecHash
    );
    require!(
        !job_spec_uri.trim().is_empty(),
        CoordinationError::InvalidTaskJobSpecUri
    );
    require!(
        job_spec_uri.len() <= TASK_JOB_SPEC_URI_MAX_LEN,
        CoordinationError::InvalidTaskJobSpecUri
    );

    Ok(())
}

pub fn validate_task_moderation_for_job_spec(
    moderation_config: &ModerationConfig,
    task_moderation: &TaskModeration,
    task_key: Pubkey,
    task: &Task,
    job_spec_hash: &[u8; HASH_SIZE],
    now: i64,
) -> Result<()> {
    require!(
        moderation_config.enabled,
        CoordinationError::TaskModerationRequired
    );
    require!(
        moderation_config.moderation_authority != Pubkey::default(),
        CoordinationError::InvalidTaskModerationAuthority
    );
    require!(
        task_moderation.moderator == moderation_config.moderation_authority,
        CoordinationError::UnauthorizedTaskModerator
    );
    require!(
        task_moderation.task == task_key,
        CoordinationError::TaskModerationTaskMismatch
    );
    require!(
        task_moderation.creator == task.creator,
        CoordinationError::TaskModerationTaskMismatch
    );
    require!(
        task_moderation.job_spec_hash == *job_spec_hash,
        CoordinationError::TaskModerationHashMismatch
    );
    require!(
        is_publishable_task_moderation_status(task_moderation.status),
        CoordinationError::TaskModerationRejected
    );
    require!(
        task_moderation.risk_score <= crate::state::TASK_MODERATION_RISK_SCORE_MAX,
        CoordinationError::InvalidTaskModerationRiskScore
    );
    require!(
        task_moderation.expires_at == 0 || task_moderation.expires_at >= now,
        CoordinationError::TaskModerationExpired
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::task_moderation_status;

    #[test]
    fn validates_non_empty_hash_and_uri() {
        let mut hash = [0u8; HASH_SIZE];
        hash[0] = 1;

        assert!(validate_task_job_spec_inputs(&hash, "agenc://job-spec/sha256/abc").is_ok());
    }

    #[test]
    fn rejects_zero_hash() {
        let err = validate_task_job_spec_inputs(&[0u8; HASH_SIZE], "agenc://job-spec/sha256/abc")
            .unwrap_err();

        assert_eq!(err, CoordinationError::InvalidTaskJobSpecHash.into());
    }

    #[test]
    fn rejects_empty_uri() {
        let mut hash = [0u8; HASH_SIZE];
        hash[0] = 1;
        let err = validate_task_job_spec_inputs(&hash, " \t ").unwrap_err();

        assert_eq!(err, CoordinationError::InvalidTaskJobSpecUri.into());
    }

    #[test]
    fn rejects_oversized_uri() {
        let mut hash = [0u8; HASH_SIZE];
        hash[0] = 1;
        let uri = "a".repeat(TASK_JOB_SPEC_URI_MAX_LEN + 1);
        let err = validate_task_job_spec_inputs(&hash, &uri).unwrap_err();

        assert_eq!(err, CoordinationError::InvalidTaskJobSpecUri.into());
    }

    #[test]
    fn allows_job_spec_mutation_before_work_starts() {
        let task = Task {
            status: TaskStatus::Open,
            current_workers: 0,
            completions: 0,
            ..Task::default()
        };

        assert!(validate_task_job_spec_mutable(&task).is_ok());
    }

    #[test]
    fn rejects_job_spec_mutation_after_claim() {
        let task = Task {
            status: TaskStatus::InProgress,
            current_workers: 1,
            completions: 0,
            ..Task::default()
        };
        let err = validate_task_job_spec_mutable(&task).unwrap_err();

        assert_eq!(
            err,
            CoordinationError::TaskValidationImmutableAfterClaim.into()
        );
    }

    #[test]
    fn rejects_job_spec_mutation_after_completion_recorded() {
        let task = Task {
            status: TaskStatus::Open,
            current_workers: 0,
            completions: 1,
            ..Task::default()
        };
        let err = validate_task_job_spec_mutable(&task).unwrap_err();

        assert_eq!(
            err,
            CoordinationError::TaskValidationImmutableAfterClaim.into()
        );
    }

    #[test]
    fn rejects_job_spec_mutation_in_terminal_or_disputed_states() {
        for status in [
            TaskStatus::PendingValidation,
            TaskStatus::Completed,
            TaskStatus::Cancelled,
            TaskStatus::Disputed,
        ] {
            let task = Task {
                status,
                current_workers: 0,
                completions: 0,
                ..Task::default()
            };
            let err = validate_task_job_spec_mutable(&task).unwrap_err();

            assert_eq!(
                err,
                CoordinationError::TaskValidationImmutableAfterClaim.into()
            );
        }
    }

    fn moderation_case(
        status: u8,
        expires_at: i64,
    ) -> (
        ModerationConfig,
        TaskModeration,
        Pubkey,
        Task,
        [u8; HASH_SIZE],
    ) {
        let moderation_authority = Pubkey::new_unique();
        let task_key = Pubkey::new_unique();
        let creator = Pubkey::new_unique();
        let mut hash = [0u8; HASH_SIZE];
        hash[0] = 1;

        (
            ModerationConfig {
                moderation_authority,
                enabled: true,
                ..ModerationConfig::default()
            },
            TaskModeration {
                task: task_key,
                creator,
                job_spec_hash: hash,
                status,
                risk_score: 0,
                expires_at,
                moderator: moderation_authority,
                ..TaskModeration::default()
            },
            task_key,
            Task {
                creator,
                ..Task::default()
            },
            hash,
        )
    }

    #[test]
    fn allows_clean_or_human_approved_moderation() {
        for status in [
            task_moderation_status::CLEAN,
            task_moderation_status::HUMAN_APPROVED,
        ] {
            let (config, moderation, task_key, task, hash) = moderation_case(status, 0);

            assert!(validate_task_moderation_for_job_spec(
                &config,
                &moderation,
                task_key,
                &task,
                &hash,
                100
            )
            .is_ok());
        }
    }

    #[test]
    fn rejects_blocked_or_suspicious_moderation() {
        for status in [
            task_moderation_status::SUSPICIOUS,
            task_moderation_status::BLOCKED,
            task_moderation_status::SCANNER_UNAVAILABLE,
            task_moderation_status::HUMAN_REJECTED,
        ] {
            let (config, moderation, task_key, task, hash) = moderation_case(status, 0);
            let err = validate_task_moderation_for_job_spec(
                &config,
                &moderation,
                task_key,
                &task,
                &hash,
                100,
            )
            .unwrap_err();

            assert_eq!(err, CoordinationError::TaskModerationRejected.into());
        }
    }

    #[test]
    fn rejects_expired_moderation() {
        let (config, moderation, task_key, task, hash) =
            moderation_case(task_moderation_status::CLEAN, 99);
        let err = validate_task_moderation_for_job_spec(
            &config,
            &moderation,
            task_key,
            &task,
            &hash,
            100,
        )
        .unwrap_err();

        assert_eq!(err, CoordinationError::TaskModerationExpired.into());
    }
}
