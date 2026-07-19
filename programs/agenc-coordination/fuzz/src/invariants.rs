//! Protocol invariant checking for fuzz testing
//!
//! Implements invariants from docs/audit/THREAT_MODEL.md

/// Escrow invariant results
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EscrowInvariantResult {
    Valid,
    DistributedExceedsAmount {
        distributed: u64,
        amount: u64,
    },
    BalanceConservationViolation {
        expected: u64,
        actual: u64,
    },
    ClosedEscrowModified,
    /// E2: Monotonic distribution violation - distributed decreased
    MonotonicityViolation {
        old_distributed: u64,
        new_distributed: u64,
    },
}

/// Task state machine invariant results
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskInvariantResult {
    Valid,
    InvalidStateTransition { from: u8, to: u8 },
    TerminalStateModified { status: u8 },
    WorkerCountExceedsMax { current: u8, max: u8 },
    CompletionsExceedRequired { completions: u8, required: u8 },
    DeadlinePassed { deadline: i64, current: i64 },
}

/// Reputation invariant results
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReputationInvariantResult {
    Valid,
    OutOfBounds { reputation: u16 },
    InitialReputationWrong { expected: u16, actual: u16 },
    IncrementExceedsMax { before: u16, after: u16 },
}

/// Dispute invariant results
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DisputeInvariantResult {
    Valid,
    InvalidStateTransition {
        from: u8,
        to: u8,
    },
    InvalidRulingRecord {
        approved: bool,
        votes_for: u64,
        votes_against: u64,
        total_voters: u8,
    },
    ResolutionExpiryOverlap,
    ResolutionExpiryGap,
}

/// Direct-resolver authorization result. The order mirrors `resolve_dispute`:
/// roster/protocol authorization, direct-authority threshold approval, initiator
/// exclusion, then party exclusion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolverAuthorizationResult {
    Authorized,
    Unauthorized,
    MissingThresholdApproval,
    InitiatorConflict,
    PartyConflict,
}

// ============================================================================
// Escrow Invariants (E1-E5)
// ============================================================================

/// E3: Distribution Bounded by Deposit
/// `TaskEscrow.distributed <= TaskEscrow.amount` must always hold.
pub fn check_escrow_distribution_bounded(distributed: u64, amount: u64) -> EscrowInvariantResult {
    if distributed > amount {
        EscrowInvariantResult::DistributedExceedsAmount {
            distributed,
            amount,
        }
    } else {
        EscrowInvariantResult::Valid
    }
}

/// E1: Escrow Balance Conservation
/// Sum of distributed + remaining lamports = amount
pub fn check_escrow_balance_conservation(
    amount: u64,
    distributed: u64,
    remaining_lamports: u64,
) -> EscrowInvariantResult {
    // Use checked_sub to detect underflow (which would indicate distributed > amount)
    let expected_remaining = match amount.checked_sub(distributed) {
        Some(r) => r,
        None => {
            return EscrowInvariantResult::DistributedExceedsAmount {
                distributed,
                amount,
            };
        }
    };
    if remaining_lamports != expected_remaining {
        EscrowInvariantResult::BalanceConservationViolation {
            expected: expected_remaining,
            actual: remaining_lamports,
        }
    } else {
        EscrowInvariantResult::Valid
    }
}

/// E2: Monotonic Distribution
/// distributed can only increase
pub fn check_escrow_monotonic_distribution(
    old_distributed: u64,
    new_distributed: u64,
) -> EscrowInvariantResult {
    if new_distributed < old_distributed {
        EscrowInvariantResult::MonotonicityViolation {
            old_distributed,
            new_distributed,
        }
    } else {
        EscrowInvariantResult::Valid
    }
}

/// E4: Single Closure - no transfers after closure
pub fn check_escrow_not_closed_on_transfer(is_closed: bool) -> EscrowInvariantResult {
    if is_closed {
        EscrowInvariantResult::ClosedEscrowModified
    } else {
        EscrowInvariantResult::Valid
    }
}

// ============================================================================
// Task State Machine Invariants (T1-T5)
// ============================================================================

/// Task status enum values
pub mod task_status {
    pub const OPEN: u8 = 0;
    pub const IN_PROGRESS: u8 = 1;
    pub const PENDING_VALIDATION: u8 = 2;
    pub const COMPLETED: u8 = 3;
    pub const CANCELLED: u8 = 4;
    pub const DISPUTED: u8 = 5;
}

/// Agent status enum values (mirrors AgentStatus in state.rs)
pub mod agent_status {
    pub const INACTIVE: u8 = 0;
    pub const ACTIVE: u8 = 1;
    pub const BUSY: u8 = 2;
    pub const SUSPENDED: u8 = 3;
}

/// T1: Valid State Transitions
pub fn check_task_state_transition(from: u8, to: u8) -> TaskInvariantResult {
    let valid = matches!(
        (from, to),
        // From Open
        (task_status::OPEN, task_status::IN_PROGRESS)
            | (task_status::OPEN, task_status::CANCELLED)
            | (task_status::OPEN, task_status::DISPUTED)
            // From InProgress
            | (task_status::IN_PROGRESS, task_status::IN_PROGRESS)
            | (task_status::IN_PROGRESS, task_status::COMPLETED)
            | (task_status::IN_PROGRESS, task_status::CANCELLED)
            | (task_status::IN_PROGRESS, task_status::DISPUTED)
            | (task_status::IN_PROGRESS, task_status::PENDING_VALIDATION)
            // From PendingValidation
            | (task_status::PENDING_VALIDATION, task_status::PENDING_VALIDATION)
            | (task_status::PENDING_VALIDATION, task_status::IN_PROGRESS)
            | (task_status::PENDING_VALIDATION, task_status::OPEN)
            | (task_status::PENDING_VALIDATION, task_status::COMPLETED)
            | (task_status::PENDING_VALIDATION, task_status::DISPUTED)
            // From Disputed
            | (task_status::DISPUTED, task_status::OPEN)
            | (task_status::DISPUTED, task_status::IN_PROGRESS)
            | (task_status::DISPUTED, task_status::PENDING_VALIDATION)
            | (task_status::DISPUTED, task_status::COMPLETED)
            | (task_status::DISPUTED, task_status::CANCELLED)
    );

    if valid {
        TaskInvariantResult::Valid
    } else {
        TaskInvariantResult::InvalidStateTransition { from, to }
    }
}

/// T2: Terminal State Immutability
pub fn check_task_terminal_state(old_status: u8, new_status: u8) -> TaskInvariantResult {
    let is_terminal = old_status == task_status::COMPLETED || old_status == task_status::CANCELLED;
    if is_terminal && old_status != new_status {
        TaskInvariantResult::TerminalStateModified { status: old_status }
    } else {
        TaskInvariantResult::Valid
    }
}

/// T3: Worker Count Consistency
pub fn check_worker_count(current_workers: u8, max_workers: u8) -> TaskInvariantResult {
    if current_workers > max_workers {
        TaskInvariantResult::WorkerCountExceedsMax {
            current: current_workers,
            max: max_workers,
        }
    } else {
        TaskInvariantResult::Valid
    }
}

/// T4: Completion Count Bounded
pub fn check_completion_count(completions: u8, required_completions: u8) -> TaskInvariantResult {
    // Note: completions can exceed required in edge cases, but shouldn't trigger extra payments
    // The check is that we don't pay out more than required_completions worth of rewards
    if completions > required_completions {
        // This indicates excess completions - may be a warning condition
        TaskInvariantResult::CompletionsExceedRequired {
            completions,
            required: required_completions,
        }
    } else {
        TaskInvariantResult::Valid
    }
}

/// T5: Deadline Enforcement
pub fn check_deadline_enforcement(
    deadline: i64,
    current_time: i64,
    is_claiming: bool,
) -> TaskInvariantResult {
    if deadline > 0 && current_time >= deadline && is_claiming {
        TaskInvariantResult::DeadlinePassed {
            deadline,
            current: current_time,
        }
    } else {
        TaskInvariantResult::Valid
    }
}

// ============================================================================
// Reputation Invariants (R1-R4)
// ============================================================================

/// R1: Reputation Bounds
pub fn check_reputation_bounds(reputation: u16) -> ReputationInvariantResult {
    if reputation > 10000 {
        ReputationInvariantResult::OutOfBounds { reputation }
    } else {
        ReputationInvariantResult::Valid
    }
}

/// R2: Initial reputation for newly created simulated agents.
pub fn check_genesis_reputation(reputation: u16, is_new_agent: bool) -> ReputationInvariantResult {
    if is_new_agent && reputation != 3000 {
        ReputationInvariantResult::InitialReputationWrong {
            expected: 3000,
            actual: reputation,
        }
    } else {
        ReputationInvariantResult::Valid
    }
}

/// R3: Reputation Increment Rules
/// Reputation increases by the fee-backed completion award, capped at 10000.
pub fn check_reputation_increment(
    before: u16,
    after: u16,
    earned_gain: u16,
) -> ReputationInvariantResult {
    let expected = before.saturating_add(earned_gain).min(10000);
    if after != expected {
        ReputationInvariantResult::IncrementExceedsMax { before, after }
    } else {
        ReputationInvariantResult::Valid
    }
}

// ============================================================================
// Dispute Invariants (D1-D5)
// ============================================================================

/// Dispute status enum values
pub mod dispute_status {
    pub const ACTIVE: u8 = 0;
    pub const RESOLVED: u8 = 1;
    pub const EXPIRED: u8 = 2;
    pub const CANCELLED: u8 = 3;
}

/// D1: Dispute State Machine
pub fn check_dispute_state_transition(from: u8, to: u8) -> DisputeInvariantResult {
    let valid = matches!(
        (from, to),
        (dispute_status::ACTIVE, dispute_status::RESOLVED)
            | (dispute_status::ACTIVE, dispute_status::EXPIRED)
            | (dispute_status::ACTIVE, dispute_status::CANCELLED)
    ) || from == to;

    if valid {
        DisputeInvariantResult::Valid
    } else {
        DisputeInvariantResult::InvalidStateTransition { from, to }
    }
}

/// Direct rulings reuse the retired vote fields as one complementary bit. The
/// retired voter byte is either historical zero or the current initiator-counter
/// provenance sentinel; neither value represents a voter count.
pub fn check_direct_ruling_record(
    approved: bool,
    votes_for: u64,
    votes_against: u64,
    total_voters: u8,
) -> DisputeInvariantResult {
    let expected = if approved { (1, 0) } else { (0, 1) };
    if (votes_for, votes_against) == expected
        && (total_voters == 0 || total_voters == crate::INITIATOR_OUTCOME_COUNTER_MARKER)
    {
        DisputeInvariantResult::Valid
    } else {
        DisputeInvariantResult::InvalidRulingRecord {
            approved,
            votes_for,
            votes_against,
            total_voters,
        }
    }
}

/// Resolution and permissionless expiry must form an exact partition at every
/// timestamp: no race where both paths succeed and no liveness gap where neither does.
pub fn check_dispute_window_partition(
    resolution_open: bool,
    expiry_open: bool,
) -> DisputeInvariantResult {
    match (resolution_open, expiry_open) {
        (true, false) | (false, true) => DisputeInvariantResult::Valid,
        (true, true) => DisputeInvariantResult::ResolutionExpiryOverlap,
        (false, false) => DisputeInvariantResult::ResolutionExpiryGap,
    }
}

pub fn check_resolver_authorization(
    resolver: &[u8; 32],
    protocol_authority: &[u8; 32],
    resolver_assigned: bool,
    has_configured_threshold_approval: bool,
    initiator_authority: &[u8; 32],
    creator_authority: &[u8; 32],
    worker_authority: &[u8; 32],
) -> ResolverAuthorizationResult {
    let is_protocol_authority = resolver == protocol_authority;
    if !is_protocol_authority && !resolver_assigned {
        return ResolverAuthorizationResult::Unauthorized;
    }
    if is_protocol_authority && !resolver_assigned && !has_configured_threshold_approval {
        return ResolverAuthorizationResult::MissingThresholdApproval;
    }
    if resolver == initiator_authority {
        return ResolverAuthorizationResult::InitiatorConflict;
    }
    if resolver == creator_authority || resolver == worker_authority {
        return ResolverAuthorizationResult::PartyConflict;
    }
    ResolverAuthorizationResult::Authorized
}

// ============================================================================
// Arithmetic Safety
// ============================================================================

/// Check that arithmetic operations don't overflow/underflow
pub struct ArithmeticCheck {
    pub overflows: Vec<String>,
}

impl ArithmeticCheck {
    pub fn new() -> Self {
        Self {
            overflows: Vec::new(),
        }
    }

    pub fn check_add(&mut self, name: &str, a: u64, b: u64) -> Option<u64> {
        match a.checked_add(b) {
            Some(result) => Some(result),
            None => {
                self.overflows
                    .push(format!("{}: {} + {} overflows", name, a, b));
                None
            }
        }
    }

    pub fn check_sub(&mut self, name: &str, a: u64, b: u64) -> Option<u64> {
        match a.checked_sub(b) {
            Some(result) => Some(result),
            None => {
                self.overflows
                    .push(format!("{}: {} - {} underflows", name, a, b));
                None
            }
        }
    }

    pub fn check_mul(&mut self, name: &str, a: u64, b: u64) -> Option<u64> {
        match a.checked_mul(b) {
            Some(result) => Some(result),
            None => {
                self.overflows
                    .push(format!("{}: {} * {} overflows", name, a, b));
                None
            }
        }
    }

    pub fn check_div(&mut self, name: &str, a: u64, b: u64) -> Option<u64> {
        if b == 0 {
            self.overflows
                .push(format!("{}: {} / 0 division by zero", name, a));
            None
        } else {
            a.checked_div(b)
        }
    }

    pub fn is_valid(&self) -> bool {
        self.overflows.is_empty()
    }

    pub fn errors(&self) -> &[String] {
        &self.overflows
    }
}

impl Default for ArithmeticCheck {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_escrow_distribution_bounded() {
        assert_eq!(
            check_escrow_distribution_bounded(100, 200),
            EscrowInvariantResult::Valid
        );
        assert_eq!(
            check_escrow_distribution_bounded(200, 200),
            EscrowInvariantResult::Valid
        );
        assert!(matches!(
            check_escrow_distribution_bounded(201, 200),
            EscrowInvariantResult::DistributedExceedsAmount { .. }
        ));
    }

    #[test]
    fn test_task_state_transitions() {
        // Canonical lifecycle transitions
        assert_eq!(
            check_task_state_transition(task_status::OPEN, task_status::IN_PROGRESS),
            TaskInvariantResult::Valid
        );
        assert_eq!(
            check_task_state_transition(task_status::OPEN, task_status::DISPUTED),
            TaskInvariantResult::Valid
        );
        assert_eq!(
            check_task_state_transition(task_status::IN_PROGRESS, task_status::PENDING_VALIDATION),
            TaskInvariantResult::Valid
        );
        assert_eq!(
            check_task_state_transition(task_status::PENDING_VALIDATION, task_status::IN_PROGRESS),
            TaskInvariantResult::Valid
        );
        assert_eq!(
            check_task_state_transition(task_status::PENDING_VALIDATION, task_status::OPEN),
            TaskInvariantResult::Valid
        );
        assert_eq!(
            check_task_state_transition(task_status::PENDING_VALIDATION, task_status::COMPLETED),
            TaskInvariantResult::Valid
        );
        assert_eq!(
            check_task_state_transition(task_status::PENDING_VALIDATION, task_status::DISPUTED),
            TaskInvariantResult::Valid
        );
        assert_eq!(
            check_task_state_transition(task_status::IN_PROGRESS, task_status::COMPLETED),
            TaskInvariantResult::Valid
        );

        // Invalid transitions
        assert!(matches!(
            check_task_state_transition(task_status::OPEN, task_status::PENDING_VALIDATION),
            TaskInvariantResult::InvalidStateTransition { .. }
        ));
        assert!(matches!(
            check_task_state_transition(task_status::COMPLETED, task_status::OPEN),
            TaskInvariantResult::InvalidStateTransition { .. }
        ));
        assert!(matches!(
            check_task_state_transition(task_status::COMPLETED, task_status::DISPUTED),
            TaskInvariantResult::InvalidStateTransition { .. }
        ));
    }

    #[test]
    fn test_reputation_bounds() {
        assert_eq!(check_reputation_bounds(0), ReputationInvariantResult::Valid);
        assert_eq!(
            check_reputation_bounds(5000),
            ReputationInvariantResult::Valid
        );
        assert_eq!(
            check_reputation_bounds(10000),
            ReputationInvariantResult::Valid
        );
        assert!(matches!(
            check_reputation_bounds(10001),
            ReputationInvariantResult::OutOfBounds { .. }
        ));
    }

    #[test]
    fn test_arithmetic_check() {
        let mut check = ArithmeticCheck::new();

        assert_eq!(check.check_add("test", 100, 200), Some(300));
        assert!(check.is_valid());

        assert_eq!(check.check_add("overflow", u64::MAX, 1), None);
        assert!(!check.is_valid());
        assert_eq!(check.errors().len(), 1);
    }
}
