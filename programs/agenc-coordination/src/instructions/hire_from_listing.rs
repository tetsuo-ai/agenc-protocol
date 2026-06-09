//! Hire a provider from a standing `ServiceListing` by minting a one-shot Task
//! (embeddable marketplace, Batch 1).
//!
//! Additive: snapshots the listing's terms into a fresh `Task` + `TaskEscrow`
//! exactly the way `create_task` would, so the entire existing task lifecycle
//! (`set_task_job_spec` -> `claim_task` -> `submit` -> `accept` / `cancel_task` /
//! `close_task`) applies unchanged.
//!
//! Moderation is gated at hire time (fail-closed): `moderation_config` is required,
//! and when enabled the hire must present a publishable listing-level attestation
//! (`ListingModeration`) for the listing's pinned `spec_hash` — the task-bound
//! `TaskModeration` PDA can't exist before the task is minted, so a listing/spec-keyed
//! attestation is used (spec §6). When moderation is disabled, the existing
//! `set_task_job_spec` path still gates go-live (Model-A).
//!
//! Provider auto-claim + the 3-way operator-fee split land in Batch 2 (they need a
//! `Task` layout migration).
//!
//! SOL-only in Batch 1 (token-priced listings are rejected), matching
//! `create_task`'s default-build posture; token hires arrive with the Batch 2
//! settlement work.

use crate::errors::CoordinationError;
use crate::events::{ServiceListingHired, TaskCreated};
use crate::instructions::constants::MIN_SKILL_PRICE;
use crate::instructions::launch_controls::require_task_type_index_enabled;
use crate::instructions::rate_limit_helpers::check_authority_task_creation_rate_limits;
use crate::instructions::task_init_helpers::{
    increment_total_tasks, init_escrow_fields, init_task_fields, validate_deadline,
};
use crate::state::{
    is_publishable_task_moderation_status, AgentRegistration, AuthorityRateLimit, HireRecord,
    ListingModeration, ListingState, ModerationConfig, ProtocolConfig, ServiceListing, Task,
    TaskEscrow, TaskType, TASK_MODERATION_RISK_SCORE_MAX,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;
use anchor_lang::system_program;

/// Pure validation of a listing's terms at hire time. Extracted so the
/// compare-and-swap, state, self-hire, and SOL-only guards are unit-testable and
/// revert-sensitive (removing any single `require!` turns a test red).
///
/// The price+version compare-and-swap is the anti-rug-pull guard: it rejects a
/// hire if the provider edited the listing (every `update_service_listing` bumps
/// `version`) between the buyer reading the terms and this transaction landing.
#[allow(clippy::too_many_arguments)]
pub(crate) fn validate_hire_terms(
    listing_state: ListingState,
    listing_price: u64,
    listing_version: u64,
    expected_price: u64,
    expected_version: u64,
    buyer_authority: Pubkey,
    provider_authority: Pubkey,
    listing_price_mint: Option<Pubkey>,
) -> Result<()> {
    require!(
        listing_state == ListingState::Active,
        CoordinationError::ListingNotActive
    );
    require!(
        listing_price == expected_price,
        CoordinationError::ListingPriceMismatch
    );
    require!(
        listing_version == expected_version,
        CoordinationError::ListingVersionMismatch
    );
    // No self-hire: a provider cannot hire its own listing (analogous to the bid
    // self-deal guard). Compared on the STORED listing authority, not a passed-in
    // account, so it cannot be spoofed.
    require!(
        buyer_authority != provider_authority,
        CoordinationError::SelfTaskNotAllowed
    );
    // Batch 1 is SOL-only (mirrors create_task's default build); token hires arrive
    // with the Batch 2 operator-split settlement work.
    require!(
        listing_price_mint.is_none(),
        CoordinationError::InvalidTokenMint
    );
    // Re-assert the listing price floor at hire time so a later MIN_SKILL_PRICE
    // change cannot strand a sub-floor hire.
    require!(
        listing_price >= MIN_SKILL_PRICE,
        CoordinationError::ListingPriceTooLow
    );
    Ok(())
}

/// Resolve a hire's relative deadline offset: the listing's configured value, or
/// the protocol default claim duration when the listing leaves it unset (0).
pub(crate) fn hire_deadline_offset(default_deadline_secs: i64, max_claim_duration: i64) -> i64 {
    if default_deadline_secs > 0 {
        default_deadline_secs
    } else {
        max_claim_duration
    }
}

/// Capacity gate: `max_open_jobs == 0` means unlimited; otherwise the listing must
/// have a free slot. `open_jobs` is incremented here on hire and decremented by
/// `close_task` (via the HireRecord link). The counter is conservative — if a
/// caller ever closes a hired task without supplying the HireRecord, the slot is
/// not freed, which can only ever BLOCK further hires (fail-safe), never over-admit.
pub(crate) fn validate_listing_capacity(open_jobs: u16, max_open_jobs: u16) -> Result<()> {
    require!(
        max_open_jobs == 0 || open_jobs < max_open_jobs,
        CoordinationError::ListingCapacityReached
    );
    Ok(())
}

/// The listing's content-commitment hash flows straight into the new task's
/// `description`; a hire must never mint a task with a zero/empty commitment.
/// `create_service_listing` and `update_service_listing` already reject a zero
/// `spec_hash`, so this is defense-in-depth against a corrupted/legacy listing.
pub(crate) fn validate_listing_spec_hash(spec_hash: &[u8; 32]) -> Result<()> {
    require!(
        *spec_hash != [0u8; 32],
        CoordinationError::ListingInvalidSpec
    );
    Ok(())
}

/// Hire-time moderation gate (spec §6). When `ModerationConfig.enabled`, a hire may
/// only mint a live task if the listing's pinned `spec_hash` carries a publishable
/// attestation (CLEAN | HUMAN_APPROVED, unexpired) recorded by the moderation
/// authority. Pure + revert-sensitive; mirrors
/// `set_task_job_spec::validate_task_moderation_for_job_spec` but listing/spec-keyed
/// (the task-bound `TaskModeration` PDA can't exist before the task is minted).
pub(crate) fn validate_listing_moderation_for_hire(
    moderation_config: &ModerationConfig,
    listing_moderation: &ListingModeration,
    listing_key: Pubkey,
    listing_spec_hash: &[u8; 32],
    now: i64,
) -> Result<()> {
    require!(
        moderation_config.moderation_authority != Pubkey::default(),
        CoordinationError::InvalidTaskModerationAuthority
    );
    require!(
        listing_moderation.moderator == moderation_config.moderation_authority,
        CoordinationError::UnauthorizedTaskModerator
    );
    require!(
        listing_moderation.listing == listing_key,
        CoordinationError::TaskModerationTaskMismatch
    );
    require!(
        listing_moderation.job_spec_hash == *listing_spec_hash,
        CoordinationError::TaskModerationHashMismatch
    );
    require!(
        is_publishable_task_moderation_status(listing_moderation.status),
        CoordinationError::TaskModerationRejected
    );
    require!(
        listing_moderation.risk_score <= TASK_MODERATION_RISK_SCORE_MAX,
        CoordinationError::InvalidTaskModerationRiskScore
    );
    require!(
        listing_moderation.expires_at == 0 || listing_moderation.expires_at >= now,
        CoordinationError::TaskModerationExpired
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(task_id: [u8; 32])]
pub struct HireFromListing<'info> {
    #[account(
        init,
        payer = creator,
        space = Task::SIZE,
        seeds = [b"task", creator.key().as_ref(), task_id.as_ref()],
        bump
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        init,
        payer = creator,
        space = TaskEscrow::SIZE,
        seeds = [b"escrow", task.key().as_ref()],
        bump
    )]
    pub escrow: Box<Account<'info, TaskEscrow>>,

    /// Links this hire to its source listing so close_task can decrement capacity
    /// without a Task layout change, and snapshots the operator fee terms.
    #[account(
        init,
        payer = creator,
        space = HireRecord::SIZE,
        seeds = [b"hire", task.key().as_ref()],
        bump
    )]
    pub hire_record: Box<Account<'info, HireRecord>>,

    /// Standing listing being hired from. Mutable to record the hire
    /// (`total_hires`, `updated_at`).
    #[account(
        mut,
        seeds = [b"service_listing", listing.provider_agent.as_ref(), listing.listing_id.as_ref()],
        bump = listing.bump
    )]
    pub listing: Box<Account<'info, ServiceListing>>,

    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// Global moderation gate. REQUIRED so a hire is fail-closed: an unconfigured
    /// gate (account absent) makes the hire fail = marketplace halt (spec §6). When
    /// `enabled`, a valid `listing_moderation` is required (checked in the handler).
    #[account(seeds = [b"moderation_config"], bump = moderation_config.bump)]
    pub moderation_config: Box<Account<'info, ModerationConfig>>,

    /// Listing/spec-keyed moderation attestation. Required iff `moderation_config.enabled`;
    /// bound by seeds to this listing's pinned `spec_hash` so it cannot be spoofed.
    #[account(
        seeds = [b"listing_moderation", listing.key().as_ref(), listing.spec_hash.as_ref()],
        bump = listing_moderation.bump
    )]
    pub listing_moderation: Option<Box<Account<'info, ListingModeration>>>,

    /// Buyer's agent registration for identity/authorization (mirrors create_task).
    #[account(
        seeds = [b"agent", creator_agent.agent_id.as_ref()],
        bump = creator_agent.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub creator_agent: Box<Account<'info, AgentRegistration>>,

    /// Wallet-scoped task/dispute rate limit state shared across all agents.
    #[account(
        init_if_needed,
        payer = creator,
        space = AuthorityRateLimit::SIZE,
        seeds = [b"authority_rate_limit", authority.key().as_ref()],
        bump
    )]
    pub authority_rate_limit: Box<Account<'info, AuthorityRateLimit>>,

    /// The authority that owns the buyer's agent.
    pub authority: Signer<'info>,

    /// The buyer who pays for and owns the hired task.
    /// Must match authority to prevent social-engineering attacks (#375).
    #[account(
        mut,
        constraint = creator.key() == authority.key() @ CoordinationError::CreatorAuthorityMismatch
    )]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Mints a one-shot `Task` from a `ServiceListing`, snapshotting its terms and
/// funding escrow from the buyer.
///
/// # Parameters
/// - `task_id`: caller-chosen unique id for the new task (PDA seed).
/// - `expected_price` / `expected_version`: the listing terms the buyer agreed
///   to; the hire is rejected if the on-chain listing no longer matches.
pub fn handler(
    ctx: Context<HireFromListing>,
    task_id: [u8; 32],
    expected_price: u64,
    expected_version: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let config = ctx.accounts.protocol_config.as_ref();

    check_version_compatible(config)?;
    // Hires mint an Exclusive one-shot task; respect the per-type kill switch.
    require_task_type_index_enabled(config, TaskType::Exclusive as u8)?;

    // Snapshot every listing field we need BEFORE taking any mutable borrow.
    let listing = ctx.accounts.listing.as_ref();
    let listing_key = listing.key();
    let provider_agent = listing.provider_agent;
    let reward_amount = listing.price;
    let required_capabilities = listing.required_capabilities;
    let listing_spec_hash = listing.spec_hash;
    let listing_deadline_secs = listing.default_deadline_secs;
    let listing_operator = listing.operator;
    let listing_operator_fee_bps = listing.operator_fee_bps;

    validate_hire_terms(
        listing.state,
        listing.price,
        listing.version,
        expected_price,
        expected_version,
        ctx.accounts.authority.key(),
        listing.authority,
        listing.price_mint,
    )?;
    // Capacity: reject if the listing has no free slot (max_open_jobs == 0 = unlimited).
    validate_listing_capacity(listing.open_jobs, listing.max_open_jobs)?;

    // Hire-time moderation gate (§6), fail-closed: moderation_config is a required
    // account, so an unconfigured marketplace can't hire. When enabled, the hire
    // must present a publishable listing-level attestation for the pinned spec_hash.
    // When disabled, keep Model-A (the existing set_task_job_spec path gates go-live).
    if ctx.accounts.moderation_config.enabled {
        let lm = ctx
            .accounts
            .listing_moderation
            .as_ref()
            .ok_or(CoordinationError::TaskModerationRequired)?;
        validate_listing_moderation_for_hire(
            ctx.accounts.moderation_config.as_ref(),
            lm.as_ref(),
            listing_key,
            &listing_spec_hash,
            clock.unix_timestamp,
        )?;
    }

    // Resolve the absolute deadline from the listing's relative offset (or the
    // protocol default), then validate it like create_task does.
    let deadline = clock
        .unix_timestamp
        .saturating_add(hire_deadline_offset(listing_deadline_secs, config.max_claim_duration));
    validate_deadline(deadline, &clock, true)?;

    // Snapshot the content-commitment hash into the task description (hash-shaped:
    // 32-byte digest + zero tail, as create_task requires).
    validate_listing_spec_hash(&listing_spec_hash)?;
    let mut description = [0u8; 64];
    description[..32].copy_from_slice(&listing_spec_hash);

    let protocol_fee_bps = config.protocol_fee_bps;
    let creator_agent = ctx.accounts.creator_agent.as_ref();

    // Rate-limit by authority (wallet) to mirror create_task anti-spam.
    check_authority_task_creation_rate_limits(
        ctx.accounts.authority_rate_limit.as_mut(),
        ctx.accounts.authority.key(),
        ctx.bumps.authority_rate_limit,
        creator_agent.agent_id,
        config,
        &clock,
    )?;

    // Initialize task-owned state before the escrow-funding CPI.
    let escrow_key = ctx.accounts.escrow.key();
    let creator_key = ctx.accounts.creator.key();
    let task = ctx.accounts.task.as_mut();
    init_task_fields(
        task,
        task_id,
        creator_key,
        required_capabilities,
        description,
        None, // constraint_hash: no private-task constraint for a listing hire
        reward_amount,
        1, // max_workers: one-shot exclusive hire
        TaskType::Exclusive as u8,
        deadline,
        escrow_key,
        ctx.bumps.task,
        protocol_fee_bps,
        clock.unix_timestamp,
        0,    // min_reputation: listing hires do not gate on reputation in Batch 1
        None, // reward_mint: SOL only in Batch 1
    )?;

    // §4: stamp the operator terms onto the Task itself so settlement reads the
    // 3-way split from the Task (the HireRecord stays the fallback for tasks hired
    // before the Batch-2 redeploy / the 149 migrated tasks). A creator that is also
    // the operator could self-deal the operator leg, so reject that here.
    if listing_operator != Pubkey::default() {
        require!(
            listing_operator != creator_key,
            CoordinationError::OperatorIsCreator
        );
        task.operator = listing_operator;
        task.operator_fee_bps = listing_operator_fee_bps;
    }
    let task_key = task.key();

    let escrow = ctx.accounts.escrow.as_mut();
    init_escrow_fields(escrow, task_key, reward_amount, ctx.bumps.escrow);

    // Fund escrow from the buyer (SOL).
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.creator.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
            },
        ),
        reward_amount,
    )?;

    // Protocol + listing bookkeeping.
    let protocol_config = ctx.accounts.protocol_config.as_mut();
    increment_total_tasks(protocol_config)?;

    // Record the hire on the listing: bump the lifetime count and occupy one
    // capacity slot. open_jobs is decremented by close_task via the HireRecord link
    // (no Task layout change / migration needed).
    let listing = ctx.accounts.listing.as_mut();
    listing.total_hires = listing
        .total_hires
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    listing.open_jobs = listing
        .open_jobs
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    listing.updated_at = clock.unix_timestamp;
    let total_hires = listing.total_hires;
    let open_jobs = listing.open_jobs;

    // Persist the task<->listing link + operator-fee snapshot (read by close_task
    // for capacity decrement, and by the Batch 2 settlement split).
    let hire_record = ctx.accounts.hire_record.as_mut();
    hire_record.task = task_key;
    hire_record.listing = listing_key;
    hire_record.operator = listing_operator;
    hire_record.operator_fee_bps = listing_operator_fee_bps;
    hire_record.bump = ctx.bumps.hire_record;
    hire_record._reserved = [0u8; 32];

    // Emit TaskCreated so the hired task is indistinguishable to existing
    // indexers/flows, plus a hire event linking listing -> task.
    emit!(TaskCreated {
        task_id,
        creator: creator_key,
        required_capabilities,
        reward_amount,
        task_type: TaskType::Exclusive as u8,
        deadline,
        min_reputation: 0,
        reward_mint: None,
        timestamp: clock.unix_timestamp,
    });
    emit!(ServiceListingHired {
        listing: listing_key,
        task: task_key,
        provider_agent,
        buyer: creator_key,
        price: reward_amount,
        total_hires,
        open_jobs,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok_terms() -> (ListingState, u64, u64, u64, u64, Pubkey, Pubkey, Option<Pubkey>) {
        (
            ListingState::Active,
            MIN_SKILL_PRICE,
            7,
            MIN_SKILL_PRICE,
            7,
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            None,
        )
    }

    #[test]
    fn accepts_matching_active_sol_listing() {
        let (s, p, v, ep, ev, b, pr, m) = ok_terms();
        assert!(validate_hire_terms(s, p, v, ep, ev, b, pr, m).is_ok());
    }

    // Revert-sensitive: each case isolates one require! in validate_hire_terms.
    #[test]
    fn rejects_inactive_listing() {
        let (_s, p, v, ep, ev, b, pr, m) = ok_terms();
        for state in [ListingState::Paused, ListingState::Retired] {
            assert!(validate_hire_terms(state, p, v, ep, ev, b, pr, m).is_err());
        }
    }

    #[test]
    fn rejects_price_mismatch() {
        let (s, p, v, _ep, ev, b, pr, m) = ok_terms();
        assert!(validate_hire_terms(s, p, v, p + 1, ev, b, pr, m).is_err());
    }

    #[test]
    fn rejects_version_mismatch() {
        let (s, p, v, ep, _ev, b, pr, m) = ok_terms();
        assert!(validate_hire_terms(s, p, v, ep, v + 1, b, pr, m).is_err());
    }

    #[test]
    fn rejects_self_hire() {
        let (s, p, v, ep, ev, _b, _pr, m) = ok_terms();
        let same = Pubkey::new_unique();
        assert!(validate_hire_terms(s, p, v, ep, ev, same, same, m).is_err());
    }

    #[test]
    fn rejects_token_priced_listing() {
        let (s, p, v, ep, ev, b, pr, _m) = ok_terms();
        assert!(
            validate_hire_terms(s, p, v, ep, ev, b, pr, Some(Pubkey::new_unique())).is_err()
        );
    }

    #[test]
    fn rejects_sub_floor_price() {
        let below = MIN_SKILL_PRICE - 1;
        let (s, _p, v, _ep, ev, b, pr, m) = ok_terms();
        assert!(validate_hire_terms(s, below, v, below, ev, b, pr, m).is_err());
    }

    #[test]
    fn capacity_allows_free_slot_and_unlimited() {
        assert!(validate_listing_capacity(0, 0).is_ok()); // unlimited
        assert!(validate_listing_capacity(4, 5).is_ok()); // free slot
        assert!(validate_listing_capacity(9999, 0).is_ok()); // unlimited ignores count
    }

    // Revert-sensitive: removing the capacity require! turns this red.
    #[test]
    fn capacity_rejects_when_full() {
        assert!(validate_listing_capacity(5, 5).is_err());
        assert!(validate_listing_capacity(6, 5).is_err());
    }

    #[test]
    fn rejects_zero_spec_hash() {
        assert!(validate_listing_spec_hash(&[0u8; 32]).is_err());
        let mut h = [0u8; 32];
        h[0] = 1;
        assert!(validate_listing_spec_hash(&h).is_ok());
    }

    fn mod_case(
        status: u8,
        expires_at: i64,
    ) -> (ModerationConfig, ListingModeration, Pubkey, [u8; 32]) {
        let auth = Pubkey::new_unique();
        let listing = Pubkey::new_unique();
        let mut hash = [0u8; 32];
        hash[0] = 1;
        (
            ModerationConfig {
                moderation_authority: auth,
                enabled: true,
                ..ModerationConfig::default()
            },
            ListingModeration {
                listing,
                job_spec_hash: hash,
                status,
                risk_score: 0,
                expires_at,
                moderator: auth,
                ..ListingModeration::default()
            },
            listing,
            hash,
        )
    }

    #[test]
    fn moderation_allows_clean_or_human_approved() {
        for status in [0u8 /*CLEAN*/, 4u8 /*HUMAN_APPROVED*/] {
            let (c, m, l, h) = mod_case(status, 0);
            assert!(validate_listing_moderation_for_hire(&c, &m, l, &h, 100).is_ok());
        }
    }

    // Revert-sensitive: each removes/violates exactly one require! in the gate.
    #[test]
    fn moderation_rejects_unpublishable_status() {
        for status in [1u8, 2u8, 3u8, 5u8] {
            let (c, m, l, h) = mod_case(status, 0);
            assert!(validate_listing_moderation_for_hire(&c, &m, l, &h, 100).is_err());
        }
    }

    #[test]
    fn moderation_rejects_hash_mismatch() {
        let (c, m, l, _h) = mod_case(0, 0);
        let mut other = [0u8; 32];
        other[0] = 9;
        assert!(validate_listing_moderation_for_hire(&c, &m, l, &other, 100).is_err());
    }

    #[test]
    fn moderation_rejects_listing_mismatch() {
        let (c, m, _l, h) = mod_case(0, 0);
        assert!(validate_listing_moderation_for_hire(&c, &m, Pubkey::new_unique(), &h, 100).is_err());
    }

    #[test]
    fn moderation_rejects_expired() {
        let (c, m, l, h) = mod_case(0, 99);
        assert!(validate_listing_moderation_for_hire(&c, &m, l, &h, 100).is_err());
        // unexpired (expires_at >= now) is fine
        let (c2, m2, l2, h2) = mod_case(0, 100);
        assert!(validate_listing_moderation_for_hire(&c2, &m2, l2, &h2, 100).is_ok());
    }

    #[test]
    fn moderation_rejects_wrong_moderator_and_zero_authority() {
        let (c, mut m, l, h) = mod_case(0, 0);
        m.moderator = Pubkey::new_unique(); // not the moderation authority
        assert!(validate_listing_moderation_for_hire(&c, &m, l, &h, 100).is_err());

        let (mut c2, m2, l2, h2) = mod_case(0, 0);
        c2.moderation_authority = Pubkey::default();
        assert!(validate_listing_moderation_for_hire(&c2, &m2, l2, &h2, 100).is_err());
    }

    #[test]
    fn deadline_offset_uses_listing_value_when_set() {
        assert_eq!(hire_deadline_offset(3600, 604_800), 3600);
    }

    #[test]
    fn deadline_offset_falls_back_to_protocol_default() {
        assert_eq!(hire_deadline_offset(0, 604_800), 604_800);
    }
}
