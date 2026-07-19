//! Rotate the trusted ZK image ID (release-disabled).
//!
//! M-of-N authorization remains enforced, but this release always returns
//! `PrivateTaskCreationDisabled` before mutation. Rotation must not imply readiness
//! while no audited guest or mainnet verifier deployment exists.

use crate::errors::CoordinationError;
use crate::instructions::zk_config_helpers::reject_zk_activation;
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

pub fn handler(ctx: Context<UpdateZkImageId>, _new_image_id: [u8; HASH_SIZE]) -> Result<()> {
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

    reject_zk_activation()
}
