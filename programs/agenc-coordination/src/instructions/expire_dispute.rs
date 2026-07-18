//! Expires a dispute after voting period ends.
//!
//! # Permissionless Design
//! This instruction can be called by anyone. This is intentional:
//! - Prevents disputes from being permanently stuck
//! - Allows third-party cleanup services
//! - No economic risk since only valid expirations succeed
//!
//! # Fair Refund Distribution (fix #418)
//! When a dispute expires, funds are distributed based on context:
//! - Worker completed + no votes: Worker gets 100% (did work, dispute not properly engaged)
//! - No completion + no votes: 50/50 split (neither party engaged arbiters)
//! - Some votes but insufficient quorum: Creator gets refund (dispute was contested)

use crate::errors::CoordinationError;
use crate::events::DisputeExpired;
use crate::instructions::bid_settlement_helpers::{
    settle_accepted_bid, AcceptedBidBondDisposition, AcceptedBidBookDisposition,
};
use crate::instructions::bond_helpers::{settle_completion_bond, BondDisposition};
use crate::instructions::dispute_helpers::{
    check_duplicate_workers, defendant_claim_required, expected_worker_pairs,
    pay_dispute_marketplace_legs, process_worker_claim_pair, resolve_task_marketplace_terms,
    sweep_dispute_submission, validate_remaining_accounts_structure, MarketplaceTerms,
};
use crate::instructions::lamport_transfer::transfer_lamports;
use crate::instructions::token_helpers::{
    close_token_escrow, transfer_tokens_from_escrow, validate_token_account,
    validate_unchecked_token_mint,
};
use crate::state::{
    AgentRegistration, CompletionBond, Dispute, DisputeStatus, ProtocolConfig, Task, TaskClaim,
    TaskEscrow, TaskStatus, TaskType, TaskValidationConfig,
};
use crate::utils::version::check_version_compatible_for_exit;
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

fn remaining_account_info<'info>(
    remaining_accounts: &[AccountInfo<'info>],
    index: usize,
) -> &'info AccountInfo<'info> {
    // SAFETY: `remaining_accounts` already stores `AccountInfo<'info>` values.
    // We only widen the reference itself back to `'info` for downstream helpers.
    unsafe { std::mem::transmute(&remaining_accounts[index]) }
}

fn remaining_account_slice<'info>(
    remaining_accounts: &[AccountInfo<'info>],
    start: usize,
    end: usize,
) -> &'info [AccountInfo<'info>] {
    // SAFETY: same rationale as `remaining_account_info`; the slice elements
    // already carry `'info`, so only the slice reference needs rebinding.
    unsafe { std::mem::transmute(&remaining_accounts[start..end]) }
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

    /// Worker's claim on the disputed task (fix #137)
    /// Optional - when provided, allows decrementing worker's active_tasks
    /// and enables fair refund distribution (fix #418)
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

    /// CHECK: Worker's wallet for receiving payment (fix #418)
    /// Required when worker should receive funds on expiration
    #[account(mut)]
    pub worker_wallet: Option<UncheckedAccount<'info>>,

    /// Hire link PDA (["hire", task]) — ALWAYS required so a hired task's operator fee
    /// cannot be bypassed when an expired dispute pays the worker. Live (program-owned)
    /// forces the operator leg; non-hired tasks pass the empty system-owned PDA.
    /// CHECK: live-vs-absent decided by `owner` in the handler; a live record is validated there.
    #[account(
        seeds = [b"hire", task.key().as_ref()],
        bump
    )]
    pub hire_record: UncheckedAccount<'info>,

    /// CHECK: operator payee — validated against the resolved marketplace terms (Task-first,
    /// HireRecord fallback); required only when those terms carry a non-zero operator fee
    /// and the worker is paid. Receives SOL.
    #[account(mut)]
    pub dispute_operator: Option<UncheckedAccount<'info>>,

    /// CHECK: referrer payee — validated against the resolved marketplace terms (P3.6 §3.3:
    /// dispute exits honor the snapshotted referrer leg); required only when those terms
    /// carry a non-zero referrer fee and the worker is paid. Receives SOL.
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

    /// Worker's token account for payment (optional)
    /// CHECK: Validated in handler
    #[account(mut)]
    pub worker_token_account_ata: Option<UncheckedAccount<'info>>,

    /// SPL token mint (optional, must match task.reward_mint)
    pub reward_mint: Option<Account<'info, Mint>>,

    /// SPL Token program (optional, required for token tasks)
    pub token_program: Option<Program<'info, Token>>,

    // === Batch 3 completion bonds (REQUIRED; both refunded on no-fault expiry) ===
    // Required, not optional: expire_dispute is PERMISSIONLESS and always Cancels the
    // task, so a posted bond is recoverable only here (reclaim_completion_bond needs a
    // Completed task). If the caller could omit a bond it would be stranded forever on
    // the Cancelled task. The caller passes the seeds-derived PDA even for an un-bonded
    // task; settle_completion_bond validates the canonical derivation and no-ops when no
    // live bond was posted (mirrors resolve_dispute / resolve_reject_frozen hardening).
    /// CHECK: creator completion bond PDA; refunded on expiry. Validated by helper.
    #[account(mut)]
    pub creator_completion_bond: UncheckedAccount<'info>,
    /// CHECK: worker completion bond PDA; refunded on expiry.
    #[account(mut)]
    pub worker_completion_bond: UncheckedAccount<'info>,

    /// OPTIONAL (audit F-9): the defendant's TaskSubmission to sweep on exit —
    /// decrements the review counters when still live and returns its rent to the
    /// worker authority. Validated + bound in the handler (`sweep_dispute_submission`).
    /// CHECK: seeds-pinned to the defendant claim; inspected in the handler.
    #[account(mut)]
    pub task_submission: Option<UncheckedAccount<'info>>,

    /// OPTIONAL (audit F-9): the task's TaskValidationConfig — required only when the
    /// swept submission is still live on a manual-validation task (pending-counter
    /// hygiene). Bound to the task in the handler.
    #[account(mut)]
    pub task_validation_config: Option<Box<Account<'info, TaskValidationConfig>>>,
}

/// Expires a dispute after voting period ends.
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

    // Fix #574: Allow expiration when EITHER expires_at OR voting_deadline has passed.
    // This closes the gap between voting_deadline and expires_at where disputes
    // could get stuck with funds locked if no one called resolve_dispute.
    //
    // Grace period: expire_dispute requires voting_deadline + 2 minutes, giving
    // resolve_dispute priority at the boundary. This prevents front-running attacks
    // where an attacker calls expire_dispute at exactly voting_deadline to get a
    // more favorable fund distribution than resolve_dispute would provide.
    const VOTING_DEADLINE_GRACE: i64 = 120;
    require!(
        clock.unix_timestamp > dispute.expires_at
            || clock.unix_timestamp
                >= dispute
                    .voting_deadline
                    .saturating_add(VOTING_DEADLINE_GRACE),
        CoordinationError::DisputeNotExpired
    );

    // Validate and bind defendant worker accounts (fix #842)
    validate_worker_accounts(
        dispute.as_ref(),
        &ctx.accounts.worker,
        &ctx.accounts.worker_claim,
        &ctx.accounts.worker_wallet,
        &task.key(),
        task.current_workers,
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
                remaining_account_slice(ctx.remaining_accounts, 0, split_at),
                Some((
                    remaining_account_info(ctx.remaining_accounts, split_at),
                    remaining_account_info(ctx.remaining_accounts, accepted_bid_index),
                    remaining_account_info(ctx.remaining_accounts, bidder_state_index),
                )),
            )
        } else {
            (ctx.remaining_accounts, None)
        };

    let remaining_funds = escrow
        .amount
        .checked_sub(escrow.distributed)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Track distribution for event emission (fix #418)
    let mut creator_amount: u64 = 0;
    let mut worker_amount: u64 = 0;

    // Fair refund distribution based on context (fix #418)
    let is_token_task = task.reward_mint.is_some();
    let task_key = task.key();
    // §4 marketplace legs (operator + referrer; Task-first, HireRecord fallback);
    // SOL-only path below.
    let expire_terms = resolve_task_marketplace_terms(
        task.operator,
        task.operator_fee_bps,
        task.referrer,
        task.referrer_fee_bps,
        &ctx.accounts.hire_record.to_account_info(),
        &task_key,
    )?;
    let worker_completed = ctx
        .accounts
        .worker_claim
        .as_ref()
        .ok_or(CoordinationError::WorkerClaimRequired)?
        .is_completed;
    let no_votes = dispute.total_voters == 0;

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
            validate_token_account(token_escrow, &mint.key(), &escrow.key())?;
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
            let creator_ta_info = ctx
                .accounts
                .creator_token_account
                .as_ref()
                .map(|a| a.to_account_info());
            let worker_ta_info = ctx
                .accounts
                .worker_token_account_ata
                .as_ref()
                .map(|a| a.to_account_info());

            // Validate destination token accounts before any escrow transfers.
            // This prevents permissionless expiration callers from redirecting payouts.
            match (no_votes, worker_completed) {
                (true, true) => {
                    let worker_ta = worker_ta_info
                        .as_ref()
                        .ok_or(CoordinationError::MissingTokenAccounts)?;
                    validate_unchecked_token_mint(
                        worker_ta,
                        &mint.key(),
                        &ctx.accounts
                            .worker_wallet
                            .as_ref()
                            .ok_or(CoordinationError::IncompleteWorkerAccounts)?
                            .key(),
                    )?;
                }
                (true, false) => {
                    let creator_ta = creator_ta_info
                        .as_ref()
                        .ok_or(CoordinationError::MissingTokenAccounts)?;
                    let worker_ta = worker_ta_info
                        .as_ref()
                        .ok_or(CoordinationError::MissingTokenAccounts)?;
                    validate_unchecked_token_mint(
                        creator_ta,
                        &mint.key(),
                        &ctx.accounts.creator.key(),
                    )?;
                    validate_unchecked_token_mint(
                        worker_ta,
                        &mint.key(),
                        &ctx.accounts
                            .worker_wallet
                            .as_ref()
                            .ok_or(CoordinationError::IncompleteWorkerAccounts)?
                            .key(),
                    )?;
                }
                (false, _) => {
                    let creator_ta = creator_ta_info
                        .as_ref()
                        .ok_or(CoordinationError::MissingTokenAccounts)?;
                    validate_unchecked_token_mint(
                        creator_ta,
                        &mint.key(),
                        &ctx.accounts.creator.key(),
                    )?;
                }
            }

            let (ca, wa) = distribute_expired_tokens(
                token_escrow,
                &escrow.to_account_info(),
                creator_ta_info.as_ref(),
                worker_ta_info.as_ref(),
                remaining_funds,
                worker_completed,
                no_votes,
                escrow_seeds,
                token_program,
            )?;
            creator_amount = ca;
            worker_amount = wa;

            // Sweep any unsolicited residual dust to the same class of recipient
            // used by this expiration branch, then close escrow ATA.
            let dust_destination_ta = match (no_votes, worker_completed) {
                (true, true) => worker_ta_info
                    .as_ref()
                    .ok_or(CoordinationError::MissingTokenAccounts)?,
                (true, false) => creator_ta_info
                    .as_ref()
                    .ok_or(CoordinationError::MissingTokenAccounts)?,
                (false, _) => creator_ta_info
                    .as_ref()
                    .ok_or(CoordinationError::MissingTokenAccounts)?,
            };
            let residual_amount = token_escrow_starting_amount
                .checked_sub(remaining_funds)
                .ok_or(CoordinationError::ArithmeticOverflow)?;

            // Close token escrow ATA
            close_token_escrow(
                token_escrow,
                residual_amount,
                dust_destination_ta,
                &ctx.accounts.creator.to_account_info(),
                &escrow.to_account_info(),
                escrow_seeds,
                token_program,
            )?;
        } else {
            let (ca, wa) = distribute_expired_funds(
                &escrow.to_account_info(),
                &ctx.accounts.creator.to_account_info(),
                &ctx.accounts
                    .worker_wallet
                    .as_ref()
                    .ok_or(CoordinationError::IncompleteWorkerAccounts)?
                    .to_account_info(),
                &expire_terms,
                ctx.accounts
                    .dispute_operator
                    .as_ref()
                    .map(|a| a.to_account_info()),
                ctx.accounts
                    .dispute_referrer
                    .as_ref()
                    .map(|a| a.to_account_info()),
                task.task_id,
                clock.unix_timestamp,
                remaining_funds,
                worker_completed,
                no_votes,
            )?;
            creator_amount = ca;
            worker_amount = wa;
        }
    }

    if let Some((bid_book_info, accepted_bid_info, bidder_market_state_info)) =
        accepted_bid_accounts
    {
        // Audit (2026-07 swarm): an expired dispute is UNRESOLVED — no fault was
        // established, so the accepted bid's bond is refunded, never slashed.
        // Previously the `no_votes` arm full-slashed it to the creator: a ghost
        // resolver turned a SUBMITTED worker's bond into the ghosting creator's
        // prize (the `worker_completed` Refund arm is unreachable — every
        // completing path closes the claim, so an open claim is never "completed").
        let bond_disposition = AcceptedBidBondDisposition::Refund;
        let worker_claim = ctx
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
        let creator_info = ctx.accounts.creator.to_account_info();

        settle_accepted_bid(
            &task_key,
            worker_claim.as_ref(),
            bid_book_info,
            accepted_bid_info,
            bidder_market_state_info,
            worker_wallet_info,
            Some(creator_info),
            clock.unix_timestamp,
            AcceptedBidBookDisposition::Close,
            bond_disposition,
        )?;
    }

    // Decrement defendant counters deterministically (fix #544, #842)
    let worker = ctx
        .accounts
        .worker
        .as_mut()
        .ok_or(CoordinationError::WorkerAgentRequired)?;
    worker.active_tasks = worker
        .active_tasks
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    worker.disputes_as_defendant = worker.disputes_as_defendant.saturating_sub(1);
    let defendant_worker_key = worker.key();

    // P6.3: the arbiter vote/quorum model is retired. A dispute never records a voter,
    // so there are NO (vote, arbiter) pairs to clean up and the `ArbiterVotesCleanedUp`
    // event is removed. `remaining_accounts` now carry ONLY the optional collaborative
    // (claim, worker) pairs; `validate_remaining_accounts_structure` asserts
    // `total_voters == 0` and pair-alignment.
    let arbiter_accounts =
        validate_remaining_accounts_structure(dispute_remaining_accounts, dispute.total_voters)?;

    let remaining_worker_accounts = dispute_remaining_accounts
        .len()
        .checked_sub(arbiter_accounts)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let worker_pairs = remaining_worker_accounts
        .checked_div(2)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    // saturating_sub (not checked_sub): 0 workers -> 0 expected pairs, never an underflow
    // that would lock the disputed escrow (#72). Identical to checked_sub for all N >= 1.
    let expected_worker_pairs = expected_worker_pairs(task.current_workers);
    require!(
        worker_pairs == expected_worker_pairs,
        CoordinationError::IncompleteWorkerAccounts
    );

    // Check for duplicate workers before processing (fix #826)
    check_duplicate_workers(
        dispute_remaining_accounts,
        arbiter_accounts,
        Some(defendant_worker_key),
    )?;

    // Process additional worker (claim, worker) pairs to decrement active_tasks (fix #333)
    for i in (arbiter_accounts..dispute_remaining_accounts.len()).step_by(2) {
        let worker_index = i
            .checked_add(1)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        process_worker_claim_pair(
            &dispute_remaining_accounts[i],
            &dispute_remaining_accounts[worker_index],
            &task.key(),
            &crate::ID,
        )?;
    }

    task.status = TaskStatus::Cancelled;
    task.current_workers = 0;
    dispute.status = DisputeStatus::Expired;
    dispute.resolved_at = clock.unix_timestamp;
    escrow.is_closed = true;

    // Close defendant claim account and return rent to worker wallet.
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
    claim.close(worker_wallet_info.clone())?;

    // Audit F-9: sweep the defendant's TaskSubmission when the caller supplies it —
    // decrement the review counters if it is still live and return its rent to the
    // worker authority, so neither the counters nor the rent strand on the terminal
    // task. Optional: when omitted, close_task remains the fallback sweep.
    if let Some(submission_info) = ctx.accounts.task_submission.as_ref() {
        sweep_dispute_submission(
            task,
            &task_key,
            &claim.key(),
            &defendant_worker_key,
            &worker_wallet_info,
            &submission_info.to_account_info(),
            ctx.accounts.task_validation_config.as_deref_mut(),
        )?;
    }

    // Batch 3 §8: a no-fault expiry refunds BOTH completion bonds. The bond accounts are
    // REQUIRED (see struct) so this permissionless exit cannot strand a posted bond on
    // the now-Cancelled task. Both are pinned to their canonical PDA: settle_completion_bond
    // no-ops on any non-program-owned account, so without this pin a caller could pass a
    // junk account to skip a refund and strand the real bond. An un-bonded task still
    // passes (correct address, no account → settle no-ops).
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
            BondDisposition::Refund,
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

fn validate_worker_accounts(
    dispute: &Dispute,
    worker: &Option<Box<Account<AgentRegistration>>>,
    worker_claim: &Option<Box<Account<TaskClaim>>>,
    worker_wallet: &Option<UncheckedAccount>,
    task_key: &Pubkey,
    current_workers: u8,
) -> Result<()> {
    // #72 tripwire: the defendant claim is required for EVERY worker count, including 0.
    // Do NOT relax this to `current_workers != 0` — see defendant_claim_required: it unlocks
    // no reachable escrow and adds fund-routing risk.
    require!(
        defendant_claim_required(current_workers),
        CoordinationError::WorkerClaimRequired
    );
    let worker = worker
        .as_ref()
        .ok_or(CoordinationError::WorkerAgentRequired)?;
    let worker_claim = worker_claim
        .as_ref()
        .ok_or(CoordinationError::WorkerClaimRequired)?;
    let worker_wallet = worker_wallet
        .as_ref()
        .ok_or(CoordinationError::IncompleteWorkerAccounts)?;

    require!(
        worker.key() == dispute.defendant,
        CoordinationError::WorkerNotInDispute
    );
    require!(
        worker.key() == worker_claim.worker,
        CoordinationError::UnauthorizedAgent
    );
    require!(
        worker_claim.task == *task_key,
        CoordinationError::NotClaimed
    );
    require!(
        worker_wallet.key() == worker.authority,
        CoordinationError::UnauthorizedAgent
    );

    Ok(())
}

/// Distributes remaining escrow funds on dispute expiration based on context (fix #418).
///
/// - Worker completed + no votes: Worker gets 100% (did work, dispute not properly engaged)
/// - No completion + no votes: 50/50 split (neither party engaged arbiters)
/// - Some votes but insufficient quorum: Creator gets refund (dispute was contested)
///
/// Returns (creator_amount, worker_amount) for event emission.
#[allow(clippy::too_many_arguments)]
fn distribute_expired_funds<'a>(
    escrow_info: &AccountInfo<'a>,
    creator_info: &AccountInfo<'a>,
    worker_wallet_info: &AccountInfo<'a>,
    terms: &MarketplaceTerms,
    operator: Option<AccountInfo<'a>>,
    referrer: Option<AccountInfo<'a>>,
    task_id: [u8; 32],
    now: i64,
    remaining_funds: u64,
    worker_completed: bool,
    no_votes: bool,
) -> Result<(u64, u64)> {
    let mut creator_amount: u64 = 0;
    let mut worker_amount: u64 = 0;

    if no_votes && worker_completed {
        // Worker gets 100% minus the marketplace legs (operator + referrer) so an
        // expired dispute cannot bypass the §4 split. No-op for non-hired,
        // unreferred tasks.
        let legs_fee = pay_dispute_marketplace_legs(
            terms,
            operator,
            referrer,
            escrow_info,
            remaining_funds,
            task_id,
            now,
        )?;
        worker_amount = remaining_funds
            .checked_sub(legs_fee)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        transfer_lamports(escrow_info, worker_wallet_info, worker_amount)?;
    } else {
        // Audit (2026-07 swarm): post-P6.3 the arbiter vote model is retired, so
        // `no_votes` is ALWAYS true and an expired dispute is an UNRESOLVED one —
        // the initiator's case was never adjudicated. The old "no votes -> 50/50"
        // arbiter-era fairness split paid HALF the escrow to a possibly zero-work
        // worker: a no-show could self-dispute, wait out the resolver window, and
        // steal 50% of any claimable escrow (and a ghost resolver flipped a
        // legitimate no-show slash into a payout). The only safe default for an
        // unproven dispute is a full refund to the funder — a worker who actually
        // delivered has the resolver/review window as their recourse, and a worker
        // who self-disputed gets nothing (their claim rent still returns below).
        creator_amount = remaining_funds;
        transfer_lamports(escrow_info, creator_info, remaining_funds)?;
    }

    Ok((creator_amount, worker_amount))
}

/// Token variant of distribute_expired_funds for SPL token tasks.
/// Same logic but uses token CPI transfers instead of lamport transfers.
///
/// Returns (creator_amount, worker_amount) for event emission.
fn distribute_expired_tokens<'a>(
    token_escrow: &mut Account<'a, TokenAccount>,
    escrow_authority: &AccountInfo<'a>,
    creator_token_account: Option<&AccountInfo<'a>>,
    worker_token_account: Option<&AccountInfo<'a>>,
    remaining_funds: u64,
    worker_completed: bool,
    no_votes: bool,
    escrow_seeds: &[&[u8]],
    token_program: &Program<'a, Token>,
) -> Result<(u64, u64)> {
    let mut creator_amount: u64 = 0;
    let mut worker_amount: u64 = 0;

    if no_votes && worker_completed {
        let worker_ta = worker_token_account.ok_or(CoordinationError::MissingTokenAccounts)?;
        worker_amount = remaining_funds;
        transfer_tokens_from_escrow(
            token_escrow,
            worker_ta,
            escrow_authority,
            remaining_funds,
            escrow_seeds,
            token_program,
        )?;
    } else {
        // Audit (2026-07 swarm): post-P6.3 an expired dispute is always UNRESOLVED
        // (no_votes is structurally true) — refund the funder in full, mirroring
        // the SOL path. Never split escrow to a possibly zero-work worker.
        let creator_ta = creator_token_account.ok_or(CoordinationError::MissingTokenAccounts)?;
        creator_amount = remaining_funds;
        transfer_tokens_from_escrow(
            token_escrow,
            creator_ta,
            escrow_authority,
            remaining_funds,
            escrow_seeds,
            token_program,
        )?;
    }

    Ok((creator_amount, worker_amount))
}
