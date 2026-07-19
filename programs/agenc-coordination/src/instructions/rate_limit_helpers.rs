//! Shared helper functions for rate limiting logic.
//!
//! Used by task creation and dispute initiation instructions.

use crate::errors::CoordinationError;
use crate::events::RateLimitHit;
use crate::instructions::constants::{
    MAX_DISPUTE_STAKE_LAMPORTS, MIN_DISPUTE_STAKE_LAMPORTS, WINDOW_24H,
};
use crate::state::{AuthorityRateLimit, ProtocolConfig};
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
fn maybe_reset_authority_window(authority_rate_limit: &mut AuthorityRateLimit, clock: &Clock) {
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
fn initialize_authority_rate_limit(
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
