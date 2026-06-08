//! Version checking utilities for protocol upgrades

use crate::errors::CoordinationError;
use crate::state::{ProtocolConfig, CURRENT_PROTOCOL_VERSION, MIN_SUPPORTED_VERSION};
use anchor_lang::prelude::*;

/// Check that the protocol version is compatible with the current program
///
/// # Arguments
/// * `config` - The protocol configuration account
///
/// # Returns
/// * `Ok(())` if version is compatible
/// * `Err(CoordinationError::AccountVersionTooOld)` if account needs migration
/// * `Err(CoordinationError::AccountVersionTooNew)` if program needs upgrade
/// * `Err(CoordinationError::VersionMismatchProtocol)` if config is inconsistent
pub fn check_version_compatible(config: &ProtocolConfig) -> Result<()> {
    if config.protocol_paused {
        msg!("Protocol is paused by multisig launch controls");
        return Err(CoordinationError::ProtocolPaused.into());
    }

    check_version_range(config)
}

/// Version compatibility check for EXIT / settlement paths (cancel, expire,
/// dispute resolution, close).
///
/// Identical to [`check_version_compatible`] EXCEPT it does **not** reject when
/// `protocol_paused` is set. Pausing the protocol is an entry-control: it must
/// stop NEW work (task creation, claims, bids) but must never trap funds that
/// are already escrowed. A paused protocol still has to let participants cancel,
/// let claims expire, resolve disputes, and reclaim rent — otherwise a pause
/// would lock SOL indefinitely (spec §7, "money never locks", Decision #4).
///
/// The version-range invariants (too-old / too-new / mismatch) are still
/// enforced: a genuinely incompatible account layout must not be mutated on any
/// path, exit included.
pub fn check_version_compatible_for_exit(config: &ProtocolConfig) -> Result<()> {
    check_version_range(config)
}

/// Shared protocol-version range invariants used by both the entry and exit
/// compatibility checks. Does NOT consider `protocol_paused` — callers layer
/// that gate on top when appropriate.
fn check_version_range(config: &ProtocolConfig) -> Result<()> {
    // Check if account version is below its minimum supported version
    if config.protocol_version < config.min_supported_version {
        msg!(
            "Account version {} is below its minimum supported {}",
            config.protocol_version,
            config.min_supported_version
        );
        return Err(CoordinationError::AccountVersionTooOld.into());
    }

    // Check if account version is too new (program needs upgrade)
    if config.protocol_version > CURRENT_PROTOCOL_VERSION {
        msg!(
            "Account version {} is newer than program version {}",
            config.protocol_version,
            CURRENT_PROTOCOL_VERSION
        );
        return Err(CoordinationError::AccountVersionTooNew.into());
    }

    // Check for invalid minimum supported version
    if config.min_supported_version < MIN_SUPPORTED_VERSION
        || config.min_supported_version > CURRENT_PROTOCOL_VERSION
    {
        msg!(
            "Account min_supported_version {} is outside supported range {}-{}",
            config.min_supported_version,
            MIN_SUPPORTED_VERSION,
            CURRENT_PROTOCOL_VERSION
        );
        return Err(CoordinationError::VersionMismatchProtocol.into());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_config(protocol_version: u8, min_supported_version: u8) -> ProtocolConfig {
        ProtocolConfig {
            protocol_version,
            min_supported_version,
            ..ProtocolConfig::default()
        }
    }

    #[test]
    fn test_check_version_compatible_ok() {
        let config = make_config(1, 1);
        assert!(check_version_compatible(&config).is_ok());
    }

    #[test]
    fn test_check_version_rejects_paused_protocol() {
        let mut config = make_config(1, 1);
        config.protocol_paused = true;
        assert!(check_version_compatible(&config).is_err());
    }

    #[test]
    fn test_check_version_compatible_too_new() {
        let config = make_config(2, 1);
        assert!(check_version_compatible(&config).is_err());
    }

    #[test]
    fn test_check_version_compatible_too_old() {
        // protocol_version < min_supported_version
        let config = make_config(0, 1);
        assert!(check_version_compatible(&config).is_err());
    }

    #[test]
    fn test_check_version_compatible_version_mismatch() {
        // min_supported_version 5 > CURRENT_PROTOCOL_VERSION 1
        let config = make_config(1, 5);
        assert!(check_version_compatible(&config).is_err());
    }

    // ---- exit variant (allows a paused protocol to still settle/exit) ----

    #[test]
    fn test_exit_variant_allows_paused_protocol() {
        // This is the whole point of the exit variant: a paused protocol must
        // still let escrowed funds exit. The entry check rejects this exact
        // config (see test_check_version_rejects_paused_protocol); the exit
        // check must accept it. Revert-sensitive: if the exit variant ever
        // reinstates the `protocol_paused` arm, this assertion goes red.
        let mut config = make_config(1, 1);
        config.protocol_paused = true;
        assert!(check_version_compatible(&config).is_err());
        assert!(check_version_compatible_for_exit(&config).is_ok());
    }

    #[test]
    fn test_exit_variant_ok_when_not_paused() {
        let config = make_config(1, 1);
        assert!(check_version_compatible_for_exit(&config).is_ok());
    }

    #[test]
    fn test_exit_variant_still_rejects_too_new() {
        // Version-range invariants are NOT relaxed on the exit path: a
        // genuinely incompatible layout must not be mutated even to exit.
        let config = make_config(2, 1);
        assert!(check_version_compatible_for_exit(&config).is_err());
    }

    #[test]
    fn test_exit_variant_still_rejects_too_old() {
        let config = make_config(0, 1);
        assert!(check_version_compatible_for_exit(&config).is_err());
    }

    #[test]
    fn test_exit_variant_still_rejects_version_mismatch() {
        let config = make_config(1, 5);
        assert!(check_version_compatible_for_exit(&config).is_err());
    }

    #[test]
    fn test_exit_variant_rejects_too_new_even_when_paused() {
        // Pausing does not waive the range invariant: an incompatible layout
        // stays rejected on exit regardless of pause state.
        let mut config = make_config(2, 1);
        config.protocol_paused = true;
        assert!(check_version_compatible_for_exit(&config).is_err());
    }
}
