//! Marketplace V2 bid-book instructions.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use solana_sha256_hasher::hashv;

use crate::errors::CoordinationError;
use crate::events::{
    BidAccepted, BidBookInitialized, BidCancelled, BidCreated, BidExpired,
    BidMarketplaceInitialized, BidPromoted, BidUpdated, BidWinnerDemoted, TaskClaimed,
};
use crate::instructions::claim_task::has_required_assignment_stake;
use crate::instructions::completion_helpers::validate_task_dependency_for_assignment;
use crate::instructions::launch_controls::require_task_type_enabled;
use crate::instructions::migrate::is_valid_surface_revision;
use crate::instructions::moderation_gate_helpers::require_content_not_blocked;
use crate::state::{
    AgentRegistration, AgentStatus, BidBookState, BidMarketplaceConfig, BidderMarketState,
    MatchingPolicy, ProtocolConfig, Task, TaskBid, TaskBidBook, TaskBidState, TaskClaim,
    TaskJobSpec, TaskStatus, TaskType, WeightedScoreWeights,
};
use crate::utils::multisig::{require_multisig_threshold, unique_account_infos};
use crate::utils::version::{
    check_version_compatible, check_version_compatible_for_bootstrap,
    check_version_compatible_for_exit,
};

const BID_WINDOW_SECONDS: i64 = 86_400;
const COMPLETION_BUFFER: i64 = 3_600;
const MAX_CONFIDENCE_BPS: u16 = 10_000;
const MAX_ACTIVE_TASKS: u16 = 10;
const BID_TERMS_HASH_DOMAIN: &[u8] = b"agenc:bid-terms:v1";
const MAX_BID_BOND_LAMPORTS: u64 = 1_000_000_000;
const MAX_BID_CREATION_COOLDOWN_SECS: i64 = BID_WINDOW_SECONDS;
const MAX_BIDS_PER_24H: u16 = 1_000;
/// Pure spam/state bound on simultaneous live bids per book. Acceptance is
/// O(1) in accounts (the book tracks its policy winner incrementally), so this
/// cap has NO wire-size consequence and can be raised by config alone.
const MAX_ACTIVE_BIDS_PER_TASK: u16 = 20;
const MAX_BID_LIFETIME_SECS: i64 = 7 * BID_WINDOW_SECONDS;
/// After the tracked winner is removed (cancel/expiry/demotion), acceptance is
/// blocked until this grace elapses so every remaining bidder has a fair,
/// permissionless window to `promote_bid` before the creator can accept.
#[cfg(not(feature = "validation-timings"))]
const BID_REPROMOTION_GRACE_SECS: i64 = 300; // 5 minutes
#[cfg(feature = "validation-timings")]
const BID_REPROMOTION_GRACE_SECS: i64 = 5; // short grace for timing tests

fn validate_bid_marketplace_config_values(
    min_bid_bond_lamports: u64,
    bid_creation_cooldown_secs: i64,
    max_bids_per_24h: u16,
    max_active_bids_per_task: u16,
    max_bid_lifetime_secs: i64,
    accepted_no_show_slash_bps: u16,
) -> Result<()> {
    require!(
        (1..=MAX_BID_BOND_LAMPORTS).contains(&min_bid_bond_lamports)
            && (0..=MAX_BID_CREATION_COOLDOWN_SECS).contains(&bid_creation_cooldown_secs)
            && (1..=MAX_BIDS_PER_24H).contains(&max_bids_per_24h)
            && (1..=MAX_ACTIVE_BIDS_PER_TASK).contains(&max_active_bids_per_task)
            && (1..=MAX_BID_LIFETIME_SECS).contains(&max_bid_lifetime_secs)
            && accepted_no_show_slash_bps <= MAX_CONFIDENCE_BPS,
        CoordinationError::InvalidBidMarketplaceConfig
    );
    Ok(())
}

/// A fresh production deployment is deliberately paused and unstamped until
/// every release singleton exists and `stamp_release_surface` binds their exact
/// account images. `BidMarketplaceConfig` is itself one of those required
/// singletons, so its one-time multisig-gated initializer must be able to run
/// during that frozen bootstrap window.
///
/// Keep this check local to the initializer. It preserves every protocol-version
/// invariant and rejects unknown surface bytes, but deliberately does not waive
/// the pause gate for bid entry or later config updates.
fn check_bid_marketplace_bootstrap_compatible(config: &ProtocolConfig) -> Result<()> {
    check_version_compatible_for_bootstrap(config)?;
    require!(
        is_valid_surface_revision(config.surface_revision),
        CoordinationError::InvalidSurfaceRevision
    );
    Ok(())
}

/// Validate the bidder-signed TaskJobSpec snapshot against the creator-locked bid
/// contract. Bidders must never be able to set the irreversible lock themselves:
/// otherwise the first bidder can freeze a creator's pointer and cancel at only
/// refunded-bond cost. `initialize_bid_book` is the sole lock transition.
fn validate_bound_bid_job_spec(
    task_job_spec: &TaskJobSpec,
    expected_job_spec_hash: &[u8; 32],
    expected_job_spec_updated_at: i64,
) -> Result<()> {
    require!(
        task_job_spec.job_spec_hash.iter().any(|byte| *byte != 0)
            && !task_job_spec.job_spec_uri.trim().is_empty(),
        CoordinationError::TaskJobSpecRequired
    );
    require!(
        task_job_spec.is_bid_locked(),
        CoordinationError::BidJobSpecBindingRequired
    );
    require!(
        task_job_spec.job_spec_hash == *expected_job_spec_hash
            && task_job_spec.updated_at == expected_job_spec_updated_at,
        CoordinationError::BidJobSpecMismatch
    );
    Ok(())
}

/// Creator-authorized transition from an editable job pointer to the immutable
/// contract advertised by an initialized bid book.
fn lock_bid_book_job_spec(task_job_spec: &mut TaskJobSpec) -> Result<()> {
    require!(
        task_job_spec.job_spec_hash.iter().any(|byte| *byte != 0),
        CoordinationError::InvalidTaskJobSpecHash
    );
    require!(
        !task_job_spec.job_spec_uri.trim().is_empty(),
        CoordinationError::InvalidTaskJobSpecUri
    );
    task_job_spec.lock_for_bids();
    Ok(())
}

/// Canonical digest of every mutable/economic bid term plus the immutable job
/// contract. A creator signs this digest in `accept_bid`, making an update to the
/// selected bid fail closed without coupling acceptance to unrelated bid churn.
pub(crate) fn calculate_bid_terms_hash(
    task_key: &Pubkey,
    bid_key: &Pubkey,
    bid: &TaskBid,
    task_job_spec: &TaskJobSpec,
) -> [u8; 32] {
    let requested_reward = bid.requested_reward_lamports.to_le_bytes();
    let eta = bid.eta_seconds.to_le_bytes();
    let confidence = bid.confidence_bps.to_le_bytes();
    let reputation = bid.reputation_snapshot_bps.to_le_bytes();
    let expires_at = bid.expires_at.to_le_bytes();
    let created_at = bid.created_at.to_le_bytes();
    let updated_at = bid.updated_at.to_le_bytes();
    let bond_lamports = bid.bond_lamports.to_le_bytes();
    let accepted_no_show_slash_bps = bid.accepted_no_show_slash_bps.to_le_bytes();
    let job_spec_updated_at = task_job_spec.updated_at.to_le_bytes();

    hashv(&[
        BID_TERMS_HASH_DOMAIN,
        task_key.as_ref(),
        bid_key.as_ref(),
        bid.task.as_ref(),
        bid.bid_book.as_ref(),
        bid.bidder.as_ref(),
        bid.bidder_authority.as_ref(),
        &requested_reward,
        &eta,
        &confidence,
        &reputation,
        &bid.quality_guarantee_hash,
        &bid.metadata_hash,
        &expires_at,
        &created_at,
        &updated_at,
        &bond_lamports,
        &accepted_no_show_slash_bps,
        &task_job_spec.job_spec_hash,
        &job_spec_updated_at,
    ])
    .to_bytes()
}

fn validate_bid_acceptance_snapshot(
    task_key: &Pubkey,
    bid_key: &Pubkey,
    bid: &TaskBid,
    task_job_spec: &TaskJobSpec,
    expected_bid_terms_hash: &[u8; 32],
) -> Result<()> {
    require!(
        task_job_spec.is_bid_locked() && bid.state == TaskBidState::BoundActive,
        CoordinationError::BidJobSpecBindingRequired
    );
    require!(
        calculate_bid_terms_hash(task_key, bid_key, bid, task_job_spec) == *expected_bid_terms_hash,
        CoordinationError::StaleBidAcceptance
    );
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct BidCandidate {
    key: Pubkey,
    requested_reward_lamports: u64,
    eta_seconds: u32,
    confidence_bps: u16,
    reputation_snapshot_bps: u16,
    weighted_score: u128,
}

fn validate_stored_matching_policy(bid_book: &TaskBidBook) -> Result<()> {
    match bid_book.policy {
        MatchingPolicy::BestPrice | MatchingPolicy::BestEta => require!(
            bid_book.weights == WeightedScoreWeights::default(),
            CoordinationError::InvalidWeightedScoreWeights
        ),
        MatchingPolicy::WeightedScore => {
            let total = bid_book
                .weights
                .price_weight_bps
                .checked_add(bid_book.weights.eta_weight_bps)
                .and_then(|value| value.checked_add(bid_book.weights.confidence_weight_bps))
                .and_then(|value| value.checked_add(bid_book.weights.reliability_weight_bps))
                .ok_or(CoordinationError::ArithmeticOverflow)?;
            require!(
                total == MAX_CONFIDENCE_BPS,
                CoordinationError::InvalidWeightedScoreWeights
            );
        }
    }
    Ok(())
}

/// Deterministic score of one set of bid terms against a task budget and the
/// book's FROZEN eta-normalization window. Pure function of its arguments —
/// the same routine scores live bid accounts and the book's cached winner
/// components, so the two can never disagree. Returns `None` when the eta
/// does not fit the frozen window (such terms are never installable).
fn weighted_terms_score(
    requested_reward_lamports: u64,
    eta_seconds: u32,
    confidence_bps: u16,
    reputation_snapshot_bps: u16,
    task_budget: u64,
    window_secs: u32,
    weights: &WeightedScoreWeights,
) -> Result<Option<u128>> {
    require!(
        task_budget > 0 && window_secs > 0,
        CoordinationError::BidBookScoreWindowInvalid
    );
    let budget = u128::from(task_budget);
    let window = u128::from(window_secs);
    let price_score = u128::from(
        task_budget
            .checked_sub(requested_reward_lamports)
            .ok_or(CoordinationError::ArithmeticOverflow)?,
    )
    .checked_mul(u128::from(MAX_CONFIDENCE_BPS))
    .and_then(|value| value.checked_div(budget))
    .ok_or(CoordinationError::ArithmeticOverflow)?;
    let Some(eta_headroom) = window.checked_sub(u128::from(eta_seconds)) else {
        return Ok(None);
    };
    let eta_score = eta_headroom
        .checked_mul(u128::from(MAX_CONFIDENCE_BPS))
        .and_then(|value| value.checked_div(window))
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let weighted_score = price_score
        .checked_mul(u128::from(weights.price_weight_bps))
        .and_then(|value| {
            value.checked_add(eta_score.checked_mul(u128::from(weights.eta_weight_bps))?)
        })
        .and_then(|value| {
            value.checked_add(
                u128::from(confidence_bps)
                    .checked_mul(u128::from(weights.confidence_weight_bps))?,
            )
        })
        .and_then(|value| {
            value.checked_add(
                u128::from(reputation_snapshot_bps)
                    .checked_mul(u128::from(weights.reliability_weight_bps))?,
            )
        })
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    Ok(Some(weighted_score))
}

fn bid_candidate(
    key: Pubkey,
    bid: &TaskBid,
    task: &Task,
    now: i64,
    window_secs: u32,
    weights: &WeightedScoreWeights,
) -> Result<Option<BidCandidate>> {
    require!(
        bid.requested_reward_lamports > 0 && bid.requested_reward_lamports <= task.reward_amount,
        CoordinationError::InvalidReward
    );
    require!(bid.eta_seconds > 0, CoordinationError::InvalidBidEta);
    require!(
        bid.confidence_bps <= MAX_CONFIDENCE_BPS
            && bid.reputation_snapshot_bps <= MAX_CONFIDENCE_BPS,
        CoordinationError::InvalidBidConfidence
    );
    require!(
        bid.created_at > 0
            && bid.updated_at >= bid.created_at
            && bid.expires_at > bid.created_at
            && bid.bond_lamports > 0
            && bid.accepted_no_show_slash_bps <= MAX_CONFIDENCE_BPS,
        CoordinationError::InvalidInput
    );

    let completion_at = now
        .checked_add(i64::from(bid.eta_seconds))
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    if bid.state != TaskBidState::BoundActive
        || now >= bid.expires_at
        || task.deadline <= now
        || completion_at > task.deadline
    {
        return Ok(None);
    }

    let Some(weighted_score) = weighted_terms_score(
        bid.requested_reward_lamports,
        bid.eta_seconds,
        bid.confidence_bps,
        bid.reputation_snapshot_bps,
        task.reward_amount,
        window_secs,
        weights,
    )?
    else {
        return Ok(None);
    };

    Ok(Some(BidCandidate {
        key,
        requested_reward_lamports: bid.requested_reward_lamports,
        eta_seconds: bid.eta_seconds,
        confidence_bps: bid.confidence_bps,
        reputation_snapshot_bps: bid.reputation_snapshot_bps,
        weighted_score,
    }))
}

/// Rebuild the tracked winner's `BidCandidate` from the book's cached score
/// components. `None` when the book tracks no winner. The cached components
/// were validated when installed, so a scoring failure here is cache
/// corruption and fails closed.
fn cached_best_candidate(book: &TaskBidBook, task: &Task) -> Result<Option<BidCandidate>> {
    if book.best_bid == Pubkey::default() {
        return Ok(None);
    }
    let weighted_score = weighted_terms_score(
        book.best_reward_lamports,
        book.best_eta_seconds,
        book.best_confidence_bps,
        book.best_reputation_bps,
        task.reward_amount,
        book.score_window_secs,
        &book.weights,
    )?
    .ok_or(CoordinationError::BidBookCacheMismatch)?;
    Ok(Some(BidCandidate {
        key: book.best_bid,
        requested_reward_lamports: book.best_reward_lamports,
        eta_seconds: book.best_eta_seconds,
        confidence_bps: book.best_confidence_bps,
        reputation_snapshot_bps: book.best_reputation_bps,
        weighted_score,
    }))
}

fn install_best(book: &mut TaskBidBook, candidate: &BidCandidate) {
    book.best_bid = candidate.key;
    book.best_reward_lamports = candidate.requested_reward_lamports;
    book.best_eta_seconds = candidate.eta_seconds;
    book.best_confidence_bps = candidate.confidence_bps;
    book.best_reputation_bps = candidate.reputation_snapshot_bps;
}

/// Remove the tracked winner and open the re-promotion grace window.
fn clear_best(book: &mut TaskBidBook, now: i64) {
    book.best_bid = Pubkey::default();
    book.best_reward_lamports = 0;
    book.best_eta_seconds = 0;
    book.best_confidence_bps = 0;
    book.best_reputation_bps = 0;
    book.winner_stale_since = now;
}

/// Install `candidate` as the tracked winner when the book has none or the
/// candidate strictly beats the cached incumbent under the book's policy.
/// Returns whether the candidate was installed.
fn maybe_install_better(
    book: &mut TaskBidBook,
    task: &Task,
    candidate: &BidCandidate,
) -> Result<bool> {
    let installed = match cached_best_candidate(book, task)? {
        None => true,
        Some(incumbent) => candidate_is_better(candidate, &incumbent, book.policy),
    };
    if installed {
        install_best(book, candidate);
    }
    Ok(installed)
}

fn lower_price_tie_break(candidate: &BidCandidate, incumbent: &BidCandidate) -> bool {
    candidate.requested_reward_lamports < incumbent.requested_reward_lamports
        || (candidate.requested_reward_lamports == incumbent.requested_reward_lamports
            && (candidate.eta_seconds < incumbent.eta_seconds
                || (candidate.eta_seconds == incumbent.eta_seconds
                    && (candidate.confidence_bps > incumbent.confidence_bps
                        || (candidate.confidence_bps == incumbent.confidence_bps
                            && (candidate.reputation_snapshot_bps
                                > incumbent.reputation_snapshot_bps
                                || (candidate.reputation_snapshot_bps
                                    == incumbent.reputation_snapshot_bps
                                    && candidate.key < incumbent.key)))))))
}

fn lower_eta_tie_break(candidate: &BidCandidate, incumbent: &BidCandidate) -> bool {
    candidate.eta_seconds < incumbent.eta_seconds
        || (candidate.eta_seconds == incumbent.eta_seconds
            && (candidate.requested_reward_lamports < incumbent.requested_reward_lamports
                || (candidate.requested_reward_lamports == incumbent.requested_reward_lamports
                    && (candidate.confidence_bps > incumbent.confidence_bps
                        || (candidate.confidence_bps == incumbent.confidence_bps
                            && (candidate.reputation_snapshot_bps
                                > incumbent.reputation_snapshot_bps
                                || (candidate.reputation_snapshot_bps
                                    == incumbent.reputation_snapshot_bps
                                    && candidate.key < incumbent.key)))))))
}

fn candidate_is_better(
    candidate: &BidCandidate,
    incumbent: &BidCandidate,
    policy: MatchingPolicy,
) -> bool {
    match policy {
        MatchingPolicy::BestPrice => lower_price_tie_break(candidate, incumbent),
        MatchingPolicy::BestEta => lower_eta_tie_break(candidate, incumbent),
        MatchingPolicy::WeightedScore => {
            candidate.weighted_score > incumbent.weighted_score
                || (candidate.weighted_score == incumbent.weighted_score
                    && lower_price_tie_break(candidate, incumbent))
        }
    }
}

fn bidder_is_currently_eligible(
    bidder_key: &Pubkey,
    bidder: &AgentRegistration,
    bid: &TaskBid,
    task: &Task,
    min_agent_stake: u64,
) -> bool {
    *bidder_key == bid.bidder
        && bidder.authority == bid.bidder_authority
        && bidder.authority != task.creator
        && bidder.status == AgentStatus::Active
        && (bidder.capabilities & task.required_capabilities) == task.required_capabilities
        && (task.min_reputation == 0 || bidder.reputation >= task.min_reputation)
        && has_required_assignment_stake(bidder.stake, min_agent_stake)
        && bidder.active_tasks < MAX_ACTIVE_TASKS
}

/// O(1) policy enforcement: the selected bid must be the book's incrementally
/// tracked winner, its live account fields must match the cached score
/// components exactly (any drift fails closed), and — when a previous winner
/// was removed — the permissionless re-promotion grace must have elapsed so
/// every remaining bidder had a fair window to `promote_bid` first.
fn validate_cached_winner_selection(
    task: &Task,
    bid_book: &TaskBidBook,
    bid_key: &Pubkey,
    selected_bid: &TaskBid,
    now: i64,
) -> Result<()> {
    validate_stored_matching_policy(bid_book)?;
    require!(
        bid_book.best_bid != Pubkey::default() && bid_book.best_bid == *bid_key,
        CoordinationError::BidNotBookBest
    );
    require!(
        bid_book.best_reward_lamports == selected_bid.requested_reward_lamports
            && bid_book.best_eta_seconds == selected_bid.eta_seconds
            && bid_book.best_confidence_bps == selected_bid.confidence_bps
            && bid_book.best_reputation_bps == selected_bid.reputation_snapshot_bps,
        CoordinationError::BidBookCacheMismatch
    );
    if bid_book.winner_stale_since > 0 {
        let grace_over = bid_book
            .winner_stale_since
            .checked_add(BID_REPROMOTION_GRACE_SECS)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        require!(
            now >= grace_over,
            CoordinationError::BidRepromotionGraceActive
        );
    }
    // The selected bid must still be a valid candidate under the frozen
    // window at acceptance time (live state, not expired, deadline-feasible).
    let candidate = bid_candidate(
        *bid_key,
        selected_bid,
        task,
        now,
        bid_book.score_window_secs,
        &bid_book.weights,
    )?;
    require!(
        candidate.is_some(),
        CoordinationError::BidDoesNotSatisfyMatchingPolicy
    );
    Ok(())
}

/// Assignment-time content gate for accepted bids. Publication-time moderation
/// is not sufficient: a multisig takedown may be recorded after bidders priced
/// the work. The canonical content-hash block must therefore be rechecked in the
/// same transaction that creates the worker obligation.
fn validate_bid_job_spec_for_acceptance(
    task_job_spec: &TaskJobSpec,
    moderation_block: &AccountInfo,
) -> Result<()> {
    require!(
        task_job_spec.job_spec_hash.iter().any(|byte| *byte != 0),
        CoordinationError::InvalidTaskJobSpecHash
    );
    require!(
        !task_job_spec.job_spec_uri.trim().is_empty(),
        CoordinationError::InvalidTaskJobSpecUri
    );
    require_content_not_blocked(moderation_block, &task_job_spec.job_spec_hash)
}

fn require_bid_task(task: &Task) -> Result<()> {
    require!(
        task.task_type == TaskType::BidExclusive,
        CoordinationError::TaskNotBidExclusive
    );
    require!(
        task.max_workers == 1,
        CoordinationError::BidExclusiveRequiresSingleWorker
    );
    require!(
        task.reward_mint.is_none(),
        CoordinationError::BidTaskSolOnly
    );
    Ok(())
}

/// Reject self-dealing on the bid path (fix #831, parity with `claim_task`).
///
/// A task's creator must not also be the worker. Without this, one wallet
/// creates a BidExclusive task, registers a second agent, self-bids, self-accepts
/// (the creator signs `accept_bid`), and self-completes, farming +100 reputation
/// per cycle with the bond refunded in full. `claim_task` enforces this for the
/// FCFS path; the bid book is the only other way to become a worker.
///
/// IMPORTANT: in `accept_bid` only the creator signs and the bidder
/// `AgentRegistration` carries no `has_one = authority`, so callers MUST pass the
/// STORED `bid.bidder_authority` (set at `create_bid`), never a freshly-supplied
/// bidder account's `authority`. In `create_bid` the bidder authority IS the
/// signer, so its `authority.key()` is authoritative there.
fn ensure_not_self_bid(bidder_authority: Pubkey, task_creator: Pubkey) -> Result<()> {
    require!(
        bidder_authority != task_creator,
        CoordinationError::SelfTaskNotAllowed
    );
    Ok(())
}

fn parse_matching_policy(
    policy: u8,
    price_weight_bps: u16,
    eta_weight_bps: u16,
    confidence_weight_bps: u16,
    reliability_weight_bps: u16,
) -> Result<(MatchingPolicy, WeightedScoreWeights)> {
    let policy = match policy {
        0 => MatchingPolicy::BestPrice,
        1 => MatchingPolicy::BestEta,
        2 => MatchingPolicy::WeightedScore,
        _ => return Err(CoordinationError::InvalidMatchingPolicy.into()),
    };

    let weights = if policy == MatchingPolicy::WeightedScore {
        let total = price_weight_bps
            .checked_add(eta_weight_bps)
            .and_then(|v| v.checked_add(confidence_weight_bps))
            .and_then(|v| v.checked_add(reliability_weight_bps))
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        require!(
            total == MAX_CONFIDENCE_BPS,
            CoordinationError::InvalidWeightedScoreWeights
        );
        WeightedScoreWeights {
            price_weight_bps,
            eta_weight_bps,
            confidence_weight_bps,
            reliability_weight_bps,
        }
    } else {
        WeightedScoreWeights::default()
    };

    Ok((policy, weights))
}

fn refresh_bid_window(state: &mut BidderMarketState, now: i64) {
    if state.bid_window_started_at == 0
        || now.saturating_sub(state.bid_window_started_at) >= BID_WINDOW_SECONDS
    {
        state.bid_window_started_at = now;
        state.bids_created_in_window = 0;
    }
}

#[derive(Accounts)]
pub struct InitializeBidMarketplace<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump,
        constraint = protocol_config.key() != bid_marketplace.key() @ CoordinationError::InvalidInput
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        init,
        payer = authority,
        space = BidMarketplaceConfig::SIZE,
        seeds = [b"bid_marketplace"],
        bump
    )]
    pub bid_marketplace: Account<'info, BidMarketplaceConfig>,

    #[account(
        mut,
        constraint = authority.key() != protocol_config.key() @ CoordinationError::InvalidInput,
        constraint = authority.key() != bid_marketplace.key() @ CoordinationError::InvalidInput
    )]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn initialize_bid_marketplace_handler(
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
    require!(
        ctx.accounts.bid_marketplace.authority == Pubkey::default()
            && ctx.accounts.bid_marketplace.bump == 0,
        CoordinationError::InvalidInput
    );
    require_keys_neq!(
        ctx.accounts.protocol_config.key(),
        ctx.accounts.bid_marketplace.key(),
        CoordinationError::InvalidInput
    );
    check_bid_marketplace_bootstrap_compatible(&ctx.accounts.protocol_config)?;
    let unique_signers = unique_account_infos(ctx.remaining_accounts);
    require_multisig_threshold(&ctx.accounts.protocol_config, &unique_signers)?;
    validate_bid_marketplace_config_values(
        min_bid_bond_lamports,
        bid_creation_cooldown_secs,
        max_bids_per_24h,
        max_active_bids_per_task,
        max_bid_lifetime_secs,
        accepted_no_show_slash_bps,
    )?;

    let config = &mut ctx.accounts.bid_marketplace;
    config.authority = ctx.accounts.protocol_config.authority;
    config.min_bid_bond_lamports = min_bid_bond_lamports;
    config.bid_creation_cooldown_secs = bid_creation_cooldown_secs;
    config.max_bids_per_24h = max_bids_per_24h;
    config.max_active_bids_per_task = max_active_bids_per_task;
    config.max_bid_lifetime_secs = max_bid_lifetime_secs;
    config.accepted_no_show_slash_bps = accepted_no_show_slash_bps;
    config.bump = ctx.bumps.bid_marketplace;

    emit!(BidMarketplaceInitialized {
        authority: config.authority,
        min_bid_bond_lamports,
        bid_creation_cooldown_secs,
        max_bids_per_24h,
        max_active_bids_per_task,
        max_bid_lifetime_secs,
        accepted_no_show_slash_bps,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateBidMarketplaceConfig<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump,
        constraint = protocol_config.key() != bid_marketplace.key() @ CoordinationError::InvalidInput
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [b"bid_marketplace"],
        bump = bid_marketplace.bump
    )]
    pub bid_marketplace: Account<'info, BidMarketplaceConfig>,

    #[account(
        constraint = authority.key() != protocol_config.key() @ CoordinationError::InvalidInput,
        constraint = authority.key() != bid_marketplace.key() @ CoordinationError::InvalidInput
    )]
    pub authority: Signer<'info>,
}

#[allow(clippy::too_many_arguments)]
pub fn update_bid_marketplace_config_handler(
    ctx: Context<UpdateBidMarketplaceConfig>,
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
    require_keys_neq!(
        ctx.accounts.protocol_config.key(),
        ctx.accounts.bid_marketplace.key(),
        CoordinationError::InvalidInput
    );
    check_version_compatible(&ctx.accounts.protocol_config)?;
    let unique_signers = unique_account_infos(ctx.remaining_accounts);
    require_multisig_threshold(&ctx.accounts.protocol_config, &unique_signers)?;
    validate_bid_marketplace_config_values(
        min_bid_bond_lamports,
        bid_creation_cooldown_secs,
        max_bids_per_24h,
        max_active_bids_per_task,
        max_bid_lifetime_secs,
        accepted_no_show_slash_bps,
    )?;

    let config = &mut ctx.accounts.bid_marketplace;
    config.authority = ctx.accounts.protocol_config.authority;
    config.min_bid_bond_lamports = min_bid_bond_lamports;
    config.bid_creation_cooldown_secs = bid_creation_cooldown_secs;
    config.max_bids_per_24h = max_bids_per_24h;
    config.max_active_bids_per_task = max_active_bids_per_task;
    config.max_bid_lifetime_secs = max_bid_lifetime_secs;
    config.accepted_no_show_slash_bps = accepted_no_show_slash_bps;

    Ok(())
}

#[derive(Accounts)]
pub struct InitializeBidBook<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        constraint = task.creator == creator.key() @ CoordinationError::UnauthorizedTaskAction
    )]
    pub task: Box<Account<'info, Task>>,

    /// Exact job contract the creator irrevocably freezes when opening bidding.
    /// This explicit creator-signed transition prevents a bidder from grief-locking
    /// an otherwise editable TaskJobSpec.
    #[account(
        mut,
        seeds = [b"task_job_spec", task.key().as_ref()],
        bump = task_job_spec.bump,
        constraint = task_job_spec.task == task.key() @ CoordinationError::TaskJobSpecTaskMismatch,
        constraint = task_job_spec.creator == task.creator @ CoordinationError::UnauthorizedTaskAction
    )]
    pub task_job_spec: Box<Account<'info, TaskJobSpec>>,

    #[account(
        init,
        payer = creator,
        space = TaskBidBook::SIZE,
        seeds = [b"bid_book", task.key().as_ref()],
        bump
    )]
    pub bid_book: Box<Account<'info, TaskBidBook>>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn initialize_bid_book_handler(
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
    require!(
        ctx.accounts.bid_book.task == Pubkey::default()
            && ctx.accounts.bid_book.total_bids == 0
            && ctx.accounts.bid_book.active_bids == 0,
        CoordinationError::InvalidInput
    );
    check_version_compatible(&ctx.accounts.protocol_config)?;
    require_bid_task(&ctx.accounts.task)?;
    require_task_type_enabled(&ctx.accounts.protocol_config, ctx.accounts.task.task_type)?;
    require!(
        ctx.accounts.task.status == TaskStatus::Open,
        CoordinationError::TaskNotOpen
    );
    require!(
        ctx.accounts.task.current_workers == 0,
        CoordinationError::TaskFullyClaimed
    );
    lock_bid_book_job_spec(ctx.accounts.task_job_spec.as_mut())?;
    let (policy, weights) = parse_matching_policy(
        policy,
        price_weight_bps,
        eta_weight_bps,
        confidence_weight_bps,
        reliability_weight_bps,
    )?;
    let now = Clock::get()?.unix_timestamp;
    // Freeze the WeightedScore eta-normalization window at book creation so
    // every policy ordering is a pure function of immutable bid fields — the
    // winner cannot depend on when the creator later calls accept.
    let score_window_secs = ctx
        .accounts
        .task
        .deadline
        .checked_sub(now)
        .filter(|window| *window > 0)
        .and_then(|window| u32::try_from(window).ok())
        .ok_or(CoordinationError::BidBookScoreWindowInvalid)?;

    let bid_book = &mut ctx.accounts.bid_book;
    bid_book.task = ctx.accounts.task.key();
    bid_book.state = BidBookState::Open;
    bid_book.policy = policy;
    bid_book.weights = weights;
    bid_book.accepted_bid = None;
    bid_book.version = 0;
    bid_book.total_bids = 0;
    bid_book.active_bids = 0;
    bid_book.created_at = now;
    bid_book.updated_at = now;
    bid_book.bump = ctx.bumps.bid_book;
    bid_book.best_bid = Pubkey::default();
    bid_book.best_reward_lamports = 0;
    bid_book.best_eta_seconds = 0;
    bid_book.best_confidence_bps = 0;
    bid_book.best_reputation_bps = 0;
    bid_book.winner_stale_since = 0;
    bid_book.score_window_secs = score_window_secs;

    emit!(BidBookInitialized {
        task: ctx.accounts.task.key(),
        bid_book: bid_book.key(),
        state: bid_book.state as u8,
        policy: bid_book.policy as u8,
        book_version: bid_book.version,
        timestamp: now,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct CreateBid<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        seeds = [b"bid_marketplace"],
        bump = bid_marketplace.bump
    )]
    pub bid_marketplace: Box<Account<'info, BidMarketplaceConfig>>,

    #[account(
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Box<Account<'info, Task>>,

    /// The exact creator-locked content-addressed job contract the bidder signs.
    #[account(
        seeds = [b"task_job_spec", task.key().as_ref()],
        bump = task_job_spec.bump,
        constraint = task_job_spec.task == task.key() @ CoordinationError::TaskJobSpecTaskMismatch,
        constraint = task_job_spec.creator == task.creator @ CoordinationError::UnauthorizedTaskAction
    )]
    pub task_job_spec: Box<Account<'info, TaskJobSpec>>,

    #[account(
        mut,
        seeds = [b"bid_book", task.key().as_ref()],
        bump = bid_book.bump,
        constraint = bid_book.task == task.key() @ CoordinationError::InvalidInput
    )]
    pub bid_book: Box<Account<'info, TaskBidBook>>,

    #[account(
        init,
        payer = authority,
        space = TaskBid::SIZE,
        seeds = [b"bid", task.key().as_ref(), bidder.key().as_ref()],
        bump
    )]
    pub bid: Box<Account<'info, TaskBid>>,

    #[account(
        init_if_needed,
        payer = authority,
        space = BidderMarketState::SIZE,
        seeds = [b"bidder_market", bidder.key().as_ref()],
        bump
    )]
    pub bidder_market_state: Box<Account<'info, BidderMarketState>>,

    #[account(
        mut,
        seeds = [b"agent", bidder.agent_id.as_ref()],
        bump = bidder.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub bidder: Box<Account<'info, AgentRegistration>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn create_bid_handler(
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
    require!(
        ctx.accounts.bid.task == Pubkey::default()
            && ctx.accounts.bid.bidder == Pubkey::default()
            && ctx.accounts.bid.bond_lamports == 0,
        CoordinationError::InvalidInput
    );
    check_version_compatible(&ctx.accounts.protocol_config)?;
    validate_bid_marketplace_config_values(
        ctx.accounts.bid_marketplace.min_bid_bond_lamports,
        ctx.accounts.bid_marketplace.bid_creation_cooldown_secs,
        ctx.accounts.bid_marketplace.max_bids_per_24h,
        ctx.accounts.bid_marketplace.max_active_bids_per_task,
        ctx.accounts.bid_marketplace.max_bid_lifetime_secs,
        ctx.accounts.bid_marketplace.accepted_no_show_slash_bps,
    )?;
    require_bid_task(&ctx.accounts.task)?;
    require_task_type_enabled(&ctx.accounts.protocol_config, ctx.accounts.task.task_type)?;
    // create_bid: the bidder authority is the signer (has_one = authority).
    ensure_not_self_bid(ctx.accounts.authority.key(), ctx.accounts.task.creator)?;
    require!(
        ctx.accounts.task.status == TaskStatus::Open,
        CoordinationError::TaskNotOpen
    );
    require!(
        ctx.accounts.bid_book.state == BidBookState::Open,
        CoordinationError::BidBookNotOpen
    );
    require!(
        ctx.accounts.bidder.status == AgentStatus::Active,
        CoordinationError::AgentNotActive
    );
    require!(
        has_required_assignment_stake(
            ctx.accounts.bidder.stake,
            ctx.accounts.protocol_config.min_agent_stake,
        ),
        CoordinationError::InsufficientStake
    );
    require!(
        (ctx.accounts.bidder.capabilities & ctx.accounts.task.required_capabilities)
            == ctx.accounts.task.required_capabilities,
        CoordinationError::InsufficientCapabilities
    );
    if ctx.accounts.task.min_reputation > 0 {
        require!(
            ctx.accounts.bidder.reputation >= ctx.accounts.task.min_reputation,
            CoordinationError::InsufficientReputation
        );
    }
    require!(
        requested_reward_lamports > 0,
        CoordinationError::InvalidReward
    );
    require!(
        requested_reward_lamports <= ctx.accounts.task.reward_amount,
        CoordinationError::BidPriceExceedsTaskBudget
    );
    require!(eta_seconds > 0, CoordinationError::InvalidBidEta);
    require!(
        confidence_bps <= MAX_CONFIDENCE_BPS,
        CoordinationError::InvalidBidConfidence
    );

    let now = Clock::get()?.unix_timestamp;
    let promised_completion_at = now
        .checked_add(i64::from(eta_seconds))
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    require!(
        ctx.accounts.task.deadline > now && promised_completion_at <= ctx.accounts.task.deadline,
        CoordinationError::InvalidBidEta
    );
    require!(expires_at > now, CoordinationError::InvalidBidExpiry);
    if ctx.accounts.task.deadline > 0 {
        require!(
            expires_at <= ctx.accounts.task.deadline,
            CoordinationError::InvalidBidExpiry
        );
    }
    require!(
        expires_at.saturating_sub(now) <= ctx.accounts.bid_marketplace.max_bid_lifetime_secs,
        CoordinationError::InvalidBidExpiry
    );
    require!(
        ctx.accounts.bid_book.active_bids < ctx.accounts.bid_marketplace.max_active_bids_per_task
            && ctx.accounts.bid_book.active_bids < MAX_ACTIVE_BIDS_PER_TASK,
        CoordinationError::BidBookCapacityReached
    );

    // The bidder signs the exact content/version the creator already froze when
    // initializing the book. This check has no mutation authority.
    validate_bound_bid_job_spec(
        ctx.accounts.task_job_spec.as_ref(),
        &expected_job_spec_hash,
        expected_job_spec_updated_at,
    )?;

    let bidder_state = &mut ctx.accounts.bidder_market_state;
    if bidder_state.bidder == Pubkey::default() {
        bidder_state.bidder = ctx.accounts.bidder.key();
        bidder_state.bump = ctx.bumps.bidder_market_state;
    }
    refresh_bid_window(bidder_state, now);
    if bidder_state.last_bid_created_at > 0 {
        require!(
            now.saturating_sub(bidder_state.last_bid_created_at)
                >= ctx.accounts.bid_marketplace.bid_creation_cooldown_secs,
            CoordinationError::CooldownNotElapsed
        );
    }
    require!(
        bidder_state.bids_created_in_window < ctx.accounts.bid_marketplace.max_bids_per_24h,
        CoordinationError::RateLimitExceeded
    );

    let task_key = ctx.accounts.task.key();
    let bid_key = ctx.accounts.bid.key();
    let bidder_key = ctx.accounts.bidder.key();
    let bid_book_key = ctx.accounts.bid_book.key();
    let bid_account_info = ctx.accounts.bid.to_account_info();
    let bond_lamports = ctx.accounts.bid_marketplace.min_bid_bond_lamports;

    let bid = &mut ctx.accounts.bid;
    bid.task = task_key;
    bid.bid_book = bid_book_key;
    bid.bidder = bidder_key;
    bid.bidder_authority = ctx.accounts.authority.key();
    bid.requested_reward_lamports = requested_reward_lamports;
    bid.eta_seconds = eta_seconds;
    bid.confidence_bps = confidence_bps;
    bid.reputation_snapshot_bps = ctx.accounts.bidder.reputation;
    bid.quality_guarantee_hash = quality_guarantee_hash;
    bid.metadata_hash = metadata_hash;
    bid.expires_at = expires_at;
    bid.created_at = now;
    bid.updated_at = now;
    bid.state = TaskBidState::BoundActive;
    bid.bond_lamports = bond_lamports;
    bid.bump = ctx.bumps.bid;
    // Contract policy is snapshotted when the bidder funds the obligation.
    // A later marketplace-config update must not retroactively change the
    // penalty attached to an already-created bid.
    bid.accepted_no_show_slash_bps = ctx.accounts.bid_marketplace.accepted_no_show_slash_bps;

    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.authority.to_account_info(),
                to: bid_account_info,
            },
        ),
        bid.bond_lamports,
    )?;

    bidder_state.last_bid_created_at = now;
    bidder_state.bids_created_in_window = bidder_state
        .bids_created_in_window
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bidder_state.active_bid_count = bidder_state
        .active_bid_count
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bidder_state.total_bids_created = bidder_state
        .total_bids_created
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    let bid_book = &mut ctx.accounts.bid_book;
    bid_book.version = bid_book
        .version
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bid_book.total_bids = bid_book
        .total_bids
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bid_book.active_bids = bid_book
        .active_bids
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bid_book.updated_at = now;

    // Incremental winner tracking (O(1) accept): a freshly funded bid takes
    // the tracked-winner slot when the book tracks none or it beats the
    // cached incumbent under the declared policy.
    let window_secs = ctx.accounts.bid_book.score_window_secs;
    let weights = ctx.accounts.bid_book.weights;
    let candidate = bid_candidate(
        bid_key,
        ctx.accounts.bid.as_ref(),
        ctx.accounts.task.as_ref(),
        now,
        window_secs,
        &weights,
    )?;
    if let Some(candidate) = candidate {
        let bid_book = &mut ctx.accounts.bid_book;
        if maybe_install_better(bid_book, ctx.accounts.task.as_ref(), &candidate)? {
            emit!(BidPromoted {
                task: task_key,
                bid: bid_key,
                bidder: bidder_key,
                bid_book: bid_book_key,
                book_version: ctx.accounts.bid_book.version,
                timestamp: now,
            });
        }
    }

    let bid_book = &mut ctx.accounts.bid_book;
    emit!(BidCreated {
        task: task_key,
        bid: bid_key,
        bidder: bidder_key,
        bid_book: bid_book_key,
        book_version: bid_book.version,
        requested_reward_lamports,
        eta_seconds,
        expires_at,
        timestamp: now,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateBid<'info> {
    #[account(
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Box<Account<'info, Task>>,

    /// Current exact creator-locked job contract. A legacy unbound bid becomes
    /// accept-safe only after its bidder refreshes it through this instruction.
    #[account(
        seeds = [b"task_job_spec", task.key().as_ref()],
        bump = task_job_spec.bump,
        constraint = task_job_spec.task == task.key() @ CoordinationError::TaskJobSpecTaskMismatch,
        constraint = task_job_spec.creator == task.creator @ CoordinationError::UnauthorizedTaskAction
    )]
    pub task_job_spec: Box<Account<'info, TaskJobSpec>>,

    #[account(
        mut,
        seeds = [b"bid_book", task.key().as_ref()],
        bump = bid_book.bump,
        constraint = bid_book.task == task.key() @ CoordinationError::InvalidInput
    )]
    pub bid_book: Box<Account<'info, TaskBidBook>>,

    #[account(
        mut,
        seeds = [b"bid", task.key().as_ref(), bidder.key().as_ref()],
        bump = bid.bump,
        constraint = bid.task == task.key() @ CoordinationError::InvalidInput,
        constraint = bid.bid_book == bid_book.key() @ CoordinationError::InvalidInput,
        constraint = bid.bidder == bidder.key() @ CoordinationError::InvalidInput
    )]
    pub bid: Box<Account<'info, TaskBid>>,

    #[account(
        mut,
        seeds = [b"agent", bidder.agent_id.as_ref()],
        bump = bidder.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub bidder: Box<Account<'info, AgentRegistration>>,

    pub authority: Signer<'info>,

    #[account(
        seeds = [b"bid_marketplace"],
        bump = bid_marketplace.bump
    )]
    pub bid_marketplace: Box<Account<'info, BidMarketplaceConfig>>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,
}

#[allow(clippy::too_many_arguments)]
pub fn update_bid_handler(
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
    check_version_compatible(&ctx.accounts.protocol_config)?;
    validate_bid_marketplace_config_values(
        ctx.accounts.bid_marketplace.min_bid_bond_lamports,
        ctx.accounts.bid_marketplace.bid_creation_cooldown_secs,
        ctx.accounts.bid_marketplace.max_bids_per_24h,
        ctx.accounts.bid_marketplace.max_active_bids_per_task,
        ctx.accounts.bid_marketplace.max_bid_lifetime_secs,
        ctx.accounts.bid_marketplace.accepted_no_show_slash_bps,
    )?;
    require_bid_task(&ctx.accounts.task)?;
    require_task_type_enabled(&ctx.accounts.protocol_config, ctx.accounts.task.task_type)?;
    require!(
        ctx.accounts.bid.state.is_open(),
        CoordinationError::BidNotActive
    );
    require!(
        ctx.accounts.bid_book.state == BidBookState::Open,
        CoordinationError::BidBookNotOpen
    );
    require!(
        ctx.accounts.task.status == TaskStatus::Open,
        CoordinationError::TaskNotOpen
    );
    require!(
        has_required_assignment_stake(
            ctx.accounts.bidder.stake,
            ctx.accounts.protocol_config.min_agent_stake,
        ),
        CoordinationError::InsufficientStake
    );
    require!(
        requested_reward_lamports > 0,
        CoordinationError::InvalidReward
    );
    require!(
        requested_reward_lamports <= ctx.accounts.task.reward_amount,
        CoordinationError::BidPriceExceedsTaskBudget
    );
    require!(eta_seconds > 0, CoordinationError::InvalidBidEta);
    require!(
        confidence_bps <= MAX_CONFIDENCE_BPS,
        CoordinationError::InvalidBidConfidence
    );
    let now = Clock::get()?.unix_timestamp;
    let promised_completion_at = now
        .checked_add(i64::from(eta_seconds))
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    require!(
        ctx.accounts.task.deadline > now && promised_completion_at <= ctx.accounts.task.deadline,
        CoordinationError::InvalidBidEta
    );
    require!(expires_at > now, CoordinationError::InvalidBidExpiry);
    if ctx.accounts.task.deadline > 0 {
        require!(
            expires_at <= ctx.accounts.task.deadline,
            CoordinationError::InvalidBidExpiry
        );
    }
    require!(
        expires_at.saturating_sub(now) <= ctx.accounts.bid_marketplace.max_bid_lifetime_secs,
        CoordinationError::InvalidBidExpiry
    );

    validate_bound_bid_job_spec(
        ctx.accounts.task_job_spec.as_ref(),
        &expected_job_spec_hash,
        expected_job_spec_updated_at,
    )?;

    let task_key = ctx.accounts.task.key();
    let bid_key = ctx.accounts.bid.key();
    let bidder_key = ctx.accounts.bidder.key();
    let bid_book_key = ctx.accounts.bid_book.key();

    // Snapshot the tracked-winner view BEFORE mutating: the leader-retreat
    // rule compares the new terms against the incumbent cache.
    let was_leader = ctx.accounts.bid_book.best_bid == bid_key;
    let incumbent = if was_leader {
        cached_best_candidate(ctx.accounts.bid_book.as_ref(), ctx.accounts.task.as_ref())?
    } else {
        None
    };

    let bid = ctx.accounts.bid.as_mut();
    bid.requested_reward_lamports = requested_reward_lamports;
    bid.eta_seconds = eta_seconds;
    bid.confidence_bps = confidence_bps;
    bid.reputation_snapshot_bps = ctx.accounts.bidder.reputation;
    bid.quality_guarantee_hash = quality_guarantee_hash;
    bid.metadata_hash = metadata_hash;
    bid.expires_at = expires_at;
    bid.updated_at = now;
    bid.state = TaskBidState::BoundActive;

    let bid_book = ctx.accounts.bid_book.as_mut();
    bid_book.version = bid_book
        .version
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bid_book.updated_at = now;

    // Incremental winner tracking. The tracked best may only update to
    // equal-or-better terms (it may sweeten, never retreat — retreating would
    // silently invalidate the cache against bids the book cannot see). A
    // leader that wants out cancels instead, which opens the re-promotion
    // grace window for everyone else.
    let window_secs = ctx.accounts.bid_book.score_window_secs;
    let weights = ctx.accounts.bid_book.weights;
    let candidate = bid_candidate(
        bid_key,
        ctx.accounts.bid.as_ref(),
        ctx.accounts.task.as_ref(),
        now,
        window_secs,
        &weights,
    )?;
    if was_leader {
        let incumbent = incumbent.ok_or(CoordinationError::BidBookCacheMismatch)?;
        let refreshed = candidate.ok_or(CoordinationError::BidLeaderRetreat)?;
        require!(
            !candidate_is_better(&incumbent, &refreshed, ctx.accounts.bid_book.policy),
            CoordinationError::BidLeaderRetreat
        );
        let bid_book = ctx.accounts.bid_book.as_mut();
        install_best(bid_book, &refreshed);
        emit!(BidPromoted {
            task: task_key,
            bid: bid_key,
            bidder: bidder_key,
            bid_book: bid_book_key,
            book_version: ctx.accounts.bid_book.version,
            timestamp: now,
        });
    } else if let Some(candidate) = candidate {
        let bid_book = ctx.accounts.bid_book.as_mut();
        if maybe_install_better(bid_book, ctx.accounts.task.as_ref(), &candidate)? {
            emit!(BidPromoted {
                task: task_key,
                bid: bid_key,
                bidder: bidder_key,
                bid_book: bid_book_key,
                book_version: ctx.accounts.bid_book.version,
                timestamp: now,
            });
        }
    }

    let bid_book = ctx.accounts.bid_book.as_mut();
    emit!(BidUpdated {
        task: task_key,
        bid: bid_key,
        bidder: bidder_key,
        bid_book: bid_book_key,
        book_version: bid_book.version,
        requested_reward_lamports,
        eta_seconds,
        expires_at,
        timestamp: now,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct CancelBid<'info> {
    #[account(
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        mut,
        seeds = [b"bid_book", task.key().as_ref()],
        bump = bid_book.bump,
        constraint = bid_book.task == task.key() @ CoordinationError::InvalidInput
    )]
    pub bid_book: Box<Account<'info, TaskBidBook>>,

    #[account(
        mut,
        close = authority,
        seeds = [b"bid", task.key().as_ref(), bidder.key().as_ref()],
        bump = bid.bump,
        constraint = bid.task == task.key() @ CoordinationError::InvalidInput,
        constraint = bid.bidder_authority == authority.key() @ CoordinationError::UnauthorizedAgent
    )]
    pub bid: Box<Account<'info, TaskBid>>,

    #[account(
        mut,
        seeds = [b"bidder_market", bidder.key().as_ref()],
        bump = bidder_market_state.bump,
        constraint = bidder_market_state.bidder == bidder.key() @ CoordinationError::InvalidInput
    )]
    pub bidder_market_state: Box<Account<'info, BidderMarketState>>,

    #[account(
        seeds = [b"agent", bidder.agent_id.as_ref()],
        bump = bidder.bump
    )]
    pub bidder: Box<Account<'info, AgentRegistration>>,

    #[account(mut)]
    pub authority: Signer<'info>,
}

pub fn cancel_bid_handler(ctx: Context<CancelBid>) -> Result<()> {
    require_bid_task(&ctx.accounts.task)?;
    require!(
        ctx.accounts.bid.state.is_open(),
        CoordinationError::BidNotActive
    );
    require!(
        matches!(
            ctx.accounts.bid_book.state,
            BidBookState::Open | BidBookState::Accepted
        ),
        CoordinationError::BidBookNotOpen
    );
    require!(
        ctx.accounts.bid_book.accepted_bid != Some(ctx.accounts.bid.key()),
        CoordinationError::BidAlreadyAccepted
    );

    let now = Clock::get()?.unix_timestamp;
    let task_key = ctx.accounts.task.key();
    let bid_key = ctx.accounts.bid.key();
    let bidder_key = ctx.accounts.bidder.key();
    let bid_book_key = ctx.accounts.bid_book.key();
    let bid_book = ctx.accounts.bid_book.as_mut();
    bid_book.active_bids = bid_book
        .active_bids
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bid_book.version = bid_book
        .version
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bid_book.updated_at = now;
    // A cancelling tracked winner opens the re-promotion grace window: the
    // book cannot know the runner-up, so acceptance is blocked until every
    // remaining bidder had a fair chance to promote.
    if bid_book.best_bid == bid_key {
        clear_best(bid_book, now);
        emit!(BidWinnerDemoted {
            task: task_key,
            bid: bid_key,
            bid_book: bid_book_key,
            book_version: bid_book.version,
            winner_stale_since: now,
            timestamp: now,
        });
    }

    let bidder_state = ctx.accounts.bidder_market_state.as_mut();
    bidder_state.active_bid_count = bidder_state
        .active_bid_count
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    emit!(BidCancelled {
        task: task_key,
        bid: bid_key,
        bidder: bidder_key,
        bid_book: bid_book_key,
        book_version: bid_book.version,
        timestamp: now,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct AcceptBid<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        constraint = task.creator == creator.key() @ CoordinationError::UnauthorizedTaskAction
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        init,
        payer = creator,
        space = TaskClaim::SIZE,
        seeds = [b"claim", task.key().as_ref(), bidder.key().as_ref()],
        bump
    )]
    pub claim: Box<Account<'info, TaskClaim>>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        mut,
        seeds = [b"bid_book", task.key().as_ref()],
        bump = bid_book.bump,
        constraint = bid_book.task == task.key() @ CoordinationError::InvalidInput
    )]
    pub bid_book: Box<Account<'info, TaskBidBook>>,

    #[account(
        mut,
        seeds = [b"bid", task.key().as_ref(), bidder.key().as_ref()],
        bump = bid.bump,
        constraint = bid.task == task.key() @ CoordinationError::InvalidInput,
        constraint = bid.bid_book == bid_book.key() @ CoordinationError::InvalidInput,
        constraint = bid.bidder == bidder.key() @ CoordinationError::InvalidInput
    )]
    pub bid: Box<Account<'info, TaskBid>>,

    #[account(
        mut,
        seeds = [b"bidder_market", bidder.key().as_ref()],
        bump = bidder_market_state.bump,
        constraint = bidder_market_state.bidder == bidder.key() @ CoordinationError::InvalidInput
    )]
    pub bidder_market_state: Box<Account<'info, BidderMarketState>>,

    #[account(
        mut,
        seeds = [b"agent", bidder.agent_id.as_ref()],
        bump = bidder.bump
    )]
    pub bidder: Box<Account<'info, AgentRegistration>>,

    /// Published, moderation-gated job spec for this task (PDA ["task_job_spec", task]).
    /// Required so a bid can only be accepted for work that passed moderation at
    /// publish time — `set_task_job_spec` is the only way this account can exist and
    /// it hard-requires a publishable `task_moderation`. This gates `accept_bid`
    /// before InProgress (spec §6) at parity with `claim_task_with_job_spec`, which
    /// makes the legacy no-job-spec assignment path unreachable.
    #[account(
        seeds = [b"task_job_spec", task.key().as_ref()],
        bump = task_job_spec.bump,
        constraint = task_job_spec.task == task.key() @ CoordinationError::TaskJobSpecTaskMismatch,
        constraint = task_job_spec.creator == task.creator @ CoordinationError::UnauthorizedTaskAction
    )]
    pub task_job_spec: Box<Account<'info, TaskJobSpec>>,

    /// Canonical content-hash BLOCK floor, rechecked at assignment time so a
    /// takedown recorded after the bid was created prevents acceptance.
    /// CHECK: handler derives and validates this PDA from task_job_spec.job_spec_hash.
    pub moderation_block: UncheckedAccount<'info>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn accept_bid_handler(
    ctx: Context<AcceptBid>,
    expected_bid_terms_hash: [u8; 32],
) -> Result<()> {
    require!(
        ctx.accounts.creator.is_signer,
        CoordinationError::UnauthorizedTaskAction
    );
    // Recheck both the pointer and the canonical BLOCK floor at assignment. This
    // closes the post-publication takedown gap without consuming a remaining
    // account, so Proof dependencies keep their parent in remaining_accounts[0].
    validate_bid_job_spec_for_acceptance(
        ctx.accounts.task_job_spec.as_ref(),
        &ctx.accounts.moderation_block.to_account_info(),
    )?;
    // A dependent task consumes exactly one prefix account for its parent.
    // Acceptance is O(1) in accounts: the book tracks its policy winner
    // incrementally, so NO competitor enumeration exists and any extra
    // remaining account is rejected outright.
    let dependency_account_count =
        usize::from(ctx.accounts.task.dependency_type != crate::state::DependencyType::None);
    require!(
        ctx.remaining_accounts.len() == dependency_account_count,
        CoordinationError::ParentTaskAccountRequired
    );
    let (dependency_accounts, _) = ctx.remaining_accounts.split_at(dependency_account_count);
    validate_task_dependency_for_assignment(
        ctx.accounts.task.as_ref(),
        dependency_accounts,
        ctx.program_id,
    )?;
    let task = &mut ctx.accounts.task;
    let bid = &mut ctx.accounts.bid;
    let bid_book = &mut ctx.accounts.bid_book;
    let bidder = &mut ctx.accounts.bidder;
    let bidder_state = &mut ctx.accounts.bidder_market_state;
    let claim = &mut ctx.accounts.claim;
    let config = &ctx.accounts.protocol_config;

    check_version_compatible(config)?;
    require_bid_task(task)?;
    require_task_type_enabled(config, task.task_type)?;
    // accept_bid: only the creator signs; the bidder account has no has_one,
    // so compare the STORED bidder authority recorded at create_bid.
    ensure_not_self_bid(bid.bidder_authority, task.creator)?;
    require!(
        task.status == TaskStatus::Open,
        CoordinationError::TaskNotOpen
    );
    require!(
        task.current_workers == 0,
        CoordinationError::TaskFullyClaimed
    );
    require!(
        bid_book.state == BidBookState::Open,
        CoordinationError::BidBookNotOpen
    );
    require!(bid.state.is_open(), CoordinationError::BidNotActive);

    // The creator commits only to the selected bid's exact terms. Changes to an
    // unrelated bid no longer invalidate acceptance unless that bid actually
    // becomes the deterministic policy winner.
    validate_bid_acceptance_snapshot(
        &task.key(),
        &bid.key(),
        bid,
        ctx.accounts.task_job_spec.as_ref(),
        &expected_bid_terms_hash,
    )?;

    let now = Clock::get()?.unix_timestamp;
    require!(now < bid.expires_at, CoordinationError::TaskExpired);
    require!(
        bid.to_account_info().lamports() >= bid.bond_lamports,
        CoordinationError::BidBookEnumerationMismatch
    );
    require!(
        bid.bidder == bidder.key() && bid.bidder_authority == bidder.authority,
        CoordinationError::BidBookEnumerationMismatch
    );
    require!(
        bidder.status == AgentStatus::Active,
        CoordinationError::AgentNotActive
    );
    require!(
        has_required_assignment_stake(bidder.stake, config.min_agent_stake),
        CoordinationError::InsufficientStake
    );
    require!(
        (bidder.capabilities & task.required_capabilities) == task.required_capabilities,
        CoordinationError::InsufficientCapabilities
    );
    if task.min_reputation > 0 {
        require!(
            bidder.reputation >= task.min_reputation,
            CoordinationError::InsufficientReputation
        );
    }
    require!(
        bidder.active_tasks < MAX_ACTIVE_TASKS,
        CoordinationError::MaxActiveTasksReached
    );
    require!(
        bid_book.active_bids >= 1,
        CoordinationError::BidBookEnumerationMismatch
    );
    validate_cached_winner_selection(task, bid_book, &bid.key(), bid, now)?;

    let expires_at = if task.deadline > 0 {
        task.deadline
            .checked_add(COMPLETION_BUFFER)
            .ok_or(CoordinationError::ArithmeticOverflow)?
    } else {
        now.checked_add(config.max_claim_duration)
            .ok_or(CoordinationError::ArithmeticOverflow)?
    };

    // Bid acceptance is the second canonical TaskClaim creation path. Keep the
    // same monotonic generation invariant as claim_task_with_job_spec; any
    // later failure rolls this value-only reserved-byte write back atomically.
    task.increment_claim_generation()?;

    claim.task = task.key();
    claim.worker = bidder.key();
    claim.claimed_at = now;
    claim.expires_at = expires_at;
    claim.completed_at = 0;
    claim.proof_hash = [0u8; 32];
    claim.result_data = [0u8; 64];
    claim.is_completed = false;
    claim.is_validated = false;
    claim.reward_paid = 0;
    claim.bump = ctx.bumps.claim;

    bid.state = TaskBidState::Accepted;
    bid.updated_at = now;

    bid_book.state = BidBookState::Accepted;
    bid_book.accepted_bid = Some(bid.key());
    bid_book.version = bid_book
        .version
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bid_book.updated_at = now;
    bid_book.winner_stale_since = 0;

    task.current_workers = 1;
    task.status = TaskStatus::InProgress;

    bidder.active_tasks = bidder
        .active_tasks
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bidder.last_active = now;

    bidder_state.total_bids_accepted = bidder_state
        .total_bids_accepted
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    emit!(BidAccepted {
        task: task.key(),
        bid: bid.key(),
        bidder: bidder.key(),
        bid_book: bid_book.key(),
        book_version: bid_book.version,
        policy: bid_book.policy as u8,
        timestamp: now,
    });

    emit!(TaskClaimed {
        task_id: task.task_id,
        worker: bidder.key(),
        current_workers: task.current_workers,
        max_workers: task.max_workers,
        timestamp: now,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct ExpireBid<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        mut,
        seeds = [b"bid_book", task.key().as_ref()],
        bump = bid_book.bump,
        constraint = bid_book.task == task.key() @ CoordinationError::InvalidInput
    )]
    pub bid_book: Box<Account<'info, TaskBidBook>>,

    #[account(
        mut,
        close = bidder_authority,
        seeds = [b"bid", task.key().as_ref(), bidder.key().as_ref()],
        bump = bid.bump,
        constraint = bid.task == task.key() @ CoordinationError::InvalidInput,
        constraint = bid.bidder_authority == bidder_authority.key() @ CoordinationError::UnauthorizedAgent
    )]
    pub bid: Box<Account<'info, TaskBid>>,

    #[account(
        mut,
        seeds = [b"bidder_market", bidder.key().as_ref()],
        bump = bidder_market_state.bump,
        constraint = bidder_market_state.bidder == bidder.key() @ CoordinationError::InvalidInput
    )]
    pub bidder_market_state: Box<Account<'info, BidderMarketState>>,

    #[account(
        seeds = [b"agent", bidder.agent_id.as_ref()],
        bump = bidder.bump
    )]
    pub bidder: Box<Account<'info, AgentRegistration>>,

    /// CHECK: this must equal `bid.bidder_authority`, enforced by the account constraint above,
    /// and only receives lamports when the expired bid account is closed.
    #[account(mut)]
    pub bidder_authority: UncheckedAccount<'info>,

    pub authority: Signer<'info>,
}

pub fn expire_bid_handler(ctx: Context<ExpireBid>) -> Result<()> {
    // Exit-safety: expire_bid is a permissionless cleanup that closes an expired bid and
    // returns the bidder's rent + bond. Like every other refund/settlement path it must
    // remain available while the protocol is paused or the task type is disabled (money
    // never locks). Previously it used the ENTRY gate (rejects while paused) +
    // require_task_type_enabled (entry-only), against the codebase convention and unlike
    // cancel_bid which has no such gate (audit). require_bid_task (a structural check that
    // the task is a bid task) is kept.
    check_version_compatible_for_exit(&ctx.accounts.protocol_config)?;
    require_bid_task(&ctx.accounts.task)?;
    require!(
        ctx.accounts.bid.state.is_open(),
        CoordinationError::BidNotActive
    );

    let now = Clock::get()?.unix_timestamp;
    let task_key = ctx.accounts.task.key();
    let bid_key = ctx.accounts.bid.key();
    let bidder_key = ctx.accounts.bidder.key();
    let bid_book_key = ctx.accounts.bid_book.key();
    require!(
        now > ctx.accounts.bid.expires_at || ctx.accounts.bid_book.state == BidBookState::Closed,
        CoordinationError::BidNotExpired
    );

    let bid_book = &mut ctx.accounts.bid_book;
    bid_book.active_bids = bid_book
        .active_bids
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bid_book.version = bid_book
        .version
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bid_book.updated_at = now;
    // An expiring tracked winner opens the re-promotion grace window exactly
    // like a cancelling one.
    if bid_book.best_bid == bid_key {
        clear_best(bid_book, now);
        emit!(BidWinnerDemoted {
            task: task_key,
            bid: bid_key,
            bid_book: bid_book_key,
            book_version: bid_book.version,
            winner_stale_since: now,
            timestamp: now,
        });
    }

    let bidder_state = &mut ctx.accounts.bidder_market_state;
    bidder_state.active_bid_count = bidder_state
        .active_bid_count
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    emit!(BidExpired {
        task: task_key,
        bid: bid_key,
        bidder: bidder_key,
        bid_book: bid_book_key,
        book_version: bid_book.version,
        timestamp: now,
    });

    Ok(())
}

/// Permissionless winner promotion: present any live, eligible, bond-backed
/// bid; it becomes the book's tracked winner when it beats the cached
/// incumbent (or the book tracks none). Rational bidders promote themselves
/// the moment a leader exits; indexer bots can crank it for anyone.
#[derive(Accounts)]
pub struct PromoteBid<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        mut,
        seeds = [b"bid_book", task.key().as_ref()],
        bump = bid_book.bump,
        constraint = bid_book.task == task.key() @ CoordinationError::InvalidInput
    )]
    pub bid_book: Box<Account<'info, TaskBidBook>>,

    #[account(
        seeds = [b"bid", task.key().as_ref(), bidder.key().as_ref()],
        bump = bid.bump,
        constraint = bid.task == task.key() @ CoordinationError::InvalidInput,
        constraint = bid.bid_book == bid_book.key() @ CoordinationError::InvalidInput,
        constraint = bid.bidder == bidder.key() @ CoordinationError::InvalidInput
    )]
    pub bid: Box<Account<'info, TaskBid>>,

    #[account(
        seeds = [b"agent", bidder.agent_id.as_ref()],
        bump = bidder.bump
    )]
    pub bidder: Box<Account<'info, AgentRegistration>>,

    pub authority: Signer<'info>,
}

pub fn promote_bid_handler(ctx: Context<PromoteBid>) -> Result<()> {
    check_version_compatible(&ctx.accounts.protocol_config)?;
    require_bid_task(&ctx.accounts.task)?;
    require!(
        ctx.accounts.task.status == TaskStatus::Open,
        CoordinationError::TaskNotOpen
    );
    require!(
        ctx.accounts.bid_book.state == BidBookState::Open,
        CoordinationError::BidBookNotOpen
    );
    require!(
        ctx.accounts.bid.state.is_open(),
        CoordinationError::BidNotActive
    );
    let now = Clock::get()?.unix_timestamp;
    // The presented bid must be everything the retired competitor enumeration
    // demanded of a winner: live terms, a currently eligible bidder, and a
    // fully bond-backed account.
    require!(
        bidder_is_currently_eligible(
            &ctx.accounts.bidder.key(),
            ctx.accounts.bidder.as_ref(),
            ctx.accounts.bid.as_ref(),
            ctx.accounts.task.as_ref(),
            ctx.accounts.protocol_config.min_agent_stake,
        ),
        CoordinationError::BidDoesNotSatisfyMatchingPolicy
    );
    require!(
        ctx.accounts.bid.to_account_info().lamports() >= ctx.accounts.bid.bond_lamports,
        CoordinationError::BidBookEnumerationMismatch
    );
    let window_secs = ctx.accounts.bid_book.score_window_secs;
    let weights = ctx.accounts.bid_book.weights;
    let bid_key = ctx.accounts.bid.key();
    let candidate = bid_candidate(
        bid_key,
        ctx.accounts.bid.as_ref(),
        ctx.accounts.task.as_ref(),
        now,
        window_secs,
        &weights,
    )?
    .ok_or(CoordinationError::BidDoesNotSatisfyMatchingPolicy)?;

    let installed = maybe_install_better(
        ctx.accounts.bid_book.as_mut(),
        ctx.accounts.task.as_ref(),
        &candidate,
    )?;
    require!(installed, CoordinationError::BidNotBetterThanTrackedBest);

    let bid_book = ctx.accounts.bid_book.as_mut();
    bid_book.version = bid_book
        .version
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bid_book.updated_at = now;

    emit!(BidPromoted {
        task: ctx.accounts.task.key(),
        bid: bid_key,
        bidder: ctx.accounts.bidder.key(),
        bid_book: ctx.accounts.bid_book.key(),
        book_version: ctx.accounts.bid_book.version,
        timestamp: now,
    });

    Ok(())
}

/// Permissionless demotion of a provably dead tracked winner (expired,
/// withdrawn terms, deadline-infeasible, bond-drained, or ineligible bidder).
/// Without this, a dead leader would block the book: the creator cannot
/// accept it (acceptance revalidates the winner) and nothing worse can
/// displace it. Demotion opens the same re-promotion grace as a cancel.
#[derive(Accounts)]
pub struct DemoteIneligibleBest<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        mut,
        seeds = [b"bid_book", task.key().as_ref()],
        bump = bid_book.bump,
        constraint = bid_book.task == task.key() @ CoordinationError::InvalidInput
    )]
    pub bid_book: Box<Account<'info, TaskBidBook>>,

    #[account(
        seeds = [b"bid", task.key().as_ref(), bidder.key().as_ref()],
        bump = bid.bump,
        constraint = bid.task == task.key() @ CoordinationError::InvalidInput,
        constraint = bid.bid_book == bid_book.key() @ CoordinationError::InvalidInput,
        constraint = bid.bidder == bidder.key() @ CoordinationError::InvalidInput
    )]
    pub bid: Box<Account<'info, TaskBid>>,

    #[account(
        seeds = [b"agent", bidder.agent_id.as_ref()],
        bump = bidder.bump
    )]
    pub bidder: Box<Account<'info, AgentRegistration>>,

    pub authority: Signer<'info>,
}

pub fn demote_ineligible_best_handler(ctx: Context<DemoteIneligibleBest>) -> Result<()> {
    // Exit-gated cleanup: like expire_bid, unblocking a book must stay
    // available while the protocol is paused.
    check_version_compatible_for_exit(&ctx.accounts.protocol_config)?;
    require_bid_task(&ctx.accounts.task)?;
    require!(
        ctx.accounts.bid_book.state == BidBookState::Open,
        CoordinationError::BidBookNotOpen
    );
    let bid_key = ctx.accounts.bid.key();
    require!(
        ctx.accounts.bid_book.best_bid == bid_key,
        CoordinationError::BidNotBookBest
    );
    let now = Clock::get()?.unix_timestamp;
    // The winner is demotable only when it is provably dead. A scoring error
    // on corrupt cached/account state also counts as dead — the book must
    // never stay blocked behind an unacceptable leader.
    let window_secs = ctx.accounts.bid_book.score_window_secs;
    let weights = ctx.accounts.bid_book.weights;
    let candidate_alive = ctx.accounts.bid.state.is_open()
        && bid_candidate(
            bid_key,
            ctx.accounts.bid.as_ref(),
            ctx.accounts.task.as_ref(),
            now,
            window_secs,
            &weights,
        )
        .ok()
        .flatten()
        .is_some();
    let bond_backed =
        ctx.accounts.bid.to_account_info().lamports() >= ctx.accounts.bid.bond_lamports;
    let eligible = bidder_is_currently_eligible(
        &ctx.accounts.bidder.key(),
        ctx.accounts.bidder.as_ref(),
        ctx.accounts.bid.as_ref(),
        ctx.accounts.task.as_ref(),
        ctx.accounts.protocol_config.min_agent_stake,
    );
    require!(
        !(candidate_alive && bond_backed && eligible),
        CoordinationError::BidWinnerStillEligible
    );

    let bid_book = ctx.accounts.bid_book.as_mut();
    clear_best(bid_book, now);
    bid_book.version = bid_book
        .version
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bid_book.updated_at = now;

    emit!(BidWinnerDemoted {
        task: ctx.accounts.task.key(),
        bid: bid_key,
        bid_book: ctx.accounts.bid_book.key(),
        book_version: ctx.accounts.bid_book.version,
        winner_stale_since: now,
        timestamp: now,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{moderation_block_status, ModerationBlock};

    fn paused_bootstrap_config(surface_revision: u16) -> ProtocolConfig {
        ProtocolConfig {
            protocol_paused: true,
            surface_revision,
            protocol_version: crate::state::CURRENT_PROTOCOL_VERSION,
            min_supported_version: crate::state::MIN_SUPPORTED_VERSION,
            ..ProtocolConfig::default()
        }
    }

    #[test]
    fn paused_bid_marketplace_bootstrap_accepts_known_compatible_surfaces() {
        for surface_revision in [
            0,
            ProtocolConfig::SURFACE_REVISION_FULL,
            ProtocolConfig::SURFACE_REVISION_BATCH2,
            ProtocolConfig::SURFACE_REVISION_BATCH3,
            ProtocolConfig::SURFACE_REVISION_BATCH4,
            ProtocolConfig::SURFACE_REVISION_CURRENT,
        ] {
            let config = paused_bootstrap_config(surface_revision);
            assert!(check_bid_marketplace_bootstrap_compatible(&config).is_ok());
        }
    }

    #[test]
    fn paused_bid_marketplace_bootstrap_rejects_incompatible_version_or_surface() {
        let mut too_new = paused_bootstrap_config(0);
        too_new.protocol_version = crate::state::CURRENT_PROTOCOL_VERSION.saturating_add(1);
        assert!(check_bid_marketplace_bootstrap_compatible(&too_new).is_err());

        let mut invalid_minimum = paused_bootstrap_config(0);
        invalid_minimum.min_supported_version =
            crate::state::CURRENT_PROTOCOL_VERSION.saturating_add(1);
        assert!(check_bid_marketplace_bootstrap_compatible(&invalid_minimum).is_err());

        let unknown_surface =
            paused_bootstrap_config(ProtocolConfig::SURFACE_REVISION_CURRENT.saturating_add(1));
        assert!(check_bid_marketplace_bootstrap_compatible(&unknown_surface).is_err());
    }

    #[test]
    fn paused_bootstrap_does_not_relax_the_bid_entry_gate() {
        let config = paused_bootstrap_config(0);
        assert!(check_bid_marketplace_bootstrap_compatible(&config).is_ok());
        assert!(
            check_version_compatible(&config).is_err(),
            "ordinary bid entry must remain blocked while the protocol is paused"
        );
    }

    fn sample_job_spec() -> TaskJobSpec {
        let mut spec = TaskJobSpec {
            task: Pubkey::new_unique(),
            creator: Pubkey::new_unique(),
            job_spec_hash: [7u8; 32],
            job_spec_uri: "agenc://job/sha256/test".to_string(),
            created_at: 10,
            updated_at: 20,
            bump: 254,
            _reserved: [0u8; 7],
        };
        spec.lock_for_bids();
        spec
    }

    fn sample_bid(task: Pubkey, bid_book: Pubkey) -> TaskBid {
        TaskBid {
            task,
            bid_book,
            bidder: Pubkey::new_unique(),
            bidder_authority: Pubkey::new_unique(),
            requested_reward_lamports: 50_000,
            eta_seconds: 900,
            confidence_bps: 9_500,
            reputation_snapshot_bps: 8_000,
            quality_guarantee_hash: [11u8; 32],
            metadata_hash: [12u8; 32],
            expires_at: 5_000,
            created_at: 100,
            updated_at: 101,
            state: TaskBidState::BoundActive,
            bond_lamports: 1_000,
            bump: 253,
            accepted_no_show_slash_bps: 2_500,
        }
    }

    // Revert-sensitive guard test for the bid-path self-deal fix (#831).
    // `ensure_not_self_bid` is the single source of the guard, called by both
    // create_bid_handler (signer authority) and accept_bid_handler (stored
    // bid.bidder_authority). Removing/weakening the require! turns
    // rejects_self_bid_same_authority red.
    #[test]
    fn rejects_self_bid_same_authority() {
        let same = Pubkey::new_unique();
        assert!(ensure_not_self_bid(same, same).is_err());
    }

    #[test]
    fn allows_distinct_authority() {
        let bidder_authority = Pubkey::new_unique();
        let task_creator = Pubkey::new_unique();
        assert!(ensure_not_self_bid(bidder_authority, task_creator).is_ok());
    }

    #[test]
    fn bidder_validation_cannot_lock_an_unlocked_job_spec() {
        let mut spec = sample_job_spec();
        spec._reserved = [0u8; 7];
        let expected_hash = spec.job_spec_hash;
        let expected_updated_at = spec.updated_at;

        assert!(validate_bound_bid_job_spec(&spec, &expected_hash, expected_updated_at,).is_err());
        assert!(!spec.is_bid_locked());

        lock_bid_book_job_spec(&mut spec).unwrap();
        assert!(spec.is_bid_locked());
        validate_bound_bid_job_spec(&spec, &expected_hash, expected_updated_at).unwrap();
    }

    #[test]
    fn bound_bid_snapshot_must_match_exact_content_and_version() {
        let spec = sample_job_spec();
        let expected_updated_at = spec.updated_at;

        assert!(validate_bound_bid_job_spec(&spec, &[99u8; 32], expected_updated_at,).is_err());
        assert!(validate_bound_bid_job_spec(
            &spec,
            &spec.job_spec_hash,
            expected_updated_at.saturating_add(1),
        )
        .is_err());
        validate_bound_bid_job_spec(&spec, &spec.job_spec_hash, expected_updated_at).unwrap();
    }

    #[test]
    fn creator_lock_rejects_an_empty_job_spec_pointer() {
        let mut empty = TaskJobSpec::default();
        assert!(lock_bid_book_job_spec(&mut empty).is_err());
        assert!(!empty.is_bid_locked());

        empty.job_spec_hash = [1u8; 32];
        assert!(lock_bid_book_job_spec(&mut empty).is_err());
        assert!(!empty.is_bid_locked());

        empty.job_spec_uri = "agenc://job/sha256/test".to_string();
        lock_bid_book_job_spec(&mut empty).unwrap();
        assert!(empty.is_bid_locked());
    }

    #[test]
    fn acceptance_rejects_legacy_unbound_and_stale_snapshots() {
        let task_key = Pubkey::new_unique();
        let bid_key = Pubkey::new_unique();
        let bid_book_key = Pubkey::new_unique();
        let spec = sample_job_spec();
        let bid = sample_bid(task_key, bid_book_key);
        let expected_hash = calculate_bid_terms_hash(&task_key, &bid_key, &bid, &spec);

        validate_bid_acceptance_snapshot(&task_key, &bid_key, &bid, &spec, &expected_hash).unwrap();

        let mut legacy = sample_bid(task_key, bid_book_key);
        legacy.state = TaskBidState::Active;
        let legacy_hash = calculate_bid_terms_hash(&task_key, &bid_key, &legacy, &spec);
        assert!(validate_bid_acceptance_snapshot(
            &task_key,
            &bid_key,
            &legacy,
            &spec,
            &legacy_hash,
        )
        .is_err());

        let mut unlocked_spec = sample_job_spec();
        unlocked_spec._reserved = [0u8; 7];
        let unlocked_hash = calculate_bid_terms_hash(&task_key, &bid_key, &bid, &unlocked_spec);
        assert!(validate_bid_acceptance_snapshot(
            &task_key,
            &bid_key,
            &bid,
            &unlocked_spec,
            &unlocked_hash,
        )
        .is_err());

        let mut repriced = sample_bid(task_key, bid_book_key);
        repriced.requested_reward_lamports = 50_001;
        assert!(validate_bid_acceptance_snapshot(
            &task_key,
            &bid_key,
            &repriced,
            &spec,
            &expected_hash,
        )
        .is_err());
    }

    #[test]
    fn bid_terms_digest_covers_every_contract_field() {
        let task_key = Pubkey::new_unique();
        let bid_key = Pubkey::new_unique();
        let bid_book_key = Pubkey::new_unique();
        let spec = sample_job_spec();
        let baseline_bid = sample_bid(task_key, bid_book_key);
        let baseline = calculate_bid_terms_hash(&task_key, &bid_key, &baseline_bid, &spec);

        macro_rules! assert_field_changes_digest {
            ($field:ident, $value:expr) => {{
                let mut changed = sample_bid(task_key, bid_book_key);
                changed.$field = $value;
                assert_ne!(
                    calculate_bid_terms_hash(&task_key, &bid_key, &changed, &spec),
                    baseline,
                    concat!(stringify!($field), " must be committed")
                );
            }};
        }

        assert_field_changes_digest!(task, Pubkey::new_unique());
        assert_field_changes_digest!(bid_book, Pubkey::new_unique());
        assert_field_changes_digest!(bidder, Pubkey::new_unique());
        assert_field_changes_digest!(bidder_authority, Pubkey::new_unique());
        assert_field_changes_digest!(requested_reward_lamports, 50_001);
        assert_field_changes_digest!(eta_seconds, 901);
        assert_field_changes_digest!(confidence_bps, 9_499);
        assert_field_changes_digest!(reputation_snapshot_bps, 7_999);
        assert_field_changes_digest!(quality_guarantee_hash, [21u8; 32]);
        assert_field_changes_digest!(metadata_hash, [22u8; 32]);
        assert_field_changes_digest!(expires_at, 5_001);
        assert_field_changes_digest!(created_at, 99);
        assert_field_changes_digest!(updated_at, 102);
        assert_field_changes_digest!(bond_lamports, 1_001);
        assert_field_changes_digest!(accepted_no_show_slash_bps, 2_499);

        assert_ne!(
            calculate_bid_terms_hash(&Pubkey::new_unique(), &bid_key, &baseline_bid, &spec),
            baseline
        );
        assert_ne!(
            calculate_bid_terms_hash(&task_key, &Pubkey::new_unique(), &baseline_bid, &spec),
            baseline
        );
        let mut changed_spec = sample_job_spec();
        changed_spec.job_spec_hash = [8u8; 32];
        assert_ne!(
            calculate_bid_terms_hash(&task_key, &bid_key, &baseline_bid, &changed_spec),
            baseline
        );
        let mut changed_spec_version = sample_job_spec();
        changed_spec_version.updated_at += 1;
        assert_ne!(
            calculate_bid_terms_hash(&task_key, &bid_key, &baseline_bid, &changed_spec_version,),
            baseline
        );
    }

    #[test]
    fn bid_terms_hash_matches_cross_language_golden_vector() {
        let task_key = Pubkey::new_from_array([1u8; 32]);
        let bid_key = Pubkey::new_from_array([2u8; 32]);
        let bid = TaskBid {
            task: task_key,
            bid_book: Pubkey::new_from_array([3u8; 32]),
            bidder: Pubkey::new_from_array([4u8; 32]),
            bidder_authority: Pubkey::new_from_array([5u8; 32]),
            requested_reward_lamports: 1_000,
            eta_seconds: 3_600,
            confidence_bps: 8_000,
            reputation_snapshot_bps: 9_000,
            quality_guarantee_hash: [6u8; 32],
            metadata_hash: [7u8; 32],
            expires_at: 1_700_000_000,
            created_at: 1_699_000_000,
            updated_at: 1_699_500_000,
            state: TaskBidState::BoundActive,
            bond_lamports: 50_000,
            bump: 0,
            accepted_no_show_slash_bps: 625,
        };
        let spec = TaskJobSpec {
            job_spec_hash: [8u8; 32],
            updated_at: 42,
            ..TaskJobSpec::default()
        };

        assert_eq!(
            calculate_bid_terms_hash(&task_key, &bid_key, &bid, &spec),
            [
                0xe5, 0x97, 0x0d, 0xb9, 0xeb, 0x02, 0xa7, 0x5e, 0xd6, 0x6d, 0x23, 0x70, 0xb4, 0xe9,
                0x07, 0xd5, 0xaa, 0xb4, 0xa3, 0xac, 0xe7, 0xd8, 0xdc, 0x18, 0x1e, 0x23, 0x39, 0x7a,
                0x22, 0x64, 0xc7, 0xe5,
            ]
        );
    }

    #[test]
    fn marketplace_config_caps_are_inclusive_and_fail_closed() {
        validate_bid_marketplace_config_values(
            MAX_BID_BOND_LAMPORTS,
            MAX_BID_CREATION_COOLDOWN_SECS,
            MAX_BIDS_PER_24H,
            MAX_ACTIVE_BIDS_PER_TASK,
            MAX_BID_LIFETIME_SECS,
            MAX_CONFIDENCE_BPS,
        )
        .unwrap();

        assert!(validate_bid_marketplace_config_values(
            MAX_BID_BOND_LAMPORTS.saturating_add(1),
            0,
            1,
            1,
            1,
            0,
        )
        .is_err());
        assert!(validate_bid_marketplace_config_values(
            1,
            MAX_BID_CREATION_COOLDOWN_SECS.saturating_add(1),
            1,
            1,
            1,
            0,
        )
        .is_err());
        assert!(validate_bid_marketplace_config_values(
            1,
            0,
            MAX_BIDS_PER_24H.saturating_add(1),
            1,
            1,
            0,
        )
        .is_err());
        assert!(validate_bid_marketplace_config_values(1, 0, 1, 21, 1, 0).is_err());
        assert!(validate_bid_marketplace_config_values(
            1,
            0,
            1,
            1,
            MAX_BID_LIFETIME_SECS.saturating_add(1),
            0,
        )
        .is_err());
    }

    #[test]
    fn declared_policy_has_deterministic_tie_breaks() {
        let low_key = BidCandidate {
            key: Pubkey::new_from_array([1u8; 32]),
            requested_reward_lamports: 1_000,
            eta_seconds: 100,
            confidence_bps: 8_000,
            reputation_snapshot_bps: 9_000,
            weighted_score: 50,
        };
        let mut candidate = low_key;
        candidate.key = Pubkey::new_from_array([2u8; 32]);
        assert!(candidate_is_better(
            &low_key,
            &candidate,
            MatchingPolicy::BestPrice
        ));

        candidate.requested_reward_lamports = 900;
        candidate.eta_seconds = 200;
        assert!(candidate_is_better(
            &candidate,
            &low_key,
            MatchingPolicy::BestPrice
        ));
        assert!(candidate_is_better(
            &low_key,
            &candidate,
            MatchingPolicy::BestEta
        ));

        candidate.weighted_score = 51;
        assert!(candidate_is_better(
            &candidate,
            &low_key,
            MatchingPolicy::WeightedScore
        ));
    }

    fn cached_book(task_key: Pubkey, policy: MatchingPolicy) -> TaskBidBook {
        TaskBidBook {
            task: task_key,
            state: BidBookState::Open,
            policy,
            weights: WeightedScoreWeights::default(),
            accepted_bid: None,
            version: 99,
            total_bids: 2,
            active_bids: 2,
            created_at: 1,
            updated_at: 1,
            bump: 0,
            score_window_secs: 9_999,
            ..TaskBidBook::default()
        }
    }

    // Revert-sensitive O(1)-accept guard: acceptance must enforce (a) exact
    // tracked-winner identity, (b) exact cached-component match against the
    // live bid account, (c) the re-promotion grace after a winner exit, and
    // (d) live candidate validity. Weakening any arm turns this red.
    #[test]
    fn cached_winner_selection_enforces_best_match_grace_and_validity() {
        let task_key = Pubkey::new_unique();
        let bid_book_key = Pubkey::new_unique();
        let task = Task {
            reward_amount: 100_000,
            deadline: 10_000,
            ..Task::default()
        };
        let selected_key = Pubkey::new_unique();
        let mut selected = sample_bid(task_key, bid_book_key);
        selected.requested_reward_lamports = 40_000;
        selected.expires_at = 9_000;

        let mut book = cached_book(task_key, MatchingPolicy::BestPrice);

        // No tracked winner: nothing is acceptable.
        assert!(
            validate_cached_winner_selection(&task, &book, &selected_key, &selected, 1_000)
                .is_err()
        );

        // Tracked winner with exactly matching components: accepted.
        book.best_bid = selected_key;
        book.best_reward_lamports = selected.requested_reward_lamports;
        book.best_eta_seconds = selected.eta_seconds;
        book.best_confidence_bps = selected.confidence_bps;
        book.best_reputation_bps = selected.reputation_snapshot_bps;
        validate_cached_winner_selection(&task, &book, &selected_key, &selected, 1_000).unwrap();

        // A different bid than the tracked winner: rejected.
        assert!(validate_cached_winner_selection(
            &task,
            &book,
            &Pubkey::new_unique(),
            &selected,
            1_000
        )
        .is_err());

        // Cached components drifting from the live account: fail closed.
        book.best_reward_lamports = selected.requested_reward_lamports + 1;
        assert!(
            validate_cached_winner_selection(&task, &book, &selected_key, &selected, 1_000)
                .is_err()
        );
        book.best_reward_lamports = selected.requested_reward_lamports;

        // Winner-exit grace: blocked inside the window, allowed after it.
        // Times derive from the (feature-dependent) grace constant.
        book.winner_stale_since = 900;
        assert!(validate_cached_winner_selection(
            &task,
            &book,
            &selected_key,
            &selected,
            900 + BID_REPROMOTION_GRACE_SECS - 1,
        )
        .is_err());
        validate_cached_winner_selection(
            &task,
            &book,
            &selected_key,
            &selected,
            900 + BID_REPROMOTION_GRACE_SECS,
        )
        .unwrap();
        book.winner_stale_since = 0;

        // An expired tracked winner is not acceptable.
        assert!(
            validate_cached_winner_selection(&task, &book, &selected_key, &selected, 9_500)
                .is_err()
        );
    }

    // Equivalence guard for the incremental argmax: over a mutation sequence,
    // the cache must always equal a full rescan of live candidates under the
    // frozen scoring window. Reverting incremental maintenance (or thawing
    // the window back to `deadline - now`) turns this red.
    #[test]
    fn incremental_cache_matches_full_rescan_argmax() {
        let task_key = Pubkey::new_unique();
        let bid_book_key = Pubkey::new_unique();
        let task = Task {
            reward_amount: 100_000,
            deadline: 10_000,
            ..Task::default()
        };
        for policy in [
            MatchingPolicy::BestPrice,
            MatchingPolicy::BestEta,
            MatchingPolicy::WeightedScore,
        ] {
            let mut book = cached_book(task_key, policy);
            book.weights = WeightedScoreWeights {
                price_weight_bps: 4_000,
                eta_weight_bps: 3_000,
                confidence_weight_bps: 2_000,
                reliability_weight_bps: 1_000,
            };
            let mut live: Vec<(Pubkey, TaskBid)> = Vec::new();
            // Deterministic pseudo-random mutation schedule.
            let mut seed = 0x9e3779b97f4a7c15u64;
            for step in 0..60u64 {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(step);
                let arrival_now = 1_000 + i64::try_from(step).unwrap();
                if live.len() > 2 && seed % 5 == 0 {
                    // Remove a live bid; demote the cache when it was best.
                    let victim = usize::try_from(seed % (live.len() as u64)).unwrap();
                    let (gone_key, _) = live.remove(victim);
                    if book.best_bid == gone_key {
                        clear_best(&mut book, arrival_now);
                    }
                } else {
                    let mut bid = sample_bid(task_key, bid_book_key);
                    bid.requested_reward_lamports = 1 + (seed % 99_999);
                    bid.eta_seconds = 1 + u32::try_from(seed % 7_000).unwrap();
                    bid.confidence_bps = u16::try_from(seed % 10_001).unwrap();
                    bid.reputation_snapshot_bps = u16::try_from((seed >> 17) % 10_001).unwrap();
                    bid.expires_at = 9_999;
                    let key = Pubkey::new_unique();
                    if let Some(candidate) = bid_candidate(
                        key,
                        &bid,
                        &task,
                        arrival_now,
                        book.score_window_secs,
                        &book.weights,
                    )
                    .unwrap()
                    {
                        maybe_install_better(&mut book, &task, &candidate).unwrap();
                        live.push((key, bid));
                    }
                }
                // Full rescan of everything still live at a FIXED later time:
                // frozen-window scores make the ordering time-invariant.
                let mut rescan_best: Option<BidCandidate> = None;
                for (key, bid) in &live {
                    if let Some(candidate) = bid_candidate(
                        *key,
                        bid,
                        &task,
                        1_000,
                        book.score_window_secs,
                        &book.weights,
                    )
                    .unwrap()
                    {
                        rescan_best = match rescan_best {
                            None => Some(candidate),
                            Some(incumbent) => {
                                if candidate_is_better(&candidate, &incumbent, book.policy) {
                                    Some(candidate)
                                } else {
                                    Some(incumbent)
                                }
                            }
                        };
                    }
                }
                match (&rescan_best, book.best_bid == Pubkey::default()) {
                    // A removal can legitimately leave the cache empty while
                    // live bids remain — that is exactly the stale state the
                    // permissionless promote crank repairs. Model it.
                    (Some(best), true) => {
                        maybe_install_better(&mut book, &task, best).unwrap();
                        assert_eq!(book.best_bid, best.key);
                    }
                    (Some(best), false) => {
                        // The cache may hold a bid that was since removed from
                        // `live` only in the same step it was cleared; here a
                        // non-empty cache must be the true argmax.
                        assert_eq!(
                            book.best_bid, best.key,
                            "cache diverged from full rescan under policy {}",
                            book.policy as u8
                        );
                    }
                    (None, true) => {}
                    (None, false) => panic!("cache tracks a winner but no live candidate exists"),
                }
            }
        }
    }

    // Coverage restored after the enumeration-machinery removal: these pure
    // gates previously ran only through the retired competitor-pair tests.
    #[test]
    fn require_bid_task_enforces_type_worker_and_sol_shape() {
        let good = Task {
            task_type: TaskType::BidExclusive,
            max_workers: 1,
            ..Task::default()
        };
        require_bid_task(&good).unwrap();
        let mut wrong_type = good.clone();
        wrong_type.task_type = TaskType::Collaborative;
        assert!(require_bid_task(&wrong_type).is_err());
        let mut multi_worker = good.clone();
        multi_worker.max_workers = 2;
        assert!(require_bid_task(&multi_worker).is_err());
        let mut token_task = good;
        token_task.reward_mint = Some(Pubkey::new_unique());
        assert!(require_bid_task(&token_task).is_err());
    }

    #[test]
    fn refresh_bid_window_resets_only_on_first_use_or_expiry() {
        let mut state = BidderMarketState::default();
        refresh_bid_window(&mut state, 1_000);
        assert_eq!(state.bid_window_started_at, 1_000);
        assert_eq!(state.bids_created_in_window, 0);
        state.bids_created_in_window = 5;
        refresh_bid_window(&mut state, 1_000 + BID_WINDOW_SECONDS - 1);
        assert_eq!(
            state.bid_window_started_at, 1_000,
            "inside the window: no reset"
        );
        assert_eq!(state.bids_created_in_window, 5);
        refresh_bid_window(&mut state, 1_000 + BID_WINDOW_SECONDS);
        assert_eq!(state.bid_window_started_at, 1_000 + BID_WINDOW_SECONDS);
        assert_eq!(state.bids_created_in_window, 0);
    }

    #[test]
    fn parse_matching_policy_accepts_known_policies_and_fails_closed() {
        assert_eq!(
            parse_matching_policy(0, 0, 0, 0, 0).unwrap().0 as u8,
            MatchingPolicy::BestPrice as u8
        );
        assert_eq!(
            parse_matching_policy(1, 0, 0, 0, 0).unwrap().0 as u8,
            MatchingPolicy::BestEta as u8
        );
        let (policy, weights) = parse_matching_policy(2, 4_000, 3_000, 2_000, 1_000).unwrap();
        assert_eq!(policy as u8, MatchingPolicy::WeightedScore as u8);
        assert_eq!(weights.price_weight_bps, 4_000);
        assert!(parse_matching_policy(3, 0, 0, 0, 0).is_err());
        assert!(parse_matching_policy(2, 0, 0, 0, 0).is_err());
    }

    #[test]
    fn bidder_eligibility_checks_every_live_gate() {
        let task = Task {
            required_capabilities: 1,
            min_reputation: 100,
            creator: Pubkey::new_unique(),
            ..Task::default()
        };
        let authority = Pubkey::new_unique();
        let bidder_key = Pubkey::new_unique();
        let bidder = AgentRegistration {
            authority,
            status: AgentStatus::Active,
            capabilities: 1,
            reputation: 100,
            stake: 10,
            active_tasks: 0,
            ..AgentRegistration::default()
        };
        let bid = TaskBid {
            bidder: bidder_key,
            bidder_authority: authority,
            ..TaskBid::default()
        };
        assert!(bidder_is_currently_eligible(
            &bidder_key,
            &bidder,
            &bid,
            &task,
            10
        ));
        // Each live gate flips eligibility off.
        assert!(!bidder_is_currently_eligible(
            &Pubkey::new_unique(),
            &bidder,
            &bid,
            &task,
            10
        ));
        let mut suspended = bidder.clone();
        suspended.status = AgentStatus::Suspended;
        assert!(!bidder_is_currently_eligible(
            &bidder_key,
            &suspended,
            &bid,
            &task,
            10
        ));
        let mut weak = bidder.clone();
        weak.capabilities = 0;
        assert!(!bidder_is_currently_eligible(
            &bidder_key,
            &weak,
            &bid,
            &task,
            10
        ));
        let mut poor = bidder.clone();
        poor.reputation = 99;
        assert!(!bidder_is_currently_eligible(
            &bidder_key,
            &poor,
            &bid,
            &task,
            10
        ));
        let mut understaked = bidder.clone();
        understaked.stake = 9;
        assert!(!bidder_is_currently_eligible(
            &bidder_key,
            &understaked,
            &bid,
            &task,
            10
        ));
        let mut busy = bidder.clone();
        busy.active_tasks = MAX_ACTIVE_TASKS;
        assert!(!bidder_is_currently_eligible(
            &bidder_key,
            &busy,
            &bid,
            &task,
            10
        ));
        let mut self_deal = bidder;
        self_deal.authority = task.creator;
        let mut self_bid = bid;
        self_bid.bidder_authority = task.creator;
        assert!(!bidder_is_currently_eligible(
            &bidder_key,
            &self_deal,
            &self_bid,
            &task,
            10
        ));
    }

    // The tracked best may sweeten but never retreat: for any same-key pair,
    // the update is allowed exactly when the incumbent is NOT strictly better
    // than the refreshed terms.
    #[test]
    fn leader_retreat_comparator_is_equal_or_better() {
        let key = Pubkey::new_unique();
        let old = BidCandidate {
            key,
            requested_reward_lamports: 50_000,
            eta_seconds: 100,
            confidence_bps: 5_000,
            reputation_snapshot_bps: 5_000,
            weighted_score: 100,
        };
        let same = old;
        assert!(!candidate_is_better(&old, &same, MatchingPolicy::BestPrice));
        let mut better = old;
        better.requested_reward_lamports = 49_999;
        assert!(!candidate_is_better(
            &old,
            &better,
            MatchingPolicy::BestPrice
        ));
        let mut worse = old;
        worse.requested_reward_lamports = 50_001;
        assert!(candidate_is_better(&old, &worse, MatchingPolicy::BestPrice));
    }

    // Frozen-window scoring: the weighted ordering between two candidates
    // must not depend on the clock. Under the retired `deadline - now`
    // normalization this assertion flips as `now` advances — revert-sensitive
    // against thawing the window.
    #[test]
    fn weighted_ordering_is_time_invariant_under_frozen_window() {
        let weights = WeightedScoreWeights {
            price_weight_bps: 5_000,
            eta_weight_bps: 5_000,
            confidence_weight_bps: 0,
            reliability_weight_bps: 0,
        };
        let score = |reward: u64, eta: u32, window: u32| {
            weighted_terms_score(reward, eta, 0, 0, 100_000, window, &weights)
                .unwrap()
                .unwrap()
        };
        // Cheap-but-slow vs pricier-but-fast under the SAME frozen window:
        // whichever wins, wins at every evaluation time.
        let window = 20_000;
        let a = score(10_000, 8_000, window);
        let b = score(60_000, 100, window);
        assert_eq!(
            a > b,
            score(10_000, 8_000, window) > score(60_000, 100, window)
        );
        // The retired normalization used `deadline - now` as the window; with
        // time passing (a shrinking window) the SAME pair flips order — which
        // is exactly what freezing forbids. Prove the flip exists so this
        // test fails if scoring ever keys on the clock again.
        let early = score(10_000, 8_000, 20_000) > score(60_000, 100, 20_000);
        let late = score(10_000, 8_000, 9_999) > score(60_000, 100, 9_999);
        assert_ne!(early, late, "chosen pair must be window-sensitive");
    }

    #[test]
    fn blocked_job_spec_cannot_be_accepted_after_publication() {
        let spec = sample_job_spec();
        let (block_key, bump) = Pubkey::find_program_address(
            &[b"moderation_block", spec.job_spec_hash.as_ref()],
            &crate::ID,
        );
        let block = ModerationBlock {
            content_hash: spec.job_spec_hash,
            status: moderation_block_status::BLOCKED,
            rationale_hash: [1u8; 32],
            rationale_uri: "agenc://moderation/test".to_string(),
            set_at: 1,
            updated_at: 1,
            updated_by: Pubkey::new_unique(),
            bump,
            _reserved: [0u8; 16],
        };
        let mut data = Vec::new();
        block.try_serialize(&mut data).unwrap();
        let mut lamports = 1_000_000u64;
        let block_info = AccountInfo::new(
            &block_key,
            false,
            false,
            &mut lamports,
            &mut data,
            &crate::ID,
            false,
            0,
        );

        assert!(validate_bid_job_spec_for_acceptance(&spec, &block_info).is_err());
    }
}
