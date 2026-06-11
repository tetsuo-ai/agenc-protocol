//! Expires a stale claim after its deadline passes.
//!
//! # Grace Period Protection (Issue #421)
//! To prevent griefing attacks where malicious actors race workers to expire
//! their claims exactly at timeout, a grace period is enforced:
//! - During the grace period (60 seconds after expiry), only the worker authority
//!   can call expire_claim on their own claim
//! - After the grace period, anyone can call expire_claim for cleanup
//!
//! This protects workers from MEV attacks and transaction reordering while
//! still allowing permissionless cleanup of truly abandoned claims.
//!
//! # Cleanup Reward
//! Callers receive a small reward (0.000001 SOL) from the task escrow
//! to incentivize timely cleanup of expired claims.

use crate::errors::CoordinationError;
#[cfg(not(feature = "mainnet-canary"))]
use crate::instructions::agent_stats_helpers::{apply_track_record, Counter};
#[cfg(not(feature = "mainnet-canary"))]
use crate::instructions::bid_settlement_helpers::{
    settle_accepted_bid, AcceptedBidBondDisposition, AcceptedBidBookDisposition,
};
#[cfg(not(feature = "mainnet-canary"))]
use crate::instructions::bond_helpers::{settle_completion_bond, BondDisposition};
use crate::instructions::lamport_transfer::transfer_lamports;
use crate::instructions::task_validation_helpers::{
    ensure_validation_config, is_manual_validation_task, sync_task_validation_status,
};
#[cfg(not(feature = "mainnet-canary"))]
use crate::state::AgentStats;
#[cfg(not(feature = "mainnet-canary"))]
use crate::state::CompletionBond;
use crate::state::{
    AgentRegistration, ProtocolConfig, SubmissionStatus, Task, TaskClaim, TaskEscrow, TaskStatus,
    TaskSubmission, TaskValidationConfig,
};
#[cfg(not(feature = "mainnet-canary"))]
use crate::state::{BidMarketplaceConfig, TaskType};
use crate::utils::version::check_version_compatible_for_exit;
use anchor_lang::prelude::*;

/// Small reward for calling expire_claim (0.000001 SOL)
/// Incentivizes third-party cleanup services
const CLEANUP_REWARD: u64 = 1000;

/// Grace period in seconds after claim expiry during which only the worker
/// authority can expire the claim. This prevents griefing attacks where
/// malicious actors race workers to expire their claims. (Issue #421)
const GRACE_PERIOD: i64 = 60;

#[cfg(not(feature = "mainnet-canary"))]
fn remaining_account_info<'info>(
    remaining_accounts: &[AccountInfo<'info>],
    index: usize,
) -> &'info AccountInfo<'info> {
    // SAFETY: the slice already stores `AccountInfo<'info>` values; we only
    // widen the reference itself back to `'info` for Anchor deserialization.
    unsafe { std::mem::transmute(&remaining_accounts[index]) }
}

#[derive(Accounts)]
pub struct ExpireClaim<'info> {
    /// Caller who triggers the expiration - receives cleanup reward
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        mut,
        seeds = [b"escrow", task.key().as_ref()],
        bump = escrow.bump,
        constraint = escrow.task == task.key() @ CoordinationError::InvalidInput
    )]
    pub escrow: Box<Account<'info, TaskEscrow>>,

    #[account(
        mut,
        close = rent_recipient,
        seeds = [b"claim", task.key().as_ref(), worker.key().as_ref()],
        bump = claim.bump,
        constraint = claim.task == task.key() @ CoordinationError::InvalidInput
    )]
    pub claim: Box<Account<'info, TaskClaim>>,

    #[account(
        mut,
        seeds = [b"agent", worker.agent_id.as_ref()],
        bump = worker.bump
    )]
    pub worker: Box<Account<'info, AgentRegistration>>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        seeds = [b"task_validation", task.key().as_ref()],
        bump = task_validation_config.bump
    )]
    pub task_validation_config: Option<Box<Account<'info, TaskValidationConfig>>>,

    #[account(
        seeds = [b"task_submission", claim.key().as_ref()],
        bump = task_submission.bump
    )]
    pub task_submission: Option<Box<Account<'info, TaskSubmission>>>,

    /// CHECK: Receives rent from closed claim account - validated to be worker authority
    #[account(
        mut,
        constraint = rent_recipient.key() == worker.authority @ CoordinationError::InvalidRentRecipient
    )]
    pub rent_recipient: UncheckedAccount<'info>,

    /// CHECK: the worker's completion bond PDA (Batch 3, optional). On a pure no-show
    /// (InProgress expiry) its principal is forfeited to the creator. Fully validated
    /// in the handler by settle_completion_bond (owner, PDA, task, role, party).
    #[account(mut)]
    pub worker_completion_bond: Option<UncheckedAccount<'info>>,

    /// CHECK: forfeit recipient for the worker bond; validated == task.creator.
    #[account(mut)]
    pub bond_creator: Option<UncheckedAccount<'info>>,

    /// OPTIONAL (P6.6): the worker agent's track-record aggregate. When supplied, a
    /// no-show expiry bumps `claims_expired`. Created lazily on first write, bound to
    /// `["agent_stats", worker]`. Full-surface only — gated so the frozen canary account
    /// list for `expire_claim` is unchanged. Paid by the (permissionless) caller.
    #[cfg(not(feature = "mainnet-canary"))]
    #[account(
        init_if_needed,
        payer = authority,
        space = AgentStats::SIZE,
        seeds = [b"agent_stats", worker.key().as_ref()],
        bump
    )]
    pub agent_stats: Option<Box<Account<'info, AgentStats>>>,

    pub system_program: Program<'info, System>,
}

/// Expires a stale claim after its deadline passes.
///
/// # Permissionless Design
/// This instruction can be called by anyone. This is intentional:
/// - Prevents claims from blocking task slots indefinitely
/// - Allows third-party cleanup services
/// - No economic risk since only valid expirations succeed
///
/// # Cleanup Reward
/// Callers receive a small reward from the task escrow to incentivize
/// timely cleanup of expired claims.
pub fn handler<'info>(ctx: Context<'_, '_, '_, 'info, ExpireClaim<'info>>) -> Result<()> {
    // Exit path: expiring a stale claim frees the slot and refunds the cleanup
    // caller; it must work even while the protocol is paused (money never locks,
    // spec §7). Type-disable gates entry only, so it is NOT re-checked here.
    check_version_compatible_for_exit(&ctx.accounts.protocol_config)?;
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::InvalidInput
    );

    let task = &mut ctx.accounts.task;
    let worker = &mut ctx.accounts.worker;
    let escrow = &mut ctx.accounts.escrow;
    let claim = &ctx.accounts.claim;
    let clock = Clock::get()?;

    // Can only expire incomplete claims
    require!(
        !claim.is_completed,
        CoordinationError::ClaimAlreadyCompleted
    );

    // Claims with expires_at = 0 are invalid (shouldn't exist)
    require!(claim.expires_at > 0, CoordinationError::InvalidExpiration);

    // Check claim has expired
    require!(
        clock.unix_timestamp > claim.expires_at,
        CoordinationError::ClaimNotExpired
    );

    // Claims involved in an active dispute must remain until dispute cleanup.
    // This prevents claim-state desynchronization with dispute bookkeeping.
    require!(
        task.status != TaskStatus::Disputed,
        CoordinationError::InvalidStatusTransition
    );
    // A PendingValidation task has a live `["task_submission", claim]` PDA by
    // construction (submit_task_result init's it and leaves the claim open). The
    // account MUST be supplied here so we can honestly evaluate whether the claim
    // still holds Submitted work. Trusting a caller-omitted optional account (the
    // old `.unwrap_or(false)`) let an attacker pass `task_submission = None`, read
    // the guard as "no pending submission", and close a claim that actually had
    // live Submitted work — permanently locking escrow (a closed claim leaves no
    // accept/reject/dispute settlement path on mainnet). The genuine no-show path
    // is `InProgress` with no submission PDA, which stays permitted via the `None`
    // arm. When supplied, the `["task_submission", claim]` seed already pins the
    // account to THIS claim, so a present submission is the canonical one.
    let claim_has_pending_submission = match (task.status, ctx.accounts.task_submission.as_ref()) {
        (TaskStatus::PendingValidation, None) => {
            return Err(CoordinationError::TaskSubmissionRequired.into());
        }
        (_, Some(submission)) => submission.status == SubmissionStatus::Submitted,
        (_, None) => false,
    };
    require!(
        task.status == TaskStatus::InProgress
            || (task.status == TaskStatus::PendingValidation && !claim_has_pending_submission),
        CoordinationError::TaskNotInProgress
    );

    // Grace period protection (Issue #421):
    // During the grace period after expiry, only the worker authority can expire
    // their own claim. This prevents griefing attacks where malicious actors race
    // workers to expire their claims exactly at timeout.
    let grace_period_ended = clock.unix_timestamp > claim.expires_at.saturating_add(GRACE_PERIOD);
    let is_worker_authority = ctx.accounts.authority.key() == worker.authority;

    require!(
        grace_period_ended || is_worker_authority,
        CoordinationError::GracePeriodNotPassed
    );

    // Transfer cleanup reward from escrow to caller (fix #531)
    let remaining_funds = escrow
        .amount
        .checked_sub(escrow.distributed)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    let reward = CLEANUP_REWARD.min(remaining_funds);
    if reward > 0 {
        transfer_lamports(
            &escrow.to_account_info(),
            &ctx.accounts.authority.to_account_info(),
            reward,
        )?;
        escrow.distributed = escrow
            .distributed
            .checked_add(reward)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
    }

    // Decrement task worker count
    task.current_workers = task
        .current_workers
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // A pure no-show is an InProgress claim that expired without a submission
    // (a submission would have moved the task to PendingValidation). Capture it
    // BEFORE the status is mutated (the reopen below flips InProgress -> Open).
    #[cfg(not(feature = "mainnet-canary"))]
    let is_pure_noshow = task.status == TaskStatus::InProgress;

    if is_manual_validation_task(task) {
        let validation_config = ctx
            .accounts
            .task_validation_config
            .as_ref()
            .ok_or(CoordinationError::TaskValidationConfigRequired)?;
        ensure_validation_config(validation_config, &task.key(), task)?;
        sync_task_validation_status(task, validation_config);
    } else if task.current_workers == 0 && task.status == TaskStatus::InProgress {
        // Reopen task if no workers left AND task is still in progress
        // (Don't reopen cancelled/completed/disputed tasks - prevents zombie task attack)
        task.status = TaskStatus::Open;
    }

    #[cfg(not(feature = "mainnet-canary"))]
    if task.task_type == TaskType::BidExclusive {
        require!(
            ctx.remaining_accounts.len() >= 5,
            CoordinationError::BidSettlementAccountsRequired
        );

        let bid_marketplace_info = remaining_account_info(ctx.remaining_accounts, 0);
        let bid_book_info = remaining_account_info(ctx.remaining_accounts, 1);
        let accepted_bid_info = remaining_account_info(ctx.remaining_accounts, 2);
        let bidder_market_state_info = remaining_account_info(ctx.remaining_accounts, 3);
        let creator_info = remaining_account_info(ctx.remaining_accounts, 4);

        require!(
            bid_marketplace_info.owner == &crate::ID,
            CoordinationError::InvalidAccountOwner
        );
        let bid_marketplace = Account::<BidMarketplaceConfig>::try_from(bid_marketplace_info)?;
        require!(
            creator_info.key() == task.creator,
            CoordinationError::InvalidCreator
        );
        let bidder_authority_info = ctx.accounts.rent_recipient.to_account_info();

        settle_accepted_bid(
            &task.key(),
            claim,
            bid_book_info,
            accepted_bid_info,
            bidder_market_state_info,
            bidder_authority_info,
            Some(creator_info.clone()),
            clock.unix_timestamp,
            AcceptedBidBookDisposition::Reopen,
            AcceptedBidBondDisposition::SlashByBpsToCreator(
                bid_marketplace.accepted_no_show_slash_bps,
            ),
        )?;
    }

    // Batch 3 §8: a pure no-show forfeits the worker's completion bond to the creator.
    // This is the case the dedicated-PDA design exists for — the claim closes to the
    // worker (auto-refunding their rent), but the bond lives in its own PDA so a
    // no-show worker does NOT get their bond back. Skip BidExclusive (it already
    // slashes a bid bond above — no double-charge).
    //
    // SECURITY (#71): the forfeit is NON-SKIPPABLE. The bond accounts cannot be made
    // required+seeds-fixed in the struct (`ExpireClaim` is shared with the canary
    // `expire_claim`, whose frozen account list carries them as OPTIONAL — see the
    // `agent_stats` cfg comment), so the "cannot be omitted" guarantee is enforced
    // HERE in the full-surface handler instead: on a pure no-show, REQUIRE the worker
    // bond account be present and equal to the canonical ["completion_bond", task,
    // worker_authority] PDA, and the creator recipient be present and == task.creator.
    // Without this, a worker self-expiring inside the grace window could OMIT the bond
    // accounts to dodge the forfeit, then re-claim the reopened task (the bond PDA is
    // keyed to [task, wallet], NOT the claim/epoch, so it survives) and reclaim the bond
    // on completion — denying the creator the no-show penalty (exploit chain #71).
    //
    // The check is STATELESS — it pins the canonical PDA via find_program_address, no
    // new Task/claim flag. settle_completion_bond is a safe no-op when that canonical
    // PDA holds no live bond, so an un-bonded no-show still expires cleanly (the required
    // account is the empty system-owned PDA → no-op), and a DIFFERENT worker expiring a
    // reopened task only ever pins THEIR OWN bond PDA (rent_recipient == their authority).
    //
    // SCOPED TO EXCLUSIVE: completion bonds can ONLY be posted on Exclusive tasks
    // (post_completion_bond requires task_type == Exclusive), so a Collaborative or
    // Competitive no-show can never have a worker bond. Gating on `== Exclusive` (NOT
    // merely `!= BidExclusive`) is load-bearing: the hard `require!(bond present)` below
    // would otherwise MissingCompletionBondAccount-FREEZE every Collaborative/Competitive
    // no-show, permanently stranding the slot. Do not re-widen this guard unless bonds
    // are also permitted on those task types.
    #[cfg(not(feature = "mainnet-canary"))]
    if is_pure_noshow && task.task_type == TaskType::Exclusive {
        // rent_recipient is constrained == worker.authority by the struct, so it is the
        // worker bond's `party` and the seed component of the canonical bond PDA.
        let worker_wallet_info = ctx.accounts.rent_recipient.to_account_info();
        let (expected_worker_bond, _) = Pubkey::find_program_address(
            &[
                b"completion_bond",
                task.key().as_ref(),
                worker_wallet_info.key().as_ref(),
            ],
            &crate::ID,
        );

        let bond = ctx
            .accounts
            .worker_completion_bond
            .as_ref()
            .ok_or(CoordinationError::MissingCompletionBondAccount)?;
        require!(
            bond.key() == expected_worker_bond,
            CoordinationError::MissingCompletionBondAccount
        );

        let creator = ctx
            .accounts
            .bond_creator
            .as_ref()
            .ok_or(CoordinationError::MissingCompletionBondAccount)?;
        require!(
            creator.key() == task.creator,
            CoordinationError::InvalidCreator
        );

        let creator_info = creator.to_account_info();
        // No-op when the canonical PDA holds no live bond (un-bonded task); forfeits the
        // principal to the creator and tombstones the PDA when a live worker bond exists,
        // so it can never be re-claimed after the task reopens (closes exploit #71).
        settle_completion_bond(
            &bond.to_account_info(),
            &worker_wallet_info,
            &task.key(),
            CompletionBond::ROLE_WORKER,
            BondDisposition::Forfeit {
                recipient: &creator_info,
            },
        )?;
    }

    // Decrement worker active tasks
    worker.active_tasks = worker
        .active_tasks
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    #[cfg(not(feature = "mainnet-canary"))]
    let worker_agent_key = worker.key();

    // P6.6: a pure no-show expiry folds into the worker agent's `claims_expired` track
    // record (no-op when the optional `agent_stats` account is absent). Telemetry only.
    // Only pure no-shows count — a PendingValidation expiry (work was submitted) is not a
    // no-show and must not be charged.
    #[cfg(not(feature = "mainnet-canary"))]
    if is_pure_noshow {
        apply_track_record(
            &mut ctx.accounts.agent_stats,
            worker_agent_key,
            ctx.bumps.agent_stats,
            Counter::ClaimsExpired,
            clock.unix_timestamp,
        )?;
    }

    Ok(())
}
