//! Property tests for the direct `resolve_dispute` model.
//!
//! The protocol authority with configured M-of-N approval, or a previously
//! threshold-seated assigned resolver, may rule immediately while the resolution
//! window is open. The initiator, creator, and worker are always conflicted. A
//! successful ruling requires a nonzero rationale commitment and records exactly
//! one approve/reject bit while retaining the counter-provenance sentinel in the
//! retired voter byte.

use crate::*;
use proptest::prelude::*;

fn modeled_attempt(
    input: &ResolveDisputeInput,
) -> (SimulatedDispute, SimulatedTask, SimulatedEscrow) {
    let dispute = SimulatedDispute {
        dispute_id: input.dispute_id,
        status: if input.dispute_active {
            dispute_status::ACTIVE
        } else {
            dispute_status::RESOLVED
        },
        resolution_type: input.resolution_type,
        votes_for: 0,
        votes_against: 0,
        total_voters: INITIATOR_OUTCOME_COUNTER_MARKER,
        voting_deadline: input.voting_deadline,
        expires_at: input.expires_at,
        initiator_authority: DISPUTE_INITIATOR,
    };
    let task = SimulatedTask {
        task_id: [9; 32],
        status: if input.task_disputed {
            task_status::DISPUTED
        } else {
            task_status::IN_PROGRESS
        },
        reward_amount: input.escrow_amount,
        max_workers: 1,
        current_workers: 1,
        required_completions: 1,
        ..Default::default()
    };
    let escrow = SimulatedEscrow {
        amount: input.escrow_amount,
        distributed: input.escrow_distributed.min(input.escrow_amount),
        is_closed: false,
    };
    (dispute, task, escrow)
}

fn role_can_resolve(role: ResolverRole, has_configured_threshold_approval: bool) -> bool {
    match role {
        ResolverRole::ProtocolAuthority => has_configured_threshold_approval,
        ResolverRole::AssignedResolver => true,
        _ => false,
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2000))]

    #[test]
    fn fuzz_direct_resolution(input in any::<ResolveDisputeInput>()) {
        let (mut dispute, mut task, mut escrow) = modeled_attempt(&input);
        let before = (dispute.clone(), task.clone(), escrow.clone());
        let ruling = direct_ruling_with_threshold_approval(
            input.resolver_role,
            input.approve,
            input.has_rationale,
            input.has_configured_threshold_approval,
        );

        let should_succeed = input.dispute_active
            && input.task_disputed
            && dispute_resolution_window_open(&dispute, input.current_timestamp)
            && role_can_resolve(
                input.resolver_role,
                input.has_configured_threshold_approval,
            )
            && input.has_rationale;

        let result = simulate_resolve_dispute(
            &mut dispute,
            &mut task,
            &mut escrow,
            &ruling,
            input.current_timestamp,
        );

        prop_assert!(
            !result.is_invariant_violation(),
            "Invariant violation: {:?}\nInput: {:?}",
            result,
            input
        );
        prop_assert_eq!(result.is_success(), should_succeed, "Unexpected result: {:?}\nInput: {:?}", result, input);

        if should_succeed {
            prop_assert_eq!(dispute.status, dispute_status::RESOLVED);
            prop_assert_eq!(dispute.total_voters, INITIATOR_OUTCOME_COUNTER_MARKER);
            prop_assert_eq!(
                (dispute.votes_for, dispute.votes_against),
                if input.approve { (1, 0) } else { (0, 1) }
            );
            prop_assert!(escrow.is_closed);
            prop_assert_eq!(escrow.distributed, escrow.amount);

            let expected_task_status = if input.approve && input.resolution_type == 1 {
                task_status::COMPLETED
            } else {
                task_status::CANCELLED
            };
            prop_assert_eq!(task.status, expected_task_status);
        } else {
            prop_assert_eq!((&dispute, &task, &escrow), (&before.0, &before.1, &before.2));
        }
    }
}

#[cfg(test)]
mod edge_cases {
    use super::*;

    fn valid_attempt(
        approve: bool,
    ) -> (
        SimulatedDispute,
        SimulatedTask,
        SimulatedEscrow,
        SimulatedRuling,
    ) {
        let input = ResolveDisputeInput {
            dispute_id: [8; 32],
            resolution_type: 1,
            approve,
            resolver_role: ResolverRole::AssignedResolver,
            has_rationale: true,
            has_configured_threshold_approval: false,
            dispute_active: true,
            task_disputed: true,
            escrow_amount: 1_000_000,
            escrow_distributed: 0,
            voting_deadline: 1_000,
            expires_at: 2_000,
            current_timestamp: 100,
        };
        let (dispute, task, escrow) = modeled_attempt(&input);
        let ruling = direct_ruling_with_threshold_approval(
            input.resolver_role,
            input.approve,
            input.has_rationale,
            input.has_configured_threshold_approval,
        );
        (dispute, task, escrow, ruling)
    }

    #[test]
    fn assigned_resolver_can_rule_without_per_case_threshold_approval() {
        let (mut dispute, mut task, mut escrow, ruling) = valid_attempt(true);
        let result = simulate_resolve_dispute(&mut dispute, &mut task, &mut escrow, &ruling, 100);
        assert!(result.is_success());
        assert_eq!(task.status, task_status::COMPLETED);
        assert_eq!(
            (
                dispute.votes_for,
                dispute.votes_against,
                dispute.total_voters
            ),
            (1, 0, INITIATOR_OUTCOME_COUNTER_MARKER)
        );
    }

    #[test]
    fn protocol_authority_can_rule_without_assignment_when_threshold_approved() {
        let (mut dispute, mut task, mut escrow, _) = valid_attempt(false);
        let ruling = direct_ruling_with_threshold_approval(
            ResolverRole::ProtocolAuthority,
            false,
            true,
            true,
        );
        let result = simulate_resolve_dispute(&mut dispute, &mut task, &mut escrow, &ruling, 100);
        assert!(result.is_success());
        assert_eq!(
            (
                dispute.votes_for,
                dispute.votes_against,
                dispute.total_voters
            ),
            (0, 1, INITIATOR_OUTCOME_COUNTER_MARKER)
        );
    }

    #[test]
    fn protocol_authority_without_threshold_approval_is_rejected_without_mutation() {
        let (mut dispute, mut task, mut escrow, _) = valid_attempt(false);
        let ruling = direct_ruling_with_threshold_approval(
            ResolverRole::ProtocolAuthority,
            false,
            true,
            false,
        );
        let before = (dispute.clone(), task.clone(), escrow.clone());
        let result = simulate_resolve_dispute(&mut dispute, &mut task, &mut escrow, &ruling, 100);

        assert!(matches!(
            &result,
            SimulationResult::Error(error) if error == "MultisigNotEnoughSigners"
        ));
        assert_eq!((dispute, task, escrow), before);
    }

    #[test]
    fn unauthorized_and_conflicted_resolvers_are_rejected() {
        for role in [
            ResolverRole::UnassignedResolver,
            ResolverRole::Initiator,
            ResolverRole::Creator,
            ResolverRole::Worker,
        ] {
            let (mut dispute, mut task, mut escrow, _) = valid_attempt(true);
            let ruling = direct_ruling(role, true, true);
            let before = (dispute.clone(), task.clone(), escrow.clone());
            let result =
                simulate_resolve_dispute(&mut dispute, &mut task, &mut escrow, &ruling, 100);
            assert!(result.is_error(), "role {role:?} unexpectedly resolved");
            assert_eq!((dispute, task, escrow), before);
        }
    }

    #[test]
    fn party_conflict_applies_even_to_protocol_authority() {
        let (mut dispute, mut task, mut escrow, mut ruling) = valid_attempt(true);
        ruling.resolver = TASK_CREATOR;
        ruling.protocol_authority = TASK_CREATOR;
        ruling.resolver_assigned = false;
        ruling.has_configured_threshold_approval = true;
        let result = simulate_resolve_dispute(&mut dispute, &mut task, &mut escrow, &ruling, 100);
        assert!(result.is_error());

        let (mut dispute, mut task, mut escrow, mut ruling) = valid_attempt(true);
        ruling.resolver = DISPUTE_INITIATOR;
        ruling.protocol_authority = DISPUTE_INITIATOR;
        ruling.resolver_assigned = false;
        ruling.has_configured_threshold_approval = true;
        let result = simulate_resolve_dispute(&mut dispute, &mut task, &mut escrow, &ruling, 100);
        assert!(result.is_error());
    }

    #[test]
    fn zero_rationale_hash_is_rejected_without_mutation() {
        let (mut dispute, mut task, mut escrow, _) = valid_attempt(true);
        let ruling = direct_ruling(ResolverRole::AssignedResolver, true, false);
        let before = (dispute.clone(), task.clone(), escrow.clone());
        let result = simulate_resolve_dispute(&mut dispute, &mut task, &mut escrow, &ruling, 100);
        assert!(result.is_error());
        assert_eq!((dispute, task, escrow), before);
    }
}
