//! Initialize trusted ZK image ID configuration.

use crate::errors::CoordinationError;
use crate::events::ZkConfigInitialized;
use crate::instructions::zk_config_helpers::require_nonzero_image_id;
use crate::state::{ProtocolConfig, ZkConfig, HASH_SIZE};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct InitializeZkConfig<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump,
        has_one = authority @ CoordinationError::UnauthorizedProtocolAuthority,
        constraint = protocol_config.key() != zk_config.key() @ CoordinationError::InvalidInput
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        init,
        payer = authority,
        space = ZkConfig::SIZE,
        seeds = [b"zk_config"],
        bump
    )]
    pub zk_config: Account<'info, ZkConfig>,

    #[account(
        mut,
        constraint = authority.key() != protocol_config.key() @ CoordinationError::InvalidInput,
        constraint = authority.key() != zk_config.key() @ CoordinationError::InvalidInput
    )]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeZkConfig>, active_image_id: [u8; HASH_SIZE]) -> Result<()> {
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::UnauthorizedProtocolAuthority
    );
    require!(
        ctx.accounts.zk_config.active_image_id == [0u8; HASH_SIZE]
            && ctx.accounts.zk_config.bump == 0,
        CoordinationError::InvalidInput
    );
    require!(
        ctx.accounts.authority.key() == ctx.accounts.protocol_config.authority,
        CoordinationError::UnauthorizedProtocolAuthority
    );
    require_keys_neq!(
        ctx.accounts.protocol_config.key(),
        ctx.accounts.zk_config.key(),
        CoordinationError::InvalidInput
    );
    require_nonzero_image_id(&active_image_id)?;

    let zk_config = &mut ctx.accounts.zk_config;
    zk_config.active_image_id = active_image_id;
    zk_config.bump = ctx.bumps.zk_config;
    zk_config._reserved = [0u8; 31];

    emit!(ZkConfigInitialized {
        image_id: active_image_id,
        authority: ctx.accounts.authority.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
