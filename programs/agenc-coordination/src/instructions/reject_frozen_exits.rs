//! Exits for a RejectFrozen task (Batch 3 §8). A task frozen by `reject_and_freeze`
//! has NO other settlement path, so without these its escrow + claim + bonds would
//! strand. Both are exit paths (money-never-locks): they call
//! `check_version_compatible_for_exit` so a paused protocol still settles.
//!
//! A frozen task is ALWAYS a manual (CreatorReview) task, and hired tasks cannot be
//! manual-validated (HiredTaskValidationUnsupported), so `task.operator` is always
//! default here — the worker payout is the plain SOL 2-way split (operator_leg=None),
//! identical to `accept_task_result`.

use crate::errors::CoordinationError;
use crate::events::{RejectFrozenExpired, RejectFrozenResolved};
use crate::instructions::bond_helpers::{settle_completion_bond, BondDisposition};
use crate::instructions::completion_helpers::{
    calculate_fee_with_reputation, execute_completion_rewards,
};
use crate::state::{
    AgentRegistration, CompletionBond, ProtocolConfig, SubmissionStatus, Task, TaskClaim,
    TaskEscrow, TaskStatus, TaskSubmission,
};
use crate::utils::multisig::{require_multisig_threshold, unique_account_infos};
use crate::utils::version::check_version_compatible_for_exit;
use anchor_lang::prelude::*;

// =============================== resolve_reject_frozen ===============================

#[derive(Accounts)]
pub struct ResolveRejectFrozen<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        mut,
        seeds = [b"claim", task.key().as_ref(), claim.worker.as_ref()],
        bump = claim.bump,
        constraint = claim.task == task.key() @ CoordinationError::NotClaimed
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
        seeds = [b"task_submission", claim.key().as_ref()],
        bump = task_submission.bump,
        constraint = task_submission.task == task.key() @ CoordinationError::TaskSubmissionRequired
    )]
    pub task_submission: Box<Account<'info, TaskSubmission>>,

    #[account(
        mut,
        seeds = [b"agent", worker.agent_id.as_ref()],
        bump = worker.bump,
        constraint = worker.key() == claim.worker @ CoordinationError::UnauthorizedAgent
    )]
    pub worker: Box<Account<'info, AgentRegistration>>,

    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// CHECK: protocol treasury (protocol fee on a Completed outcome).
    #[account(
        mut,
        constraint = treasury.key() == protocol_config.treasury @ CoordinationError::InvalidInput
    )]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: task creator — escrow refund recipient on Cancelled; validated to task.creator.
    #[account(
        mut,
        constraint = creator.key() == task.creator @ CoordinationError::InvalidCreator
    )]
    pub creator: UncheckedAccount<'info>,

    /// CHECK: worker payout + claim-rent recipient; validated to worker.authority.
    #[account(
        mut,
        constraint = worker_authority.key() == worker.authority @ CoordinationError::UnauthorizedAgent
    )]
    pub worker_authority: UncheckedAccount<'info>,

    /// Multisig review authority; `remaining_accounts` carries the co-signers.
    pub authority: Signer<'info>,

    /// CHECK: creator completion bond PDA — REQUIRED + seeds-fixed so the multisig
    /// cannot omit a live bond to dodge the forfeit (audit). settle no-ops if no bond
    /// was posted (the empty PDA). Forfeits go to `treasury` (== protocol_config.treasury).
    #[account(
        mut,
        seeds = [b"completion_bond", task.key().as_ref(), creator.key().as_ref()],
        bump
    )]
    pub creator_completion_bond: UncheckedAccount<'info>,
    /// CHECK: worker completion bond PDA — REQUIRED + seeds-fixed (same rationale).
    #[account(
        mut,
        seeds = [b"completion_bond", task.key().as_ref(), worker_authority.key().as_ref()],
        bump
    )]
    pub worker_completion_bond: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Multisig review decision on a frozen task. `approve_completion`:
/// - true  -> the rejection is overturned: pay the worker, refund the worker bond,
///   forfeit the creator bond to treasury.
/// - false -> the rejection is upheld: refund the creator, forfeit the worker bond to
///   treasury, refund the creator bond.
pub fn resolve_handler(
    ctx: Context<ResolveRejectFrozen>,
    approve_completion: bool,
) -> Result<()> {
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::MultisigNotEnoughSigners
    );
    let unique_signers = unique_account_infos(ctx.remaining_accounts);
    require_multisig_threshold(&ctx.accounts.protocol_config, &unique_signers)?;
    // Exit path: a frozen task must settle even while paused (money never locks).
    check_version_compatible_for_exit(&ctx.accounts.protocol_config)?;
    let clock = Clock::get()?;

    require!(
        ctx.accounts.task.status == TaskStatus::RejectFrozen,
        CoordinationError::TaskNotRejectFrozen
    );

    let task_key = ctx.accounts.task.key();
    let creator_info = ctx.accounts.creator.to_account_info();
    let worker_auth_info = ctx.accounts.worker_authority.to_account_info();
    // Forfeits go to the protocol treasury (already validated == protocol_config.treasury).
    let treasury_info = ctx.accounts.treasury.to_account_info();

    if approve_completion {
        // Worker vindicated: pay the worker (SOL 2-way, no operator leg on a manual task).
        let protocol_fee_bps = calculate_fee_with_reputation(
            ctx.accounts.task.protocol_fee_bps,
            ctx.accounts.worker.reputation,
        );
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
            &worker_auth_info,
            &ctx.accounts.treasury.to_account_info(),
            &creator_info,
            protocol_fee_bps,
            None,
            Some(ctx.accounts.task_submission.result_data),
            &clock,
            None,
            None,
        )?;

        ctx.accounts.task_submission.status = SubmissionStatus::Accepted;
        ctx.accounts.task_submission.accepted_at = clock.unix_timestamp;

        // Worker vindicated: refund the worker bond, forfeit the creator bond to
        // treasury. Bonds are required+seeds-fixed, so the multisig cannot omit them
        // to dodge the forfeit; settle no-ops when no bond was posted.
        settle_completion_bond(
            &ctx.accounts.worker_completion_bond.to_account_info(),
            &worker_auth_info,
            &task_key,
            CompletionBond::ROLE_WORKER,
            BondDisposition::Refund,
        )?;
        settle_completion_bond(
            &ctx.accounts.creator_completion_bond.to_account_info(),
            &creator_info,
            &task_key,
            CompletionBond::ROLE_CREATOR,
            BondDisposition::Forfeit {
                recipient: &treasury_info,
            },
        )?;

        emit!(RejectFrozenResolved {
            task: task_key,
            outcome: 1,
            timestamp: clock.unix_timestamp,
        });
    } else {
        // Rejection upheld: refund the creator the full escrow; the worker forfeits.
        ctx.accounts.task.status = TaskStatus::Cancelled;

        // Rejection upheld: forfeit the worker bond to treasury, refund the creator bond.
        settle_completion_bond(
            &ctx.accounts.worker_completion_bond.to_account_info(),
            &worker_auth_info,
            &task_key,
            CompletionBond::ROLE_WORKER,
            BondDisposition::Forfeit {
                recipient: &treasury_info,
            },
        )?;
        settle_completion_bond(
            &ctx.accounts.creator_completion_bond.to_account_info(),
            &creator_info,
            &task_key,
            CompletionBond::ROLE_CREATOR,
            BondDisposition::Refund,
        )?;

        // Close the escrow to the creator — refunds the full reward + rent.
        ctx.accounts.escrow.is_closed = true;
        ctx.accounts.escrow.close(creator_info.clone())?;

        emit!(RejectFrozenResolved {
            task: task_key,
            outcome: 0,
            timestamp: clock.unix_timestamp,
        });
    }

    // Return the claim rent to the worker who funded it.
    ctx.accounts.claim.close(worker_auth_info)?;

    Ok(())
}

// =============================== expire_reject_frozen ===============================

#[derive(Accounts)]
pub struct ExpireRejectFrozen<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        mut,
        seeds = [b"claim", task.key().as_ref(), claim.worker.as_ref()],
        bump = claim.bump,
        constraint = claim.task == task.key() @ CoordinationError::NotClaimed
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
        seeds = [b"task_submission", claim.key().as_ref()],
        bump = task_submission.bump,
        constraint = task_submission.task == task.key() @ CoordinationError::TaskSubmissionRequired
    )]
    pub task_submission: Box<Account<'info, TaskSubmission>>,

    #[account(
        mut,
        seeds = [b"agent", worker.agent_id.as_ref()],
        bump = worker.bump,
        constraint = worker.key() == claim.worker @ CoordinationError::UnauthorizedAgent
    )]
    pub worker: Box<Account<'info, AgentRegistration>>,

    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// CHECK: protocol treasury (protocol fee on the default worker payout).
    #[account(
        mut,
        constraint = treasury.key() == protocol_config.treasury @ CoordinationError::InvalidInput
    )]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: task creator (escrow close residual / rent); validated to task.creator.
    #[account(
        mut,
        constraint = creator.key() == task.creator @ CoordinationError::InvalidCreator
    )]
    pub creator: UncheckedAccount<'info>,

    /// CHECK: worker payout + claim-rent recipient; validated to worker.authority.
    #[account(
        mut,
        constraint = worker_authority.key() == worker.authority @ CoordinationError::UnauthorizedAgent
    )]
    pub worker_authority: UncheckedAccount<'info>,

    /// Permissionless caller.
    pub authority: Signer<'info>,

    /// CHECK: optional creator completion bond PDA; refunded (no-fault).
    #[account(mut)]
    pub creator_completion_bond: Option<UncheckedAccount<'info>>,
    /// CHECK: optional worker completion bond PDA; refunded (no-fault).
    #[account(mut)]
    pub worker_completion_bond: Option<UncheckedAccount<'info>>,

    pub system_program: Program<'info, System>,
}

/// Permissionless timeout: once the review window lapses with no multisig decision,
/// a frozen task defaults to the WORKER (the creator failed to adjudicate). Pays the
/// worker and refunds BOTH bonds (no fault established).
pub fn expire_handler(ctx: Context<ExpireRejectFrozen>) -> Result<()> {
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::InvalidInput
    );
    // Exit path: must settle even while paused.
    check_version_compatible_for_exit(&ctx.accounts.protocol_config)?;
    let clock = Clock::get()?;

    require!(
        ctx.accounts.task.status == TaskStatus::RejectFrozen,
        CoordinationError::TaskNotRejectFrozen
    );
    require!(
        clock.unix_timestamp > ctx.accounts.task_submission.review_deadline_at,
        CoordinationError::RejectFrozenTimeoutNotElapsed
    );

    let task_key = ctx.accounts.task.key();
    let worker_auth_info = ctx.accounts.worker_authority.to_account_info();
    let creator_info = ctx.accounts.creator.to_account_info();

    let protocol_fee_bps = calculate_fee_with_reputation(
        ctx.accounts.task.protocol_fee_bps,
        ctx.accounts.worker.reputation,
    );
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
        &worker_auth_info,
        &ctx.accounts.treasury.to_account_info(),
        &creator_info,
        protocol_fee_bps,
        None,
        Some(ctx.accounts.task_submission.result_data),
        &clock,
        None,
        None,
    )?;

    ctx.accounts.task_submission.status = SubmissionStatus::Accepted;
    ctx.accounts.task_submission.accepted_at = clock.unix_timestamp;
    // Report the ACTUAL lamports paid to the worker (reward minus protocol fee), not
    // the gross escrow — execute_completion_rewards records it on the claim.
    let worker_payout = ctx.accounts.claim.reward_paid;

    // No fault on a timeout: refund BOTH bonds to their posters.
    if let Some(bond) = ctx.accounts.worker_completion_bond.as_ref() {
        settle_completion_bond(
            &bond.to_account_info(),
            &worker_auth_info,
            &task_key,
            CompletionBond::ROLE_WORKER,
            BondDisposition::Refund,
        )?;
    }
    if let Some(bond) = ctx.accounts.creator_completion_bond.as_ref() {
        settle_completion_bond(
            &bond.to_account_info(),
            &creator_info,
            &task_key,
            CompletionBond::ROLE_CREATOR,
            BondDisposition::Refund,
        )?;
    }

    ctx.accounts.claim.close(worker_auth_info)?;

    emit!(RejectFrozenExpired {
        task: task_key,
        worker_payout,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
