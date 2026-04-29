//! Accept a Task Validation V2 submission and settle the task reward.

use crate::errors::CoordinationError;
use crate::events::TaskResultAccepted;
use crate::instructions::bid_settlement_helpers::{
    finalize_bid_task_completion, load_bid_task_completion_meta,
};
use crate::instructions::completion_helpers::TokenPaymentAccounts;
use crate::instructions::completion_helpers::{
    calculate_fee_with_reputation, execute_completion_rewards, validate_task_dependency,
};
use crate::instructions::launch_controls::require_task_type_enabled;
use crate::instructions::task_validation_helpers::{
    decrement_pending_submission_count, ensure_validation_config, ensure_validation_mode,
    is_manual_validation_task, sync_task_validation_status,
};
use crate::instructions::token_helpers::{validate_token_account, validate_unchecked_token_mint};
use crate::state::{
    AgentRegistration, ProtocolConfig, SubmissionStatus, Task, TaskClaim, TaskEscrow, TaskStatus,
    TaskSubmission, TaskValidationConfig, ValidationMode,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;
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

    // === Optional SPL Token accounts (only required for token-denominated tasks) ===
    #[account(mut)]
    pub token_escrow_ata: Option<Account<'info, TokenAccount>>,

    /// CHECK: Validated in handler; ATA may be created ahead of review settlement.
    #[account(mut)]
    pub worker_token_account: Option<UncheckedAccount<'info>>,

    #[account(mut)]
    pub treasury_token_account: Option<Account<'info, TokenAccount>>,

    pub reward_mint: Option<Account<'info, Mint>>,

    pub token_program: Option<Program<'info, Token>>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<AcceptTaskResult>) -> Result<()> {
    check_version_compatible(&ctx.accounts.protocol_config)?;
    require_task_type_enabled(&ctx.accounts.protocol_config, ctx.accounts.task.task_type)?;
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

    Ok(())
}
