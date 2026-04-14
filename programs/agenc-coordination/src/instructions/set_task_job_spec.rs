//! Attach or update a content-addressed job specification pointer for a task.

use crate::errors::CoordinationError;
use crate::events::TaskJobSpecSet;
use crate::state::{Task, TaskJobSpec, TaskStatus, HASH_SIZE, TASK_JOB_SPEC_URI_MAX_LEN};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SetTaskJobSpec<'info> {
    #[account(
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        constraint = task.creator == creator.key() @ CoordinationError::UnauthorizedTaskAction
    )]
    pub task: Account<'info, Task>,

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

    let clock = Clock::get()?;
    let task_key = ctx.accounts.task.key();
    let task = &ctx.accounts.task;
    validate_task_job_spec_mutable(task)?;
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
