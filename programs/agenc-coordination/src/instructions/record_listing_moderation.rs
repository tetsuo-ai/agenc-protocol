//! Record a moderation decision for a service listing's pinned job-spec hash
//! (embeddable marketplace, Batch 1 — spec §6).
//!
//! The per-task `TaskModeration` PDA is keyed by `task.key()`, so it cannot exist
//! before a task is minted — which makes moderating a `hire_from_listing` at hire
//! time impossible with the task-bound seeds. This listing/spec-keyed attestation
//! solves that: the moderation authority attests a listing's pinned `spec_hash`
//! once, and `hire_from_listing` checks THIS account at hire. Mirrors
//! `record_task_moderation` (and reuses its input validator).

use anchor_lang::prelude::*;

use crate::errors::CoordinationError;
use crate::events::ListingModerationRecorded;
use crate::instructions::record_task_moderation::{
    require_moderation_authorized, validate_record_task_moderation_inputs,
};
use crate::state::{
    ListingModeration, ModerationAttestor, ModerationConfig, ServiceListing, HASH_SIZE,
};

#[derive(Accounts)]
#[instruction(job_spec_hash: [u8; HASH_SIZE])]
pub struct RecordListingModeration<'info> {
    #[account(seeds = [b"moderation_config"], bump = moderation_config.bump)]
    pub moderation_config: Account<'info, ModerationConfig>,

    #[account(
        seeds = [b"service_listing", listing.provider_agent.as_ref(), listing.listing_id.as_ref()],
        bump = listing.bump
    )]
    pub listing: Account<'info, ServiceListing>,

    #[account(
        init_if_needed,
        payer = moderator,
        space = ListingModeration::SIZE,
        seeds = [b"listing_moderation", listing.key().as_ref(), job_spec_hash.as_ref()],
        bump
    )]
    pub listing_moderation: Account<'info, ListingModeration>,

    /// The recording signer. Authorization (global moderation authority OR a registered
    /// attestor) is checked in the handler, not as an account constraint here.
    #[account(mut)]
    pub moderator: Signer<'info>,

    /// OPTIONAL (P6.8): a registered moderation-attestor roster entry. When supplied (and
    /// `moderator == moderation_attestor.attestor`), authorizes a non-global-authority
    /// attestor to record. Bound to `["moderation_attestor", moderator]` — Anchor enforces
    /// the canonical PDA, so a forged/mismatched entry fails account resolution, and a
    /// REVOKED attestor's PDA is closed and fails to load (cannot attest). This instruction
    /// is full-surface only, so this field carries no canary-surface implications.
    #[account(
        seeds = [b"moderation_attestor", moderator.key().as_ref()],
        bump = moderation_attestor.bump,
        constraint = moderation_attestor.attestor == moderator.key()
            @ CoordinationError::ModerationAttestorMismatch
    )]
    pub moderation_attestor: Option<Box<Account<'info, ModerationAttestor>>>,

    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<RecordListingModeration>,
    job_spec_hash: [u8; HASH_SIZE],
    status: u8,
    risk_score: u8,
    category_mask: u64,
    policy_hash: [u8; HASH_SIZE],
    scanner_hash: [u8; HASH_SIZE],
    expires_at: i64,
) -> Result<()> {
    // Authorization (P6.8): global moderation authority OR a registered (non-revoked)
    // attestor. A supplied attestor account is canonical-PDA + `attestor == moderator`
    // bound by the account constraints above; a revoked attestor's PDA is closed and
    // fails to load, so it can never reach here as `Some`.
    require_moderation_authorized(
        ctx.accounts.moderator.key(),
        ctx.accounts.moderation_config.moderation_authority,
        ctx.accounts.moderation_attestor.is_some(),
    )?;

    // Reuse the task-moderation input validator (identical field rules).
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

    let listing_key = ctx.accounts.listing.key();
    let provider_agent = ctx.accounts.listing.provider_agent;
    let m = &mut ctx.accounts.listing_moderation;
    m.listing = listing_key;
    m.provider_agent = provider_agent;
    m.job_spec_hash = job_spec_hash;
    m.status = status;
    m.risk_score = risk_score;
    m.category_mask = category_mask;
    m.policy_hash = policy_hash;
    m.scanner_hash = scanner_hash;
    m.recorded_at = clock.unix_timestamp;
    m.expires_at = expires_at;
    m.moderator = ctx.accounts.moderator.key();
    m.bump = ctx.bumps.listing_moderation;

    emit!(ListingModerationRecorded {
        listing: listing_key,
        provider_agent,
        job_spec_hash,
        status,
        risk_score,
        expires_at,
        moderator: ctx.accounts.moderator.key(),
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
