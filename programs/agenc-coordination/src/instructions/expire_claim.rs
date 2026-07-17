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
    ensure_validation_config, is_manual_validation_task, saturating_dec_counter,
    sync_task_validation_status,
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

/// Audit F-4: the cleanup reward is paid from the escrow PDA's lamports. On token
/// tasks that PDA holds only its rent (the reward tokens live in the token escrow
/// ATA), so any debit breaks rent exemption and bricks expire_claim — skip the
/// reward there. Pure + revert-sensitive.
fn cleanup_reward_for_task(is_token_task: bool, remaining_funds: u64) -> u64 {
    if is_token_task {
        0
    } else {
        CLEANUP_REWARD.min(remaining_funds)
    }
}

/// Audit F-11: expire_claim must never fire while THIS claim has a live (Submitted)
/// submission. The evidence gate previously covered only the PendingValidation
/// branch, so an InProgress task whose claim somehow carried a live submission
/// could be expired out from under the worker's in-flight review. Unreachable
/// post-H-1; defense-in-depth against future status-machine edits. Pure +
/// revert-sensitive.
fn claim_is_expirable(status: TaskStatus, claim_has_pending_submission: bool) -> bool {
    matches!(status, TaskStatus::InProgress | TaskStatus::PendingValidation)
        && !claim_has_pending_submission
}

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

    /// The derived `["task_submission", claim]` PDA. The address is seeds-pinned
    /// (unfakeable), so what lives AT it is honest evidence: a live program-owned
    /// `TaskSubmission` is deserialized and inspected; a system-owned, zero-data
    /// account at this address PROVES no submission exists for this claim (the
    /// PDA was either never initialized — a no-show — or already closed by a
    /// settlement path that also closed the claim). This is what lets a no-show
    /// claim be expired during `PendingValidation` (another entrant's submission
    /// moved the task there) without reopening the caller-omission attack: the
    /// caller must still PASS the account, and cannot fake its contents.
    /// CHECK: seeds-pinned; owner/data inspected in the handler.
    #[account(
        seeds = [b"task_submission", claim.key().as_ref()],
        bump
    )]
    pub task_submission: Option<UncheckedAccount<'info>>,

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

    /// CHECK: the protocol treasury, validated against `protocol_config.treasury`.
    /// Receives the FORFEITED contest entry-deposit surplus on a no-show expiry
    /// (never the creator). Required whenever the expiring claim carries a
    /// contest deposit; enforced in the handler (non-skippable). Full-surface
    /// only — canary builds are contest-incapable (see
    /// `validate_task_supports_validation_mode`), so the frozen canary account
    /// list for `expire_claim` is unchanged.
    #[cfg(not(feature = "mainnet-canary"))]
    #[account(
        mut,
        constraint = treasury.key() == protocol_config.treasury @ CoordinationError::ContestForfeitTreasuryRequired
    )]
    pub treasury: Option<UncheckedAccount<'info>>,

    pub system_program: Program<'info, System>,
}

/// What the seeds-pinned `["task_submission", claim]` address proves.
enum SubmissionEvidence {
    /// The caller did not pass the account — nothing is proven.
    NotProvided,
    /// System-owned + zero-data at the derived address: no live submission
    /// exists for this claim (never initialized, or closed by settlement).
    Absent,
    /// A live program-owned `TaskSubmission` bound to this claim, with its status.
    Live(SubmissionStatus),
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
    // The `["task_submission", claim]` seed pins the supplied account to THIS
    // claim, so whatever lives at the derived address is honest evidence.
    // Trusting a caller-omitted optional account (the old `.unwrap_or(false)`)
    // let an attacker pass `task_submission = None`, read the guard as "no
    // pending submission", and close a claim that actually had live Submitted
    // work — permanently locking escrow. During `PendingValidation` the account
    // therefore MUST be supplied; but (fix round) a system-owned, zero-data
    // account at the derived address PROVES this claim never submitted — a
    // multi-entrant task (contest/Collaborative) sits in PendingValidation on
    // ANOTHER entrant's submission, and this claim's no-show must stay
    // expirable or it strands forever (current_workers > 0 bricks close_task,
    // and the worker's active_tasks slot leaks).
    let submission_evidence = match ctx.accounts.task_submission.as_ref() {
        None => SubmissionEvidence::NotProvided,
        Some(info) => {
            let info = info.to_account_info();
            if info.owner == &crate::ID {
                let data = info.try_borrow_data()?;
                let submission = TaskSubmission::try_deserialize(&mut &data[..])
                    .map_err(|_| error!(CoordinationError::TaskSubmissionRequired))?;
                // Seeds already pin the address; assert the stored back-references
                // anyway (defense in depth against any future seed drift).
                require!(
                    submission.claim == claim.key() && submission.task == task.key(),
                    CoordinationError::TaskSubmissionRequired
                );
                SubmissionEvidence::Live(submission.status)
            } else if info.owner == &anchor_lang::system_program::ID && info.data_is_empty() {
                SubmissionEvidence::Absent
            } else {
                return Err(CoordinationError::TaskSubmissionRequired.into());
            }
        }
    };
    let claim_has_pending_submission = match (task.status, &submission_evidence) {
        (TaskStatus::PendingValidation, SubmissionEvidence::NotProvided) => {
            return Err(CoordinationError::TaskSubmissionRequired.into());
        }
        (_, SubmissionEvidence::Live(status)) => *status == SubmissionStatus::Submitted,
        (_, _) => false,
    };
    require!(
        claim_is_expirable(task.status, claim_has_pending_submission),
        CoordinationError::TaskNotInProgress
    );
    #[cfg(not(feature = "mainnet-canary"))]
    let submission_proven_absent = matches!(submission_evidence, SubmissionEvidence::Absent);

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

    // Audit F-4: on token tasks the escrow PDA holds ONLY its rent — the reward
    // tokens live in the token escrow ATA — so debiting even 1000 lamports would
    // break rent exemption (runtime InsufficientFundsForRent) and brick
    // expire_claim for every token task. Skip the reward there (the crank pays for
    // itself with the tx fee) and never pollute the token-denominated `distributed`
    // counter with lamports.
    let reward = cleanup_reward_for_task(task.reward_mint.is_some(), remaining_funds);
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

    // Decrement task worker count. saturating (audit F-15): this is a recovery path —
    // a checked_sub underflow on a drifted legacy counter would itself brick it.
    task.current_workers = saturating_dec_counter(task.current_workers);

    // A pure no-show is a claim that expired without THIS worker ever submitting:
    // either an InProgress expiry (a live submission would have moved the task to
    // PendingValidation; the request_changes/Revisable edge still counts as a
    // missed deadline, matching pre-fix-round behavior), or (fix round) a
    // PendingValidation expiry whose derived submission PDA is PROVABLY absent —
    // the task is pending on another entrant's work, not this claim's. Capture it
    // BEFORE the status is mutated (the reopen below flips InProgress -> Open).
    #[cfg(not(feature = "mainnet-canary"))]
    let is_pure_noshow = task.status == TaskStatus::InProgress
        || (task.status == TaskStatus::PendingValidation && submission_proven_absent);

    // FIX 4 (anti-slop entry deposit): a contest-configured claim carries
    // CONTEST_ENTRY_DEPOSIT_LAMPORTS as surplus on the claim PDA. Reaching THIS
    // point on a contest claim means the worker never submitted (a Submitted
    // entry is blocked above; contests have no revision rounds, and every
    // settled entry closes its claim) — a no-show. The deposit is FORFEITED to
    // the protocol treasury, never the creator; the claim's own rent still
    // closes to the worker via `close = rent_recipient`. Non-skippable: the
    // absence proof AND the treasury account are both required, so a worker
    // self-expiring in the grace window cannot dodge the forfeit by omitting
    // accounts. Full-surface only: canary builds are contest-incapable by
    // construction, so no canary claim can ever carry a deposit.
    #[cfg(not(feature = "mainnet-canary"))]
    if crate::instructions::task_validation_helpers::is_contest_configured_task(task) {
        require!(
            submission_proven_absent,
            CoordinationError::TaskSubmissionRequired
        );
        let claim_info = claim.to_account_info();
        let rent_min = Rent::get()?.minimum_balance(claim_info.data_len());
        let surplus = claim_info.lamports().saturating_sub(rent_min);
        if surplus > 0 {
            let treasury = ctx
                .accounts
                .treasury
                .as_ref()
                .ok_or(CoordinationError::ContestForfeitTreasuryRequired)?;
            let treasury_info = treasury.to_account_info();
            **claim_info.try_borrow_mut_lamports()? = claim_info
                .lamports()
                .checked_sub(surplus)
                .ok_or(CoordinationError::ArithmeticOverflow)?;
            **treasury_info.try_borrow_mut_lamports()? = treasury_info
                .lamports()
                .checked_add(surplus)
                .ok_or(CoordinationError::ArithmeticOverflow)?;
            emit!(crate::events::ContestDepositForfeited {
                task: task.key(),
                claim: claim.key(),
                worker_agent: worker.key(),
                amount: surplus,
                timestamp: clock.unix_timestamp,
            });
        }
    }

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

    // Decrement worker active tasks. saturating (audit F-15): legacy counter drift
    // must not brick the designated un-bricking path.
    worker.active_tasks = saturating_dec_counter(worker.active_tasks);
    #[cfg(not(feature = "mainnet-canary"))]
    let worker_agent_key = worker.key();

    // P6.6: a pure no-show expiry folds into the worker agent's `claims_expired` track
    // record (no-op when the optional `agent_stats` account is absent). Telemetry only.
    // Only pure no-shows count — a PendingValidation expiry counts only when THIS
    // claim's submission PDA is provably absent (the task pends on another entrant's
    // work); a claim whose worker actually submitted is never charged.
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

#[cfg(test)]
mod tests {
    use super::*;

    // Audit F-4 (revert-sensitive): the cleanup reward must be skipped on token
    // tasks (the escrow PDA holds only rent — debiting it bricks expire_claim via
    // InsufficientFundsForRent). Reverting to an ungated CLEANUP_REWARD.min turns
    // the token-case assert red.
    #[test]
    fn cleanup_reward_is_zero_for_token_tasks() {
        assert_eq!(cleanup_reward_for_task(true, 1_000_000), 0);
        assert_eq!(cleanup_reward_for_task(false, 1_000_000), CLEANUP_REWARD);
        assert_eq!(cleanup_reward_for_task(false, 500), 500);
        assert_eq!(cleanup_reward_for_task(false, 0), 0);
    }

    // Audit F-11 (revert-sensitive): InProgress + live-Submitted must NOT be
    // expirable. Restoring the status-only gate turns the second assert red.
    #[test]
    fn in_progress_with_live_submission_is_not_expirable() {
        assert!(claim_is_expirable(TaskStatus::InProgress, false));
        assert!(!claim_is_expirable(TaskStatus::InProgress, true));
        assert!(claim_is_expirable(TaskStatus::PendingValidation, false));
        assert!(!claim_is_expirable(TaskStatus::PendingValidation, true));
        assert!(!claim_is_expirable(TaskStatus::Open, false));
        assert!(!claim_is_expirable(TaskStatus::Completed, false));
        assert!(!claim_is_expirable(TaskStatus::Cancelled, false));
    }
}
