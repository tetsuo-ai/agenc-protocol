//! Accept a Task Validation V2 submission and settle the task reward.

use crate::errors::CoordinationError;
use crate::events::TaskResultAccepted;
#[cfg(not(feature = "mainnet-canary"))]
use crate::instructions::bid_settlement_helpers::{
    finalize_bid_task_completion, load_bid_task_completion_meta,
};
#[cfg(not(feature = "mainnet-canary"))]
use crate::instructions::bond_helpers::{settle_completion_bond, BondDisposition};
#[cfg(feature = "spl-token-rewards")]
use crate::instructions::completion_helpers::TokenPaymentAccounts;
use crate::instructions::completion_helpers::{
    build_referrer_leg, calculate_fee_with_reputation, execute_completion_rewards,
    validate_task_dependency, OperatorLeg,
};
use crate::instructions::task_validation_helpers::{
    decrement_pending_submission_count, ensure_validation_config, ensure_validation_mode,
    is_manual_validation_task, note_submission_left_review, sync_task_validation_status,
    validate_contest_accept_window,
};
#[cfg(feature = "spl-token-rewards")]
use crate::instructions::token_helpers::{validate_token_account, validate_unchecked_token_mint};
#[cfg(not(feature = "mainnet-canary"))]
use crate::state::CompletionBond;
use crate::state::{
    AgentRegistration, HireRecord, ProtocolConfig, SubmissionStatus, Task, TaskClaim, TaskEscrow,
    TaskStatus, TaskSubmission, TaskValidationConfig, ValidationMode,
};
use crate::utils::version::check_version_compatible_for_exit;
use anchor_lang::prelude::*;
#[cfg(feature = "spl-token-rewards")]
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(Accounts)]
pub struct AcceptTaskResult<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        mut,
        seeds = [b"claim", task.key().as_ref(), worker.key().as_ref()],
        bump = claim.bump,
        constraint = claim.task == task.key() @ CoordinationError::NotClaimed,
        constraint = claim.worker == worker.key() @ CoordinationError::NotClaimed
    )]
    pub claim: Box<Account<'info, TaskClaim>>,

    #[account(
        mut,
        seeds = [b"escrow", task.key().as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Box<Account<'info, TaskEscrow>>,

    #[account(
        mut,
        seeds = [b"task_validation", task.key().as_ref()],
        bump = task_validation_config.bump
    )]
    pub task_validation_config: Box<Account<'info, TaskValidationConfig>>,

    #[account(
        mut,
        seeds = [b"task_submission", claim.key().as_ref()],
        bump = task_submission.bump,
        constraint = task_submission.task == task.key() @ CoordinationError::TaskSubmissionRequired,
        constraint = task_submission.claim == claim.key() @ CoordinationError::TaskSubmissionRequired,
        constraint = task_submission.worker == worker.key() @ CoordinationError::TaskSubmissionRequired
    )]
    pub task_submission: Box<Account<'info, TaskSubmission>>,

    #[account(
        mut,
        seeds = [b"agent", worker.agent_id.as_ref()],
        bump = worker.bump
    )]
    pub worker: Box<Account<'info, AgentRegistration>>,

    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// CHECK: Protocol treasury account, validated against protocol config.
    #[account(
        mut,
        constraint = treasury.key() == protocol_config.treasury @ CoordinationError::InvalidInput
    )]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: Receives escrow rent on final settlement, validated against task.creator.
    #[account(
        mut,
        constraint = creator.key() == task.creator @ CoordinationError::InvalidCreator
    )]
    pub creator: Signer<'info>,

    /// CHECK: Receives reward payout, validated against worker.authority.
    #[account(
        mut,
        constraint = worker_authority.key() == worker.authority @ CoordinationError::UnauthorizedAgent
    )]
    pub worker_authority: UncheckedAccount<'info>,

    // === §4 operator leg (makes manual-review settlement hire-aware) ===
    /// CHECK: ["hire", task] record — optional, read-only. Pre-Batch-2 fallback for the
    /// operator-fee terms; for current hires the terms are read from the Task itself.
    pub hire_record: Option<UncheckedAccount<'info>>,
    /// CHECK: operator payee — validated == the task's resolved operator. Required only
    /// when the task carries a non-zero operator fee (a listing hire); receives the
    /// operator fee leg in SOL.
    #[account(mut)]
    pub operator: Option<UncheckedAccount<'info>>,
    /// CHECK: referrer payee — validated == the task's resolved referrer (P6.2 §4
    /// 4-way split). Required only when the task carries a non-zero referrer fee;
    /// receives the referrer fee leg in SOL.
    #[account(mut)]
    pub referrer: Option<UncheckedAccount<'info>>,

    // === Batch 3 completion bonds — REQUIRED + canonical-PDA-pinned (audit F12) ===
    // Refunded on accept. Made required + seeds-pinned (was Optional) so a Completed
    // transition can NEVER leave a live bond behind: if these were omittable, the bond
    // PDAs would survive into the terminal task, and close_task — which closes the Task
    // PDA — would then make reclaim_completion_bond (needs a live Task) impossible,
    // permanently stranding the bond principal. The caller passes the derived PDA even
    // for un-bonded tasks (an empty system account); settle_completion_bond no-ops on it.
    /// CHECK: creator completion bond PDA, seeds-pinned; validated + refunded by helper.
    #[cfg(not(feature = "mainnet-canary"))]
    #[account(
        mut,
        seeds = [b"completion_bond", task.key().as_ref(), creator.key().as_ref()],
        bump
    )]
    pub creator_completion_bond: UncheckedAccount<'info>,
    /// CHECK: worker completion bond PDA, seeds-pinned to the validated worker authority.
    #[cfg(not(feature = "mainnet-canary"))]
    #[account(
        mut,
        seeds = [b"completion_bond", task.key().as_ref(), worker_authority.key().as_ref()],
        bump
    )]
    pub worker_completion_bond: UncheckedAccount<'info>,

    // === Optional SPL Token accounts (only required for token-denominated tasks) ===
    #[cfg(feature = "spl-token-rewards")]
    #[account(mut)]
    pub token_escrow_ata: Option<Account<'info, TokenAccount>>,

    #[cfg(feature = "spl-token-rewards")]
    /// CHECK: Validated in handler; ATA may be created ahead of review settlement.
    #[account(mut)]
    pub worker_token_account: Option<UncheckedAccount<'info>>,

    #[cfg(feature = "spl-token-rewards")]
    #[account(mut)]
    pub treasury_token_account: Option<Account<'info, TokenAccount>>,

    #[cfg(feature = "spl-token-rewards")]
    pub reward_mint: Option<Account<'info, Mint>>,

    #[cfg(feature = "spl-token-rewards")]
    pub token_program: Option<Program<'info, Token>>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<AcceptTaskResult>) -> Result<()> {
    // Settlement path: accepting a submission resolves an in-flight, already-
    // escrowed task and pays the worker. It must work while the protocol is paused
    // or the type is disabled (both gate ENTRY only — spec §7, Decision #4 "money
    // never locks"); a pause must not strand escrowed funds mid-settlement.
    check_version_compatible_for_exit(&ctx.accounts.protocol_config)?;
    let clock = Clock::get()?;

    require!(
        ctx.accounts.task.status == TaskStatus::PendingValidation,
        CoordinationError::TaskNotPendingValidation
    );
    require!(
        is_manual_validation_task(&ctx.accounts.task),
        CoordinationError::TaskValidationConfigRequired
    );
    ensure_validation_config(
        &ctx.accounts.task_validation_config,
        &ctx.accounts.task.key(),
        &ctx.accounts.task,
    )?;
    ensure_validation_mode(
        &ctx.accounts.task_validation_config,
        ValidationMode::CreatorReview,
    )?;
    require!(
        ctx.accounts.task_submission.status == SubmissionStatus::Submitted,
        CoordinationError::SubmissionNotPending
    );
    // Batch 3 WS-CONTEST temporal partition (spec §3): a contest winner may be
    // accepted only strictly BEFORE `ghost_at` (afterwards the permissionless
    // ghost-split crank owns settlement), and only once every other live
    // submission has been rejected (losers' claim + submission rent must flow
    // back to them before the task can go terminal). No-op for non-contests.
    validate_contest_accept_window(&ctx.accounts.task, clock.unix_timestamp)?;

    validate_task_dependency(
        ctx.accounts.task.as_ref(),
        ctx.remaining_accounts,
        ctx.program_id,
    )?;
    decrement_pending_submission_count(&mut ctx.accounts.task_validation_config)?;
    note_submission_left_review(&mut ctx.accounts.task)?;

    #[cfg(not(feature = "mainnet-canary"))]
    let bid_completion_meta = load_bid_task_completion_meta(
        ctx.accounts.task.as_ref(),
        &ctx.accounts.task.key(),
        ctx.accounts.claim.as_ref(),
        ctx.remaining_accounts,
    )?;
    #[cfg(not(feature = "mainnet-canary"))]
    let reward_amount_override = bid_completion_meta
        .as_ref()
        .map(|meta| meta.accepted_bid_price);
    #[cfg(feature = "mainnet-canary")]
    let reward_amount_override = None;
    let protocol_fee_bps = calculate_fee_with_reputation(
        ctx.accounts.task.protocol_fee_bps,
        ctx.accounts.worker.reputation,
    );

    #[cfg(feature = "spl-token-rewards")]
    let token_accounts = if ctx.accounts.task.reward_mint.is_some() {
        require!(
            ctx.accounts.token_escrow_ata.is_some()
                && ctx.accounts.worker_token_account.is_some()
                && ctx.accounts.treasury_token_account.is_some()
                && ctx.accounts.reward_mint.is_some()
                && ctx.accounts.token_program.is_some(),
            CoordinationError::MissingTokenAccounts
        );

        let mint = ctx
            .accounts
            .reward_mint
            .as_mut()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        let token_escrow = ctx
            .accounts
            .token_escrow_ata
            .as_mut()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        let treasury_ta = ctx
            .accounts
            .treasury_token_account
            .as_ref()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        let expected_mint = ctx
            .accounts
            .task
            .reward_mint
            .ok_or(CoordinationError::InvalidTokenMint)?;

        require!(
            mint.key() == expected_mint,
            CoordinationError::InvalidTokenMint
        );
        validate_token_account(token_escrow, &mint.key(), &ctx.accounts.escrow.key())?;
        validate_token_account(
            treasury_ta,
            &mint.key(),
            &ctx.accounts.protocol_config.treasury,
        )?;
        let token_escrow_starting_amount =
            anchor_spl::token::accessor::amount(&token_escrow.to_account_info())
                .map_err(|_| CoordinationError::TokenTransferFailed)?;

        let worker_ta_info = ctx
            .accounts
            .worker_token_account
            .as_ref()
            .ok_or(CoordinationError::MissingTokenAccounts)?
            .to_account_info();
        validate_unchecked_token_mint(
            &worker_ta_info,
            &mint.key(),
            &ctx.accounts.worker_authority.key(),
        )?;

        Some(TokenPaymentAccounts {
            token_escrow_ata: token_escrow,
            token_escrow_starting_amount,
            worker_token_account: worker_ta_info,
            treasury_token_account: treasury_ta.to_account_info(),
            token_program: ctx
                .accounts
                .token_program
                .as_ref()
                .ok_or(CoordinationError::MissingTokenAccounts)?,
            escrow_authority: ctx.accounts.escrow.to_account_info(),
            escrow_bump: ctx.accounts.escrow.bump,
            task_key: ctx.accounts.task.key(),
        })
    } else {
        None
    };
    #[cfg(not(feature = "spl-token-rewards"))]
    let token_accounts = {
        require!(
            ctx.accounts.task.reward_mint.is_none(),
            CoordinationError::InvalidTokenMint
        );
        None
    };

    ctx.accounts.claim.proof_hash = ctx.accounts.task_submission.proof_hash;
    ctx.accounts.claim.result_data = ctx.accounts.task_submission.result_data;
    ctx.accounts.claim.is_completed = true;
    ctx.accounts.claim.is_validated = true;
    ctx.accounts.claim.completed_at = clock.unix_timestamp;

    // §4 3-way split on the manual-review path (Task-first, HireRecord fallback) — mirrors
    // complete_task so a hired task settled via CreatorReview still pays the operator leg.
    // The operator terms come from program-owned state (the Task, stamped at hire; or the
    // ["hire", task] record), so the leg can't be dodged; the accounts are optional so a
    // non-hired CreatorReview task (task.operator == default) settles unchanged with None.
    let accept_task_key = ctx.accounts.task.key();
    let (operator_pubkey, operator_fee_bps_resolved, referrer_pubkey, referrer_fee_bps_resolved) =
        if ctx.accounts.task.operator != Pubkey::default()
            || ctx.accounts.task.referrer != Pubkey::default()
        {
            (
                ctx.accounts.task.operator,
                ctx.accounts.task.operator_fee_bps,
                ctx.accounts.task.referrer,
                ctx.accounts.task.referrer_fee_bps,
            )
        } else if let Some(hr) = ctx.accounts.hire_record.as_ref() {
            if hr.owner == &crate::ID {
                let hire_info = hr.to_account_info();
                let hire = {
                    let data = hire_info.try_borrow_data()?;
                    HireRecord::try_deserialize(&mut &data[..])?
                };
                require!(
                    hire.task == accept_task_key,
                    CoordinationError::InvalidHireRecord
                );
                (
                    hire.operator,
                    hire.operator_fee_bps,
                    hire.referrer,
                    hire.referrer_fee_bps,
                )
            } else {
                (Pubkey::default(), 0, Pubkey::default(), 0)
            }
        } else {
            (Pubkey::default(), 0, Pubkey::default(), 0)
        };
    let operator_leg = if operator_fee_bps_resolved > 0 && operator_pubkey != Pubkey::default() {
        let op = ctx
            .accounts
            .operator
            .as_ref()
            .ok_or(CoordinationError::MissingOperatorAccount)?;
        require!(
            op.key() == operator_pubkey,
            CoordinationError::InvalidOperatorAccount
        );
        Some(OperatorLeg {
            payee: op.to_account_info(),
            fee_bps: operator_fee_bps_resolved,
        })
    } else {
        None
    };
    let referrer_leg = build_referrer_leg(
        referrer_pubkey,
        referrer_fee_bps_resolved,
        ctx.accounts.referrer.as_ref().map(|r| r.as_ref()),
    )?;

    execute_completion_rewards(
        &mut ctx.accounts.task,
        &mut ctx.accounts.claim,
        &mut ctx.accounts.escrow,
        &mut ctx.accounts.worker,
        &mut ctx.accounts.protocol_config,
        &ctx.accounts.worker_authority.to_account_info(),
        &ctx.accounts.treasury.to_account_info(),
        &ctx.accounts.creator.to_account_info(),
        protocol_fee_bps,
        reward_amount_override,
        Some(ctx.accounts.task_submission.result_data),
        &clock,
        token_accounts,
        operator_leg,
        referrer_leg,
    )?;

    ctx.accounts.task_submission.status = SubmissionStatus::Accepted;
    ctx.accounts.task_submission.accepted_at = clock.unix_timestamp;
    ctx.accounts.task_submission.rejected_at = 0;
    ctx.accounts.task_submission.rejection_hash = [0u8; 32];
    if ctx.accounts.task.status != TaskStatus::Completed {
        sync_task_validation_status(&mut ctx.accounts.task, &ctx.accounts.task_validation_config);
    }

    emit!(TaskResultAccepted {
        task: ctx.accounts.task.key(),
        claim: ctx.accounts.claim.key(),
        worker: ctx.accounts.worker.key(),
        accepted_by: ctx.accounts.creator.key(),
        accepted_at: clock.unix_timestamp,
    });

    #[cfg(not(feature = "mainnet-canary"))]
    if let Some(meta) = bid_completion_meta {
        finalize_bid_task_completion(
            ctx.remaining_accounts,
            &ctx.accounts.task.key(),
            ctx.accounts.claim.as_ref(),
            &meta,
            clock.unix_timestamp,
        )?;
    }

    ctx.accounts
        .claim
        .close(ctx.accounts.worker_authority.to_account_info())?;

    // Batch 3 WS-CONTEST §1 (submission-rent return, ALL task types): the worker
    // funded the TaskSubmission PDA — close it back to them at settle instead of
    // leaving its rent for the close_task sweep.
    ctx.accounts
        .task_submission
        .close(ctx.accounts.worker_authority.to_account_info())?;

    // Batch 3 §8: an accepted result means nobody lost — refund BOTH bonds. Required +
    // seeds-pinned accounts (audit F12), so this ALWAYS runs and a live bond can never
    // survive the Completed transition; settle no-ops on an un-bonded task's empty PDA.
    #[cfg(not(feature = "mainnet-canary"))]
    {
        let task_key = ctx.accounts.task.key();
        settle_completion_bond(
            &ctx.accounts.creator_completion_bond.to_account_info(),
            &ctx.accounts.creator.to_account_info(),
            &task_key,
            CompletionBond::ROLE_CREATOR,
            BondDisposition::Refund,
        )?;
        settle_completion_bond(
            &ctx.accounts.worker_completion_bond.to_account_info(),
            &ctx.accounts.worker_authority.to_account_info(),
            &task_key,
            CompletionBond::ROLE_WORKER,
            BondDisposition::Refund,
        )?;
    }

    Ok(())
}
