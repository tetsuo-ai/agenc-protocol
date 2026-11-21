//! P1.3 moderation liveness heartbeat (batch-2 A2, `docs/MODERATION_LIVENESS.md`).
//!
//! Bumps `ModerationConfig.updated_at`, the deadman timestamp the consumption
//! gates read, under an authority signature: the config authority (protocol
//! authority), the moderation authority, or (revision 9) any `ProtocolConfig`
//! multisig owner, who must pass the appended `protocol_config`. Optionally
//! retunes the liveness window carved into the config's reserved bytes; since
//! revision 9 a window change needs `protocol_config` and the multisig threshold
//! over remaining accounts, because a 1-day or a 400-day window changes
//! moderation for all new work.
//!
//! Only the authorities and the multisig owners heartbeat: no third party can
//! keep the gate armed on a dead operator's behalf, and no third party can force
//! it stale (a heartbeat is one cheap transaction per window). Silence past the window relaxes the ALLOW
//! gates to moderation-optional; the BLOCK floor is never relaxed.

#![cfg(not(feature = "mainnet-canary"))]

use crate::errors::CoordinationError;
use crate::events::ModerationHeartbeatRecorded;
use crate::instructions::constants::{
    DEFAULT_MODERATION_LIVENESS_WINDOW_SECS, MAX_MODERATION_LIVENESS_WINDOW_SECS,
    MIN_MODERATION_LIVENESS_WINDOW_SECS,
};
use crate::state::{ModerationConfig, ProtocolConfig};
use crate::utils::multisig::{require_multisig_threshold, unique_account_infos};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ModerationHeartbeat<'info> {
    #[account(
        mut,
        seeds = [b"moderation_config"],
        bump = moderation_config.bump,
        constraint = moderation_config.validate_reserved_fields() @ CoordinationError::InvalidModerationConfig
    )]
    pub moderation_config: Account<'info, ModerationConfig>,

    pub authority: Signer<'info>,

    /// Revision 9 (G), appended and optional: the protocol config. A plain
    /// heartbeat from the config authority or the moderation authority works
    /// without it; a heartbeat from another multisig owner needs it, and a
    /// window change needs it plus the threshold over remaining accounts.
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Option<Box<Account<'info, ProtocolConfig>>>,
}

/// Pure authorization + window-change rule, extracted for unit tests:
/// - heartbeat: config authority, moderation authority, or a multisig owner
///   (`signer_is_owner`, proven against the passed `ProtocolConfig`);
/// - window change (`Some`): the multisig threshold approved it
///   (`window_approved`), bounded to `[MIN, MAX]_MODERATION_LIVENESS_WINDOW_SECS`
///   (floor + ceiling).
pub(crate) fn validate_heartbeat(
    signer: Pubkey,
    config_authority: Pubkey,
    moderation_authority: Pubkey,
    signer_is_owner: bool,
    new_window_secs: Option<u32>,
    window_approved: bool,
) -> Result<()> {
    require!(
        signer == config_authority || signer == moderation_authority || signer_is_owner,
        CoordinationError::UnauthorizedModerationHeartbeat
    );
    if let Some(window) = new_window_secs {
        require!(
            window_approved,
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
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::UnauthorizedModerationHeartbeat
    );
    let (signer_is_owner, window_approved) = match ctx.accounts.protocol_config.as_ref() {
        Some(protocol_config) => {
            let owners_len = usize::from(protocol_config.multisig_owners_len);
            let signer_is_owner = protocol_config
                .multisig_owners
                .get(..owners_len)
                .is_some_and(|owners| owners.contains(&signer));
            // A failed threshold is reported as the heartbeat's own error.
            let window_approved = new_window_secs.is_some()
                && require_multisig_threshold(
                    protocol_config,
                    &unique_account_infos(ctx.remaining_accounts),
                )
                .is_ok();
            (signer_is_owner, window_approved)
        }
        None => (false, false),
    };
    let config = &mut ctx.accounts.moderation_config;
    validate_heartbeat(
        signer,
        config.authority,
        config.moderation_authority,
        signer_is_owner,
        new_window_secs,
        window_approved,
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
    fn heartbeat_allows_both_authorities_and_any_owner_and_rejects_strangers() {
        let config_auth = Pubkey::new_unique();
        let mod_auth = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let stranger = Pubkey::new_unique();
        assert!(validate_heartbeat(config_auth, config_auth, mod_auth, false, None, false).is_ok());
        assert!(validate_heartbeat(mod_auth, config_auth, mod_auth, false, None, false).is_ok());
        // Revision 9: any multisig owner, proven against the protocol config.
        assert!(validate_heartbeat(owner, config_auth, mod_auth, true, None, false).is_ok());
        let err =
            validate_heartbeat(stranger, config_auth, mod_auth, false, None, false).unwrap_err();
        assert_eq!(
            err,
            CoordinationError::UnauthorizedModerationHeartbeat.into()
        );
    }

    // Revision 9 (G): a window change needs the multisig threshold, whoever sends
    // it. Revert-sensitive: drop the approval require! and the single-signer case
    // goes red.
    #[test]
    fn window_change_needs_the_multisig_threshold() {
        let config_auth = Pubkey::new_unique();
        let mod_auth = Pubkey::new_unique();
        let window = Some(MIN_MODERATION_LIVENESS_WINDOW_SECS);
        for (signer, is_owner) in [
            (config_auth, true),
            (mod_auth, false),
            (Pubkey::new_unique(), true),
        ] {
            let err = validate_heartbeat(signer, config_auth, mod_auth, is_owner, window, false)
                .unwrap_err();
            assert_eq!(
                err,
                CoordinationError::UnauthorizedModerationHeartbeat.into()
            );
            assert!(
                validate_heartbeat(signer, config_auth, mod_auth, is_owner, window, true).is_ok()
            );
        }
        // An approved window change still needs an allowed sender.
        let err = validate_heartbeat(
            Pubkey::new_unique(),
            config_auth,
            mod_auth,
            false,
            window,
            true,
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
            true,
            Some(MIN_MODERATION_LIVENESS_WINDOW_SECS - 1),
            true,
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
            true,
            Some(MAX_MODERATION_LIVENESS_WINDOW_SECS),
            true
        )
        .is_ok());
        let err = validate_heartbeat(
            config_auth,
            config_auth,
            mod_auth,
            true,
            Some(MAX_MODERATION_LIVENESS_WINDOW_SECS + 1),
            true,
        )
        .unwrap_err();
        assert_eq!(
            err,
            CoordinationError::InvalidModerationLivenessWindow.into()
        );
    }
}
