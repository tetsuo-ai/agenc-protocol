//! Configure Task Validation V2 for an existing task.

use crate::errors::CoordinationError;
use crate::events::TaskValidationConfigured;
use crate::instructions::task_validation_helpers::{
    validate_attestor, validate_configurable_task, validate_review_window_for_mode,
    validate_task_supports_validation_mode, validate_validation_mode, validate_validator_quorum,
};
use crate::state::{
    ProtocolConfig, Task, TaskAttestorConfig, TaskValidationConfig, ValidationMode,
    MANUAL_VALIDATION_SENTINEL,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ConfigureTaskValidation<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        constraint = task.creator == creator.key() @ CoordinationError::UnauthorizedTaskAction
    )]
    pub task: Account<'info, Task>,

    #[account(
        init_if_needed,
        payer = creator,
        space = TaskValidationConfig::SIZE,
        seeds = [b"task_validation", task.key().as_ref()],
        bump
    )]
    pub task_validation_config: Account<'info, TaskValidationConfig>,

    #[account(
        init_if_needed,
        payer = creator,
        space = TaskAttestorConfig::SIZE,
        seeds = [b"task_attestor", task.key().as_ref()],
        bump
    )]
    pub task_attestor_config: Account<'info, TaskAttestorConfig>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<ConfigureTaskValidation>,
    mode: u8,
    review_window_secs: i64,
    validator_quorum: u8,
    attestor: Option<Pubkey>,
) -> Result<()> {
    check_version_compatible(&ctx.accounts.protocol_config)?;

    let parsed_mode = validate_validation_mode(mode)?;
    require!(
        parsed_mode != ValidationMode::Auto,
        CoordinationError::InvalidValidationMode
    );
    validate_review_window_for_mode(parsed_mode, review_window_secs)?;
    validate_validator_quorum(parsed_mode, validator_quorum)?;
    validate_attestor(parsed_mode, attestor)?;
    validate_configurable_task(&ctx.accounts.task)?;
    validate_task_supports_validation_mode(&ctx.accounts.task, parsed_mode)?;

    let task_key = ctx.accounts.task.key();
    let task = &mut ctx.accounts.task;
    let config = &mut ctx.accounts.task_validation_config;
    let clock = Clock::get()?;

    if config.task != Pubkey::default() {
        require!(
            config.task == task_key,
            CoordinationError::TaskValidationAlreadyConfigured
        );
        require!(
            config.creator == task.creator,
            CoordinationError::UnauthorizedTaskAction
        );
    }

    config.task = task_key;
    config.creator = task.creator;
    config.mode = parsed_mode;
    config.review_window_secs = review_window_secs;
    config.set_validator_quorum(validator_quorum);
    config.set_pending_submission_count(0);
    if config.created_at == 0 {
        config.created_at = clock.unix_timestamp;
    }
    config.updated_at = clock.unix_timestamp;
    config.bump = ctx.bumps.task_validation_config;

    let attestor_config = &mut ctx.accounts.task_attestor_config;
    attestor_config.task = task_key;
    attestor_config.creator = task.creator;
    attestor_config.attestor = attestor.unwrap_or_default();
    if attestor_config.created_at == 0 {
        attestor_config.created_at = clock.unix_timestamp;
    }
    attestor_config.updated_at = clock.unix_timestamp;
    attestor_config.bump = ctx.bumps.task_attestor_config;

    task.constraint_hash = MANUAL_VALIDATION_SENTINEL;

    emit!(TaskValidationConfigured {
        task: task_key,
        creator: task.creator,
        mode,
        review_window_secs,
        validator_quorum,
        attestor,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
