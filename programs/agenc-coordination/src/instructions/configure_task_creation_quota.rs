//! Bounded, opt-in u32 task capacity for a wallet, approved by the protocol multisig.
use crate::errors::CoordinationError;
use crate::events::TaskCreationQuotaConfigured;
use crate::instructions::rate_limit_helpers::{
    initialize_authority_rate_limit, maybe_reset_authority_window, synchronize_task_quota,
    MAX_EXTENDED_TASK_QUOTA, MIN_EXTENDED_TASK_QUOTA,
};
use crate::state::{AuthorityRateLimit, AuthorityTaskQuota, ProtocolConfig};
use crate::utils::multisig::{require_multisig_threshold, unique_account_infos};
use crate::utils::version::check_version_compatible_for_exit;
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(task_authority: Pubkey)]
pub struct ConfigureTaskCreationQuota<'info> {
    #[account(seeds = [b"protocol"], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(init_if_needed, payer = authority, space = AuthorityTaskQuota::SIZE,
        seeds = [b"authority_task_quota", task_authority.as_ref()], bump)]
    pub task_quota: Account<'info, AuthorityTaskQuota>,
    #[account(init_if_needed, payer = authority, space = AuthorityRateLimit::SIZE,
        seeds = [b"authority_rate_limit", task_authority.as_ref()], bump)]
    pub quota_authority_rate_limit: Account<'info, AuthorityRateLimit>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<ConfigureTaskCreationQuota>,
    task_authority: Pubkey,
    max_tasks_per_24h: u32,
    enabled: bool,
) -> Result<()> {
    check_version_compatible_for_exit(&ctx.accounts.protocol_config)?;
    require_multisig_threshold(
        &ctx.accounts.protocol_config,
        &unique_account_infos(ctx.remaining_accounts),
    )?;
    require!(
        task_authority != Pubkey::default(),
        CoordinationError::InvalidInput
    );
    require!(
        (MIN_EXTENDED_TASK_QUOTA..=MAX_EXTENDED_TASK_QUOTA).contains(&max_tasks_per_24h),
        CoordinationError::InvalidTaskQuota
    );
    let clock = Clock::get()?;
    let legacy = &mut ctx.accounts.quota_authority_rate_limit;
    require!(
        legacy.authority == Pubkey::default() || legacy.authority == task_authority,
        CoordinationError::InvalidTaskQuotaAccount
    );
    initialize_authority_rate_limit(
        legacy,
        task_authority,
        ctx.bumps.quota_authority_rate_limit,
        &clock,
    );
    maybe_reset_authority_window(legacy, &clock);
    let quota = &mut ctx.accounts.task_quota;
    if quota.authority == Pubkey::default() {
        quota.authority = task_authority;
        quota.rate_limit_window_start = legacy.rate_limit_window_start;
        quota.task_count_24h = u32::from(legacy.task_count_24h);
        quota.bump = ctx.bumps.task_quota;
        quota._reserved = [0u8; 6];
    }
    synchronize_task_quota(quota, legacy)?;
    // Updating, disabling, or re-enabling a grant never replenishes its budget.
    quota.max_tasks_per_24h = max_tasks_per_24h;
    quota.enabled = enabled;
    emit!(TaskCreationQuotaConfigured {
        authority: task_authority,
        max_tasks_per_24h,
        enabled,
        updated_by: ctx.accounts.authority.key(),
        timestamp: clock.unix_timestamp
    });
    Ok(())
}
