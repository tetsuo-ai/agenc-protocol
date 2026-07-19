//! Events emitted by the AgenC Coordination Protocol
//!
//! These events can be monitored via WebSocket subscriptions
//! for real-time coordination between agents.

use crate::state::HASH_SIZE;
use anchor_lang::prelude::*;

/// Dispute resolution outcome constants (fix #425)
///
/// These distinguish how a dispute was resolved, enabling consumers
/// to differentiate between active rejection and default behavior.
pub mod dispute_outcome {
    /// The authorized resolver ruled to reject (P6.3: `approve = false` — creator refunded).
    pub const REJECTED: u8 = 0;
    /// The authorized resolver ruled to approve (P6.3: `approve = true`).
    pub const APPROVED: u8 = 1;
    /// DEPRECATED (P6.3): the arbiter vote/quorum model is retired, so a dispute can no
    /// longer resolve via "no votes cast → default rejection". `resolve_dispute` only ever
    /// emits REJECTED/APPROVED now. Retained for API stability; never emitted.
    pub const NO_VOTE_DEFAULT: u8 = 2;
}

/// Emitted when a new agent registers
#[event]
pub struct AgentRegistered {
    pub agent_id: [u8; 32],
    pub authority: Pubkey,
    pub capabilities: u64,
    pub endpoint: String,
    pub stake_amount: u64,
    pub timestamp: i64,
}

/// Emitted when an agent updates its registration
#[event]
pub struct AgentUpdated {
    pub agent_id: [u8; 32],
    pub capabilities: u64,
    pub status: u8,
    pub timestamp: i64,
}

/// Emitted when an agent is suspended by the protocol authority (fix #819)
#[event]
pub struct AgentSuspended {
    pub agent_id: [u8; 32],
    pub authority: Pubkey,
    pub timestamp: i64,
}

/// Emitted when an agent is unsuspended by the protocol authority (fix #819)
#[event]
pub struct AgentUnsuspended {
    pub agent_id: [u8; 32],
    pub authority: Pubkey,
    pub timestamp: i64,
}

/// Emitted when an agent deregisters
#[event]
pub struct AgentDeregistered {
    pub agent_id: [u8; 32],
    pub authority: Pubkey,
    pub timestamp: i64,
}

/// Emitted when a new task is created
#[event]
pub struct TaskCreated {
    pub task_id: [u8; 32],
    pub creator: Pubkey,
    pub required_capabilities: u64,
    pub reward_amount: u64,
    pub task_type: u8,
    pub deadline: i64,
    pub min_reputation: u16,
    /// SPL token mint for reward denomination (None = SOL)
    pub reward_mint: Option<Pubkey>,
    pub timestamp: i64,
}

/// Emitted when a task's full off-chain job specification pointer is set.
#[event]
pub struct TaskJobSpecSet {
    pub task: Pubkey,
    pub creator: Pubkey,
    pub job_spec_hash: [u8; HASH_SIZE],
    pub job_spec_uri: String,
    /// WP-A1 roster telemetry: the registered `ModerationAttestor` wallet whose
    /// attestation unlocked this publish, or `None` when the task-moderation was
    /// authored by the global `ModerationConfig.moderation_authority`.
    pub moderation_attestor: Option<Pubkey>,
    pub timestamp: i64,
}

/// Emitted when the global task moderation ingest gate is configured.
#[event]
pub struct TaskModerationConfigUpdated {
    pub authority: Pubkey,
    pub moderation_authority: Pubkey,
    pub enabled: bool,
    pub timestamp: i64,
}

/// Emitted when the moderation authority records a decision for a task/job-spec hash.
#[event]
pub struct TaskModerationRecorded {
    pub task: Pubkey,
    pub creator: Pubkey,
    pub job_spec_hash: [u8; HASH_SIZE],
    pub status: u8,
    pub risk_score: u8,
    pub category_mask: u64,
    pub policy_hash: [u8; HASH_SIZE],
    pub scanner_hash: [u8; HASH_SIZE],
    pub expires_at: i64,
    pub moderator: Pubkey,
    pub timestamp: i64,
}

/// Emitted when multisig launch controls are updated.
#[event]
pub struct LaunchControlsUpdated {
    pub authority: Pubkey,
    pub protocol_paused: bool,
    pub disabled_task_type_mask: u8,
    pub timestamp: i64,
}

/// Emitted only after the atomic release-boundary instruction has locked and
/// verified the reviewed executable metadata, IDL, singleton policy, and
/// upgrade-custody images in the same transaction as the surface stamp.
#[event]
pub struct ReleaseSurfaceStamped {
    pub authority: Pubkey,
    pub surface_revision: u16,
    pub disabled_task_type_mask: u8,
    pub program_data_slot: u64,
    /// Full pre-stamp ProtocolConfig account-data hash.
    pub protocol_config_hash: [u8; HASH_SIZE],
    pub bid_config_hash: [u8; HASH_SIZE],
    pub moderation_config_hash: [u8; HASH_SIZE],
    pub idl_account_hash: [u8; HASH_SIZE],
    pub custody_account_hash: [u8; HASH_SIZE],
    pub timestamp: i64,
}

/// Emitted when a task with dependencies is created
#[event]
pub struct DependentTaskCreated {
    pub task_id: [u8; 32],
    pub creator: Pubkey,
    pub depends_on: Pubkey,
    pub dependency_type: u8,
    /// SPL token mint for reward denomination (None = SOL)
    pub reward_mint: Option<Pubkey>,
    pub timestamp: i64,
}

/// Emitted when an agent claims a task
#[event]
pub struct TaskClaimed {
    pub task_id: [u8; 32],
    pub worker: Pubkey,
    pub current_workers: u8,
    pub max_workers: u8,
    pub timestamp: i64,
}

/// Emitted when a task is completed
#[event]
pub struct TaskCompleted {
    pub task_id: [u8; 32],
    pub worker: Pubkey,
    pub proof_hash: [u8; 32],
    pub result_data: [u8; 64],
    pub reward_paid: u64,
    pub timestamp: i64,
}

/// Emitted when Task Validation V2 is configured for a task.
#[event]
pub struct TaskValidationConfigured {
    pub task: Pubkey,
    pub creator: Pubkey,
    pub mode: u8,
    pub review_window_secs: i64,
    pub validator_quorum: u8,
    pub attestor: Option<Pubkey>,
    pub timestamp: i64,
}

/// Emitted when a worker submits a result for manual validation.
#[event]
pub struct TaskResultSubmitted {
    pub task: Pubkey,
    pub claim: Pubkey,
    pub worker: Pubkey,
    pub proof_hash: [u8; HASH_SIZE],
    pub result_data: [u8; 64],
    pub submission_count: u16,
    pub submitted_at: i64,
    pub review_deadline_at: i64,
}

/// Emitted when a manual-validation result is accepted.
#[event]
pub struct TaskResultAccepted {
    pub task: Pubkey,
    pub claim: Pubkey,
    pub worker: Pubkey,
    pub accepted_by: Pubkey,
    pub accepted_at: i64,
}

/// Emitted when a manual-validation result is rejected.
#[event]
pub struct TaskResultRejected {
    pub task: Pubkey,
    pub claim: Pubkey,
    pub worker: Pubkey,
    pub rejected_by: Pubkey,
    pub rejection_hash: [u8; HASH_SIZE],
    pub rejected_at: i64,
}

/// Emitted when a validator or attestor records an approval / rejection.
#[event]
pub struct TaskResultValidationRecorded {
    pub task: Pubkey,
    pub claim: Pubkey,
    pub reviewer: Pubkey,
    pub reviewer_agent: Pubkey,
    pub approved: bool,
    pub submission_count: u16,
    pub approval_count: u8,
    pub rejection_count: u8,
    pub recorded_at: i64,
}

/// Emitted when a task is cancelled
#[event]
pub struct TaskCancelled {
    pub task_id: [u8; 32],
    pub creator: Pubkey,
    pub refund_amount: u64,
    pub timestamp: i64,
}

/// Emitted when a terminal task's account rent is reclaimed via close_task.
#[event]
pub struct TaskClosed {
    pub task_id: [u8; 32],
    pub creator: Pubkey,
    /// Terminal status at close time (`TaskStatus` repr: 3=Completed, 4=Cancelled).
    pub status: u8,
    /// Whether a leftover job-spec pointer was closed in the same transaction.
    pub job_spec_closed: bool,
    /// Whether a still-alive (expire_dispute) escrow PDA was closed in the same tx.
    pub escrow_closed: bool,
    /// Whether a hire link was closed (and its listing's capacity slot freed).
    pub hire_record_closed: bool,
    pub timestamp: i64,
}

/// Emitted when Marketplace V2 configuration is initialized.
#[event]
pub struct BidMarketplaceInitialized {
    pub authority: Pubkey,
    pub min_bid_bond_lamports: u64,
    pub bid_creation_cooldown_secs: i64,
    pub max_bids_per_24h: u16,
    pub max_active_bids_per_task: u16,
    pub max_bid_lifetime_secs: i64,
    pub accepted_no_show_slash_bps: u16,
    pub timestamp: i64,
}

/// Emitted when a bid book is initialized for a task.
#[event]
pub struct BidBookInitialized {
    pub task: Pubkey,
    pub bid_book: Pubkey,
    pub state: u8,
    pub policy: u8,
    pub book_version: u64,
    pub timestamp: i64,
}

/// Emitted when a bid is created.
#[event]
pub struct BidCreated {
    pub task: Pubkey,
    pub bid: Pubkey,
    pub bidder: Pubkey,
    pub bid_book: Pubkey,
    pub book_version: u64,
    pub requested_reward_lamports: u64,
    pub eta_seconds: u32,
    pub expires_at: i64,
    pub timestamp: i64,
}

/// Emitted when a bid is updated.
#[event]
pub struct BidUpdated {
    pub task: Pubkey,
    pub bid: Pubkey,
    pub bidder: Pubkey,
    pub bid_book: Pubkey,
    pub book_version: u64,
    pub requested_reward_lamports: u64,
    pub eta_seconds: u32,
    pub expires_at: i64,
    pub timestamp: i64,
}

/// Emitted when a bid is accepted.
#[event]
pub struct BidAccepted {
    pub task: Pubkey,
    pub bid: Pubkey,
    pub bidder: Pubkey,
    pub bid_book: Pubkey,
    pub book_version: u64,
    pub policy: u8,
    pub timestamp: i64,
}

/// Emitted when a parked or open bid is cancelled.
#[event]
pub struct BidCancelled {
    pub task: Pubkey,
    pub bid: Pubkey,
    pub bidder: Pubkey,
    pub bid_book: Pubkey,
    pub book_version: u64,
    pub timestamp: i64,
}

/// Emitted when a bid is expired and cleaned up.
#[event]
pub struct BidExpired {
    pub task: Pubkey,
    pub bid: Pubkey,
    pub bidder: Pubkey,
    pub bid_book: Pubkey,
    pub book_version: u64,
    pub timestamp: i64,
}

/// Emitted when coordination state is updated
#[event]
pub struct StateUpdated {
    pub state_key: [u8; 32],
    pub state_value: [u8; 64],
    pub updater: Pubkey,
    pub version: u64,
    pub timestamp: i64,
}

/// Emitted when a dispute is initiated
#[event]
pub struct DisputeInitiated {
    pub dispute_id: [u8; 32],
    pub task_id: [u8; 32],
    pub initiator: Pubkey,
    /// The defendant worker's agent PDA (fix #827)
    pub defendant: Pubkey,
    pub resolution_type: u8,
    pub voting_deadline: i64,
    pub timestamp: i64,
}

// P6.3: `DisputeVoteCast` removed with `vote_dispute` — the per-case arbiter
// vote/quorum model is retired. An authorized resolver (threshold-approved protocol
// authority or threshold-seated assigned resolver) decides, not a tally.

/// Emitted when a dispute is cancelled by its initiator (fix #587)
#[event]
pub struct DisputeCancelled {
    pub dispute_id: [u8; 32],
    pub task: Pubkey,
    pub initiator: Pubkey,
    pub cancelled_at: i64,
}

/// Emitted when a dispute is resolved
///
/// The `outcome` field reflects the authorized resolver's binary ruling (P6.3 — the
/// per-case arbiter vote/quorum model is retired):
/// - 0 = Rejected (the resolver passed `approve = false` — creator refunded)
/// - 1 = Approved (the resolver passed `approve = true` — initiator's resolution upheld)
///
/// `votes_for`/`votes_against` are DEPRECATED: they are no longer a vote tally. P6.3
/// reuses them as a 1-bit ruling record ((1,0)=approved, (0,1)=rejected) so the
/// permissionless slash finalizers can read the decision; the fields are emitted as-is.
#[event]
pub struct DisputeResolved {
    pub dispute_id: [u8; 32],
    pub resolution_type: u8,
    /// Resolution outcome: 0=Rejected, 1=Approved (P6.3: no more NoVoteDefault path).
    pub outcome: u8,
    /// DEPRECATED (P6.3): ruling bit, not a vote tally — 1 when approved else 0.
    pub votes_for: u64,
    /// DEPRECATED (P6.3): ruling bit, not a vote tally — 1 when rejected else 0.
    pub votes_against: u64,
    pub timestamp: i64,
    /// P6.4 accountable rulings: the wallet that decided this dispute (the protocol
    /// authority with M-of-N approval OR the threshold-seated assigned resolver).
    pub resolved_by: Pubkey,
    /// P6.4: 32-byte content hash of the off-chain ruling rationale.
    pub rationale_hash: [u8; 32],
}

/// Emitted after an authority-proposed resolver assignment receives configured M-of-N
/// approval.
#[event]
pub struct DisputeResolverAssigned {
    pub resolver: Pubkey,
    pub assigned_by: Pubkey,
    pub timestamp: i64,
}

/// Emitted after an authority-proposed resolver revocation receives configured M-of-N
/// approval.
#[event]
pub struct DisputeResolverRevoked {
    pub resolver: Pubkey,
    pub revoked_by: Pubkey,
    pub timestamp: i64,
}

/// Emitted when the protocol authority assigns a wallet to the moderation-attestor roster (P6.8).
#[event]
pub struct ModerationAttestorAssigned {
    pub attestor: Pubkey,
    pub assigned_by: Pubkey,
    pub timestamp: i64,
}

/// Emitted when the protocol authority revokes a wallet from the moderation-attestor roster (P6.8).
#[event]
pub struct ModerationAttestorRevoked {
    pub attestor: Pubkey,
    pub revoked_by: Pubkey,
    pub timestamp: i64,
}

/// Emitted when a wallet self-registers onto the open moderation-attestor roster
/// (P1.2). `bond_lamports` is the hardcoded registration bond deposited on the PDA.
#[event]
pub struct ModerationAttestorRegistered {
    pub attestor: Pubkey,
    pub bond_lamports: u64,
    pub timestamp: i64,
}

/// Emitted when an attestor starts its two-step exit (P1.2). From this moment the
/// attestor is rejected at the record and consumption gates; the bond refunds at
/// finalize after the cooldown.
#[event]
pub struct AttestorExitRequested {
    pub attestor: Pubkey,
    pub exit_at: i64,
    pub timestamp: i64,
}

/// Emitted when an attestor exit finalizes and the roster PDA closes, refunding
/// bond + rent to the attestor in full (P1.2 — never confiscatable).
#[event]
pub struct AttestorExitFinalized {
    pub attestor: Pubkey,
    pub refunded_lamports: u64,
    pub timestamp: i64,
}

/// Emitted when the multisig sets (or re-sets) the BLOCK-only takedown floor for a
/// content hash (P1.2 §5.2). The rationale is REQUIRED — the discretionary takedown
/// lever is bounded by an auditable, content-addressed record.
#[event]
pub struct ModerationBlockSet {
    pub content_hash: [u8; 32],
    pub rationale_hash: [u8; 32],
    pub rationale_uri: String,
    pub updated_by: Pubkey,
    pub timestamp: i64,
}

/// Emitted when the multisig clears a takedown block (P1.2 §5.2). The account stays
/// open as the audit trail; the hash is consumable again at the gates.
#[event]
pub struct ModerationBlockCleared {
    pub content_hash: [u8; 32],
    pub updated_by: Pubkey,
    pub timestamp: i64,
}

/// Emitted when the multisig updates the on-chain default trusted-attestor list
/// pointer (P1.2 §5.1). `version` is monotonic; `timestamp` doubles as the deadman.
#[event]
pub struct DefaultTrustListUpdated {
    pub list_hash: [u8; 32],
    pub list_uri: String,
    pub version: u64,
    pub updated_by: Pubkey,
    pub timestamp: i64,
}

/// Emitted when a trusted attestor records a domain-verification attestation for an
/// agent (P7.3). `verified_by` is the recording attestor/authority.
#[event]
pub struct AgentVerified {
    pub agent: Pubkey,
    pub verified_domain: String,
    pub method: u8,
    pub verified_by: Pubkey,
    pub verified_at: i64,
    pub expires_at: i64,
    pub timestamp: i64,
}

/// Emitted when a trusted attestor revokes an agent's domain verification (P7.3).
#[event]
pub struct AgentVerificationRevoked {
    pub agent: Pubkey,
    pub revoked_by: Pubkey,
    pub timestamp: i64,
}

/// Emitted when a dispute expires without resolution
/// Updated in fix #418 to include fair distribution details
#[event]
pub struct DisputeExpired {
    pub dispute_id: [u8; 32],
    pub task_id: [u8; 32],
    pub refund_amount: u64,
    /// Amount refunded to creator (fix #418)
    pub creator_amount: u64,
    /// Amount paid to worker (fix #418)
    pub worker_amount: u64,
    pub timestamp: i64,
}

/// Emitted when protocol is initialized
#[event]
pub struct ProtocolInitialized {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub dispute_threshold: u8,
    pub protocol_fee_bps: u16,
    pub timestamp: i64,
}

/// Emitted when protocol treasury is updated via multisig governance.
#[event]
pub struct TreasuryUpdated {
    pub old_treasury: Pubkey,
    pub new_treasury: Pubkey,
    pub updated_by: Pubkey,
    pub timestamp: i64,
}

/// Emitted when the trusted ZK image ID config is initialized.
#[cfg(feature = "private-zk")]
#[event]
pub struct ZkConfigInitialized {
    pub image_id: [u8; HASH_SIZE],
    pub authority: Pubkey,
    pub timestamp: i64,
}

/// Emitted when the trusted ZK image ID is rotated.
#[cfg(feature = "private-zk")]
#[event]
pub struct ZkImageIdUpdated {
    pub old_image_id: [u8; HASH_SIZE],
    pub new_image_id: [u8; HASH_SIZE],
    pub updated_by: Pubkey,
    pub timestamp: i64,
}

/// Emitted when multisig signer set or threshold is updated.
#[event]
pub struct MultisigUpdated {
    pub old_threshold: u8,
    pub new_threshold: u8,
    pub old_owner_count: u8,
    pub new_owner_count: u8,
    pub updated_by: Pubkey,
    pub timestamp: i64,
}

/// Emitted for reward distribution
#[event]
pub struct RewardDistributed {
    pub task_id: [u8; 32],
    pub recipient: Pubkey,
    pub amount: u64,
    pub protocol_fee: u64,
    pub timestamp: i64,
}

/// Emitted when an operator (embedding-site) fee leg is paid out of a settlement
/// (spec §4 3-way split). Only emitted when the operator leg is non-zero.
#[event]
pub struct OperatorFeePaid {
    pub task_id: [u8; 32],
    pub operator: Pubkey,
    pub amount: u64,
    pub operator_fee_bps: u16,
    pub timestamp: i64,
}

/// Emitted when a referrer (demand-side embedder) fee leg is paid out of a
/// settlement (spec §4 4-way split, P6.2). Only emitted when the referrer leg is
/// non-zero.
#[event]
pub struct ReferrerFeePaid {
    pub task_id: [u8; 32],
    pub referrer: Pubkey,
    pub amount: u64,
    pub referrer_fee_bps: u16,
    pub timestamp: i64,
}

/// Emitted when a rate limit is hit
#[event]
pub struct RateLimitHit {
    pub agent_id: [u8; 32],
    pub action_type: u8, // 0 = task_creation, 1 = dispute_initiation
    pub limit_type: u8,  // 0 = cooldown, 1 = 24h_window
    pub current_count: u8,
    pub max_count: u8,
    pub cooldown_remaining: i64,
    pub timestamp: i64,
}

/// Emitted when protocol migration is completed
#[event]
pub struct MigrationCompleted {
    pub from_version: u8,
    pub to_version: u8,
    pub authority: Pubkey,
    pub timestamp: i64,
}

/// Emitted when a single Task account is reallocated to the Batch-2 layout.
#[event]
pub struct TaskMigrated {
    pub task: Pubkey,
    pub from_size: u32,
    pub to_size: u32,
    pub authority: Pubkey,
    pub timestamp: i64,
}

/// Emitted when the ProtocolConfig account is reallocated to the P6.5
/// surface-versioning layout (349B -> 351B, zero-init `surface_revision`).
#[event]
pub struct ProtocolConfigMigrated {
    pub config: Pubkey,
    pub from_size: u32,
    pub to_size: u32,
    pub authority: Pubkey,
    pub timestamp: i64,
}

/// Emitted when a completion bond is posted (Batch 3 §8).
#[event]
pub struct BondPosted {
    pub task: Pubkey,
    pub party: Pubkey,
    pub role: u8,
    pub amount: u64,
    pub timestamp: i64,
}

/// Emitted when a completion bond is refunded to its poster.
#[event]
pub struct BondRefunded {
    pub task: Pubkey,
    pub party: Pubkey,
    pub role: u8,
    pub amount: u64,
    pub timestamp: i64,
}

/// Emitted when a completion bond's principal is forfeited (to the creator or treasury).
#[event]
pub struct BondForfeited {
    pub task: Pubkey,
    pub party: Pubkey,
    pub role: u8,
    pub amount: u64,
    pub recipient: Pubkey,
    pub timestamp: i64,
}

/// Emitted when a creator requests free, non-terminal revisions (Batch 3 §8).
#[event]
pub struct TaskChangesRequested {
    pub task: Pubkey,
    pub claim: Pubkey,
    pub worker: Pubkey,
    pub round: u16,
    pub timestamp: i64,
}

/// Emitted when a submission is terminally rejected and frozen for review.
#[event]
pub struct TaskRejectFrozen {
    pub task: Pubkey,
    pub claim: Pubkey,
    pub worker: Pubkey,
    pub rejection_hash: [u8; 32],
    pub review_deadline_at: i64,
    pub timestamp: i64,
}

/// Emitted when a frozen task's review is resolved (Completed or Cancelled).
#[event]
pub struct RejectFrozenResolved {
    pub task: Pubkey,
    pub outcome: u8, // 1 = Completed (pay worker), 0 = Cancelled (refund creator)
    pub timestamp: i64,
}

/// Emitted when a frozen task's review window expires and it defaults to the worker.
#[event]
pub struct RejectFrozenExpired {
    pub task: Pubkey,
    pub worker_payout: u64,
    pub timestamp: i64,
}

/// Emitted when protocol version is updated
#[event]
pub struct ProtocolVersionUpdated {
    pub old_version: u8,
    pub new_version: u8,
    pub min_supported_version: u8,
    pub timestamp: i64,
}

// P6.3: `ArbiterVotesCleanedUp` removed — `expire_dispute` no longer cleans up arbiter
// vote PDAs (none are ever created after the vote/quorum model was retired).

/// Emitted when rate limit configuration is updated
#[event]
pub struct RateLimitsUpdated {
    pub task_creation_cooldown: i64,
    pub max_tasks_per_24h: u8,
    pub dispute_initiation_cooldown: i64,
    pub max_disputes_per_24h: u8,
    pub min_stake_for_dispute: u64,
    pub updated_by: Pubkey,
    pub timestamp: i64,
}

/// Emitted when protocol fee is updated
#[event]
pub struct ProtocolFeeUpdated {
    pub old_fee_bps: u16,
    pub new_fee_bps: u16,
    pub updated_by: Pubkey,
    pub timestamp: i64,
}

// ============================================================================
// Governance events
// ============================================================================

/// Emitted when governance configuration is initialized
#[event]
pub struct GovernanceInitialized {
    pub authority: Pubkey,
    pub voting_period: i64,
    pub execution_delay: i64,
    pub quorum_bps: u16,
    pub approval_threshold_bps: u16,
    pub timestamp: i64,
}

/// Emitted when a governance proposal is created
#[event]
pub struct ProposalCreated {
    pub proposer: Pubkey,
    pub proposal_type: u8,
    pub title_hash: [u8; 32],
    pub voting_deadline: i64,
    pub quorum: u64,
    pub timestamp: i64,
}

/// Emitted when a vote is cast on a governance proposal
#[event]
pub struct GovernanceVoteCast {
    pub proposal: Pubkey,
    pub voter: Pubkey,
    pub approved: bool,
    pub vote_weight: u64,
    pub votes_for: u64,
    pub votes_against: u64,
    pub timestamp: i64,
}

/// Emitted when a governance proposal is executed
#[event]
pub struct ProposalExecuted {
    pub proposal: Pubkey,
    pub proposal_type: u8,
    pub votes_for: u64,
    pub votes_against: u64,
    pub total_voters: u16,
    pub timestamp: i64,
}

/// Emitted when a governance proposal is cancelled
#[event]
pub struct ProposalCancelled {
    pub proposal: Pubkey,
    pub proposer: Pubkey,
    pub timestamp: i64,
}

/// Reason codes for reputation changes
pub mod reputation_reason {
    /// Reputation increased from task completion
    pub const COMPLETION: u8 = 0;
    /// Reputation decreased from losing a dispute
    pub const DISPUTE_SLASH: u8 = 1;
    /// Reputation decreased from inactivity decay
    pub const DECAY: u8 = 2;
}

/// Emitted when an agent's reputation changes
#[event]
pub struct ReputationChanged {
    pub agent_id: [u8; 32],
    pub old_reputation: u16,
    pub new_reputation: u16,
    /// Reason: 0=completion, 1=dispute_slash, 2=decay
    pub reason: u8,
    pub timestamp: i64,
}

// ============================================================================
// Skill registry events
// ============================================================================

/// Emitted when a new skill is registered
#[event]
pub struct SkillRegistered {
    pub skill: Pubkey,
    pub author: Pubkey,
    pub skill_id: [u8; 32],
    pub name: [u8; 32],
    pub content_hash: [u8; 32],
    pub price: u64,
    pub price_mint: Option<Pubkey>,
    pub timestamp: i64,
}

/// Emitted when a skill is updated by its author
#[event]
pub struct SkillUpdated {
    pub skill: Pubkey,
    pub author: Pubkey,
    pub content_hash: [u8; 32],
    pub price: u64,
    pub version: u8,
    pub timestamp: i64,
}

/// Emitted when a maker publishes a standing service listing
#[event]
pub struct ServiceListingCreated {
    pub listing: Pubkey,
    pub provider_agent: Pubkey,
    pub authority: Pubkey,
    pub listing_id: [u8; 32],
    pub price: u64,
    pub price_mint: Option<Pubkey>,
    pub operator: Pubkey,
    pub operator_fee_bps: u16,
    pub timestamp: i64,
}

/// Emitted when a service listing's terms are updated
#[event]
pub struct ServiceListingUpdated {
    pub listing: Pubkey,
    pub authority: Pubkey,
    pub price: u64,
    pub operator_fee_bps: u16,
    pub version: u64,
    pub timestamp: i64,
}

/// Emitted when a service listing's lifecycle state changes (pause/reactivate/retire)
#[event]
pub struct ServiceListingStateChanged {
    pub listing: Pubkey,
    pub authority: Pubkey,
    pub new_state: u8,
    pub timestamp: i64,
}

/// Emitted when the moderation authority records a decision for a listing/spec hash.
#[event]
pub struct ListingModerationRecorded {
    pub listing: Pubkey,
    pub provider_agent: Pubkey,
    pub job_spec_hash: [u8; HASH_SIZE],
    pub status: u8,
    pub risk_score: u8,
    pub expires_at: i64,
    pub moderator: Pubkey,
    pub timestamp: i64,
}

/// Emitted when a buyer hires a provider from a standing service listing,
/// minting a one-shot task. Links the source listing to the new task.
#[event]
pub struct ServiceListingHired {
    pub listing: Pubkey,
    pub task: Pubkey,
    pub provider_agent: Pubkey,
    pub buyer: Pubkey,
    pub price: u64,
    pub total_hires: u64,
    /// Concurrent open hires after this one (capacity counter).
    pub open_jobs: u16,
    /// WP-A1 roster telemetry: the registered `ModerationAttestor` wallet whose
    /// listing attestation unlocked this hire, or `None` when the listing-moderation
    /// was authored by the global `ModerationConfig.moderation_authority` (or when
    /// moderation is disabled).
    pub moderation_attestor: Option<Pubkey>,
    pub timestamp: i64,
}

/// Emitted when a skill is rated by another agent
#[event]
pub struct SkillRated {
    pub skill: Pubkey,
    pub rater: Pubkey,
    pub rating: u8,
    pub rater_reputation: u16,
    pub new_total_rating: u64,
    pub new_rating_count: u32,
    pub timestamp: i64,
}

/// Emitted when a skill is purchased
#[event]
pub struct SkillPurchased {
    pub skill: Pubkey,
    pub buyer: Pubkey,
    pub author: Pubkey,
    pub content_hash: [u8; 32],
    pub content_version: u8,
    pub price_paid: u64,
    pub protocol_fee: u64,
    pub timestamp: i64,
}

// ============================================================================
// Feed events
// ============================================================================

/// Emitted when an agent creates a feed post
#[event]
pub struct PostCreated {
    pub post: Pubkey,
    pub author: Pubkey,
    pub content_hash: [u8; 32],
    pub topic: [u8; 32],
    pub parent_post: Option<Pubkey>,
    pub timestamp: i64,
}

/// Emitted when a feed post is upvoted
#[event]
pub struct PostUpvoted {
    pub post: Pubkey,
    pub voter: Pubkey,
    pub new_upvote_count: u32,
    pub timestamp: i64,
}

// ============================================================================
// Reputation economy events
// ============================================================================

/// Emitted when an agent stakes SOL on their reputation
#[event]
pub struct ReputationStaked {
    pub agent: Pubkey,
    pub amount: u64,
    pub total_staked: u64,
    pub locked_until: i64,
    pub timestamp: i64,
}

/// Emitted when an agent withdraws staked SOL
#[event]
pub struct ReputationStakeWithdrawn {
    pub agent: Pubkey,
    pub amount: u64,
    pub remaining_staked: u64,
    pub timestamp: i64,
}

/// Emitted when a reputation delegation is revoked
#[event]
pub struct ReputationDelegationRevoked {
    pub delegator: Pubkey,
    pub delegatee: Pubkey,
    pub amount: u16,
    pub timestamp: i64,
}

/// Emitted when revision 5 permanently retires a legacy delegation. Reputation
/// is never restored because doing so after a slash would recreate the retired
/// shelter primitive. Rent goes to the recorded authority only for an
/// identity-continuous registration; otherwise it goes to the canonical treasury.
#[event]
pub struct ReputationDelegationRetired {
    pub delegation: Pubkey,
    pub delegator: Pubkey,
    pub delegatee: Pubkey,
    pub discarded_reputation: u16,
    pub recovered_rent: u64,
    pub rent_recipient: Pubkey,
    pub identity_continuous: bool,
    pub timestamp: i64,
}

/// Emitted when a buyer rates a completed listing hire (P6.1). Carries the new
/// listing aggregate so indexers can recompute the average without re-reading the
/// account. The provider-agent rating aggregate is deferred to P6.6's `AgentStats`.
#[event]
pub struct ListingRated {
    /// Service listing whose aggregate was updated.
    pub listing: Pubkey,
    /// The hired task that was rated.
    pub task: Pubkey,
    /// Provider agent of the listing.
    pub provider_agent: Pubkey,
    /// The buyer (task creator) that authored the rating.
    pub buyer: Pubkey,
    /// Score in [1, 5].
    pub score: u8,
    /// `listing.total_rating` after this rating.
    pub new_total_rating: u64,
    /// `listing.rating_count` after this rating.
    pub new_rating_count: u32,
    pub timestamp: i64,
}

/// Which negative / non-success track-record counter was bumped (P6.6). Keeps the
/// `AgentTrackRecordUpdated` event self-describing for indexers without re-reading
/// the `AgentStats` account.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum TrackRecordCounter {
    /// A submission was rejected for re-work or frozen for review.
    TasksRejected,
    /// A dispute resolved in the defendant worker's favor.
    DisputesWon,
    /// A dispute resolved against the defendant worker (a slash-history loss).
    DisputesLost,
    /// A claim expired (no-show / abandoned).
    ClaimsExpired,
    /// A created task was cancelled.
    TotalCancelled,
}

/// Emitted whenever a track-record counter on `AgentStats` is incremented (P6.6).
/// `new_value` is the post-increment counter so indexers can build a slash/outcome
/// history from the event stream alone (feeds the SDK `getAgentTrackRecord`).
#[event]
pub struct AgentTrackRecordUpdated {
    /// The `AgentRegistration` PDA whose track record changed.
    pub agent: Pubkey,
    /// The `AgentStats` PDA that was written.
    pub agent_stats: Pubkey,
    /// Which counter was incremented.
    pub counter: TrackRecordCounter,
    /// The counter's value AFTER this increment.
    pub new_value: u64,
    pub timestamp: i64,
}

// ============================================================================
// Batch 2 events (P5.2 store identity, P1.3 moderation liveness)
// ============================================================================

/// Emitted when a store registers its on-chain identity (P5.2).
#[event]
pub struct StoreRegistered {
    /// The `["store", owner]` PDA.
    pub store: Pubkey,
    /// Owner wallet (the identity key).
    pub owner: Pubkey,
    /// Display handle (zero-padded; NOT unique on-chain).
    pub handle: [u8; 32],
    /// Registration bond deposited on the PDA.
    pub bond_lamports: u64,
    pub timestamp: i64,
}

/// Emitted when a store updates its advertised identity/terms (P5.2).
#[event]
pub struct StoreUpdated {
    pub store: Pubkey,
    pub owner: Pubkey,
    pub handle: [u8; 32],
    /// Monotonic version AFTER this update (indexer staleness/CAS signal).
    pub version: u64,
    pub timestamp: i64,
}

/// Emitted when a store closes its identity PDA; rent + bond are refunded in
/// full to the owner (P5.2 — no exit cooldown: nothing money-bearing reads
/// `Store` in v1).
#[event]
pub struct StoreClosed {
    pub store: Pubkey,
    pub owner: Pubkey,
    /// The bond principal that was held (informational).
    pub bond_lamports: u64,
    /// Total lamports actually refunded to the owner at close — the full PDA
    /// balance (rent + bond + any lamports transferred to the PDA after
    /// registration), which is what `close = owner` returns.
    pub refunded_lamports: u64,
    pub timestamp: i64,
}

/// Emitted on every `moderation_heartbeat` (P1.3 liveness deadman). Surfaces and
/// indexers can watch this to display gate-armed status; silence past the window
/// relaxes the consumption gates (docs/MODERATION_LIVENESS.md).
#[event]
pub struct ModerationHeartbeatRecorded {
    /// The signer that heartbeated (config authority or moderation authority).
    pub by: Pubkey,
    /// The EFFECTIVE liveness window after this call (seconds; the default is
    /// substituted when the stored value is 0).
    pub window_secs: u32,
    pub timestamp: i64,
}

// ============================================================================
// Batch 3 events (WS-CONTEST — docs/design/batch-3-contest-tasks.md)
// ============================================================================

/// Emitted by each `distribute_ghost_share` crank: an unjudged contest
/// (schema-1 Competitive) submission was paid its equal slice of the remaining
/// escrow worker pool after the selection window elapsed (`ghost_at`). The paid
/// submission + claim are closed to the worker in the same instruction, so a
/// submission can be ghost-paid at most once.
#[event]
pub struct GhostShareDistributed {
    /// The contest task being ghost-split.
    pub task: Pubkey,
    /// The paid submitter's `AgentRegistration` PDA.
    pub worker_agent: Pubkey,
    /// Lamports paid to the worker for this slice (net of the fee legs).
    pub lamports: u64,
    /// Live submissions REMAINING after this slice (0 = the contest is fully
    /// distributed and the task is Completed).
    pub remaining: u8,
}

/// Emitted by `reclaim_terminal_claim`: an unsettled claim on an already-terminal
/// task was reclaimed. The eligible shapes are an empty/no-submission record, a
/// Rejected submission, or a still-Submitted Collaborative straggler after
/// completion. Task/worker slot counters are freed; applicable claim surplus is
/// forfeited to the treasury while a Submitted straggler is refunded in full.
#[event]
pub struct TerminalClaimReclaimed {
    pub task: Pubkey,
    pub claim: Pubkey,
    /// The affected worker's `AgentRegistration` PDA.
    pub worker_agent: Pubkey,
    /// Claim lamports returned to the worker authority: the rent-exempt minimum
    /// for empty/Rejected cleanup, or the full balance for a Submitted
    /// Collaborative straggler.
    pub worker_refund: u64,
    /// Lamports forfeited to the protocol treasury (the contest entry-deposit
    /// surplus above rent; 0 for non-contest claims).
    pub forfeited: u64,
    pub timestamp: i64,
}

/// Emitted when `expire_claim` or `cancel_task` forfeits a contest entry deposit
/// to the protocol treasury for a proven no-show. Terminal empty/Rejected claim
/// cleanup reports the same forfeiture through
/// [`TerminalClaimReclaimed::forfeited`] instead of emitting this event.
#[event]
pub struct ContestDepositForfeited {
    pub task: Pubkey,
    pub claim: Pubkey,
    /// The proven no-show worker's `AgentRegistration` PDA.
    pub worker_agent: Pubkey,
    /// Lamports forfeited to the treasury (the surplus above the claim's rent).
    pub amount: u64,
    pub timestamp: i64,
}

// ============================================================================
// Batch 4 — GOODS market events (docs/design/batch-4-goods.md)
// ============================================================================

/// Emitted when an agent lists a finite good for sale.
#[event]
pub struct GoodsListingCreated {
    pub listing: Pubkey,
    /// Seller's agent PDA.
    pub seller: Pubkey,
    pub good_id: [u8; 32],
    pub name: [u8; 32],
    pub metadata_hash: [u8; 32],
    pub price: u64,
    pub price_mint: Option<Pubkey>,
    pub total_supply: u64,
    /// Operator payee (`Pubkey::default()` = no operator leg).
    pub operator: Pubkey,
    pub operator_fee_bps: u16,
    pub timestamp: i64,
}

/// Emitted on every unit sold — the indexer-facing provenance signal.
/// Carries the full fee split so the protocol cut is auditable per sale.
#[event]
pub struct GoodPurchased {
    pub listing: Pubkey,
    /// Buyer WALLET (bare signer).
    pub buyer: Pubkey,
    /// Seller's agent PDA.
    pub seller: Pubkey,
    /// This unit's receipt serial (== `sold_count` before the increment).
    pub serial: u64,
    /// Snapshot of the listing's metadata hash at sale time.
    pub metadata_hash: [u8; 32],
    pub price_paid: u64,
    pub protocol_fee: u64,
    pub operator_fee: u64,
    /// Units still available after this sale (`total_supply - sold_count`).
    pub remaining_supply: u64,
    pub timestamp: i64,
}

/// Emitted when a seller updates their goods listing (price / active /
/// metadata / operator terms / additive restock).
#[event]
pub struct GoodsListingUpdated {
    pub listing: Pubkey,
    /// Seller's agent PDA.
    pub seller: Pubkey,
    pub price: u64,
    pub is_active: bool,
    pub total_supply: u64,
    pub sold_count: u64,
    pub restock_count: u16,
    pub timestamp: i64,
}

/// Emitted when the recovery rail returns rent from a historical auxiliary
/// child whose parent Task was destroyed by an older close_task implementation.
#[event]
pub struct OrphanTaskChildReclaimed {
    pub child: Pubkey,
    pub task: Pubkey,
    pub recipient: Pubkey,
    pub cranker: Pubkey,
    pub child_kind: u8,
    pub reclaimed_lamports: u64,
    pub timestamp: i64,
}
