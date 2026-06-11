//! Create a task as a human buyer with no registered agent (embeddable
//! marketplace, spec §9).
//!
//! `create_task` requires the creator to own an `AgentRegistration`; a human
//! buyer hiring through an embedded site has only a wallet. This dedicated
//! instruction lets a plain wallet post a task WITHOUT an agent, and — critically
//! — ALWAYS pins the task to `ValidationMode::CreatorReview` by initializing the
//! `TaskValidationConfig` in the same transaction. That closes the
//! `ValidationMode::Auto` auto-pay-no-recourse trap: a human buyer always gets to
//! review a submission before funds are released.
//!
//! Additive + SOL-only + single-worker Exclusive (v1). Rate-limited on the wallet
//! pubkey (no agent identity).

use crate::errors::CoordinationError;
use crate::events::TaskCreated;
use crate::instructions::completion_helpers::resolve_referrer_snapshot;
use crate::instructions::launch_controls::require_task_type_index_enabled;
use crate::instructions::rate_limit_helpers::check_authority_task_creation_rate_limits;
use crate::instructions::task_init_helpers::{
    increment_total_tasks, init_escrow_fields, init_task_fields, validate_deadline,
    validate_task_params,
};
use crate::instructions::task_validation_helpers::validate_review_window_for_mode;
use crate::state::{
    AuthorityRateLimit, ProtocolConfig, Task, TaskEscrow, TaskType, TaskValidationConfig,
    ValidationMode, MANUAL_VALIDATION_SENTINEL,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;
use anchor_lang::system_program;

#[derive(Accounts)]
#[instruction(task_id: [u8; 32])]
pub struct CreateTaskHumanless<'info> {
    #[account(
        init,
        payer = creator,
        space = Task::SIZE,
        seeds = [b"task", creator.key().as_ref(), task_id.as_ref()],
        bump
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        init,
        payer = creator,
        space = TaskEscrow::SIZE,
        seeds = [b"escrow", task.key().as_ref()],
        bump
    )]
    pub escrow: Box<Account<'info, TaskEscrow>>,

    /// Forced CreatorReview validation config — initialized here so a humanless task
    /// can never settle on the auto-pay path.
    #[account(
        init,
        payer = creator,
        space = TaskValidationConfig::SIZE,
        seeds = [b"task_validation", task.key().as_ref()],
        bump
    )]
    pub task_validation_config: Box<Account<'info, TaskValidationConfig>>,

    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// Wallet-scoped rate limit (seeded on the buyer wallet; no agent).
    #[account(
        init_if_needed,
        payer = creator,
        space = AuthorityRateLimit::SIZE,
        seeds = [b"authority_rate_limit", creator.key().as_ref()],
        bump
    )]
    pub authority_rate_limit: Box<Account<'info, AuthorityRateLimit>>,

    /// The human buyer's wallet — owns and pays for the task. No AgentRegistration.
    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<CreateTaskHumanless>,
    task_id: [u8; 32],
    required_capabilities: u64,
    description: [u8; 64],
    reward_amount: u64,
    deadline: i64,
    min_reputation: u16,
    review_window_secs: i64,
    referrer: Option<Pubkey>,
    referrer_fee_bps: u16,
) -> Result<()> {
    // v1: single-worker Exclusive, SOL-only.
    validate_task_params(
        &task_id,
        &description,
        required_capabilities,
        1,
        TaskType::Exclusive as u8,
        min_reputation,
    )?;
    require!(reward_amount > 0, CoordinationError::InvalidReward);
    // Forced CreatorReview ⇒ the review window must be valid for that mode.
    validate_review_window_for_mode(ValidationMode::CreatorReview, review_window_secs)?;

    let clock = Clock::get()?;
    let config = ctx.accounts.protocol_config.as_ref();
    check_version_compatible(config)?;
    require_task_type_index_enabled(config, TaskType::Exclusive as u8)?;
    validate_deadline(deadline, &clock, true)?;

    let protocol_fee_bps = config.protocol_fee_bps;

    // Wallet-scoped rate limit. No invoking agent ⇒ zero agent id (the limit is
    // keyed by the authority/wallet, not the agent — see rate_limit_helpers).
    check_authority_task_creation_rate_limits(
        ctx.accounts.authority_rate_limit.as_mut(),
        ctx.accounts.creator.key(),
        ctx.bumps.authority_rate_limit,
        [0u8; 32],
        config,
        &clock,
    )?;

    let escrow_key = ctx.accounts.escrow.key();
    let creator_key = ctx.accounts.creator.key();
    let task = ctx.accounts.task.as_mut();
    init_task_fields(
        task,
        task_id,
        creator_key,
        required_capabilities,
        description,
        None, // constraint_hash
        reward_amount,
        1, // max_workers
        TaskType::Exclusive as u8,
        deadline,
        escrow_key,
        ctx.bumps.task,
        protocol_fee_bps,
        clock.unix_timestamp,
        min_reputation,
        None, // reward_mint: SOL only
    )?;
    // Mark the task as manual-validation so submit/accept route through CreatorReview
    // (without this, is_manual_validation_task is false and submit_task_result rejects
    // with TaskValidationConfigRequired — the task could be created but never settled).
    task.constraint_hash = MANUAL_VALIDATION_SENTINEL;

    // P6.2 demand-side referral leg (no operator leg on a direct humanless create).
    let (referrer_key, referrer_bps) = resolve_referrer_snapshot(
        referrer,
        referrer_fee_bps,
        protocol_fee_bps,
        0,
        creator_key,
    )?;
    task.referrer = referrer_key;
    task.referrer_fee_bps = referrer_bps;
    let task_key = task.key();

    let escrow = ctx.accounts.escrow.as_mut();
    init_escrow_fields(escrow, task_key, reward_amount, ctx.bumps.escrow);

    // Fund escrow from the buyer (SOL).
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.creator.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
            },
        ),
        reward_amount,
    )?;

    // Pin CreatorReview so settlement always routes through buyer review.
    let vc = ctx.accounts.task_validation_config.as_mut();
    vc.task = task_key;
    vc.creator = creator_key;
    vc.mode = ValidationMode::CreatorReview;
    vc.review_window_secs = review_window_secs;
    vc.created_at = clock.unix_timestamp;
    vc.updated_at = clock.unix_timestamp;
    vc.bump = ctx.bumps.task_validation_config;

    let protocol_config = ctx.accounts.protocol_config.as_mut();
    increment_total_tasks(protocol_config)?;

    emit!(TaskCreated {
        task_id,
        creator: creator_key,
        required_capabilities,
        reward_amount,
        task_type: TaskType::Exclusive as u8,
        deadline,
        min_reputation,
        reward_mint: None,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
