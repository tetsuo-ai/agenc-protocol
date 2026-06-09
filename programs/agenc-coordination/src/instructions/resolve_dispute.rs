//! Resolve a dispute and execute the outcome

use crate::errors::CoordinationError;
use crate::events::{dispute_outcome, DisputeResolved};
use crate::instructions::bid_settlement_helpers::{
    settle_accepted_bid, AcceptedBidBondDisposition, AcceptedBidBookDisposition,
};
use crate::instructions::completion_helpers::update_protocol_stats;
use crate::instructions::constants::{MIN_VOTERS_FOR_RESOLUTION, PERCENT_BASE};
use crate::instructions::bond_helpers::{settle_completion_bond, BondDisposition};
use crate::instructions::dispute_helpers::{
    check_duplicate_arbiters, check_duplicate_workers, pay_dispute_operator_fee,
    process_arbiter_vote_pair, process_worker_claim_pair, resolve_task_operator_terms,
    validate_remaining_accounts_structure,
};
use crate::instructions::lamport_transfer::{credit_lamports, debit_lamports, transfer_lamports};
use crate::instructions::slash_helpers::calculate_slash_amount;
use crate::instructions::token_helpers::{
    close_token_escrow, transfer_tokens_from_escrow, validate_token_account,
    validate_unchecked_token_mint,
};
use crate::state::{
    AgentRegistration, CompletionBond, Dispute, DisputeStatus, ProtocolConfig, ResolutionType, Task,
    TaskClaim, TaskEscrow, TaskStatus, TaskType,
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

    #[account(
        constraint = authority.key() == protocol_config.authority
            @ CoordinationError::UnauthorizedResolver
    )]
    pub authority: Signer<'info>,

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

    /// CHECK: operator payee — validated against hire_record.operator; required only when
    /// a live hire carries a non-zero operator fee. Receives the operator leg (SOL).
    #[account(mut)]
    pub dispute_operator: Option<UncheckedAccount<'info>>,

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
}

pub fn handler<'info>(ctx: Context<'_, '_, '_, 'info, ResolveDispute<'info>>) -> Result<()> {
    let dispute = &mut ctx.accounts.dispute;
    let task = &mut ctx.accounts.task;
    let escrow = &mut ctx.accounts.escrow;
    let config = &ctx.accounts.protocol_config;
    let clock = Clock::get()?;

    // Exit path: dispute resolution releases escrowed funds to the rightful
    // party; it must work even while the protocol is paused (money never locks,
    // spec §7). Type-disable gates entry only, so it is NOT re-checked here.
    check_version_compatible_for_exit(config)?;
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::UnauthorizedResolver
    );

    // Verify dispute is active
    require!(
        dispute.status == DisputeStatus::Active,
        CoordinationError::DisputeNotActive
    );

    // Verify voting period has ended
    require!(
        clock.unix_timestamp >= dispute.voting_deadline,
        CoordinationError::VotingNotEnded
    );

    // Validate and bind defendant worker accounts (fix #842)
    validate_worker_accounts(
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

    // Calculate total votes
    let total_votes = dispute
        .votes_for
        .checked_add(dispute.votes_against)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Require minimum quorum for dispute resolution (fix #546)
    // A single arbiter should not be able to unilaterally decide outcomes
    require!(
        dispute.total_voters as usize >= MIN_VOTERS_FOR_RESOLUTION,
        CoordinationError::InsufficientQuorum
    );

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

    let (approved, outcome) = determine_dispute_outcome(
        dispute.votes_for,
        dispute.votes_against,
        total_votes,
        config,
    )?;

    // Calculate remaining escrow funds
    let remaining_funds = escrow
        .amount
        .checked_sub(escrow.distributed)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Prepare token context if this is a token-denominated task
    let is_token_task = task.reward_mint.is_some();
    let task_key = task.key();
    // §4 operator leg (Task-first, HireRecord fallback) resolved once for the SOL
    // Complete/Split branches below; hires are SOL-only so token paths take no leg.
    let (dispute_operator_pubkey, dispute_operator_fee_bps) = resolve_task_operator_terms(
        task.operator,
        task.operator_fee_bps,
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
                    // §4 3-way split: pay the operator leg first if this is a hired task,
                    // so dispute resolution can't bypass the operator fee. No-op otherwise.
                    let op_fee = pay_dispute_operator_fee(
                        dispute_operator_pubkey,
                        dispute_operator_fee_bps,
                        ctx.accounts.dispute_operator.as_ref().map(|a| a.to_account_info()),
                        &escrow.to_account_info(),
                        remaining_funds,
                    )?;
                    let worker_net = remaining_funds
                        .checked_sub(op_fee)
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
                        // §4 3-way split: carve the operator leg from the worker's half so
                        // a Split resolution can't bypass the operator fee (no-op if not hired).
                        let op_fee = pay_dispute_operator_fee(
                            dispute_operator_pubkey,
                            dispute_operator_fee_bps,
                            ctx.accounts.dispute_operator.as_ref().map(|a| a.to_account_info()),
                            &escrow.to_account_info(),
                            worker_share,
                        )?;
                        let worker_net = worker_share
                            .checked_sub(op_fee)
                            .ok_or(CoordinationError::ArithmeticOverflow)?;
                        // The operator leg was already debited from escrow by the helper.
                        debit_lamports(
                            &escrow.to_account_info(),
                            remaining_funds
                                .checked_sub(op_fee)
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
    worker.active_tasks = worker
        .active_tasks
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    // Update activity timestamp so fallback deregistration gating has a deterministic anchor.
    worker.last_active = clock.unix_timestamp;
    if !worker_slash_pending {
        worker.disputes_as_defendant = worker.disputes_as_defendant.saturating_sub(1);
    }
    let defendant_worker_key = worker.key();

    // Update dispute status - decrement active_dispute_votes for each arbiter
    //
    // remaining_accounts format (fix #333):
    // - First: (vote, arbiter) pairs for total_voters
    // - Then: optional (claim, worker) pairs for additional workers on collaborative tasks
    let arbiter_accounts =
        validate_remaining_accounts_structure(dispute_remaining_accounts, dispute.total_voters)?;
    check_duplicate_arbiters(dispute_remaining_accounts, arbiter_accounts)?;

    for i in (0..arbiter_accounts).step_by(2) {
        let arbiter_index = i
            .checked_add(1)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        process_arbiter_vote_pair(
            &dispute_remaining_accounts[i],
            &dispute_remaining_accounts[arbiter_index],
            &dispute.key(),
            &crate::ID,
        )?;
    }

    let remaining_worker_accounts = dispute_remaining_accounts
        .len()
        .checked_sub(arbiter_accounts)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let worker_pairs = remaining_worker_accounts
        .checked_div(2)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let expected_worker_pairs = usize::from(
        task.current_workers
            .checked_sub(1)
            .ok_or(CoordinationError::ArithmeticOverflow)?,
    );
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
    let distributed_now = remaining_funds
        .checked_sub(token_slash_reserve)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    escrow.distributed = escrow
        .distributed
        .checked_add(distributed_now)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    escrow.is_closed = !defer_token_escrow_close;
    task.current_workers = 0;

    if !defer_token_escrow_close {
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

    emit!(DisputeResolved {
        dispute_id: dispute.dispute_id,
        resolution_type: dispute.resolution_type as u8,
        outcome,
        votes_for: dispute.votes_for,
        votes_against: dispute.votes_against,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

/// Validates worker account consistency and defendant binding.
fn validate_worker_accounts(
    dispute: &Dispute,
    worker: &Option<Box<Account<AgentRegistration>>>,
    worker_claim: &Option<Box<Account<TaskClaim>>>,
    worker_wallet: &Option<UncheckedAccount>,
    task_key: &Pubkey,
) -> Result<()> {
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

/// Determine dispute outcome from vote counts.
///
/// Returns `(approved, outcome_code)` where outcome_code is one of:
/// - `dispute_outcome::REJECTED` (0): Arbiters actively voted against
/// - `dispute_outcome::APPROVED` (1): Arbiters voted in favor and met threshold
/// - `dispute_outcome::NO_VOTE_DEFAULT` (2): No votes cast, defaulted to rejection
fn determine_dispute_outcome(
    votes_for: u64,
    _votes_against: u64,
    total_votes: u64,
    config: &ProtocolConfig,
) -> Result<(bool, u8)> {
    if total_votes == 0 {
        return Ok((false, dispute_outcome::NO_VOTE_DEFAULT));
    }

    let approval_pct = votes_for
        .checked_mul(PERCENT_BASE)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(total_votes)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let is_approved = approval_pct >= config.dispute_threshold as u64;
    let outcome = if is_approved {
        dispute_outcome::APPROVED
    } else {
        dispute_outcome::REJECTED
    };
    Ok((is_approved, outcome))
}
