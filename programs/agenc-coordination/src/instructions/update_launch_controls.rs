//! Update launch controls (multisig gated)

use anchor_lang::prelude::*;

use crate::errors::CoordinationError;
use crate::events::LaunchControlsUpdated;
use crate::instructions::launch_controls::validate_disabled_task_type_mask;
use crate::state::ProtocolConfig;
use crate::utils::multisig::{require_multisig_threshold, unique_account_infos};

#[derive(Accounts)]
pub struct UpdateLaunchControls<'info> {
    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub authority: Signer<'info>,
}

/// Audit F-18: `disabled_task_type_mask` sentinel meaning "keep the live value".
/// The frozen args force every call to pass all three fields, so a ceremony
/// targeting one field with stale reads of the others silently reset them (the
/// rehearsal hazard below). `0xFF` is outside the valid mask range (0b1111), so
/// it can never collide with a real mask.
pub const KEEP_DISABLED_TASK_TYPE_MASK: u8 = 0xFF;
/// Audit F-18: `surface_revision` sentinel meaning "keep the live value".
pub const KEEP_SURFACE_REVISION: u16 = u16::MAX;

fn legacy_surface_revision_write_allowed(surface_revision: u16) -> bool {
    #[cfg(feature = "mainnet-canary")]
    {
        surface_revision == 0
            && crate::instructions::migrate::is_valid_surface_revision(surface_revision)
    }
    #[cfg(not(feature = "mainnet-canary"))]
    {
        crate::instructions::migrate::is_valid_surface_revision(surface_revision)
            && surface_revision != ProtocolConfig::SURFACE_REVISION_CURRENT
    }
}

fn release_unpause_allowed(protocol_paused: bool, surface_revision: u16) -> bool {
    #[cfg(feature = "mainnet-canary")]
    {
        // The restricted canary intentionally has no production stamp path and
        // remains on the conservative revision 0 surface.
        let _ = protocol_paused;
        let _ = surface_revision;
        true
    }
    #[cfg(not(feature = "mainnet-canary"))]
    {
        protocol_paused || surface_revision == ProtocolConfig::SURFACE_REVISION_CURRENT
    }
}

/// Update launch controls and historical/conservative surface revisions (P6.5).
///
/// `surface_revision` is the operator-declared instruction-surface stamp the SDK's
/// `getDeployedSurface` reads to advertise capabilities. It is gated on the existing
/// multisig config-update authority — the same gate as the pause/disable controls.
/// The current production revision is established only by
/// `stamp_release_surface`, which atomically binds the reviewed release accounts.
///
/// NOTE: this instruction takes a typed `Account<ProtocolConfig>`, so the live
/// mainnet config MUST already have been reallocated to the P6.5 layout by
/// `migrate_protocol` before this can load it. That ordering is the intended
/// deploy → migrate → stamp choreography.
///
/// Allowed `surface_revision` values: `0` (unstamped / conservative),
/// `SURFACE_REVISION_FULL`, `SURFACE_REVISION_BATCH2`, `SURFACE_REVISION_BATCH3`,
/// `SURFACE_REVISION_BATCH4`. The current revision is rejected here so this legacy
/// path cannot bypass the atomic release boundary. In the restricted canary build,
/// explicit writes are limited to `0`; `KEEP_SURFACE_REVISION` remains available
/// for pause/mask-only changes.
///
/// The full production build may only transition to `protocol_paused = false`
/// when the resulting stored revision is CURRENT. Operators can still pause and
/// roll back to a conservative historical revision, but must complete a new
/// atomic release stamp before they can unpause again.
///
/// BATCH-4 NOTE: stamping `SURFACE_REVISION_BATCH4` is ENFORCING, not advisory —
/// it turns the goods market on (`require_goods_enabled` gates every goods
/// handler); rolling back to `SURFACE_REVISION_BATCH3` is the coarse kill switch.
/// CEREMONY HAZARD: this instruction rewrites ALL THREE fields — every stamp
/// call must fetch the live config and re-pass the live `protocol_paused` +
/// `disabled_task_type_mask` or it will silently reset them. Since audit F-18
/// you may instead pass `KEEP_DISABLED_TASK_TYPE_MASK` / `KEEP_SURFACE_REVISION`
/// to leave those fields untouched; `protocol_paused` is a bool (no in-band
/// sentinel) and must always be passed explicitly.
pub fn handler(
    ctx: Context<UpdateLaunchControls>,
    protocol_paused: bool,
    disabled_task_type_mask: u8,
    surface_revision: u16,
) -> Result<()> {
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::MultisigNotEnoughSigners
    );
    let unique_signers = unique_account_infos(ctx.remaining_accounts);
    require_multisig_threshold(&ctx.accounts.protocol_config, &unique_signers)?;

    let config = &mut ctx.accounts.protocol_config;
    let next_surface_revision = if surface_revision == KEEP_SURFACE_REVISION {
        config.surface_revision
    } else {
        require!(
            legacy_surface_revision_write_allowed(surface_revision),
            CoordinationError::InvalidSurfaceRevision
        );
        surface_revision
    };
    require!(
        release_unpause_allowed(protocol_paused, next_surface_revision),
        CoordinationError::ReleaseUnpauseRequiresCurrentSurface
    );

    config.protocol_paused = protocol_paused;
    // Audit F-18: KEEP sentinels leave the field untouched (stale-read hazard);
    // explicit values validate + apply exactly as before.
    if disabled_task_type_mask != KEEP_DISABLED_TASK_TYPE_MASK {
        validate_disabled_task_type_mask(disabled_task_type_mask)?;
        config.disabled_task_type_mask = disabled_task_type_mask;
    }
    config.surface_revision = next_surface_revision;

    emit!(LaunchControlsUpdated {
        authority: ctx.accounts.authority.key(),
        protocol_paused,
        disabled_task_type_mask: config.disabled_task_type_mask,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_path_cannot_establish_the_current_release_revision() {
        assert!(!legacy_surface_revision_write_allowed(
            ProtocolConfig::SURFACE_REVISION_CURRENT
        ));
        assert!(legacy_surface_revision_write_allowed(0));

        #[cfg(feature = "mainnet-canary")]
        for revision in 1..ProtocolConfig::SURFACE_REVISION_CURRENT {
            assert!(!legacy_surface_revision_write_allowed(revision));
        }

        #[cfg(not(feature = "mainnet-canary"))]
        for revision in 1..ProtocolConfig::SURFACE_REVISION_CURRENT {
            assert!(legacy_surface_revision_write_allowed(revision));
        }
    }

    #[test]
    fn full_build_cannot_unpause_before_the_atomic_release_stamp() {
        #[cfg(feature = "mainnet-canary")]
        {
            assert!(release_unpause_allowed(false, 0));
        }

        #[cfg(not(feature = "mainnet-canary"))]
        {
            assert!(release_unpause_allowed(true, 0));
            assert!(!release_unpause_allowed(false, 0));
            assert!(!release_unpause_allowed(
                false,
                ProtocolConfig::SURFACE_REVISION_BATCH4
            ));
            assert!(release_unpause_allowed(
                false,
                ProtocolConfig::SURFACE_REVISION_CURRENT
            ));
        }
    }
}
