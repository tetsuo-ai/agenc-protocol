//! Configure the task/job-spec moderation ingest gate.

use anchor_lang::prelude::*;

use crate::errors::CoordinationError;
use crate::events::TaskModerationConfigUpdated;
use crate::state::{ModerationConfig, ProtocolConfig};
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

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<ConfigureTaskModeration>,
    moderation_authority: Pubkey,
    enabled: bool,
) -> Result<()> {
    // The moderation/job-spec gate decides which task claims are allowed, so it
    // is a protocol security control and must be governed like the other admin
    // mutators (update_treasury / update_protocol_fee / update_multisig) rather
    // than by a single key. Require a multisig threshold of distinct multisig
    // owner signers (passed via remaining_accounts), matching update_treasury.
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::MultisigNotEnoughSigners
    );
    let unique_signers = unique_account_infos(ctx.remaining_accounts);
    require_multisig_threshold(&ctx.accounts.protocol_config, &unique_signers)?;
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
