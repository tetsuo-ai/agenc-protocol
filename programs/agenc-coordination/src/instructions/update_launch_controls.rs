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

/// Update launch controls AND stamp the deployed surface revision (P6.5).
///
/// `surface_revision` is the operator-declared instruction-surface stamp the SDK's
/// `getDeployedSurface` reads to advertise capabilities. It is gated on the existing
/// multisig config-update authority — the same gate as the pause/disable controls —
/// so stamping the live surface needs no new instruction and no new authority path.
///
/// NOTE: this instruction takes a typed `Account<ProtocolConfig>`, so the live
/// mainnet config MUST already have been reallocated to the P6.5 layout by
/// `migrate_protocol` before this can load it. That ordering is the intended
/// deploy → migrate → stamp choreography.
///
/// Allowed `surface_revision` values: `0` (unstamped / conservative),
/// `SURFACE_REVISION_FULL`, `SURFACE_REVISION_BATCH2`, `SURFACE_REVISION_BATCH3`,
/// or `SURFACE_REVISION_BATCH4`. Unknown values are
/// rejected so an operator cannot stamp a surface the SDK does not understand.
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
    config.protocol_paused = protocol_paused;
    // Audit F-18: KEEP sentinels leave the field untouched (stale-read hazard);
    // explicit values validate + apply exactly as before.
    if disabled_task_type_mask != KEEP_DISABLED_TASK_TYPE_MASK {
        validate_disabled_task_type_mask(disabled_task_type_mask)?;
        config.disabled_task_type_mask = disabled_task_type_mask;
    }
    if surface_revision != KEEP_SURFACE_REVISION {
        require!(
            crate::instructions::migrate::is_valid_surface_revision(surface_revision),
            CoordinationError::InvalidSurfaceRevision
        );
        config.surface_revision = surface_revision;
    }

    emit!(LaunchControlsUpdated {
        authority: ctx.accounts.authority.key(),
        protocol_paused,
        disabled_task_type_mask: config.disabled_task_type_mask,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
