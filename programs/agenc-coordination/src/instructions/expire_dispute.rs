//! Expires an unresolved dispute after its resolver window closes.
//!
//! # Permissionless Design
//! This instruction can be called by anyone. This is intentional:
//! - Prevents disputes from being permanently stuck
//! - Allows third-party cleanup services
//! - No economic risk since only valid expirations succeed
//!
//! # Refund-on-expiry distribution (audit 2026-07 swarm, supersedes fix #418)
//! The arbiter vote model is retired. Expiry is therefore an UNRESOLVED outcome:
//! all remaining reward principal returns to the funder. Objective claim/submission
//! evidence may still penalize a true no-show's bonds, but never redirects principal.

use crate::errors::CoordinationError;
use crate::events::DisputeExpired;
use crate::instructions::bid_settlement_helpers::{
    accepted_bid_no_show_bond_disposition, settle_accepted_bid, AcceptedBidBookDisposition,
};
use crate::instructions::bond_helpers::{settle_completion_bond, BondDisposition};
use crate::instructions::dispute_helpers::{
    expected_peer_bundles, settle_dispute_submission_evidence, validate_dispute_worker_accounts,
};
use crate::instructions::lamport_transfer::transfer_lamports;
use crate::instructions::post_completion_bond::dependency_parent_completed;
use crate::instructions::program_account_helpers::{remaining_account_at, remaining_account_range};
use crate::instructions::token_helpers::{
    close_token_escrow, transfer_tokens_from_escrow, validate_token_escrow_account,
    validate_unchecked_token_mint,
};
use crate::state::{
    AgentRegistration, CompletionBond, DependencyType, Dispute, DisputeStatus, ProtocolConfig,
    Task, TaskClaim, TaskEscrow, TaskStatus, TaskType, TaskValidationConfig,
};
use crate::utils::version::check_version_compatible_for_exit;
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

/// A dispute expiry is allowed to carry a no-show penalty only when the same
/// objective evidence required by the ordinary claim-expiry path is present.
/// In particular, dispute initiation cannot shorten the worker's claim window,
/// and any live TaskSubmission protects the worker from confiscation.
fn expiry_no_show_penalty_allowed(
    claim_is_completed: bool,
    claim_expires_at: i64,
    now: i64,
    submission_was_live: bool,
    dependency_parent_completed: bool,
) -> bool {
    !claim_is_completed
        && claim_expires_at > 0
        && now > claim_expires_at
        && !submission_was_live
        && dependency_parent_completed
}

/// Note: Large accounts use Box<Account<...>> to avoid stack overflow
/// Consistent with Anchor best practices for accounts > 10KB
#[derive(Accounts)]
pub struct ExpireDispute<'info> {
    #[account(
        mut,
        seeds = [b"dispute", dispute.dispute_id.as_ref()],
        bump = dispute.bump
    )]
    pub dispute: Box<Account<'info, Dispute>>,

    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        constraint = dispute.task == task.key() @ CoordinationError::TaskNotFound
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        mut,
        close = creator,
        seeds = [b"escrow", task.key().as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Box<Account<'info, TaskEscrow>>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// CHECK: Task creator for refund - validated to match task.creator
    #[account(
        mut,
        constraint = creator.key() == task.creator @ CoordinationError::InvalidCreator
    )]
    pub creator: UncheckedAccount<'info>,

    pub authority: Signer<'info>,

    /// Worker's canonical claim on the disputed task.
    /// Retained as an optional ABI slot, but required by the handler on every expiry
    /// to bind the defendant and unwind the claim and worker counters.
    #[account(
        mut,
        seeds = [b"claim", task.key().as_ref(), worker_claim.worker.as_ref()],
        bump = worker_claim.bump,
        constraint = worker_claim.task == task.key() @ CoordinationError::NotClaimed
    )]
    pub worker_claim: Option<Box<Account<'info, TaskClaim>>>,

    /// Worker's AgentRegistration PDA (must be dispute defendant).
    #[account(mut)]
    pub worker: Option<Box<Account<'info, AgentRegistration>>>,

    /// CHECK: Worker's authority wallet, required by the handler on every expiry.
    /// Receives closed-account rent and any refundable worker bond, never unresolved
    /// task principal; validated against `worker.authority` before funds can move.
    #[account(mut)]
    pub worker_wallet: Option<UncheckedAccount<'info>>,

    /// CHECK: canonical legacy hire-link slot retained for ABI stability. Expiry
    /// never pays a marketplace leg; all unresolved principal returns to the creator.
    #[account(
        seeds = [b"hire", task.key().as_ref()],
        bump
    )]
    pub hire_record: UncheckedAccount<'info>,

    /// CHECK: legacy optional operator slot retained for ABI stability; ignored on expiry.
    #[account(mut)]
    pub dispute_operator: Option<UncheckedAccount<'info>>,

    /// CHECK: legacy optional referrer slot retained for ABI stability; ignored on expiry.
    #[account(mut)]
    pub dispute_referrer: Option<UncheckedAccount<'info>>,

    // === Optional SPL Token accounts (only required for token-denominated tasks) ===
    /// Token escrow ATA holding reward tokens (optional)
    #[account(mut)]
    pub token_escrow_ata: Option<Account<'info, TokenAccount>>,

    /// Creator's token account for refund (optional)
    /// CHECK: Validated in handler
    #[account(mut)]
    pub creator_token_account: Option<UncheckedAccount<'info>>,

    /// CHECK: legacy worker-token slot retained for ABI stability; ignored on expiry.
    #[account(mut)]
    pub worker_token_account_ata: Option<UncheckedAccount<'info>>,

    /// SPL token mint (optional, must match task.reward_mint)
    pub reward_mint: Option<Account<'info, Mint>>,

    /// SPL Token program (optional, required for token tasks)
    pub token_program: Option<Program<'info, Token>>,

    // === Batch 3 completion bonds (REQUIRED; evidence-bound on expiry) ===
    // Required, not optional: expire_dispute is PERMISSIONLESS and always Cancels the
    // task, so a posted bond is recoverable only here (reclaim_completion_bond needs a
    // Completed task). If the caller could omit a bond it would be stranded forever on
    // the Cancelled task. The caller passes the seeds-derived PDA even for an un-bonded
    // task; settle_completion_bond validates the canonical derivation and no-ops when no
    // live bond was posted (mirrors resolve_dispute / resolve_reject_frozen hardening).
    /// CHECK: creator completion bond PDA; always refunded on expiry. Validated by helper.
    #[account(mut)]
    pub creator_completion_bond: UncheckedAccount<'info>,
    /// CHECK: worker completion bond PDA; refunded unless canonical evidence proves no-show.
    #[account(mut)]
    pub worker_completion_bond: UncheckedAccount<'info>,

    /// REQUIRED-EVIDENCE ON THE OPTIONAL WIRE (audit F-9): callers pass the
    /// canonical TaskSubmission PDA for the defendant claim. A live record is
    /// swept before claim close; the exact system-owned empty PDA proves absence.
    /// `Option` preserves the deployed account list, but `None` fails closed.
    /// CHECK: seeds-pinned to the defendant claim and inspected in the handler.
    #[account(mut)]
    pub task_submission: Option<UncheckedAccount<'info>>,

    /// OPTIONAL: canonical TaskValidationConfig, required when the swept manual
    /// submission is still Submitted and therefore carries counter debt.
    #[account(
        mut,
        seeds = [b"task_validation", task.key().as_ref()],
        bump = task_validation_config.bump
    )]
    pub task_validation_config: Option<Box<Account<'info, TaskValidationConfig>>>,
}

/// Expires a dispute after its direct-resolver window closes.
///
/// # Permissionless Design
/// This instruction can be called by anyone. This is intentional:
/// - Prevents disputes from being permanently stuck
/// - Allows third-party cleanup services
/// - No economic risk since only valid expirations succeed
pub fn handler<'info>(ctx: Context<'_, '_, '_, 'info, ExpireDispute<'info>>) -> Result<()> {
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::InvalidInput
    );

    let dispute = &mut ctx.accounts.dispute;
    let task = &mut ctx.accounts.task;
    let escrow = &mut ctx.accounts.escrow;
    let config = &ctx.accounts.protocol_config;
    let clock = Clock::get()?;

    // Exit path: expiring a stale dispute releases escrowed funds to the
    // default winner; it must work even while the protocol is paused (money
    // never locks, spec §7). Type-disable gates entry only, so it is NOT
    // re-checked here.
    check_version_compatible_for_exit(config)?;
    require!(
        dispute.status == DisputeStatus::Active,
        CoordinationError::DisputeNotActive
    );

    // Validate task is in disputed state and transition is allowed (fix #538)
    require!(
        task.status == TaskStatus::Disputed,
        CoordinationError::TaskNotInProgress
    );
    require!(
        task.status.can_transition_to(TaskStatus::Cancelled),
        CoordinationError::InvalidStatusTransition
    );

    // The legacy `voting_deadline` field is now the first resolver-action
    // deadline. Permissionless expiry opens after that deadline plus a two-minute
    // grace period, or immediately after the hard `expires_at` boundary. The
    // complementary predicates in `Dispute` give resolution and expiry disjoint
    // windows, so escrow has neither an overlap race nor a liveness gap.
    require!(
        dispute.expiry_window_open(clock.unix_timestamp),
        CoordinationError::DisputeNotExpired
    );

    // Validate and bind defendant worker accounts (fix #842)
    validate_dispute_worker_accounts(
        dispute.as_ref(),
        &ctx.accounts.worker,
        &ctx.accounts.worker_claim,
        &ctx.accounts.worker_wallet,
        &task.key(),
    )?;

    let (dispute_remaining_accounts, accepted_bid_accounts) =
        if task.task_type == TaskType::BidExclusive {
            require!(
                ctx.remaining_accounts.len() >= 3,
                CoordinationError::BidSettlementAccountsRequired
            );
            let split_at = ctx
                .remaining_accounts
                .len()
                .checked_sub(3)
                .ok_or(CoordinationError::ArithmeticOverflow)?;
            let accepted_bid_index = split_at
                .checked_add(1)
                .ok_or(CoordinationError::ArithmeticOverflow)?;
            let bidder_state_index = split_at
                .checked_add(2)
                .ok_or(CoordinationError::ArithmeticOverflow)?;
            (
                remaining_account_range(
                    ctx.remaining_accounts,
                    0..split_at,
                    CoordinationError::BidSettlementAccountsRequired,
                )?,
                Some((
                    remaining_account_at(
                        ctx.remaining_accounts,
                        split_at,
                        CoordinationError::BidSettlementAccountsRequired,
                    )?,
                    remaining_account_at(
                        ctx.remaining_accounts,
                        accepted_bid_index,
                        CoordinationError::BidSettlementAccountsRequired,
                    )?,
                    remaining_account_at(
                        ctx.remaining_accounts,
                        bidder_state_index,
                        CoordinationError::BidSettlementAccountsRequired,
                    )?,
                )),
            )
        } else {
            (ctx.remaining_accounts, None)
        };

    let remaining_funds = escrow
        .amount
        .checked_sub(escrow.distributed)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Expiry is an unresolved outcome. The retired vote instruction cannot
    // authorize a worker payout, so return every remaining reward unit to the
    // funder. Worker fault is handled separately through objective no-show bond
    // evidence below; it must never redirect task principal.
    let creator_amount = remaining_funds;
    let worker_amount = 0;
    let is_token_task = task.reward_mint.is_some();
    let task_key = task.key();
    dispute.initiator_outcome_counter_tracked()?;

    // A dependent task always supplies its canonical parent at slot 0. The
    // parent state controls only evidence-bound no-show penalties, never the
    // creator's ability to recover principal.
    let dependency_parent_completed =
        dependency_parent_completed(task.as_ref(), dispute_remaining_accounts, ctx.program_id)?;
    let dependency_parent_prefix = usize::from(task.dependency_type != DependencyType::None);
    let dispute_worker_accounts = remaining_account_range(
        dispute_remaining_accounts,
        dependency_parent_prefix..dispute_remaining_accounts.len(),
        CoordinationError::InvalidInput,
    )?;

    if remaining_funds > 0 {
        if is_token_task {
            require!(
                ctx.accounts.token_escrow_ata.is_some()
                    && ctx.accounts.reward_mint.is_some()
                    && ctx.accounts.token_program.is_some(),
                CoordinationError::MissingTokenAccounts
            );
            let mint = ctx
                .accounts
                .reward_mint
                .as_ref()
                .ok_or(CoordinationError::MissingTokenAccounts)?;
            let expected_mint = task
                .reward_mint
                .ok_or(CoordinationError::InvalidTokenMint)?;
            require!(
                mint.key() == expected_mint,
                CoordinationError::InvalidTokenMint
            );
            let token_escrow = ctx
                .accounts
                .token_escrow_ata
                .as_mut()
                .ok_or(CoordinationError::MissingTokenAccounts)?;
            validate_token_escrow_account(
                &token_escrow.to_account_info(),
                &mint.key(),
                &escrow.key(),
            )?;
            let token_escrow_starting_amount =
                anchor_spl::token::accessor::amount(&token_escrow.to_account_info())
                    .map_err(|_| CoordinationError::TokenTransferFailed)?;
            let token_program = ctx
                .accounts
                .token_program
                .as_ref()
                .ok_or(CoordinationError::MissingTokenAccounts)?;
            let task_key_bytes = task_key.to_bytes();
            let bump_slice = [escrow.bump];
            let escrow_seeds: &[&[u8]] = &[b"escrow", task_key_bytes.as_ref(), &bump_slice];
            let creator_ta = ctx
                .accounts
                .creator_token_account
                .as_ref()
                .ok_or(CoordinationError::MissingTokenAccounts)?
                .to_account_info();
            validate_unchecked_token_mint(&creator_ta, &mint.key(), &ctx.accounts.creator.key())?;
            transfer_tokens_from_escrow(
                token_escrow,
                &creator_ta,
                &escrow.to_account_info(),
                remaining_funds,
                escrow_seeds,
                token_program,
            )?;

            // Unsolicited residual dust follows principal back to the creator.
            let residual_amount = token_escrow_starting_amount
                .checked_sub(remaining_funds)
                .ok_or(CoordinationError::ArithmeticOverflow)?;
            close_token_escrow(
                token_escrow,
                residual_amount,
                &creator_ta,
                &ctx.accounts.creator.to_account_info(),
                &escrow.to_account_info(),
                escrow_seeds,
                token_program,
            )?;
        } else {
            transfer_lamports(
                &escrow.to_account_info(),
                &ctx.accounts.creator.to_account_info(),
                remaining_funds,
            )?;
        }
    }

    // Decrement defendant counters deterministically (fix #544, #842)
    let worker = ctx
        .accounts
        .worker
        .as_mut()
        .ok_or(CoordinationError::WorkerAgentRequired)?;
    // Saturating (F-15 consistency): a legacy drifted counter must not brick the
    // designated un-bricking exit — every other decrement of this counter
    // (dispute_helpers::process_worker_claim_bundle, the multi-worker loop below)
    // already saturates.
    worker.active_tasks = worker.active_tasks.saturating_sub(1);
    worker.disputes_as_defendant = worker.disputes_as_defendant.saturating_sub(1);
    let defendant_worker_key = worker.key();

    // P6.3: the arbiter vote/quorum model is retired. A dispute never records a voter,
    // so there are NO (vote, arbiter) pairs to clean up. Each additional collaborative
    // worker supplies a canonical `(claim, worker, task_submission)` bundle. The
    // submission meta is non-skippable evidence: live records are swept before claim
    // close; the exact empty PDA proves absence.
    // Chunked settlement: expiry is O(1) in accounts. Additional collaborative
    // workers are swept by the permissionless `settle_dispute_claim` crank —
    // any peer account presented here is rejected outright.
    require!(
        dispute_worker_accounts.is_empty(),
        CoordinationError::DisputePeerBundlesRetired
    );
    let deferred_peers = u8::try_from(expected_peer_bundles(task.current_workers))
        .map_err(|_| CoordinationError::ArithmeticOverflow)?;

    task.status = TaskStatus::Cancelled;
    task.current_workers = deferred_peers;
    if deferred_peers == 0 {
        dispute.status = DisputeStatus::Expired;
    } else {
        dispute.status = DisputeStatus::SettlementPending;
        dispute.pending_terminal_status = DisputeStatus::Expired as u8;
    }
    dispute.peer_workers_total = deferred_peers;
    dispute.peer_workers_settled = 0;
    dispute.resolved_at = clock.unix_timestamp;
    escrow.is_closed = true;

    // Bind the defendant claim + wallet once for mandatory submission cleanup
    // and the subsequent claim-rent return.
    let claim = ctx
        .accounts
        .worker_claim
        .as_ref()
        .ok_or(CoordinationError::WorkerClaimRequired)?;
    let worker_wallet = ctx
        .accounts
        .worker_wallet
        .as_ref()
        .ok_or(CoordinationError::IncompleteWorkerAccounts)?;
    let worker_wallet_info = worker_wallet.to_account_info();

    // Audit F-9 follow-up: a permissionless expirer cannot omit a live
    // TaskSubmission and strand its rent/counter debt on the terminal task. The
    // canonical account is required as evidence: live records are swept; the
    // exact empty system-owned PDA proves absence. Cleanup precedes claim close.
    let submission_was_live = settle_dispute_submission_evidence(
        task,
        &task_key,
        &claim.key(),
        &defendant_worker_key,
        &worker_wallet_info,
        ctx.accounts.task_submission.as_ref().map(AsRef::as_ref),
        ctx.accounts.task_validation_config.as_deref_mut(),
        ctx.program_id,
    )?;

    // D16: creator-initiated disputes previously laundered a true no-show through
    // the no-fault expiry branch: expire_claim/cancel would slash the worker, but
    // expire_dispute refunded every bond. Use only objective on-chain evidence.
    // A creator cannot confiscate before the claim window ends, a live submission
    // always forces a refund, and an unmet/closed dependency is creator-side
    // availability failure rather than worker fault.
    let no_show_penalty_allowed = expiry_no_show_penalty_allowed(
        claim.is_completed,
        claim.expires_at,
        clock.unix_timestamp,
        submission_was_live,
        dependency_parent_completed,
    );

    if let Some((bid_book_info, accepted_bid_info, bidder_market_state_info)) =
        accepted_bid_accounts
    {
        let bond_disposition = accepted_bid_no_show_bond_disposition(no_show_penalty_allowed);
        let creator_info = ctx.accounts.creator.to_account_info();

        settle_accepted_bid(
            &task_key,
            claim.as_ref(),
            bid_book_info,
            accepted_bid_info,
            bidder_market_state_info,
            worker_wallet_info.clone(),
            Some(creator_info),
            clock.unix_timestamp,
            AcceptedBidBookDisposition::Close,
            bond_disposition,
        )?;
    }

    claim.close(worker_wallet_info.clone())?;

    // Completion-bond accounts remain mandatory so a permissionless terminal exit
    // cannot strand them. The creator always receives a no-fault refund. The worker
    // is forfeited only for the exact same evidence-bound no-show classification
    // used above; completion bonds are supported only for Exclusive tasks.
    {
        let creator_info = ctx.accounts.creator.to_account_info();
        let (expected_creator_bond, _) = Pubkey::find_program_address(
            &[
                b"completion_bond",
                task_key.as_ref(),
                ctx.accounts.creator.key().as_ref(),
            ],
            &crate::ID,
        );
        require!(
            ctx.accounts.creator_completion_bond.key() == expected_creator_bond,
            CoordinationError::MissingCompletionBondAccount
        );
        let (expected_worker_bond, _) = Pubkey::find_program_address(
            &[
                b"completion_bond",
                task_key.as_ref(),
                worker_wallet_info.key().as_ref(),
            ],
            &crate::ID,
        );
        require!(
            ctx.accounts.worker_completion_bond.key() == expected_worker_bond,
            CoordinationError::MissingCompletionBondAccount
        );
        settle_completion_bond(
            &ctx.accounts.creator_completion_bond.to_account_info(),
            &creator_info,
            &task_key,
            CompletionBond::ROLE_CREATOR,
            BondDisposition::Refund,
        )?;
        settle_completion_bond(
            &ctx.accounts.worker_completion_bond.to_account_info(),
            &worker_wallet_info,
            &task_key,
            CompletionBond::ROLE_WORKER,
            if task.task_type == TaskType::Exclusive && no_show_penalty_allowed {
                BondDisposition::Forfeit {
                    recipient: &creator_info,
                }
            } else {
                BondDisposition::Refund
            },
        )?;
    }

    emit!(DisputeExpired {
        dispute_id: dispute.dispute_id,
        task_id: task.task_id,
        refund_amount: remaining_funds,
        creator_amount,
        worker_amount,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instructions::bid_settlement_helpers::AcceptedBidBondDisposition;

    #[test]
    fn expiry_no_show_penalty_requires_expired_incomplete_claim_and_absence() {
        let expires_at = 1_000;

        assert!(expiry_no_show_penalty_allowed(
            false,
            expires_at,
            expires_at + 1,
            false,
            true,
        ));
        assert!(!expiry_no_show_penalty_allowed(
            false, expires_at, expires_at, false, true,
        ));
        assert!(!expiry_no_show_penalty_allowed(
            false,
            expires_at,
            expires_at - 1,
            false,
            true,
        ));
        assert!(!expiry_no_show_penalty_allowed(
            true,
            expires_at,
            expires_at + 1,
            false,
            true,
        ));
        assert!(!expiry_no_show_penalty_allowed(
            false,
            0,
            expires_at + 1,
            false,
            true,
        ));
    }

    #[test]
    fn any_live_submission_forces_bond_refund() {
        let allowed = expiry_no_show_penalty_allowed(false, 1_000, 2_000, true, true);
        assert!(!allowed);
        assert_eq!(
            accepted_bid_no_show_bond_disposition(allowed),
            AcceptedBidBondDisposition::Refund,
        );
    }

    #[test]
    fn expired_absent_non_dependent_claim_uses_snapshotted_bid_slash() {
        let task = Task::default();
        let parent_completed = dependency_parent_completed(&task, &[], &crate::ID).unwrap();
        let allowed = expiry_no_show_penalty_allowed(false, 1_000, 1_001, false, parent_completed);

        assert!(allowed);
        assert_eq!(
            accepted_bid_no_show_bond_disposition(allowed),
            AcceptedBidBondDisposition::SnapshottedNoShowSlashToCreator,
        );
    }

    #[test]
    fn dependent_no_show_refunds_when_parent_is_not_completed() {
        assert!(!expiry_no_show_penalty_allowed(
            false, 1_000, 1_001, false, false,
        ));
    }

    #[test]
    fn dependent_expiry_rejects_missing_or_substituted_parent_evidence() {
        let parent_key = Pubkey::new_unique();
        let child = Task {
            depends_on: Some(parent_key),
            dependency_type: DependencyType::Data,
            ..Task::default()
        };

        assert!(dependency_parent_completed(&child, &[], &crate::ID).is_err());

        let substituted_key = Pubkey::new_unique();
        let system_owner = anchor_lang::system_program::ID;
        let mut lamports = 0;
        let mut data = [];
        let substituted = AccountInfo::new(
            &substituted_key,
            false,
            false,
            &mut lamports,
            &mut data,
            &system_owner,
            false,
            0,
        );
        assert!(dependency_parent_completed(&child, &[substituted], &crate::ID).is_err());

        let mut closed_parent_lamports = 0;
        let mut closed_parent_data = [];
        let closed_parent = AccountInfo::new(
            &parent_key,
            false,
            false,
            &mut closed_parent_lamports,
            &mut closed_parent_data,
            &system_owner,
            false,
            0,
        );
        assert!(!dependency_parent_completed(&child, &[closed_parent], &crate::ID).unwrap());
    }
}
