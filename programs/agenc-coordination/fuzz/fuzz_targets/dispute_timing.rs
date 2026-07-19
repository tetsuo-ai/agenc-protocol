//! Timing properties for direct dispute resolution and permissionless expiry.
//!
//! Resolution is available immediately and remains open only while both the
//! hard expiry and legacy-deadline grace permit it. Expiry is its exact logical
//! complement, so no timestamp permits both paths or strands the dispute.

use crate::*;
use proptest::prelude::*;

fn active_dispute(voting_deadline: i64, expires_at: i64) -> SimulatedDispute {
    SimulatedDispute {
        status: dispute_status::ACTIVE,
        resolution_type: 1,
        voting_deadline,
        expires_at,
        initiator_authority: DISPUTE_INITIATOR,
        ..Default::default()
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2000))]

    #[test]
    fn fuzz_resolution_expiry_partition(input in any::<DisputeTimingInput>()) {
        let template = active_dispute(input.voting_deadline, input.expires_at);

        for &timestamp in &input.timestamps {
            let resolution_open = dispute_resolution_window_open(&template, timestamp);
            let expiry_open = dispute_expiry_window_open(&template, timestamp);

            prop_assert_eq!(
                check_dispute_window_partition(resolution_open, expiry_open),
                DisputeInvariantResult::Valid,
                "window partition failed at {}: {:?}",
                timestamp,
                input
            );

            let mut resolution_dispute = template.clone();
            let mut task = SimulatedTask {
                status: task_status::DISPUTED,
                current_workers: 1,
                max_workers: 1,
                required_completions: 1,
                ..Default::default()
            };
            let mut escrow = SimulatedEscrow {
                amount: 1_000_000,
                ..Default::default()
            };
            let ruling = direct_ruling(ResolverRole::AssignedResolver, true, true);
            let resolution_result = simulate_resolve_dispute(
                &mut resolution_dispute,
                &mut task,
                &mut escrow,
                &ruling,
                timestamp,
            );
            prop_assert_eq!(
                resolution_result.is_success(),
                resolution_open,
                "resolution result disagreed with window at {}: {:?}",
                timestamp,
                input
            );

            let mut expiry_dispute = template.clone();
            let expiry_result = simulate_expire_dispute(&mut expiry_dispute, timestamp);
            prop_assert_eq!(
                expiry_result.is_success(),
                expiry_open,
                "expiry result disagreed with window at {}: {:?}",
                timestamp,
                input
            );
        }
    }
}

#[cfg(test)]
mod boundaries {
    use super::*;

    #[test]
    fn grace_boundary_is_complementary() {
        let dispute = active_dispute(1_000, 2_000);
        let grace_boundary = 1_000 + DISPUTE_RESOLUTION_GRACE;
        assert!(dispute_resolution_window_open(&dispute, grace_boundary - 1));
        assert!(!dispute_expiry_window_open(&dispute, grace_boundary - 1));
        assert!(!dispute_resolution_window_open(&dispute, grace_boundary));
        assert!(dispute_expiry_window_open(&dispute, grace_boundary));
    }

    #[test]
    fn hard_expiry_is_inclusive_for_resolution_then_exclusive() {
        let dispute = active_dispute(10_000, 2_000);
        assert!(dispute_resolution_window_open(&dispute, 2_000));
        assert!(!dispute_expiry_window_open(&dispute, 2_000));
        assert!(!dispute_resolution_window_open(&dispute, 2_001));
        assert!(dispute_expiry_window_open(&dispute, 2_001));
    }

    #[test]
    fn resolution_is_immediate_not_vote_deadline_gated() {
        let dispute = active_dispute(1_000, 2_000);
        assert!(dispute_resolution_window_open(&dispute, 100));
    }

    #[test]
    fn saturating_grace_at_max_timestamp_remains_partitioned() {
        let dispute = active_dispute(i64::MAX, i64::MAX);
        assert!(dispute_resolution_window_open(&dispute, i64::MAX - 1));
        assert!(!dispute_expiry_window_open(&dispute, i64::MAX - 1));
        assert!(!dispute_resolution_window_open(&dispute, i64::MAX));
        assert!(dispute_expiry_window_open(&dispute, i64::MAX));
    }
}
