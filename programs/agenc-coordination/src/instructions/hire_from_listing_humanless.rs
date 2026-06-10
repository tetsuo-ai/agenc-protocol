//! Hire a provider from a standing `ServiceListing` as a human buyer with NO
//! registered agent (embeddable single-agent storefront).
//!
//! `hire_from_listing` requires the buyer to own an `AgentRegistration` — but a
//! website visitor paying a storefront agent in SOL has only a wallet. This is the
//! humanless twin: it snapshots the listing's terms into a fresh `Task` + `TaskEscrow`
//! exactly like `hire_from_listing` (including the §4 operator-fee leg, so the
//! embedding site still earns its cut), funds escrow in SOL, and — critically, like
//! `create_task_humanless` — ALWAYS pins `ValidationMode::CreatorReview` by
//! initializing the `TaskValidationConfig` in the same transaction, so the human
//! buyer always gets to review the work before funds are released (no auto-pay trap).
//!
//! This closes the visitor-pays loop: a plain human wallet hires a specific listing,
//! the agent does the work, the human reviews, and settlement runs the 3-way split
//! (worker / AgenC protocol / operator). Additive + SOL-only + single-worker
//! Exclusive (v1). Rate-limited on the wallet pubkey (no agent identity).

use crate::errors::CoordinationError;
use crate::events::{ServiceListingHired, TaskCreated};
use crate::instructions::hire_from_listing::{
    hire_deadline_offset, validate_hire_terms, validate_listing_capacity,
    validate_listing_moderation_for_hire, validate_listing_spec_hash,
};
use crate::instructions::launch_controls::require_task_type_index_enabled;
use crate::instructions::rate_limit_helpers::check_authority_task_creation_rate_limits;
use crate::instructions::task_init_helpers::{
    increment_total_tasks, init_escrow_fields, init_task_fields, validate_deadline,
};
use crate::instructions::task_validation_helpers::validate_review_window_for_mode;
use crate::state::{
    AuthorityRateLimit, HireRecord, ListingModeration, ModerationConfig, ProtocolConfig,
    ServiceListing, Task, TaskEscrow, TaskType, TaskValidationConfig, ValidationMode,
    MANUAL_VALIDATION_SENTINEL,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;
use anchor_lang::system_program;

#[derive(Accounts)]
#[instruction(task_id: [u8; 32])]
pub struct HireFromListingHumanless<'info> {
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

    /// Links this hire to its source listing (capacity decrement via close_task) and
    /// snapshots the operator-fee terms for the settlement split.
    #[account(
        init,
        payer = creator,
        space = HireRecord::SIZE,
        seeds = [b"hire", task.key().as_ref()],
        bump
    )]
    pub hire_record: Box<Account<'info, HireRecord>>,

    /// Forced CreatorReview validation config — initialized here so a humanless hire
    /// can never settle on the auto-pay path; the human buyer always reviews first.
    #[account(
        init,
        payer = creator,
        space = TaskValidationConfig::SIZE,
        seeds = [b"task_validation", task.key().as_ref()],
        bump
    )]
    pub task_validation_config: Box<Account<'info, TaskValidationConfig>>,

    /// Standing listing being hired from. Mutable to record the hire.
    #[account(
        mut,
        seeds = [b"service_listing", listing.provider_agent.as_ref(), listing.listing_id.as_ref()],
        bump = listing.bump
    )]
    pub listing: Box<Account<'info, ServiceListing>>,

    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// Global moderation gate. REQUIRED so a hire is fail-closed (spec §6).
    #[account(seeds = [b"moderation_config"], bump = moderation_config.bump)]
    pub moderation_config: Box<Account<'info, ModerationConfig>>,

    /// Listing/spec-keyed moderation attestation. Required iff `moderation_config.enabled`.
    #[account(
        seeds = [b"listing_moderation", listing.key().as_ref(), listing.spec_hash.as_ref()],
        bump = listing_moderation.bump
    )]
    pub listing_moderation: Option<Box<Account<'info, ListingModeration>>>,

    /// Wallet-scoped task/dispute rate limit state (seeded on the buyer wallet; no agent).
    #[account(
        init_if_needed,
        payer = creator,
        space = AuthorityRateLimit::SIZE,
        seeds = [b"authority_rate_limit", creator.key().as_ref()],
        bump
    )]
    pub authority_rate_limit: Box<Account<'info, AuthorityRateLimit>>,

    /// The human buyer's wallet — owns and pays for the hired task. No AgentRegistration.
    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Mints a one-shot `Task` from a `ServiceListing` for a human (agentless) buyer.
///
/// # Parameters
/// - `task_id`: caller-chosen unique id for the new task (PDA seed).
/// - `expected_price` / `expected_version`: the listing terms the buyer agreed to;
///   the hire is rejected if the on-chain listing no longer matches (anti-rug).
/// - `review_window_secs`: CreatorReview review window for the forced validation config.
pub fn handler(
    ctx: Context<HireFromListingHumanless>,
    task_id: [u8; 32],
    expected_price: u64,
    expected_version: u64,
    review_window_secs: i64,
) -> Result<()> {
    let clock = Clock::get()?;
    let config = ctx.accounts.protocol_config.as_ref();

    check_version_compatible(config)?;
    require_task_type_index_enabled(config, TaskType::Exclusive as u8)?;
    // Forced CreatorReview ⇒ the review window must be valid for that mode.
    validate_review_window_for_mode(ValidationMode::CreatorReview, review_window_secs)?;

    // Snapshot listing fields BEFORE any mutable borrow.
    let listing = ctx.accounts.listing.as_ref();
    let listing_key = listing.key();
    let provider_agent = listing.provider_agent;
    let reward_amount = listing.price;
    let required_capabilities = listing.required_capabilities;
    let listing_spec_hash = listing.spec_hash;
    let listing_deadline_secs = listing.default_deadline_secs;
    let listing_operator = listing.operator;
    let listing_operator_fee_bps = listing.operator_fee_bps;

    // Anti-rug compare-and-swap + state/self-hire/SOL-only guards (the buyer authority
    // is the human wallet; self-hire is still checked against the listing authority).
    validate_hire_terms(
        listing.state,
        listing.price,
        listing.version,
        expected_price,
        expected_version,
        ctx.accounts.creator.key(),
        listing.authority,
        listing.price_mint,
    )?;
    validate_listing_capacity(listing.open_jobs, listing.max_open_jobs)?;

    // Hire-time moderation gate (§6), fail-closed.
    if ctx.accounts.moderation_config.enabled {
        let lm = ctx
            .accounts
            .listing_moderation
            .as_ref()
            .ok_or(CoordinationError::TaskModerationRequired)?;
        validate_listing_moderation_for_hire(
            ctx.accounts.moderation_config.as_ref(),
            lm.as_ref(),
            listing_key,
            &listing_spec_hash,
            clock.unix_timestamp,
        )?;
    }

    let deadline = clock.unix_timestamp.saturating_add(hire_deadline_offset(
        listing_deadline_secs,
        config.max_claim_duration,
    ));
    validate_deadline(deadline, &clock, true)?;

    validate_listing_spec_hash(&listing_spec_hash)?;
    let mut description = [0u8; 64];
    description[..32].copy_from_slice(&listing_spec_hash);

    let protocol_fee_bps = config.protocol_fee_bps;

    // Wallet-scoped rate limit (agent_id = 0 ⇒ keyed by the wallet, no agent).
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
        0,    // min_reputation
        None, // reward_mint: SOL only
    )?;
    // Mark the task as manual-validation so submit/accept route through CreatorReview
    // (mirrors configure_task_validation); the TaskValidationConfig is pinned below.
    task.constraint_hash = MANUAL_VALIDATION_SENTINEL;

    // §4: stamp the operator terms onto the Task so settlement runs the 3-way split.
    // A creator that is also the operator could self-deal the operator leg.
    if listing_operator != Pubkey::default() {
        require!(
            listing_operator != creator_key,
            CoordinationError::OperatorIsCreator
        );
        task.operator = listing_operator;
        task.operator_fee_bps = listing_operator_fee_bps;
    }
    let task_key = task.key();

    let escrow = ctx.accounts.escrow.as_mut();
    init_escrow_fields(escrow, task_key, reward_amount, ctx.bumps.escrow);

    // Fund escrow from the human buyer (SOL).
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

    let protocol_config = ctx.accounts.protocol_config.as_mut();
    increment_total_tasks(protocol_config)?;

    // Record the hire on the listing (lifetime count + occupy one capacity slot).
    let listing = ctx.accounts.listing.as_mut();
    listing.total_hires = listing
        .total_hires
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    listing.open_jobs = listing
        .open_jobs
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    listing.updated_at = clock.unix_timestamp;
    let total_hires = listing.total_hires;
    let open_jobs = listing.open_jobs;

    // task<->listing link + operator-fee snapshot.
    let hire_record = ctx.accounts.hire_record.as_mut();
    hire_record.task = task_key;
    hire_record.listing = listing_key;
    hire_record.operator = listing_operator;
    hire_record.operator_fee_bps = listing_operator_fee_bps;
    hire_record.bump = ctx.bumps.hire_record;
    hire_record._reserved = [0u8; 32];

    // Pin CreatorReview so the human buyer always reviews before settlement.
    let vc = ctx.accounts.task_validation_config.as_mut();
    vc.task = task_key;
    vc.creator = creator_key;
    vc.mode = ValidationMode::CreatorReview;
    vc.review_window_secs = review_window_secs;
    vc.created_at = clock.unix_timestamp;
    vc.updated_at = clock.unix_timestamp;
    vc.bump = ctx.bumps.task_validation_config;

    emit!(TaskCreated {
        task_id,
        creator: creator_key,
        required_capabilities,
        reward_amount,
        task_type: TaskType::Exclusive as u8,
        deadline,
        min_reputation: 0,
        reward_mint: None,
        timestamp: clock.unix_timestamp,
    });
    emit!(ServiceListingHired {
        listing: listing_key,
        task: task_key,
        provider_agent,
        buyer: creator_key,
        price: reward_amount,
        total_hires,
        open_jobs,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
