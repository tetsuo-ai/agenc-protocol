//! Shared helpers for Task Validation V2.

use crate::errors::CoordinationError;
use crate::state::{
    AgentRegistration, Task, TaskStatus, TaskType, TaskValidationConfig, ValidationMode,
    MANUAL_VALIDATION_SENTINEL,
};
use anchor_lang::prelude::*;

/// Default creator-review window: 24 hours.
pub const DEFAULT_REVIEW_WINDOW_SECS: i64 = 86_400;
/// Maximum creator-review window accepted by the protocol: 7 days.
pub const MAX_REVIEW_WINDOW_SECS: i64 = 604_800;

pub fn is_manual_validation_task(task: &Task) -> bool {
    task.constraint_hash == MANUAL_VALIDATION_SENTINEL
}

pub fn validate_validation_mode(mode: u8) -> Result<ValidationMode> {
    match mode {
        0 => Ok(ValidationMode::Auto),
        1 => Ok(ValidationMode::CreatorReview),
        2 => Ok(ValidationMode::ValidatorQuorum),
        3 => Ok(ValidationMode::ExternalAttestation),
        _ => err!(CoordinationError::InvalidValidationMode),
    }
}

pub fn validate_review_window_for_mode(
    mode: ValidationMode,
    review_window_secs: i64,
) -> Result<()> {
    match mode {
        ValidationMode::CreatorReview => {
            require!(
                review_window_secs > 0,
                CoordinationError::InvalidReviewWindow
            );
            require!(
                review_window_secs <= MAX_REVIEW_WINDOW_SECS,
                CoordinationError::InvalidReviewWindow
            );
        }
        ValidationMode::ValidatorQuorum | ValidationMode::ExternalAttestation => {
            require!(
                review_window_secs == 0,
                CoordinationError::InvalidReviewWindow
            );
        }
        ValidationMode::Auto => return err!(CoordinationError::InvalidValidationMode),
    }

    Ok(())
}

pub fn validate_validator_quorum(mode: ValidationMode, validator_quorum: u8) -> Result<()> {
    match mode {
        ValidationMode::ValidatorQuorum => {
            require!(
                validator_quorum > 0,
                CoordinationError::InvalidValidatorQuorum
            );
        }
        ValidationMode::CreatorReview | ValidationMode::ExternalAttestation => {
            require!(
                validator_quorum == 0,
                CoordinationError::InvalidValidatorQuorum
            );
        }
        ValidationMode::Auto => return err!(CoordinationError::InvalidValidationMode),
    }

    Ok(())
}

pub fn validate_attestor(mode: ValidationMode, attestor: Option<Pubkey>) -> Result<()> {
    match mode {
        ValidationMode::ExternalAttestation => {
            let attestor = attestor.ok_or(CoordinationError::InvalidAttestor)?;
            require!(
                attestor != Pubkey::default(),
                CoordinationError::InvalidAttestor
            );
        }
        ValidationMode::CreatorReview | ValidationMode::ValidatorQuorum => {
            require!(attestor.is_none(), CoordinationError::InvalidAttestor);
        }
        ValidationMode::Auto => return err!(CoordinationError::InvalidValidationMode),
    }

    Ok(())
}

pub fn validate_task_supports_validation_mode(task: &Task, mode: ValidationMode) -> Result<()> {
    require!(
        task.task_type != TaskType::Competitive,
        CoordinationError::ValidationModeUnsupportedTaskType
    );
    require!(
        task.constraint_hash == [0u8; 32] || is_manual_validation_task(task),
        CoordinationError::ManualValidationPrivateTaskUnsupported
    );

    // Bid-exclusive flows remain single-worker even when reviewed.
    if task.task_type == TaskType::BidExclusive {
        require!(
            mode != ValidationMode::ValidatorQuorum || task.max_workers == 1,
            CoordinationError::ValidationModeUnsupportedTaskType
        );
    }

    Ok(())
}

pub fn validate_configurable_task(task: &Task) -> Result<()> {
    require!(
        task.status == TaskStatus::Open,
        CoordinationError::TaskValidationImmutableAfterClaim
    );
    require!(
        task.current_workers == 0 && task.completions == 0,
        CoordinationError::TaskValidationImmutableAfterClaim
    );
    Ok(())
}

pub fn ensure_validation_config(
    config: &TaskValidationConfig,
    task_key: &Pubkey,
    task: &Task,
) -> Result<()> {
    require!(
        config.task == *task_key,
        CoordinationError::TaskValidationConfigRequired
    );
    require!(
        config.creator == task.creator,
        CoordinationError::UnauthorizedTaskAction
    );
    Ok(())
}

pub fn ensure_validation_mode(
    config: &TaskValidationConfig,
    expected: ValidationMode,
) -> Result<()> {
    require!(
        config.mode == expected,
        CoordinationError::ValidationModeMismatch
    );
    Ok(())
}

pub fn increment_pending_submission_count(config: &mut TaskValidationConfig) -> Result<()> {
    let next = config
        .pending_submission_count()
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    config.set_pending_submission_count(next);
    Ok(())
}

pub fn decrement_pending_submission_count(config: &mut TaskValidationConfig) -> Result<()> {
    let next = config
        .pending_submission_count()
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    config.set_pending_submission_count(next);
    Ok(())
}

pub fn sync_task_validation_status(task: &mut Task, config: &TaskValidationConfig) {
    if task.status == TaskStatus::Completed {
        return;
    }

    task.status = if config.pending_submission_count() > 0 {
        TaskStatus::PendingValidation
    } else if task.current_workers > 0 {
        TaskStatus::InProgress
    } else {
        TaskStatus::Open
    };
}

pub fn release_claim_slot(
    task: &mut Task,
    worker: &mut AgentRegistration,
    released_at: i64,
) -> Result<()> {
    task.current_workers = task
        .current_workers
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    worker.active_tasks = worker
        .active_tasks
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    worker.last_active = released_at;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sync_task_validation_status_prefers_pending_submission_state() {
        let mut task = Task {
            status: TaskStatus::InProgress,
            current_workers: 1,
            ..Task::default()
        };
        let mut config = TaskValidationConfig::default();
        config.set_pending_submission_count(2);

        sync_task_validation_status(&mut task, &config);

        assert!(task.status == TaskStatus::PendingValidation);
    }

    #[test]
    fn test_sync_task_validation_status_restores_in_progress_when_claims_remain() {
        let mut task = Task {
            status: TaskStatus::PendingValidation,
            current_workers: 2,
            ..Task::default()
        };
        let config = TaskValidationConfig::default();

        sync_task_validation_status(&mut task, &config);

        assert!(task.status == TaskStatus::InProgress);
    }

    #[test]
    fn test_sync_task_validation_status_reopens_task_without_claims() {
        let mut task = Task {
            status: TaskStatus::PendingValidation,
            current_workers: 0,
            ..Task::default()
        };
        let config = TaskValidationConfig::default();

        sync_task_validation_status(&mut task, &config);

        assert!(task.status == TaskStatus::Open);
    }

    #[test]
    fn test_sync_task_validation_status_preserves_completed_terminal_state() {
        let mut task = Task {
            status: TaskStatus::Completed,
            current_workers: 1,
            ..Task::default()
        };
        let mut config = TaskValidationConfig::default();
        config.set_pending_submission_count(1);

        sync_task_validation_status(&mut task, &config);

        assert!(task.status == TaskStatus::Completed);
    }

    #[test]
    fn test_release_claim_slot_updates_counters_and_last_active() {
        let mut task = Task {
            current_workers: 2,
            ..Task::default()
        };
        let mut worker = AgentRegistration {
            active_tasks: 3,
            last_active: 10,
            ..AgentRegistration::default()
        };

        release_claim_slot(&mut task, &mut worker, 42).expect("slot release should succeed");

        assert_eq!(task.current_workers, 1);
        assert_eq!(worker.active_tasks, 2);
        assert_eq!(worker.last_active, 42);
    }

    #[test]
    fn test_release_claim_slot_rejects_underflow() {
        let mut task = Task::default();
        let mut worker = AgentRegistration::default();

        assert!(release_claim_slot(&mut task, &mut worker, 42).is_err());
    }

    #[test]
    fn test_pending_submission_count_round_trip() {
        let mut config = TaskValidationConfig::default();

        increment_pending_submission_count(&mut config).expect("increment should succeed");
        increment_pending_submission_count(&mut config).expect("second increment should succeed");
        assert_eq!(config.pending_submission_count(), 2);

        decrement_pending_submission_count(&mut config).expect("decrement should succeed");
        assert_eq!(config.pending_submission_count(), 1);
    }

    #[test]
    fn test_pending_submission_count_rejects_underflow() {
        let mut config = TaskValidationConfig::default();

        assert!(decrement_pending_submission_count(&mut config).is_err());
    }

    #[test]
    fn test_pending_submission_count_rejects_overflow() {
        let mut config = TaskValidationConfig::default();
        config.set_pending_submission_count(u16::MAX);

        assert!(increment_pending_submission_count(&mut config).is_err());
    }
}
