//! Shared helper functions for rate limiting logic.
//!
//! Used by task creation and dispute initiation instructions.

use crate::errors::CoordinationError;
use crate::events::{RateLimitHit, TaskCreationQuotaHit};
use crate::instructions::constants::{
    MAX_DISPUTE_STAKE_LAMPORTS, MIN_DISPUTE_STAKE_LAMPORTS, WINDOW_24H,
};
use crate::state::{AuthorityRateLimit, AuthorityTaskQuota, ProtocolConfig};
use anchor_lang::prelude::*;

/// Action types for rate limiting (matches RateLimitHit event field)
pub const ACTION_TYPE_TASK_CREATION: u8 = 0;
pub const ACTION_TYPE_DISPUTE_INITIATION: u8 = 1;

/// Limit types for rate limiting (matches RateLimitHit event field)
pub const LIMIT_TYPE_COOLDOWN: u8 = 0;
pub const LIMIT_TYPE_24H_WINDOW: u8 = 1;

/// One shared dispute-stake policy for protocol initialization, direct multisig
/// updates, governance proposal creation, and governance execution.
///
/// The absolute ceiling prevents overflow-shaped or economically absurd values.
/// The dynamic ceiling preserves dispute access for every worker registered at
/// the protocol's minimum agent stake. Creator disputes still intentionally
/// require twice this value in `initiate_dispute`.
pub fn is_valid_dispute_stake_limit(min_stake_for_dispute: u64, min_agent_stake: u64) -> bool {
    (MIN_DISPUTE_STAKE_LAMPORTS..=MAX_DISPUTE_STAKE_LAMPORTS).contains(&min_stake_for_dispute)
        && min_stake_for_dispute <= min_agent_stake
}

/// Rate limit action type for parameterized checking
#[derive(Clone, Copy)]
pub enum RateLimitAction {
    TaskCreation,
    DisputeInitiation,
}

impl RateLimitAction {
    /// Get the action type constant for events
    pub fn action_type(&self) -> u8 {
        match self {
            RateLimitAction::TaskCreation => ACTION_TYPE_TASK_CREATION,
            RateLimitAction::DisputeInitiation => ACTION_TYPE_DISPUTE_INITIATION,
        }
    }

    /// Get cooldown from protocol config
    pub fn get_cooldown(&self, config: &ProtocolConfig) -> i64 {
        match self {
            RateLimitAction::TaskCreation => config.task_creation_cooldown,
            RateLimitAction::DisputeInitiation => config.dispute_initiation_cooldown,
        }
    }

    /// Get max actions per 24h from protocol config
    pub fn get_max_per_24h(&self, config: &ProtocolConfig) -> u8 {
        match self {
            RateLimitAction::TaskCreation => config.max_tasks_per_24h,
            RateLimitAction::DisputeInitiation => config.max_disputes_per_24h,
        }
    }

    /// Get last action timestamp from authority-scoped rate limit state
    pub fn get_last_authority_timestamp(&self, authority_rate_limit: &AuthorityRateLimit) -> i64 {
        match self {
            RateLimitAction::TaskCreation => authority_rate_limit.last_task_created,
            RateLimitAction::DisputeInitiation => authority_rate_limit.last_dispute_initiated,
        }
    }

    /// Get current count from authority-scoped rate limit state
    pub fn get_authority_count(&self, authority_rate_limit: &AuthorityRateLimit) -> u8 {
        match self {
            RateLimitAction::TaskCreation => authority_rate_limit.task_count_24h,
            RateLimitAction::DisputeInitiation => authority_rate_limit.dispute_count_24h,
        }
    }

    /// Update last action timestamp on authority-scoped rate limit state
    pub fn set_authority_last_timestamp(
        &self,
        authority_rate_limit: &mut AuthorityRateLimit,
        timestamp: i64,
    ) {
        match self {
            RateLimitAction::TaskCreation => authority_rate_limit.last_task_created = timestamp,
            RateLimitAction::DisputeInitiation => {
                authority_rate_limit.last_dispute_initiated = timestamp
            }
        }
    }

    /// Increment count on authority-scoped rate limit state, returns error on overflow
    pub fn increment_authority_count(
        &self,
        authority_rate_limit: &mut AuthorityRateLimit,
    ) -> Result<()> {
        match self {
            RateLimitAction::TaskCreation => {
                authority_rate_limit.task_count_24h = authority_rate_limit
                    .task_count_24h
                    .checked_add(1)
                    .ok_or(CoordinationError::ArithmeticOverflow)?;
            }
            RateLimitAction::DisputeInitiation => {
                authority_rate_limit.dispute_count_24h = authority_rate_limit
                    .dispute_count_24h
                    .checked_add(1)
                    .ok_or(CoordinationError::ArithmeticOverflow)?;
            }
        }
        Ok(())
    }
}

/// Emit a rate limit hit event with the given parameters
fn emit_rate_limit_hit(
    agent_id: [u8; 32],
    action: RateLimitAction,
    limit_type: u8,
    current_count: u8,
    max_count: u8,
    cooldown_remaining: i64,
    timestamp: i64,
) {
    emit!(RateLimitHit {
        agent_id,
        action_type: action.action_type(),
        limit_type,
        current_count,
        max_count,
        cooldown_remaining,
        timestamp,
    });
}

/// Reset the 24h rate limit window for wallet-scoped state if expired.
pub(crate) fn maybe_reset_authority_window(
    authority_rate_limit: &mut AuthorityRateLimit,
    clock: &Clock,
) {
    // Using saturating_sub intentionally - handles clock drift safely
    if clock
        .unix_timestamp
        .saturating_sub(authority_rate_limit.rate_limit_window_start)
        >= WINDOW_24H
    {
        let window_start = clock
            .unix_timestamp
            .div_euclid(WINDOW_24H)
            .saturating_mul(WINDOW_24H);
        authority_rate_limit.rate_limit_window_start = window_start;
        authority_rate_limit.task_count_24h = 0;
        authority_rate_limit.dispute_count_24h = 0;
    }
}

/// Initialize wallet-scoped rate limit state on first use.
pub(crate) fn initialize_authority_rate_limit(
    authority_rate_limit: &mut AuthorityRateLimit,
    authority: Pubkey,
    bump: u8,
    clock: &Clock,
) {
    if authority_rate_limit.authority == Pubkey::default() {
        authority_rate_limit.authority = authority;
        authority_rate_limit.rate_limit_window_start = clock
            .unix_timestamp
            .div_euclid(WINDOW_24H)
            .saturating_mul(WINDOW_24H);
        authority_rate_limit.bump = bump;
    }
}

/// Check wallet-scoped rate limits for task creation and dispute initiation.
///
/// This closes the multi-agent bypass where one authority wallet could mint
/// multiple agents and rotate between them to evade task/dispute throttles.
pub fn check_authority_rate_limits(
    authority_rate_limit: &mut AuthorityRateLimit,
    authority: Pubkey,
    authority_bump: u8,
    invoking_agent_id: [u8; 32],
    config: &ProtocolConfig,
    clock: &Clock,
    action: RateLimitAction,
) -> Result<()> {
    initialize_authority_rate_limit(authority_rate_limit, authority, authority_bump, clock);

    let cooldown = action.get_cooldown(config);
    let max_per_24h = action.get_max_per_24h(config);
    let last_timestamp = action.get_last_authority_timestamp(authority_rate_limit);

    if cooldown > 0 && last_timestamp > 0 {
        let elapsed = clock.unix_timestamp.saturating_sub(last_timestamp);
        if elapsed < cooldown {
            let remaining = cooldown.saturating_sub(elapsed);
            emit_rate_limit_hit(
                invoking_agent_id,
                action,
                LIMIT_TYPE_COOLDOWN,
                action.get_authority_count(authority_rate_limit),
                max_per_24h,
                remaining,
                clock.unix_timestamp,
            );
            return Err(CoordinationError::CooldownNotElapsed.into());
        }
    }

    if max_per_24h > 0 {
        maybe_reset_authority_window(authority_rate_limit, clock);

        let current_count = action.get_authority_count(authority_rate_limit);
        if current_count >= max_per_24h {
            emit_rate_limit_hit(
                invoking_agent_id,
                action,
                LIMIT_TYPE_24H_WINDOW,
                current_count,
                max_per_24h,
                0,
                clock.unix_timestamp,
            );
            return Err(CoordinationError::RateLimitExceeded.into());
        }

        action.increment_authority_count(authority_rate_limit)?;
    }

    action.set_authority_last_timestamp(authority_rate_limit, clock.unix_timestamp);
    Ok(())
}

/// Check wallet-scoped rate limits for task creation.
pub fn check_authority_task_creation_rate_limits(
    authority_rate_limit: &mut AuthorityRateLimit,
    authority: Pubkey,
    authority_bump: u8,
    invoking_agent_id: [u8; 32],
    config: &ProtocolConfig,
    clock: &Clock,
) -> Result<()> {
    check_authority_rate_limits(
        authority_rate_limit,
        authority,
        authority_bump,
        invoking_agent_id,
        config,
        clock,
        RateLimitAction::TaskCreation,
    )
}

pub const MIN_EXTENDED_TASK_QUOTA: u32 = 256;
pub const MAX_EXTENDED_TASK_QUOTA: u32 = 1000;

/// Merge legacy writes without resetting the shared calendar-day budget. Once
/// the wide count reaches 255, the legacy u8 counter is saturated and every
/// legacy task entry is exhausted, even if the caller omits its quota account.
pub(crate) fn synchronize_task_quota(
    quota: &mut AuthorityTaskQuota,
    legacy: &AuthorityRateLimit,
) -> Result<()> {
    require!(
        quota.authority == legacy.authority,
        CoordinationError::InvalidTaskQuotaAccount
    );
    require!(
        quota._reserved == [0u8; 6],
        CoordinationError::CorruptedData
    );
    require!(
        quota.rate_limit_window_start <= legacy.rate_limit_window_start,
        CoordinationError::CorruptedData
    );
    if quota.rate_limit_window_start < legacy.rate_limit_window_start {
        quota.rate_limit_window_start = legacy.rate_limit_window_start;
        quota.task_count_24h = u32::from(legacy.task_count_24h);
    } else {
        quota.task_count_24h = quota.task_count_24h.max(u32::from(legacy.task_count_24h));
    }
    Ok(())
}

/// Optional remaining-account extension shared by all five task entry paths.
/// No suffix retains the stricter legacy cap; it cannot bypass an extended cap
/// because that cap is always greater than every representable legacy limit.
#[allow(clippy::too_many_arguments)]
pub fn check_task_creation_with_optional_quota(
    legacy: &mut AuthorityRateLimit,
    authority: Pubkey,
    authority_bump: u8,
    invoking_agent_id: [u8; 32],
    config: &ProtocolConfig,
    clock: &Clock,
    remaining: &[AccountInfo<'_>],
) -> Result<()> {
    if remaining.is_empty() {
        return check_authority_task_creation_rate_limits(
            legacy,
            authority,
            authority_bump,
            invoking_agent_id,
            config,
            clock,
        );
    }
    require!(
        config.surface_revision >= ProtocolConfig::SURFACE_REVISION_TASK_QUOTAS,
        CoordinationError::TaskQuotaUnavailable
    );
    require!(
        remaining.len() == 1,
        CoordinationError::InvalidTaskQuotaAccount
    );
    let info = &remaining[0];
    let (expected, bump) =
        Pubkey::find_program_address(&[b"authority_task_quota", authority.as_ref()], &crate::ID);
    require!(
        info.key() == expected
            && info.owner == &crate::ID
            && info.is_writable
            && info.data_len() == AuthorityTaskQuota::SIZE,
        CoordinationError::InvalidTaskQuotaAccount
    );
    let mut quota = AuthorityTaskQuota::try_deserialize(&mut &info.try_borrow_data()?[..])?;
    require!(
        quota.authority == authority && quota.bump == bump,
        CoordinationError::InvalidTaskQuotaAccount
    );
    require!(
        (MIN_EXTENDED_TASK_QUOTA..=MAX_EXTENDED_TASK_QUOTA).contains(&quota.max_tasks_per_24h),
        CoordinationError::InvalidTaskQuota
    );
    require!(
        config.task_creation_cooldown >= 1 && config.max_tasks_per_24h >= 1,
        CoordinationError::RateLimitBelowMinimum
    );
    initialize_authority_rate_limit(legacy, authority, authority_bump, clock);
    maybe_reset_authority_window(legacy, clock);
    synchronize_task_quota(&mut quota, legacy)?;
    if !quota.enabled {
        check_authority_task_creation_rate_limits(
            legacy,
            authority,
            authority_bump,
            invoking_agent_id,
            config,
            clock,
        )?;
        synchronize_task_quota(&mut quota, legacy)?;
    } else {
        let elapsed = clock
            .unix_timestamp
            .saturating_sub(legacy.last_task_created);
        if legacy.last_task_created > 0 && elapsed < config.task_creation_cooldown {
            emit!(TaskCreationQuotaHit {
                authority,
                current_count: quota.task_count_24h,
                max_count: quota.max_tasks_per_24h,
                cooldown_remaining: config.task_creation_cooldown.saturating_sub(elapsed),
                timestamp: clock.unix_timestamp
            });
            return err!(CoordinationError::CooldownNotElapsed);
        }
        if quota.task_count_24h >= quota.max_tasks_per_24h {
            emit!(TaskCreationQuotaHit {
                authority,
                current_count: quota.task_count_24h,
                max_count: quota.max_tasks_per_24h,
                cooldown_remaining: 0,
                timestamp: clock.unix_timestamp
            });
            return err!(CoordinationError::RateLimitExceeded);
        }
        quota.task_count_24h = quota
            .task_count_24h
            .checked_add(1)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        legacy.task_count_24h = quota.task_count_24h.min(u32::from(u8::MAX)) as u8;
        legacy.last_task_created = clock.unix_timestamp;
    }
    quota.try_serialize(&mut &mut info.try_borrow_mut_data()?[..])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispute_stake_limit_has_identical_absolute_and_registration_caps() {
        assert!(!is_valid_dispute_stake_limit(0, 10_000_000));
        assert!(is_valid_dispute_stake_limit(1_000, 10_000_000));
        assert!(is_valid_dispute_stake_limit(10_000_000, 10_000_000));
        assert!(!is_valid_dispute_stake_limit(10_000_001, 10_000_000));
        assert!(is_valid_dispute_stake_limit(
            MAX_DISPUTE_STAKE_LAMPORTS,
            MAX_DISPUTE_STAKE_LAMPORTS,
        ));
        assert!(!is_valid_dispute_stake_limit(
            MAX_DISPUTE_STAKE_LAMPORTS + 1,
            MAX_DISPUTE_STAKE_LAMPORTS + 1,
        ));
        assert!(!is_valid_dispute_stake_limit(u64::MAX, u64::MAX));
    }

    fn test_clock(unix_timestamp: i64) -> Clock {
        Clock {
            slot: 0,
            epoch_start_timestamp: 0,
            epoch: 0,
            leader_schedule_epoch: 0,
            unix_timestamp,
        }
    }

    fn assert_anchor_error_code<T>(result: Result<T>, expected: CoordinationError) {
        let expected_code: u32 = expected.into();
        match result {
            Ok(_) => panic!("expected AnchorError code {expected_code}, got success"),
            Err(anchor_lang::error::Error::AnchorError(anchor_err)) => {
                assert_eq!(anchor_err.error_code_number, expected_code);
            }
            Err(other) => panic!("expected AnchorError code {expected_code}, got {other:?}"),
        }
    }

    #[test]
    fn task_quota_merges_legacy_usage_and_only_resets_for_a_later_window() {
        let authority = Pubkey::new_unique();
        let mut legacy = AuthorityRateLimit {
            authority,
            task_count_24h: 42,
            rate_limit_window_start: WINDOW_24H,
            ..AuthorityRateLimit::default()
        };
        let mut quota = AuthorityTaskQuota {
            authority,
            max_tasks_per_24h: 300,
            task_count_24h: 40,
            rate_limit_window_start: WINDOW_24H,
            enabled: true,
            ..AuthorityTaskQuota::default()
        };
        synchronize_task_quota(&mut quota, &legacy).unwrap();
        assert_eq!(quota.task_count_24h, 42);
        // A saturated u8 counter must not replenish the wider budget.
        quota.task_count_24h = 299;
        legacy.task_count_24h = 255;
        synchronize_task_quota(&mut quota, &legacy).unwrap();
        assert_eq!(quota.task_count_24h, 299);
        // A dispute may already have advanced the shared calendar window.
        legacy.rate_limit_window_start = 2 * WINDOW_24H;
        legacy.task_count_24h = 3;
        synchronize_task_quota(&mut quota, &legacy).unwrap();
        assert_eq!(quota.task_count_24h, 3);
        assert_eq!(quota.rate_limit_window_start, 2 * WINDOW_24H);
        legacy.rate_limit_window_start = WINDOW_24H;
        assert_anchor_error_code(
            synchronize_task_quota(&mut quota, &legacy),
            CoordinationError::CorruptedData,
        );
        assert_eq!(quota.task_count_24h, 3);
        legacy.rate_limit_window_start = 2 * WINDOW_24H;
        quota._reserved[5] = 1;
        assert_anchor_error_code(
            synchronize_task_quota(&mut quota, &legacy),
            CoordinationError::CorruptedData,
        );
        quota._reserved[5] = 0;
        quota.authority = Pubkey::new_unique();
        assert_anchor_error_code(
            synchronize_task_quota(&mut quota, &legacy),
            CoordinationError::InvalidTaskQuotaAccount,
        );
    }

    #[test]
    fn serialized_task_quota_admits_256_then_rejects_every_agent_without_touching_disputes() {
        let authority = Pubkey::new_unique();
        let (address, bump) = Pubkey::find_program_address(
            &[b"authority_task_quota", authority.as_ref()],
            &crate::ID,
        );
        let quota = AuthorityTaskQuota {
            authority,
            max_tasks_per_24h: 256,
            task_count_24h: 255,
            enabled: true,
            bump,
            ..AuthorityTaskQuota::default()
        };
        let mut data = vec![];
        quota.try_serialize(&mut data).unwrap();
        assert_eq!(data.len(), AuthorityTaskQuota::SIZE);
        let mut lamports = 1_000_000;
        let info = AccountInfo::new(
            &address,
            false,
            true,
            &mut lamports,
            &mut data,
            &crate::ID,
            false,
            0,
        );
        let config = ProtocolConfig {
            surface_revision: ProtocolConfig::SURFACE_REVISION_TASK_QUOTAS,
            task_creation_cooldown: 1,
            max_tasks_per_24h: 255,
            ..ProtocolConfig::default()
        };
        let mut legacy = AuthorityRateLimit {
            authority,
            task_count_24h: 255,
            last_task_created: 1_000,
            dispute_count_24h: 7,
            last_dispute_initiated: 999,
            ..AuthorityRateLimit::default()
        };
        let before = info.try_borrow_data().unwrap().to_vec();
        assert_anchor_error_code(
            check_task_creation_with_optional_quota(
                &mut legacy,
                authority,
                7,
                [1; 32],
                &config,
                &test_clock(1_000),
                std::slice::from_ref(&info),
            ),
            CoordinationError::CooldownNotElapsed,
        );
        assert_eq!(&info.try_borrow_data().unwrap()[..], before.as_slice());
        check_task_creation_with_optional_quota(
            &mut legacy,
            authority,
            7,
            [1; 32],
            &config,
            &test_clock(1_001),
            std::slice::from_ref(&info),
        )
        .unwrap();
        let saved =
            AuthorityTaskQuota::try_deserialize(&mut &info.try_borrow_data().unwrap()[..]).unwrap();
        assert_eq!(saved.task_count_24h, 256);
        assert_eq!(legacy.task_count_24h, 255);
        assert_eq!(legacy.last_task_created, 1_001);
        let at_capacity = info.try_borrow_data().unwrap().to_vec();
        for agent_id in [[1; 32], [2; 32]] {
            assert_anchor_error_code(
                check_task_creation_with_optional_quota(
                    &mut legacy,
                    authority,
                    7,
                    agent_id,
                    &config,
                    &test_clock(1_002),
                    std::slice::from_ref(&info),
                ),
                CoordinationError::RateLimitExceeded,
            );
        }
        assert_anchor_error_code(
            check_task_creation_with_optional_quota(
                &mut legacy,
                authority,
                7,
                [2; 32],
                &config,
                &test_clock(1_002),
                &[],
            ),
            CoordinationError::RateLimitExceeded,
        );
        assert_eq!(&info.try_borrow_data().unwrap()[..], at_capacity.as_slice());
        assert_eq!(legacy.dispute_count_24h, 7);
        assert_eq!(legacy.last_dispute_initiated, 999);
    }

    #[test]
    fn disabled_quota_retains_usage_and_obeys_the_legacy_limit() {
        let authority = Pubkey::new_unique();
        let (address, bump) = Pubkey::find_program_address(
            &[b"authority_task_quota", authority.as_ref()],
            &crate::ID,
        );
        let quota = AuthorityTaskQuota {
            authority,
            max_tasks_per_24h: 256,
            task_count_24h: 2,
            bump,
            ..AuthorityTaskQuota::default()
        };
        let mut data = vec![];
        quota.try_serialize(&mut data).unwrap();
        let mut lamports = 1_000_000;
        let info = AccountInfo::new(
            &address,
            false,
            true,
            &mut lamports,
            &mut data,
            &crate::ID,
            false,
            0,
        );
        let mut config = ProtocolConfig {
            surface_revision: ProtocolConfig::SURFACE_REVISION_TASK_QUOTAS,
            task_creation_cooldown: 1,
            max_tasks_per_24h: 3,
            ..ProtocolConfig::default()
        };
        let mut legacy = AuthorityRateLimit {
            authority,
            task_count_24h: 2,
            last_task_created: 1_000,
            ..AuthorityRateLimit::default()
        };
        check_task_creation_with_optional_quota(
            &mut legacy,
            authority,
            7,
            [1; 32],
            &config,
            &test_clock(1_001),
            std::slice::from_ref(&info),
        )
        .unwrap();
        let saved =
            AuthorityTaskQuota::try_deserialize(&mut &info.try_borrow_data().unwrap()[..]).unwrap();
        assert_eq!(saved.task_count_24h, 3);
        assert!(!saved.enabled);
        assert_anchor_error_code(
            check_task_creation_with_optional_quota(
                &mut legacy,
                authority,
                7,
                [2; 32],
                &config,
                &test_clock(1_002),
                std::slice::from_ref(&info),
            ),
            CoordinationError::RateLimitExceeded,
        );
        config.surface_revision = ProtocolConfig::SURFACE_REVISION_TASK_QUOTAS - 1;
        assert_anchor_error_code(
            check_task_creation_with_optional_quota(
                &mut legacy,
                authority,
                7,
                [2; 32],
                &config,
                &test_clock(1_002),
                std::slice::from_ref(&info),
            ),
            CoordinationError::TaskQuotaUnavailable,
        );
    }

    #[test]
    fn authority_task_cooldown_is_shared_across_agents() {
        let authority = Pubkey::new_unique();
        let mut authority_rate_limit = AuthorityRateLimit::default();
        let config = ProtocolConfig {
            task_creation_cooldown: 60,
            max_tasks_per_24h: 50,
            ..ProtocolConfig::default()
        };

        check_authority_task_creation_rate_limits(
            &mut authority_rate_limit,
            authority,
            7,
            [1u8; 32],
            &config,
            &test_clock(1_000),
        )
        .unwrap();

        assert_eq!(authority_rate_limit.authority, authority);
        assert_eq!(authority_rate_limit.task_count_24h, 1);

        let result = check_authority_task_creation_rate_limits(
            &mut authority_rate_limit,
            authority,
            7,
            [2u8; 32],
            &config,
            &test_clock(1_001),
        );

        assert_anchor_error_code(result, CoordinationError::CooldownNotElapsed);
        assert_eq!(authority_rate_limit.task_count_24h, 1);
    }

    #[test]
    fn authority_task_daily_limit_is_shared_across_agents() {
        let authority = Pubkey::new_unique();
        let mut authority_rate_limit = AuthorityRateLimit::default();
        let config = ProtocolConfig {
            task_creation_cooldown: 0,
            max_tasks_per_24h: 1,
            ..ProtocolConfig::default()
        };

        check_authority_task_creation_rate_limits(
            &mut authority_rate_limit,
            authority,
            9,
            [3u8; 32],
            &config,
            &test_clock(2_000),
        )
        .unwrap();

        let result = check_authority_task_creation_rate_limits(
            &mut authority_rate_limit,
            authority,
            9,
            [4u8; 32],
            &config,
            &test_clock(2_001),
        );

        assert_anchor_error_code(result, CoordinationError::RateLimitExceeded);
        assert_eq!(authority_rate_limit.task_count_24h, 1);
    }

    #[test]
    fn authority_dispute_cooldown_is_shared_across_agents() {
        let authority = Pubkey::new_unique();
        let mut authority_rate_limit = AuthorityRateLimit::default();
        let config = ProtocolConfig {
            dispute_initiation_cooldown: 300,
            max_disputes_per_24h: 10,
            ..ProtocolConfig::default()
        };

        check_authority_rate_limits(
            &mut authority_rate_limit,
            authority,
            11,
            [5u8; 32],
            &config,
            &test_clock(3_000),
            RateLimitAction::DisputeInitiation,
        )
        .unwrap();

        let result = check_authority_rate_limits(
            &mut authority_rate_limit,
            authority,
            11,
            [6u8; 32],
            &config,
            &test_clock(3_001),
            RateLimitAction::DisputeInitiation,
        );

        assert_anchor_error_code(result, CoordinationError::CooldownNotElapsed);
        assert_eq!(authority_rate_limit.dispute_count_24h, 1);
    }

    #[test]
    fn authority_dispute_daily_limit_is_shared_across_agents() {
        let authority = Pubkey::new_unique();
        let mut authority_rate_limit = AuthorityRateLimit::default();
        let config = ProtocolConfig {
            dispute_initiation_cooldown: 0,
            max_disputes_per_24h: 1,
            ..ProtocolConfig::default()
        };

        check_authority_rate_limits(
            &mut authority_rate_limit,
            authority,
            12,
            [7u8; 32],
            &config,
            &test_clock(4_000),
            RateLimitAction::DisputeInitiation,
        )
        .unwrap();

        let result = check_authority_rate_limits(
            &mut authority_rate_limit,
            authority,
            12,
            [8u8; 32],
            &config,
            &test_clock(4_001),
            RateLimitAction::DisputeInitiation,
        );

        assert_anchor_error_code(result, CoordinationError::RateLimitExceeded);
        assert_eq!(authority_rate_limit.dispute_count_24h, 1);
    }
}
