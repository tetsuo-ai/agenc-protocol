//! Configure the task/job-spec moderation ingest gate.

use anchor_lang::prelude::*;

use crate::errors::CoordinationError;
use crate::events::TaskModerationConfigUpdated;
use crate::state::{ModerationConfig, ProtocolConfig};

#[derive(Accounts)]
pub struct ConfigureTaskModeration<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        init_if_needed,
        payer = authority,
        space = ModerationConfig::SIZE,
        seeds = [b"moderation_config"],
        bump
    )]
    pub moderation_config: Account<'info, ModerationConfig>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<ConfigureTaskModeration>,
    moderation_authority: Pubkey,
    enabled: bool,
) -> Result<()> {
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::MultisigNotEnoughSigners
    );
    require_keys_eq!(
        ctx.accounts.authority.key(),
        ctx.accounts.protocol_config.authority,
        CoordinationError::UnauthorizedAgent
    );
    require!(
        moderation_authority != Pubkey::default(),
        CoordinationError::InvalidTaskModerationAuthority
    );

    let clock = Clock::get()?;
    let config = &mut ctx.accounts.moderation_config;
    config.authority = ctx.accounts.protocol_config.authority;
    config.moderation_authority = moderation_authority;
    config.enabled = enabled;
    if config.created_at == 0 {
        config.created_at = clock.unix_timestamp;
    }
    config.updated_at = clock.unix_timestamp;
    config.bump = ctx.bumps.moderation_config;

    emit!(TaskModerationConfigUpdated {
        authority: ctx.accounts.authority.key(),
        moderation_authority,
        enabled,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
