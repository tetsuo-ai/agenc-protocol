//! Auto-accept a creator-reviewed submission after the review window expires.

use crate::errors::CoordinationError;
use crate::events::TaskResultAccepted;
use crate::instructions::bid_settlement_helpers::{
    finalize_bid_task_completion, load_bid_task_completion_meta,
};
#[cfg(not(feature = "mainnet-canary"))]
use crate::instructions::bond_helpers::{settle_completion_bond, BondDisposition};
use crate::instructions::completion_helpers::TokenPaymentAccounts;
use crate::instructions::completion_helpers::{
    calculate_fee_with_reputation, execute_completion_rewards, validate_task_dependency,
    OperatorLeg,
};
use crate::instructions::task_validation_helpers::{
    decrement_pending_submission_count, ensure_validation_config, ensure_validation_mode,
    is_manual_validation_task, sync_task_validation_status,
};
use crate::instructions::token_helpers::{validate_token_account, validate_unchecked_token_mint};
#[cfg(not(feature = "mainnet-canary"))]
use crate::state::CompletionBond;
use crate::state::{
    AgentRegistration, HireRecord, ProtocolConfig, SubmissionStatus, Task, TaskClaim, TaskEscrow,
    TaskStatus, TaskSubmission, TaskValidationConfig, ValidationMode,
};
use crate::utils::version::check_version_compatible_for_exit;
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(Accounts)]
pub struct AutoAcceptTaskResult<'info> {
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
    pub creator: UncheckedAccount<'info>,

    /// CHECK: Receives reward payout, validated against worker.authority.
    #[account(
        mut,
        constraint = worker_authority.key() == worker.authority @ CoordinationError::UnauthorizedAgent
    )]
    pub worker_authority: UncheckedAccount<'info>,

    // === §4 operator leg (makes timeout auto-accept hire-aware) ===
    /// CHECK: ["hire", task] record — optional, read-only; pre-Batch-2 fallback for the
    /// operator-fee terms (current hires read them from the Task itself).
    pub hire_record: Option<UncheckedAccount<'info>>,
    /// CHECK: operator payee — validated == the task's resolved operator. Required only
    /// when the task carries a non-zero operator fee; receives the operator leg (SOL).
    #[account(mut)]
    pub operator: Option<UncheckedAccount<'info>>,

    // === Batch 3 completion bonds (optional; refunded on auto-accept) ===
    /// CHECK: creator completion bond PDA; refunded on auto-accept. Validated by helper.
    #[cfg(not(feature = "mainnet-canary"))]
    #[account(mut)]
    pub creator_completion_bond: Option<UncheckedAccount<'info>>,
    /// CHECK: worker completion bond PDA; refunded on auto-accept.
    #[cfg(not(feature = "mainnet-canary"))]
    #[account(mut)]
    pub worker_completion_bond: Option<UncheckedAccount<'info>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub token_escrow_ata: Option<Account<'info, TokenAccount>>,

    /// CHECK: Validated in handler; ATA may be created ahead of settlement.
    #[account(mut)]
    pub worker_token_account: Option<UncheckedAccount<'info>>,

    #[account(mut)]
    pub treasury_token_account: Option<Account<'info, TokenAccount>>,

    pub reward_mint: Option<Account<'info, Mint>>,

    pub token_program: Option<Program<'info, Token>>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<AutoAcceptTaskResult>) -> Result<()> {
    // Settlement path: timeout auto-acceptance resolves an in-flight, already-
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
    require!(
        clock.unix_timestamp >= ctx.accounts.task_submission.review_deadline_at,
        CoordinationError::ReviewWindowNotElapsed
    );

    validate_task_dependency(
        ctx.accounts.task.as_ref(),
        ctx.remaining_accounts,
        ctx.program_id,
    )?;
    decrement_pending_submission_count(&mut ctx.accounts.task_validation_config)?;

    let bid_completion_meta = load_bid_task_completion_meta(
        ctx.accounts.task.as_ref(),
        &ctx.accounts.task.key(),
        ctx.accounts.claim.as_ref(),
        ctx.remaining_accounts,
    )?;
    let reward_amount_override = bid_completion_meta
        .as_ref()
        .map(|meta| meta.accepted_bid_price);
    let protocol_fee_bps = calculate_fee_with_reputation(
        ctx.accounts.task.protocol_fee_bps,
        ctx.accounts.worker.reputation,
    );

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

    ctx.accounts.claim.proof_hash = ctx.accounts.task_submission.proof_hash;
    ctx.accounts.claim.result_data = ctx.accounts.task_submission.result_data;
    ctx.accounts.claim.is_completed = true;
    ctx.accounts.claim.is_validated = true;
    ctx.accounts.claim.completed_at = clock.unix_timestamp;

    // §4 3-way split on the timeout auto-accept path (Task-first, HireRecord fallback) — so a
    // hired task whose human buyer ghosts past the review window still pays the operator leg.
    // Optional accounts: a non-hired task (task.operator == default) settles unchanged with None.
    let auto_accept_task_key = ctx.accounts.task.key();
    let (operator_pubkey, operator_fee_bps_resolved) =
        if ctx.accounts.task.operator != Pubkey::default() {
            (
                ctx.accounts.task.operator,
                ctx.accounts.task.operator_fee_bps,
            )
        } else if let Some(hr) = ctx.accounts.hire_record.as_ref() {
            if hr.owner == &crate::ID {
                let hire_info = hr.to_account_info();
                let hire = {
                    let data = hire_info.try_borrow_data()?;
                    HireRecord::try_deserialize(&mut &data[..])?
                };
                require!(
                    hire.task == auto_accept_task_key,
                    CoordinationError::InvalidHireRecord
                );
                (hire.operator, hire.operator_fee_bps)
            } else {
                (Pubkey::default(), 0)
            }
        } else {
            (Pubkey::default(), 0)
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
        accepted_by: ctx.accounts.authority.key(),
        accepted_at: clock.unix_timestamp,
    });

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

    // Batch 3 §8: auto-accept is a success — refund BOTH completion bonds.
    #[cfg(not(feature = "mainnet-canary"))]
    {
        let task_key = ctx.accounts.task.key();
        if let Some(bond) = ctx.accounts.creator_completion_bond.as_ref() {
            settle_completion_bond(
                &bond.to_account_info(),
                &ctx.accounts.creator.to_account_info(),
                &task_key,
                CompletionBond::ROLE_CREATOR,
                BondDisposition::Refund,
            )?;
        }
        if let Some(bond) = ctx.accounts.worker_completion_bond.as_ref() {
            settle_completion_bond(
                &bond.to_account_info(),
                &ctx.accounts.worker_authority.to_account_info(),
                &task_key,
                CompletionBond::ROLE_WORKER,
                BondDisposition::Refund,
            )?;
        }
    }

    Ok(())
}
