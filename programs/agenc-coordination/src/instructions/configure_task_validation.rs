//! Configure Task Validation V2 for an existing task.

use crate::errors::CoordinationError;
use crate::events::TaskValidationConfigured;
use crate::instructions::task_validation_helpers::{
    validate_configurable_task, validate_review_window, validate_task_supports_creator_review,
    validate_validation_mode,
};
use crate::state::{
    ProtocolConfig, Task, TaskValidationConfig, ValidationMode, MANUAL_VALIDATION_SENTINEL,
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
) -> Result<()> {
    check_version_compatible(&ctx.accounts.protocol_config)?;

    let parsed_mode = validate_validation_mode(mode)?;
    require!(
        parsed_mode == ValidationMode::CreatorReview,
        CoordinationError::InvalidValidationMode
    );
    validate_review_window(review_window_secs)?;
    validate_configurable_task(&ctx.accounts.task)?;
    validate_task_supports_creator_review(&ctx.accounts.task)?;

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
    if config.created_at == 0 {
        config.created_at = clock.unix_timestamp;
    }
    config.updated_at = clock.unix_timestamp;
    config.bump = ctx.bumps.task_validation_config;

    task.constraint_hash = MANUAL_VALIDATION_SENTINEL;

    emit!(TaskValidationConfigured {
        task: task_key,
        creator: task.creator,
        mode,
        review_window_secs,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
