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
use crate::instructions::completion_helpers::resolve_referrer_snapshot;
use crate::instructions::constants::MIN_SKILL_PRICE;
use crate::instructions::launch_controls::require_task_type_index_enabled;
use crate::instructions::rate_limit_helpers::check_authority_task_creation_rate_limits;
use crate::instructions::task_init_helpers::{
    increment_total_tasks, init_escrow_fields, init_task_fields, validate_deadline,
};
use crate::state::{
    is_publishable_task_moderation_status, AgentRegistration, AuthorityRateLimit, HireRecord,
    ListingModeration, ListingState, ModerationAttestor, ModerationConfig, ProtocolConfig,
    ServiceListing, Task, TaskEscrow, TaskType, TASK_MODERATION_RISK_SCORE_MAX,
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
/// attestation (CLEAN | HUMAN_APPROVED, unexpired) authored by an authorized moderator.
/// Pure + revert-sensitive; mirrors
/// `set_task_job_spec::validate_task_moderation_for_job_spec` but listing/spec-keyed
/// (the task-bound `TaskModeration` PDA can't exist before the task is minted).
///
/// WP-A1: the attestation's `moderator` is accepted when it is EITHER the global
/// `ModerationConfig.moderation_authority` OR a registered, non-revoked
/// `ModerationAttestor` (signalled by `attestor_supplied`). `attestor_supplied` is proven
/// by the caller in the handler via `resolve_listing_attestor` (canonical roster PDA for
/// `listing_moderation.moderator` + `attestor == moderator`); a revoked attestor's PDA is
/// closed and cannot be supplied. Every other attestation check is unchanged, so a roster
/// attestor can only unlock a genuinely publishable, correctly-bound listing attestation.
pub(crate) fn validate_listing_moderation_for_hire(
    moderation_config: &ModerationConfig,
    listing_moderation: &ListingModeration,
    listing_key: Pubkey,
    listing_spec_hash: &[u8; 32],
    now: i64,
    attestor_supplied: bool,
) -> Result<()> {
    require!(
        moderation_config.moderation_authority != Pubkey::default(),
        CoordinationError::InvalidTaskModerationAuthority
    );
    require!(
        listing_moderation.moderator == moderation_config.moderation_authority || attestor_supplied,
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

/// WP-A1: resolve whether an optional `ModerationAttestor` roster entry authorizes a hire
/// whose listing attestation was authored by `moderator`.
///
/// The hire instructions cannot bind the optional attestor account to
/// `listing_moderation.moderator` with Anchor seeds (Anchor cannot seed one optional
/// account off another optional account's field), so the roster binding is enforced here:
///   1. `attestor_wallet == moderator` — the passed roster entry is the moderator's OWN
///      entry, which also proves the moderator is STILL on the roster at hire time (a
///      revoked attestor's PDA is closed and cannot be supplied, so its `Account`
///      deserialization would already have failed). Passing some *other* still-valid
///      attestor's entry can never satisfy this.
///   2. `attestor_pda == find_program_address(["moderation_attestor", moderator])` — pins
///      the canonical roster PDA (defense-in-depth; `assign_moderation_attestor` always
///      stores `attestor == seed`, so (1) already implies this).
///
/// Returns `Ok(Some(attestor_wallet))` for the roster path, `Ok(None)` for the
/// global-authority path (no attestor supplied). Pure + revert-sensitive.
pub(crate) fn resolve_listing_attestor(
    attestor_wallet: Option<Pubkey>,
    attestor_pda: Option<Pubkey>,
    moderator: Pubkey,
) -> Result<Option<Pubkey>> {
    match (attestor_wallet, attestor_pda) {
        (Some(wallet), Some(pda)) => {
            require!(
                wallet == moderator,
                CoordinationError::ModerationAttestorMismatch
            );
            let (expected, _bump) = Pubkey::find_program_address(
                &[b"moderation_attestor", moderator.as_ref()],
                &crate::ID,
            );
            require!(pda == expected, CoordinationError::ModerationAttestorMismatch);
            Ok(Some(wallet))
        }
        _ => Ok(None),
    }
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

    /// OPTIONAL (WP-A1): a registered moderation-attestor roster entry that unlocks the hire
    /// gate when `listing_moderation` was authored by a non-global-authority attestor.
    /// Anchor cannot seed this off the *optional* `listing_moderation.moderator`, so the
    /// canonical-PDA + moderator binding is enforced in the handler via
    /// `resolve_listing_attestor`. `Account<ModerationAttestor>` still guarantees the entry
    /// is program-owned and non-revoked (a revoked entry's PDA is closed and fails to load).
    /// Only needed for the roster path; the global-authority path passes with this absent
    /// (`None`), byte-unchanged.
    pub moderation_attestor: Option<Box<Account<'info, ModerationAttestor>>>,

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
    referrer: Option<Pubkey>,
    referrer_fee_bps: u16,
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
    //
    // WP-A1 roster-honored gate: the listing attestation may be authored by the global
    // moderation authority OR a registered, non-revoked ModerationAttestor. The optional
    // attestor account is bound to the STORED `lm.moderator` in the handler (Anchor cannot
    // seed it off an optional account) and only matters for the roster path.
    let mut unlocking_attestor: Option<Pubkey> = None;
    if ctx.accounts.moderation_config.enabled {
        let lm = ctx
            .accounts
            .listing_moderation
            .as_ref()
            .ok_or(CoordinationError::TaskModerationRequired)?;
        unlocking_attestor = resolve_listing_attestor(
            ctx.accounts.moderation_attestor.as_ref().map(|a| a.attestor),
            ctx.accounts.moderation_attestor.as_ref().map(|a| a.key()),
            lm.moderator,
        )?;
        validate_listing_moderation_for_hire(
            ctx.accounts.moderation_config.as_ref(),
            lm.as_ref(),
            listing_key,
            &listing_spec_hash,
            clock.unix_timestamp,
            unlocking_attestor.is_some(),
        )?;
    }

    // Resolve the absolute deadline from the listing's relative offset (or the
    // protocol default), then validate it like create_task does.
    let deadline = clock.unix_timestamp.saturating_add(hire_deadline_offset(
        listing_deadline_secs,
        config.max_claim_duration,
    ));
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
    let stamped_operator_fee_bps = if listing_operator != Pubkey::default() {
        require!(
            listing_operator != creator_key,
            CoordinationError::OperatorIsCreator
        );
        task.operator = listing_operator;
        task.operator_fee_bps = listing_operator_fee_bps;
        listing_operator_fee_bps
    } else {
        0
    };

    // P6.2 demand-side referral leg: the buyer supplies the embedder who brought them
    // (referrer + bps). Validated against the per-leg + combined caps and the
    // no-self-deal guard at creation, then snapshotted onto the Task (read by the
    // 4-way settlement split; HireRecord carries the fallback copy below).
    let (referrer_key, referrer_bps) = resolve_referrer_snapshot(
        referrer,
        referrer_fee_bps,
        protocol_fee_bps,
        stamped_operator_fee_bps,
        creator_key,
    )?;
    task.referrer = referrer_key;
    task.referrer_fee_bps = referrer_bps;
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
    hire_record.referrer = referrer_key;
    hire_record.referrer_fee_bps = referrer_bps;

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
        moderation_attestor: unlocking_attestor,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok_terms() -> (
        ListingState,
        u64,
        u64,
        u64,
        u64,
        Pubkey,
        Pubkey,
        Option<Pubkey>,
    ) {
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
        assert!(validate_hire_terms(s, p, v, ep, ev, b, pr, Some(Pubkey::new_unique())).is_err());
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
            assert!(validate_listing_moderation_for_hire(&c, &m, l, &h, 100, false).is_ok());
        }
    }

    // Revert-sensitive: each removes/violates exactly one require! in the gate.
    #[test]
    fn moderation_rejects_unpublishable_status() {
        for status in [1u8, 2u8, 3u8, 5u8] {
            let (c, m, l, h) = mod_case(status, 0);
            assert!(validate_listing_moderation_for_hire(&c, &m, l, &h, 100, false).is_err());
        }
    }

    #[test]
    fn moderation_rejects_hash_mismatch() {
        let (c, m, l, _h) = mod_case(0, 0);
        let mut other = [0u8; 32];
        other[0] = 9;
        assert!(validate_listing_moderation_for_hire(&c, &m, l, &other, 100, false).is_err());
    }

    #[test]
    fn moderation_rejects_listing_mismatch() {
        let (c, m, _l, h) = mod_case(0, 0);
        assert!(validate_listing_moderation_for_hire(
            &c,
            &m,
            Pubkey::new_unique(),
            &h,
            100,
            false
        )
        .is_err());
    }

    #[test]
    fn moderation_rejects_expired() {
        let (c, m, l, h) = mod_case(0, 99);
        assert!(validate_listing_moderation_for_hire(&c, &m, l, &h, 100, false).is_err());
        // unexpired (expires_at >= now) is fine
        let (c2, m2, l2, h2) = mod_case(0, 100);
        assert!(validate_listing_moderation_for_hire(&c2, &m2, l2, &h2, 100, false).is_ok());
    }

    #[test]
    fn moderation_rejects_wrong_moderator_and_zero_authority() {
        let (c, mut m, l, h) = mod_case(0, 0);
        m.moderator = Pubkey::new_unique(); // not the moderation authority
        assert!(validate_listing_moderation_for_hire(&c, &m, l, &h, 100, false).is_err());

        let (mut c2, m2, l2, h2) = mod_case(0, 0);
        c2.moderation_authority = Pubkey::default();
        assert!(validate_listing_moderation_for_hire(&c2, &m2, l2, &h2, 100, false).is_err());
    }

    // WP-A1 revert-sensitive: a registered roster attestor (moderator != global authority)
    // unlocks the hire gate. Against the pre-fix predicate (`moderator == authority`) this
    // errors, turning the test red.
    #[test]
    fn moderation_allows_registered_roster_attestor() {
        let (c, mut m, l, h) = mod_case(0, 0);
        m.moderator = Pubkey::new_unique(); // authored by a roster attestor, not the authority
        assert_ne!(m.moderator, c.moderation_authority);
        assert!(validate_listing_moderation_for_hire(&c, &m, l, &h, 100, true).is_ok());
    }

    // WP-A1 fail-closed guard: a non-authority moderator with NO roster entry supplied is
    // rejected (the gate never fails open).
    #[test]
    fn moderation_rejects_non_authority_without_attestor() {
        let (c, mut m, l, h) = mod_case(0, 0);
        m.moderator = Pubkey::new_unique();
        let err = validate_listing_moderation_for_hire(&c, &m, l, &h, 100, false).unwrap_err();
        assert_eq!(err, CoordinationError::UnauthorizedTaskModerator.into());
    }

    // WP-A1: a supplied roster entry does NOT bypass the other attestation invariants — a
    // blocked status still fails even for a roster attestor.
    #[test]
    fn roster_attestor_cannot_hire_blocked_listing() {
        let (c, mut m, l, h) = mod_case(2 /*BLOCKED*/, 0);
        m.moderator = Pubkey::new_unique();
        let err = validate_listing_moderation_for_hire(&c, &m, l, &h, 100, true).unwrap_err();
        assert_eq!(err, CoordinationError::TaskModerationRejected.into());
    }

    // WP-A1 roster binding (resolve_listing_attestor): the passed entry must be the
    // moderator's OWN canonical roster PDA.
    #[test]
    fn resolve_listing_attestor_accepts_canonical_entry() {
        let moderator = Pubkey::new_unique();
        let (pda, _bump) = Pubkey::find_program_address(
            &[b"moderation_attestor", moderator.as_ref()],
            &crate::ID,
        );
        // Roster entry for `moderator`, canonical PDA -> unlocks, returns the attestor wallet.
        assert_eq!(
            resolve_listing_attestor(Some(moderator), Some(pda), moderator).unwrap(),
            Some(moderator)
        );
        // No entry supplied -> global-authority path (None).
        assert_eq!(
            resolve_listing_attestor(None, None, moderator).unwrap(),
            None
        );
    }

    // WP-A1 security: passing SOME OTHER attestor's entry (wallet != moderator) is rejected,
    // so a revoked moderator cannot be substituted by an unrelated still-valid attestor.
    #[test]
    fn resolve_listing_attestor_rejects_foreign_entry() {
        let moderator = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        let (other_pda, _bump) =
            Pubkey::find_program_address(&[b"moderation_attestor", other.as_ref()], &crate::ID);
        let err = resolve_listing_attestor(Some(other), Some(other_pda), moderator).unwrap_err();
        assert_eq!(err, CoordinationError::ModerationAttestorMismatch.into());
    }

    // WP-A1 security: a wallet that matches the moderator but a non-canonical PDA (defense
    // in depth) is rejected.
    #[test]
    fn resolve_listing_attestor_rejects_non_canonical_pda() {
        let moderator = Pubkey::new_unique();
        let err = resolve_listing_attestor(Some(moderator), Some(Pubkey::new_unique()), moderator)
            .unwrap_err();
        assert_eq!(err, CoordinationError::ModerationAttestorMismatch.into());
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
