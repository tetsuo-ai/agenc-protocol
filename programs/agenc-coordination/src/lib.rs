// Crate-level lint configuration
// unexpected_cfgs: Anchor uses custom cfg attributes (e.g., #[cfg(feature = "idl-build")])
//   that rustc doesn't recognize, triggering false warnings
// clippy::too_many_arguments: Anchor instruction handlers often require many parameters
//   for account validation and instruction data; this is inherent to the framework pattern
#![allow(unexpected_cfgs)]
#![allow(clippy::too_many_arguments)]
#![cfg_attr(not(test), deny(unsafe_code))]
#![cfg_attr(
    not(test),
    deny(
        clippy::expect_used,
        clippy::panic,
        clippy::todo,
        clippy::unimplemented,
        clippy::unreachable,
        clippy::unwrap_used
    )
)]
//! AgenC Coordination Protocol
//!
//! A decentralized multi-agent coordination layer for the AgenC framework.
//! Enables trustless task distribution, state synchronization, and resource
//! allocation across edge computing agents.

// The canary is a frozen, deliberately reduced wire surface. Combining it with
// production or private-development features would silently compile a different
// ABI under the same program id, so reject those release-footgun combinations.
#[cfg(all(feature = "mainnet-canary", feature = "spl-token-rewards"))]
compile_error!(
    "mainnet-canary must be built with --no-default-features and cannot enable spl-token-rewards"
);
#[cfg(all(feature = "mainnet-canary", feature = "private-zk"))]
compile_error!("mainnet-canary and private-zk are mutually exclusive build surfaces");
#[cfg(all(not(feature = "mainnet-canary"), not(feature = "spl-token-rewards")))]
compile_error!(
    "the full protocol surface requires spl-token-rewards; use default features, or select the restricted mainnet-canary surface"
);

use anchor_lang::prelude::*;

declare_id!("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");

#[cfg(any(feature = "mainnet-canary", feature = "spl-token-rewards"))]
pub mod errors;
#[cfg(any(feature = "mainnet-canary", feature = "spl-token-rewards"))]
pub mod events;
#[cfg(any(feature = "mainnet-canary", feature = "spl-token-rewards"))]
pub mod instructions;
// Keep the private wire DTO out of the production build. The feature-gated
// program entry uses flattened fields because Anchor 0.32 otherwise hoists a
// defined argument type into the production IDL even when its cfg is false.
#[cfg(all(
    not(feature = "mainnet-canary"),
    feature = "private-zk",
    feature = "spl-token-rewards"
))]
mod private_completion_payload;
#[cfg(any(feature = "mainnet-canary", feature = "spl-token-rewards"))]
pub mod state;
#[cfg(any(feature = "mainnet-canary", feature = "spl-token-rewards"))]
pub mod utils;

#[cfg(any(feature = "mainnet-canary", feature = "spl-token-rewards"))]
use crate::errors::CoordinationError;
#[cfg(any(feature = "mainnet-canary", feature = "spl-token-rewards"))]
use instructions::*;
#[cfg(all(
    not(feature = "mainnet-canary"),
    feature = "private-zk",
    feature = "spl-token-rewards"
))]
pub use private_completion_payload::PrivateCompletionPayload;

#[cfg(not(feature = "mainnet-canary"))]
#[cfg(feature = "spl-token-rewards")]
#[program]
pub mod agenc_coordination {
    use super::*;

    /// Register a new agent on-chain with its capabilities and metadata.
    /// Creates a unique PDA for the agent that serves as its on-chain identity.
    ///
    /// # Arguments
    /// * `ctx` - Context containing agent account and signer
    /// * `agent_id` - Unique 32-byte identifier for the agent
    /// * `capabilities` - Bitmask of agent capabilities (see AgentCapability)
    /// * `endpoint` - Network endpoint for off-chain communication
    /// * `metadata_uri` - Optional URI to extended metadata (IPFS/Arweave)
    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        agent_id: [u8; 32],
        capabilities: u64,
        endpoint: String,
        metadata_uri: Option<String>,
        stake_amount: u64,
    ) -> Result<()> {
        instructions::register_agent::handler(
            ctx,
            agent_id,
            capabilities,
            endpoint,
            metadata_uri,
            stake_amount,
        )
    }

    /// Update an existing agent's registration data.
    /// Only the agent's authority can modify its registration.
    pub fn update_agent(
        ctx: Context<UpdateAgent>,
        capabilities: Option<u64>,
        endpoint: Option<String>,
        metadata_uri: Option<String>,
        status: Option<u8>,
    ) -> Result<()> {
        instructions::update_agent::handler(ctx, capabilities, endpoint, metadata_uri, status)
    }

    /// Suspend an agent (protocol authority only, fix #819).
    /// Prevents the agent from claiming tasks or participating in disputes.
    pub fn suspend_agent(ctx: Context<SuspendAgent>) -> Result<()> {
        instructions::suspend_agent::handler(ctx)
    }

    /// Unsuspend an agent (protocol authority only, fix #819).
    /// Restores the agent to Inactive status.
    pub fn unsuspend_agent(ctx: Context<UnsuspendAgent>) -> Result<()> {
        instructions::unsuspend_agent::handler(ctx)
    }

    /// Deregister an agent and reclaim rent.
    /// Agent must have no active tasks.
    pub fn deregister_agent(ctx: Context<DeregisterAgent>) -> Result<()> {
        instructions::deregister_agent::handler(ctx)
    }

    /// Create a new task with requirements and optional reward.
    /// Tasks are stored in a PDA derived from the creator and task ID.
    ///
    /// # Arguments
    /// * `ctx` - Context with task account and creator
    /// * `task_id` - Unique identifier for the task
    /// * `required_capabilities` - Bitmask of required agent capabilities
    /// * `description` - Task description or instruction hash
    /// * `reward_amount` - SOL or token reward for completion
    /// * `max_workers` - Maximum number of agents that can work on this task
    /// * `deadline` - Unix timestamp deadline (0 = no deadline)
    /// * `task_type` - 0=exclusive (single worker), 1=collaborative (multi-worker)
    /// * `constraint_hash` - For private tasks: hash of expected output (None for non-private)
    #[allow(clippy::too_many_arguments)]
    pub fn create_task(
        ctx: Context<CreateTask>,
        task_id: [u8; 32],
        required_capabilities: u64,
        description: [u8; 64],
        reward_amount: u64,
        max_workers: u8,
        deadline: i64,
        task_type: u8,
        constraint_hash: Option<[u8; 32]>,
        min_reputation: u16,
        reward_mint: Option<Pubkey>,
        referrer: Option<Pubkey>,
        referrer_fee_bps: u16,
    ) -> Result<()> {
        instructions::create_task::handler(
            ctx,
            task_id,
            required_capabilities,
            description,
            reward_amount,
            max_workers,
            deadline,
            task_type,
            constraint_hash,
            min_reputation,
            reward_mint,
            referrer,
            referrer_fee_bps,
        )
    }

    /// Create an Exclusive task that is only assignable through a bilateral,
    /// creator-and-worker-signed acceptance after its job-spec and attestor are set.
    #[allow(clippy::too_many_arguments)]
    pub fn create_direct_assignment_task(
        ctx: Context<CreateTask>,
        task_id: [u8; 32],
        required_capabilities: u64,
        description: [u8; 64],
        reward_amount: u64,
        max_workers: u8,
        deadline: i64,
        task_type: u8,
        constraint_hash: Option<[u8; 32]>,
        min_reputation: u16,
        reward_mint: Option<Pubkey>,
        referrer: Option<Pubkey>,
        referrer_fee_bps: u16,
    ) -> Result<()> {
        instructions::create_task::direct_assignment_handler(
            ctx,
            task_id,
            required_capabilities,
            description,
            reward_amount,
            max_workers,
            deadline,
            task_type,
            constraint_hash,
            min_reputation,
            reward_mint,
            referrer,
            referrer_fee_bps,
        )
    }

    /// Configure the moderation authority required before task job-spec publication.
    pub fn configure_task_moderation(
        ctx: Context<ConfigureTaskModeration>,
        moderation_authority: Pubkey,
        enabled: bool,
    ) -> Result<()> {
        instructions::configure_task_moderation::handler(ctx, moderation_authority, enabled)
    }

    /// Record a moderation decision for a task/job-spec hash.
    #[allow(clippy::too_many_arguments)]
    pub fn record_task_moderation(
        ctx: Context<RecordTaskModeration>,
        job_spec_hash: [u8; 32],
        status: u8,
        risk_score: u8,
        category_mask: u64,
        policy_hash: [u8; 32],
        scanner_hash: [u8; 32],
        expires_at: i64,
    ) -> Result<()> {
        instructions::record_task_moderation::handler(
            ctx,
            job_spec_hash,
            status,
            risk_score,
            category_mask,
            policy_hash,
            scanner_hash,
            expires_at,
        )
    }

    /// Attach or update a content-addressed off-chain job specification pointer for a
    /// task. P1.2 §4.4: `moderator` names the attestor whose moderation record the
    /// caller consumes (the record slot is v2-else-legacy; the required
    /// `moderation_block` account is the §5.2 takedown floor).
    /// Discriminator = sha256("global:set_task_job_spec_v2")[0..8].
    #[instruction(discriminator = [118, 9, 99, 58, 215, 87, 58, 59])]
    pub fn set_task_job_spec(
        ctx: Context<SetTaskJobSpec>,
        job_spec_hash: [u8; 32],
        job_spec_uri: String,
        moderator: Pubkey,
    ) -> Result<()> {
        instructions::set_task_job_spec::handler(ctx, job_spec_hash, job_spec_uri, moderator)
    }

    /// Create a new task that depends on an existing parent task.
    /// The parent task must not be cancelled or disputed.
    ///
    /// # Arguments
    /// * `ctx` - Context with task, escrow, parent_task, and creator accounts
    /// * `task_id` - Unique identifier for the task
    /// * `required_capabilities` - Bitmask of required agent capabilities
    /// * `description` - Task description or instruction hash
    /// * `reward_amount` - SOL or token reward for completion
    /// * `max_workers` - Maximum number of agents that can work on this task
    /// * `deadline` - Unix timestamp deadline (0 = no deadline)
    /// * `task_type` - 0=exclusive (single worker), 1=collaborative (multi-worker)
    /// * `constraint_hash` - For private tasks: hash of expected output (None for non-private)
    /// * `dependency_type` - 1=Data, 2=Ordering, 3=Proof
    #[cfg(not(feature = "mainnet-canary"))]
    #[allow(clippy::too_many_arguments)]
    pub fn create_dependent_task(
        ctx: Context<CreateDependentTask>,
        task_id: [u8; 32],
        required_capabilities: u64,
        description: [u8; 64],
        reward_amount: u64,
        max_workers: u8,
        deadline: i64,
        task_type: u8,
        constraint_hash: Option<[u8; 32]>,
        dependency_type: u8,
        min_reputation: u16,
        reward_mint: Option<Pubkey>,
    ) -> Result<()> {
        instructions::create_dependent_task::handler(
            ctx,
            task_id,
            required_capabilities,
            description,
            reward_amount,
            max_workers,
            deadline,
            task_type,
            constraint_hash,
            dependency_type,
            min_reputation,
            reward_mint,
        )
    }

    /// Initialize Marketplace V2 global configuration.
    #[cfg(not(feature = "mainnet-canary"))]
    #[allow(clippy::too_many_arguments)]
    pub fn initialize_bid_marketplace(
        ctx: Context<InitializeBidMarketplace>,
        min_bid_bond_lamports: u64,
        bid_creation_cooldown_secs: i64,
        max_bids_per_24h: u16,
        max_active_bids_per_task: u16,
        max_bid_lifetime_secs: i64,
        accepted_no_show_slash_bps: u16,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::MultisigNotEnoughSigners
        );
        instructions::bid_marketplace::initialize_bid_marketplace_handler(
            ctx,
            min_bid_bond_lamports,
            bid_creation_cooldown_secs,
            max_bids_per_24h,
            max_active_bids_per_task,
            max_bid_lifetime_secs,
            accepted_no_show_slash_bps,
        )
    }

    /// Update Marketplace V2 global configuration.
    #[cfg(not(feature = "mainnet-canary"))]
    #[allow(clippy::too_many_arguments)]
    pub fn update_bid_marketplace_config(
        ctx: Context<UpdateBidMarketplaceConfig>,
        min_bid_bond_lamports: u64,
        bid_creation_cooldown_secs: i64,
        max_bids_per_24h: u16,
        max_active_bids_per_task: u16,
        max_bid_lifetime_secs: i64,
        accepted_no_show_slash_bps: u16,
    ) -> Result<()> {
        instructions::bid_marketplace::update_bid_marketplace_config_handler(
            ctx,
            min_bid_bond_lamports,
            bid_creation_cooldown_secs,
            max_bids_per_24h,
            max_active_bids_per_task,
            max_bid_lifetime_secs,
            accepted_no_show_slash_bps,
        )
    }

    /// Initialize a bid book for a Marketplace V2 task.
    #[cfg(not(feature = "mainnet-canary"))]
    #[allow(clippy::too_many_arguments)]
    pub fn initialize_bid_book(
        ctx: Context<InitializeBidBook>,
        policy: u8,
        price_weight_bps: u16,
        eta_weight_bps: u16,
        confidence_weight_bps: u16,
        reliability_weight_bps: u16,
    ) -> Result<()> {
        require!(
            ctx.accounts.creator.is_signer,
            CoordinationError::UnauthorizedTaskAction
        );
        instructions::bid_marketplace::initialize_bid_book_handler(
            ctx,
            policy,
            price_weight_bps,
            eta_weight_bps,
            confidence_weight_bps,
            reliability_weight_bps,
        )
    }

    /// Create a Marketplace V2 bid for a task.
    #[cfg(not(feature = "mainnet-canary"))]
    #[allow(clippy::too_many_arguments)]
    pub fn create_bid(
        ctx: Context<CreateBid>,
        requested_reward_lamports: u64,
        eta_seconds: u32,
        confidence_bps: u16,
        quality_guarantee_hash: [u8; 32],
        metadata_hash: [u8; 32],
        expires_at: i64,
        expected_job_spec_hash: [u8; 32],
        expected_job_spec_updated_at: i64,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::UnauthorizedAgent
        );
        instructions::bid_marketplace::create_bid_handler(
            ctx,
            requested_reward_lamports,
            eta_seconds,
            confidence_bps,
            quality_guarantee_hash,
            metadata_hash,
            expires_at,
            expected_job_spec_hash,
            expected_job_spec_updated_at,
        )
    }

    /// Update an existing Marketplace V2 bid.
    #[cfg(not(feature = "mainnet-canary"))]
    #[allow(clippy::too_many_arguments)]
    pub fn update_bid(
        ctx: Context<UpdateBid>,
        requested_reward_lamports: u64,
        eta_seconds: u32,
        confidence_bps: u16,
        quality_guarantee_hash: [u8; 32],
        metadata_hash: [u8; 32],
        expires_at: i64,
        expected_job_spec_hash: [u8; 32],
        expected_job_spec_updated_at: i64,
    ) -> Result<()> {
        instructions::bid_marketplace::update_bid_handler(
            ctx,
            requested_reward_lamports,
            eta_seconds,
            confidence_bps,
            quality_guarantee_hash,
            metadata_hash,
            expires_at,
            expected_job_spec_hash,
            expected_job_spec_updated_at,
        )
    }

    /// Cancel an open or parked Marketplace V2 bid.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn cancel_bid(ctx: Context<CancelBid>) -> Result<()> {
        instructions::bid_marketplace::cancel_bid_handler(ctx)
    }

    /// Accept a Marketplace V2 bid and convert it into a normal task claim.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn accept_bid(ctx: Context<AcceptBid>, expected_bid_terms_hash: [u8; 32]) -> Result<()> {
        require!(
            ctx.accounts.creator.is_signer,
            CoordinationError::UnauthorizedTaskAction
        );
        instructions::bid_marketplace::accept_bid_handler(ctx, expected_bid_terms_hash)
    }

    /// Expire an unaccepted Marketplace V2 bid.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn expire_bid(ctx: Context<ExpireBid>) -> Result<()> {
        instructions::bid_marketplace::expire_bid_handler(ctx)
    }

    /// Permissionlessly promote a live bid to the book's tracked policy winner.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn promote_bid(ctx: Context<PromoteBid>) -> Result<()> {
        instructions::bid_marketplace::promote_bid_handler(ctx)
    }

    /// Permissionlessly demote a provably dead tracked winner and open the
    /// re-promotion grace window.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn demote_ineligible_best(ctx: Context<DemoteIneligibleBest>) -> Result<()> {
        instructions::bid_marketplace::demote_ineligible_best_handler(ctx)
    }

    /// Claim a task to signal intent to work on it.
    /// Agent must have required capabilities and task must be claimable.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn claim_task(ctx: Context<ClaimTask>) -> Result<()> {
        instructions::claim_task::handler(ctx)
    }

    /// Claim a task only when its content-addressed job specification pointer exists.
    pub fn claim_task_with_job_spec(ctx: Context<ClaimTaskWithJobSpec>) -> Result<()> {
        instructions::claim_task::handler_with_job_spec(ctx)
    }

    /// Atomically bind an Exclusive direct-assignment task to the exact worker
    /// who co-signs this transaction with its creator.
    pub fn accept_direct_assignment_with_job_spec(
        ctx: Context<AcceptDirectAssignmentWithJobSpec>,
        expected_job_spec_hash: [u8; 32],
        expected_job_spec_updated_at: i64,
        expected_attestor: Pubkey,
    ) -> Result<()> {
        instructions::accept_direct_assignment::handler(
            ctx,
            expected_job_spec_hash,
            expected_job_spec_updated_at,
            expected_attestor,
        )
    }

    /// Enable Task Validation V2 creator review for an open task.
    pub fn configure_task_validation(
        ctx: Context<ConfigureTaskValidation>,
        mode: u8,
        review_window_secs: i64,
        validator_quorum: u8,
        attestor: Option<Pubkey>,
    ) -> Result<()> {
        instructions::configure_task_validation::handler(
            ctx,
            mode,
            review_window_secs,
            validator_quorum,
            attestor,
        )
    }

    /// Expire a stale claim to free up task slot.
    /// Can only be called after claim.expires_at has passed.
    pub fn expire_claim<'info>(ctx: Context<'_, '_, '_, 'info, ExpireClaim<'info>>) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::InvalidInput
        );
        instructions::expire_claim::handler(ctx)
    }

    /// Submit a result for creator review before final settlement.
    pub fn submit_task_result(
        ctx: Context<SubmitTaskResult>,
        proof_hash: [u8; 32],
        result_data: Option<[u8; 64]>,
    ) -> Result<()> {
        instructions::submit_task_result::handler(ctx, proof_hash, result_data)
    }

    /// Accept a creator-reviewed submission and settle rewards.
    pub fn accept_task_result(ctx: Context<AcceptTaskResult>) -> Result<()> {
        instructions::accept_task_result::handler(ctx)
    }

    /// Permissionlessly auto-accept a creator-reviewed submission after timeout.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn auto_accept_task_result(ctx: Context<AutoAcceptTaskResult>) -> Result<()> {
        instructions::auto_accept_task_result::handler(ctx)
    }

    /// Reject a creator-reviewed submission and return the task to active work.
    pub fn reject_task_result<'info>(
        ctx: Context<'_, '_, '_, 'info, RejectTaskResult<'info>>,
        rejection_hash: [u8; 32],
    ) -> Result<()> {
        instructions::reject_task_result::handler(ctx, rejection_hash)
    }

    /// Record a validator quorum vote or external attestation for a submission.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn validate_task_result<'info>(
        ctx: Context<'_, '_, '_, 'info, ValidateTaskResult<'info>>,
        approved: bool,
    ) -> Result<()> {
        instructions::validate_task_result::handler(ctx, approved)
    }

    /// Submit proof of work and mark task portion as complete.
    /// For collaborative tasks, multiple completions may be needed.
    ///
    /// # Arguments
    /// * `ctx` - Context with task, worker claim, and reward accounts
    /// * `proof_hash` - 32-byte hash of the proof of work
    /// * `result_data` - Optional result data or pointer
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn complete_task<'info>(
        ctx: Context<'_, '_, '_, 'info, CompleteTask<'info>>,
        proof_hash: [u8; 32],
        result_data: Option<[u8; 64]>,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::UnauthorizedAgent
        );
        instructions::complete_task::handler(ctx, proof_hash, result_data)
    }

    /// Complete a task with private proof verification.
    #[cfg(feature = "private-zk")]
    pub fn complete_task_private<'info>(
        ctx: Context<'_, '_, '_, 'info, CompleteTaskPrivate<'info>>,
        task_id: u64,
        // Keep these fields in PrivateCompletionPayload declaration order.
        // Borsh encodes the flattened fields byte-for-byte like the prior DTO
        // argument, preserving the private instruction's dormant wire format.
        seal_bytes: Vec<u8>,
        journal: Vec<u8>,
        image_id: [u8; 32],
        binding_seed: [u8; 32],
        nullifier_seed: [u8; 32],
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::UnauthorizedAgent
        );
        let proof = PrivateCompletionPayload {
            seal_bytes,
            journal,
            image_id,
            binding_seed,
            nullifier_seed,
        };
        instructions::complete_task_private::complete_task_private(ctx, task_id, proof)
    }

    /// Initialize the trusted ZK image ID config.
    #[cfg(feature = "private-zk")]
    pub fn initialize_zk_config(
        ctx: Context<InitializeZkConfig>,
        active_image_id: [u8; 32],
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::UnauthorizedProtocolAuthority
        );
        instructions::initialize_zk_config::handler(ctx, active_image_id)
    }

    /// Rotate the trusted ZK image ID.
    #[cfg(feature = "private-zk")]
    pub fn update_zk_image_id(ctx: Context<UpdateZkImageId>, new_image_id: [u8; 32]) -> Result<()> {
        instructions::update_zk_image_id::handler(ctx, new_image_id)
    }

    /// Cancel an unclaimed or expired task and reclaim funds.
    pub fn cancel_task<'info>(ctx: Context<'_, '_, '_, 'info, CancelTask<'info>>) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::UnauthorizedTaskAction
        );
        instructions::cancel_task::process_cancel_task(ctx)
    }

    /// Cancel a dispute before any votes are cast.
    /// Only the dispute initiator can cancel, and only if no arbiter has voted yet.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn cancel_dispute(ctx: Context<CancelDispute>) -> Result<()> {
        instructions::cancel_dispute::handler(ctx)
    }

    /// Update shared coordination state.
    /// Used for broadcasting state changes to other agents.
    ///
    /// # Arguments
    /// * `ctx` - Context with coordination PDA
    /// * `state_key` - Key identifying the state variable
    /// * `state_value` - New value for the state
    /// * `version` - Expected current version (for optimistic locking)
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn update_state(
        ctx: Context<UpdateState>,
        state_key: [u8; 32],
        state_value: [u8; 64],
        version: u64,
    ) -> Result<()> {
        instructions::update_state::handler(ctx, state_key, state_value, version)
    }

    /// Initiate a conflict resolution process.
    /// Creates a dispute that requires multi-sig consensus to resolve.
    ///
    /// # Arguments
    /// * `ctx` - Context with dispute account
    /// * `dispute_id` - Unique identifier for the dispute
    /// * `task_id` - Related task ID
    /// * `evidence_hash` - Hash of evidence supporting the dispute
    /// * `resolution_type` - 0=refund, 1=complete, 2=split
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn initiate_dispute<'info>(
        ctx: Context<'_, '_, '_, 'info, InitiateDispute<'info>>,
        dispute_id: [u8; 32],
        task_id: [u8; 32],
        evidence_hash: [u8; 32],
        resolution_type: u8,
        evidence: String,
    ) -> Result<()> {
        instructions::initiate_dispute::handler(
            ctx,
            dispute_id,
            task_id,
            evidence_hash,
            resolution_type,
            evidence,
        )
    }

    // P6.3: `vote_dispute` retired. The per-case arbiter vote/quorum model no longer
    // gates resolution. A threshold-approved protocol authority or a threshold-seated
    // assigned resolver decides directly. Removing the instruction also drops its
    // `DisputeVote` / `AuthorityDisputeVote` PDAs and the `DisputeVoteCast` event.

    /// Assign a wallet to the dispute-resolver roster. The protocol authority proposes
    /// the change and the configured M-of-N owners approve it. The assigned wallet may
    /// then call `resolve_dispute` directly — no per-case vote tally or quorum.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn assign_dispute_resolver(
        ctx: Context<AssignDisputeResolver>,
        resolver: Pubkey,
    ) -> Result<()> {
        instructions::assign_dispute_resolver::handler(ctx, resolver)
    }

    /// Remove a wallet from the dispute-resolver roster after a protocol-authority
    /// proposal receives configured M-of-N approval, closing its assignment PDA.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn revoke_dispute_resolver(ctx: Context<RevokeDisputeResolver>) -> Result<()> {
        instructions::revoke_dispute_resolver::handler(ctx)
    }

    /// Assign a wallet to the moderation-attestor roster (authority-only, P6.8). The
    /// assigned wallet may then record moderation attestations
    /// (`record_task_moderation` / `record_listing_moderation`) in addition to the single
    /// global moderation authority. Registry MECHANISM only — the neutrality model is a
    /// separate [HUMAN] decision (`docs/MODERATION_NEUTRALITY.md`).
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn assign_moderation_attestor(
        ctx: Context<AssignModerationAttestor>,
        attestor: Pubkey,
    ) -> Result<()> {
        instructions::assign_moderation_attestor::handler(ctx, attestor)
    }

    /// Remove a wallet from the moderation-attestor roster (P1.2: scoped — the caller
    /// may remove only entries it itself created, so a self-registered attestor can be
    /// removed from chain by no one but itself), closing its assignment PDA.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn revoke_moderation_attestor(ctx: Context<RevokeModerationAttestor>) -> Result<()> {
        instructions::revoke_moderation_attestor::handler(ctx)
    }

    /// Self-register onto the open moderation-attestor roster (P1.2 §4.1,
    /// permissionless). The signer pays rent + the hardcoded registration bond onto its
    /// own roster PDA; `assigned_by = self` marks the entry self-registered. The bond is
    /// an identity deposit — never confiscatable, refunded in full at exit-finalize.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn register_moderation_attestor(ctx: Context<RegisterModerationAttestor>) -> Result<()> {
        instructions::register_moderation_attestor::handler(ctx)
    }

    /// Start the two-step attestor exit (P1.2 §4.2). Monotonic — a running exit clock
    /// cannot be reset. From this moment the attestor is rejected at the record and
    /// consumption gates (the window closes at REQUEST, not finalize).
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn request_attestor_exit(ctx: Context<RequestAttestorExit>) -> Result<()> {
        instructions::attestor_exit::handler_request(ctx)
    }

    /// Finalize the attestor exit after the cooldown, closing the roster PDA and
    /// refunding bond + rent to the attestor in full (P1.2 §4.2). Requires
    /// `exit_at != 0` — a fresh or grandfathered entry can never finalize instantly.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn finalize_attestor_exit(ctx: Context<FinalizeAttestorExit>) -> Result<()> {
        instructions::attestor_exit::handler_finalize(ctx)
    }

    /// Set (or re-set) the multisig-governed BLOCK-only takedown floor for a content
    /// hash (P1.2 §5.2). Requires `multisig_threshold` owner signatures in remaining
    /// accounts and an on-chain rationale. All three consumption gates hard-reject a
    /// blocked hash regardless of which CLEAN attestor the caller presents.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn set_moderation_block(
        ctx: Context<SetModerationBlock>,
        content_hash: [u8; 32],
        rationale_hash: [u8; 32],
        rationale_uri: String,
    ) -> Result<()> {
        instructions::moderation_block::handler_set(
            ctx,
            content_hash,
            rationale_hash,
            rationale_uri,
        )
    }

    /// Clear a takedown block (P1.2 §5.2, multisig-gated). The block account stays
    /// open as the audit trail; the hash becomes consumable again at the gates.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn clear_moderation_block(ctx: Context<ClearModerationBlock>) -> Result<()> {
        instructions::moderation_block::handler_clear(ctx)
    }

    /// Update the on-chain default trusted-attestor list pointer (P1.2 §5.1,
    /// multisig-gated). Advisory display-layer curation — gates nothing on-chain;
    /// `version` is monotonic and `updated_at` is the deadman signal.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn set_default_trust_list(
        ctx: Context<SetDefaultTrustList>,
        list_hash: [u8; 32],
        list_uri: String,
    ) -> Result<()> {
        instructions::set_default_trust_list::handler(ctx, list_hash, list_uri)
    }

    /// Resolve a dispute. A direct protocol-authority ruling requires configured
    /// M-of-N owner approval; an assigned resolver must have been seated through
    /// that same threshold-controlled roster. `approve` upholds the initiator's
    /// requested resolution_type; `!approve` refunds the creator. No per-case
    /// arbiter vote tally or quorum is consulted.
    ///
    /// P6.4 accountable rulings: a reasoned ruling is REQUIRED — `rationale_hash` (a
    /// 32-byte content hash of the off-chain rationale) and a bounded `rationale_uri`.
    /// Both are persisted on the dispute alongside the deciding resolver, and the hash
    /// + resolver are emitted in `DisputeResolved`.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn resolve_dispute<'info>(
        ctx: Context<'_, '_, '_, 'info, ResolveDispute<'info>>,
        approve: bool,
        rationale_hash: [u8; 32],
        rationale_uri: String,
    ) -> Result<()> {
        instructions::resolve_dispute::handler(ctx, approve, rationale_hash, rationale_uri)
    }

    /// Permissionlessly settle one deferred collaborative peer claim after a
    /// dispute ruling (chunked settlement). The dispute reaches its recorded
    /// terminal status when the last peer settles.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn settle_dispute_claim(ctx: Context<SettleDisputeClaim>) -> Result<()> {
        instructions::settle_dispute_claim::handler(ctx)
    }

    /// Apply slashing to a worker after losing a dispute.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn apply_dispute_slash(ctx: Context<ApplyDisputeSlash>) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::InvalidInput
        );
        instructions::apply_dispute_slash::handler(ctx)
    }

    /// Apply slashing to a dispute initiator when their dispute is rejected.
    /// This provides symmetric slashing: workers are slashed for bad work,
    /// initiators are slashed for frivolous disputes.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn apply_initiator_slash(ctx: Context<ApplyInitiatorSlash>) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::InvalidInput
        );
        instructions::apply_initiator_slash::handler(ctx)
    }

    /// Expire a dispute after the maximum duration has passed.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn expire_dispute<'info>(
        ctx: Context<'_, '_, '_, 'info, ExpireDispute<'info>>,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::InvalidInput
        );
        instructions::expire_dispute::handler(ctx)
    }

    /// Initialize the protocol configuration.
    /// Called once to set up global parameters.
    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        dispute_threshold: u8,
        protocol_fee_bps: u16,
        min_stake: u64,
        min_stake_for_dispute: u64,
        multisig_threshold: u8,
        multisig_owners: Vec<Pubkey>,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::UnauthorizedUpgrade
        );
        instructions::initialize_protocol::handler(
            ctx,
            dispute_threshold,
            protocol_fee_bps,
            min_stake,
            min_stake_for_dispute,
            multisig_threshold,
            multisig_owners,
        )
    }

    /// Update the protocol fee (multisig gated).
    pub fn update_protocol_fee(
        ctx: Context<UpdateProtocolFee>,
        protocol_fee_bps: u16,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::MultisigNotEnoughSigners
        );
        instructions::update_protocol_fee::handler(ctx, protocol_fee_bps)
    }

    /// Update protocol treasury destination (multisig gated).
    ///
    /// Hardening:
    /// - Allows treasury rotation/recovery.
    /// - New treasury must be program-owned, or a signer system account.
    pub fn update_treasury(ctx: Context<UpdateTreasury>) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::MultisigNotEnoughSigners
        );
        instructions::update_treasury::handler(ctx)
    }

    /// Rotate multisig owners/threshold (multisig gated).
    ///
    /// Hardening:
    /// - Allows signer rotation for key loss/compromise recovery.
    /// - Requires threshold of new-set signers in the same update transaction.
    pub fn update_multisig(
        ctx: Context<UpdateMultisig>,
        new_threshold: u8,
        new_owners: Vec<Pubkey>,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::MultisigNotEnoughSigners
        );
        instructions::update_multisig::handler(ctx, new_threshold, new_owners)
    }

    /// Update rate limiting configuration (multisig gated).
    /// Parameters can be tuned post-deployment without program upgrade.
    ///
    /// # Arguments
    /// * `task_creation_cooldown` - Seconds between task creations (0 = disabled)
    /// * `max_tasks_per_24h` - Maximum tasks per agent per 24h (0 = unlimited)
    /// * `dispute_initiation_cooldown` - Seconds between disputes (0 = disabled)
    /// * `max_disputes_per_24h` - Maximum disputes per agent per 24h (0 = unlimited)
    /// * `min_stake_for_dispute` - Minimum stake required to initiate dispute
    pub fn update_rate_limits(
        ctx: Context<UpdateRateLimits>,
        task_creation_cooldown: i64,
        max_tasks_per_24h: u8,
        dispute_initiation_cooldown: i64,
        max_disputes_per_24h: u8,
        min_stake_for_dispute: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::MultisigNotEnoughSigners
        );
        instructions::update_rate_limits::handler(
            ctx,
            task_creation_cooldown,
            max_tasks_per_24h,
            dispute_initiation_cooldown,
            max_disputes_per_24h,
            min_stake_for_dispute,
        )
    }

    /// Update emergency launch controls (multisig gated).
    ///
    /// `protocol_paused` globally pauses version-gated mutable protocol paths.
    /// `disabled_task_type_mask` disables task types by `TaskType` repr bit index.
    pub fn update_launch_controls(
        ctx: Context<UpdateLaunchControls>,
        protocol_paused: bool,
        disabled_task_type_mask: u8,
        surface_revision: u16,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::MultisigNotEnoughSigners
        );
        instructions::update_launch_controls::handler(
            ctx,
            protocol_paused,
            disabled_task_type_mask,
            surface_revision,
        )
    }

    /// Atomically verify the reviewed mainnet release accounts and stamp the
    /// current surface revision while the protocol remains paused.
    #[allow(clippy::too_many_arguments)]
    pub fn stamp_release_surface(
        ctx: Context<StampReleaseSurface>,
        disabled_task_type_mask: u8,
        surface_revision: u16,
        expected_protocol_config_hash: [u8; 32],
        expected_program_data_slot: u64,
        expected_program_data_payload_len: u32,
        expected_upgrade_authority: Pubkey,
        expected_bid_config_hash: [u8; 32],
        expected_moderation_config_hash: [u8; 32],
        expected_idl_account_hash: [u8; 32],
        expected_custody_address: Pubkey,
        expected_custody_owner: Pubkey,
        expected_custody_account_hash: [u8; 32],
    ) -> Result<()> {
        instructions::stamp_release_surface::handler(
            ctx,
            disabled_task_type_mask,
            surface_revision,
            expected_protocol_config_hash,
            expected_program_data_slot,
            expected_program_data_payload_len,
            expected_upgrade_authority,
            expected_bid_config_hash,
            expected_moderation_config_hash,
            expected_idl_account_hash,
            expected_custody_address,
            expected_custody_owner,
            expected_custody_account_hash,
        )
    }

    /// Migrate protocol to a new version (multisig gated).
    /// Handles state migration when upgrading the program.
    ///
    /// # Arguments
    /// * `target_version` - The version to migrate to
    pub fn migrate_protocol(ctx: Context<MigrateProtocol>, target_version: u8) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::MultisigNotEnoughSigners
        );
        instructions::migrate::handler(ctx, target_version)
    }

    /// Migrate one Task account to the P6.2 layout (382B or 432B -> 466B; appends the
    /// operator + referrer fee legs). Multisig gated, VERSION-UNGATED (must run while
    /// version == 1, before the version bump). `dry_run` validates without mutating.
    /// Idempotent / re-runnable.
    pub fn migrate_task(ctx: Context<MigrateTask>, dry_run: bool) -> Result<()> {
        instructions::migrate::migrate_task_handler(ctx, dry_run)
    }

    /// Update minimum supported protocol version (multisig gated).
    /// Used to deprecate old versions after migration grace period.
    ///
    /// # Arguments
    /// * `new_min_version` - The new minimum supported version
    pub fn update_min_version(ctx: Context<UpdateMinVersion>, new_min_version: u8) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::MultisigNotEnoughSigners
        );
        instructions::migrate::update_min_version_handler(ctx, new_min_version)
    }

    /// Initialize governance configuration.
    /// Must be called by the protocol authority.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn initialize_governance(
        ctx: Context<InitializeGovernance>,
        voting_period: i64,
        execution_delay: i64,
        quorum_bps: u16,
        approval_threshold_bps: u16,
        min_proposal_stake: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::UnauthorizedAgent
        );
        instructions::initialize_governance::handler(
            ctx,
            voting_period,
            execution_delay,
            quorum_bps,
            approval_threshold_bps,
            min_proposal_stake,
        )
    }

    /// Create a governance proposal.
    /// Proposer must be an active agent with sufficient stake.
    #[cfg(not(feature = "mainnet-canary"))]
    #[allow(clippy::too_many_arguments)]
    pub fn create_proposal(
        ctx: Context<CreateProposal>,
        nonce: u64,
        proposal_type: u8,
        title_hash: [u8; 32],
        description_hash: [u8; 32],
        payload: [u8; 64],
        voting_period: i64,
    ) -> Result<()> {
        instructions::create_proposal::handler(
            ctx,
            nonce,
            proposal_type,
            title_hash,
            description_hash,
            payload,
            voting_period,
        )
    }

    /// Vote on a governance proposal.
    /// Voter must be an active agent. Double voting prevented by PDA uniqueness.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn vote_proposal(ctx: Context<VoteProposal>, approve: bool) -> Result<()> {
        instructions::vote_proposal::handler(ctx, approve)
    }

    /// Execute an approved governance proposal after voting period ends.
    /// Permissionless — anyone can call after quorum + majority is met.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn execute_proposal(ctx: Context<ExecuteProposal>) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::InvalidInput
        );
        instructions::execute_proposal::handler(ctx)
    }

    /// Cancel a governance proposal before any votes are cast.
    /// Only the proposer's authority can cancel.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn cancel_proposal(ctx: Context<CancelProposal>) -> Result<()> {
        instructions::cancel_proposal::handler(ctx)
    }

    /// Register a new skill on-chain.
    /// Author must be an active agent.
    #[cfg(not(feature = "mainnet-canary"))]
    #[allow(clippy::too_many_arguments)]
    pub fn register_skill(
        ctx: Context<RegisterSkill>,
        skill_id: [u8; 32],
        name: [u8; 32],
        content_hash: [u8; 32],
        price: u64,
        price_mint: Option<Pubkey>,
        tags: [u8; 64],
    ) -> Result<()> {
        instructions::register_skill::handler(
            ctx,
            skill_id,
            name,
            content_hash,
            price,
            price_mint,
            tags,
        )
    }

    /// Update a skill's content, price, tags, or active status.
    /// Only the skill author can update.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn update_skill(
        ctx: Context<UpdateSkill>,
        content_hash: [u8; 32],
        price: u64,
        tags: Option<[u8; 64]>,
        is_active: Option<bool>,
    ) -> Result<()> {
        instructions::update_skill::handler(ctx, content_hash, price, tags, is_active)
    }

    /// Publish a standing service listing (embeddable marketplace).
    #[cfg(not(feature = "mainnet-canary"))]
    #[allow(clippy::too_many_arguments)]
    pub fn create_service_listing(
        ctx: Context<CreateServiceListing>,
        listing_id: [u8; 32],
        name: [u8; 32],
        category: [u8; 32],
        tags: [u8; 64],
        spec_hash: [u8; 32],
        spec_uri: String,
        price: u64,
        price_mint: Option<Pubkey>,
        required_capabilities: u64,
        default_deadline_secs: i64,
        max_open_jobs: u16,
        operator: Option<Pubkey>,
        operator_fee_bps: u16,
    ) -> Result<()> {
        instructions::create_service_listing::handler(
            ctx,
            listing_id,
            name,
            category,
            tags,
            spec_hash,
            spec_uri,
            price,
            price_mint,
            required_capabilities,
            default_deadline_secs,
            max_open_jobs,
            operator,
            operator_fee_bps,
        )
    }

    /// Update a service listing's terms (provider-only).
    #[cfg(not(feature = "mainnet-canary"))]
    #[allow(clippy::too_many_arguments)]
    pub fn update_service_listing(
        ctx: Context<UpdateServiceListing>,
        price: Option<u64>,
        spec_hash: Option<[u8; 32]>,
        spec_uri: Option<String>,
        tags: Option<[u8; 64]>,
        required_capabilities: Option<u64>,
        default_deadline_secs: Option<i64>,
        max_open_jobs: Option<u16>,
        operator: Option<Pubkey>,
        operator_fee_bps: Option<u16>,
    ) -> Result<()> {
        instructions::update_service_listing::handler(
            ctx,
            price,
            spec_hash,
            spec_uri,
            tags,
            required_capabilities,
            default_deadline_secs,
            max_open_jobs,
            operator,
            operator_fee_bps,
        )
    }

    /// Pause / reactivate / retire a service listing (provider-only). Reactivating
    /// to `Active` requires exactly one readonly remaining account: the listing's
    /// canonical provider `AgentRegistration`. Pausing or retiring requires no
    /// remaining accounts, so a closed provider identity cannot block safe exits.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn set_service_listing_state(
        ctx: Context<SetServiceListingState>,
        new_state: u8,
    ) -> Result<()> {
        instructions::set_service_listing_state::handler(ctx, new_state)
    }

    /// Hire a provider from a standing service listing, minting a one-shot task
    /// that snapshots the listing's terms and funds escrow from the buyer.
    ///
    /// The explicit v2 discriminator (`sha256("global:hire_from_listing_v2")[0..8]`)
    /// is an atomic rollout boundary: the old
    /// program rejects new clients instead of silently ignoring the appended
    /// task-job-spec commitment, and the upgraded program rejects old clients.
    #[cfg(not(feature = "mainnet-canary"))]
    #[instruction(discriminator = [241, 94, 127, 7, 104, 174, 240, 116])]
    pub fn hire_from_listing(
        ctx: Context<HireFromListing>,
        task_id: [u8; 32],
        expected_price: u64,
        expected_version: u64,
        referrer: Option<Pubkey>,
        referrer_fee_bps: u16,
        moderator: Pubkey,
        task_job_spec_hash: [u8; 32],
    ) -> Result<()> {
        instructions::hire_from_listing::handler(
            ctx,
            task_id,
            expected_price,
            expected_version,
            referrer,
            referrer_fee_bps,
            moderator,
            task_job_spec_hash,
        )
    }

    /// Hire a provider from a standing service listing as a human buyer with NO
    /// registered agent (single-agent storefront). Funds SOL escrow, carries the
    /// listing's operator-fee leg (the embedding site's cut), and pins
    /// ValidationMode::CreatorReview so the human reviews the work before payout.
    /// Its discriminator is
    /// `sha256("global:hire_from_listing_humanless_v2")[0..8]` so the
    /// required task commitment cannot be silently ignored by the old binary.
    #[cfg(not(feature = "mainnet-canary"))]
    #[allow(clippy::too_many_arguments)]
    #[instruction(discriminator = [229, 163, 171, 114, 38, 116, 215, 85])]
    pub fn hire_from_listing_humanless(
        ctx: Context<HireFromListingHumanless>,
        task_id: [u8; 32],
        expected_price: u64,
        expected_version: u64,
        review_window_secs: i64,
        referrer: Option<Pubkey>,
        referrer_fee_bps: u16,
        moderator: Pubkey,
        task_job_spec_hash: [u8; 32],
    ) -> Result<()> {
        instructions::hire_from_listing_humanless::handler(
            ctx,
            task_id,
            expected_price,
            expected_version,
            review_window_secs,
            referrer,
            referrer_fee_bps,
            moderator,
            task_job_spec_hash,
        )
    }

    /// Record a moderation decision for a service listing's pinned job-spec hash,
    /// so `hire_from_listing` can gate at hire time. Moderation-authority only.
    #[cfg(not(feature = "mainnet-canary"))]
    #[allow(clippy::too_many_arguments)]
    pub fn record_listing_moderation(
        ctx: Context<RecordListingModeration>,
        job_spec_hash: [u8; 32],
        status: u8,
        risk_score: u8,
        category_mask: u64,
        policy_hash: [u8; 32],
        scanner_hash: [u8; 32],
        expires_at: i64,
    ) -> Result<()> {
        instructions::record_listing_moderation::handler(
            ctx,
            job_spec_hash,
            status,
            risk_score,
            category_mask,
            policy_hash,
            scanner_hash,
            expires_at,
        )
    }

    /// Record a domain-verification attestation for an agent (P7.3). A TRUSTED attestor
    /// (the global moderation authority OR a registered, non-revoked `ModerationAttestor`)
    /// records that operator domain `verified_domain` was proven to control the agent. The
    /// off-chain domain-control proof (TXT record / `.well-known` + signed challenge) is the
    /// attestor SERVICE's job; on-chain this only records the trusted verdict. `method`:
    /// 0 = TxtRecord, 1 = WellKnown. `expires_at`: 0 = no expiry. Re-verification overwrites
    /// the `["agent_verification", agent]` PDA in place.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn record_agent_verification(
        ctx: Context<RecordAgentVerification>,
        verified_domain: String,
        method: u8,
        expires_at: i64,
    ) -> Result<()> {
        instructions::record_agent_verification::handler(ctx, verified_domain, method, expires_at)
    }

    /// Revoke an agent's domain verification (P7.3), marking it `revoked = true` so the
    /// record stays readable. Same trusted-roster authorization as
    /// `record_agent_verification`.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn revoke_agent_verification(ctx: Context<RevokeAgentVerification>) -> Result<()> {
        instructions::revoke_agent_verification::handler(ctx)
    }

    /// Create a task as a human buyer with no registered agent. Always pins
    /// ValidationMode::CreatorReview so settlement routes through buyer review.
    #[cfg(not(feature = "mainnet-canary"))]
    #[allow(clippy::too_many_arguments)]
    pub fn create_task_humanless(
        ctx: Context<CreateTaskHumanless>,
        task_id: [u8; 32],
        required_capabilities: u64,
        description: [u8; 64],
        reward_amount: u64,
        deadline: i64,
        min_reputation: u16,
        review_window_secs: i64,
        referrer: Option<Pubkey>,
        referrer_fee_bps: u16,
    ) -> Result<()> {
        instructions::create_task_humanless::handler(
            ctx,
            task_id,
            required_capabilities,
            description,
            reward_amount,
            deadline,
            min_reputation,
            review_window_secs,
            referrer,
            referrer_fee_bps,
        )
    }

    /// Clean supplied children of a terminal task while retaining the rent-exempt
    /// Task as a durable liveness anchor for any children not supplied.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn close_task<'info>(ctx: Context<'_, '_, '_, 'info, CloseTask<'info>>) -> Result<()> {
        instructions::close_task::handler(ctx)
    }

    /// Return rent from a historical rent-only task child whose parent was
    /// destroyed by an older close_task implementation. The destination is
    /// derived from stored program state; the permissionless cranker cannot pick it.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn reclaim_orphan_task_child<'info>(
        ctx: Context<'_, '_, '_, 'info, ReclaimOrphanTaskChild<'info>>,
    ) -> Result<()> {
        instructions::reclaim_orphan_task_child::handler(ctx)
    }

    /// Post a symmetric 25% completion bond (Batch 3 §8). `role`: 0 = creator,
    /// 1 = worker. SOL-only v1; single-worker (Exclusive) tasks only.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn post_completion_bond(ctx: Context<PostCompletionBond>, role: u8) -> Result<()> {
        instructions::post_completion_bond::handler(ctx, role)
    }

    /// Permissionlessly refund a still-live completion bond to its poster once the
    /// task is Completed — recovers a bond stranded by a terminal exit that omitted
    /// the optional bond account (audit fix). `role`: 0 = creator, 1 = worker.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn reclaim_completion_bond(ctx: Context<ReclaimCompletionBond>, role: u8) -> Result<()> {
        instructions::reclaim_completion_bond::handler(ctx, role)
    }

    /// Request free, non-terminal revisions on a submitted result (Batch 3 §8). Keeps
    /// the claim open for an in-place resubmit; bounded by MAX_REVISION_ROUNDS.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn request_changes(ctx: Context<RequestChanges>, changes_hash: [u8; 32]) -> Result<()> {
        instructions::request_changes::handler(ctx, changes_hash)
    }

    /// Terminally reject a submission and freeze the task for review (Batch 3 §8).
    /// Settles only via resolve_reject_frozen / expire_reject_frozen.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn reject_and_freeze(
        ctx: Context<RejectAndFreeze>,
        rejection_hash: [u8; 32],
    ) -> Result<()> {
        instructions::reject_and_freeze::handler(ctx, rejection_hash)
    }

    /// Multisig review decision on a frozen task (Batch 3 §8): pay the worker
    /// (approve_completion=true) or refund the creator (false), disposing both bonds.
    /// Exit path — settles even while paused (money never locks).
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn resolve_reject_frozen(
        ctx: Context<ResolveRejectFrozen>,
        approve_completion: bool,
    ) -> Result<()> {
        instructions::reject_frozen_exits::resolve_handler(ctx, approve_completion)
    }

    /// Permissionless timeout exit for a frozen task (Batch 3 §8): after the review
    /// window lapses, default to the worker (pay + refund both bonds). Exit path.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn expire_reject_frozen(ctx: Context<ExpireRejectFrozen>) -> Result<()> {
        instructions::reject_frozen_exits::expire_handler(ctx)
    }

    /// Permissionless contest ghost-split crank (Batch 3 WS-CONTEST §3): from
    /// `ghost_at = deadline + SELECTION_WINDOW_SECS`, pay one live (Submitted)
    /// contest submission its equal slice of the remaining escrow pool — same fee
    /// legs as settlement — and close its submission + claim to the worker. The
    /// final slice sweeps the pool, completes the task, and closes the escrow.
    /// Exit path — settles even while paused (money never locks).
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn distribute_ghost_share(ctx: Context<DistributeGhostShare>) -> Result<()> {
        instructions::distribute_ghost_share::handler(ctx)
    }

    /// Permissionlessly reclaim an unsettled claim stranded on an already-terminal
    /// (Completed/Cancelled) task. The canonical submission PDA must prove an
    /// empty/no-submission record, a Rejected submission, or a still-Submitted
    /// Collaborative straggler after completion. Frees task/worker slot counters,
    /// returns eligible claim/submission balances to the worker, and forfeits any
    /// applicable no-show/rejection surplus to the treasury. Exit path — settles
    /// even while paused (money never locks).
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn reclaim_terminal_claim(ctx: Context<ReclaimTerminalClaim>) -> Result<()> {
        instructions::reclaim_terminal_claim::handler(ctx)
    }

    /// Rate a skill (1-5, reputation-weighted).
    /// One rating per agent per skill, enforced by PDA uniqueness.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn rate_skill(
        ctx: Context<RateSkill>,
        rating: u8,
        review_hash: Option<[u8; 32]>,
    ) -> Result<()> {
        instructions::rate_skill::handler(ctx, rating, review_hash)
    }

    /// Purchase a skill (SOL or SPL token).
    /// Protocol fee is deducted and sent to treasury.
    /// expected_price provides slippage protection against front-running.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn purchase_skill(
        ctx: Context<PurchaseSkill>,
        expected_price: u64,
        expected_version: u8,
        expected_content_hash: [u8; 32],
    ) -> Result<()> {
        instructions::purchase_skill::handler(
            ctx,
            expected_price,
            expected_version,
            expected_content_hash,
        )
    }

    /// Batch 4 (docs/design/batch-4-goods.md): list a FINITE, transferable good.
    /// Seller must be an active agent. The good itself is off-chain; the listing
    /// is the payment + provenance + protocol-cut rail. Requires the batch-4
    /// surface stamp (`surface_revision >= 4`).
    #[cfg(not(feature = "mainnet-canary"))]
    #[allow(clippy::too_many_arguments)]
    pub fn create_goods_listing(
        ctx: Context<CreateGoodsListing>,
        good_id: [u8; 32],
        name: [u8; 32],
        metadata_hash: [u8; 32],
        metadata_uri: String,
        price: u64,
        price_mint: Option<Pubkey>,
        tags: [u8; 64],
        total_supply: u64,
        operator: Pubkey,
        operator_fee_bps: u16,
    ) -> Result<()> {
        instructions::create_goods_listing::handler(
            ctx,
            good_id,
            name,
            metadata_hash,
            metadata_uri,
            price,
            price_mint,
            tags,
            total_supply,
            operator,
            operator_fee_bps,
        )
    }

    /// Batch 4: purchase ONE unit of a finite good (SOL or SPL token).
    /// The buyer is a bare wallet (no agent registration). Protocol fee goes to
    /// the treasury; an optional operator leg rides the settlement combined-fee
    /// cap. `expected_serial` pins this sale's receipt PDA (stale = retry);
    /// `expected_price` is the slippage guard.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn purchase_good(
        ctx: Context<PurchaseGood>,
        expected_serial: u64,
        expected_price: u64,
        expected_metadata_hash: [u8; 32],
    ) -> Result<()> {
        instructions::purchase_good::handler(
            ctx,
            expected_serial,
            expected_price,
            expected_metadata_hash,
        )
    }

    /// Batch 4: update a goods listing (seller only): price / active flag /
    /// metadata (hash+uri together) / tags / operator terms, and RESTOCK via
    /// additive delta only (never an absolute supply set).
    #[cfg(not(feature = "mainnet-canary"))]
    #[allow(clippy::too_many_arguments)]
    pub fn update_goods_listing(
        ctx: Context<UpdateGoodsListing>,
        price: Option<u64>,
        is_active: Option<bool>,
        metadata_hash: Option<[u8; 32]>,
        metadata_uri: Option<String>,
        tags: Option<[u8; 64]>,
        additional_supply: Option<u64>,
        operator: Option<Pubkey>,
        operator_fee_bps: Option<u16>,
    ) -> Result<()> {
        instructions::update_goods_listing::handler(
            ctx,
            price,
            is_active,
            metadata_hash,
            metadata_uri,
            tags,
            additional_supply,
            operator,
            operator_fee_bps,
        )
    }

    /// Post to the agent feed.
    /// Author must be an active agent. Content is stored on IPFS, hash on-chain.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn post_to_feed(
        ctx: Context<PostToFeed>,
        content_hash: [u8; 32],
        nonce: [u8; 32],
        topic: [u8; 32],
        parent_post: Option<Pubkey>,
    ) -> Result<()> {
        instructions::post_to_feed::handler(ctx, content_hash, nonce, topic, parent_post)
    }

    /// Upvote a feed post.
    /// One vote per agent per post, enforced by PDA uniqueness.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn upvote_post(ctx: Context<UpvotePost>) -> Result<()> {
        instructions::upvote_post::handler(ctx)
    }

    /// Stake SOL on agent reputation.
    /// Creates or adds to an existing reputation stake account.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn stake_reputation(ctx: Context<StakeReputation>, amount: u64) -> Result<()> {
        instructions::stake_reputation::handler(ctx, amount)
    }

    /// Withdraw SOL from reputation stake after cooldown period.
    /// Agent must have no pending disputes as defendant.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn withdraw_reputation_stake(
        ctx: Context<WithdrawReputationStake>,
        amount: u64,
    ) -> Result<()> {
        instructions::withdraw_reputation_stake::handler(ctx, amount)
    }

    /// Delegate reputation points to a trusted peer.
    /// One delegation per (delegator, delegatee) pair.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn delegate_reputation(
        ctx: Context<DelegateReputation>,
        amount: u16,
        expires_at: i64,
    ) -> Result<()> {
        instructions::delegate_reputation::handler(ctx, amount, expires_at)
    }

    /// Permissionlessly retire a legacy reputation delegation without restoring
    /// slash-sheltered reputation. An identity-continuous record returns rent to
    /// its recorded authority; an orphan sends rent only to the canonical treasury.
    /// Orphan recovery appends exactly two accounts after the three fixed metas:
    /// `[canonical ProtocolConfig readonly, configured treasury writable]`.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn revoke_delegation<'info>(
        ctx: Context<'_, '_, '_, 'info, RevokeDelegation<'info>>,
    ) -> Result<()> {
        instructions::revoke_delegation::handler(ctx)
    }

    /// Rate a completed listing hire (P6.1). The task's recorded buyer
    /// (`task.creator`) scores the delivered work once the task is terminally
    /// `Completed`; one rating per hire is enforced by the init-once
    /// `["hire_rating", task]` PDA. Folds the score into the source listing's
    /// `total_rating`/`rating_count` aggregate and emits `ListingRated`.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn rate_hire(
        ctx: Context<RateHire>,
        score: u8,
        review_hash: Option<[u8; 32]>,
        review_uri: String,
    ) -> Result<()> {
        instructions::rate_hire::handler(ctx, score, review_hash, review_uri)
    }

    /// Register a permissionless on-chain store identity (P5.2, batch 2). The
    /// signer pays rent + the hardcoded 0.05 SOL bond onto its own `["store",
    /// owner]` PDA. The handle is display-only (NOT unique on-chain); fee fields
    /// are advertised defaults, not enforcement.
    #[cfg(not(feature = "mainnet-canary"))]
    #[allow(clippy::too_many_arguments)]
    pub fn register_store(
        ctx: Context<RegisterStore>,
        handle: [u8; 32],
        metadata_hash: [u8; 32],
        metadata_uri: String,
        referrer_fee_bps: u16,
        operator: Pubkey,
        operator_fee_bps: u16,
        domain: String,
    ) -> Result<()> {
        instructions::store_identity::register_handler(
            ctx,
            handle,
            metadata_hash,
            metadata_uri,
            referrer_fee_bps,
            operator,
            operator_fee_bps,
            domain,
        )
    }

    /// Update a store's advertised identity/terms (owner-only, P5.2). Bumps the
    /// monotonic `version` for indexer staleness/CAS.
    #[cfg(not(feature = "mainnet-canary"))]
    #[allow(clippy::too_many_arguments)]
    pub fn update_store(
        ctx: Context<UpdateStore>,
        handle: [u8; 32],
        metadata_hash: [u8; 32],
        metadata_uri: String,
        referrer_fee_bps: u16,
        operator: Pubkey,
        operator_fee_bps: u16,
        domain: String,
    ) -> Result<()> {
        instructions::store_identity::update_handler(
            ctx,
            handle,
            metadata_hash,
            metadata_uri,
            referrer_fee_bps,
            operator,
            operator_fee_bps,
            domain,
        )
    }

    /// Close a store identity PDA (owner-only, P5.2), refunding rent + bond in
    /// full. No exit cooldown: nothing money-bearing consumes `Store` in v1.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn close_store(ctx: Context<CloseStore>) -> Result<()> {
        instructions::store_identity::close_handler(ctx)
    }

    /// P1.3 moderation liveness heartbeat (batch-2 A2). The config authority or
    /// the moderation authority bumps the deadman timestamp; the config authority
    /// may also retune the liveness window (floored at 1 day). Silence past the
    /// window relaxes the moderation ALLOW gates to moderation-optional
    /// (docs/MODERATION_LIVENESS.md); the multisig BLOCK floor never relaxes.
    #[cfg(not(feature = "mainnet-canary"))]
    pub fn moderation_heartbeat(
        ctx: Context<ModerationHeartbeat>,
        new_window_secs: Option<u32>,
    ) -> Result<()> {
        instructions::moderation_heartbeat::handler(ctx, new_window_secs)
    }
}

#[cfg(feature = "mainnet-canary")]
#[program]
pub mod agenc_coordination {
    use super::*;

    /// Register a new agent on-chain with its capabilities and metadata.
    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        agent_id: [u8; 32],
        capabilities: u64,
        endpoint: String,
        metadata_uri: Option<String>,
        stake_amount: u64,
    ) -> Result<()> {
        instructions::register_agent::handler(
            ctx,
            agent_id,
            capabilities,
            endpoint,
            metadata_uri,
            stake_amount,
        )
    }

    /// Update an existing agent's registration data.
    pub fn update_agent(
        ctx: Context<UpdateAgent>,
        capabilities: Option<u64>,
        endpoint: Option<String>,
        metadata_uri: Option<String>,
        status: Option<u8>,
    ) -> Result<()> {
        instructions::update_agent::handler(ctx, capabilities, endpoint, metadata_uri, status)
    }

    /// Suspend an agent during a canary incident.
    pub fn suspend_agent(ctx: Context<SuspendAgent>) -> Result<()> {
        instructions::suspend_agent::handler(ctx)
    }

    /// Unsuspend an agent after operator review.
    pub fn unsuspend_agent(ctx: Context<UnsuspendAgent>) -> Result<()> {
        instructions::unsuspend_agent::handler(ctx)
    }

    /// Deregister an agent and reclaim rent.
    pub fn deregister_agent(ctx: Context<DeregisterAgent>) -> Result<()> {
        instructions::deregister_agent::handler(ctx)
    }

    /// Create a canary task. The handler enforces Exclusive, single-worker,
    /// SOL-only, non-private task creation when `mainnet-canary` is enabled.
    #[allow(clippy::too_many_arguments)]
    pub fn create_task(
        ctx: Context<CreateTask>,
        task_id: [u8; 32],
        required_capabilities: u64,
        description: [u8; 64],
        reward_amount: u64,
        max_workers: u8,
        deadline: i64,
        task_type: u8,
        constraint_hash: Option<[u8; 32]>,
        min_reputation: u16,
        reward_mint: Option<Pubkey>,
        referrer: Option<Pubkey>,
        referrer_fee_bps: u16,
    ) -> Result<()> {
        instructions::create_task::handler(
            ctx,
            task_id,
            required_capabilities,
            description,
            reward_amount,
            max_workers,
            deadline,
            task_type,
            constraint_hash,
            min_reputation,
            reward_mint,
            referrer,
            referrer_fee_bps,
        )
    }

    /// Configure the moderation authority required before task job-spec publication.
    pub fn configure_task_moderation(
        ctx: Context<ConfigureTaskModeration>,
        moderation_authority: Pubkey,
        enabled: bool,
    ) -> Result<()> {
        instructions::configure_task_moderation::handler(ctx, moderation_authority, enabled)
    }

    /// Record a moderation decision for a task/job-spec hash.
    #[allow(clippy::too_many_arguments)]
    pub fn record_task_moderation(
        ctx: Context<RecordTaskModeration>,
        job_spec_hash: [u8; 32],
        status: u8,
        risk_score: u8,
        category_mask: u64,
        policy_hash: [u8; 32],
        scanner_hash: [u8; 32],
        expires_at: i64,
    ) -> Result<()> {
        instructions::record_task_moderation::handler(
            ctx,
            job_spec_hash,
            status,
            risk_score,
            category_mask,
            policy_hash,
            scanner_hash,
            expires_at,
        )
    }

    /// Attach a content-addressed off-chain job specification pointer for a task.
    pub fn set_task_job_spec(
        ctx: Context<SetTaskJobSpec>,
        job_spec_hash: [u8; 32],
        job_spec_uri: String,
    ) -> Result<()> {
        instructions::set_task_job_spec::handler(ctx, job_spec_hash, job_spec_uri)
    }

    /// Claim a task only when its content-addressed job specification pointer exists.
    pub fn claim_task_with_job_spec(ctx: Context<ClaimTaskWithJobSpec>) -> Result<()> {
        instructions::claim_task::handler_with_job_spec(ctx)
    }

    /// Enable creator-review validation for an open canary task.
    pub fn configure_task_validation(
        ctx: Context<ConfigureTaskValidation>,
        mode: u8,
        review_window_secs: i64,
        validator_quorum: u8,
        attestor: Option<Pubkey>,
    ) -> Result<()> {
        instructions::configure_task_validation::handler(
            ctx,
            mode,
            review_window_secs,
            validator_quorum,
            attestor,
        )
    }

    /// Expire a stale claim to free a canary task slot.
    pub fn expire_claim<'info>(ctx: Context<'_, '_, '_, 'info, ExpireClaim<'info>>) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::InvalidInput
        );
        instructions::expire_claim::handler(ctx)
    }

    /// Submit a result for creator review before final settlement.
    pub fn submit_task_result(
        ctx: Context<SubmitTaskResult>,
        proof_hash: [u8; 32],
        result_data: Option<[u8; 64]>,
    ) -> Result<()> {
        instructions::submit_task_result::handler(ctx, proof_hash, result_data)
    }

    /// Accept a creator-reviewed submission and settle rewards.
    pub fn accept_task_result(ctx: Context<AcceptTaskResult>) -> Result<()> {
        instructions::accept_task_result::handler(ctx)
    }

    /// Reject a creator-reviewed submission and return the task to active work.
    pub fn reject_task_result<'info>(
        ctx: Context<'_, '_, '_, 'info, RejectTaskResult<'info>>,
        rejection_hash: [u8; 32],
    ) -> Result<()> {
        instructions::reject_task_result::handler(ctx, rejection_hash)
    }

    /// Cancel an unclaimed or expired task and reclaim funds.
    pub fn cancel_task<'info>(ctx: Context<'_, '_, '_, 'info, CancelTask<'info>>) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::UnauthorizedTaskAction
        );
        instructions::cancel_task::process_cancel_task(ctx)
    }

    /// Initialize the protocol configuration.
    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        dispute_threshold: u8,
        protocol_fee_bps: u16,
        min_stake: u64,
        min_stake_for_dispute: u64,
        multisig_threshold: u8,
        multisig_owners: Vec<Pubkey>,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::UnauthorizedUpgrade
        );
        instructions::initialize_protocol::handler(
            ctx,
            dispute_threshold,
            protocol_fee_bps,
            min_stake,
            min_stake_for_dispute,
            multisig_threshold,
            multisig_owners,
        )
    }

    /// Update the protocol fee.
    pub fn update_protocol_fee(
        ctx: Context<UpdateProtocolFee>,
        protocol_fee_bps: u16,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::MultisigNotEnoughSigners
        );
        instructions::update_protocol_fee::handler(ctx, protocol_fee_bps)
    }

    /// Update protocol treasury destination.
    pub fn update_treasury(ctx: Context<UpdateTreasury>) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::MultisigNotEnoughSigners
        );
        instructions::update_treasury::handler(ctx)
    }

    /// Rotate multisig owners/threshold.
    pub fn update_multisig(
        ctx: Context<UpdateMultisig>,
        new_threshold: u8,
        new_owners: Vec<Pubkey>,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::MultisigNotEnoughSigners
        );
        instructions::update_multisig::handler(ctx, new_threshold, new_owners)
    }

    /// Update rate limiting configuration.
    pub fn update_rate_limits(
        ctx: Context<UpdateRateLimits>,
        task_creation_cooldown: i64,
        max_tasks_per_24h: u8,
        dispute_initiation_cooldown: i64,
        max_disputes_per_24h: u8,
        min_stake_for_dispute: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::MultisigNotEnoughSigners
        );
        instructions::update_rate_limits::handler(
            ctx,
            task_creation_cooldown,
            max_tasks_per_24h,
            dispute_initiation_cooldown,
            max_disputes_per_24h,
            min_stake_for_dispute,
        )
    }

    /// Update emergency launch controls. The restricted canary may preserve its
    /// live revision or explicitly select only the conservative revision `0`.
    pub fn update_launch_controls(
        ctx: Context<UpdateLaunchControls>,
        protocol_paused: bool,
        disabled_task_type_mask: u8,
        surface_revision: u16,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::MultisigNotEnoughSigners
        );
        instructions::update_launch_controls::handler(
            ctx,
            protocol_paused,
            disabled_task_type_mask,
            surface_revision,
        )
    }

    /// Migrate protocol to a new version.
    pub fn migrate_protocol(ctx: Context<MigrateProtocol>, target_version: u8) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::MultisigNotEnoughSigners
        );
        instructions::migrate::handler(ctx, target_version)
    }

    /// Migrate one Task account to the current layout (382B or 432B -> 466B; the shared
    /// handler reallocs to Task::SIZE = 466B). Multisig gated, version-ungated, idempotent.
    /// `dry_run` validates without mutating. (Was stale "382B -> 432B" — audit doc drift.)
    pub fn migrate_task(ctx: Context<MigrateTask>, dry_run: bool) -> Result<()> {
        instructions::migrate::migrate_task_handler(ctx, dry_run)
    }

    /// Update minimum supported protocol version.
    pub fn update_min_version(ctx: Context<UpdateMinVersion>, new_min_version: u8) -> Result<()> {
        require!(
            ctx.accounts.authority.is_signer,
            CoordinationError::MultisigNotEnoughSigners
        );
        instructions::migrate::update_min_version_handler(ctx, new_min_version)
    }
}
