//! Resolve a dispute and execute the outcome

use crate::errors::CoordinationError;
use crate::events::{dispute_outcome, DisputeResolved};
use crate::instructions::agent_stats_helpers::{apply_track_record, Counter};
use crate::instructions::bid_settlement_helpers::{
    settle_accepted_bid, AcceptedBidBondDisposition, AcceptedBidBookDisposition,
};
use crate::instructions::bond_helpers::{settle_completion_bond, BondDisposition};
use crate::instructions::completion_helpers::update_protocol_stats;
use crate::instructions::constants::PERCENT_BASE;
use crate::instructions::dispute_helpers::{
    check_duplicate_workers, defendant_claim_required, expected_worker_pairs,
    pay_dispute_marketplace_legs, process_worker_claim_pair, resolve_task_marketplace_terms,
    sweep_dispute_submission, validate_remaining_accounts_structure,
};
use crate::instructions::lamport_transfer::{credit_lamports, debit_lamports, transfer_lamports};
use crate::instructions::slash_helpers::calculate_slash_amount;
use crate::instructions::token_helpers::{
    close_token_escrow, transfer_tokens_from_escrow, validate_token_account,
    validate_unchecked_token_mint,
};
use crate::state::{
    AgentRegistration, AgentStats, CompletionBond, Dispute, DisputeResolver, DisputeStatus,
    ProtocolConfig, ResolutionType, Task, TaskClaim, TaskEscrow, TaskStatus, TaskType,
    TaskValidationConfig,
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

/// Pure bound check on the ruling `rationale_uri` (P6.4). Empty is allowed (the
/// 32-byte `rationale_hash` may carry the rationale on its own); anything longer than
/// the account reserve is rejected. Extracted so the bound is unit-testable and
/// revert-sensitive independently of account wiring.
pub(crate) fn validate_rationale_uri(rationale_uri: &str) -> Result<()> {
    require!(
        rationale_uri.len() <= Dispute::MAX_RATIONALE_URI_LEN,
        CoordinationError::RationaleUriTooLong
    );
    Ok(())
}

/// Pure (P6.3): encode the resolver's binary ruling into the `(votes_for, votes_against)`
/// pair that the slash finalizers read. Returns `(1, 0)` on APPROVE and `(0, 1)` on
/// REJECT. The arbiter vote/quorum model is retired, so this 1-bit record replaces the
/// real tally; `apply_dispute_slash` / `apply_initiator_slash` recover the decision via
/// `calculate_approval_percentage` against `dispute_threshold` (default 50): 100% >= 50
/// (approved) vs 0% < 50 (rejected). Extracted so the encoding is unit-testable and
/// revert-sensitive (flip a branch and the slash-direction test goes red).
pub(crate) fn ruling_vote_bits(approved: bool) -> (u64, u64) {
    if approved {
        (1, 0)
    } else {
        (0, 1)
    }
}

/// Pure, checked bump of an assigned resolver's case counters (P6.4): increments
/// `resolved_count` and stamps `last_resolved_at`. `overturned_count` is intentionally
/// untouched here — it is only moved by the (design-doc-only) challenge-window
/// mechanism. Extracted so the increment is unit-testable and revert-sensitive (drop
/// the `checked_add` and the overflow test goes red; drop the call site and the
/// integration assertion `resolved_count == 1` goes red).
pub(crate) fn bump_resolver_case_counters(
    resolver_entry: &mut DisputeResolver,
    now: i64,
) -> Result<u64> {
    resolver_entry.resolved_count = resolver_entry
        .resolved_count
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    resolver_entry.last_resolved_at = now;
    Ok(resolver_entry.resolved_count)
}

/// Note: Large accounts use Box<Account<...>> to avoid stack overflow
/// Consistent with Anchor best practices for accounts > 10KB
#[derive(Accounts)]
pub struct ResolveDispute<'info> {
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
        seeds = [b"escrow", task.key().as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Box<Account<'info, TaskEscrow>>,

    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// The resolver: EITHER the protocol authority OR a wallet on the dispute-resolver
    /// roster. The OR is enforced in the handler against `resolver_assignment` below — a
    /// plain account constraint cannot express "this key OR that account exists".
    /// `mut` so it can pay rent for the optional `agent_stats` init (P6.6).
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Optional roster entry proving `authority` is an assigned dispute resolver. A plain
    /// optional account (NOT seeds-derived) so the client can pass `None` when resolving as
    /// the protocol authority; when present it must be a program-owned `DisputeResolver`
    /// whose `resolver` equals the signer (enforced in the handler). Only the authority-
    /// gated `assign_dispute_resolver` can mint one, and the handler binds it to this signer,
    /// so the canonical ["dispute_resolver", signer] PDA is enforced transitively.
    ///
    /// `mut` (P6.4): when an assigned resolver decides the dispute, their case counters
    /// (`resolved_count`, `last_resolved_at`) are bumped on this account. The protocol
    /// authority resolving directly passes `None` (no per-resolver counter to bump).
    #[account(mut)]
    pub resolver_assignment: Option<Box<Account<'info, DisputeResolver>>>,

    /// CHECK: Task creator for refund - validated to match task.creator (fix #58)
    #[account(
        mut,
        constraint = creator.key() == task.creator @ CoordinationError::UnauthorizedTaskAction
    )]
    pub creator: UncheckedAccount<'info>,

    /// Worker's claim proving they worked on task (fix #59)
    /// Required for Complete/Split resolutions that pay a worker
    /// Made mutable to allow closing after dispute resolution (fix #439)
    #[account(
        mut,
        seeds = [b"claim", task.key().as_ref(), worker_claim.worker.as_ref()],
        bump = worker_claim.bump,
        constraint = worker_claim.task == task.key() @ CoordinationError::NotClaimed
    )]
    pub worker_claim: Option<Box<Account<'info, TaskClaim>>>,

    /// Worker agent account for the dispute defendant.
    #[account(mut)]
    pub worker: Option<Box<Account<'info, AgentRegistration>>>,

    /// OPTIONAL (P6.6): the defendant worker's track-record aggregate. When supplied,
    /// resolution bumps `disputes_won` (worker prevailed) or `disputes_lost` (worker was
    /// slashed). Bound to `["agent_stats", dispute.defendant]` (the handler validates
    /// `worker.key() == dispute.defendant`), created lazily on first write. The
    /// `disputes_lost` counter is the SDK slash-history signal. Telemetry only.
    #[account(
        init_if_needed,
        payer = authority,
        space = AgentStats::SIZE,
        seeds = [b"agent_stats", dispute.defendant.as_ref()],
        bump
    )]
    pub agent_stats: Option<Box<Account<'info, AgentStats>>>,

    /// CHECK: Worker's wallet for receiving payment
    #[account(mut)]
    pub worker_wallet: Option<UncheckedAccount<'info>>,

    /// Hire link PDA (["hire", task]) — ALWAYS required so a hired task's operator fee
    /// cannot be bypassed by settling through dispute resolution. A live (program-owned)
    /// record forces the operator leg; for a non-hired task the caller passes the empty,
    /// system-owned PDA. CHECK: live-vs-absent decided by `owner` in the handler; a live
    /// record is deserialized + validated there.
    #[account(
        seeds = [b"hire", task.key().as_ref()],
        bump
    )]
    pub hire_record: UncheckedAccount<'info>,

    /// CHECK: operator payee — validated against the resolved marketplace terms (Task-first,
    /// HireRecord fallback); required only when those terms carry a non-zero operator fee.
    /// Receives the operator leg (SOL).
    #[account(mut)]
    pub dispute_operator: Option<UncheckedAccount<'info>>,

    /// CHECK: referrer payee — validated against the resolved marketplace terms (P3.6 §3.3:
    /// dispute exits honor the snapshotted referrer leg); required only when those terms
    /// carry a non-zero referrer fee. Receives the referrer leg (SOL).
    #[account(mut)]
    pub dispute_referrer: Option<UncheckedAccount<'info>>,

    pub system_program: Program<'info, System>,

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

    /// Treasury's token account for protocol fees (optional)
    #[account(mut)]
    pub treasury_token_account: Option<Account<'info, TokenAccount>>,

    /// SPL token mint (optional, must match task.reward_mint)
    pub reward_mint: Option<Account<'info, Mint>>,

    /// SPL Token program (optional, required for token tasks)
    pub token_program: Option<Program<'info, Token>>,

    // === Batch 3 completion bonds (REQUIRED — see below) ===
    // Required, not optional: a resolver must not be able to omit a forfeit-due bond
    // (which `reclaim_completion_bond` could then refund to the loser on a Completed
    // task, inverting the forfeit). The caller passes the seeds-derived PDA even for an
    // un-bonded task; settle_completion_bond validates the canonical derivation and
    // no-ops when no bond was posted (audit hardening, mirrors resolve_reject_frozen).
    /// CHECK: creator completion bond PDA; refunded if the creator prevails, else
    /// forfeited to the treasury. Fully validated by settle_completion_bond.
    #[account(mut)]
    pub creator_completion_bond: UncheckedAccount<'info>,
    /// CHECK: worker completion bond PDA; refunded if the worker prevails, else forfeited.
    #[account(mut)]
    pub worker_completion_bond: UncheckedAccount<'info>,
    /// CHECK: treasury, recipient of a forfeited bond; validated == protocol_config.treasury.
    #[account(mut)]
    pub bond_treasury: UncheckedAccount<'info>,

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

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, ResolveDispute<'info>>,
    approve: bool,
    rationale_hash: [u8; 32],
    rationale_uri: String,
) -> Result<()> {
    // P6.4 accountable rulings: a reasoned ruling is REQUIRED. The 32-byte
    // `rationale_hash` is mandatory by type (always present); the bounded
    // `rationale_uri` is length-checked here. Both are persisted on the dispute and the
    // hash + deciding resolver are emitted in `DisputeResolved`.
    validate_rationale_uri(&rationale_uri)?;

    // Authorization: the protocol authority OR an assigned dispute resolver may resolve.
    // This replaced the open staked-arbiter vote + quorum model: a single assigned
    // resolver now decides the outcome directly (see assign_dispute_resolver).
    let signer = ctx.accounts.authority.key();
    let is_protocol_authority = signer == ctx.accounts.protocol_config.authority;
    let is_assigned_resolver = ctx
        .accounts
        .resolver_assignment
        .as_ref()
        .map(|r| r.resolver == signer)
        .unwrap_or(false);
    require!(
        ctx.accounts.authority.is_signer && (is_protocol_authority || is_assigned_resolver),
        CoordinationError::UnauthorizedResolver
    );
    // Self-dealing guard: the dispute initiator must never resolve their own dispute,
    // even if they are also on the resolver roster (or are the protocol authority).
    // The InitiatorCannotResolve error was declared but never wired (audit) — without
    // this a roster member could initiate a dispute on their own task and rule in
    // their own favor, then drive the permissionless slash finalizers against the
    // counterparty's stake.
    require!(
        signer != ctx.accounts.dispute.initiator_authority,
        CoordinationError::InitiatorCannotResolve
    );

    let dispute = &mut ctx.accounts.dispute;
    let task = &mut ctx.accounts.task;
    let escrow = &mut ctx.accounts.escrow;
    let config = &ctx.accounts.protocol_config;
    let clock = Clock::get()?;

    // Exit path: dispute resolution releases escrowed funds to the rightful
    // party; it must work even while the protocol is paused (money never locks,
    // spec §7). Type-disable gates entry only, so it is NOT re-checked here.
    check_version_compatible_for_exit(config)?;

    // Verify dispute is active
    require!(
        dispute.status == DisputeStatus::Active,
        CoordinationError::DisputeNotActive
    );

    // No voting-period wait: an assigned resolver decides directly. (The legacy
    // voting_deadline field is retained on the account but no longer gates resolution.)

    // Validate and bind defendant worker accounts (fix #842)
    validate_worker_accounts(
        dispute.as_ref(),
        &ctx.accounts.worker,
        &ctx.accounts.worker_claim,
        &ctx.accounts.worker_wallet,
        &task.key(),
        task.current_workers,
    )?;

    // Audit H-2: a resolver who is a PARTY to the dispute — the task creator or the
    // defendant worker — must never rule on it, even when seated on the resolver roster.
    // The initiator guard above only covers whichever party filed; without this, a
    // roster-seated DEFENDANT could rule `approve:false` to dodge a slash and drive the
    // permissionless finalizers against the honest initiator, and a roster-seated CREATOR
    // could refund their own escrow and slash the worker. `worker_wallet` is validated to
    // equal `worker.authority` (the defendant) by `validate_worker_accounts` above.
    let worker_wallet_key = ctx
        .accounts
        .worker_wallet
        .as_ref()
        .ok_or(CoordinationError::IncompleteWorkerAccounts)?
        .key();
    require!(
        !resolver_is_dispute_party(&signer, &task.creator, &worker_wallet_key),
        CoordinationError::ResolverConflictOfInterest
    );

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

    // Validate task is in disputed state and transitions are allowed (fix #538)
    require!(
        task.status == TaskStatus::Disputed,
        CoordinationError::TaskNotInProgress
    );
    require!(
        task.status.can_transition_to(TaskStatus::Completed)
            && task.status.can_transition_to(TaskStatus::Cancelled),
        CoordinationError::InvalidStatusTransition
    );

    // The decision is the resolver's `approve` argument — NOT a vote tally. `approved`
    // upholds the initiator's requested `resolution_type`; `!approved` refunds the creator.
    let approved = approve;
    let outcome = if approved {
        dispute_outcome::APPROVED
    } else {
        dispute_outcome::REJECTED
    };

    // Calculate remaining escrow funds
    let remaining_funds = escrow
        .amount
        .checked_sub(escrow.distributed)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Prepare token context if this is a token-denominated task
    let is_token_task = task.reward_mint.is_some();
    let task_key = task.key();
    // §4 marketplace legs (operator + referrer; Task-first, HireRecord fallback)
    // resolved once for the SOL Complete/Split branches below; hires are SOL-only
    // so token paths take no leg.
    let dispute_terms = resolve_task_marketplace_terms(
        task.operator,
        task.operator_fee_bps,
        task.referrer,
        task.referrer_fee_bps,
        &ctx.accounts.hire_record.to_account_info(),
        &task_key,
    )?;
    let worker_stake_now = ctx
        .accounts
        .worker
        .as_ref()
        .ok_or(CoordinationError::WorkerAgentRequired)?
        .stake;

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
            .as_ref()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        validate_token_account(token_escrow, &mint.key(), &escrow.key())?;
    }
    let token_escrow_starting_amount = if is_token_task {
        let token_escrow = ctx
            .accounts
            .token_escrow_ata
            .as_ref()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        anchor_spl::token::accessor::amount(&token_escrow.to_account_info())
            .map_err(|_| CoordinationError::TokenTransferFailed)?
    } else {
        0
    };

    // A worker "loses" when dispute is approved and resolution is not Complete.
    // This matches apply_dispute_slash semantics.
    let worker_lost = approved && dispute.resolution_type != ResolutionType::Complete;
    let slash_amount = if worker_lost {
        calculate_slash_amount(
            dispute.worker_stake_at_dispute,
            worker_stake_now,
            config.slash_percentage,
        )?
    } else {
        0
    };
    let token_slash_reserve = if is_token_task && worker_lost {
        remaining_funds
            .checked_mul(config.slash_percentage as u64)
            .ok_or(CoordinationError::ArithmeticOverflow)?
            .checked_div(PERCENT_BASE)
            .ok_or(CoordinationError::ArithmeticOverflow)?
    } else {
        0
    };
    let worker_slash_pending = worker_lost && (slash_amount > 0 || token_slash_reserve > 0);
    let defer_token_escrow_close = is_token_task && token_slash_reserve > 0;
    let defer_worker_claim_close = worker_slash_pending;

    // Pre-compute escrow PDA signer seeds (used by all token paths)
    let task_key_bytes = task_key.to_bytes();
    let bump_slice = [escrow.bump];
    let escrow_seeds: &[&[u8]] = &[b"escrow", task_key_bytes.as_ref(), &bump_slice];

    // Execute resolution based on type and approval
    if approved {
        match dispute.resolution_type {
            ResolutionType::Refund => {
                if is_token_task {
                    let token_escrow = ctx
                        .accounts
                        .token_escrow_ata
                        .as_mut()
                        .ok_or(CoordinationError::MissingTokenAccounts)?;
                    let token_program = ctx
                        .accounts
                        .token_program
                        .as_ref()
                        .ok_or(CoordinationError::MissingTokenAccounts)?;
                    let mint = ctx
                        .accounts
                        .reward_mint
                        .as_ref()
                        .ok_or(CoordinationError::MissingTokenAccounts)?;
                    require!(
                        ctx.accounts.creator_token_account.is_some(),
                        CoordinationError::MissingTokenAccounts
                    );
                    let creator_ta = ctx
                        .accounts
                        .creator_token_account
                        .as_ref()
                        .ok_or(CoordinationError::MissingTokenAccounts)?;
                    validate_unchecked_token_mint(
                        &creator_ta.to_account_info(),
                        &mint.key(),
                        &ctx.accounts.creator.key(),
                    )?;
                    let creator_refund = remaining_funds
                        .checked_sub(token_slash_reserve)
                        .ok_or(CoordinationError::ArithmeticOverflow)?;
                    transfer_tokens_from_escrow(
                        token_escrow,
                        &creator_ta.to_account_info(),
                        &escrow.to_account_info(),
                        creator_refund,
                        escrow_seeds,
                        token_program,
                    )?;
                    if !defer_token_escrow_close {
                        let residual_amount = token_escrow_starting_amount
                            .checked_sub(creator_refund)
                            .ok_or(CoordinationError::ArithmeticOverflow)?;
                        close_token_escrow(
                            token_escrow,
                            residual_amount,
                            &creator_ta.to_account_info(),
                            &ctx.accounts.creator.to_account_info(),
                            &escrow.to_account_info(),
                            escrow_seeds,
                            token_program,
                        )?;
                    }
                } else {
                    transfer_lamports(
                        &escrow.to_account_info(),
                        &ctx.accounts.creator.to_account_info(),
                        remaining_funds,
                    )?;
                }
                task.status = TaskStatus::Cancelled;
            }
            ResolutionType::Complete => {
                let worker_wallet = ctx
                    .accounts
                    .worker_wallet
                    .as_ref()
                    .ok_or(CoordinationError::IncompleteWorkerAccounts)?;
                if is_token_task {
                    let token_escrow = ctx
                        .accounts
                        .token_escrow_ata
                        .as_mut()
                        .ok_or(CoordinationError::MissingTokenAccounts)?;
                    let token_program = ctx
                        .accounts
                        .token_program
                        .as_ref()
                        .ok_or(CoordinationError::MissingTokenAccounts)?;
                    let mint = ctx
                        .accounts
                        .reward_mint
                        .as_ref()
                        .ok_or(CoordinationError::MissingTokenAccounts)?;
                    require!(
                        ctx.accounts.worker_token_account_ata.is_some(),
                        CoordinationError::MissingTokenAccounts
                    );
                    let worker_ta = ctx
                        .accounts
                        .worker_token_account_ata
                        .as_ref()
                        .ok_or(CoordinationError::MissingTokenAccounts)?;
                    validate_unchecked_token_mint(
                        &worker_ta.to_account_info(),
                        &mint.key(),
                        &worker_wallet.key(),
                    )?;
                    transfer_tokens_from_escrow(
                        token_escrow,
                        &worker_ta.to_account_info(),
                        &escrow.to_account_info(),
                        remaining_funds,
                        escrow_seeds,
                        token_program,
                    )?;
                    let residual_amount = token_escrow_starting_amount
                        .checked_sub(remaining_funds)
                        .ok_or(CoordinationError::ArithmeticOverflow)?;
                    close_token_escrow(
                        token_escrow,
                        residual_amount,
                        &worker_ta.to_account_info(),
                        &ctx.accounts.creator.to_account_info(),
                        &escrow.to_account_info(),
                        escrow_seeds,
                        token_program,
                    )?;
                } else {
                    // §4 split: pay the marketplace legs (operator + referrer) first so
                    // dispute resolution can't bypass them. No-op for a non-hired,
                    // unreferred task.
                    let legs_fee = pay_dispute_marketplace_legs(
                        &dispute_terms,
                        ctx.accounts
                            .dispute_operator
                            .as_ref()
                            .map(|a| a.to_account_info()),
                        ctx.accounts
                            .dispute_referrer
                            .as_ref()
                            .map(|a| a.to_account_info()),
                        &escrow.to_account_info(),
                        remaining_funds,
                        task.task_id,
                        clock.unix_timestamp,
                    )?;
                    let worker_net = remaining_funds
                        .checked_sub(legs_fee)
                        .ok_or(CoordinationError::ArithmeticOverflow)?;
                    transfer_lamports(
                        &escrow.to_account_info(),
                        &worker_wallet.to_account_info(),
                        worker_net,
                    )?;
                }
                task.status = TaskStatus::Completed;
                task.completed_at = clock.unix_timestamp;
                update_protocol_stats(&mut ctx.accounts.protocol_config, remaining_funds)?;
            }
            ResolutionType::Split => {
                if remaining_funds > 0 {
                    let distributable = remaining_funds
                        .checked_sub(token_slash_reserve)
                        .ok_or(CoordinationError::ArithmeticOverflow)?;
                    let worker_share = distributable
                        .checked_div(2)
                        .ok_or(CoordinationError::ArithmeticOverflow)?;
                    let creator_share = distributable
                        .checked_sub(worker_share)
                        .ok_or(CoordinationError::ArithmeticOverflow)?;

                    let worker_wallet = ctx
                        .accounts
                        .worker_wallet
                        .as_ref()
                        .ok_or(CoordinationError::IncompleteWorkerAccounts)?;

                    if is_token_task {
                        let token_escrow = ctx
                            .accounts
                            .token_escrow_ata
                            .as_mut()
                            .ok_or(CoordinationError::MissingTokenAccounts)?;
                        let token_program = ctx
                            .accounts
                            .token_program
                            .as_ref()
                            .ok_or(CoordinationError::MissingTokenAccounts)?;
                        let mint = ctx
                            .accounts
                            .reward_mint
                            .as_ref()
                            .ok_or(CoordinationError::MissingTokenAccounts)?;
                        require!(
                            ctx.accounts.creator_token_account.is_some()
                                && ctx.accounts.worker_token_account_ata.is_some(),
                            CoordinationError::MissingTokenAccounts
                        );
                        let creator_ta = ctx
                            .accounts
                            .creator_token_account
                            .as_ref()
                            .ok_or(CoordinationError::MissingTokenAccounts)?;
                        let worker_ta = ctx
                            .accounts
                            .worker_token_account_ata
                            .as_ref()
                            .ok_or(CoordinationError::MissingTokenAccounts)?;
                        validate_unchecked_token_mint(
                            &creator_ta.to_account_info(),
                            &mint.key(),
                            &ctx.accounts.creator.key(),
                        )?;
                        validate_unchecked_token_mint(
                            &worker_ta.to_account_info(),
                            &mint.key(),
                            &worker_wallet.key(),
                        )?;
                        transfer_tokens_from_escrow(
                            token_escrow,
                            &creator_ta.to_account_info(),
                            &escrow.to_account_info(),
                            creator_share,
                            escrow_seeds,
                            token_program,
                        )?;
                        transfer_tokens_from_escrow(
                            token_escrow,
                            &worker_ta.to_account_info(),
                            &escrow.to_account_info(),
                            worker_share,
                            escrow_seeds,
                            token_program,
                        )?;
                        if !defer_token_escrow_close {
                            let split_total = creator_share
                                .checked_add(worker_share)
                                .ok_or(CoordinationError::ArithmeticOverflow)?;
                            let residual_amount = token_escrow_starting_amount
                                .checked_sub(split_total)
                                .ok_or(CoordinationError::ArithmeticOverflow)?;
                            close_token_escrow(
                                token_escrow,
                                residual_amount,
                                &creator_ta.to_account_info(),
                                &ctx.accounts.creator.to_account_info(),
                                &escrow.to_account_info(),
                                escrow_seeds,
                                token_program,
                            )?;
                        }
                    } else {
                        // §4 split: carve the marketplace legs (operator + referrer) from
                        // the worker's half so a Split resolution can't bypass them
                        // (no-op for a non-hired, unreferred task).
                        let legs_fee = pay_dispute_marketplace_legs(
                            &dispute_terms,
                            ctx.accounts
                                .dispute_operator
                                .as_ref()
                                .map(|a| a.to_account_info()),
                            ctx.accounts
                                .dispute_referrer
                                .as_ref()
                                .map(|a| a.to_account_info()),
                            &escrow.to_account_info(),
                            worker_share,
                            task.task_id,
                            clock.unix_timestamp,
                        )?;
                        let worker_net = worker_share
                            .checked_sub(legs_fee)
                            .ok_or(CoordinationError::ArithmeticOverflow)?;
                        // The marketplace legs were already debited from escrow by the helper.
                        debit_lamports(
                            &escrow.to_account_info(),
                            remaining_funds
                                .checked_sub(legs_fee)
                                .ok_or(CoordinationError::ArithmeticOverflow)?,
                        )?;
                        let creator_info = ctx.accounts.creator.to_account_info();
                        credit_lamports(&creator_info, creator_share)?;
                        credit_lamports(&worker_wallet.to_account_info(), worker_net)?;
                    }
                }
                task.status = TaskStatus::Cancelled;
            }
        }
    } else {
        // Dispute rejected - refund to creator by default
        if is_token_task {
            let token_escrow = ctx
                .accounts
                .token_escrow_ata
                .as_mut()
                .ok_or(CoordinationError::MissingTokenAccounts)?;
            let token_program = ctx
                .accounts
                .token_program
                .as_ref()
                .ok_or(CoordinationError::MissingTokenAccounts)?;
            let mint = ctx
                .accounts
                .reward_mint
                .as_ref()
                .ok_or(CoordinationError::MissingTokenAccounts)?;
            require!(
                ctx.accounts.creator_token_account.is_some(),
                CoordinationError::MissingTokenAccounts
            );
            let creator_ta = ctx
                .accounts
                .creator_token_account
                .as_ref()
                .ok_or(CoordinationError::MissingTokenAccounts)?;
            validate_unchecked_token_mint(
                &creator_ta.to_account_info(),
                &mint.key(),
                &ctx.accounts.creator.key(),
            )?;
            transfer_tokens_from_escrow(
                token_escrow,
                &creator_ta.to_account_info(),
                &escrow.to_account_info(),
                remaining_funds,
                escrow_seeds,
                token_program,
            )?;
            let residual_amount = token_escrow_starting_amount
                .checked_sub(remaining_funds)
                .ok_or(CoordinationError::ArithmeticOverflow)?;
            close_token_escrow(
                token_escrow,
                residual_amount,
                &creator_ta.to_account_info(),
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
        task.status = TaskStatus::Cancelled;
    }

    if let Some((bid_book_info, accepted_bid_info, bidder_market_state_info)) =
        accepted_bid_accounts
    {
        let bond_disposition = if approved && dispute.resolution_type != ResolutionType::Complete {
            AcceptedBidBondDisposition::FullSlashToCreator
        } else {
            AcceptedBidBondDisposition::Refund
        };
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
    // Audit F-2 (adversarial-review follow-up): when the claim close is DEFERRED
    // (slash pending), the claim is still open — so active_tasks must stay
    // incremented, mirroring current_workers (which likewise stays 1). The slash
    // finalizer (apply_dispute_slash) decrements it when the claim closes.
    // Decrementing here would leave current_workers == 1 but active_tasks == 0 —
    // a counter desync on the still-open claim.
    if !worker_slash_pending {
        // Saturating (F-15 consistency): this path is a designated un-bricking
        // exit; a legacy drifted counter must not be able to wedge it.
        worker.active_tasks = worker.active_tasks.saturating_sub(1);
    }
    // Update activity timestamp so fallback deregistration gating has a deterministic anchor.
    worker.last_active = clock.unix_timestamp;
    if !worker_slash_pending {
        worker.disputes_as_defendant = worker.disputes_as_defendant.saturating_sub(1);
    }
    let defendant_worker_key = worker.key();

    // P6.6: record the dispute OUTCOME for the defendant worker's track record. A
    // resolution where the worker is slashed (`worker_lost`) is a loss (the SDK
    // slash-history signal); any other resolution is a win for the defendant. No-op when
    // the optional `agent_stats` account is absent. Telemetry only — never gates the
    // settlement above. `defendant_worker_key == dispute.defendant`, so it matches the
    // PDA seed bound on `agent_stats`.
    let dispute_outcome_counter = if worker_lost {
        Counter::DisputesLost
    } else {
        Counter::DisputesWon
    };
    apply_track_record(
        &mut ctx.accounts.agent_stats,
        defendant_worker_key,
        ctx.bumps.agent_stats,
        dispute_outcome_counter,
        clock.unix_timestamp,
    )?;

    // P6.3: the arbiter vote/quorum model is retired, so there are no (vote, arbiter)
    // pairs to clean up — `remaining_accounts` carry ONLY the optional collaborative
    // (claim, worker) pairs. `validate_remaining_accounts_structure` now asserts
    // `total_voters == 0` and that the remaining accounts come in pairs.
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

    dispute.status = DisputeStatus::Resolved;
    dispute.resolved_at = clock.unix_timestamp;
    // P6.3: record the resolver's binary RULING into the (now-deprecated) vote-tally
    // fields so the permissionless slash finalizers — `apply_dispute_slash` (worker) and
    // `apply_initiator_slash` (initiator) — can read the approve/reject decision without
    // a vote tally. They derive the loser via `calculate_approval_percentage(votes_for,
    // votes_against)` against `config.dispute_threshold`; writing (1, 0) on APPROVE
    // yields 100% (>= threshold → approved) and (0, 1) on REJECT yields 0% (< threshold
    // → rejected), reproducing the exact pre-P6.3 slash decision with no votes cast.
    // Without this, `calculate_approval_percentage(0, 0)` would error (InsufficientVotes)
    // and BOTH slash legs would be permanently stranded after the roster rework.
    let (ruling_for, ruling_against) = ruling_vote_bits(approved);
    dispute.votes_for = ruling_for;
    dispute.votes_against = ruling_against;
    // P6.4 accountable rulings: persist the reasoned ruling + the deciding resolver on
    // the dispute itself (an immutable, on-chain audit trail of who ruled and why).
    dispute.rationale_hash = rationale_hash;
    dispute.rationale_uri = rationale_uri;
    dispute.resolved_by = signer;
    let distributed_now = remaining_funds
        .checked_sub(token_slash_reserve)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    escrow.distributed = escrow
        .distributed
        .checked_add(distributed_now)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    escrow.is_closed = !defer_token_escrow_close;
    // Audit F-2: when the defendant's claim close is DEFERRED (a slash is pending), keep
    // current_workers honest — the claim IS still open — instead of zeroing it. The
    // slash finalizer (apply_dispute_slash) decrements it when the claim closes. This
    // makes close_task's current_workers == 0 guard atomically block destroying the
    // Task PDA while a worker-slash is pending (that brick previously locked the
    // defendant's disputes_as_defendant — and their entire stake — forever, and let a
    // creator race the permissionless finalizer). The initiator side no longer needs
    // this protection: apply_initiator_slash does not load the Task at all.
    task.current_workers = if defer_worker_claim_close { 1 } else { 0 };

    // Audit M-3 (follow-up): a token task's escrow PDA stays OPEN even when nothing was
    // deferred (drained, is_closed = true). apply_dispute_slash derives "deferred token
    // reserve" from this account's liveness (open + !is_closed), so it must be able to
    // read it to distinguish "reserve pending" from "settled at resolve" — without that
    // signal a caller could omit the token accounts, take the stake-slash-only path, close
    // the worker_claim and strand a live reserve forever. The drained PDA's rent is
    // reclaimed by close_task (the same pattern expire_dispute already uses). SOL tasks
    // close here as before.
    if !defer_token_escrow_close && !is_token_task {
        escrow.close(ctx.accounts.creator.to_account_info())?;
    }

    // Close worker_claim account and return rent lamports to worker wallet (fix #838)
    // The claim rent was paid by worker wallet at creation, so return it there
    if !defer_worker_claim_close {
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
        claim.close(worker_wallet.to_account_info())?;
    }

    // Audit F-9: sweep the defendant's TaskSubmission when the caller supplies it —
    // decrement the review counters if it is still live and return its rent to the
    // worker authority, so neither the counters nor the rent strand on the terminal
    // task. Optional: when omitted, close_task remains the fallback sweep.
    if let Some(submission_info) = ctx.accounts.task_submission.as_ref() {
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
        sweep_dispute_submission(
            task,
            &task_key,
            &worker_claim.key(),
            &defendant_worker_key,
            &worker_wallet.to_account_info(),
            &submission_info.to_account_info(),
            ctx.accounts.task_validation_config.as_deref_mut(),
        )?;
    }

    // Batch 3 §8: completion bond disposition follows the dispute outcome — the loser
    // forfeits their bond to the treasury, the winner is refunded. A Split or a
    // rejected dispute (no fault established) refunds both. No-op for un-bonded tasks.
    //
    // The bond accounts are REQUIRED (not optional): a resolver must not be able to
    // omit a forfeit-due bond, which `reclaim_completion_bond` could then refund to
    // the loser on the now-Completed task — inverting the forfeit. The caller passes
    // the seeds-derived PDA even for an un-bonded task; settle_completion_bond
    // validates the canonical derivation and no-ops when no live bond was posted
    // (mirrors resolve_reject_frozen).
    {
        let bond_resolution = dispute.resolution_type;
        // (creator_forfeit, worker_forfeit)
        let (creator_forfeit, worker_forfeit) = if approved {
            match bond_resolution {
                ResolutionType::Complete => (true, false), // worker wins
                ResolutionType::Refund => (false, true),   // worker loses
                ResolutionType::Split => (false, false),
            }
        } else {
            (false, false) // rejected: no fault, refund both
        };

        // Validate + bind the treasury (forfeit recipient).
        require!(
            ctx.accounts.bond_treasury.key() == ctx.accounts.protocol_config.treasury,
            CoordinationError::InvalidInput
        );
        let treasury_info = ctx.accounts.bond_treasury.to_account_info();

        // Pin both bond accounts to their canonical PDA. settle_completion_bond no-ops on
        // any non-program-owned account, so without this a resolver could pass a junk
        // (system-owned) account to SKIP a forfeit-due settle, leaving the real bond at
        // its canonical PDA for reclaim_completion_bond to refund on the now-Completed
        // task — inverting the forfeit. Required + canonical-pinned closes that. An
        // un-bonded task still passes (correct address, no account → settle no-ops).
        let worker_wallet_key = ctx
            .accounts
            .worker_wallet
            .as_ref()
            .ok_or(CoordinationError::IncompleteWorkerAccounts)?
            .key();
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
                worker_wallet_key.as_ref(),
            ],
            &crate::ID,
        );
        require!(
            ctx.accounts.worker_completion_bond.key() == expected_worker_bond,
            CoordinationError::MissingCompletionBondAccount
        );

        // Creator bond: forfeit to treasury if the creator lost, else refund.
        let creator_info = ctx.accounts.creator.to_account_info();
        let creator_bond_info = ctx.accounts.creator_completion_bond.to_account_info();
        if creator_forfeit {
            settle_completion_bond(
                &creator_bond_info,
                &creator_info,
                &task_key,
                CompletionBond::ROLE_CREATOR,
                BondDisposition::Forfeit {
                    recipient: &treasury_info,
                },
            )?;
        } else {
            settle_completion_bond(
                &creator_bond_info,
                &creator_info,
                &task_key,
                CompletionBond::ROLE_CREATOR,
                BondDisposition::Refund,
            )?;
        }

        // Worker bond: forfeit to treasury if the worker lost, else refund. The
        // poster is the worker's signing wallet (validated == worker.authority by
        // validate_worker_accounts above, which also guarantees worker_wallet is Some).
        let worker_info = ctx
            .accounts
            .worker_wallet
            .as_ref()
            .ok_or(CoordinationError::IncompleteWorkerAccounts)?
            .to_account_info();
        let worker_bond_info = ctx.accounts.worker_completion_bond.to_account_info();
        if worker_forfeit {
            settle_completion_bond(
                &worker_bond_info,
                &worker_info,
                &task_key,
                CompletionBond::ROLE_WORKER,
                BondDisposition::Forfeit {
                    recipient: &treasury_info,
                },
            )?;
        } else {
            settle_completion_bond(
                &worker_bond_info,
                &worker_info,
                &task_key,
                CompletionBond::ROLE_WORKER,
                BondDisposition::Refund,
            )?;
        }
    }

    // P6.4 resolver accountability: if an ASSIGNED resolver decided this dispute (the
    // protocol authority resolving directly passes `resolver_assignment: None`), fold
    // the case into THAT resolver's track record on the roster PDA. We bump only when
    // the supplied entry actually belongs to the signing decider — never mis-attribute
    // a case to an unrelated roster member that a protocol-authority caller happened to
    // pass. Mismatch is a silent skip (not an error): the counters are telemetry and
    // must not be able to block a valid settlement. Checked arithmetic throughout.
    if let Some(resolver_entry) = ctx.accounts.resolver_assignment.as_mut() {
        if resolver_entry.resolver == signer {
            bump_resolver_case_counters(resolver_entry.as_mut(), clock.unix_timestamp)?;
        }
    }

    emit!(DisputeResolved {
        dispute_id: dispute.dispute_id,
        resolution_type: dispute.resolution_type as u8,
        outcome,
        votes_for: dispute.votes_for,
        votes_against: dispute.votes_against,
        timestamp: clock.unix_timestamp,
        resolved_by: signer,
        rationale_hash,
    });

    Ok(())
}

/// Validates worker account consistency and defendant binding.
/// Audit H-2 conflict-of-interest predicate: a resolver who is a PARTY to the dispute —
/// the task creator or the defendant worker's validated authority wallet — must never
/// rule on it, not only the initiator. Returns true when `signer` is conflicted. Compare
/// against `worker_wallet` (the on-chain-validated worker authority, see
/// `validate_worker_accounts`), NOT `dispute.defendant`, which is an agent PDA and would
/// make the check a no-op.
fn resolver_is_dispute_party(signer: &Pubkey, creator: &Pubkey, worker_wallet: &Pubkey) -> bool {
    signer == creator || signer == worker_wallet
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

    // Worker must be the dispute defendant.
    require!(
        worker.key() == dispute.defendant,
        CoordinationError::WorkerNotInDispute
    );

    // Verify worker matches claim
    require!(
        worker.key() == worker_claim.worker,
        CoordinationError::UnauthorizedAgent
    );

    // Verify claim is for this task
    require!(
        worker_claim.task == *task_key,
        CoordinationError::NotClaimed
    );

    // Verify worker wallet binding.
    require!(
        worker_wallet.key() == worker.authority,
        CoordinationError::UnauthorizedAgent
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Audit H-2 (revert-sensitive on the predicate): a resolver equal to the task creator
    // or the defendant worker's validated wallet is conflicted; an unrelated resolver is
    // not. Narrowing `resolver_is_dispute_party` back to a single party turns this red.
    #[test]
    fn resolver_dispute_party_conflict_is_detected() {
        let creator = Pubkey::new_unique();
        let worker_wallet = Pubkey::new_unique();
        let outsider = Pubkey::new_unique();
        assert!(resolver_is_dispute_party(&creator, &creator, &worker_wallet));
        assert!(resolver_is_dispute_party(
            &worker_wallet,
            &creator,
            &worker_wallet
        ));
        assert!(!resolver_is_dispute_party(&outsider, &creator, &worker_wallet));
    }

    // === P6.4 (1): rationale_uri bound (positive + negative) ===

    #[test]
    fn accepts_empty_and_max_rationale_uri() {
        // Empty is allowed (the 32-byte hash can carry the rationale alone).
        assert!(validate_rationale_uri("").is_ok());
        let max = "a".repeat(Dispute::MAX_RATIONALE_URI_LEN);
        assert!(
            validate_rationale_uri(&max).is_ok(),
            "exactly-max URI must be accepted"
        );
    }

    // Revert-sensitive: removing the length `require!` in `validate_rationale_uri`
    // makes an over-length URI pass — this assertion then goes red.
    #[test]
    fn rejects_overlong_rationale_uri() {
        let over = "a".repeat(Dispute::MAX_RATIONALE_URI_LEN + 1);
        assert!(validate_rationale_uri(&over).is_err());
    }

    // === P6.4 (2): resolver case counters ===

    fn fresh_resolver() -> DisputeResolver {
        let mut r = DisputeResolver::default();
        r.resolver = Pubkey::new_unique();
        r
    }

    // One resolution bumps `resolved_count` by exactly one and stamps `last_resolved_at`.
    // Revert-sensitive: drop the `checked_add` increment in `bump_resolver_case_counters`
    // and `resolved_count == 1` goes red; drop the timestamp write and the
    // `last_resolved_at` assertion goes red.
    #[test]
    fn bump_resolver_increments_resolved_count_and_stamps_time() {
        let mut r = fresh_resolver();
        let v = bump_resolver_case_counters(&mut r, 1_700_000_123).unwrap();
        assert_eq!(v, 1, "returns the post-increment count");
        assert_eq!(r.resolved_count, 1);
        assert_eq!(r.last_resolved_at, 1_700_000_123);
    }

    // `overturned_count` has no incrementer here — it is moved only by the
    // (design-doc-only) challenge-window mechanism. This pins that invariant: resolving
    // must NEVER move it. Revert-sensitive: if a future edit accidentally bumps
    // `overturned_count` in `bump_resolver_case_counters`, this goes red.
    #[test]
    fn bump_resolver_does_not_touch_overturned_count() {
        let mut r = fresh_resolver();
        bump_resolver_case_counters(&mut r, 10).unwrap();
        assert_eq!(
            r.overturned_count, 0,
            "resolving must not move overturned_count (challenge-window only)"
        );
    }

    #[test]
    fn repeated_resolutions_accumulate_resolved_count() {
        let mut r = fresh_resolver();
        assert_eq!(bump_resolver_case_counters(&mut r, 1).unwrap(), 1);
        assert_eq!(bump_resolver_case_counters(&mut r, 2).unwrap(), 2);
        assert_eq!(bump_resolver_case_counters(&mut r, 3).unwrap(), 3);
        assert_eq!(r.resolved_count, 3);
        assert_eq!(r.last_resolved_at, 3);
    }

    // Overflow guard (negative). Revert-sensitive: swapping `checked_add` for a wrapping
    // add makes this pass silently — the `is_err` assertion then goes red.
    #[test]
    fn bump_resolver_at_max_errors_instead_of_wrapping() {
        let mut r = fresh_resolver();
        r.resolved_count = u64::MAX;
        assert!(bump_resolver_case_counters(&mut r, 1).is_err());
        // Left untouched on the error path.
        assert_eq!(r.resolved_count, u64::MAX);
    }

    // === P6.3 (vote retirement): ruling-bit encoding for the slash finalizers ===
    use crate::instructions::slash_helpers::calculate_approval_percentage;

    // APPROVE encodes (1, 0); REJECT encodes (0, 1). Revert-sensitive: swap a branch in
    // `ruling_vote_bits` and these equalities go red.
    #[test]
    fn ruling_vote_bits_encode_approve_and_reject() {
        assert_eq!(
            ruling_vote_bits(true),
            (1, 0),
            "approve -> (votes_for=1, votes_against=0)"
        );
        assert_eq!(
            ruling_vote_bits(false),
            (0, 1),
            "reject -> (votes_for=0, votes_against=1)"
        );
    }

    // The ruling bits must reproduce the EXACT slash decision the finalizers compute:
    // approve -> 100% (>= the default 50% threshold -> approved -> worker slashable);
    // reject  -> 0%   (<  threshold -> rejected -> worker vindicated).
    // Revert-sensitive: if `resolve_dispute` ever wrote (0, 0) again, the approved case
    // would error (InsufficientVotes) and this assertion would go red.
    #[test]
    fn ruling_bits_round_trip_through_approval_percentage() {
        const DEFAULT_THRESHOLD: u64 = 50;

        let (f, a) = ruling_vote_bits(true);
        let (_total, approval_pct) = calculate_approval_percentage(f, a).unwrap();
        assert_eq!(approval_pct, 100, "approve ruling reads as 100% approval");
        assert!(
            approval_pct >= DEFAULT_THRESHOLD,
            "approve ruling clears the threshold"
        );

        let (f, a) = ruling_vote_bits(false);
        let (_total, approval_pct) = calculate_approval_percentage(f, a).unwrap();
        assert_eq!(approval_pct, 0, "reject ruling reads as 0% approval");
        assert!(
            approval_pct < DEFAULT_THRESHOLD,
            "reject ruling fails the threshold"
        );
    }

    // Negative pin: a (0, 0) tally — the bug the ruling-bit fix avoids — must error
    // rather than silently read as "not approved". This is exactly why the ruling bits
    // are required. Revert-sensitive: drop the `require!(total_votes > 0)` guard in
    // `calculate_approval_percentage` and this `is_err` goes red.
    #[test]
    fn zero_tally_is_an_error_not_a_silent_rejection() {
        assert!(
            calculate_approval_percentage(0, 0).is_err(),
            "a (0,0) tally must error (InsufficientVotes), proving the ruling bits are load-bearing"
        );
    }
}
