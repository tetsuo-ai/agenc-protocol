//! Rotate the trusted ZK image ID.
//!
//! M-of-N multisig gated (audit): the active ZK image ID is the root of trust for the
//! private-completion settlement path — complete_task_private pays out escrow on any
//! proof whose `image_id == zk_config.active_image_id`. A single compromised authority
//! key could otherwise rotate the image to an attacker-authored guest and then drain
//! escrow on every ZK-private task. This now requires the same M-of-N multisig threshold
//! that gates the treasury and protocol-fee controls (update_treasury /
//! update_protocol_fee), with co-signers passed in `remaining_accounts`.

use crate::errors::CoordinationError;
use crate::events::ZkImageIdUpdated;
use crate::instructions::zk_config_helpers::require_nonzero_image_id;
use crate::state::{ProtocolConfig, ZkConfig, HASH_SIZE};
use crate::utils::multisig::{require_multisig_threshold, unique_account_infos};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct UpdateZkImageId<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump,
        constraint = protocol_config.key() != zk_config.key() @ CoordinationError::InvalidInput
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [b"zk_config"],
        bump = zk_config.bump
    )]
    pub zk_config: Account<'info, ZkConfig>,

    #[account(
        constraint = authority.key() != protocol_config.key() @ CoordinationError::InvalidInput,
        constraint = authority.key() != zk_config.key() @ CoordinationError::InvalidInput
    )]
    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<UpdateZkImageId>, new_image_id: [u8; HASH_SIZE]) -> Result<()> {
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::MultisigNotEnoughSigners
    );
    // M-of-N multisig gate (co-signers in remaining_accounts), matching update_treasury /
    // update_protocol_fee. Replaces the previous single-authority-key check (audit): the
    // ZK image ID is a money-critical root of trust and must not be rotatable by one key.
    let unique_signers = unique_account_infos(ctx.remaining_accounts);
    require_multisig_threshold(&ctx.accounts.protocol_config, &unique_signers)?;
    require_keys_neq!(
        ctx.accounts.protocol_config.key(),
        ctx.accounts.zk_config.key(),
        CoordinationError::InvalidInput
    );
    require_nonzero_image_id(&new_image_id)?;

    let zk_config = &mut ctx.accounts.zk_config;
    require!(
        zk_config.active_image_id != new_image_id,
        CoordinationError::InvalidInput
    );

    let old_image_id = zk_config.active_image_id;
    zk_config.active_image_id = new_image_id;

    emit!(ZkImageIdUpdated {
        old_image_id,
        new_image_id,
        updated_by: ctx.accounts.authority.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
