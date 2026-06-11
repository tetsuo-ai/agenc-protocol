//! Record a moderation decision for a task/job-spec hash.

use anchor_lang::prelude::*;

use crate::errors::CoordinationError;
use crate::events::TaskModerationRecorded;
#[cfg(not(feature = "mainnet-canary"))]
use crate::state::ModerationAttestor;
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

    /// The recording signer. Authorization is checked in the handler (NOT as an account
    /// constraint here) so the registered-attestor OR global-authority branch can be
    /// evaluated. In the canary build there is no attestor account, so the handler falls
    /// back to the global-authority-only check — the canary surface stays frozen.
    #[account(mut)]
    pub moderator: Signer<'info>,

    /// OPTIONAL (P6.8): a registered moderation-attestor roster entry. When supplied (and
    /// `moderator == moderation_attestor.attestor`), authorizes a non-global-authority
    /// attestor to record. Bound to `["moderation_attestor", moderator]` — Anchor enforces
    /// the canonical PDA, so a forged or mismatched entry fails account resolution; a
    /// REVOKED attestor's PDA is closed and fails to load (cannot attest). Full-surface
    /// only — gated so the frozen canary account list for `record_task_moderation` is
    /// unchanged.
    #[cfg(not(feature = "mainnet-canary"))]
    #[account(
        seeds = [b"moderation_attestor", moderator.key().as_ref()],
        bump = moderation_attestor.bump,
        constraint = moderation_attestor.attestor == moderator.key()
            @ CoordinationError::ModerationAttestorMismatch
    )]
    pub moderation_attestor: Option<Box<Account<'info, ModerationAttestor>>>,

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
    // Authorization (P6.8): the global moderation authority OR any registered
    // (non-revoked) attestor. In the canary build there is no attestor account, so
    // `attestor_supplied` is always false and this collapses to the original
    // global-authority-only check.
    #[cfg(not(feature = "mainnet-canary"))]
    let attestor_supplied = ctx.accounts.moderation_attestor.is_some();
    #[cfg(feature = "mainnet-canary")]
    let attestor_supplied = false;
    require_moderation_authorized(
        ctx.accounts.moderator.key(),
        ctx.accounts.moderation_config.moderation_authority,
        attestor_supplied,
    )?;

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

/// Authorize a moderation recorder (P6.8). Shared by `record_task_moderation` and
/// `record_listing_moderation`.
///
/// Passes iff EITHER:
///   - `moderator` is the global `ModerationConfig.moderation_authority`, OR
///   - a registered, non-revoked attestor entry was supplied (`attestor_supplied`).
///
/// `attestor_supplied` is `true` only when the caller passed a `ModerationAttestor` PDA
/// that Anchor already validated by canonical seeds AND `attestor == moderator` — so this
/// helper does not re-check that binding; presence is proof of authorization. A revoked
/// attestor cannot reach this function with `attestor_supplied == true` because its PDA is
/// closed and fails to load at account resolution.
pub fn require_moderation_authorized(
    moderator: Pubkey,
    moderation_authority: Pubkey,
    attestor_supplied: bool,
) -> Result<()> {
    require!(
        moderator == moderation_authority || attestor_supplied,
        CoordinationError::UnauthorizedModerationAttestor
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::task_moderation_status;

    #[test]
    fn authorizes_global_moderation_authority() {
        let auth = Pubkey::new_unique();
        // Global authority, no attestor supplied -> authorized.
        assert!(require_moderation_authorized(auth, auth, false).is_ok());
    }

    #[test]
    fn authorizes_registered_attestor_who_is_not_the_global_authority() {
        let auth = Pubkey::new_unique();
        let attestor = Pubkey::new_unique();
        // Not the global authority, but a registered attestor entry was supplied.
        assert!(require_moderation_authorized(attestor, auth, true).is_ok());
    }

    #[test]
    fn rejects_stranger_without_attestor_entry() {
        let auth = Pubkey::new_unique();
        let stranger = Pubkey::new_unique();
        // Neither the global authority NOR a supplied attestor entry -> rejected. This is
        // also the revoked-attestor case: once revoked, the PDA is closed, the account
        // fails to load, so `attestor_supplied` is false here.
        let err = require_moderation_authorized(stranger, auth, false).unwrap_err();
        assert_eq!(
            err,
            CoordinationError::UnauthorizedModerationAttestor.into()
        );
    }

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
