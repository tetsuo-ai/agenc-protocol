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

pub fn handler(
    ctx: Context<UpdateLaunchControls>,
    protocol_paused: bool,
    disabled_task_type_mask: u8,
) -> Result<()> {
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::MultisigNotEnoughSigners
    );
    let unique_signers = unique_account_infos(ctx.remaining_accounts);
    require_multisig_threshold(&ctx.accounts.protocol_config, &unique_signers)?;
    validate_disabled_task_type_mask(disabled_task_type_mask)?;

    let config = &mut ctx.accounts.protocol_config;
    config.protocol_paused = protocol_paused;
    config.disabled_task_type_mask = disabled_task_type_mask;

    emit!(LaunchControlsUpdated {
        authority: ctx.accounts.authority.key(),
        protocol_paused,
        disabled_task_type_mask,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
