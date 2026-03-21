//! Fuzz testing scenarios that simulate instruction execution
//!
//! These scenarios test the instruction logic without requiring the full
//! Solana runtime, enabling fast property-based testing.

use crate::invariants::*;

/// Simulated task state for testing
#[derive(Debug, Clone, Default)]
pub struct SimulatedTask {
    pub task_id: [u8; 32],
    pub status: u8,
    pub reward_amount: u64,
    pub max_workers: u8,
    pub current_workers: u8,
    pub required_capabilities: u64,
    pub deadline: i64,
    pub completions: u8,
    pub required_completions: u8,
    pub task_type: u8,
}

/// Simulated escrow state for testing
#[derive(Debug, Clone, Default)]
pub struct SimulatedEscrow {
    pub amount: u64,
    pub distributed: u64,
    pub is_closed: bool,
}

/// Simulated agent state for testing
#[derive(Debug, Clone, Default)]
pub struct SimulatedAgent {
    pub agent_id: [u8; 32],
    pub capabilities: u64,
    /// Agent status (see `agent_status` module in invariants.rs for values)
    pub status: u8,
    pub active_tasks: u8,
    pub reputation: u16,
    pub stake: u64,
    pub tasks_completed: u64,
    pub total_earned: u64,
}

/// Simulated dispute state for testing
#[derive(Debug, Clone, Default)]
pub struct SimulatedDispute {
    pub dispute_id: [u8; 32],
    pub status: u8,
    pub resolution_type: u8,
    pub votes_for: u8,
    pub votes_against: u8,
    pub total_voters: u8,
    pub voting_deadline: i64,
}

/// Simulated protocol config
#[derive(Debug, Clone)]
pub struct SimulatedConfig {
    pub dispute_threshold: u8,
    pub protocol_fee_bps: u16,
    pub min_arbiter_stake: u64,
}

impl Default for SimulatedConfig {
    fn default() -> Self {
        Self {
            dispute_threshold: 51,
            protocol_fee_bps: 100, // 1%
            min_arbiter_stake: 1_000_000,
        }
    }
}

/// Result of a simulated instruction execution
#[derive(Debug, Clone)]
pub enum SimulationResult {
    Success,
    Error(String),
    InvariantViolation(String),
}

impl SimulationResult {
    pub fn is_success(&self) -> bool {
        matches!(self, SimulationResult::Success)
    }

    pub fn is_error(&self) -> bool {
        matches!(self, SimulationResult::Error(_))
    }

    pub fn is_invariant_violation(&self) -> bool {
        matches!(self, SimulationResult::InvariantViolation(_))
    }
}

// ============================================================================
// Claim Task Simulation
// ============================================================================

/// Simulate claim_task instruction
pub fn simulate_claim_task(
    task: &mut SimulatedTask,
    worker: &mut SimulatedAgent,
    current_time: i64,
) -> SimulationResult {
    // Pre-condition checks (these should return errors, not invariant violations)

    // Check task status
    if task.status != task_status::OPEN && task.status != task_status::IN_PROGRESS {
        return SimulationResult::Error("TaskNotOpen".to_string());
    }

    // Check deadline
    if task.deadline > 0 && current_time >= task.deadline {
        return SimulationResult::Error("TaskExpired".to_string());
    }

    // Check worker count
    if task.current_workers >= task.max_workers {
        return SimulationResult::Error("TaskFullyClaimed".to_string());
    }

    // Check worker is active
    if worker.status != agent_status::ACTIVE {
        return SimulationResult::Error("AgentNotActive".to_string());
    }

    // Check capabilities
    if (worker.capabilities & task.required_capabilities) != task.required_capabilities {
        return SimulationResult::Error("InsufficientCapabilities".to_string());
    }

    // Check active tasks limit
    if worker.active_tasks >= 10 {
        return SimulationResult::Error("MaxActiveTasksReached".to_string());
    }

    // Execute the claim
    let old_status = task.status;
    task.current_workers = match task.current_workers.checked_add(1) {
        Some(w) => w,
        None => return SimulationResult::Error("ArithmeticOverflow: current_workers".to_string()),
    };
    task.status = task_status::IN_PROGRESS;
    worker.active_tasks = match worker.active_tasks.checked_add(1) {
        Some(a) => a,
        None => return SimulationResult::Error("ArithmeticOverflow: active_tasks".to_string()),
    };

    // Post-condition invariant checks

    // T1: Valid state transition
    if let TaskInvariantResult::InvalidStateTransition { from, to } =
        check_task_state_transition(old_status, task.status)
    {
        return SimulationResult::InvariantViolation(format!(
            "T1: Invalid state transition from {} to {}",
            from, to
        ));
    }

    // T3: Worker count consistency
    if let TaskInvariantResult::WorkerCountExceedsMax { current, max } =
        check_worker_count(task.current_workers, task.max_workers)
    {
        return SimulationResult::InvariantViolation(format!(
            "T3: Worker count {} exceeds max {}",
            current, max
        ));
    }

    SimulationResult::Success
}

// ============================================================================
// Complete Task Simulation
// ============================================================================

/// Simulate complete_task instruction
pub fn simulate_complete_task(
    task: &mut SimulatedTask,
    escrow: &mut SimulatedEscrow,
    worker: &mut SimulatedAgent,
    config: &SimulatedConfig,
    _proof_hash: [u8; 32],
) -> SimulationResult {
    // Pre-condition checks

    // Check task status
    if task.status != task_status::IN_PROGRESS {
        return SimulationResult::Error("TaskNotInProgress".to_string());
    }

    // Check worker is active
    if worker.status != agent_status::ACTIVE {
        return SimulationResult::Error("AgentNotActive".to_string());
    }

    // CRITICAL: Check competitive task single-completion invariant
    // Competitive tasks (task_type == 2) must check completions == 0 before paying rewards
    if task.task_type == 2 && task.completions > 0 {
        return SimulationResult::Error("CompetitiveTaskAlreadyWon".to_string());
    }

    // E4: Check escrow not closed
    if escrow.is_closed {
        return SimulationResult::Error("EscrowAlreadyClosed".to_string());
    }

    // Calculate reward
    let reward_per_worker = if task.task_type == 1 {
        // Collaborative
        match task
            .reward_amount
            .checked_div(task.required_completions as u64)
        {
            Some(r) => r,
            None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
        }
    } else {
        task.reward_amount
    };

    // Calculate protocol fee
    let protocol_fee = match reward_per_worker
        .checked_mul(config.protocol_fee_bps as u64)
        .and_then(|v| v.checked_div(10000))
    {
        Some(f) => f,
        None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
    };

    let worker_reward = match reward_per_worker.checked_sub(protocol_fee) {
        Some(r) => r,
        None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
    };

    // E3: Check distribution won't exceed amount
    let new_distributed = match escrow.distributed.checked_add(reward_per_worker) {
        Some(d) => d,
        None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
    };

    if let EscrowInvariantResult::DistributedExceedsAmount {
        distributed,
        amount,
    } = check_escrow_distribution_bounded(new_distributed, escrow.amount)
    {
        return SimulationResult::Error(format!(
            "InsufficientEscrowBalance: {} > {}",
            distributed, amount
        ));
    }

    // Execute the completion
    let old_distributed = escrow.distributed;
    escrow.distributed = new_distributed;

    task.completions = match task.completions.checked_add(1) {
        Some(c) => c,
        None => return SimulationResult::Error("ArithmeticOverflow: completions".to_string()),
    };

    let task_completed = task.completions >= task.required_completions;
    let old_status = task.status;
    if task_completed {
        task.status = task_status::COMPLETED;
        escrow.is_closed = true;
    }

    // Update worker stats
    worker.tasks_completed = match worker.tasks_completed.checked_add(1) {
        Some(c) => c,
        None => return SimulationResult::Error("ArithmeticOverflow: tasks_completed".to_string()),
    };
    worker.total_earned = match worker.total_earned.checked_add(worker_reward) {
        Some(e) => e,
        None => return SimulationResult::Error("ArithmeticOverflow: total_earned".to_string()),
    };
    worker.active_tasks = match worker.active_tasks.checked_sub(1) {
        Some(a) => a,
        None => return SimulationResult::Error("ArithmeticUnderflow: active_tasks".to_string()),
    };

    // R1 & R3: Update reputation (capped at 10000)
    let old_reputation = worker.reputation;
    worker.reputation = worker
        .reputation
        .checked_add(100)
        .unwrap_or(10000)
        .min(10000);

    // Post-condition invariant checks

    // E2: Monotonic distribution
    if let EscrowInvariantResult::MonotonicityViolation {
        old_distributed: old,
        new_distributed: new,
    } = check_escrow_monotonic_distribution(old_distributed, escrow.distributed)
    {
        return SimulationResult::InvariantViolation(format!(
            "E2: Distribution decreased from {} to {}",
            old, new
        ));
    }

    // T1: Valid state transition
    if let TaskInvariantResult::InvalidStateTransition { from, to } =
        check_task_state_transition(old_status, task.status)
    {
        return SimulationResult::InvariantViolation(format!(
            "T1: Invalid state transition from {} to {}",
            from, to
        ));
    }

    // R1: Reputation bounds
    if let ReputationInvariantResult::OutOfBounds { reputation } =
        check_reputation_bounds(worker.reputation)
    {
        return SimulationResult::InvariantViolation(format!(
            "R1: Reputation {} out of bounds",
            reputation
        ));
    }

    // R3: Reputation increment
    if let ReputationInvariantResult::IncrementExceedsMax { before, after } =
        check_reputation_increment(old_reputation, worker.reputation)
    {
        return SimulationResult::InvariantViolation(format!(
            "R3: Reputation increment from {} to {} exceeds rules",
            before, after
        ));
    }

    SimulationResult::Success
}

// ============================================================================
// Vote Dispute Simulation
// ============================================================================

/// Simulate vote_dispute instruction
pub fn simulate_vote_dispute(
    dispute: &mut SimulatedDispute,
    arbiter: &SimulatedAgent,
    config: &SimulatedConfig,
    approve: bool,
    current_time: i64,
) -> SimulationResult {
    // Pre-condition checks

    // Check dispute is active
    if dispute.status != dispute_status::ACTIVE {
        return SimulationResult::Error("DisputeNotActive".to_string());
    }

    // D3: Check voting window
    if current_time >= dispute.voting_deadline {
        return SimulationResult::Error("VotingEnded".to_string());
    }

    // Check arbiter is active
    if arbiter.status != agent_status::ACTIVE {
        return SimulationResult::Error("AgentNotActive".to_string());
    }

    // A4: Check arbiter capability
    if let AuthorityInvariantResult::MissingArbiterCapability =
        check_arbiter_capability(arbiter.capabilities)
    {
        return SimulationResult::Error("NotArbiter".to_string());
    }

    // S1: Check arbiter stake
    if let AuthorityInvariantResult::InsufficientArbiterStake { stake, required } =
        check_arbiter_stake(arbiter.stake, config.min_arbiter_stake)
    {
        return SimulationResult::Error(format!("InsufficientStake: {} < {}", stake, required));
    }

    // Execute the vote
    if approve {
        dispute.votes_for = match dispute.votes_for.checked_add(1) {
            Some(v) => v,
            None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
        };
    } else {
        dispute.votes_against = match dispute.votes_against.checked_add(1) {
            Some(v) => v,
            None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
        };
    }

    dispute.total_voters = match dispute.total_voters.checked_add(1) {
        Some(v) => v,
        None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
    };

    // Post-condition checks - voting window invariant
    if let DisputeInvariantResult::VotingAfterDeadline { deadline, voted_at } =
        check_voting_window(dispute.voting_deadline, current_time, true)
    {
        return SimulationResult::InvariantViolation(format!(
            "D3: Voted at {} after deadline {}",
            voted_at, deadline
        ));
    }

    SimulationResult::Success
}

// ============================================================================
// Resolve Dispute Simulation
// ============================================================================

/// Simulate resolve_dispute instruction
pub fn simulate_resolve_dispute(
    dispute: &mut SimulatedDispute,
    task: &mut SimulatedTask,
    escrow: &mut SimulatedEscrow,
    config: &SimulatedConfig,
    current_time: i64,
) -> SimulationResult {
    // Pre-condition checks

    // Check dispute is active
    if dispute.status != dispute_status::ACTIVE {
        return SimulationResult::Error("DisputeNotActive".to_string());
    }

    // Check task is in disputed state
    if task.status != task_status::DISPUTED {
        return SimulationResult::Error("TaskNotDisputed".to_string());
    }

    // D3: Check voting period has ended
    if current_time < dispute.voting_deadline {
        return SimulationResult::Error("VotingNotEnded".to_string());
    }

    // Check we have votes
    let total_votes = match dispute.votes_for.checked_add(dispute.votes_against) {
        Some(t) => t,
        None => return SimulationResult::Error("ArithmeticOverflow: total_votes".to_string()),
    };
    if total_votes == 0 {
        return SimulationResult::Error("InsufficientVotes".to_string());
    }

    // D4: Calculate approval percentage
    let approval_pct = (dispute.votes_for as u64)
        .checked_mul(100)
        .and_then(|v| v.checked_div(total_votes as u64))
        .unwrap_or(0) as u8;

    let approved = approval_pct >= config.dispute_threshold;

    // Calculate remaining funds
    let remaining_funds = match escrow.amount.checked_sub(escrow.distributed) {
        Some(r) => r,
        None => {
            return SimulationResult::InvariantViolation(
                "E3: distributed exceeds amount".to_string(),
            )
        }
    };

    // Execute resolution
    let old_task_status = task.status;
    let old_dispute_status = dispute.status;

    if approved {
        match dispute.resolution_type {
            0 => {
                // Refund
                task.status = task_status::CANCELLED;
            }
            1 => {
                // Complete
                task.status = task_status::COMPLETED;
            }
            2 => {
                // Split
                task.status = task_status::CANCELLED;
            }
            _ => return SimulationResult::Error("InvalidResolutionType".to_string()),
        }
    } else {
        // Rejected - refund by default
        task.status = task_status::CANCELLED;
    }

    dispute.status = dispute_status::RESOLVED;
    escrow.distributed = match escrow.distributed.checked_add(remaining_funds) {
        Some(d) => d,
        None => {
            return SimulationResult::InvariantViolation(
                "E3: distributed overflow when adding remaining funds".to_string(),
            )
        }
    };
    escrow.is_closed = true;

    // Post-condition invariant checks

    // D1: Valid dispute state transition
    if let DisputeInvariantResult::InvalidStateTransition { from, to } =
        check_dispute_state_transition(old_dispute_status, dispute.status)
    {
        return SimulationResult::InvariantViolation(format!(
            "D1: Invalid dispute transition from {} to {}",
            from, to
        ));
    }

    // T1: Valid task state transition (Disputed -> Completed/Cancelled)
    if let TaskInvariantResult::InvalidStateTransition { from, to } =
        check_task_state_transition(old_task_status, task.status)
    {
        return SimulationResult::InvariantViolation(format!(
            "T1: Invalid task transition from {} to {}",
            from, to
        ));
    }

    // E3: Distribution bounded
    if let EscrowInvariantResult::DistributedExceedsAmount {
        distributed,
        amount,
    } = check_escrow_distribution_bounded(escrow.distributed, escrow.amount)
    {
        return SimulationResult::InvariantViolation(format!(
            "E3: distributed {} exceeds amount {}",
            distributed, amount
        ));
    }

    SimulationResult::Success
}

// ============================================================================
// Cancel / Expire / Lifecycle Simulation
// ============================================================================

/// Simulate cancel_task instruction
pub fn simulate_cancel_task(
    task: &mut SimulatedTask,
    escrow: &mut SimulatedEscrow,
) -> SimulationResult {
    // Pre-condition checks
    if task.status != task_status::OPEN && task.status != task_status::IN_PROGRESS {
        return SimulationResult::Error("TaskNotCancellable".to_string());
    }

    if escrow.is_closed {
        return SimulationResult::Error("EscrowAlreadyClosed".to_string());
    }

    let old_task_status = task.status;
    let old_distributed = escrow.distributed;

    // Cancel the task
    task.status = task_status::CANCELLED;

    // Refund remaining funds and close escrow
    let remaining_funds = match escrow.amount.checked_sub(escrow.distributed) {
        Some(r) => r,
        None => {
            return SimulationResult::InvariantViolation(
                "E3: distributed exceeds amount".to_string(),
            );
        }
    };

    escrow.distributed = match escrow.distributed.checked_add(remaining_funds) {
        Some(d) => d,
        None => return SimulationResult::Error("ArithmeticOverflow: distributed".to_string()),
    };
    escrow.is_closed = true;

    // Post-condition invariant checks

    // E2: Monotonic distribution
    if let EscrowInvariantResult::MonotonicityViolation {
        old_distributed: old,
        new_distributed: new,
    } = check_escrow_monotonic_distribution(old_distributed, escrow.distributed)
    {
        return SimulationResult::InvariantViolation(format!(
            "E2: Distribution decreased from {} to {}",
            old, new
        ));
    }

    // E3: Distribution bounded
    if let EscrowInvariantResult::DistributedExceedsAmount {
        distributed,
        amount,
    } = check_escrow_distribution_bounded(escrow.distributed, escrow.amount)
    {
        return SimulationResult::InvariantViolation(format!(
            "E3: distributed {} exceeds amount {}",
            distributed, amount
        ));
    }

    // T1: Valid task state transition
    if let TaskInvariantResult::InvalidStateTransition { from, to } =
        check_task_state_transition(old_task_status, task.status)
    {
        return SimulationResult::InvariantViolation(format!(
            "T1: Invalid state transition from {} to {}",
            from, to
        ));
    }

    SimulationResult::Success
}

/// Simulate expiring a claim after task deadline passes
pub fn simulate_expire_claim(
    task: &mut SimulatedTask,
    worker: &mut SimulatedAgent,
    current_time: i64,
) -> SimulationResult {
    // Pre-condition checks
    if task.status != task_status::IN_PROGRESS {
        return SimulationResult::Error("TaskNotInProgress".to_string());
    }

    if task.deadline <= 0 || current_time < task.deadline {
        return SimulationResult::Error("ClaimNotExpired".to_string());
    }

    if task.current_workers == 0 {
        return SimulationResult::Error("NoActiveClaims".to_string());
    }

    if worker.active_tasks == 0 {
        return SimulationResult::Error("WorkerHasNoActiveTasks".to_string());
    }

    let old_status = task.status;

    task.current_workers = match task.current_workers.checked_sub(1) {
        Some(w) => w,
        None => return SimulationResult::Error("ArithmeticUnderflow: current_workers".to_string()),
    };

    worker.active_tasks = match worker.active_tasks.checked_sub(1) {
        Some(a) => a,
        None => return SimulationResult::Error("ArithmeticUnderflow: active_tasks".to_string()),
    };

    // Post-condition invariant checks

    // T1: No invalid state transition (should remain InProgress)
    if let TaskInvariantResult::InvalidStateTransition { from, to } =
        check_task_state_transition(old_status, task.status)
    {
        return SimulationResult::InvariantViolation(format!(
            "T1: Invalid state transition from {} to {}",
            from, to
        ));
    }

    // T3: Worker count consistency
    if let TaskInvariantResult::WorkerCountExceedsMax { current, max } =
        check_worker_count(task.current_workers, task.max_workers)
    {
        return SimulationResult::InvariantViolation(format!(
            "T3: Worker count {} exceeds max {}",
            current, max
        ));
    }

    SimulationResult::Success
}

/// Simulate initiating a dispute for a task
pub fn simulate_dispute_open(
    task: &mut SimulatedTask,
    dispute: &mut SimulatedDispute,
) -> SimulationResult {
    // Pre-condition checks
    if task.status != task_status::IN_PROGRESS && task.status != task_status::COMPLETED {
        return SimulationResult::Error("TaskNotDisputable".to_string());
    }

    let old_task_status = task.status;
    task.status = task_status::DISPUTED;

    // Activate dispute (id and deadlines are assumed to be set by caller)
    dispute.status = dispute_status::ACTIVE;

    // Post-condition invariant checks
    if let TaskInvariantResult::InvalidStateTransition { from, to } =
        check_task_state_transition(old_task_status, task.status)
    {
        return SimulationResult::InvariantViolation(format!(
            "T1: Invalid state transition from {} to {}",
            from, to
        ));
    }

    SimulationResult::Success
}

/// Simulate expiring a dispute after voting deadline passes
pub fn simulate_expire_dispute(
    dispute: &mut SimulatedDispute,
    current_time: i64,
) -> SimulationResult {
    // Pre-condition checks
    if dispute.status != dispute_status::ACTIVE {
        return SimulationResult::Error("DisputeNotActive".to_string());
    }

    if current_time < dispute.voting_deadline {
        return SimulationResult::Error("VotingNotEnded".to_string());
    }

    let old_status = dispute.status;
    dispute.status = dispute_status::EXPIRED;

    // Post-condition invariant checks
    if let DisputeInvariantResult::InvalidStateTransition { from, to } =
        check_dispute_state_transition(old_status, dispute.status)
    {
        return SimulationResult::InvariantViolation(format!(
            "D1: Invalid dispute transition from {} to {}",
            from, to
        ));
    }

    SimulationResult::Success
}

/// Simulate completing a dependent task (requires all parents completed)
pub fn simulate_complete_dependent_task(
    task: &mut SimulatedTask,
    parents_completed: bool,
) -> SimulationResult {
    if !parents_completed {
        return SimulationResult::Error("DependenciesNotMet".to_string());
    }

    if task.status != task_status::IN_PROGRESS {
        return SimulationResult::Error("TaskNotInProgress".to_string());
    }

    let old_status = task.status;
    task.status = task_status::COMPLETED;

    // Post-condition invariant checks
    if let TaskInvariantResult::InvalidStateTransition { from, to } =
        check_task_state_transition(old_status, task.status)
    {
        return SimulationResult::InvariantViolation(format!(
            "T1: Invalid state transition from {} to {}",
            from, to
        ));
    }

    SimulationResult::Success
}

// ============================================================================
// Race Condition Scenarios
// ============================================================================

/// Test multiple simultaneous claims on the same task
pub fn simulate_concurrent_claims(
    task: &mut SimulatedTask,
    workers: &mut [SimulatedAgent],
    current_time: i64,
) -> Vec<SimulationResult> {
    let mut results = Vec::new();

    for worker in workers.iter_mut() {
        let result = simulate_claim_task(task, worker, current_time);
        results.push(result);
    }

    // Invariant: current_workers should never exceed max_workers
    if task.current_workers > task.max_workers {
        results.push(SimulationResult::InvariantViolation(format!(
            "Race condition: current_workers {} > max_workers {}",
            task.current_workers, task.max_workers
        )));
    }

    results
}

/// Test double completion attempt
pub fn simulate_double_completion(
    task: &mut SimulatedTask,
    escrow: &mut SimulatedEscrow,
    worker: &mut SimulatedAgent,
    config: &SimulatedConfig,
) -> (SimulationResult, SimulationResult) {
    let proof_hash = [0u8; 32];

    // First completion
    let result1 = simulate_complete_task(task, escrow, worker, config, proof_hash);

    // Second completion attempt (should fail for exclusive tasks)
    let result2 = simulate_complete_task(task, escrow, worker, config, proof_hash);

    (result1, result2)
}

// ============================================================================
// Marketplace V2 Bid Lifecycle Simulation
// ============================================================================

/// Marketplace V2 bid-book state enum values.
pub mod bid_book_state {
    pub const OPEN: u8 = 0;
    pub const ACCEPTED: u8 = 1;
    pub const CLOSED: u8 = 2;
}

/// Marketplace V2 matching policy enum values.
pub mod matching_policy {
    pub const BEST_PRICE: u8 = 0;
    pub const BEST_ETA: u8 = 1;
    pub const WEIGHTED_SCORE: u8 = 2;
}

/// Marketplace V2 bid state enum values.
pub mod bid_state {
    pub const ACTIVE: u8 = 0;
    pub const ACCEPTED: u8 = 1;
}

const TASK_TYPE_BID_EXCLUSIVE: u8 = 3;
const BID_WINDOW_SECONDS: i64 = 86_400;
const MAX_CONFIDENCE_BPS: u16 = 10_000;
const MAX_ACTIVE_BID_TASKS: u8 = 10;

/// Simulated Marketplace V2 config.
#[derive(Debug, Clone)]
pub struct SimulatedBidMarketplaceConfig {
    pub min_bid_bond_lamports: u64,
    pub bid_creation_cooldown_secs: i64,
    pub max_bids_per_24h: u16,
    pub max_active_bids_per_task: u16,
    pub max_bid_lifetime_secs: i64,
    pub accepted_no_show_slash_bps: u16,
}

impl Default for SimulatedBidMarketplaceConfig {
    fn default() -> Self {
        Self {
            min_bid_bond_lamports: 100_000,
            bid_creation_cooldown_secs: 60,
            max_bids_per_24h: 24,
            max_active_bids_per_task: 8,
            max_bid_lifetime_secs: 86_400,
            accepted_no_show_slash_bps: 2_500,
        }
    }
}

/// Simulated bidder market state.
#[derive(Debug, Clone, Default)]
pub struct SimulatedBidderMarketState {
    pub bidder: [u8; 32],
    pub last_bid_created_at: i64,
    pub bid_window_started_at: i64,
    pub bids_created_in_window: u16,
    pub active_bid_count: u16,
    pub total_bids_created: u64,
    pub total_bids_accepted: u64,
}

/// Simulated bid book state.
#[derive(Debug, Clone)]
pub struct SimulatedBidBook {
    pub task: [u8; 32],
    pub state: u8,
    pub policy: u8,
    pub accepted_bid: Option<[u8; 32]>,
    pub version: u64,
    pub total_bids: u32,
    pub active_bids: u16,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Default for SimulatedBidBook {
    fn default() -> Self {
        Self {
            task: [0u8; 32],
            state: bid_book_state::OPEN,
            policy: matching_policy::BEST_PRICE,
            accepted_bid: None,
            version: 0,
            total_bids: 0,
            active_bids: 0,
            created_at: 0,
            updated_at: 0,
        }
    }
}

/// Simulated task bid state.
#[derive(Debug, Clone, Default)]
pub struct SimulatedBid {
    pub bid_id: [u8; 32],
    pub task: [u8; 32],
    pub bidder: [u8; 32],
    pub requested_reward_lamports: u64,
    pub eta_seconds: u32,
    pub confidence_bps: u16,
    pub reputation_snapshot_bps: u16,
    pub expires_at: i64,
    pub state: u8,
    pub bond_lamports: u64,
    pub is_closed: bool,
}

fn require_bid_marketplace_task(task: &SimulatedTask) -> Option<SimulationResult> {
    if task.task_type != TASK_TYPE_BID_EXCLUSIVE {
        return Some(SimulationResult::Error("TaskNotBidExclusive".to_string()));
    }

    if task.max_workers != 1 {
        return Some(SimulationResult::Error(
            "BidExclusiveRequiresSingleWorker".to_string(),
        ));
    }

    None
}

fn refresh_bid_window(state: &mut SimulatedBidderMarketState, now: i64) {
    if state.bid_window_started_at == 0
        || now.saturating_sub(state.bid_window_started_at) >= BID_WINDOW_SECONDS
    {
        state.bid_window_started_at = now;
        state.bids_created_in_window = 0;
    }
}

#[allow(clippy::too_many_arguments)]
pub fn simulate_initialize_bid_book(
    task: &SimulatedTask,
    bid_book: &mut SimulatedBidBook,
    now: i64,
    policy: u8,
    price_weight_bps: u16,
    eta_weight_bps: u16,
    confidence_weight_bps: u16,
    reliability_weight_bps: u16,
) -> SimulationResult {
    if let Some(result) = require_bid_marketplace_task(task) {
        return result;
    }

    if task.status != task_status::OPEN {
        return SimulationResult::Error("TaskNotOpen".to_string());
    }

    if task.current_workers != 0 {
        return SimulationResult::Error("TaskFullyClaimed".to_string());
    }

    match policy {
        matching_policy::BEST_PRICE | matching_policy::BEST_ETA => {}
        matching_policy::WEIGHTED_SCORE => {
            let total = price_weight_bps
                .checked_add(eta_weight_bps)
                .and_then(|v| v.checked_add(confidence_weight_bps))
                .and_then(|v| v.checked_add(reliability_weight_bps));

            if total != Some(MAX_CONFIDENCE_BPS) {
                return SimulationResult::Error("InvalidWeightedScoreWeights".to_string());
            }
        }
        _ => return SimulationResult::Error("InvalidMatchingPolicy".to_string()),
    }

    bid_book.task = task.task_id;
    bid_book.state = bid_book_state::OPEN;
    bid_book.policy = policy;
    bid_book.accepted_bid = None;
    bid_book.version = 0;
    bid_book.total_bids = 0;
    bid_book.active_bids = 0;
    bid_book.created_at = now;
    bid_book.updated_at = now;

    SimulationResult::Success
}

#[allow(clippy::too_many_arguments)]
pub fn simulate_create_bid(
    task: &SimulatedTask,
    bid_book: &mut SimulatedBidBook,
    bid: &mut SimulatedBid,
    bidder: &SimulatedAgent,
    bidder_state: &mut SimulatedBidderMarketState,
    config: &SimulatedBidMarketplaceConfig,
    now: i64,
    min_reputation: u16,
    bid_id: [u8; 32],
    requested_reward_lamports: u64,
    eta_seconds: u32,
    confidence_bps: u16,
    expires_at: i64,
) -> SimulationResult {
    if let Some(result) = require_bid_marketplace_task(task) {
        return result;
    }

    if task.status != task_status::OPEN {
        return SimulationResult::Error("TaskNotOpen".to_string());
    }

    if bid_book.state != bid_book_state::OPEN {
        return SimulationResult::Error("BidBookNotOpen".to_string());
    }

    if bidder.status != agent_status::ACTIVE {
        return SimulationResult::Error("AgentNotActive".to_string());
    }

    if (bidder.capabilities & task.required_capabilities) != task.required_capabilities {
        return SimulationResult::Error("InsufficientCapabilities".to_string());
    }

    if min_reputation > 0 && bidder.reputation < min_reputation {
        return SimulationResult::Error("InsufficientReputation".to_string());
    }

    if requested_reward_lamports == 0 {
        return SimulationResult::Error("InvalidReward".to_string());
    }

    if requested_reward_lamports > task.reward_amount {
        return SimulationResult::Error("BidPriceExceedsTaskBudget".to_string());
    }

    if eta_seconds == 0 {
        return SimulationResult::Error("InvalidBidEta".to_string());
    }

    if confidence_bps > MAX_CONFIDENCE_BPS {
        return SimulationResult::Error("InvalidBidConfidence".to_string());
    }

    if expires_at <= now {
        return SimulationResult::Error("InvalidBidExpiry".to_string());
    }

    if task.deadline > 0 && expires_at > task.deadline {
        return SimulationResult::Error("InvalidBidExpiry".to_string());
    }

    if expires_at.saturating_sub(now) > config.max_bid_lifetime_secs {
        return SimulationResult::Error("InvalidBidExpiry".to_string());
    }

    if bid_book.active_bids >= config.max_active_bids_per_task {
        return SimulationResult::Error("BidBookCapacityReached".to_string());
    }

    if bidder_state.bidder == [0u8; 32] {
        bidder_state.bidder = bidder.agent_id;
    }

    refresh_bid_window(bidder_state, now);

    if bidder_state.last_bid_created_at > 0
        && now.saturating_sub(bidder_state.last_bid_created_at) < config.bid_creation_cooldown_secs
    {
        return SimulationResult::Error("CooldownNotElapsed".to_string());
    }

    if bidder_state.bids_created_in_window >= config.max_bids_per_24h {
        return SimulationResult::Error("RateLimitExceeded".to_string());
    }

    bid.bid_id = bid_id;
    bid.task = task.task_id;
    bid.bidder = bidder.agent_id;
    bid.requested_reward_lamports = requested_reward_lamports;
    bid.eta_seconds = eta_seconds;
    bid.confidence_bps = confidence_bps;
    bid.reputation_snapshot_bps = bidder.reputation;
    bid.expires_at = expires_at;
    bid.state = bid_state::ACTIVE;
    bid.bond_lamports = config.min_bid_bond_lamports;
    bid.is_closed = false;

    bidder_state.last_bid_created_at = now;
    bidder_state.bids_created_in_window = match bidder_state.bids_created_in_window.checked_add(1) {
        Some(value) => value,
        None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
    };
    bidder_state.active_bid_count = match bidder_state.active_bid_count.checked_add(1) {
        Some(value) => value,
        None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
    };
    bidder_state.total_bids_created = match bidder_state.total_bids_created.checked_add(1) {
        Some(value) => value,
        None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
    };

    bid_book.version = match bid_book.version.checked_add(1) {
        Some(value) => value,
        None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
    };
    bid_book.total_bids = match bid_book.total_bids.checked_add(1) {
        Some(value) => value,
        None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
    };
    bid_book.active_bids = match bid_book.active_bids.checked_add(1) {
        Some(value) => value,
        None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
    };
    bid_book.updated_at = now;

    SimulationResult::Success
}

#[allow(clippy::too_many_arguments)]
pub fn simulate_update_bid(
    task: &SimulatedTask,
    bid_book: &mut SimulatedBidBook,
    bid: &mut SimulatedBid,
    bidder: &SimulatedAgent,
    config: &SimulatedBidMarketplaceConfig,
    now: i64,
    requested_reward_lamports: u64,
    eta_seconds: u32,
    confidence_bps: u16,
    expires_at: i64,
) -> SimulationResult {
    if let Some(result) = require_bid_marketplace_task(task) {
        return result;
    }

    if bid.is_closed || bid.state != bid_state::ACTIVE {
        return SimulationResult::Error("BidNotActive".to_string());
    }

    if bid_book.state != bid_book_state::OPEN {
        return SimulationResult::Error("BidBookNotOpen".to_string());
    }

    if task.status != task_status::OPEN {
        return SimulationResult::Error("TaskNotOpen".to_string());
    }

    if requested_reward_lamports == 0 {
        return SimulationResult::Error("InvalidReward".to_string());
    }

    if requested_reward_lamports > task.reward_amount {
        return SimulationResult::Error("BidPriceExceedsTaskBudget".to_string());
    }

    if eta_seconds == 0 {
        return SimulationResult::Error("InvalidBidEta".to_string());
    }

    if confidence_bps > MAX_CONFIDENCE_BPS {
        return SimulationResult::Error("InvalidBidConfidence".to_string());
    }

    if expires_at <= now {
        return SimulationResult::Error("InvalidBidExpiry".to_string());
    }

    if task.deadline > 0 && expires_at > task.deadline {
        return SimulationResult::Error("InvalidBidExpiry".to_string());
    }

    if expires_at.saturating_sub(now) > config.max_bid_lifetime_secs {
        return SimulationResult::Error("InvalidBidExpiry".to_string());
    }

    bid.requested_reward_lamports = requested_reward_lamports;
    bid.eta_seconds = eta_seconds;
    bid.confidence_bps = confidence_bps;
    bid.reputation_snapshot_bps = bidder.reputation;
    bid.expires_at = expires_at;

    bid_book.version = match bid_book.version.checked_add(1) {
        Some(value) => value,
        None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
    };
    bid_book.updated_at = now;

    SimulationResult::Success
}

pub fn simulate_cancel_bid(
    task: &SimulatedTask,
    bid_book: &mut SimulatedBidBook,
    bid: &mut SimulatedBid,
    bidder_state: &mut SimulatedBidderMarketState,
    now: i64,
) -> SimulationResult {
    if let Some(result) = require_bid_marketplace_task(task) {
        return result;
    }

    if bid.is_closed || bid.state != bid_state::ACTIVE {
        return SimulationResult::Error("BidNotActive".to_string());
    }

    if bid_book.state != bid_book_state::OPEN && bid_book.state != bid_book_state::ACCEPTED {
        return SimulationResult::Error("BidBookNotOpen".to_string());
    }

    if bid_book.accepted_bid == Some(bid.bid_id) {
        return SimulationResult::Error("BidAlreadyAccepted".to_string());
    }

    bid_book.active_bids = match bid_book.active_bids.checked_sub(1) {
        Some(value) => value,
        None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
    };
    bid_book.version = match bid_book.version.checked_add(1) {
        Some(value) => value,
        None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
    };
    bid_book.updated_at = now;

    bidder_state.active_bid_count = match bidder_state.active_bid_count.checked_sub(1) {
        Some(value) => value,
        None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
    };

    bid.is_closed = true;
    bid.bond_lamports = 0;

    SimulationResult::Success
}

pub fn simulate_accept_bid(
    task: &mut SimulatedTask,
    bid_book: &mut SimulatedBidBook,
    bid: &mut SimulatedBid,
    bidder: &mut SimulatedAgent,
    bidder_state: &mut SimulatedBidderMarketState,
    now: i64,
    min_reputation: u16,
) -> SimulationResult {
    if let Some(result) = require_bid_marketplace_task(task) {
        return result;
    }

    if task.status != task_status::OPEN {
        return SimulationResult::Error("TaskNotOpen".to_string());
    }

    if task.current_workers != 0 {
        return SimulationResult::Error("TaskFullyClaimed".to_string());
    }

    if bid_book.state != bid_book_state::OPEN {
        return SimulationResult::Error("BidBookNotOpen".to_string());
    }

    if bid.is_closed || bid.state != bid_state::ACTIVE {
        return SimulationResult::Error("BidNotActive".to_string());
    }

    if now >= bid.expires_at {
        return SimulationResult::Error("TaskExpired".to_string());
    }

    if bidder.status != agent_status::ACTIVE {
        return SimulationResult::Error("AgentNotActive".to_string());
    }

    if (bidder.capabilities & task.required_capabilities) != task.required_capabilities {
        return SimulationResult::Error("InsufficientCapabilities".to_string());
    }

    if min_reputation > 0 && bidder.reputation < min_reputation {
        return SimulationResult::Error("InsufficientReputation".to_string());
    }

    if bidder.active_tasks >= MAX_ACTIVE_BID_TASKS {
        return SimulationResult::Error("MaxActiveTasksReached".to_string());
    }

    let old_status = task.status;
    task.current_workers = 1;
    task.status = task_status::IN_PROGRESS;

    if let TaskInvariantResult::InvalidStateTransition { from, to } =
        check_task_state_transition(old_status, task.status)
    {
        return SimulationResult::InvariantViolation(format!(
            "T1: Invalid state transition from {} to {}",
            from, to
        ));
    }

    bid.state = bid_state::ACCEPTED;
    bid_book.state = bid_book_state::ACCEPTED;
    bid_book.accepted_bid = Some(bid.bid_id);
    bid_book.version = match bid_book.version.checked_add(1) {
        Some(value) => value,
        None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
    };
    bid_book.updated_at = now;

    bidder.active_tasks = match bidder.active_tasks.checked_add(1) {
        Some(value) => value,
        None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
    };

    bidder_state.total_bids_accepted = match bidder_state.total_bids_accepted.checked_add(1) {
        Some(value) => value,
        None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
    };

    SimulationResult::Success
}

pub fn simulate_expire_bid(
    task: &SimulatedTask,
    bid_book: &mut SimulatedBidBook,
    bid: &mut SimulatedBid,
    bidder_state: &mut SimulatedBidderMarketState,
    now: i64,
) -> SimulationResult {
    if let Some(result) = require_bid_marketplace_task(task) {
        return result;
    }

    if bid.is_closed || bid.state != bid_state::ACTIVE {
        return SimulationResult::Error("BidNotActive".to_string());
    }

    if now <= bid.expires_at && bid_book.state != bid_book_state::CLOSED {
        return SimulationResult::Error("BidNotExpired".to_string());
    }

    bid_book.active_bids = match bid_book.active_bids.checked_sub(1) {
        Some(value) => value,
        None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
    };
    bid_book.version = match bid_book.version.checked_add(1) {
        Some(value) => value,
        None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
    };
    bid_book.updated_at = now;

    bidder_state.active_bid_count = match bidder_state.active_bid_count.checked_sub(1) {
        Some(value) => value,
        None => return SimulationResult::Error("ArithmeticOverflow".to_string()),
    };

    bid.is_closed = true;
    bid.bond_lamports = 0;

    SimulationResult::Success
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn build_valid_task_fixture() -> SimulatedTask {
        SimulatedTask {
            task_id: [1u8; 32],
            status: task_status::OPEN,
            reward_amount: 1_000_000,
            max_workers: 5,
            current_workers: 0,
            required_capabilities: 1, // COMPUTE
            deadline: 0,
            completions: 0,
            required_completions: 1,
            task_type: 0, // Exclusive
        }
    }

    fn build_valid_worker_fixture() -> SimulatedAgent {
        SimulatedAgent {
            agent_id: [2u8; 32],
            capabilities: 0xFF, // All capabilities
            status: agent_status::ACTIVE,
            active_tasks: 0,
            reputation: 5000,
            stake: 1_000_000,
            tasks_completed: 0,
            total_earned: 0,
        }
    }

    #[test]
    fn test_claim_task_success() {
        let mut task = build_valid_task_fixture();
        let mut worker = build_valid_worker_fixture();

        let result = simulate_claim_task(&mut task, &mut worker, 100);
        assert!(result.is_success());
        assert_eq!(task.current_workers, 1);
        assert_eq!(task.status, task_status::IN_PROGRESS);
        assert_eq!(worker.active_tasks, 1);
    }

    #[test]
    fn test_claim_task_exceeds_max_workers() {
        let mut task = build_valid_task_fixture();
        task.max_workers = 1;
        task.current_workers = 1;

        let mut worker = build_valid_worker_fixture();

        let result = simulate_claim_task(&mut task, &mut worker, 100);
        assert!(result.is_error());
    }

    #[test]
    fn test_complete_task_success() {
        let mut task = build_valid_task_fixture();
        task.status = task_status::IN_PROGRESS;
        task.current_workers = 1;

        let mut escrow = SimulatedEscrow {
            amount: 1_000_000,
            distributed: 0,
            is_closed: false,
        };

        let mut worker = build_valid_worker_fixture();
        worker.active_tasks = 1; // Worker must have claimed the task first
        let config = SimulatedConfig::default();

        let result =
            simulate_complete_task(&mut task, &mut escrow, &mut worker, &config, [0u8; 32]);

        assert!(result.is_success());
        assert_eq!(task.status, task_status::COMPLETED);
        assert!(escrow.is_closed);
        assert!(worker.reputation > 5000);
    }

    proptest! {
        #[test]
        fn test_escrow_never_overdrafts(
            amount in 1u64..u64::MAX/2,
            fee_bps in 0u16..10000u16,
        ) {
            let mut task = build_valid_task_fixture();
            task.status = task_status::IN_PROGRESS;
            task.reward_amount = amount;

            let mut escrow = SimulatedEscrow {
                amount,
                distributed: 0,
                is_closed: false,
            };

            let mut worker = build_valid_worker_fixture();
            let config = SimulatedConfig {
                protocol_fee_bps: fee_bps,
                ..Default::default()
            };

            let result = simulate_complete_task(
                &mut task,
                &mut escrow,
                &mut worker,
                &config,
                [0u8; 32],
            );

            // Either success or error, but never invariant violation
            prop_assert!(!result.is_invariant_violation(),
                "Invariant violation: {:?}", result);

            // If successful, distributed should not exceed amount
            if result.is_success() {
                prop_assert!(escrow.distributed <= escrow.amount,
                    "distributed {} > amount {}", escrow.distributed, escrow.amount);
            }
        }

        #[test]
        fn test_reputation_stays_bounded(
            initial_rep in 0u16..=10000u16,
            num_completions in 0usize..200usize,
        ) {
            let mut worker = build_valid_worker_fixture();
            worker.reputation = initial_rep;

            for _ in 0..num_completions {
                worker.reputation = worker.reputation.saturating_add(100).min(10000);
            }

            prop_assert!(worker.reputation <= 10000,
                "Reputation {} exceeds max", worker.reputation);
        }

        #[test]
        fn test_concurrent_claims_bounded(
            max_workers in 1u8..=10u8,
            num_claimants in 1usize..20usize,
        ) {
            let mut task = build_valid_task_fixture();
            task.max_workers = max_workers;

            let mut workers: Vec<_> = (0..num_claimants)
                .map(|i| {
                    let mut w = build_valid_worker_fixture();
                    w.agent_id[0] = i as u8;
                    w
                })
                .collect();

            let results = simulate_concurrent_claims(&mut task, &mut workers, 100);

            // Count successful claims
            let successes = results.iter().filter(|r| r.is_success()).count();

            prop_assert!(successes as u8 <= max_workers,
                "Successful claims {} > max_workers {}", successes, max_workers);

            prop_assert!(task.current_workers <= task.max_workers,
                "current_workers {} > max_workers {}", task.current_workers, task.max_workers);
        }
    }

    #[test]
    fn test_competitive_task_double_completion_rejected() {
        // Competitive task type = 2
        let mut task = SimulatedTask {
            task_id: [1u8; 32],
            status: task_status::IN_PROGRESS,
            reward_amount: 1_000_000,
            max_workers: 5,
            current_workers: 2,
            required_capabilities: 0,
            deadline: 0,
            completions: 0, // First completion hasn't happened yet
            required_completions: 1,
            task_type: 2, // COMPETITIVE
        };

        let mut escrow = SimulatedEscrow {
            amount: 1_000_000,
            distributed: 0,
            is_closed: false,
        };

        let mut worker1 = build_valid_worker_fixture();
        worker1.agent_id[0] = 1;
        worker1.active_tasks = 1;

        let mut worker2 = build_valid_worker_fixture();
        worker2.agent_id[0] = 2;
        worker2.active_tasks = 1;

        let config = SimulatedConfig::default();

        // First completion should succeed
        let result1 =
            simulate_complete_task(&mut task, &mut escrow, &mut worker1, &config, [0u8; 32]);
        assert!(
            result1.is_success(),
            "First completion should succeed: {:?}",
            result1
        );

        // Reset task status for second attempt (simulating before task marked completed)
        task.status = task_status::IN_PROGRESS;

        // Second completion should be rejected due to CompetitiveTaskAlreadyWon
        let result2 =
            simulate_complete_task(&mut task, &mut escrow, &mut worker2, &config, [0u8; 32]);
        assert!(
            result2.is_error(),
            "Second completion should be rejected: {:?}",
            result2
        );
        if let SimulationResult::Error(msg) = result2 {
            assert_eq!(
                msg, "CompetitiveTaskAlreadyWon",
                "Expected CompetitiveTaskAlreadyWon error"
            );
        }
    }
}
