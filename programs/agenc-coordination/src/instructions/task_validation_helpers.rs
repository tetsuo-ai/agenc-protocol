//! Shared helpers for Task Validation V2.

use crate::errors::CoordinationError;
use crate::state::{
    Task, TaskStatus, TaskType, TaskValidationConfig, ValidationMode, MANUAL_VALIDATION_SENTINEL,
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
        _ => err!(CoordinationError::InvalidValidationMode),
    }
}

pub fn validate_review_window(review_window_secs: i64) -> Result<()> {
    require!(
        review_window_secs > 0,
        CoordinationError::InvalidReviewWindow
    );
    require!(
        review_window_secs <= MAX_REVIEW_WINDOW_SECS,
        CoordinationError::InvalidReviewWindow
    );
    Ok(())
}

pub fn validate_task_supports_creator_review(task: &Task) -> Result<()> {
    require!(
        task.task_type == TaskType::Exclusive || task.task_type == TaskType::BidExclusive,
        CoordinationError::ValidationModeUnsupportedTaskType
    );
    require!(
        task.constraint_hash == [0u8; 32] || is_manual_validation_task(task),
        CoordinationError::ManualValidationPrivateTaskUnsupported
    );
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

pub fn ensure_creator_review_config(
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
    require!(
        config.mode == ValidationMode::CreatorReview,
        CoordinationError::TaskValidationConfigRequired
    );
    Ok(())
}
