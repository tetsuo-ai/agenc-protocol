//! Marketplace V2 bid-book instructions.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use solana_sha256_hasher::hashv;

use crate::errors::CoordinationError;
use crate::events::{
    BidAccepted, BidBookInitialized, BidCancelled, BidCreated, BidExpired,
    BidMarketplaceInitialized, BidUpdated, TaskClaimed,
};
use crate::instructions::claim_task::has_required_assignment_stake;
use crate::instructions::completion_helpers::validate_task_dependency_for_assignment;
use crate::instructions::launch_controls::require_task_type_enabled;
use crate::instructions::moderation_gate_helpers::require_content_not_blocked;
use crate::state::{
    AgentRegistration, AgentStatus, BidBookState, BidMarketplaceConfig, BidderMarketState,
    MatchingPolicy, ProtocolConfig, Task, TaskBid, TaskBidBook, TaskBidState, TaskClaim,
    TaskJobSpec, TaskStatus, TaskType, WeightedScoreWeights,
};
use crate::utils::multisig::{require_multisig_threshold, unique_account_infos};
use crate::utils::version::{check_version_compatible, check_version_compatible_for_exit};

const BID_WINDOW_SECONDS: i64 = 86_400;
const COMPLETION_BUFFER: i64 = 3_600;
const MAX_CONFIDENCE_BPS: u16 = 10_000;
const MAX_ACTIVE_TASKS: u16 = 10;
const BID_TERMS_HASH_DOMAIN: &[u8] = b"agenc:bid-terms:v1";
const MAX_BID_BOND_LAMPORTS: u64 = 1_000_000_000;
const MAX_BID_CREATION_COOLDOWN_SECS: i64 = BID_WINDOW_SECONDS;
const MAX_BIDS_PER_24H: u16 = 1_000;
/// `accept_bid` enumerates all other live bids in the transaction. Twenty is
/// the largest supported book and keeps the account list transaction-feasible.
const MAX_ACTIVE_BIDS_PER_TASK: u16 = 20;
const MAX_BID_LIFETIME_SECS: i64 = 7 * BID_WINDOW_SECONDS;
const BID_COMPETITOR_ACCOUNT_STRIDE: usize = 2;
const ACCEPT_BID_TYPED_ACCOUNT_COUNT: usize = 11;
const ACCEPT_BID_AUXILIARY_PROGRAM_KEYS: usize = 2;
const MAX_TRANSACTION_ACCOUNT_KEYS: usize = 64;

fn validate_bid_marketplace_config_values(
    min_bid_bond_lamports: u64,
    bid_creation_cooldown_secs: i64,
    max_bids_per_24h: u16,
    max_active_bids_per_task: u16,
    max_bid_lifetime_secs: i64,
    accepted_no_show_slash_bps: u16,
) -> Result<()> {
    let accept_account_keys =
        accept_bid_account_key_budget(max_active_bids_per_task, true).unwrap_or(usize::MAX);
    require!(
        (1..=MAX_BID_BOND_LAMPORTS).contains(&min_bid_bond_lamports)
            && (0..=MAX_BID_CREATION_COOLDOWN_SECS).contains(&bid_creation_cooldown_secs)
            && (1..=MAX_BIDS_PER_24H).contains(&max_bids_per_24h)
            && (1..=MAX_ACTIVE_BIDS_PER_TASK).contains(&max_active_bids_per_task)
            && (1..=MAX_BID_LIFETIME_SECS).contains(&max_bid_lifetime_secs)
            && accepted_no_show_slash_bps <= MAX_CONFIDENCE_BPS
            && accept_account_keys <= MAX_TRANSACTION_ACCOUNT_KEYS,
        CoordinationError::InvalidBidMarketplaceConfig
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

fn bid_candidate(
    key: Pubkey,
    bid: &TaskBid,
    task: &Task,
    now: i64,
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

    let task_budget = u128::from(task.reward_amount);
    let remaining_secs = u128::try_from(task.deadline.saturating_sub(now))
        .map_err(|_| CoordinationError::ArithmeticOverflow)?;
    require!(
        task_budget > 0 && remaining_secs > 0,
        CoordinationError::InvalidInput
    );
    let price_score = u128::from(
        task.reward_amount
            .checked_sub(bid.requested_reward_lamports)
            .ok_or(CoordinationError::ArithmeticOverflow)?,
    )
    .checked_mul(u128::from(MAX_CONFIDENCE_BPS))
    .and_then(|value| value.checked_div(task_budget))
    .ok_or(CoordinationError::ArithmeticOverflow)?;
    let eta_score = remaining_secs
        .checked_sub(u128::from(bid.eta_seconds))
        .and_then(|value| value.checked_mul(u128::from(MAX_CONFIDENCE_BPS)))
        .and_then(|value| value.checked_div(remaining_secs))
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let weighted_score = price_score
        .checked_mul(u128::from(weights.price_weight_bps))
        .and_then(|value| {
            value.checked_add(eta_score.checked_mul(u128::from(weights.eta_weight_bps))?)
        })
        .and_then(|value| {
            value.checked_add(
                u128::from(bid.confidence_bps)
                    .checked_mul(u128::from(weights.confidence_weight_bps))?,
            )
        })
        .and_then(|value| {
            value.checked_add(
                u128::from(bid.reputation_snapshot_bps)
                    .checked_mul(u128::from(weights.reliability_weight_bps))?,
            )
        })
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    Ok(Some(BidCandidate {
        key,
        requested_reward_lamports: bid.requested_reward_lamports,
        eta_seconds: bid.eta_seconds,
        confidence_bps: bid.confidence_bps,
        reputation_snapshot_bps: bid.reputation_snapshot_bps,
        weighted_score,
    }))
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

fn validate_bid_account<'info>(
    account: &AccountInfo<'info>,
    task_key: &Pubkey,
    bid_book_key: &Pubkey,
    program_id: &Pubkey,
) -> Result<TaskBid> {
    require!(
        account.owner == program_id && !account.executable && account.data_len() == TaskBid::SIZE,
        CoordinationError::InvalidAccountOwner
    );
    let data = account.try_borrow_data()?;
    let bid = TaskBid::try_deserialize(&mut &data[..])
        .map_err(|_| CoordinationError::BidBookEnumerationMismatch)?;
    require!(
        bid.task == *task_key && bid.bid_book == *bid_book_key && bid.state.is_open(),
        CoordinationError::BidBookEnumerationMismatch
    );
    let bump = [bid.bump];
    let canonical_key = Pubkey::create_program_address(
        &[b"bid", task_key.as_ref(), bid.bidder.as_ref(), &bump],
        program_id,
    )
    .map_err(|_| CoordinationError::BidBookEnumerationMismatch)?;
    require!(
        canonical_key == *account.key,
        CoordinationError::BidBookEnumerationMismatch
    );
    require!(
        account.lamports() >= bid.bond_lamports,
        CoordinationError::BidBookEnumerationMismatch
    );
    Ok(bid)
}

fn validate_bidder_account<'info>(
    account: &AccountInfo<'info>,
    expected_bidder_key: &Pubkey,
    expected_bidder_authority: &Pubkey,
    program_id: &Pubkey,
) -> Result<AgentRegistration> {
    require!(
        account.owner == program_id
            && !account.executable
            && account.data_len() == AgentRegistration::SIZE,
        CoordinationError::InvalidAccountOwner
    );
    let data = account.try_borrow_data()?;
    let bidder = AgentRegistration::try_deserialize(&mut &data[..])
        .map_err(|_| CoordinationError::BidBookEnumerationMismatch)?;
    let bump = [bidder.bump];
    let canonical_key =
        Pubkey::create_program_address(&[b"agent", bidder.agent_id.as_ref(), &bump], program_id)
            .map_err(|_| CoordinationError::BidBookEnumerationMismatch)?;
    require!(
        canonical_key == *account.key
            && canonical_key == *expected_bidder_key
            && bidder.authority == *expected_bidder_authority,
        CoordinationError::BidBookEnumerationMismatch
    );
    Ok(bidder)
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

fn accept_bid_account_key_budget(active_bids: u16, has_dependency: bool) -> Result<usize> {
    let competing_bids = usize::from(
        active_bids
            .checked_sub(1)
            .ok_or(CoordinationError::ArithmeticOverflow)?,
    );
    ACCEPT_BID_TYPED_ACCOUNT_COUNT
        .checked_add(usize::from(has_dependency))
        .and_then(|value| {
            value.checked_add(competing_bids.checked_mul(BID_COMPETITOR_ACCOUNT_STRIDE)?)
        })
        .and_then(|value| value.checked_add(ACCEPT_BID_AUXILIARY_PROGRAM_KEYS))
        .ok_or_else(|| CoordinationError::ArithmeticOverflow.into())
}

/// Enforce the bid book's declared policy from an exact enumeration of all other
/// open bids. Each competitor is an exact `[TaskBid, AgentRegistration]` pair.
/// The program-maintained `active_bids` counter makes omission or duplication
/// fail closed, while canonical PDA checks prevent account substitution.
fn validate_matching_policy_selection<'info>(
    task_key: &Pubkey,
    bid_key: &Pubkey,
    task: &Task,
    bid_book_key: &Pubkey,
    bid_book: &TaskBidBook,
    selected_bid: &TaskBid,
    other_bid_accounts: &[AccountInfo<'info>],
    now: i64,
    min_agent_stake: u64,
    program_id: &Pubkey,
) -> Result<()> {
    validate_stored_matching_policy(bid_book)?;
    require!(
        (1..=MAX_ACTIVE_BIDS_PER_TASK).contains(&bid_book.active_bids),
        CoordinationError::BidBookEnumerationMismatch
    );
    let expected_other_bids = usize::from(
        bid_book
            .active_bids
            .checked_sub(1)
            .ok_or(CoordinationError::ArithmeticOverflow)?,
    );
    let expected_other_accounts = expected_other_bids
        .checked_mul(BID_COMPETITOR_ACCOUNT_STRIDE)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    require!(
        other_bid_accounts.len() == expected_other_accounts,
        CoordinationError::BidBookEnumerationMismatch
    );

    let mut best = bid_candidate(*bid_key, selected_bid, task, now, &bid_book.weights)?
        .ok_or(CoordinationError::BidDoesNotSatisfyMatchingPolicy)?;
    let mut seen = Vec::with_capacity(expected_other_bids.saturating_add(1));
    seen.push(*bid_key);
    let mut seen_bidders = Vec::with_capacity(expected_other_bids.saturating_add(1));
    seen_bidders.push(selected_bid.bidder);

    for pair in other_bid_accounts.chunks_exact(BID_COMPETITOR_ACCOUNT_STRIDE) {
        let bid_account = &pair[0];
        let bidder_account = &pair[1];
        require!(
            !seen.iter().any(|key| key == bid_account.key)
                && !seen_bidders.iter().any(|key| key == bidder_account.key),
            CoordinationError::BidBookEnumerationMismatch
        );
        let other_bid = validate_bid_account(bid_account, task_key, bid_book_key, program_id)?;
        let other_bidder = validate_bidder_account(
            bidder_account,
            &other_bid.bidder,
            &other_bid.bidder_authority,
            program_id,
        )?;
        let other_candidate =
            bid_candidate(*bid_account.key, &other_bid, task, now, &bid_book.weights)?;
        seen.push(*bid_account.key);
        seen_bidders.push(*bidder_account.key);
        if bidder_is_currently_eligible(
            bidder_account.key,
            &other_bidder,
            &other_bid,
            task,
            min_agent_stake,
        ) {
            if let Some(candidate) = other_candidate {
                if candidate_is_better(&candidate, &best, bid_book.policy) {
                    best = candidate;
                }
            }
        }
    }

    require!(
        best.key == *bid_key,
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
    // A dependent task consumes exactly one prefix account for its parent. Every
    // remaining account after that prefix must be an exact repeating
    // [competing TaskBid, matching AgentRegistration] pair.
    let dependency_account_count =
        usize::from(ctx.accounts.task.dependency_type != crate::state::DependencyType::None);
    require!(
        ctx.remaining_accounts.len() >= dependency_account_count,
        CoordinationError::ParentTaskAccountRequired
    );
    let (dependency_accounts, other_bid_accounts) =
        ctx.remaining_accounts.split_at(dependency_account_count);
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
    validate_matching_policy_selection(
        &task.key(),
        &bid.key(),
        task,
        &bid_book.key(),
        bid_book,
        bid,
        other_bid_accounts,
        now,
        config.min_agent_stake,
        ctx.program_id,
    )?;

    let expires_at = if task.deadline > 0 {
        task.deadline
            .checked_add(COMPLETION_BUFFER)
            .ok_or(CoordinationError::ArithmeticOverflow)?
    } else {
        now.checked_add(config.max_claim_duration)
            .ok_or(CoordinationError::ArithmeticOverflow)?
    };

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{moderation_block_status, ModerationBlock};

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

    fn leaked_account_info<T: AccountSerialize>(
        key: Pubkey,
        value: &T,
        size: usize,
        lamports: u64,
    ) -> AccountInfo<'static> {
        let mut data = Vec::new();
        value.try_serialize(&mut data).unwrap();
        data.resize(size, 0);
        AccountInfo::new(
            Box::leak(Box::new(key)),
            false,
            false,
            Box::leak(Box::new(lamports)),
            Box::leak(data.into_boxed_slice()),
            &crate::ID,
            false,
            0,
        )
    }

    fn competitor_pair(
        bid_key: Pubkey,
        bid: &TaskBid,
        bidder_key: Pubkey,
        bidder: &AgentRegistration,
    ) -> [AccountInfo<'static>; BID_COMPETITOR_ACCOUNT_STRIDE] {
        [
            leaked_account_info(bid_key, bid, TaskBid::SIZE, 1_000_000),
            leaked_account_info(bidder_key, bidder, AgentRegistration::SIZE, 1_000_000),
        ]
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
    fn competitor_agent_pair_rejects_identity_or_authority_substitution() {
        let agent_id = [41u8; 32];
        let authority = Pubkey::new_unique();
        let (agent_key, bump) = Pubkey::find_program_address(&[b"agent", &agent_id], &crate::ID);
        let agent = AgentRegistration {
            agent_id,
            authority,
            bump,
            ..AgentRegistration::default()
        };
        let account = leaked_account_info(agent_key, &agent, AgentRegistration::SIZE, 1_000_000);

        validate_bidder_account(&account, &agent_key, &authority, &crate::ID).unwrap();
        assert!(
            validate_bidder_account(&account, &Pubkey::new_unique(), &authority, &crate::ID,)
                .is_err()
        );
        assert!(
            validate_bidder_account(&account, &agent_key, &Pubkey::new_unique(), &crate::ID,)
                .is_err()
        );
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

    #[test]
    fn matching_requires_every_other_open_bid_and_rejects_a_better_bid() {
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

        let mut book = TaskBidBook {
            task: task_key,
            state: BidBookState::Open,
            policy: MatchingPolicy::BestPrice,
            weights: WeightedScoreWeights::default(),
            accepted_bid: None,
            version: 99,
            total_bids: 2,
            active_bids: 2,
            created_at: 1,
            updated_at: 1,
            bump: 0,
        };

        assert!(validate_matching_policy_selection(
            &task_key,
            &selected_key,
            &task,
            &bid_book_key,
            &book,
            &selected,
            &[],
            1_000,
            0,
            &crate::ID,
        )
        .is_err());

        let mut other = sample_bid(task_key, bid_book_key);
        let other_agent_id = [31u8; 32];
        let (other_bidder_key, other_bidder_bump) =
            Pubkey::find_program_address(&[b"agent", &other_agent_id], &crate::ID);
        let other_authority = Pubkey::new_unique();
        let mut other_bidder = AgentRegistration {
            agent_id: other_agent_id,
            authority: other_authority,
            capabilities: 1,
            status: AgentStatus::Active,
            reputation: 8_000,
            bump: other_bidder_bump,
            ..AgentRegistration::default()
        };
        other.bidder = other_bidder_key;
        other.bidder_authority = other_authority;
        other.requested_reward_lamports = 50_000;
        other.expires_at = 9_000;
        let (other_key, other_bump) = Pubkey::find_program_address(
            &[b"bid", task_key.as_ref(), other.bidder.as_ref()],
            &crate::ID,
        );
        other.bump = other_bump;
        let pair = competitor_pair(other_key, &other, other_bidder_key, &other_bidder);
        validate_matching_policy_selection(
            &task_key,
            &selected_key,
            &task,
            &bid_book_key,
            &book,
            &selected,
            &pair,
            1_000,
            0,
            &crate::ID,
        )
        .unwrap();

        other.requested_reward_lamports = 30_000;
        let pair = competitor_pair(other_key, &other, other_bidder_key, &other_bidder);
        assert!(validate_matching_policy_selection(
            &task_key,
            &selected_key,
            &task,
            &bid_book_key,
            &book,
            &selected,
            &pair,
            1_000,
            0,
            &crate::ID,
        )
        .is_err());

        other_bidder.status = AgentStatus::Inactive;
        let pair = competitor_pair(other_key, &other, other_bidder_key, &other_bidder);
        validate_matching_policy_selection(
            &task_key,
            &selected_key,
            &task,
            &bid_book_key,
            &book,
            &selected,
            &pair,
            1_000,
            0,
            &crate::ID,
        )
        .unwrap();

        other_bidder.status = AgentStatus::Active;
        other_bidder.stake = 99;
        let pair = competitor_pair(other_key, &other, other_bidder_key, &other_bidder);
        validate_matching_policy_selection(
            &task_key,
            &selected_key,
            &task,
            &bid_book_key,
            &book,
            &selected,
            &pair,
            1_000,
            100,
            &crate::ID,
        )
        .unwrap();
        assert!(validate_matching_policy_selection(
            &task_key,
            &selected_key,
            &task,
            &bid_book_key,
            &book,
            &selected,
            &pair,
            1_000,
            99,
            &crate::ID,
        )
        .is_err());

        book.active_bids = 1;
        validate_matching_policy_selection(
            &task_key,
            &selected_key,
            &task,
            &bid_book_key,
            &book,
            &selected,
            &[],
            1_000,
            0,
            &crate::ID,
        )
        .unwrap();
    }

    #[test]
    fn max_bid_book_pair_enumeration_stays_within_account_and_data_budget() {
        let task_key = Pubkey::new_unique();
        let bid_book_key = Pubkey::new_unique();
        let task = Task {
            creator: Pubkey::new_unique(),
            required_capabilities: 1,
            min_reputation: 5_000,
            reward_amount: 100_000,
            deadline: 10_000,
            ..Task::default()
        };

        let selected_key = Pubkey::new_unique();
        let mut selected = sample_bid(task_key, bid_book_key);
        selected.requested_reward_lamports = 100;
        selected.expires_at = 9_000;
        let book = TaskBidBook {
            task: task_key,
            state: BidBookState::Open,
            policy: MatchingPolicy::BestPrice,
            weights: WeightedScoreWeights::default(),
            accepted_bid: None,
            version: u64::MAX,
            total_bids: u32::from(MAX_ACTIVE_BIDS_PER_TASK),
            active_bids: MAX_ACTIVE_BIDS_PER_TASK,
            created_at: 1,
            updated_at: 1,
            bump: 0,
        };

        let mut remaining = Vec::with_capacity(
            usize::from(MAX_ACTIVE_BIDS_PER_TASK.saturating_sub(1)) * BID_COMPETITOR_ACCOUNT_STRIDE,
        );
        for marker in 1u8..MAX_ACTIVE_BIDS_PER_TASK as u8 {
            let agent_id = [marker; 32];
            let (bidder_key, bidder_bump) =
                Pubkey::find_program_address(&[b"agent", &agent_id], &crate::ID);
            let authority = Pubkey::new_from_array([marker.saturating_add(100); 32]);
            let bidder = AgentRegistration {
                agent_id,
                authority,
                capabilities: 1,
                status: AgentStatus::Active,
                reputation: 8_000,
                bump: bidder_bump,
                ..AgentRegistration::default()
            };
            let mut bid = sample_bid(task_key, bid_book_key);
            bid.bidder = bidder_key;
            bid.bidder_authority = authority;
            bid.requested_reward_lamports = 1_000 + u64::from(marker);
            bid.expires_at = 9_000;
            let (bid_key, bid_bump) = Pubkey::find_program_address(
                &[b"bid", task_key.as_ref(), bidder_key.as_ref()],
                &crate::ID,
            );
            bid.bump = bid_bump;
            remaining.push(leaked_account_info(bid_key, &bid, TaskBid::SIZE, 1_000_000));
            remaining.push(leaked_account_info(
                bidder_key,
                &bidder,
                AgentRegistration::SIZE,
                1_000_000,
            ));
        }

        validate_matching_policy_selection(
            &task_key,
            &selected_key,
            &task,
            &bid_book_key,
            &book,
            &selected,
            &remaining,
            1_000,
            0,
            &crate::ID,
        )
        .unwrap();
        assert_eq!(accept_bid_account_key_budget(20, true).unwrap(), 52);
        assert!(accept_bid_account_key_budget(20, true).unwrap() <= MAX_TRANSACTION_ACCOUNT_KEYS);
        assert!(
            usize::from(MAX_ACTIVE_BIDS_PER_TASK.saturating_sub(1))
                * (TaskBid::SIZE + AgentRegistration::SIZE)
                <= 16 * 1_024
        );
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
