//! Configure the task/job-spec moderation ingest gate.
//!
//! Revision 9 (G): turning moderation on or off and choosing the global
//! moderator need the `ProtocolConfig` multisig threshold (2 of 3 on mainnet),
//! with the co-signers in remaining accounts, exactly like `set_moderation_block`.
//! The signer is the fee payer and proposer; the threshold decides. The canary
//! build keeps the single protocol-authority signer.

use anchor_lang::prelude::*;

use crate::errors::CoordinationError;
use crate::events::TaskModerationConfigUpdated;
use crate::state::{ModerationConfig, ProtocolConfig};
#[cfg(not(feature = "mainnet-canary"))]
use crate::utils::multisig::{require_multisig_threshold, unique_account_infos};

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

    /// Fee payer and proposer. On the full surface the approval is the multisig
    /// threshold over `remaining_accounts`; the canary requires the protocol
    /// authority itself.
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
    #[cfg(not(feature = "mainnet-canary"))]
    {
        let unique_signers = unique_account_infos(ctx.remaining_accounts);
        require_multisig_threshold(&ctx.accounts.protocol_config, &unique_signers)?;
    }
    #[cfg(feature = "mainnet-canary")]
    require_keys_eq!(
        ctx.accounts.authority.key(),
        ctx.accounts.protocol_config.authority,
        CoordinationError::UnauthorizedAgent
    );
    require!(
        moderation_authority != Pubkey::default(),
        CoordinationError::InvalidTaskModerationAuthority
    );
    require!(
        ctx.accounts.moderation_config.validate_reserved_fields(),
        CoordinationError::InvalidModerationConfig
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
