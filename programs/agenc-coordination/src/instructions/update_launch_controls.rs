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
/// `SURFACE_REVISION_FULL`, or `SURFACE_REVISION_BATCH2`. Unknown values are
/// rejected so an operator cannot stamp a surface the SDK does not understand.
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
    validate_disabled_task_type_mask(disabled_task_type_mask)?;
    require!(
        crate::instructions::migrate::is_valid_surface_revision(surface_revision),
        CoordinationError::InvalidSurfaceRevision
    );

    let config = &mut ctx.accounts.protocol_config;
    config.protocol_paused = protocol_paused;
    config.disabled_task_type_mask = disabled_task_type_mask;
    config.surface_revision = surface_revision;

    emit!(LaunchControlsUpdated {
        authority: ctx.accounts.authority.key(),
        protocol_paused,
        disabled_task_type_mask,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
