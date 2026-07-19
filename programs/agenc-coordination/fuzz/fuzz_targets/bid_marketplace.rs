//! Fuzz target for Marketplace V2 bid lifecycle scenarios.
//!
//! Covers create/update/cancel/accept/expire flows plus adversarial conditions
//! such as cooldown/rate limits, over-budget bids, and accepting expired bids.

use crate::*;
use proptest::prelude::*;

fn build_bid_task(
    task_id: [u8; 32],
    reward_amount: u64,
    required_capabilities: u64,
    deadline: i64,
) -> SimulatedTask {
    SimulatedTask {
        task_id,
        status: task_status::OPEN,
        reward_amount,
        max_workers: 1,
        current_workers: 0,
        required_capabilities,
        deadline,
        completions: 0,
        required_completions: 1,
        task_type: 3,
    }
}

fn build_bidder(
    agent_id: [u8; 32],
    capabilities: u64,
    active_tasks: u8,
    reputation: u16,
) -> SimulatedAgent {
    SimulatedAgent {
        agent_id,
        capabilities,
        status: agent_status::ACTIVE,
        active_tasks,
        reputation,
        stake: 1_000_000,
        tasks_completed: 0,
        total_earned: 0,
    }
}

fn build_open_bid_book(task_id: [u8; 32], now: i64) -> SimulatedBidBook {
    SimulatedBidBook {
        task: task_id,
        state: bid_book_state::OPEN,
        policy: matching_policy::BEST_PRICE,
        price_weight_bps: 0,
        eta_weight_bps: 0,
        confidence_weight_bps: 0,
        reliability_weight_bps: 0,
        accepted_bid: None,
        version: 0,
        total_bids: 0,
        active_bids: 0,
        created_at: now,
        updated_at: now,
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(750))]

    #[test]
    fn fuzz_bid_create_update_cancel_roundtrip(
        task_id in arb_id(),
        bidder_id in arb_id(),
        bid_id in arb_id(),
        task_reward in 10_000u64..1_000_000_000u64,
        requested_reward in 1u64..1_000_000_000u64,
        updated_reward in 1u64..1_000_000_000u64,
        eta_seconds in 1u32..86_400u32,
        updated_eta_seconds in 1u32..86_400u32,
        confidence_bps in 0u16..=10_000u16,
        updated_confidence_bps in 0u16..=10_000u16,
        current_time in 1_700_000_000i64..1_800_000_000i64,
        expires_offset in 1i64..86_400i64,
        updated_expires_offset in 1i64..86_400i64,
        required_capabilities in arb_capabilities(),
        extra_capabilities in arb_capabilities(),
        bidder_reputation in 0u16..=10_000u16,
    ) {
        let requested_reward = requested_reward.min(task_reward);
        let updated_reward = updated_reward.min(task_reward);
        let bidder_capabilities = required_capabilities | extra_capabilities;
        let max_lifetime = expires_offset.max(updated_expires_offset).saturating_add(600);
        let deadline_offset = max_lifetime
            .max(i64::from(eta_seconds))
            .max(i64::from(updated_eta_seconds));
        let deadline = current_time.saturating_add(deadline_offset).saturating_add(600);
        let expires_at = current_time.saturating_add(expires_offset);
        let updated_expires_at = current_time.saturating_add(updated_expires_offset);

        let task = build_bid_task(task_id, task_reward, required_capabilities, deadline);
        let bidder = build_bidder(
            bidder_id,
            bidder_capabilities,
            0,
            bidder_reputation,
        );
        let mut bid_book = build_open_bid_book(task_id, current_time);
        let mut bid = SimulatedBid::default();
        let mut bidder_state = SimulatedBidderMarketState::default();
        let config = SimulatedBidMarketplaceConfig {
            max_bid_lifetime_secs: max_lifetime,
            max_active_bids_per_task: 4,
            ..Default::default()
        };

        let create_result = simulate_create_bid(
            &task,
            &mut bid_book,
            &mut bid,
            &bidder,
            &mut bidder_state,
            &config,
            current_time,
            bidder_reputation,
            bid_id,
            requested_reward,
            eta_seconds,
            confidence_bps,
            expires_at,
        );

        prop_assert!(create_result.is_success(), "create failed: {:?}", create_result);
        prop_assert_eq!(bid_book.version, 1);
        prop_assert_eq!(bid_book.total_bids, 1);
        prop_assert_eq!(bid_book.active_bids, 1);
        prop_assert_eq!(bidder_state.active_bid_count, 1);
        prop_assert_eq!(bidder_state.total_bids_created, 1);
        prop_assert_eq!(bid.bond_lamports, config.min_bid_bond_lamports);

        let update_result = simulate_update_bid(
            &task,
            &mut bid_book,
            &mut bid,
            &bidder,
            &config,
            current_time,
            updated_reward,
            updated_eta_seconds,
            updated_confidence_bps,
            updated_expires_at,
        );

        prop_assert!(update_result.is_success(), "update failed: {:?}", update_result);
        prop_assert_eq!(bid_book.version, 2);
        prop_assert_eq!(bid.requested_reward_lamports, updated_reward);
        prop_assert_eq!(bid.eta_seconds, updated_eta_seconds);
        prop_assert_eq!(bid.confidence_bps, updated_confidence_bps);
        prop_assert_eq!(bid.expires_at, updated_expires_at);

        let cancel_result = simulate_cancel_bid(
            &task,
            &mut bid_book,
            &mut bid,
            &mut bidder_state,
            current_time,
        );

        prop_assert!(cancel_result.is_success(), "cancel failed: {:?}", cancel_result);
        prop_assert_eq!(bid_book.version, 3);
        prop_assert_eq!(bid_book.active_bids, 0);
        prop_assert_eq!(bidder_state.active_bid_count, 0);
        prop_assert!(bid.is_closed);
        prop_assert_eq!(bid.bond_lamports, 0);
    }

    #[test]
    fn fuzz_bid_accept_transitions_task_and_book(
        task_id in arb_id(),
        bidder_id in arb_id(),
        bid_id in arb_id(),
        task_reward in 10_000u64..1_000_000_000u64,
        requested_reward in 1u64..1_000_000_000u64,
        eta_seconds in 1u32..86_400u32,
        confidence_bps in 0u16..=10_000u16,
        current_time in 1_700_000_000i64..1_800_000_000i64,
        expires_offset in 1i64..86_400i64,
        required_capabilities in arb_capabilities(),
        extra_capabilities in arb_capabilities(),
        min_reputation in 0u16..=10_000u16,
        reputation_padding in 0u16..=10_000u16,
        initial_active_tasks in 0u8..=9u8,
    ) {
        let requested_reward = requested_reward.min(task_reward);
        let bidder_capabilities = required_capabilities | extra_capabilities;
        let bidder_reputation = min_reputation.saturating_add(reputation_padding).min(10_000);
        let deadline = current_time
            .saturating_add(expires_offset.max(i64::from(eta_seconds)))
            .saturating_add(600);
        let expires_at = current_time.saturating_add(expires_offset);

        let mut task = build_bid_task(task_id, task_reward, required_capabilities, deadline);
        let bidder = build_bidder(
            bidder_id,
            bidder_capabilities,
            initial_active_tasks,
            bidder_reputation,
        );
        let mut bid_book = build_open_bid_book(task_id, current_time);
        let mut bid = SimulatedBid::default();
        let mut bidder_state = SimulatedBidderMarketState::default();
        let config = SimulatedBidMarketplaceConfig {
            max_bid_lifetime_secs: expires_offset.saturating_add(1_000),
            ..Default::default()
        };

        let create_result = simulate_create_bid(
            &task,
            &mut bid_book,
            &mut bid,
            &bidder,
            &mut bidder_state,
            &config,
            current_time,
            min_reputation,
            bid_id,
            requested_reward,
            eta_seconds,
            confidence_bps,
            expires_at,
        );
        prop_assert!(create_result.is_success(), "create failed: {:?}", create_result);

        let mut bidder = bidder;
        let accept_result = simulate_accept_bid(
            &mut task,
            &mut bid_book,
            &mut bid,
            &mut bidder,
            &mut bidder_state,
            SimulatedBidAcceptanceContext {
                other_bid_pairs: &[],
                now: current_time,
                min_reputation,
            },
        );

        prop_assert!(accept_result.is_success(), "accept failed: {:?}", accept_result);
        prop_assert_eq!(task.status, task_status::IN_PROGRESS);
        prop_assert_eq!(task.current_workers, 1);
        prop_assert_eq!(bid.state, bid_state::ACCEPTED);
        prop_assert_eq!(bid_book.state, bid_book_state::ACCEPTED);
        prop_assert_eq!(bid_book.accepted_bid, Some(bid_id));
        prop_assert_eq!(bid_book.version, 2);
        prop_assert_eq!(bidder.active_tasks, initial_active_tasks + 1);
        prop_assert_eq!(bidder_state.total_bids_accepted, 1);
        prop_assert_eq!(bidder_state.active_bid_count, 1);
        prop_assert_eq!(bid_book.active_bids, 1);
    }

    #[test]
    fn fuzz_declared_policy_rejects_a_better_bid_but_ignores_book_version_churn(
        policy in 0u8..=2u8,
        selected_price in 2u64..999_000_000u64,
        selected_eta in 2u32..86_000u32,
        book_version in any::<u64>(),
        current_time in 1_700_000_000i64..1_800_000_000i64,
    ) {
        let task_reward = selected_price.saturating_add(1_000);
        let deadline = current_time
            .saturating_add(i64::from(selected_eta))
            .saturating_add(1_000);
        let task = build_bid_task([1u8; 32], task_reward, 1, deadline);
        let mut bid_book = build_open_bid_book(task.task_id, current_time);
        bid_book.policy = policy;
        bid_book.version = book_version;
        bid_book.total_bids = 2;
        bid_book.active_bids = 2;
        if policy == matching_policy::WEIGHTED_SCORE {
            bid_book.price_weight_bps = 10_000;
        }

        let selected = SimulatedBid {
            bid_id: [2u8; 32],
            task: task.task_id,
            bidder: [3u8; 32],
            requested_reward_lamports: selected_price,
            eta_seconds: selected_eta,
            confidence_bps: 8_000,
            reputation_snapshot_bps: 8_000,
            expires_at: deadline,
            state: bid_state::BOUND_ACTIVE,
            bond_lamports: 100_000,
            is_closed: false,
        };
        let mut competitor = selected.clone();
        competitor.bid_id = [4u8; 32];
        competitor.bidder = [5u8; 32];
        if policy == matching_policy::BEST_ETA {
            competitor.eta_seconds = selected_eta - 1;
            competitor.requested_reward_lamports = selected_price.saturating_add(1);
        } else {
            competitor.requested_reward_lamports = selected_price - 1;
            competitor.eta_seconds = selected_eta.saturating_add(1);
        }

        let mut competitor_pair = SimulatedCompetingBidPair {
            bidder: build_bidder(
                competitor.bidder,
                task.required_capabilities,
                0,
                10_000,
            ),
            bid: competitor,
        };
        let losing_result = simulate_validate_bid_selection(
            &task,
            &bid_book,
            &selected,
            std::slice::from_ref(&competitor_pair),
            current_time,
            0,
        );
        prop_assert!(losing_result.is_error());

        if policy == matching_policy::BEST_ETA {
            competitor_pair.bid.eta_seconds = selected_eta.saturating_add(1);
            competitor_pair.bid.requested_reward_lamports = selected_price.saturating_sub(1);
        } else {
            competitor_pair.bid.requested_reward_lamports = selected_price.saturating_add(1);
            competitor_pair.bid.eta_seconds = selected_eta.saturating_sub(1);
        }
        let winning_result = simulate_validate_bid_selection(
            &task,
            &bid_book,
            &selected,
            std::slice::from_ref(&competitor_pair),
            current_time,
            0,
        );
        prop_assert!(winning_result.is_success(), "unexpected selection: {:?}", winning_result);

        competitor_pair.bid.requested_reward_lamports = 1;
        competitor_pair.bidder.status = agent_status::INACTIVE;
        let inactive_better_result = simulate_validate_bid_selection(
            &task,
            &bid_book,
            &selected,
            std::slice::from_ref(&competitor_pair),
            current_time,
            0,
        );
        prop_assert!(inactive_better_result.is_success());

        competitor_pair.bidder.status = agent_status::ACTIVE;
        competitor_pair.bidder.stake = 999_999;
        let under_staked_better_result = simulate_validate_bid_selection(
            &task,
            &bid_book,
            &selected,
            std::slice::from_ref(&competitor_pair),
            current_time,
            0,
        );
        prop_assert!(under_staked_better_result.is_success());
    }

    #[test]
    fn fuzz_bid_expire_requires_timeout_or_closed_book(
        task_id in arb_id(),
        bidder_id in arb_id(),
        bid_id in arb_id(),
        task_reward in 10_000u64..1_000_000_000u64,
        requested_reward in 1u64..1_000_000_000u64,
        eta_seconds in 1u32..86_400u32,
        confidence_bps in 0u16..=10_000u16,
        current_time in 1_700_000_000i64..1_800_000_000i64,
        expires_offset in 1i64..86_400i64,
        required_capabilities in arb_capabilities(),
        extra_capabilities in arb_capabilities(),
        close_book in any::<bool>(),
        advance_past_expiry in any::<bool>(),
    ) {
        let requested_reward = requested_reward.min(task_reward);
        let bidder_capabilities = required_capabilities | extra_capabilities;
        let deadline = current_time
            .saturating_add(expires_offset.max(i64::from(eta_seconds)))
            .saturating_add(600);
        let expires_at = current_time.saturating_add(expires_offset);

        let task = build_bid_task(task_id, task_reward, required_capabilities, deadline);
        let bidder = build_bidder(bidder_id, bidder_capabilities, 0, 5_000);
        let mut bid_book = build_open_bid_book(task_id, current_time);
        let mut bid = SimulatedBid::default();
        let mut bidder_state = SimulatedBidderMarketState::default();
        let config = SimulatedBidMarketplaceConfig {
            max_bid_lifetime_secs: expires_offset.saturating_add(1_000),
            ..Default::default()
        };

        let create_result = simulate_create_bid(
            &task,
            &mut bid_book,
            &mut bid,
            &bidder,
            &mut bidder_state,
            &config,
            current_time,
            0,
            bid_id,
            requested_reward,
            eta_seconds,
            confidence_bps,
            expires_at,
        );
        prop_assert!(create_result.is_success(), "create failed: {:?}", create_result);

        if close_book {
            bid_book.state = bid_book_state::CLOSED;
        }
        let expire_time = if advance_past_expiry {
            expires_at.saturating_add(1)
        } else {
            current_time
        };

        let expire_result = simulate_expire_bid(
            &task,
            &mut bid_book,
            &mut bid,
            &mut bidder_state,
            expire_time,
        );

        let should_succeed = close_book || advance_past_expiry;
        prop_assert_eq!(
            expire_result.is_success(),
            should_succeed,
            "unexpected expire result: {:?}",
            expire_result
        );

        if should_succeed {
            prop_assert_eq!(bid_book.version, 2);
            prop_assert_eq!(bid_book.active_bids, 0);
            prop_assert_eq!(bidder_state.active_bid_count, 0);
            prop_assert!(bid.is_closed);
        } else {
            prop_assert_eq!(bid_book.version, 1);
            prop_assert_eq!(bid_book.active_bids, 1);
            prop_assert_eq!(bidder_state.active_bid_count, 1);
            prop_assert!(!bid.is_closed);
        }
    }
}

#[cfg(test)]
mod edge_cases {
    use super::*;

    fn plus_time(current_time: i64, delta: i64) -> i64 {
        current_time
            .checked_add(delta)
            .expect("test timestamp addition should stay in range")
    }

    fn minus_time(current_time: i64, delta: i64) -> i64 {
        current_time
            .checked_sub(delta)
            .expect("test timestamp subtraction should stay in range")
    }

    #[test]
    fn test_initialize_bid_book_weighted_score_rejects_invalid_sum() {
        let task = build_bid_task([1u8; 32], 1_000_000, 1, 0);
        let mut bid_book = SimulatedBidBook::default();

        let result = simulate_initialize_bid_book(
            &task,
            &mut bid_book,
            100,
            matching_policy::WEIGHTED_SCORE,
            2_500,
            2_500,
            2_500,
            2_400,
        );

        assert!(result.is_error());
        if let SimulationResult::Error(message) = result {
            assert_eq!(message, "InvalidWeightedScoreWeights");
        }
    }

    #[test]
    fn test_create_bid_over_budget_fails() {
        let current_time = 1_750_000_000;
        let task = build_bid_task([1u8; 32], 500_000, 1, plus_time(current_time, 10_000));
        let bidder = build_bidder([2u8; 32], 1, 0, 5_000);
        let mut bid_book = build_open_bid_book(task.task_id, current_time);
        let mut bid = SimulatedBid::default();
        let mut bidder_state = SimulatedBidderMarketState::default();

        let result = simulate_create_bid(
            &task,
            &mut bid_book,
            &mut bid,
            &bidder,
            &mut bidder_state,
            &SimulatedBidMarketplaceConfig::default(),
            current_time,
            0,
            [3u8; 32],
            500_001,
            600,
            9_000,
            plus_time(current_time, 600),
        );

        assert!(result.is_error());
        if let SimulationResult::Error(message) = result {
            assert_eq!(message, "BidPriceExceedsTaskBudget");
        }
    }

    #[test]
    fn test_create_bid_respects_cooldown() {
        let current_time = 1_750_000_000;
        let task = build_bid_task([1u8; 32], 500_000, 1, plus_time(current_time, 10_000));
        let bidder = build_bidder([2u8; 32], 1, 0, 5_000);
        let mut bid_book = build_open_bid_book(task.task_id, current_time);
        let mut bid = SimulatedBid::default();
        let mut bidder_state = SimulatedBidderMarketState {
            bidder: bidder.agent_id,
            last_bid_created_at: minus_time(current_time, 10),
            bid_window_started_at: minus_time(current_time, 10),
            bids_created_in_window: 1,
            active_bid_count: 1,
            total_bids_created: 1,
            total_bids_accepted: 0,
        };
        let config = SimulatedBidMarketplaceConfig {
            bid_creation_cooldown_secs: 60,
            ..Default::default()
        };

        let result = simulate_create_bid(
            &task,
            &mut bid_book,
            &mut bid,
            &bidder,
            &mut bidder_state,
            &config,
            current_time,
            0,
            [3u8; 32],
            400_000,
            600,
            9_000,
            plus_time(current_time, 600),
        );

        assert!(result.is_error());
        if let SimulationResult::Error(message) = result {
            assert_eq!(message, "CooldownNotElapsed");
        }
    }

    #[test]
    fn test_create_bid_respects_rate_limit() {
        let current_time = 1_750_000_000;
        let task = build_bid_task([1u8; 32], 500_000, 1, plus_time(current_time, 10_000));
        let bidder = build_bidder([2u8; 32], 1, 0, 5_000);
        let mut bid_book = build_open_bid_book(task.task_id, current_time);
        let mut bid = SimulatedBid::default();
        let mut bidder_state = SimulatedBidderMarketState {
            bidder: bidder.agent_id,
            last_bid_created_at: minus_time(current_time, 600),
            bid_window_started_at: minus_time(current_time, 600),
            bids_created_in_window: 2,
            active_bid_count: 0,
            total_bids_created: 2,
            total_bids_accepted: 0,
        };
        let config = SimulatedBidMarketplaceConfig {
            max_bids_per_24h: 2,
            ..Default::default()
        };

        let result = simulate_create_bid(
            &task,
            &mut bid_book,
            &mut bid,
            &bidder,
            &mut bidder_state,
            &config,
            current_time,
            0,
            [3u8; 32],
            400_000,
            600,
            9_000,
            plus_time(current_time, 600),
        );

        assert!(result.is_error());
        if let SimulationResult::Error(message) = result {
            assert_eq!(message, "RateLimitExceeded");
        }
    }

    #[test]
    fn test_bid_entry_and_acceptance_reject_under_staked_bidder() {
        let current_time = 1_750_000_000;
        let mut task = build_bid_task([1u8; 32], 500_000, 1, plus_time(current_time, 10_000));
        let mut bidder = build_bidder([2u8; 32], 1, 0, 5_000);
        bidder.stake = 999_999;
        let mut bid_book = build_open_bid_book(task.task_id, current_time);
        let mut bid = SimulatedBid::default();
        let mut bidder_state = SimulatedBidderMarketState::default();

        let result = simulate_create_bid(
            &task,
            &mut bid_book,
            &mut bid,
            &bidder,
            &mut bidder_state,
            &SimulatedBidMarketplaceConfig::default(),
            current_time,
            0,
            [3u8; 32],
            400_000,
            600,
            9_000,
            plus_time(current_time, 600),
        );
        assert!(matches!(
            result,
            SimulationResult::Error(message) if message == "InsufficientStake"
        ));

        bidder.stake = 1_000_000;
        assert!(simulate_create_bid(
            &task,
            &mut bid_book,
            &mut bid,
            &bidder,
            &mut bidder_state,
            &SimulatedBidMarketplaceConfig::default(),
            current_time,
            0,
            [3u8; 32],
            400_000,
            600,
            9_000,
            plus_time(current_time, 600),
        )
        .is_success());
        bidder.stake = 999_999;
        let result = simulate_update_bid(
            &task,
            &mut bid_book,
            &mut bid,
            &bidder,
            &SimulatedBidMarketplaceConfig::default(),
            current_time,
            350_000,
            500,
            9_000,
            plus_time(current_time, 600),
        );
        assert!(matches!(
            result,
            SimulationResult::Error(message) if message == "InsufficientStake"
        ));
        let result = simulate_accept_bid(
            &mut task,
            &mut bid_book,
            &mut bid,
            &mut bidder,
            &mut bidder_state,
            SimulatedBidAcceptanceContext {
                other_bid_pairs: &[],
                now: current_time,
                min_reputation: 0,
            },
        );
        assert!(matches!(
            result,
            SimulationResult::Error(message) if message == "InsufficientStake"
        ));
    }

    #[test]
    fn test_accept_expired_bid_fails() {
        let current_time = 1_750_000_000;
        let mut task = build_bid_task([1u8; 32], 500_000, 1, plus_time(current_time, 10_000));
        let bidder = build_bidder([2u8; 32], 1, 0, 5_000);
        let mut bid_book = build_open_bid_book(task.task_id, current_time);
        let mut bid = SimulatedBid::default();
        let mut bidder_state = SimulatedBidderMarketState::default();

        let create_result = simulate_create_bid(
            &task,
            &mut bid_book,
            &mut bid,
            &bidder,
            &mut bidder_state,
            &SimulatedBidMarketplaceConfig::default(),
            current_time,
            0,
            [3u8; 32],
            400_000,
            600,
            9_000,
            plus_time(current_time, 60),
        );
        assert!(create_result.is_success());

        let mut bidder = bidder;
        let result = simulate_accept_bid(
            &mut task,
            &mut bid_book,
            &mut bid,
            &mut bidder,
            &mut bidder_state,
            SimulatedBidAcceptanceContext {
                other_bid_pairs: &[],
                now: plus_time(current_time, 60),
                min_reputation: 0,
            },
        );

        assert!(result.is_error());
        if let SimulationResult::Error(message) = result {
            assert_eq!(message, "TaskExpired");
        }
    }

    #[test]
    fn test_accept_bid_rejects_bidder_at_capacity() {
        let current_time = 1_750_000_000;
        let mut task = build_bid_task([1u8; 32], 500_000, 1, plus_time(current_time, 10_000));
        let bidder = build_bidder([2u8; 32], 1, 10, 5_000);
        let mut bid_book = build_open_bid_book(task.task_id, current_time);
        let mut bid = SimulatedBid::default();
        let mut bidder_state = SimulatedBidderMarketState::default();

        let create_result = simulate_create_bid(
            &task,
            &mut bid_book,
            &mut bid,
            &bidder,
            &mut bidder_state,
            &SimulatedBidMarketplaceConfig::default(),
            current_time,
            0,
            [3u8; 32],
            400_000,
            600,
            9_000,
            plus_time(current_time, 600),
        );
        assert!(create_result.is_success());

        let mut bidder = bidder;
        let result = simulate_accept_bid(
            &mut task,
            &mut bid_book,
            &mut bid,
            &mut bidder,
            &mut bidder_state,
            SimulatedBidAcceptanceContext {
                other_bid_pairs: &[],
                now: current_time,
                min_reputation: 0,
            },
        );

        assert!(result.is_error());
        if let SimulationResult::Error(message) = result {
            assert_eq!(message, "MaxActiveTasksReached");
        }
    }

    #[test]
    fn test_update_accepted_bid_fails() {
        let current_time = 1_750_000_000;
        let mut task = build_bid_task([1u8; 32], 500_000, 1, plus_time(current_time, 10_000));
        let bidder = build_bidder([2u8; 32], 1, 0, 5_000);
        let mut bid_book = build_open_bid_book(task.task_id, current_time);
        let mut bid = SimulatedBid::default();
        let mut bidder_state = SimulatedBidderMarketState::default();

        let create_result = simulate_create_bid(
            &task,
            &mut bid_book,
            &mut bid,
            &bidder,
            &mut bidder_state,
            &SimulatedBidMarketplaceConfig::default(),
            current_time,
            0,
            [3u8; 32],
            400_000,
            600,
            9_000,
            plus_time(current_time, 600),
        );
        assert!(create_result.is_success());

        let mut bidder = bidder;
        let accept_result = simulate_accept_bid(
            &mut task,
            &mut bid_book,
            &mut bid,
            &mut bidder,
            &mut bidder_state,
            SimulatedBidAcceptanceContext {
                other_bid_pairs: &[],
                now: current_time,
                min_reputation: 0,
            },
        );
        assert!(accept_result.is_success());

        let result = simulate_update_bid(
            &task,
            &mut bid_book,
            &mut bid,
            &bidder,
            &SimulatedBidMarketplaceConfig::default(),
            current_time,
            350_000,
            300,
            9_500,
            plus_time(current_time, 500),
        );

        assert!(result.is_error());
        if let SimulationResult::Error(message) = result {
            assert_eq!(message, "BidNotActive");
        }
    }

    #[test]
    fn test_cancel_accepted_bid_fails() {
        let current_time = 1_750_000_000;
        let mut task = build_bid_task([1u8; 32], 500_000, 1, plus_time(current_time, 10_000));
        let bidder = build_bidder([2u8; 32], 1, 0, 5_000);
        let mut bid_book = build_open_bid_book(task.task_id, current_time);
        let mut bid = SimulatedBid::default();
        let mut bidder_state = SimulatedBidderMarketState::default();

        let create_result = simulate_create_bid(
            &task,
            &mut bid_book,
            &mut bid,
            &bidder,
            &mut bidder_state,
            &SimulatedBidMarketplaceConfig::default(),
            current_time,
            0,
            [3u8; 32],
            400_000,
            600,
            9_000,
            plus_time(current_time, 600),
        );
        assert!(create_result.is_success());

        let mut bidder = bidder;
        let accept_result = simulate_accept_bid(
            &mut task,
            &mut bid_book,
            &mut bid,
            &mut bidder,
            &mut bidder_state,
            SimulatedBidAcceptanceContext {
                other_bid_pairs: &[],
                now: current_time,
                min_reputation: 0,
            },
        );
        assert!(accept_result.is_success());

        let result = simulate_cancel_bid(
            &task,
            &mut bid_book,
            &mut bid,
            &mut bidder_state,
            current_time,
        );

        assert!(result.is_error());
        if let SimulationResult::Error(message) = result {
            assert_eq!(message, "BidNotActive");
        }
    }
}
