//! P1.3 moderation liveness heartbeat (batch-2 A2, `docs/MODERATION_LIVENESS.md`).
//!
//! Bumps `ModerationConfig.updated_at` — the deadman timestamp the consumption
//! gates read — under an authority signature: the config authority (protocol
//! authority) OR the moderation authority. Optionally (config authority only)
//! retunes the liveness window carved into the config's reserved bytes.
//!
//! Only the authority heartbeats: no third party can keep the gate armed on a
//! dead operator's behalf, and no third party can force it stale (a heartbeat is
//! one cheap transaction per window). Silence past the window relaxes the ALLOW
//! gates to moderation-optional; the BLOCK floor is never relaxed.

#![cfg(not(feature = "mainnet-canary"))]

use crate::errors::CoordinationError;
use crate::events::ModerationHeartbeatRecorded;
use crate::instructions::constants::{
    DEFAULT_MODERATION_LIVENESS_WINDOW_SECS, MAX_MODERATION_LIVENESS_WINDOW_SECS,
    MIN_MODERATION_LIVENESS_WINDOW_SECS,
};
use crate::state::ModerationConfig;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ModerationHeartbeat<'info> {
    #[account(
        mut,
        seeds = [b"moderation_config"],
        bump = moderation_config.bump
    )]
    pub moderation_config: Account<'info, ModerationConfig>,

    pub authority: Signer<'info>,
}

/// Pure authorization + window-change rule, extracted for unit tests:
/// - heartbeat: config authority OR moderation authority;
/// - window change (`Some`): config authority ONLY, bounded to
///   `[MIN, MAX]_MODERATION_LIVENESS_WINDOW_SECS` (floor + ceiling).
pub(crate) fn validate_heartbeat(
    signer: Pubkey,
    config_authority: Pubkey,
    moderation_authority: Pubkey,
    new_window_secs: Option<u32>,
) -> Result<()> {
    require!(
        signer == config_authority || signer == moderation_authority,
        CoordinationError::UnauthorizedModerationHeartbeat
    );
    if let Some(window) = new_window_secs {
        require!(
            signer == config_authority,
            CoordinationError::UnauthorizedModerationHeartbeat
        );
        // Bounded on BOTH sides: the floor stops an always-relaxed gate; the
        // ceiling stops a fat-fingered window from freezing the deadman forever.
        require!(
            (MIN_MODERATION_LIVENESS_WINDOW_SECS..=MAX_MODERATION_LIVENESS_WINDOW_SECS)
                .contains(&window),
            CoordinationError::InvalidModerationLivenessWindow
        );
    }
    Ok(())
}

pub fn handler(ctx: Context<ModerationHeartbeat>, new_window_secs: Option<u32>) -> Result<()> {
    let signer = ctx.accounts.authority.key();
    let config = &mut ctx.accounts.moderation_config;
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::UnauthorizedModerationHeartbeat
    );
    validate_heartbeat(
        signer,
        config.authority,
        config.moderation_authority,
        new_window_secs,
    )?;

    let clock = Clock::get()?;
    if let Some(window) = new_window_secs {
        config.set_liveness_window_secs(window);
    }
    // THE heartbeat: the deadman timestamp every consumption gate reads.
    config.updated_at = clock.unix_timestamp;

    let stored = config.liveness_window_secs();
    let effective = if stored > 0 {
        stored
    } else {
        DEFAULT_MODERATION_LIVENESS_WINDOW_SECS
    };
    emit!(ModerationHeartbeatRecorded {
        by: signer,
        window_secs: effective,
        timestamp: clock.unix_timestamp,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Revert-sensitive: drop the signer require! and the stranger case goes red.
    #[test]
    fn heartbeat_allows_both_authorities_and_rejects_strangers() {
        let config_auth = Pubkey::new_unique();
        let mod_auth = Pubkey::new_unique();
        let stranger = Pubkey::new_unique();
        assert!(validate_heartbeat(config_auth, config_auth, mod_auth, None).is_ok());
        assert!(validate_heartbeat(mod_auth, config_auth, mod_auth, None).is_ok());
        let err = validate_heartbeat(stranger, config_auth, mod_auth, None).unwrap_err();
        assert_eq!(
            err,
            CoordinationError::UnauthorizedModerationHeartbeat.into()
        );
    }

    // Revert-sensitive: drop the config-authority-only require! on window changes
    // and the moderation-authority case goes red.
    #[test]
    fn window_change_is_config_authority_only() {
        let config_auth = Pubkey::new_unique();
        let mod_auth = Pubkey::new_unique();
        assert!(validate_heartbeat(
            config_auth,
            config_auth,
            mod_auth,
            Some(MIN_MODERATION_LIVENESS_WINDOW_SECS)
        )
        .is_ok());
        let err = validate_heartbeat(
            mod_auth,
            config_auth,
            mod_auth,
            Some(MIN_MODERATION_LIVENESS_WINDOW_SECS),
        )
        .unwrap_err();
        assert_eq!(
            err,
            CoordinationError::UnauthorizedModerationHeartbeat.into()
        );
    }

    // Revert-sensitive: drop the floor require! and the sub-floor case goes red.
    #[test]
    fn window_change_enforces_the_one_day_floor() {
        let config_auth = Pubkey::new_unique();
        let mod_auth = Pubkey::new_unique();
        let err = validate_heartbeat(
            config_auth,
            config_auth,
            mod_auth,
            Some(MIN_MODERATION_LIVENESS_WINDOW_SECS - 1),
        )
        .unwrap_err();
        assert_eq!(
            err,
            CoordinationError::InvalidModerationLivenessWindow.into()
        );
    }

    // Revert-sensitive: widen the range check to floor-only (drop the ceiling) and
    // the over-ceiling case goes red. The boundary itself (== MAX) stays valid.
    #[test]
    fn window_change_enforces_the_ceiling() {
        let config_auth = Pubkey::new_unique();
        let mod_auth = Pubkey::new_unique();
        assert!(validate_heartbeat(
            config_auth,
            config_auth,
            mod_auth,
            Some(MAX_MODERATION_LIVENESS_WINDOW_SECS)
        )
        .is_ok());
        let err = validate_heartbeat(
            config_auth,
            config_auth,
            mod_auth,
            Some(MAX_MODERATION_LIVENESS_WINDOW_SECS + 1),
        )
        .unwrap_err();
        assert_eq!(
            err,
            CoordinationError::InvalidModerationLivenessWindow.into()
        );
    }
}
