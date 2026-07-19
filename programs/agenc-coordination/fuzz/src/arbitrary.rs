//! Arbitrary input generators for fuzz testing
//!
//! Generates random but valid inputs for testing protocol instructions.

use proptest::prelude::*;

/// Arbitrary 32-byte identifier (task_id, agent_id, dispute_id, pubkey, etc.)
pub fn arb_id() -> impl Strategy<Value = [u8; 32]> {
    prop::array::uniform32(any::<u8>())
}

/// Arbitrary 64-byte data (description, result_data, etc.)
pub fn arb_data_64() -> impl Strategy<Value = [u8; 64]> {
    prop::array::uniform32(any::<u8>()).prop_flat_map(|a| {
        prop::array::uniform32(any::<u8>()).prop_map(move |b| {
            let mut result = [0u8; 64];
            result[..32].copy_from_slice(&a);
            result[32..].copy_from_slice(&b);
            result
        })
    })
}

/// Arbitrary reward amount with edge cases
/// Tests: 0, 1, small values, large values, u64::MAX
pub fn arb_reward_amount() -> impl Strategy<Value = u64> {
    prop_oneof![
        // Edge cases (20% of tests)
        Just(0u64),
        Just(1u64),
        Just(u64::MAX),
        Just(u64::MAX - 1),
        Just(u64::MAX / 2),
        // Small amounts (30% of tests)
        1_000u64..1_000_000u64,
        // Typical amounts (30% of tests)
        1_000_000u64..1_000_000_000u64,
        // Large amounts (20% of tests)
        1_000_000_000u64..u64::MAX / 2,
    ]
}

/// Arbitrary malformed reward amounts for corpus-style edge case emphasis
pub fn arb_malformed_reward() -> impl Strategy<Value = u64> {
    prop_oneof![
        Just(0u64),
        Just(1u64),
        Just(u64::MAX),
        Just(u64::MAX - 1),
        (1u64..100u64),
    ]
}

/// Arbitrary protocol fee in basis points (0-10000)
pub fn arb_protocol_fee_bps() -> impl Strategy<Value = u16> {
    prop_oneof![
        // Edge cases
        Just(0u16),
        Just(1u16),
        Just(10000u16), // 100%
        Just(9999u16),
        // Typical values
        1u16..100u16,    // 0.01% - 1%
        100u16..1000u16, // 1% - 10%
    ]
}

/// Arbitrary reputation value (0-10000)
pub fn arb_reputation() -> impl Strategy<Value = u16> {
    prop_oneof![
        // Edge cases
        Just(0u16),
        Just(10000u16),
        Just(5000u16), // Initial reputation
        // Random values
        0u16..10000u16,
    ]
}

/// Arbitrary capability bitmask
pub fn arb_capabilities() -> impl Strategy<Value = u64> {
    prop_oneof![
        // Single capabilities
        Just(1u64 << 0), // COMPUTE
        Just(1u64 << 1), // INFERENCE
        Just(1u64 << 7), // ARBITER
        // Combined capabilities
        Just((1u64 << 0) | (1u64 << 1)), // COMPUTE + INFERENCE
        Just((1u64 << 7) | (1u64 << 0)), // ARBITER + COMPUTE
        // All capabilities
        Just((1u64 << 10) - 1),
        // Random combinations
        0u64..((1u64 << 10) - 1),
    ]
}

/// Arbitrary malformed capability masks (0, high bits, max)
pub fn arb_malformed_capabilities() -> impl Strategy<Value = u64> {
    prop_oneof![
        Just(0u64),
        Just(u64::MAX),
        Just(1u64 << 63),
        (0u64..1024u64),
    ]
}

/// Arbitrary worker count (1-255)
pub fn arb_worker_count() -> impl Strategy<Value = u8> {
    prop_oneof![Just(1u8), Just(10u8), Just(255u8), 1u8..=255u8,]
}

/// Arbitrary timestamp (seconds since Unix epoch)
pub fn arb_timestamp() -> impl Strategy<Value = i64> {
    prop_oneof![
        // Past timestamps
        Just(0i64),
        Just(1_000_000_000i64), // 2001
        // Current-ish timestamps
        1_700_000_000i64..1_800_000_000i64,
        // Far future
        Just(i64::MAX),
        Just(i64::MAX / 2),
    ]
}

/// Arbitrary deadline (0 = no deadline, or future timestamp)
pub fn arb_deadline() -> impl Strategy<Value = i64> {
    prop_oneof![
        Just(0i64),                         // No deadline
        1_700_000_000i64..1_900_000_000i64, // Future deadline
        Just(i64::MAX),
    ]
}

/// Arbitrary malformed deadlines (negative, min/max, near-term)
pub fn arb_malformed_deadline() -> impl Strategy<Value = i64> {
    prop_oneof![
        Just(0i64),
        Just(-1i64),
        Just(i64::MIN),
        Just(i64::MAX),
        (0i64..100i64),
    ]
}

/// Dispute timestamps, including values that exercise saturating deadline math.
pub fn arb_dispute_time() -> impl Strategy<Value = i64> {
    prop_oneof![
        Just(i64::MIN),
        Just(i64::MIN + 1),
        Just(-1i64),
        Just(0i64),
        Just(1i64),
        Just(i64::MAX - 1),
        Just(i64::MAX),
        -1_000_000i64..=1_000_000i64,
    ]
}

/// Arbitrary active task count (0-10)
pub fn arb_active_tasks() -> impl Strategy<Value = u8> {
    prop_oneof![
        Just(0u8),
        Just(9u8),  // Just under limit
        Just(10u8), // At limit
        0u8..=10u8,
    ]
}

/// Input for claim_task fuzz testing
#[derive(Debug, Clone)]
pub struct ClaimTaskInput {
    pub task_id: [u8; 32],
    pub agent_id: [u8; 32],
    pub task_reward: u64,
    pub task_max_workers: u8,
    pub task_current_workers: u8,
    pub task_required_capabilities: u64,
    pub task_deadline: i64,
    pub worker_capabilities: u64,
    pub worker_active_tasks: u8,
    pub worker_reputation: u16,
    pub current_timestamp: i64,
}

impl Arbitrary for ClaimTaskInput {
    type Parameters = ();
    type Strategy = BoxedStrategy<Self>;

    fn arbitrary_with(_: Self::Parameters) -> Self::Strategy {
        (
            arb_id(),
            arb_id(),
            arb_reward_amount(),
            arb_worker_count(),
            0u8..=255u8,
            arb_capabilities(),
            arb_deadline(),
            arb_capabilities(),
            arb_active_tasks(),
            arb_reputation(),
            arb_timestamp(),
        )
            .prop_map(
                |(
                    task_id,
                    agent_id,
                    task_reward,
                    task_max_workers,
                    task_current_workers,
                    task_required_capabilities,
                    task_deadline,
                    worker_capabilities,
                    worker_active_tasks,
                    worker_reputation,
                    current_timestamp,
                )| {
                    ClaimTaskInput {
                        task_id,
                        agent_id,
                        task_reward,
                        task_max_workers,
                        task_current_workers,
                        task_required_capabilities,
                        task_deadline,
                        worker_capabilities,
                        worker_active_tasks,
                        worker_reputation,
                        current_timestamp,
                    }
                },
            )
            .boxed()
    }
}

/// Input for complete_task fuzz testing
#[derive(Debug, Clone)]
pub struct CompleteTaskInput {
    pub task_id: [u8; 32],
    pub proof_hash: [u8; 32],
    pub result_data: Option<[u8; 64]>,
    pub task_reward: u64,
    pub task_type: u8, // 0=Exclusive, 1=Collaborative, 2=Competitive
    pub required_completions: u8,
    pub current_completions: u8,
    pub protocol_fee_bps: u16,
    pub escrow_amount: u64,
    pub escrow_distributed: u64,
    pub worker_reputation: u16,
    pub worker_total_earned: u64,
}

impl Arbitrary for CompleteTaskInput {
    type Parameters = ();
    type Strategy = BoxedStrategy<Self>;

    fn arbitrary_with(_: Self::Parameters) -> Self::Strategy {
        (
            arb_id(),
            arb_id(),
            proptest::option::of(arb_data_64()),
            arb_reward_amount(),
            0u8..=2u8,
            1u8..=255u8,
            0u8..=254u8,
            arb_protocol_fee_bps(),
            arb_reward_amount(),
            arb_reward_amount(),
            arb_reputation(),
            arb_reward_amount(),
        )
            .prop_map(
                |(
                    task_id,
                    proof_hash,
                    result_data,
                    task_reward,
                    task_type,
                    required_completions,
                    current_completions,
                    protocol_fee_bps,
                    escrow_amount,
                    escrow_distributed,
                    worker_reputation,
                    worker_total_earned,
                )| {
                    CompleteTaskInput {
                        task_id,
                        proof_hash,
                        result_data,
                        task_reward,
                        task_type,
                        required_completions,
                        current_completions,
                        protocol_fee_bps,
                        escrow_amount,
                        escrow_distributed,
                        worker_reputation,
                        worker_total_earned,
                    }
                },
            )
            .boxed()
    }
}

/// Identity selected for a direct dispute ruling. Party roles are modeled as
/// assigned resolvers so the conflict guards, rather than the roster gate, are
/// what reject them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolverRole {
    ProtocolAuthority,
    AssignedResolver,
    UnassignedResolver,
    Initiator,
    Creator,
    Worker,
}

pub const PROTOCOL_AUTHORITY: [u8; 32] = [1; 32];
pub const ASSIGNED_RESOLVER: [u8; 32] = [2; 32];
pub const UNASSIGNED_RESOLVER: [u8; 32] = [3; 32];
pub const DISPUTE_INITIATOR: [u8; 32] = [4; 32];
pub const TASK_CREATOR: [u8; 32] = [5; 32];
pub const TASK_WORKER: [u8; 32] = [6; 32];

/// Materialize a role with a complete authorization proof. This convenience
/// assumes configured threshold approval for a direct protocol-authority ruling;
/// tests that model missing approval must use
/// [`direct_ruling_with_threshold_approval`]. Party roles carry a valid assignment
/// so they exercise the self-dealing guards after passing the roster gate.
pub fn direct_ruling(
    role: ResolverRole,
    approve: bool,
    has_rationale: bool,
) -> crate::scenarios::SimulatedRuling {
    direct_ruling_with_threshold_approval(role, approve, has_rationale, true)
}

/// Materialize a direct ruling while explicitly modeling whether the configured
/// M-of-N owners approved an unassigned protocol-authority action. The approval
/// bit is ignored for assigned resolvers because their roster assignment was
/// threshold-approved separately.
pub fn direct_ruling_with_threshold_approval(
    role: ResolverRole,
    approve: bool,
    has_rationale: bool,
    has_configured_threshold_approval: bool,
) -> crate::scenarios::SimulatedRuling {
    let (resolver, resolver_assigned) = match role {
        ResolverRole::ProtocolAuthority => (PROTOCOL_AUTHORITY, false),
        ResolverRole::AssignedResolver => (ASSIGNED_RESOLVER, true),
        ResolverRole::UnassignedResolver => (UNASSIGNED_RESOLVER, false),
        ResolverRole::Initiator => (DISPUTE_INITIATOR, true),
        ResolverRole::Creator => (TASK_CREATOR, true),
        ResolverRole::Worker => (TASK_WORKER, true),
    };

    crate::scenarios::SimulatedRuling {
        resolver,
        protocol_authority: PROTOCOL_AUTHORITY,
        resolver_assigned,
        has_configured_threshold_approval,
        creator_authority: TASK_CREATOR,
        worker_authority: TASK_WORKER,
        approve,
        rationale_hash: if has_rationale { [7; 32] } else { [0; 32] },
    }
}

impl Arbitrary for ResolverRole {
    type Parameters = ();
    type Strategy = BoxedStrategy<Self>;

    fn arbitrary_with(_: Self::Parameters) -> Self::Strategy {
        prop_oneof![
            Just(Self::ProtocolAuthority),
            Just(Self::AssignedResolver),
            Just(Self::UnassignedResolver),
            Just(Self::Initiator),
            Just(Self::Creator),
            Just(Self::Worker),
        ]
        .boxed()
    }
}

/// Input for resolve_dispute fuzz testing
#[derive(Debug, Clone)]
pub struct ResolveDisputeInput {
    pub dispute_id: [u8; 32],
    pub resolution_type: u8, // 0=Refund, 1=Complete, 2=Split
    pub approve: bool,
    pub resolver_role: ResolverRole,
    pub has_rationale: bool,
    pub has_configured_threshold_approval: bool,
    pub dispute_active: bool,
    pub task_disputed: bool,
    pub escrow_amount: u64,
    pub escrow_distributed: u64,
    pub voting_deadline: i64,
    pub expires_at: i64,
    pub current_timestamp: i64,
}

impl Arbitrary for ResolveDisputeInput {
    type Parameters = ();
    type Strategy = BoxedStrategy<Self>;

    fn arbitrary_with(_: Self::Parameters) -> Self::Strategy {
        (
            (arb_id(), 0u8..=2u8, any::<bool>(), any::<ResolverRole>()),
            (any::<bool>(), any::<bool>(), any::<bool>(), any::<bool>()),
            (arb_reward_amount(), arb_reward_amount()),
            (arb_dispute_time(), arb_dispute_time(), arb_dispute_time()),
        )
            .prop_map(
                |(
                    (dispute_id, resolution_type, approve, resolver_role),
                    (
                        has_rationale,
                        has_configured_threshold_approval,
                        dispute_active,
                        task_disputed,
                    ),
                    (escrow_amount, escrow_distributed),
                    (voting_deadline, expires_at, current_timestamp),
                )| {
                    ResolveDisputeInput {
                        dispute_id,
                        resolution_type,
                        approve,
                        resolver_role,
                        has_rationale,
                        has_configured_threshold_approval,
                        dispute_active,
                        task_disputed,
                        escrow_amount,
                        escrow_distributed,
                        voting_deadline,
                        expires_at,
                        current_timestamp,
                    }
                },
            )
            .boxed()
    }
}

// ============================================================================
// Multi-instruction / lifecycle fuzz inputs
// ============================================================================

#[derive(Debug, Clone)]
pub enum LifecycleAction {
    Claim,
    Complete { proof_hash: [u8; 32] },
    Cancel,
    ExpireClaim,
    InitiateDispute { dispute_id: [u8; 32] },
}

impl Arbitrary for LifecycleAction {
    type Parameters = ();
    type Strategy = BoxedStrategy<Self>;

    fn arbitrary_with(_: Self::Parameters) -> Self::Strategy {
        prop_oneof![
            3 => Just(LifecycleAction::Claim),
            3 => arb_id().prop_map(|proof_hash| LifecycleAction::Complete { proof_hash }),
            2 => Just(LifecycleAction::Cancel),
            2 => Just(LifecycleAction::ExpireClaim),
            2 => arb_id().prop_map(|dispute_id| LifecycleAction::InitiateDispute { dispute_id }),
        ]
        .boxed()
    }
}

#[derive(Debug, Clone)]
pub struct TaskLifecycleSequence {
    pub task_id: [u8; 32],
    pub creator_id: [u8; 32],
    pub worker_id: [u8; 32],
    pub worker_status: u8,
    pub worker_capabilities: u64,
    pub task_required_capabilities: u64,
    pub reward_amount: u64,
    pub task_type: u8,
    pub max_workers: u8,
    pub required_completions: u8,
    pub deadline_offset: i64,
    pub current_timestamp: i64,
    pub protocol_fee_bps: u16,
    pub actions: Vec<LifecycleAction>,
}

impl Arbitrary for TaskLifecycleSequence {
    type Parameters = ();
    type Strategy = BoxedStrategy<Self>;

    fn arbitrary_with(_: Self::Parameters) -> Self::Strategy {
        (
            (arb_id(), arb_id(), arb_id()),
            (
                prop_oneof![Just(1u8), Just(3u8), 0u8..=3u8], // emphasize ACTIVE + SUSPENDED
                prop_oneof![arb_capabilities(), arb_malformed_capabilities()],
                prop_oneof![arb_capabilities(), arb_malformed_capabilities()],
            ),
            (
                prop_oneof![arb_reward_amount(), arb_malformed_reward()],
                0u8..=2u8,
                1u8..=10u8,
                1u8..=10u8,
            ),
            (
                prop_oneof![Just(-1i64), Just(0i64), Just(1i64), (-1_000i64..=1_000i64)],
                prop_oneof![arb_timestamp(), 0i64..1_000_000_000i64],
                arb_protocol_fee_bps(),
            ),
            prop::collection::vec(any::<LifecycleAction>(), 0..25),
        )
            .prop_map(
                |(
                    (task_id, creator_id, worker_id),
                    (worker_status, worker_capabilities, task_required_capabilities),
                    (reward_amount, task_type, max_workers, required_completions),
                    (deadline_offset, current_timestamp, protocol_fee_bps),
                    actions,
                )| TaskLifecycleSequence {
                    task_id,
                    creator_id,
                    worker_id,
                    worker_status,
                    worker_capabilities,
                    task_required_capabilities,
                    reward_amount,
                    task_type,
                    max_workers,
                    required_completions,
                    deadline_offset,
                    current_timestamp,
                    protocol_fee_bps,
                    actions,
                },
            )
            .boxed()
    }
}

#[derive(Debug, Clone)]
pub enum DisputeAction {
    Resolve {
        resolver_role: ResolverRole,
        approve: bool,
        has_rationale: bool,
        has_configured_threshold_approval: bool,
        timestamp: i64,
    },
    Cancel {
        by_initiator: bool,
    },
    Expire {
        timestamp: i64,
    },
}

impl Arbitrary for DisputeAction {
    type Parameters = ();
    type Strategy = BoxedStrategy<Self>;

    fn arbitrary_with(_: Self::Parameters) -> Self::Strategy {
        prop_oneof![
            5 => (
                any::<ResolverRole>(),
                any::<bool>(),
                any::<bool>(),
                any::<bool>(),
                arb_dispute_time(),
            )
                .prop_map(|(
                    resolver_role,
                    approve,
                    has_rationale,
                    has_configured_threshold_approval,
                    timestamp,
                )| {
                    DisputeAction::Resolve {
                        resolver_role,
                        approve,
                        has_rationale,
                        has_configured_threshold_approval,
                        timestamp,
                    }
                }),
            2 => any::<bool>().prop_map(|by_initiator| DisputeAction::Cancel { by_initiator }),
            3 => arb_dispute_time().prop_map(|timestamp| DisputeAction::Expire { timestamp }),
        ]
        .boxed()
    }
}

#[derive(Debug, Clone)]
pub struct DisputeLifecycleSequence {
    pub dispute_id: [u8; 32],
    pub task_id: [u8; 32],
    pub initial_task_status: u8,
    pub resolution_type: u8,
    pub voting_deadline: i64,
    pub expires_at: i64,
    pub escrow_amount: u64,
    pub actions: Vec<DisputeAction>,
}

impl Arbitrary for DisputeLifecycleSequence {
    type Parameters = ();
    type Strategy = BoxedStrategy<Self>;

    fn arbitrary_with(_: Self::Parameters) -> Self::Strategy {
        (
            (arb_id(), arb_id()),
            (
                prop_oneof![
                    Just(0u8), // OPEN
                    Just(1u8), // IN_PROGRESS
                    Just(2u8), // PENDING_VALIDATION
                    Just(3u8), // COMPLETED
                    Just(4u8), // CANCELLED
                    Just(5u8), // DISPUTED
                ],
                0u8..=2u8,
            ),
            (arb_dispute_time(), arb_dispute_time()),
            arb_reward_amount(),
            prop::collection::vec(any::<DisputeAction>(), 0..30),
        )
            .prop_map(
                |(
                    (dispute_id, task_id),
                    (initial_task_status, resolution_type),
                    (voting_deadline, expires_at),
                    escrow_amount,
                    actions,
                )| {
                    DisputeLifecycleSequence {
                        dispute_id,
                        task_id,
                        initial_task_status,
                        resolution_type,
                        voting_deadline,
                        expires_at,
                        escrow_amount,
                        actions,
                    }
                },
            )
            .boxed()
    }
}

#[derive(Debug, Clone)]
pub struct DependencyGraphInput {
    pub task_count: u8,
    pub edges: Vec<(u8, u8)>,
    pub completion_order: Vec<u8>,
}

impl Arbitrary for DependencyGraphInput {
    type Parameters = ();
    type Strategy = BoxedStrategy<Self>;

    fn arbitrary_with(_: Self::Parameters) -> Self::Strategy {
        (
            1u8..=10u8,
            prop::collection::vec((0u8..=20u8, 0u8..=20u8), 0..40),
            prop::collection::vec(0u8..=20u8, 0..40),
        )
            .prop_map(
                |(task_count, edges, completion_order)| DependencyGraphInput {
                    task_count,
                    edges,
                    completion_order,
                },
            )
            .boxed()
    }
}

#[derive(Debug, Clone)]
pub struct DisputeTimingInput {
    pub voting_deadline: i64,
    pub expires_at: i64,
    pub timestamps: Vec<i64>,
}

impl Arbitrary for DisputeTimingInput {
    type Parameters = ();
    type Strategy = BoxedStrategy<Self>;

    fn arbitrary_with(_: Self::Parameters) -> Self::Strategy {
        (
            arb_dispute_time(),
            arb_dispute_time(),
            prop::collection::vec(arb_dispute_time(), 1..20),
        )
            .prop_map(
                |(voting_deadline, expires_at, timestamps)| DisputeTimingInput {
                    voting_deadline,
                    expires_at,
                    timestamps,
                },
            )
            .boxed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    proptest! {
        #[test]
        fn test_arb_reward_generates_valid_values(reward in arb_reward_amount()) {
            // All u64 values are valid
            let _ = reward;
        }

        #[test]
        fn test_arb_reputation_within_bounds(rep in arb_reputation()) {
            prop_assert!(rep <= 10000);
        }

        #[test]
        fn test_claim_task_input_generates(input in any::<ClaimTaskInput>()) {
            // Ensure input is generated without panicking
            let _ = input.task_id;
            let _ = input.worker_capabilities;
        }

        #[test]
        fn test_complete_task_input_generates(input in any::<CompleteTaskInput>()) {
            prop_assert!(input.task_type <= 2);
            prop_assert!(input.required_completions >= 1);
        }

        #[test]
        fn test_resolve_dispute_input_generates(_input in any::<ResolveDisputeInput>()) {
        }

        #[test]
        fn test_task_lifecycle_sequence_generates(_seq in any::<TaskLifecycleSequence>()) {
        }

        #[test]
        fn test_dispute_lifecycle_sequence_generates(_seq in any::<DisputeLifecycleSequence>()) {
        }

        #[test]
        fn test_dependency_graph_input_generates(_input in any::<DependencyGraphInput>()) {
        }

        #[test]
        fn test_dispute_timing_input_generates(_input in any::<DisputeTimingInput>()) {
        }
    }
}
