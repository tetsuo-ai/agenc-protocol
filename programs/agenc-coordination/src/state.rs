//! Account state structures for the AgenC Coordination Protocol

use crate::instructions::constants::{
    DEFAULT_DISPUTE_INITIATION_COOLDOWN, DEFAULT_MAX_DISPUTES_PER_24H, DEFAULT_MAX_TASKS_PER_24H,
    DEFAULT_TASK_CREATION_COOLDOWN,
};
use anchor_lang::prelude::*;

// ============================================================================
// Size Constants
// ============================================================================

/// Size of cryptographic hashes and IDs (SHA256, Pubkey bytes)
pub const HASH_SIZE: usize = 32;

/// Size of result/description/value data fields
pub const RESULT_DATA_SIZE: usize = 64;

/// Reserved sentinel stored in `Task.constraint_hash` to indicate that the task
/// uses the Task Validation V2 review / attestation flow rather than immediate payout.
pub const MANUAL_VALIDATION_SENTINEL: [u8; HASH_SIZE] = *b"agenc-manual-validation-v2-seed!";

/// Agent capability flags (bitmask).
///
/// Capabilities are represented as a 64-bit bitmask where each bit indicates
/// a specific capability the agent possesses. Tasks specify required capabilities
/// and only agents with matching capabilities can claim them.
///
/// # Currently Defined Bits (10 of 64)
///
/// | Bit | Constant      | Description                                      |
/// |-----|---------------|--------------------------------------------------|
/// |  0  | `COMPUTE`     | General computation tasks                        |
/// |  1  | `INFERENCE`   | Machine learning inference                       |
/// |  2  | `STORAGE`     | Data storage and retrieval                       |
/// |  3  | `NETWORK`     | Network relay and communication                  |
/// |  4  | `SENSOR`      | Sensor data collection (IoT, monitoring)         |
/// |  5  | `ACTUATOR`    | Physical actuation (robotics, hardware control)  |
/// |  6  | `COORDINATOR` | Task coordination and orchestration              |
/// |  7  | `ARBITER`     | DEPRECATED (P6.3): arbiter voting retired        |
/// |  8  | `VALIDATOR`   | Result validation and verification               |
/// |  9  | `AGGREGATOR`  | Data aggregation and summarization               |
///
/// # Reserved Bits
///
/// Bits 10-63 are reserved for future protocol extensions.
///
pub mod capability {
    /// General computation tasks
    pub const COMPUTE: u64 = 1 << 0;
    /// Machine learning inference
    pub const INFERENCE: u64 = 1 << 1;
    /// Data storage and retrieval
    pub const STORAGE: u64 = 1 << 2;
    /// Network relay and communication
    pub const NETWORK: u64 = 1 << 3;
    /// Sensor data collection (IoT, monitoring)
    pub const SENSOR: u64 = 1 << 4;
    /// Physical actuation (robotics, hardware control)
    pub const ACTUATOR: u64 = 1 << 5;
    /// Task coordination and orchestration
    pub const COORDINATOR: u64 = 1 << 6;
    /// DEPRECATED (P6.3): formerly granted dispute-voting rights. The arbiter
    /// vote/quorum model is retired (disputes are decided by an assigned resolver);
    /// this capability bit is no longer checked by any instruction. Kept for the stable
    /// capability bit layout.
    pub const ARBITER: u64 = 1 << 7;
    /// Result validation and verification
    pub const VALIDATOR: u64 = 1 << 8;
    /// Data aggregation and summarization
    pub const AGGREGATOR: u64 = 1 << 9;

    /// Bitmask covering all currently defined capabilities (bits 0-9)
    pub const ALL_DEFINED: u64 = 0x03ff;
}

/// Agent status
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, InitSpace)]
#[repr(u8)]
pub enum AgentStatus {
    #[default]
    Inactive = 0,
    Active = 1,
    Busy = 2,
    Suspended = 3,
}

/// Task status
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, InitSpace)]
#[repr(u8)]
pub enum TaskStatus {
    #[default]
    Open = 0,
    InProgress = 1,
    PendingValidation = 2,
    Completed = 3,
    Cancelled = 4,
    Disputed = 5,
    /// Batch 3 §8: a terminally-rejected submission frozen for review. Non-terminal —
    /// exits via resolve_reject_frozen (multisig) or expire_reject_frozen (timeout).
    /// Highest discriminant keeps 0-5 stable for the 149 live tasks (no layout change).
    RejectFrozen = 6,
}

impl TaskStatus {
    /// Validates whether a status transition is allowed.
    ///
    /// Valid transitions:
    /// - Open → InProgress (when task is claimed)
    /// - Open → Disputed (post-submission dispute after slot release)
    /// - Open → Cancelled (when task is cancelled before any claims)
    /// - InProgress → Completed (when task is completed)
    /// - InProgress → Cancelled (when task is cancelled after deadline with no completions)
    /// - InProgress → Disputed (when a dispute is initiated)
    /// - InProgress → PendingValidation (manual validation flow)
    /// - PendingValidation → PendingValidation (additional submissions while review is active)
    /// - PendingValidation → InProgress (pending submissions resolved, active claims remain)
    /// - PendingValidation → Open (pending submissions resolved, task needs new claims)
    /// - PendingValidation → Completed (after validation passes)
    /// - PendingValidation → Disputed (when validation is contested)
    /// - Disputed → Completed (dispute resolved in favor of completion)
    /// - Disputed → Cancelled (dispute resolved with refund/split, or expired)
    ///
    /// Terminal states (Completed, Cancelled) cannot transition to any other state.
    pub fn can_transition_to(&self, new_status: TaskStatus) -> bool {
        use TaskStatus::*;
        matches!(
            (self, new_status),
            // From Open
            (Open, InProgress) | (Open, Cancelled) | (Open, Disputed) |
            // From InProgress (InProgress -> InProgress for additional claims on collaborative tasks)
            (InProgress, InProgress) | (InProgress, Completed) | (InProgress, Cancelled) |
            (InProgress, Disputed) | (InProgress, PendingValidation) |
            // From PendingValidation
            (PendingValidation, PendingValidation) | (PendingValidation, InProgress) |
            (PendingValidation, Open) | (PendingValidation, Completed) |
            (PendingValidation, Disputed) |
            // From Disputed
            (Disputed, Completed) | (Disputed, Cancelled) |
            // From PendingValidation -> RejectFrozen (terminal reject freezes for review)
            (PendingValidation, RejectFrozen) |
            // From RejectFrozen (resolved/expired review)
            (RejectFrozen, Completed) | (RejectFrozen, Cancelled)
        )
    }
}

/// Task type enumeration
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, InitSpace)]
#[repr(u8)]
pub enum TaskType {
    /// Exclusive - only one worker can claim
    #[default]
    Exclusive = 0,
    /// Collaborative - multiple workers share the task
    Collaborative = 1,
    /// Competitive - multiple workers race; first to complete wins.
    /// Race condition handling: Claims are first-come-first-served.
    /// Only the first valid completion receives the reward.
    Competitive = 2,
    /// Bid-market exclusive task. Direct `claim_task` is disallowed; the creator
    /// must explicitly accept a bid before a normal `TaskClaim` is created.
    BidExclusive = 3,
}

/// Validation mode configured for a task.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, InitSpace)]
#[repr(u8)]
pub enum ValidationMode {
    /// Existing behavior: workers complete tasks and are paid immediately.
    #[default]
    Auto = 0,
    /// Worker submissions require explicit creator review before settlement.
    CreatorReview = 1,
    /// Validators vote on a submission before settlement.
    ValidatorQuorum = 2,
    /// A configured external attestor approves or rejects the submission.
    ExternalAttestation = 3,
}

/// Task submission lifecycle for manual validation.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, InitSpace)]
#[repr(u8)]
pub enum SubmissionStatus {
    /// Account is initialized but has no active submission yet.
    #[default]
    Idle = 0,
    /// Awaiting creator review.
    Submitted = 1,
    /// Accepted and settled.
    Accepted = 2,
    /// Rejected and may be resubmitted.
    Rejected = 3,
}

/// Bid book state for Marketplace V2.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, InitSpace)]
#[repr(u8)]
pub enum BidBookState {
    #[default]
    Open = 0,
    Accepted = 1,
    Closed = 2,
}

/// Matching policy declared on a bid book.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, InitSpace)]
#[repr(u8)]
pub enum MatchingPolicy {
    #[default]
    BestPrice = 0,
    BestEta = 1,
    WeightedScore = 2,
}

/// Bid lifecycle state.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, InitSpace)]
#[repr(u8)]
pub enum TaskBidState {
    #[default]
    Active = 0,
    Accepted = 1,
}

/// Weight configuration used when a bid book declares `WeightedScore`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, InitSpace)]
pub struct WeightedScoreWeights {
    pub price_weight_bps: u16,
    pub eta_weight_bps: u16,
    pub confidence_weight_bps: u16,
    pub reliability_weight_bps: u16,
}

/// Task dependency type for speculative execution decisions
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, InitSpace)]
#[repr(u8)]
pub enum DependencyType {
    /// No dependency - task can execute independently.
    /// This is the default (0) and matches the default field initialization.
    #[default]
    None = 0,
    /// Data dependency - needs parent output data (speculatable)
    Data = 1,
    /// Ordering dependency - must run after parent (speculatable)
    Ordering = 2,
    /// Proof dependency - requires parent task's on-chain completion proof (NOT speculatable)
    Proof = 3,
}

/// Dispute resolution type
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, InitSpace)]
#[repr(u8)]
pub enum ResolutionType {
    #[default]
    Refund = 0, // Full refund to task creator
    Complete = 1, // Mark task as complete, pay worker
    Split = 2,    // Split reward between parties
}

/// Dispute status
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, InitSpace)]
#[repr(u8)]
pub enum DisputeStatus {
    #[default]
    Active = 0,
    Resolved = 1,
    Expired = 2,
    Cancelled = 3,
}

/// Reason for slashing an agent's stake
///
/// These correspond to verification failures where slashing applies as a penalty
/// for submitting invalid or incomplete work.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum SlashReason {
    /// Proof verification failed (cryptographic proof invalid)
    ProofFailed = 0,
    /// Proof was not submitted within the required timeframe
    ProofTimeout = 1,
    /// Result data failed validation checks
    InvalidResult = 2,
}

/// Current protocol version
pub const CURRENT_PROTOCOL_VERSION: u8 = 1;

/// Minimum supported protocol version for backward compatibility
pub const MIN_SUPPORTED_VERSION: u8 = 1;

/// Protocol configuration account
/// PDA seeds: ["protocol"]
#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    /// Protocol authority
    /// Note: Cannot be updated after initialization.
    pub authority: Pubkey,
    /// Treasury address for protocol fees
    /// Can be updated via multisig-gated `update_treasury`.
    pub treasury: Pubkey,
    /// Minimum votes needed to resolve dispute (percentage, 1-100)
    pub dispute_threshold: u8,
    /// Protocol fee in basis points (1/100th of a percent)
    pub protocol_fee_bps: u16,
    /// Minimum stake required to register as arbiter
    pub min_arbiter_stake: u64,
    /// Minimum stake required to register as agent
    pub min_agent_stake: u64,
    /// Max duration (seconds) a claim can stay active without completion
    pub max_claim_duration: i64,
    /// Max duration (seconds) a dispute can remain active
    pub max_dispute_duration: i64,
    /// Total registered agents
    pub total_agents: u64,
    /// Total tasks created
    pub total_tasks: u64,
    /// Total tasks completed
    pub completed_tasks: u64,
    /// Total value distributed
    pub total_value_distributed: u64,
    /// Bump seed for PDA
    pub bump: u8,
    /// Multisig threshold
    pub multisig_threshold: u8,
    /// Length of configured multisig owners
    pub multisig_owners_len: u8,
    // === Rate limiting configuration ===
    /// Minimum cooldown between task creations per authority wallet (seconds, 0 = disabled)
    pub task_creation_cooldown: i64,
    /// Maximum tasks an authority wallet can create per 24h window (0 = unlimited)
    pub max_tasks_per_24h: u8,
    /// Minimum cooldown between dispute initiations per authority wallet (seconds, 0 = disabled)
    pub dispute_initiation_cooldown: i64,
    /// Maximum disputes an authority wallet can initiate per 24h window (0 = unlimited)
    pub max_disputes_per_24h: u8,
    /// Minimum stake required to initiate a dispute (griefing resistance)
    pub min_stake_for_dispute: u64,
    /// Percentage of stake slashed on losing dispute (0-100)
    pub slash_percentage: u8,
    /// Cooldown between state updates per agent (seconds, 0 = disabled) (fix #415)
    pub state_update_cooldown: i64,
    /// Voting period for disputes in seconds (default: 24 hours)
    pub voting_period: i64,
    // === Versioning fields ===
    /// Current protocol version (for upgrades)
    pub protocol_version: u8,
    /// Minimum supported version for backward compatibility
    pub min_supported_version: u8,
    /// Emergency global pause. When true, version-gated mutable protocol paths fail closed.
    pub protocol_paused: bool,
    /// Bitmask of disabled task types. Bit index matches `TaskType` repr.
    pub disabled_task_type_mask: u8,
    /// Multisig owners for admin-gated protocol changes.
    ///
    /// Updated via multisig-gated `update_multisig` with strict validation:
    /// - owner keys must be unique and non-default
    /// - threshold must satisfy 0 < threshold < owners_len
    /// - update tx must include threshold signers from the new owner set
    ///
    /// Only the first `multisig_owners_len` entries are valid; remaining slots
    /// are always `Pubkey::default()`.
    pub multisig_owners: [Pubkey; ProtocolConfig::MAX_MULTISIG_OWNERS],
    // === P6.5: surface-versioning contract ===
    /// Deployed instruction-surface revision stamp.
    ///
    /// APPEND-ONLY: this is the only field after `multisig_owners`, so the 349-byte
    /// pre-P6.5 prefix (the live mainnet config account) stays valid. The live
    /// account is migrated up to the new size by `migrate_protocol` (realloc +
    /// zero-init), which lands this at `0` = "surface not yet stamped". An operator
    /// then sets the real revision via `update_launch_controls` (the existing
    /// multisig-gated config-update authority path).
    ///
    /// Semantics:
    /// - `0`  → surface unstamped (treat as the conservative canary surface;
    ///          clients should fall back to capability probing).
    /// - `>0` → the operator-declared surface revision; the SDK maps it to a typed
    ///          capability set (`SURFACE_REVISION_FULL` = the full 80-ix surface).
    pub surface_revision: u16,
}

impl Default for ProtocolConfig {
    fn default() -> Self {
        Self {
            authority: Pubkey::default(),
            treasury: Pubkey::default(),
            dispute_threshold: 50,
            protocol_fee_bps: 100,
            min_arbiter_stake: 0,
            // P6.7 sybil deterrent: a fresh protocol init requires a nonzero, slashable
            // stake per agent identity so a sybil identity COSTS money (the primary
            // deterrent; the probationary reputation start is the secondary one). This is
            // exactly the 0.001 SOL floor (`MIN_REASONABLE_STAKE`) that
            // `initialize_protocol` already enforces (`min_stake >= MIN_REASONABLE_STAKE`),
            // so a fresh init can never go below it anyway — the default now matches.
            // NOTE: this only affects FRESH initialize_protocol (devnet/localnet/new
            // deploys); the already-initialized live mainnet config is unaffected. Raising
            // mainnet's min_agent_stake is a [HUMAN] deploy-time config update — and see
            // P6.7 in PLAN.md: there is currently NO config-update instruction that mutates
            // min_agent_stake (only initialize_protocol sets it).
            min_agent_stake: 1_000_000,
            max_claim_duration: ProtocolConfig::DEFAULT_MAX_CLAIM_DURATION,
            max_dispute_duration: ProtocolConfig::DEFAULT_MAX_DISPUTE_DURATION,
            total_agents: 0,
            total_tasks: 0,
            completed_tasks: 0,
            total_value_distributed: 0,
            bump: 0,
            multisig_threshold: 0,
            multisig_owners_len: 0,
            // Default rate limits (can be configured post-deployment)
            task_creation_cooldown: DEFAULT_TASK_CREATION_COOLDOWN,
            max_tasks_per_24h: DEFAULT_MAX_TASKS_PER_24H,
            dispute_initiation_cooldown: DEFAULT_DISPUTE_INITIATION_COOLDOWN,
            max_disputes_per_24h: DEFAULT_MAX_DISPUTES_PER_24H,
            min_stake_for_dispute: 100_000_000, // 0.1 SOL default for anti-griefing
            slash_percentage: ProtocolConfig::DEFAULT_SLASH_PERCENTAGE,
            state_update_cooldown: 60, // 60 seconds between state updates (fix #415)
            voting_period: ProtocolConfig::DEFAULT_VOTING_PERIOD,
            // Versioning
            protocol_version: CURRENT_PROTOCOL_VERSION,
            min_supported_version: MIN_SUPPORTED_VERSION,
            protocol_paused: false,
            disabled_task_type_mask: 0,
            multisig_owners: [Pubkey::default(); ProtocolConfig::MAX_MULTISIG_OWNERS],
            // P6.5: a freshly initialized config has the full surface available
            // (init only runs on dev/devnet/localnet — the mainnet canary config
            // already exists and is brought forward by migrate_protocol). Stamp it
            // to the full-surface revision so a fresh full-surface deploy advertises
            // `listings: true` without a manual stamp.
            surface_revision: ProtocolConfig::SURFACE_REVISION_FULL,
        }
    }
}

#[cfg(feature = "validation-timings")]
const PROTOCOL_DEFAULT_MAX_CLAIM_DURATION: i64 = 300; // 5 minutes
#[cfg(not(feature = "validation-timings"))]
const PROTOCOL_DEFAULT_MAX_CLAIM_DURATION: i64 = 604_800; // 7 days

#[cfg(feature = "validation-timings")]
const PROTOCOL_DEFAULT_MAX_DISPUTE_DURATION: i64 = 600; // 10 minutes
#[cfg(not(feature = "validation-timings"))]
const PROTOCOL_DEFAULT_MAX_DISPUTE_DURATION: i64 = 604_800; // 7 days

#[cfg(feature = "validation-timings")]
const PROTOCOL_DEFAULT_VOTING_PERIOD: i64 = 300; // 5 minutes
#[cfg(not(feature = "validation-timings"))]
const PROTOCOL_DEFAULT_VOTING_PERIOD: i64 = 86_400; // 24 hours

impl ProtocolConfig {
    pub const MAX_MULTISIG_OWNERS: usize = 5;
    pub const TASK_TYPE_DISABLE_MASK: u8 = 0b0000_1111;
    pub const DEFAULT_MAX_CLAIM_DURATION: i64 = PROTOCOL_DEFAULT_MAX_CLAIM_DURATION;
    pub const DEFAULT_MAX_DISPUTE_DURATION: i64 = PROTOCOL_DEFAULT_MAX_DISPUTE_DURATION;
    /// Default percentage of stake slashed for malicious behavior.
    /// Increased from 10% to 25% to provide stronger deterrence against bad actors
    /// while remaining proportionate to typical violation severity.
    pub const DEFAULT_SLASH_PERCENTAGE: u8 = 25;
    /// Default voting period for disputes.
    pub const DEFAULT_VOTING_PERIOD: i64 = PROTOCOL_DEFAULT_VOTING_PERIOD;
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8); // multisig owners

    /// On-chain byte size of the pre-P6.5 `ProtocolConfig` (8-byte discriminator +
    /// 341 INIT_SPACE = 349). The single live mainnet config account is at this
    /// size; `migrate_protocol` reallocs it up to `SIZE` and zero-inits the appended
    /// `surface_revision`. Do NOT change — it is the migration precondition.
    pub const OLD_CONFIG_SIZE: usize = 349;

    /// `surface_revision` value meaning "the full 80-instruction surface is live".
    /// An operator stamps this via `update_launch_controls` after deploying the full
    /// surface; the SDK maps it to a complete `CapabilitySet`.
    pub const SURFACE_REVISION_FULL: u16 = 1;

    /// Validates that launch control bytes do not contain unknown task-type bits.
    /// Kept under the old name so existing migration tests remain source-compatible.
    pub fn validate_padding_fields(&self) -> bool {
        self.disabled_task_type_mask & !Self::TASK_TYPE_DISABLE_MASK == 0
    }
}

/// Compile-time pin for the P6.5 surface-versioning migration: a layout drift
/// (field add/reorder changing INIT_SPACE) fails the build instead of silently
/// bricking the single-account `migrate_protocol` realloc of the live config.
const _: () = assert!(ProtocolConfig::SIZE == 351);
const _: () = assert!(ProtocolConfig::OLD_CONFIG_SIZE + 2 == ProtocolConfig::SIZE);

/// ZK verifier configuration account
/// PDA seeds: ["zk_config"]
#[account]
#[derive(InitSpace)]
pub struct ZkConfig {
    /// Active trusted RISC Zero guest image ID.
    pub active_image_id: [u8; HASH_SIZE],
    /// Bump seed for PDA.
    pub bump: u8,
    /// Reserved for future ZK config extensions.
    pub _reserved: [u8; 31],
}

impl Default for ZkConfig {
    fn default() -> Self {
        Self {
            active_image_id: [0u8; HASH_SIZE],
            bump: 0,
            _reserved: [0u8; 31],
        }
    }
}

impl ZkConfig {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8);

    pub fn validate_reserved_fields(&self) -> bool {
        self._reserved == [0u8; 31]
    }
}

/// Agent registration account
/// PDA seeds: ["agent", agent_id]
#[account]
#[derive(Default, InitSpace)]
pub struct AgentRegistration {
    /// Unique agent identifier
    pub agent_id: [u8; 32],
    /// Agent's signing authority
    pub authority: Pubkey,
    /// Agent capabilities as a bitmask (u64).
    ///
    /// Each bit represents a specific capability the agent possesses.
    /// See [`capability`] module for defined bits:
    /// - Bits 0-9: Currently defined capabilities (COMPUTE, INFERENCE, etc.)
    /// - Bits 10-63: Reserved for future protocol extensions
    ///
    /// Agents can only claim tasks where they have all required capabilities:
    /// `(agent.capabilities & task.required_capabilities) == task.required_capabilities`
    pub capabilities: u64,
    /// Agent status
    pub status: AgentStatus,
    /// Network endpoint (max 256 chars)
    #[max_len(256)]
    pub endpoint: String,
    /// Extended metadata URI (max 128 chars)
    #[max_len(128)]
    pub metadata_uri: String,
    /// Registration timestamp
    pub registered_at: i64,
    /// Last activity timestamp
    pub last_active: i64,
    /// Total tasks completed
    pub tasks_completed: u64,
    /// Total rewards earned
    pub total_earned: u64,
    /// Agent reputation score (0-10000)
    /// Initial value: 5000 (neutral starting point)
    /// Can be adjusted via protocol config in future versions
    pub reputation: u16,
    /// Active task count
    pub active_tasks: u16,
    /// Stake amount (for arbiters)
    pub stake: u64,
    /// Bump seed
    pub bump: u8,
    // === Agent-scoped rate limiting fields ===
    // Used for actions that remain bound to a specific agent identity.
    // Wallet-scoped task/dispute throttles live in `AuthorityRateLimit`.
    /// Timestamp of last task creation
    pub last_task_created: i64,
    /// Timestamp of last dispute initiated
    pub last_dispute_initiated: i64,
    /// Number of tasks created in current 24h window
    pub task_count_24h: u8,
    /// Number of disputes initiated in current 24h window
    pub dispute_count_24h: u8,
    /// Start of current rate limit window (unix timestamp)
    pub rate_limit_window_start: i64,
    /// DEPRECATED (P6.3): always 0 — the arbiter vote/quorum model is retired, so nothing
    /// increments this. The `deregister_agent` gate (`active_dispute_votes == 0`) is now a
    /// permanent no-op. Retained (not removed) to keep the AgentRegistration layout stable.
    pub active_dispute_votes: u8,
    /// DEPRECATED (P6.3): always 0 — no agent ever votes on a dispute anymore.
    pub last_vote_timestamp: i64,
    /// Timestamp of last state update
    pub last_state_update: i64,
    /// Active disputes where this agent is a defendant (can be slashed)
    pub disputes_as_defendant: u8,
    /// Reserved bytes for future use.
    /// Note: Not validated on deserialization - may contain arbitrary data
    /// from previous versions. New fields should handle this gracefully.
    pub _reserved: [u8; 4],
}

impl AgentRegistration {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8); // reserved

    /// Validates that reserved bytes are zeroed.
    /// Called during migration to ensure no data corruption.
    pub fn validate_reserved_fields(&self) -> bool {
        self._reserved == [0u8; 4]
    }
}

/// Wallet-scoped rate limit state.
/// PDA seeds: ["authority_rate_limit", authority]
#[account]
#[derive(Default, InitSpace)]
pub struct AuthorityRateLimit {
    /// Authority wallet this rate limit state belongs to
    pub authority: Pubkey,
    /// Timestamp of last task creation initiated by this authority
    pub last_task_created: i64,
    /// Timestamp of last dispute initiated by this authority
    pub last_dispute_initiated: i64,
    /// Number of tasks created in current 24h window
    pub task_count_24h: u8,
    /// Number of disputes initiated in current 24h window
    pub dispute_count_24h: u8,
    /// Start of current rate limit window (unix timestamp)
    pub rate_limit_window_start: i64,
    /// PDA bump seed
    pub bump: u8,
}

impl AuthorityRateLimit {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8); // bump
}

/// Task-level validation configuration.
/// PDA seeds: ["task_validation", task]
#[account]
#[derive(Default, InitSpace)]
pub struct TaskValidationConfig {
    /// Task this config belongs to.
    pub task: Pubkey,
    /// Task creator / reviewer authority.
    pub creator: Pubkey,
    /// Active validation mode.
    pub mode: ValidationMode,
    /// Review window in seconds before the submission may be escalated off-path.
    pub review_window_secs: i64,
    /// Creation timestamp.
    pub created_at: i64,
    /// Last update timestamp.
    pub updated_at: i64,
    /// PDA bump.
    pub bump: u8,
    /// Reserved for future validation variants.
    pub _reserved: [u8; 7],
}

impl TaskValidationConfig {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8);

    pub fn validator_quorum(&self) -> u8 {
        self._reserved[0]
    }

    pub fn set_validator_quorum(&mut self, quorum: u8) {
        self._reserved[0] = quorum;
    }

    pub fn pending_submission_count(&self) -> u16 {
        u16::from_le_bytes([self._reserved[1], self._reserved[2]])
    }

    pub fn set_pending_submission_count(&mut self, count: u16) {
        let bytes = count.to_le_bytes();
        self._reserved[1] = bytes[0];
        self._reserved[2] = bytes[1];
    }
}

/// Task-level external attestor configuration.
/// PDA seeds: ["task_attestor", task]
#[account]
#[derive(Default, InitSpace)]
pub struct TaskAttestorConfig {
    /// Task this config belongs to.
    pub task: Pubkey,
    /// Task creator / reviewer authority.
    pub creator: Pubkey,
    /// Wallet allowed to attest the outcome.
    pub attestor: Pubkey,
    /// Creation timestamp.
    pub created_at: i64,
    /// Last update timestamp.
    pub updated_at: i64,
    /// PDA bump.
    pub bump: u8,
    /// Reserved for future attestor metadata.
    pub _reserved: [u8; 7],
}

impl TaskAttestorConfig {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8);
}

/// Claim-level submission state for manual validation.
/// PDA seeds: ["task_submission", claim]
#[account]
#[derive(InitSpace)]
pub struct TaskSubmission {
    /// Task being submitted.
    pub task: Pubkey,
    /// Claim tied to this submission.
    pub claim: Pubkey,
    /// Worker that submitted the result.
    pub worker: Pubkey,
    /// Current submission status.
    pub status: SubmissionStatus,
    /// Latest proof hash supplied by the worker.
    pub proof_hash: [u8; HASH_SIZE],
    /// Latest result payload supplied by the worker.
    pub result_data: [u8; RESULT_DATA_SIZE],
    /// Number of times this claim has been submitted for review.
    pub submission_count: u16,
    /// Timestamp of latest submission.
    pub submitted_at: i64,
    /// Timestamp after which the review window has elapsed.
    pub review_deadline_at: i64,
    /// Acceptance timestamp (0 when unresolved).
    pub accepted_at: i64,
    /// Rejection timestamp (0 when unresolved).
    pub rejected_at: i64,
    /// Optional rejection reason hash.
    pub rejection_hash: [u8; HASH_SIZE],
    /// PDA bump.
    pub bump: u8,
    /// Reserved for future attestation metadata.
    pub _reserved: [u8; 5],
}

impl TaskSubmission {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8);

    pub fn approval_count(&self) -> u8 {
        self._reserved[0]
    }

    pub fn set_approval_count(&mut self, approvals: u8) {
        self._reserved[0] = approvals;
    }

    pub fn rejection_count(&self) -> u8 {
        self._reserved[1]
    }

    pub fn set_rejection_count(&mut self, rejections: u8) {
        self._reserved[1] = rejections;
    }

    pub fn clear_validation_counts(&mut self) {
        self._reserved[0] = 0;
        self._reserved[1] = 0;
    }
}

impl Default for TaskSubmission {
    fn default() -> Self {
        Self {
            task: Pubkey::default(),
            claim: Pubkey::default(),
            worker: Pubkey::default(),
            status: SubmissionStatus::Idle,
            proof_hash: [0u8; HASH_SIZE],
            result_data: [0u8; RESULT_DATA_SIZE],
            submission_count: 0,
            submitted_at: 0,
            review_deadline_at: 0,
            accepted_at: 0,
            rejected_at: 0,
            rejection_hash: [0u8; HASH_SIZE],
            bump: 0,
            _reserved: [0u8; 5],
        }
    }
}

/// Reviewer vote or attestation recorded for a task submission round.
/// PDA seeds: ["task_validation_vote", task_submission, reviewer]
#[account]
#[derive(Default, InitSpace)]
pub struct TaskValidationVote {
    /// Submission being validated.
    pub submission: Pubkey,
    /// Reviewer wallet that cast the vote / attestation.
    pub reviewer: Pubkey,
    /// Reviewer agent used for validator-quorum mode (default pubkey for attestors).
    pub reviewer_agent: Pubkey,
    /// Submission round the vote applies to.
    pub submission_round: u16,
    /// Whether the reviewer approved the result.
    pub approved: bool,
    /// Timestamp of the vote / attestation.
    pub voted_at: i64,
    /// PDA bump.
    pub bump: u8,
    /// Reserved for future metadata.
    pub _reserved: [u8; 5],
}

impl TaskValidationVote {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8);
}

/// Maximum byte length for a task job specification URI.
pub const TASK_JOB_SPEC_URI_MAX_LEN: usize = 256;

/// Moderation status constants for task/job-spec pre-ingest attestations.
///
/// These values are intentionally simple `u8`s so indexers and external
/// moderation services can interoperate without depending on Rust enum layout.
pub mod task_moderation_status {
    /// Scanner found no blocking/suspicious signal.
    pub const CLEAN: u8 = 0;
    /// Scanner found risky content; human review is required.
    pub const SUSPICIOUS: u8 = 1;
    /// Scanner found high-confidence malicious content.
    pub const BLOCKED: u8 = 2;
    /// Scanner was unavailable; fail closed for marketplace ingest.
    pub const SCANNER_UNAVAILABLE: u8 = 3;
    /// Human reviewer explicitly approved a held task/job spec.
    pub const HUMAN_APPROVED: u8 = 4;
    /// Human reviewer explicitly rejected a held task/job spec.
    pub const HUMAN_REJECTED: u8 = 5;
}

/// Maximum normalized risk score accepted by task moderation attestations.
pub const TASK_MODERATION_RISK_SCORE_MAX: u8 = 100;

pub fn is_valid_task_moderation_status(status: u8) -> bool {
    matches!(
        status,
        task_moderation_status::CLEAN
            | task_moderation_status::SUSPICIOUS
            | task_moderation_status::BLOCKED
            | task_moderation_status::SCANNER_UNAVAILABLE
            | task_moderation_status::HUMAN_APPROVED
            | task_moderation_status::HUMAN_REJECTED
    )
}

pub fn is_publishable_task_moderation_status(status: u8) -> bool {
    matches!(
        status,
        task_moderation_status::CLEAN | task_moderation_status::HUMAN_APPROVED
    )
}

/// Content-addressed pointer to a task's full off-chain job specification.
/// PDA seeds: ["task_job_spec", task]
#[account]
#[derive(Default, InitSpace)]
pub struct TaskJobSpec {
    /// Task this job specification belongs to.
    pub task: Pubkey,
    /// Task creator authorized to set or update the pointer.
    pub creator: Pubkey,
    /// SHA-256 hash of the canonicalized job specification payload.
    pub job_spec_hash: [u8; HASH_SIZE],
    /// URI where the canonicalized job specification payload can be fetched.
    #[max_len(256)]
    pub job_spec_uri: String,
    /// Creation timestamp.
    pub created_at: i64,
    /// Last update timestamp.
    pub updated_at: i64,
    /// PDA bump.
    pub bump: u8,
    /// Reserved for future metadata flags.
    pub _reserved: [u8; 7],
}

impl TaskJobSpec {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8);
}

/// Global task moderation configuration.
/// PDA seeds: ["moderation_config"]
#[account]
#[derive(Default, InitSpace)]
pub struct ModerationConfig {
    /// Protocol authority that configured this moderation gate.
    pub authority: Pubkey,
    /// Signer allowed to record moderation attestations.
    pub moderation_authority: Pubkey,
    /// Whether task job-spec publication requires moderation attestations.
    pub enabled: bool,
    /// Creation timestamp.
    pub created_at: i64,
    /// Last update timestamp.
    pub updated_at: i64,
    /// PDA bump.
    pub bump: u8,
    /// Reserved for future moderation policy flags.
    pub _reserved: [u8; 6],
}

impl ModerationConfig {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8);
}

/// On-chain moderation attestation for a task/job-spec hash.
/// PDA seeds: ["task_moderation", task, job_spec_hash]
#[account]
#[derive(Default, InitSpace)]
pub struct TaskModeration {
    /// Task this moderation decision applies to.
    pub task: Pubkey,
    /// Task creator at the time the decision was recorded.
    pub creator: Pubkey,
    /// Job-spec hash approved/held/rejected by the scanner or reviewer.
    pub job_spec_hash: [u8; HASH_SIZE],
    /// One of `task_moderation_status::*`.
    pub status: u8,
    /// Normalized 0-100 risk score.
    pub risk_score: u8,
    /// Bitmask of scanner categories, interpreted by off-chain policy docs.
    pub category_mask: u64,
    /// Hash of the moderation policy/threshold version.
    pub policy_hash: [u8; HASH_SIZE],
    /// Hash of the scanner/model version bundle.
    pub scanner_hash: [u8; HASH_SIZE],
    /// When the moderation decision was recorded.
    pub recorded_at: i64,
    /// Optional expiry timestamp. Zero means no expiry.
    pub expires_at: i64,
    /// Signer that recorded the moderation decision.
    pub moderator: Pubkey,
    /// PDA bump.
    pub bump: u8,
    /// Reserved for future attestation metadata.
    pub _reserved: [u8; 7],
}

impl TaskModeration {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8);
}

/// Task account
/// PDA seeds: ["task", creator, task_id]
#[account]
#[derive(InitSpace)]
pub struct Task {
    /// Unique task identifier
    pub task_id: [u8; 32],
    /// Task creator (paying party)
    pub creator: Pubkey,
    /// Required capability bitmask (u64).
    ///
    /// Specifies which capabilities an agent must have to claim this task.
    /// See [`capability`] module for defined bits. An agent can claim this
    /// task only if: `(agent.capabilities & required_capabilities) == required_capabilities`
    pub required_capabilities: u64,
    /// Task description or instruction hash
    pub description: [u8; 64],
    /// Constraint hash for private task verification (hash of expected output)
    /// For private tasks, workers must prove they know output that hashes to this value
    pub constraint_hash: [u8; 32],
    /// Reward amount in lamports
    pub reward_amount: u64,
    /// Maximum workers allowed
    pub max_workers: u8,
    /// Current worker count
    pub current_workers: u8,
    /// Task status
    pub status: TaskStatus,
    /// Task type
    pub task_type: TaskType,
    /// Creation timestamp
    pub created_at: i64,
    /// Deadline timestamp (0 = no deadline)
    pub deadline: i64,
    /// Completion timestamp
    pub completed_at: i64,
    /// Escrow account for reward
    pub escrow: Pubkey,
    /// Result data or pointer
    pub result: [u8; 64],
    /// Number of completions (for collaborative tasks)
    pub completions: u8,
    /// Required completions
    pub required_completions: u8,
    /// Bump seed
    pub bump: u8,
    /// Protocol fee in basis points, locked at task creation (#479)
    pub protocol_fee_bps: u16,
    /// Optional parent task this task depends on (None for independent tasks)
    pub depends_on: Option<Pubkey>,
    /// Type of dependency relationship
    pub dependency_type: DependencyType,
    /// Minimum reputation score (0-10000) required for workers to claim this task.
    /// 0 means no reputation gate (default for backward compatibility).
    pub min_reputation: u16,
    /// Optional SPL token mint for reward denomination.
    /// None = SOL rewards (default, backward compatible).
    /// Some(mint) = SPL token rewards using the specified mint.
    pub reward_mint: Option<Pubkey>,
    // === Batch 2 layout additions (APPEND-ONLY — never reorder/insert above) ===
    /// Operator (embedding-site) payee for the §4 3-way split. `Pubkey::default()`
    /// means no operator leg (non-operator task, or a pre-Batch-2 task not yet
    /// backfilled — settlement falls back to the HireRecord in that case).
    pub operator: Pubkey,
    /// Operator fee in basis points, snapshotted from the listing at hire time.
    /// 0 = no operator leg. Capped at MAX_OPERATOR_FEE_BPS by listing creation.
    pub operator_fee_bps: u16,
    /// Reserved padding so future field adds become value-only migrates rather
    /// than another realloc-all sweep. MUST stay zeroed (validate_reserved_fields).
    pub _reserved: [u8; 16],
    // === P6.2 demand-side referral leg (APPEND-ONLY — never reorder/insert above) ===
    /// Referrer (embedder who brought the buyer) payee for the §4 4-way split.
    /// `Pubkey::default()` means no referrer leg (the common case). Snapshotted from
    /// the hire / create-task args, EXACTLY like `operator` — the 34B referrer fields
    /// exceed the 16B `_reserved`, so this is a size-extending migration of the 149
    /// live tasks (see `migrate_task`).
    pub referrer: Pubkey,
    /// Referrer fee in basis points, snapshotted at hire/create time. 0 = no referrer
    /// leg. Combined with protocol + operator, capped so the worker keeps ≥60%.
    pub referrer_fee_bps: u16,
}

impl Default for Task {
    fn default() -> Self {
        Self {
            task_id: [0u8; 32],
            creator: Pubkey::default(),
            required_capabilities: 0,
            description: [0u8; 64],
            constraint_hash: [0u8; 32],
            reward_amount: 0,
            max_workers: 1,
            current_workers: 0,
            status: TaskStatus::default(),
            task_type: TaskType::default(),
            created_at: 0,
            deadline: 0,
            completed_at: 0,
            escrow: Pubkey::default(),
            result: [0u8; 64],
            completions: 0,
            required_completions: 1,
            bump: 0,
            protocol_fee_bps: 0,
            depends_on: None,
            dependency_type: DependencyType::default(),
            min_reputation: 0,
            reward_mint: None,
            operator: Pubkey::default(),
            operator_fee_bps: 0,
            _reserved: [0u8; 16],
            referrer: Pubkey::default(),
            referrer_fee_bps: 0,
        }
    }
}

impl Task {
    /// Prefer using `8 + Task::INIT_SPACE` (from #[derive(InitSpace)]).
    /// This manual constant is kept for backwards compatibility.
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8); // reward_mint (Option<Pubkey>: 1 byte discriminator + 32 bytes pubkey)

    /// On-chain byte size of the pre-Batch-2 `Task` (8-byte discriminator + 374
    /// INIT_SPACE). The 149 live mainnet tasks are at this size; `migrate_task`
    /// reallocs them up to `SIZE`. Do NOT change — it is the migration precondition.
    pub const OLD_TASK_SIZE: usize = 382;

    /// On-chain byte size of the intermediate Batch-2 `Task` (operator leg added,
    /// pre-P6.2). A task already grown to this size by a Batch-2 `migrate_task` run
    /// is a SECOND valid migration precondition — `migrate_task` accepts EITHER the
    /// pre-Batch-2 (382B) OR the Batch-2 (432B) layout and reallocs straight up to
    /// `SIZE`, so the sweep is correct regardless of whether the live tasks were ever
    /// migrated to 432 before this P6.2 deploy (on mainnet today they are still 382).
    pub const BATCH2_TASK_SIZE: usize = 432;

    /// Reserved padding must stay zeroed; non-zero implies corruption or an
    /// unexpected write (defense-in-depth, mirrors other reserved-field guards).
    pub fn validate_reserved_fields(&self) -> bool {
        self._reserved == [0u8; 16]
    }
}

/// Compile-time pin: a layout drift (field add/reorder changing INIT_SPACE)
/// fails the build instead of silently bricking the 149-task migration.
/// P6.2 appends `referrer` (32B) + `referrer_fee_bps` (2B) = 34B onto the Batch-2
/// layout, taking the Task from 432B to 466B.
const _: () = assert!(Task::SIZE == 466);
const _: () = assert!(Task::OLD_TASK_SIZE + 84 == Task::SIZE);
const _: () = assert!(Task::BATCH2_TASK_SIZE + 34 == Task::SIZE);

/// Worker's claim on a task
/// PDA seeds: ["claim", task, worker_agent]
#[account]
#[derive(InitSpace)]
pub struct TaskClaim {
    /// Task being claimed
    pub task: Pubkey,
    /// Worker agent
    pub worker: Pubkey,
    /// Claim timestamp
    pub claimed_at: i64,
    /// Expiration timestamp for claim
    pub expires_at: i64,
    /// Completion timestamp
    pub completed_at: i64,
    /// Proof of work hash
    pub proof_hash: [u8; 32],
    /// Result data
    pub result_data: [u8; 64],
    /// Is completed
    pub is_completed: bool,
    /// Is validated
    pub is_validated: bool,
    /// Reward paid
    pub reward_paid: u64,
    /// Bump seed
    pub bump: u8,
}

impl Default for TaskClaim {
    fn default() -> Self {
        Self {
            task: Pubkey::default(),
            worker: Pubkey::default(),
            claimed_at: 0,
            expires_at: 0,
            completed_at: 0,
            proof_hash: [0u8; 32],
            result_data: [0u8; 64],
            is_completed: false,
            is_validated: false,
            reward_paid: 0,
            bump: 0,
        }
    }
}

impl TaskClaim {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8); // bump
}

/// Shared coordination state
/// PDA seeds: ["state", owner, state_key]
#[account]
#[derive(InitSpace)]
pub struct CoordinationState {
    /// Owner authority - namespaces state to prevent cross-user collisions
    pub owner: Pubkey,
    /// State key
    pub state_key: [u8; 32],
    /// State value
    pub state_value: [u8; 64],
    /// Last updater
    pub last_updater: Pubkey,
    /// Version for optimistic locking
    pub version: u64,
    /// Last update timestamp
    pub updated_at: i64,
    /// Bump seed
    pub bump: u8,
}

impl Default for CoordinationState {
    fn default() -> Self {
        Self {
            owner: Pubkey::default(),
            state_key: [0u8; 32],
            state_value: [0u8; 64],
            last_updater: Pubkey::default(),
            version: 0,
            updated_at: 0,
            bump: 0,
        }
    }
}

impl CoordinationState {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8); // bump
}

/// Dispute account for conflict resolution
/// PDA seeds: ["dispute", dispute_id]
#[account]
#[derive(Default, InitSpace)]
pub struct Dispute {
    /// Dispute identifier
    pub dispute_id: [u8; 32],
    /// Related task
    pub task: Pubkey,
    /// Initiator (agent PDA)
    pub initiator: Pubkey,
    /// Initiator's authority wallet (for resolver constraint)
    pub initiator_authority: Pubkey,
    /// Evidence hash
    pub evidence_hash: [u8; 32],
    /// Proposed resolution type
    pub resolution_type: ResolutionType,
    /// Dispute status
    pub status: DisputeStatus,
    /// Creation timestamp
    pub created_at: i64,
    /// Resolution timestamp
    pub resolved_at: i64,
    /// DEPRECATED (P6.3): arbiter vote tally retired. `vote_dispute` no longer exists,
    /// so no path increments these from voting. `resolve_dispute` now repurposes this
    /// pair as a 1-bit RULING RECORD so the permissionless `apply_dispute_slash` /
    /// `apply_initiator_slash` finalizers can read the resolver's approve/reject decision
    /// without a vote tally: a resolution writes `votes_for = 1, votes_against = 0` when
    /// the resolver APPROVED and `votes_for = 0, votes_against = 1` when REJECTED. The
    /// fields are NOT shrunk (a layout change would be a hazard); they are reinterpreted.
    pub votes_for: u64,
    /// DEPRECATED (P6.3): see `votes_for`. Reused as the reject side of the ruling bit.
    pub votes_against: u64,
    /// DEPRECATED (P6.3): always 0 — the arbiter vote/quorum model is retired, so no
    /// voter is ever recorded. Retained (not shrunk) to keep the account layout stable.
    pub total_voters: u8,
    /// DEPRECATED (P6.3): no longer gates resolution — an assigned resolver decides
    /// directly with no voting-period wait. Still stamped at initiation for back-compat.
    /// voting_deadline = created_at + voting_period
    pub voting_deadline: i64,
    /// Dispute expiration - after this, can call expire_dispute
    /// expires_at = created_at + max_dispute_duration
    /// Note: expires_at >= voting_deadline, allowing resolution after voting ends
    pub expires_at: i64,
    /// Whether worker slashing has been applied
    pub slash_applied: bool,
    /// Whether initiator slashing has been applied (for rejected disputes)
    pub initiator_slash_applied: bool,
    /// Snapshot of worker's stake at dispute initiation (prevents stake withdrawal attacks)
    pub worker_stake_at_dispute: u64,
    /// Whether the dispute was initiated by the task creator (fix #407)
    /// Used to apply stricter requirements and different expiration behavior for creator disputes
    pub initiated_by_creator: bool,
    /// Bump seed
    pub bump: u8,
    /// The defendant worker's agent PDA (fix #827)
    /// Binds slashing target at dispute initiation to prevent slashing wrong worker
    /// on collaborative tasks with multiple claimants.
    pub defendant: Pubkey,
    /// P6.4 (accountable rulings) — APPENDED fields. The resolver MUST attach a
    /// reasoned ruling: a 32-byte content hash of the off-chain rationale plus a
    /// bounded pointer to it, and the deciding resolver's pubkey. All three are
    /// zero/empty on a dispute that has not been resolved through `resolve_dispute`
    /// (e.g. an expired dispute), which is a valid "no ruling recorded" state.
    ///
    /// LAYOUT NOTE: appending these grows `Dispute::SIZE`. This is a layout change,
    /// but NOT a migration: `Dispute` is compiled OUT of the live mainnet canary
    /// surface (the 25-instruction allowlist contains no dispute instructions), so
    /// ZERO live mainnet `Dispute` accounts exist to migrate. On devnet/full-surface
    /// this is treated as append-only (any pre-existing dispute prefix stays valid;
    /// the new fields read back as zero/empty). See `test_dispute_size_p64_append`.
    pub rationale_hash: [u8; 32],
    /// Bounded off-chain pointer to the ruling rationale (e.g. `agenc://ruling/...`).
    /// Empty string = no URI (the hash may still carry the rationale).
    #[max_len(256)]
    pub rationale_uri: String,
    /// The wallet that decided this dispute (the protocol authority OR the assigned
    /// resolver who signed `resolve_dispute`). Default pubkey until resolved.
    pub resolved_by: Pubkey,
}

impl Dispute {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8); // defendant (fix #827) + P6.4 rationale/resolver
    /// Maximum byte length of `rationale_uri` (matches the `#[max_len(256)]` reserve).
    pub const MAX_RATIONALE_URI_LEN: usize = 256;
}

// P6.3: the `DisputeVote` (["vote", dispute, voter]) and `AuthorityDisputeVote`
// (["authority_vote", dispute, authority]) PDA account types are RETIRED. They were
// only ever minted by `vote_dispute` (now removed) and closed by the arbiter-pair
// cleanup loops in resolve/expire (also removed). Disputes are decided by an assigned
// resolver, so no vote PDA is ever created. The types are deleted; no existing account
// layout is changed (disputes are compiled out of the live mainnet canary, so no live
// mainnet dispute-vote accounts exist to migrate).

/// Task escrow account
/// PDA seeds: ["escrow", task]
#[account]
#[derive(Default, InitSpace)]
pub struct TaskEscrow {
    /// Task this escrow belongs to
    pub task: Pubkey,
    /// Total amount deposited
    pub amount: u64,
    /// Amount already distributed
    pub distributed: u64,
    /// Is closed
    pub is_closed: bool,
    /// Bump seed
    pub bump: u8,
}

impl TaskEscrow {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8); // bump
}

/// Marketplace V2 configuration account
/// PDA seeds: ["bid_marketplace"]
#[account]
#[derive(Default, InitSpace)]
pub struct BidMarketplaceConfig {
    pub authority: Pubkey,
    pub min_bid_bond_lamports: u64,
    pub bid_creation_cooldown_secs: i64,
    pub max_bids_per_24h: u16,
    pub max_active_bids_per_task: u16,
    pub max_bid_lifetime_secs: i64,
    pub accepted_no_show_slash_bps: u16,
    pub bump: u8,
}

impl BidMarketplaceConfig {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8);
}

/// Per-bidder bid-market activity state
/// PDA seeds: ["bidder_market", bidder_agent]
#[account]
#[derive(Default, InitSpace)]
pub struct BidderMarketState {
    pub bidder: Pubkey,
    pub last_bid_created_at: i64,
    pub bid_window_started_at: i64,
    pub bids_created_in_window: u16,
    pub active_bid_count: u16,
    pub total_bids_created: u64,
    pub total_bids_accepted: u64,
    pub bump: u8,
}

impl BidderMarketState {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8);
}

/// Bid book for a Marketplace V2 task
/// PDA seeds: ["bid_book", task]
#[account]
#[derive(Default, InitSpace)]
pub struct TaskBidBook {
    pub task: Pubkey,
    pub state: BidBookState,
    pub policy: MatchingPolicy,
    pub weights: WeightedScoreWeights,
    pub accepted_bid: Option<Pubkey>,
    pub version: u64,
    pub total_bids: u32,
    pub active_bids: u16,
    pub created_at: i64,
    pub updated_at: i64,
    pub bump: u8,
}

impl TaskBidBook {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8);
}

/// Single active bid per bidder per task in Marketplace V2
/// PDA seeds: ["bid", task, bidder_agent]
#[account]
#[derive(Default, InitSpace)]
pub struct TaskBid {
    pub task: Pubkey,
    pub bid_book: Pubkey,
    pub bidder: Pubkey,
    pub bidder_authority: Pubkey,
    pub requested_reward_lamports: u64,
    pub eta_seconds: u32,
    pub confidence_bps: u16,
    pub reputation_snapshot_bps: u16,
    pub quality_guarantee_hash: [u8; 32],
    pub metadata_hash: [u8; 32],
    pub expires_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub state: TaskBidState,
    pub bond_lamports: u64,
    pub bump: u8,
}

impl TaskBid {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8);
}

/// Agent's speculation bond account
/// PDA seeds: ["speculation_bond", agent]
#[account]
#[derive(Default, InitSpace)]
pub struct SpeculationBond {
    pub agent: Pubkey,
    pub total_bonded: u64,
    pub available: u64,
    pub total_deposited: u64,
    pub total_slashed: u64,
    pub bump: u8,
}

impl SpeculationBond {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8);
}

/// On-chain record of a speculative commitment
#[account]
#[derive(Default, InitSpace)]
pub struct SpeculativeCommitment {
    pub task: Pubkey,
    pub producer: Pubkey,
    pub result_hash: [u8; 32],
    pub confirmed: bool,
    pub expires_at: i64,
    pub bonded_stake: u64,
    pub created_at: i64,
    pub bump: u8,
}

impl SpeculativeCommitment {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8); // 130 bytes
}

/// Binding spend account to prevent statement replay for the same
/// task/authority/commitment context.
/// PDA seeds: ["binding_spend", binding]
#[account]
#[derive(Default, InitSpace)]
pub struct BindingSpend {
    /// Binding value committed in the private journal.
    pub binding: [u8; 32],
    /// The task where this binding was first used
    pub task: Pubkey,
    /// The agent who spent this binding
    pub agent: Pubkey,
    /// Timestamp when binding was spent
    pub spent_at: i64,
    /// Bump seed for PDA
    pub bump: u8,
}

impl BindingSpend {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8); // bump
}

/// Nullifier spend account to prevent global proof/knowledge replay.
/// PDA seeds: ["nullifier_spend", nullifier]
#[account]
#[derive(Default, InitSpace)]
pub struct NullifierSpend {
    /// Nullifier value committed in the private journal.
    pub nullifier: [u8; 32],
    /// The task where this nullifier was first used
    pub task: Pubkey,
    /// The agent who spent this nullifier
    pub agent: Pubkey,
    /// Timestamp when nullifier was spent
    pub spent_at: i64,
    /// Bump seed for PDA
    pub bump: u8,
}

impl NullifierSpend {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8); // bump
}

// ============================================================================
// Governance
// ============================================================================

/// Governance configuration account
/// PDA seeds: ["governance"]
#[account]
#[derive(InitSpace)]
pub struct GovernanceConfig {
    /// Protocol authority (must match ProtocolConfig.authority at init time)
    pub authority: Pubkey,
    /// Minimum stake required to create a proposal
    pub min_proposal_stake: u64,
    /// Voting period in seconds for new proposals
    pub voting_period: i64,
    /// Execution delay after voting ends (timelock) in seconds
    pub execution_delay: i64,
    /// Quorum in basis points of total agents' stake
    pub quorum_bps: u16,
    /// Approval threshold in basis points (e.g., 5000 = simple majority)
    pub approval_threshold_bps: u16,
    /// Total proposals created (monotonic counter)
    pub total_proposals: u64,
    /// Bump seed
    pub bump: u8,
    /// Reserved for future use
    pub _reserved: [u8; 64],
}

impl GovernanceConfig {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8); // _reserved

    /// Default voting period: 3 days
    pub const DEFAULT_VOTING_PERIOD: i64 = 259_200;

    /// Maximum voting period: 7 days
    pub const MAX_VOTING_PERIOD: i64 = 604_800;

    /// Default execution delay: 1 day
    pub const DEFAULT_EXECUTION_DELAY: i64 = 86_400;

    /// Maximum execution delay: 7 days
    pub const MAX_EXECUTION_DELAY: i64 = 604_800;
}

/// Governance proposal type
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, InitSpace)]
#[repr(u8)]
pub enum ProposalType {
    /// Change protocol parameters (fee tiers, thresholds)
    #[default]
    ProtocolUpgrade = 0,
    /// Change protocol fee
    FeeChange = 1,
    /// Transfer lamports from treasury
    TreasurySpend = 2,
    /// Change rate limit parameters
    RateLimitChange = 3,
}

/// Governance proposal status
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, InitSpace)]
#[repr(u8)]
pub enum ProposalStatus {
    /// Proposal is accepting votes
    #[default]
    Active = 0,
    /// Proposal passed and was executed
    Executed = 1,
    /// Proposal failed to reach quorum or majority
    Defeated = 2,
    /// Proposal was cancelled by proposer
    Cancelled = 3,
}

/// Governance proposal account
/// PDA seeds: ["proposal", proposer, nonce]
#[account]
#[derive(InitSpace)]
pub struct Proposal {
    /// Proposer's agent PDA
    pub proposer: Pubkey,
    /// Proposer's authority wallet
    pub proposer_authority: Pubkey,
    /// Monotonic nonce per proposer (allows multiple proposals)
    pub nonce: u64,
    /// Proposal type
    pub proposal_type: ProposalType,
    /// Title hash (SHA256 of title string)
    pub title_hash: [u8; 32],
    /// Description hash (SHA256 of description/URI)
    pub description_hash: [u8; 32],
    /// Type-specific payload (64 bytes)
    /// FeeChange: new fee bps as u16 LE in bytes [0..2], rest zero
    /// TreasurySpend: recipient Pubkey [0..32] + amount u64 LE [32..40], rest zero
    /// ProtocolUpgrade: reserved for future parameter batch changes
    pub payload: [u8; 64],
    /// Current status
    pub status: ProposalStatus,
    /// Creation timestamp
    pub created_at: i64,
    /// Voting deadline (no new votes accepted after this)
    pub voting_deadline: i64,
    /// Earliest timestamp at which the proposal can be executed (timelock)
    pub execution_after: i64,
    /// Execution timestamp (0 if not executed)
    pub executed_at: i64,
    /// Total stake-weighted votes for approval
    pub votes_for: u64,
    /// Total stake-weighted votes against
    pub votes_against: u64,
    /// Number of individual voters
    pub total_voters: u16,
    /// Required quorum (minimum total stake-weighted votes)
    pub quorum: u64,
    /// Bump seed
    pub bump: u8,
    /// Reserved for future use
    pub _reserved: [u8; 64],
}

impl Proposal {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8); // _reserved
}

/// Governance vote record
/// PDA seeds: ["governance_vote", proposal, voter]
#[account]
#[derive(Default, InitSpace)]
pub struct GovernanceVote {
    /// Proposal being voted on
    pub proposal: Pubkey,
    /// Voter (agent PDA)
    pub voter: Pubkey,
    /// Vote (true = approve, false = reject)
    pub approved: bool,
    /// Vote timestamp
    pub voted_at: i64,
    /// Voter's effective vote weight (reputation * stake, capped)
    pub vote_weight: u64,
    /// Bump seed
    pub bump: u8,
    /// Reserved for future use
    pub _reserved: [u8; 8],
}

impl GovernanceVote {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8); // _reserved
}

// ============================================================================
// Skill Registry
// ============================================================================

/// Skill registration account
/// PDA seeds: ["skill", author_agent_pda, skill_id]
#[account]
#[derive(InitSpace)]
pub struct SkillRegistration {
    /// Author's agent PDA
    pub author: Pubkey,
    /// Unique skill identifier
    pub skill_id: [u8; 32],
    /// Skill display name
    pub name: [u8; 32],
    /// Content hash (IPFS CID, Arweave tx, etc.)
    pub content_hash: [u8; 32],
    /// Price in lamports (SOL) or token smallest units
    pub price: u64,
    /// Optional SPL token mint for price denomination (None = SOL)
    pub price_mint: Option<Pubkey>,
    /// Tags for discovery (encoded by client)
    pub tags: [u8; 64],
    /// Sum of reputation-weighted ratings
    pub total_rating: u64,
    /// Number of ratings received
    pub rating_count: u32,
    /// Number of purchases
    pub download_count: u32,
    /// Content version (monotonically increasing)
    pub version: u8,
    /// Whether the skill is currently active
    pub is_active: bool,
    /// Creation timestamp
    pub created_at: i64,
    /// Last update timestamp
    pub updated_at: i64,
    /// Bump seed
    pub bump: u8,
    /// Reserved for future use
    pub _reserved: [u8; 8],
}

impl SkillRegistration {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8); // _reserved
}

/// Lifecycle state of a service listing.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, InitSpace)]
#[repr(u8)]
pub enum ListingState {
    /// Open for hires.
    #[default]
    Active = 0,
    /// Temporarily not hireable; can be reactivated.
    Paused = 1,
    /// Permanently retired; terminal (cannot be reactivated or updated).
    Retired = 2,
}

impl ListingState {
    /// Parse a client-supplied state byte. Used by `set_service_listing_state`.
    pub fn from_u8(value: u8) -> anchor_lang::Result<Self> {
        match value {
            0 => Ok(ListingState::Active),
            1 => Ok(ListingState::Paused),
            2 => Ok(ListingState::Retired),
            _ => Err(crate::errors::CoordinationError::ListingInvalidStateTransition.into()),
        }
    }
}

/// A standing, embeddable service listing: a provider agent advertising a fixed-price
/// service that buyers (humans or other agents) can hire on demand. The listing is
/// never escrow-bearing or task-bearing itself — each hire mints an independent
/// one-shot `Task` (see `hire_from_listing`).
/// PDA seeds: ["service_listing", provider_agent_pda, listing_id]
#[account]
#[derive(InitSpace)]
pub struct ServiceListing {
    /// Provider's agent PDA (the maker / worker that fulfils hires)
    pub provider_agent: Pubkey,
    /// Provider's signing authority (owns the listing)
    pub authority: Pubkey,
    /// Unique listing identifier
    pub listing_id: [u8; 32],
    /// Display name
    pub name: [u8; 32],
    /// Category (client-encoded)
    pub category: [u8; 32],
    /// Tags for discovery (client-encoded)
    pub tags: [u8; 64],
    /// Content-addressed job-spec hash (sha256 of the spec)
    pub spec_hash: [u8; 32],
    /// Job-spec URI (e.g. agenc://job-spec/sha256/<hash>)
    #[max_len(256)]
    pub spec_uri: String,
    /// Price in lamports (SOL) or token smallest units
    pub price: u64,
    /// Optional SPL token mint for price denomination (None = SOL)
    pub price_mint: Option<Pubkey>,
    /// Capability bitmask a worker must satisfy
    pub required_capabilities: u64,
    /// Default task deadline in seconds from hire (0 = protocol default)
    pub default_deadline_secs: i64,
    /// Operator payee (the embedding site); `Pubkey::default()` = no operator.
    /// Carried here in Batch 1; the on-chain 3-way settlement split lands in
    /// Batch 2 with the `Task` layout change + migration.
    pub operator: Pubkey,
    /// Operator fee in basis points (applied at settlement once Batch 2 ships)
    pub operator_fee_bps: u16,
    /// Lifecycle state
    pub state: ListingState,
    /// Max concurrently-open hires (0 = unlimited)
    pub max_open_jobs: u16,
    /// Open-hire count: incremented by `hire_from_listing`, decremented only by
    /// `close_task` (NOT at task termination via cancel/complete). It therefore
    /// counts hires that have been created but not yet closed, which is
    /// deliberately conservative: the count can lag high (blocking further hires)
    /// but never lags low, so it can never over-admit past `max_open_jobs`. A
    /// provider can always raise/zero `max_open_jobs` to relieve a lagging count.
    /// (Batch 2's Task migration will let cancel/complete free the slot directly.)
    pub open_jobs: u16,
    /// Lifetime hire count
    pub total_hires: u64,
    /// Sum of reputation-weighted ratings
    pub total_rating: u64,
    /// Number of ratings received
    pub rating_count: u32,
    /// Version, bumped on every update (compare-and-swap target for hire)
    pub version: u64,
    /// Creation timestamp
    pub created_at: i64,
    /// Last update timestamp
    pub updated_at: i64,
    /// Bump seed
    pub bump: u8,
    /// Reserved for future growth (SLA refs, escrow refs, etc.)
    pub _reserved: [u8; 32],
}

impl ServiceListing {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8); // + 8 discriminator
}

/// Links a one-shot hire to its source `ServiceListing`.
///
/// Created by `hire_from_listing` and closed by `close_task`. Its purpose is to
/// let `close_task` decrement the listing's `open_jobs` capacity counter WITHOUT a
/// `Task` layout change (no migration): the on-chain task<->listing link lives
/// here instead of on `Task`. It also snapshots the operator fee terms at hire
/// time so the Batch 2 settlement split can read them without touching `Task`.
/// PDA seeds: ["hire", task]
#[account]
#[derive(Default, InitSpace)]
pub struct HireRecord {
    /// The one-shot task minted by this hire.
    pub task: Pubkey,
    /// Source service listing whose `open_jobs` is decremented when the task closes.
    pub listing: Pubkey,
    /// Operator payee snapshot for the Batch 2 fee split (`Pubkey::default()` = none).
    pub operator: Pubkey,
    /// Operator fee in basis points, snapshotted at hire time.
    pub operator_fee_bps: u16,
    /// PDA bump.
    pub bump: u8,
    /// Reserved for future hire metadata.
    pub _reserved: [u8; 32],
    // === P6.2 demand-side referral leg (APPEND-ONLY) ===
    /// Referrer (embedder) payee snapshot for the §4 4-way split
    /// (`Pubkey::default()` = none). Mirrors the operator snapshot. HireRecords have
    /// NO live mainnet accounts (`hire_from_listing` is full-module only), so this is
    /// a fresh-init size bump — no realloc migration needed for HireRecord.
    pub referrer: Pubkey,
    /// Referrer fee in basis points, snapshotted at hire time.
    pub referrer_fee_bps: u16,
}

impl HireRecord {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8);
}

/// One-shot buyer rating of a completed listing hire (P6.1).
///
/// Init-once on PDA `["hire_rating", task]` so exactly ONE rating can ever be
/// recorded per hired task — re-rating the same task fails at account `init`
/// (the PDA already exists), which is the on-chain double-rate guard. The account
/// is keyed solely on `task`, so its existence is the dedupe key regardless of who
/// holds the buyer/listing accounts at call time.
///
/// Written by `rate_hire`. The rating is authored by the task's recorded buyer
/// (`task.creator`, which `hire_from_listing` constrains to equal the funding
/// authority), and only after the task reaches the terminal `Completed` state, so
/// a buyer can only rate work they paid for and that actually finished.
///
/// PDA seeds: ["hire_rating", task]
#[account]
#[derive(Default, InitSpace)]
pub struct HireRating {
    /// The completed hired task this rating is for (also the dedupe seed).
    pub task: Pubkey,
    /// Source service listing whose aggregate was updated by this rating.
    pub listing: Pubkey,
    /// The buyer (task creator) that authored the rating.
    pub buyer: Pubkey,
    /// Score in [1, 5].
    pub score: u8,
    /// Optional off-chain review content hash (`None` = no written review).
    pub review_hash: Option<[u8; 32]>,
    /// Optional bounded pointer to the off-chain review (e.g. agenc://review/...).
    /// Empty string = no URI.
    #[max_len(256)]
    pub review_uri: String,
    /// When the rating was recorded.
    pub rated_at: i64,
    /// PDA bump.
    pub bump: u8,
    /// Reserved for future rating metadata. MUST stay zeroed.
    pub _reserved: [u8; 32],
}

impl HireRating {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8); // + 8 discriminator
    /// Maximum byte length of `review_uri` (matches the `#[max_len(256)]` reserve).
    pub const MAX_REVIEW_URI_LEN: usize = 256;
    /// Inclusive minimum rating score.
    pub const MIN_SCORE: u8 = 1;
    /// Inclusive maximum rating score.
    pub const MAX_SCORE: u8 = 5;

    pub fn validate_reserved_fields(&self) -> bool {
        self._reserved == [0u8; 32]
    }
}

/// Negative / non-success track-record counters for an agent (P6.6).
///
/// `AgentRegistration` only tracks success-side stats (`tasks_completed`,
/// `total_earned`) and has just FOUR reserved bytes, so the negative counters
/// (rejections, dispute outcomes, expirations, cancellations) do NOT fit there.
/// Rather than a size-extending migration of every live mainnet agent account,
/// these live in a SEPARATE aggregate PDA `["agent_stats", agent]` that is created
/// lazily on first write (`init_if_needed`), keyed on the agent's
/// `AgentRegistration` PDA. No `AgentRegistration` layout change / migration is
/// introduced.
///
/// These are reputation TELEMETRY, not a money-path account: they are never read to
/// gate settlement, so the incrementing accounts are passed OPTIONALLY in the
/// full-surface handlers (`reject_task_result`, `reject_and_freeze`, `expire_claim`,
/// `resolve_dispute`, `cancel_task`). The counted party (worker / creator) is not the
/// signer that decides whether the account is supplied, so it cannot self-omit.
///
/// PDA seeds: ["agent_stats", agent]
#[account]
#[derive(Default, InitSpace)]
pub struct AgentStats {
    /// The `AgentRegistration` PDA these counters belong to (also the seed).
    pub agent: Pubkey,
    /// Times one of this agent's submissions was rejected for re-work
    /// (`reject_task_result`) or frozen for review (`reject_and_freeze`).
    pub tasks_rejected: u64,
    /// Disputes resolved in this agent's favor as the defendant worker.
    pub disputes_won: u64,
    /// Disputes resolved against this agent as the defendant worker (a loss; the
    /// slash-history signal).
    pub disputes_lost: u64,
    /// Claims by this agent that expired (no-show / abandoned) via `expire_claim`.
    pub claims_expired: u64,
    /// Tasks created by this agent (as the creator/buyer) that were cancelled.
    pub total_cancelled: u64,
    /// Last time any counter was updated (unix timestamp).
    pub last_updated: i64,
    /// PDA bump.
    pub bump: u8,
    /// Reserved for future track-record counters. MUST stay zeroed.
    pub _reserved: [u8; 32],
}

impl AgentStats {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8); // + 8 discriminator

    pub fn validate_reserved_fields(&self) -> bool {
        self._reserved == [0u8; 32]
    }

    /// Initialize the identity fields on first write (idempotent: only sets the
    /// agent/bump when the account was freshly created, leaving counters at zero).
    pub fn init_if_fresh(&mut self, agent: Pubkey, bump: u8) {
        if self.agent == Pubkey::default() {
            self.agent = agent;
            self.bump = bump;
            self._reserved = [0u8; 32];
        }
    }
}

/// Symmetric 25/25 completion bond (spec §8). Both the creator and the worker post
/// a bond equal to 25% of the reward into their own PDA; the loser of a dispute
/// forfeits theirs, the winner is refunded, and a no-show worker's bond is forfeited
/// to the creator on `expire_claim`. Kept in a DEDICATED PDA (never on `TaskClaim`,
/// which closes to the worker on exit and would auto-refund a no-show).
/// SOL-only in v1. PDA seeds: ["completion_bond", task, party] where `party` is the
/// SIGNING WALLET (creator wallet / worker authority), so the two sides get distinct
/// PDAs and one-bond-per-wallet-per-task is automatic.
#[account]
#[derive(Default, InitSpace)]
pub struct CompletionBond {
    /// Task this bond backs.
    pub task: Pubkey,
    /// Posting wallet (creator wallet for the creator bond, worker authority for the
    /// worker bond). Also the seed component and the rent/refund recipient.
    pub party: Pubkey,
    /// 0 = creator bond, 1 = worker bond (see `ROLE_CREATOR` / `ROLE_WORKER`).
    pub role: u8,
    /// Bonded principal in lamports (held as excess lamports on this PDA).
    pub amount: u64,
    /// Bond denomination. `None` = SOL (v1); SPL deferred behind a feature flag.
    pub bond_mint: Option<Pubkey>,
    /// Post timestamp.
    pub posted_at: i64,
    /// PDA bump.
    pub bump: u8,
    /// Reserved for future bond metadata. MUST stay zeroed.
    pub _reserved: [u8; 16],
}

impl CompletionBond {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8);
    pub const ROLE_CREATOR: u8 = 0;
    pub const ROLE_WORKER: u8 = 1;
    /// Bond rate: 25% of the reward (basis points), per the symmetric 25/25 design.
    pub const BOND_BPS: u64 = 2500;

    pub fn validate_reserved_fields(&self) -> bool {
        self._reserved == [0u8; 16]
    }
}

/// Roster entry authorizing a specific wallet to resolve disputes (the assignable
/// arbiter model). The protocol authority manages the roster via
/// `assign_dispute_resolver` / `revoke_dispute_resolver`. The mere existence of this
/// PDA authorizes its `resolver` to call `resolve_dispute`; closing it (revoke) removes
/// the authorization. A single assigned resolver decides a dispute directly — there is
/// NO vote tally or quorum on this path (that is the whole point of the model).
/// PDA seeds: ["dispute_resolver", resolver]
#[account]
#[derive(Default, InitSpace)]
pub struct DisputeResolver {
    /// The wallet authorized to resolve disputes.
    pub resolver: Pubkey,
    /// The protocol authority that assigned this resolver (audit trail).
    pub assigned_by: Pubkey,
    /// Unix timestamp the assignment was created.
    pub assigned_at: i64,
    /// PDA bump.
    pub bump: u8,
    // === P6.4 case counters — carved from the former `_reserved: [u8; 32]`. ===
    // These three scalars (8+8+8 = 24B) + the remaining 8 reserved bytes below total
    // exactly 32 bytes, so `DisputeResolver::SIZE` is UNCHANGED — this is a pure
    // value-into-reserved-space write, NOT a layout change and NOT a migration. The
    // pinned-size test `test_dispute_resolver_size_unchanged` enforces that the new
    // field set still serializes to the same byte count as the pre-P6.4 reserve.
    /// Disputes this resolver has decided through `resolve_dispute`.
    pub resolved_count: u64,
    /// Rulings later vacated/overturned. Has no on-chain incrementer yet: the
    /// challenge-window mechanism that would bump it (`execute_resolution` settling a
    /// pending outcome unless vacated) is the design-doc-only P6.4 step (3),
    /// `docs/DISPUTE_CHALLENGE_WINDOW.md`, gated `[HUMAN: approve before build]`. The
    /// field is reserved now so adding that mechanism later needs NO layout change.
    pub overturned_count: u64,
    /// Unix timestamp this resolver last decided a dispute (0 = never).
    pub last_resolved_at: i64,
    /// Reserved for future metadata. MUST stay zeroed.
    pub _reserved: [u8; 8],
}

impl DisputeResolver {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8);

    pub fn validate_reserved_fields(&self) -> bool {
        self._reserved == [0u8; 8]
    }
}

/// On-chain moderation attestation for a service listing's pinned job-spec hash.
///
/// The task-bound `TaskModeration` PDA (`["task_moderation", task, hash]`) cannot
/// exist before a task is minted, so it can't gate `hire_from_listing` at hire
/// time. This listing/spec-keyed attestation does: the moderation authority attests
/// the listing's `spec_hash` once, and the hire checks it. Recorded by
/// `record_listing_moderation`. PDA seeds: ["listing_moderation", service_listing, job_spec_hash]
#[account]
#[derive(Default, InitSpace)]
pub struct ListingModeration {
    /// Service listing this decision applies to.
    pub listing: Pubkey,
    /// Provider agent of the listing at decision time.
    pub provider_agent: Pubkey,
    /// Job-spec hash approved/held/rejected.
    pub job_spec_hash: [u8; HASH_SIZE],
    /// One of `task_moderation_status::*`.
    pub status: u8,
    /// Normalized 0-100 risk score.
    pub risk_score: u8,
    /// Bitmask of scanner categories.
    pub category_mask: u64,
    /// Hash of the moderation policy/threshold version.
    pub policy_hash: [u8; HASH_SIZE],
    /// Hash of the scanner/model version bundle.
    pub scanner_hash: [u8; HASH_SIZE],
    /// When the decision was recorded.
    pub recorded_at: i64,
    /// Optional expiry timestamp. Zero means no expiry.
    pub expires_at: i64,
    /// Signer that recorded the decision (the moderation authority).
    pub moderator: Pubkey,
    /// PDA bump.
    pub bump: u8,
    /// Reserved for future attestation metadata.
    pub _reserved: [u8; 7],
}

impl ListingModeration {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8);
}

/// Roster entry authorizing a third-party / per-integrator moderation attestor (P6.8).
///
/// Mirrors `DisputeResolver`: the protocol authority designates wallets that may record
/// moderation attestations (`record_task_moderation` / `record_listing_moderation`) in
/// addition to the single global `ModerationConfig.moderation_authority`. The PDA's mere
/// existence authorizes its `attestor`; revoking closes the PDA, after which that wallet
/// can no longer attest (the closed account fails to load). Re-assigning an already-listed
/// attestor fails at `init` (the PDA already exists), the desired "already assigned" signal.
///
/// NOTE: this is the registry MECHANISM only. The neutrality question (whether an
/// authority-curated roster is the right trust model, vs. a moderation-optional tier or
/// per-integrator attestor choice) is a deliberate, separate [HUMAN] decision documented in
/// `docs/MODERATION_NEUTRALITY.md`. This struct deliberately builds none of those options.
///
/// PDA seeds: ["moderation_attestor", attestor]
#[account]
#[derive(Default, InitSpace)]
pub struct ModerationAttestor {
    /// The wallet authorized to record moderation attestations.
    pub attestor: Pubkey,
    /// The protocol authority that assigned this attestor (audit trail).
    pub assigned_by: Pubkey,
    /// Unix timestamp the assignment was created.
    pub assigned_at: i64,
    /// PDA bump.
    pub bump: u8,
    /// Reserved for future metadata. MUST stay zeroed.
    pub _reserved: [u8; 32],
}

impl ModerationAttestor {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8);

    pub fn validate_reserved_fields(&self) -> bool {
        self._reserved == [0u8; 32]
    }
}

/// Maximum length of a verified domain name. A DNS name is at most 253 octets
/// (RFC 1035 §2.3.4 / RFC 1123), which bounds the `verified_domain` String.
pub const AGENT_VERIFICATION_DOMAIN_MAX: usize = 253;

/// Domain-control proof methods for `AgentVerification.method` (P7.3).
pub mod agent_verification_method {
    /// Operator proved control via a DNS `TXT` record on the domain.
    pub const TXT_RECORD: u8 = 0;
    /// Operator proved control via a `.well-known` file served over HTTPS.
    pub const WELL_KNOWN: u8 = 1;
}

/// `true` iff `method` is a recognized `agent_verification_method::*` variant.
pub fn is_valid_agent_verification_method(method: u8) -> bool {
    matches!(
        method,
        agent_verification_method::TXT_RECORD | agent_verification_method::WELL_KNOWN
    )
}

/// On-chain domain-verification attestation for an agent (P7.3).
///
/// A trusted attestor (the global moderation authority OR a registered, non-revoked
/// `ModerationAttestor`) records that operator domain `D` was proven to control agent
/// `A`. The off-chain proof (a DNS `TXT` record or `.well-known` file containing the
/// agent PDA + a signed challenge) is the attestor SERVICE's job; on-chain this account
/// only records the trusted attestor's verdict so `verified` + domain is trustlessly
/// readable. Re-verification overwrites the same PDA (`init_if_needed`); a revocation
/// marks `revoked = true`.
///
/// Authorization mirrors `record_*_moderation` EXACTLY (same trusted roster), so domain
/// verifications come from the same set of attestors that gate moderation.
///
/// PDA seeds: ["agent_verification", agent]
#[account]
#[derive(Default, InitSpace)]
pub struct AgentVerification {
    /// The `AgentRegistration` PDA this verification applies to.
    pub agent: Pubkey,
    /// The verified operator domain (DNS name, <= 253 octets). Lowercased ASCII.
    #[max_len(AGENT_VERIFICATION_DOMAIN_MAX)]
    pub verified_domain: String,
    /// Proof method: one of `agent_verification_method::*`.
    pub method: u8,
    /// The attestor/authority that recorded this verification.
    pub verified_by: Pubkey,
    /// When the verification was recorded.
    pub verified_at: i64,
    /// Optional expiry timestamp. Zero means no expiry.
    pub expires_at: i64,
    /// Whether this verification has been revoked (set by `revoke_agent_verification`).
    pub revoked: bool,
    /// PDA bump.
    pub bump: u8,
    /// Reserved for future verification metadata. MUST stay zeroed.
    pub _reserved: [u8; 32],
}

impl AgentVerification {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8);

    pub fn validate_reserved_fields(&self) -> bool {
        self._reserved == [0u8; 32]
    }
}

/// Validate a `verified_domain` string for `record_agent_verification`.
///
/// Enforces: non-empty, bounded length (<= `AGENT_VERIFICATION_DOMAIN_MAX`), and a basic
/// DNS-name charset (ASCII letters, digits, `-`, `.`; no leading/trailing dot, no empty
/// labels). The full RFC-compliant + control-proof check is the attestor SERVICE's job;
/// this is the on-chain sanity floor.
pub fn validate_verified_domain(domain: &str) -> bool {
    if domain.is_empty() || domain.len() > AGENT_VERIFICATION_DOMAIN_MAX {
        return false;
    }
    if domain.starts_with('.') || domain.ends_with('.') {
        return false;
    }
    let mut label_len = 0usize;
    for b in domain.bytes() {
        match b {
            b'.' => {
                // Empty label (e.g. "a..b") is invalid.
                if label_len == 0 {
                    return false;
                }
                label_len = 0;
            }
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' => {
                label_len = label_len.saturating_add(1);
                // A single DNS label is at most 63 octets.
                if label_len > 63 {
                    return false;
                }
            }
            _ => return false,
        }
    }
    // Final label must be non-empty (handled by trailing-dot check, but keep explicit).
    label_len > 0
}

/// Skill rating record (one per rater per skill)
/// PDA seeds: ["skill_rating", skill_pda, rater_agent_pda]
#[account]
#[derive(InitSpace)]
pub struct SkillRating {
    /// Skill being rated
    pub skill: Pubkey,
    /// Rater's agent PDA
    pub rater: Pubkey,
    /// Rating value (1-5)
    pub rating: u8,
    /// Optional review content hash
    pub review_hash: Option<[u8; 32]>,
    /// Rater's reputation at time of rating
    pub rater_reputation: u16,
    /// Rating timestamp
    pub timestamp: i64,
    /// Bump seed
    pub bump: u8,
    /// Reserved for future use
    pub _reserved: [u8; 4],
}

impl SkillRating {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8); // _reserved
}

/// Purchase record (one per buyer per skill, prevents double purchase)
/// PDA seeds: ["skill_purchase", skill_pda, buyer_agent_pda]
#[account]
#[derive(InitSpace)]
pub struct PurchaseRecord {
    /// Skill purchased
    pub skill: Pubkey,
    /// Buyer's agent PDA
    pub buyer: Pubkey,
    /// Price paid at time of purchase
    pub price_paid: u64,
    /// Purchase timestamp
    pub timestamp: i64,
    /// Bump seed
    pub bump: u8,
    /// Reserved for future use
    pub _reserved: [u8; 4],
}

impl PurchaseRecord {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8); // _reserved
}

/// Agent feed post (content hash stored on-chain, content on IPFS)
/// PDA seeds: ["post", author_agent_pda, nonce]
#[account]
#[derive(InitSpace)]
pub struct FeedPost {
    /// Author agent PDA
    pub author: Pubkey,
    /// IPFS content hash (CIDv1 or SHA-256 of content)
    pub content_hash: [u8; 32],
    /// Topic identifier (application-level grouping)
    pub topic: [u8; 32],
    /// Optional parent post PDA (for replies/threads)
    pub parent_post: Option<Pubkey>,
    /// Unique nonce (client-generated UUID)
    pub nonce: [u8; 32],
    /// Number of upvotes
    pub upvote_count: u32,
    /// Creation timestamp
    pub created_at: i64,
    /// Bump seed
    pub bump: u8,
    /// Reserved for future use
    pub _reserved: [u8; 8],
}

impl FeedPost {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8); // _reserved
}

/// Feed upvote record (one per voter per post, prevents double voting)
/// PDA seeds: ["upvote", post_pda, voter_agent_pda]
#[account]
#[derive(InitSpace)]
pub struct FeedVote {
    /// Post PDA that was upvoted
    pub post: Pubkey,
    /// Voter agent PDA
    pub voter: Pubkey,
    /// Vote timestamp
    pub timestamp: i64,
    /// Bump seed
    pub bump: u8,
    /// Reserved for future use
    pub _reserved: [u8; 4],
}

impl FeedVote {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8); // _reserved
}

// ============================================================================
// Reputation Economy
// ============================================================================

/// Reputation stake account — agent stakes SOL on their reputation.
/// SOL is stored as excess lamports on the PDA (same pattern as agent registration stake).
/// Account is never closed to preserve slash_count history (prevents reset exploit).
/// PDA seeds: ["reputation_stake", agent_pda]
#[account]
#[derive(Default, InitSpace)]
pub struct ReputationStake {
    /// Agent PDA this stake belongs to
    pub agent: Pubkey,
    /// SOL lamports currently staked
    pub staked_amount: u64,
    /// Timestamp before which withdrawals are blocked
    pub locked_until: i64,
    /// Historical count of slashes applied
    pub slash_count: u8,
    /// Account creation timestamp
    pub created_at: i64,
    /// Bump seed for PDA
    pub bump: u8,
    /// Reserved for future use
    pub _reserved: [u8; 8],
}

impl ReputationStake {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8); // _reserved
}

/// Reputation delegation — agent delegates reputation points to a trusted peer.
/// One delegation per (delegator, delegatee) pair. Revoke-and-redelegate pattern.
/// PDA seeds: ["reputation_delegation", delegator_pda, delegatee_pda]
#[account]
#[derive(Default, InitSpace)]
pub struct ReputationDelegation {
    /// Delegator agent PDA
    pub delegator: Pubkey,
    /// Delegatee agent PDA
    pub delegatee: Pubkey,
    /// Reputation points delegated (0-10000 scale)
    pub amount: u16,
    /// Expiration timestamp (0 = no expiry)
    pub expires_at: i64,
    /// Delegation creation timestamp
    pub created_at: i64,
    /// Bump seed for PDA
    pub bump: u8,
    /// Reserved for future use
    pub _reserved: [u8; 8],
}

impl ReputationDelegation {
    pub const SIZE: usize = <Self as anchor_lang::Space>::INIT_SPACE.saturating_add(8); // _reserved
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: SIZE should equal INIT_SPACE (borsh serialized) + 8-byte discriminator.
    /// Note: std::mem::size_of doesn't work here because Rust adds alignment padding
    /// that borsh serialization doesn't include.
    macro_rules! test_size_constant {
        ($struct:ty) => {
            assert_eq!(
                <$struct>::SIZE,
                <$struct as anchor_lang::Space>::INIT_SPACE + 8,
                concat!(stringify!($struct), "::SIZE mismatch with INIT_SPACE")
            );
        };
    }

    #[test]
    fn test_protocol_config_size() {
        test_size_constant!(ProtocolConfig);
    }

    #[test]
    fn test_agent_registration_size() {
        test_size_constant!(AgentRegistration);
    }

    #[test]
    fn test_authority_rate_limit_size() {
        test_size_constant!(AuthorityRateLimit);
    }

    #[test]
    fn test_zk_config_size() {
        test_size_constant!(ZkConfig);
    }

    #[test]
    fn test_task_size() {
        test_size_constant!(Task);
    }

    #[test]
    fn test_task_job_spec_size() {
        test_size_constant!(TaskJobSpec);
    }

    #[test]
    fn test_task_claim_size() {
        test_size_constant!(TaskClaim);
    }

    #[test]
    fn test_protocol_timing_profile_matches_build_mode() {
        #[cfg(feature = "validation-timings")]
        {
            assert_eq!(ProtocolConfig::DEFAULT_MAX_CLAIM_DURATION, 300);
            assert_eq!(ProtocolConfig::DEFAULT_MAX_DISPUTE_DURATION, 600);
            assert_eq!(ProtocolConfig::DEFAULT_VOTING_PERIOD, 300);
        }

        #[cfg(not(feature = "validation-timings"))]
        {
            assert_eq!(ProtocolConfig::DEFAULT_MAX_CLAIM_DURATION, 604_800);
            assert_eq!(ProtocolConfig::DEFAULT_MAX_DISPUTE_DURATION, 604_800);
            assert_eq!(ProtocolConfig::DEFAULT_VOTING_PERIOD, 86_400);
        }
    }

    #[test]
    fn test_coordination_state_size() {
        test_size_constant!(CoordinationState);
    }

    #[test]
    fn test_dispute_size() {
        test_size_constant!(Dispute);
    }

    /// P6.4: pins the `Dispute` layout APPEND (rationale_hash + rationale_uri +
    /// resolved_by). This is a layout change, NOT a migration: no live mainnet
    /// `Dispute` accounts exist (disputes are compiled out of the 25-instruction
    /// canary surface), so there is nothing to migrate; on devnet it is append-only.
    /// If a future edit reorders or drops one of the three appended fields, this guard
    /// fails loudly. The delta is computed from the field reserves themselves so it
    /// stays correct if `MAX_RATIONALE_URI_LEN` is re-tuned.
    #[test]
    fn test_dispute_size_p64_append() {
        // The three P6.4 fields: [u8;32] hash + (4-byte len prefix + max_len) String
        // + Pubkey resolver.
        let append_delta = 32 + (4 + Dispute::MAX_RATIONALE_URI_LEN) + 32;
        // Pre-P6.4 Dispute INIT_SPACE was 255 bytes (ending at `defendant: Pubkey`).
        const OLD_DISPUTE_INIT_SPACE: usize = 255;
        assert_eq!(
            <Dispute as anchor_lang::Space>::INIT_SPACE,
            OLD_DISPUTE_INIT_SPACE + append_delta,
            "Dispute must equal the pre-P6.4 prefix (255B) + the appended rationale/resolver fields"
        );
        assert_eq!(
            Dispute::MAX_RATIONALE_URI_LEN,
            256,
            "rationale_uri reserve must match its #[max_len(256)]"
        );
    }

    #[test]
    fn test_dispute_rationale_defaults_are_empty() {
        let d = Dispute::default();
        assert_eq!(d.rationale_hash, [0u8; 32], "fresh rationale_hash is zeroed");
        assert_eq!(d.rationale_uri, "", "fresh rationale_uri is empty");
        assert_eq!(
            d.resolved_by,
            Pubkey::default(),
            "fresh resolved_by is the default pubkey (unresolved)"
        );
    }

    // P6.3: `test_dispute_vote_size` / `test_authority_dispute_vote_size` removed with
    // the `DisputeVote` / `AuthorityDisputeVote` account types (vote machinery retired).

    #[test]
    fn test_task_escrow_size() {
        test_size_constant!(TaskEscrow);
    }

    #[test]
    fn test_bid_marketplace_config_size() {
        test_size_constant!(BidMarketplaceConfig);
    }

    #[test]
    fn test_bidder_market_state_size() {
        test_size_constant!(BidderMarketState);
    }

    #[test]
    fn test_task_bid_book_size() {
        test_size_constant!(TaskBidBook);
    }

    #[test]
    fn test_task_bid_size() {
        test_size_constant!(TaskBid);
    }

    #[test]
    fn test_speculation_bond_size() {
        test_size_constant!(SpeculationBond);
    }

    #[test]
    fn test_speculative_commitment_size() {
        test_size_constant!(SpeculativeCommitment);
    }

    #[test]
    fn test_binding_spend_size() {
        test_size_constant!(BindingSpend);
    }

    #[test]
    fn test_nullifier_spend_size() {
        test_size_constant!(NullifierSpend);
    }

    #[test]
    fn test_governance_config_size() {
        test_size_constant!(GovernanceConfig);
    }

    #[test]
    fn test_proposal_size() {
        test_size_constant!(Proposal);
    }

    #[test]
    fn test_governance_vote_size() {
        test_size_constant!(GovernanceVote);
    }

    #[test]
    fn test_skill_registration_size() {
        test_size_constant!(SkillRegistration);
    }

    #[test]
    fn test_skill_rating_size() {
        test_size_constant!(SkillRating);
    }

    #[test]
    fn test_service_listing_size() {
        test_size_constant!(ServiceListing);
    }

    #[test]
    fn test_hire_record_size() {
        test_size_constant!(HireRecord);
    }

    #[test]
    fn test_hire_rating_size() {
        test_size_constant!(HireRating);
    }

    #[test]
    fn test_agent_stats_size() {
        test_size_constant!(AgentStats);
    }

    #[test]
    fn test_agent_stats_init_if_fresh_is_idempotent() {
        let agent = Pubkey::new_unique();
        let mut stats = AgentStats::default();
        // Fresh: identity fields are set, counters stay zero.
        stats.init_if_fresh(agent, 7);
        assert_eq!(stats.agent, agent);
        assert_eq!(stats.bump, 7);
        assert_eq!(stats.tasks_rejected, 0);
        assert!(stats.validate_reserved_fields());

        // Already-initialized: a second call must NOT overwrite identity (idempotent).
        let other = Pubkey::new_unique();
        stats.tasks_rejected = 3;
        stats.init_if_fresh(other, 9);
        assert_eq!(stats.agent, agent, "agent must not be overwritten once set");
        assert_eq!(stats.bump, 7, "bump must not be overwritten once set");
        assert_eq!(stats.tasks_rejected, 3, "counters must be preserved");
    }

    #[test]
    fn test_listing_moderation_size() {
        test_size_constant!(ListingModeration);
    }

    #[test]
    fn test_moderation_attestor_size() {
        test_size_constant!(ModerationAttestor);
    }

    #[test]
    fn test_dispute_resolver_size() {
        test_size_constant!(DisputeResolver);
    }

    /// P6.4: carving `DisputeResolver`'s former 32 reserved bytes into
    /// `resolved_count: u64` (8) + `overturned_count: u64` (8) + `last_resolved_at: i64`
    /// (8) + `_reserved: [u8; 8]` (8) MUST keep the account's serialized size identical
    /// (8+8+8+8 = 32). This is a value-into-reserved-space write, NOT a layout change
    /// and NOT a migration. If a future edit changes the field set so the size moves,
    /// this guard fails before any account is mis-sized.
    #[test]
    fn test_dispute_resolver_size_unchanged() {
        // resolver(32) + assigned_by(32) + assigned_at(8) + bump(1) + the 32 bytes
        // formerly reserved, now resolved_count(8)+overturned_count(8)
        // +last_resolved_at(8)+_reserved(8).
        const EXPECTED_INIT_SPACE: usize = 32 + 32 + 8 + 1 + (8 + 8 + 8 + 8);
        assert_eq!(
            <DisputeResolver as anchor_lang::Space>::INIT_SPACE,
            EXPECTED_INIT_SPACE,
            "DisputeResolver size must be unchanged after carving the reserved bytes (no migration)"
        );
    }

    #[test]
    fn test_dispute_resolver_counters_default_to_zero() {
        let entry = DisputeResolver::default();
        assert_eq!(entry.resolved_count, 0);
        assert_eq!(entry.overturned_count, 0);
        assert_eq!(entry.last_resolved_at, 0);
        assert!(
            entry.validate_reserved_fields(),
            "a fresh DisputeResolver must have zeroed reserved bytes"
        );
    }

    #[test]
    fn test_moderation_attestor_reserved_default_is_zeroed() {
        let entry = ModerationAttestor::default();
        assert!(
            entry.validate_reserved_fields(),
            "a fresh ModerationAttestor must have zeroed reserved bytes"
        );
    }

    #[test]
    fn test_agent_verification_size() {
        test_size_constant!(AgentVerification);
    }

    #[test]
    fn test_agent_verification_reserved_default_is_zeroed() {
        let v = AgentVerification::default();
        assert!(
            v.validate_reserved_fields(),
            "a fresh AgentVerification must have zeroed reserved bytes"
        );
    }

    #[test]
    fn test_agent_verification_method_validity() {
        assert!(is_valid_agent_verification_method(
            agent_verification_method::TXT_RECORD
        ));
        assert!(is_valid_agent_verification_method(
            agent_verification_method::WELL_KNOWN
        ));
        assert!(!is_valid_agent_verification_method(2));
        assert!(!is_valid_agent_verification_method(255));
    }

    #[test]
    fn test_validate_verified_domain_accepts_clean_names() {
        assert!(validate_verified_domain("example.com"));
        assert!(validate_verified_domain("agent-1.operators.example.io"));
        assert!(validate_verified_domain("a.co"));
        assert!(validate_verified_domain("localhost"));
    }

    #[test]
    fn test_validate_verified_domain_rejects_empty() {
        assert!(!validate_verified_domain(""));
    }

    #[test]
    fn test_validate_verified_domain_rejects_too_long() {
        // 254 ASCII chars (one over the 253 cap), kept label-legal.
        let long = "a".repeat(63) + "." + &"b".repeat(63) + "." + &"c".repeat(63) + "." + &"d".repeat(62);
        assert_eq!(long.len(), 254);
        assert!(!validate_verified_domain(&long));
    }

    #[test]
    fn test_validate_verified_domain_rejects_bad_charset_and_shape() {
        assert!(!validate_verified_domain("exa mple.com")); // space
        assert!(!validate_verified_domain("under_score.com")); // underscore
        assert!(!validate_verified_domain("https://example.com")); // scheme/slashes
        assert!(!validate_verified_domain(".example.com")); // leading dot
        assert!(!validate_verified_domain("example.com.")); // trailing dot
        assert!(!validate_verified_domain("a..b")); // empty label
        // A label over 63 octets is rejected even within the 253 cap.
        let big_label = "a".repeat(64) + ".com";
        assert!(!validate_verified_domain(&big_label));
    }

    #[test]
    fn test_listing_state_from_u8() {
        // ListingState has no Debug derive, so match with `matches!`.
        assert!(matches!(ListingState::from_u8(0), Ok(ListingState::Active)));
        assert!(matches!(ListingState::from_u8(1), Ok(ListingState::Paused)));
        assert!(matches!(
            ListingState::from_u8(2),
            Ok(ListingState::Retired)
        ));
        assert!(ListingState::from_u8(3).is_err());
        assert!(ListingState::from_u8(255).is_err());
    }

    #[test]
    fn test_purchase_record_size() {
        test_size_constant!(PurchaseRecord);
    }

    #[test]
    fn test_feed_post_size() {
        test_size_constant!(FeedPost);
    }

    #[test]
    fn test_feed_vote_size() {
        test_size_constant!(FeedVote);
    }

    #[test]
    fn test_reputation_stake_size() {
        test_size_constant!(ReputationStake);
    }

    #[test]
    fn test_reputation_delegation_size() {
        test_size_constant!(ReputationDelegation);
    }

    #[test]
    fn test_task_status_allows_manual_validation_lifecycle_transitions() {
        assert!(TaskStatus::Open.can_transition_to(TaskStatus::Disputed));
        assert!(TaskStatus::InProgress.can_transition_to(TaskStatus::PendingValidation));
        assert!(TaskStatus::PendingValidation.can_transition_to(TaskStatus::PendingValidation));
        assert!(TaskStatus::PendingValidation.can_transition_to(TaskStatus::InProgress));
        assert!(TaskStatus::PendingValidation.can_transition_to(TaskStatus::Open));
        assert!(TaskStatus::PendingValidation.can_transition_to(TaskStatus::Completed));
        assert!(TaskStatus::PendingValidation.can_transition_to(TaskStatus::Disputed));
    }

    #[test]
    fn test_task_status_rejects_invalid_manual_validation_transitions() {
        assert!(!TaskStatus::Open.can_transition_to(TaskStatus::PendingValidation));
        assert!(!TaskStatus::Completed.can_transition_to(TaskStatus::Disputed));
        assert!(!TaskStatus::Completed.can_transition_to(TaskStatus::PendingValidation));
        assert!(!TaskStatus::Cancelled.can_transition_to(TaskStatus::InProgress));
    }

    #[test]
    fn test_task_status_reject_frozen_transitions() {
        // Allowed: PendingValidation -> RejectFrozen (terminal reject freezes for review),
        // and RejectFrozen -> Completed / Cancelled (review resolved or expired).
        assert!(TaskStatus::PendingValidation.can_transition_to(TaskStatus::RejectFrozen));
        assert!(TaskStatus::RejectFrozen.can_transition_to(TaskStatus::Completed));
        assert!(TaskStatus::RejectFrozen.can_transition_to(TaskStatus::Cancelled));
        // Rejected: a frozen task cannot reopen, and terminal states cannot freeze.
        assert!(!TaskStatus::RejectFrozen.can_transition_to(TaskStatus::InProgress));
        assert!(!TaskStatus::RejectFrozen.can_transition_to(TaskStatus::Open));
        assert!(!TaskStatus::RejectFrozen.can_transition_to(TaskStatus::PendingValidation));
        assert!(!TaskStatus::RejectFrozen.can_transition_to(TaskStatus::Disputed));
        assert!(!TaskStatus::Completed.can_transition_to(TaskStatus::RejectFrozen));
        assert!(!TaskStatus::Cancelled.can_transition_to(TaskStatus::RejectFrozen));
        assert!(!TaskStatus::InProgress.can_transition_to(TaskStatus::RejectFrozen));
    }

    #[test]
    fn test_agent_registration_reserved_fields_default_to_zero() {
        let agent = AgentRegistration::default();
        assert_eq!(agent._reserved, [0u8; 4]);
    }

    #[test]
    fn test_protocol_config_padding_defaults_to_zero() {
        let config = ProtocolConfig::default();
        assert!(!config.protocol_paused);
        assert_eq!(config.disabled_task_type_mask, 0);
    }

    #[test]
    fn test_agent_validate_reserved_fields_ok() {
        let agent = AgentRegistration::default();
        assert!(agent.validate_reserved_fields());
    }

    #[test]
    fn test_agent_validate_reserved_fields_corrupted() {
        let mut agent = AgentRegistration::default();
        agent._reserved[0] = 0xFF;
        assert!(!agent.validate_reserved_fields());
    }

    #[test]
    fn test_config_validate_padding_fields_ok() {
        let config = ProtocolConfig::default();
        assert!(config.validate_padding_fields());
    }

    #[test]
    fn test_config_validate_padding_fields_corrupted() {
        let mut config = ProtocolConfig::default();
        config.protocol_paused = true;
        assert!(config.validate_padding_fields());

        config.protocol_paused = false;
        config.disabled_task_type_mask = 0b0001_0000;
        assert!(!config.validate_padding_fields());
    }

    #[test]
    fn test_zk_config_reserved_fields_default_to_zero() {
        let config = ZkConfig::default();
        assert_eq!(config._reserved, [0u8; 31]);
    }

    #[test]
    fn test_zk_config_validate_reserved_fields_ok() {
        let config = ZkConfig::default();
        assert!(config.validate_reserved_fields());
    }

    #[test]
    fn test_zk_config_validate_reserved_fields_corrupted() {
        let mut config = ZkConfig::default();
        config._reserved[0] = 0xFF;
        assert!(!config.validate_reserved_fields());
    }

    // === Batch 2 Task layout (migration safety) ===

    #[test]
    fn test_task_size_pins() {
        // Runtime guard mirroring the compile-time const_assert. If a field add
        // changes the layout, the 149-task realloc (OLD_TASK_SIZE -> SIZE) breaks;
        // this fails loudly rather than silently bricking live accounts.
        assert_eq!(
            Task::OLD_TASK_SIZE,
            382,
            "OLD_TASK_SIZE is the migration precondition; do not change"
        );
        assert_eq!(
            Task::BATCH2_TASK_SIZE,
            432,
            "BATCH2_TASK_SIZE is the second migration precondition; do not change"
        );
        assert_eq!(
            Task::SIZE,
            466,
            "P6.2: Task grew by referrer(32)+referrer_fee_bps(2)=34 on top of Batch-2"
        );
        assert_eq!(
            Task::SIZE - Task::OLD_TASK_SIZE,
            84,
            "382B legacy task -> 466B realloc delta must be exactly +84 bytes"
        );
        assert_eq!(
            Task::SIZE - Task::BATCH2_TASK_SIZE,
            34,
            "432B Batch-2 task -> 466B realloc delta must be exactly +34 bytes"
        );
    }

    // === P6.5 ProtocolConfig layout (surface-versioning migration safety) ===

    #[test]
    fn test_protocol_config_size_pins() {
        // Runtime guard mirroring the compile-time const_assert. If a field add
        // changes the layout, the single-account realloc (OLD_CONFIG_SIZE -> SIZE)
        // breaks; this fails loudly rather than silently bricking the live config.
        assert_eq!(
            ProtocolConfig::OLD_CONFIG_SIZE,
            349,
            "OLD_CONFIG_SIZE is the migration precondition; do not change"
        );
        assert_eq!(
            ProtocolConfig::SIZE,
            351,
            "ProtocolConfig grew by surface_revision (u16) = 2 bytes"
        );
        assert_eq!(
            ProtocolConfig::SIZE - ProtocolConfig::OLD_CONFIG_SIZE,
            2,
            "realloc delta must be exactly +2 bytes"
        );
    }

    #[test]
    fn test_protocol_config_surface_revision_default_is_full() {
        // A freshly initialized config (full-surface deploy) advertises the full
        // surface; the live mainnet config is brought to 0 by migrate_protocol and
        // stamped later by an operator.
        let config = ProtocolConfig::default();
        assert_eq!(
            config.surface_revision,
            ProtocolConfig::SURFACE_REVISION_FULL
        );
        assert_eq!(ProtocolConfig::SURFACE_REVISION_FULL, 1);
    }

    #[test]
    fn test_task_reserved_fields_default_to_zero() {
        let task = Task::default();
        assert_eq!(task._reserved, [0u8; 16]);
        assert_eq!(task.operator, Pubkey::default());
        assert_eq!(task.operator_fee_bps, 0);
    }

    #[test]
    fn test_task_validate_reserved_fields_ok() {
        let task = Task::default();
        assert!(task.validate_reserved_fields());
    }

    #[test]
    fn test_task_validate_reserved_fields_corrupted() {
        let mut task = Task::default();
        task._reserved[0] = 0xFF;
        assert!(!task.validate_reserved_fields());
    }
}
