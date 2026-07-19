//! Stateful fuzzing for the direct-resolver dispute lifecycle.
//!
//! The sequence model covers opening, accountable direct resolution, initiator
//! cancellation, and permissionless expiry. It deliberately contains no voter,
//! quorum, arbiter-capability, or arbiter-stake state.

use crate::*;
use proptest::prelude::*;

fn simulate_cancel_dispute(
    dispute: &mut SimulatedDispute,
    task: &mut SimulatedTask,
    by_initiator: bool,
    restore_status: u8,
) -> SimulationResult {
    if dispute.status != dispute_status::ACTIVE {
        return SimulationResult::Error("DisputeNotActive".to_string());
    }
    if !by_initiator {
        return SimulationResult::Error("UnauthorizedResolver".to_string());
    }
    // This retained byte is provenance, never a voter count.
    if dispute.total_voters != 0 && dispute.total_voters != INITIATOR_OUTCOME_COUNTER_MARKER {
        return SimulationResult::Error("InvalidLegacyVoterCount".to_string());
    }

    let old_dispute_status = dispute.status;
    let old_task_status = task.status;
    dispute.status = dispute_status::CANCELLED;
    if task.status == task_status::DISPUTED {
        task.status = restore_status;
    }

    if let DisputeInvariantResult::InvalidStateTransition { from, to } =
        check_dispute_state_transition(old_dispute_status, dispute.status)
    {
        return SimulationResult::InvariantViolation(format!(
            "Invalid dispute cancellation transition from {from} to {to}"
        ));
    }
    if let TaskInvariantResult::InvalidStateTransition { from, to } =
        check_task_state_transition(old_task_status, task.status)
    {
        return SimulationResult::InvariantViolation(format!(
            "Invalid task restoration transition from {from} to {to}"
        ));
    }
    SimulationResult::Success
}

fn simulate_expiry_refund(
    dispute: &mut SimulatedDispute,
    task: &mut SimulatedTask,
    escrow: &mut SimulatedEscrow,
    timestamp: i64,
) -> SimulationResult {
    let result = simulate_expire_dispute(dispute, timestamp);
    if !result.is_success() {
        return result;
    }

    let old_task_status = task.status;
    task.status = task_status::CANCELLED;
    escrow.distributed = escrow.amount;
    escrow.is_closed = true;
    if let TaskInvariantResult::InvalidStateTransition { from, to } =
        check_task_state_transition(old_task_status, task.status)
    {
        return SimulationResult::InvariantViolation(format!(
            "Invalid task expiry transition from {from} to {to}"
        ));
    }
    SimulationResult::Success
}

fn role_can_resolve(role: ResolverRole) -> bool {
    matches!(
        role,
        ResolverRole::ProtocolAuthority | ResolverRole::AssignedResolver
    )
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1500))]

    #[test]
    fn fuzz_dispute_lifecycle(seq in any::<DisputeLifecycleSequence>()) {
        let mut task = SimulatedTask {
            task_id: seq.task_id,
            status: seq.initial_task_status,
            reward_amount: seq.escrow_amount,
            max_workers: 1,
            current_workers: 1,
            required_completions: 1,
            ..Default::default()
        };
        let mut escrow = SimulatedEscrow {
            amount: seq.escrow_amount,
            ..Default::default()
        };
        let mut dispute = SimulatedDispute {
            dispute_id: seq.dispute_id,
            resolution_type: seq.resolution_type,
            voting_deadline: seq.voting_deadline,
            expires_at: seq.expires_at,
            initiator_authority: DISPUTE_INITIATOR,
            ..Default::default()
        };

        let init_result = simulate_dispute_open(&mut task, &mut dispute);
        prop_assert!(
            !init_result.is_invariant_violation(),
            "Invariant violation on dispute open: {:?}\nSequence: {:?}",
            init_result,
            seq
        );
        let disputable = matches!(
            seq.initial_task_status,
            task_status::IN_PROGRESS | task_status::PENDING_VALIDATION
        );
        prop_assert_eq!(init_result.is_success(), disputable);

        if disputable {
            for action in &seq.actions {
                let before = (dispute.clone(), task.clone(), escrow.clone());
                let expected_success = match action {
                    DisputeAction::Resolve {
                        resolver_role,
                        has_rationale,
                        timestamp,
                        ..
                    } => {
                        dispute.status == dispute_status::ACTIVE
                            && task.status == task_status::DISPUTED
                            && dispute_resolution_window_open(&dispute, *timestamp)
                            && role_can_resolve(*resolver_role)
                            && *has_rationale
                    }
                    DisputeAction::Cancel { by_initiator } => {
                        dispute.status == dispute_status::ACTIVE && *by_initiator
                    }
                    DisputeAction::Expire { timestamp } => {
                        dispute.status == dispute_status::ACTIVE
                            && dispute_expiry_window_open(&dispute, *timestamp)
                    }
                };

                let result = match action {
                    DisputeAction::Resolve {
                        resolver_role,
                        approve,
                        has_rationale,
                        timestamp,
                    } => {
                        let ruling = direct_ruling(*resolver_role, *approve, *has_rationale);
                        simulate_resolve_dispute(
                            &mut dispute,
                            &mut task,
                            &mut escrow,
                            &ruling,
                            *timestamp,
                        )
                    }
                    DisputeAction::Cancel { by_initiator } => simulate_cancel_dispute(
                        &mut dispute,
                        &mut task,
                        *by_initiator,
                        seq.initial_task_status,
                    ),
                    DisputeAction::Expire { timestamp } => simulate_expiry_refund(
                        &mut dispute,
                        &mut task,
                        &mut escrow,
                        *timestamp,
                    ),
                };

                prop_assert!(
                    !result.is_invariant_violation(),
                    "Invariant violation: {:?}\nAction: {:?}\nSequence: {:?}",
                    result,
                    action,
                    seq
                );
                prop_assert_eq!(
                    result.is_success(),
                    expected_success,
                    "Unexpected lifecycle result: {:?}\nAction: {:?}\nSequence: {:?}",
                    result,
                    action,
                    seq
                );
                prop_assert_eq!(dispute.total_voters, INITIATOR_OUTCOME_COUNTER_MARKER);
                prop_assert!(escrow.distributed <= escrow.amount);

                if result.is_error() {
                    prop_assert_eq!((&dispute, &task, &escrow), (&before.0, &before.1, &before.2));
                }

                if let DisputeAction::Resolve { approve, .. } = action {
                    if result.is_success() {
                        prop_assert_eq!(
                            (dispute.votes_for, dispute.votes_against),
                            if *approve { (1, 0) } else { (0, 1) }
                        );
                    }
                }
            }
        }
    }
}
