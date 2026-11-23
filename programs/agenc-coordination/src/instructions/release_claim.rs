//! Revision 9 (E): a worker gives up an undelivered claim before it expires.
//!
//! Every non-contest claim carries a deposit (`claim_task_with_job_spec`). A
//! worker that cannot do the job (for example because the spec content is gone)
//! may release the claim at once instead of waiting for `deadline + 1 hour`:
//! within `CLAIM_RELEASE_GRACE_SECS` of claiming the deposit comes back; later
//! it goes to the buyer and the worker's record counts an expired claim. The slot
//! is freed and the task status resynced as `expire_claim` does.
//!
//! Not for delivered work under review (a Submitted submission), a claim with a
//! live completion bond, contests (their entry deposit has its own rules) or bid
//! claims (bid bond). Exit gate: a pause must not trap a worker in a claim.

use crate::errors::CoordinationError;
use crate::events::ClaimReleased;
use crate::instructions::agent_stats_helpers::Counter;
use crate::instructions::claim_deposit_helpers::{
    forfeit_claim_deposit, refund_claim_deposit, release_refunds_deposit,
};
use crate::instructions::close_task::completion_bond_is_live;
use crate::instructions::record_account_helpers::{count_agent_stats, ensure_agent_stats};
use crate::instructions::task_validation_helpers::{
    ensure_validation_config, is_contest_configured_task, is_manual_validation_task,
    release_claim_slot, sync_task_validation_status,
};
use crate::state::{
    AgentRegistration, ProtocolConfig, SubmissionStatus, Task, TaskClaim, TaskStatus,
    TaskSubmission, TaskType, TaskValidationConfig,
};
use crate::utils::version::check_version_compatible_for_exit;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ReleaseClaim<'info> {
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

    /// The claim's worker; only its own wallet can release.
    #[account(
        mut,
        seeds = [b"agent", worker.agent_id.as_ref()],
        bump = worker.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub worker: Box<Account<'info, AgentRegistration>>,

    /// CHECK: seeds-pinned to the claim. Must be empty (no delivery) or hold a
    /// Rejected submission of this claim (bounced by a change request), which is
    /// closed to the worker. Inspected in the handler.
    #[account(
        mut,
        seeds = [b"task_submission", claim.key().as_ref()],
        bump
    )]
    pub task_submission: UncheckedAccount<'info>,

    /// Required for a manual-validation task, to resync its status.
    #[account(
        seeds = [b"task_validation", task.key().as_ref()],
        bump = task_validation_config.bump
    )]
    pub task_validation_config: Option<Box<Account<'info, TaskValidationConfig>>>,

    /// CHECK: seeds-pinned `["completion_bond", task, authority]`; must not hold a
    /// live bond (a bonded claim settles through its own paths).
    #[account(
        seeds = [b"completion_bond", task.key().as_ref(), authority.key().as_ref()],
        bump
    )]
    pub worker_completion_bond: UncheckedAccount<'info>,

    /// CHECK: validated against `task.creator`; receives a deposit released after
    /// the grace.
    #[account(
        mut,
        constraint = creator.key() == task.creator @ CoordinationError::InvalidCreator
    )]
    pub creator: UncheckedAccount<'info>,

    /// CHECK: revision 9 worker record `["agent_stats", worker.key()]`, seeds-pinned
    /// here. A release after the grace bumps `claims_expired`. Created when missing
    /// by `ensure_agent_stats`, paid by `authority`.
    #[account(mut, seeds = [b"agent_stats", worker.key().as_ref()], bump)]
    pub worker_stats: UncheckedAccount<'info>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// The worker wallet: gets the claim rent (and the deposit within the grace).
    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// The task states a claim can be released from: live work, not a dispute, a
/// freeze or a terminal task.
fn releasable_task_status(status: TaskStatus) -> bool {
    matches!(
        status,
        TaskStatus::InProgress | TaskStatus::PendingValidation
    )
}

pub fn handler(ctx: Context<ReleaseClaim>) -> Result<()> {
    release(ctx, None)
}

pub fn release_to(ctx: Context<ReleaseClaim>, recipient: Pubkey) -> Result<()> {
    release(ctx, Some(recipient))
}

fn release(ctx: Context<ReleaseClaim>, recipient: Option<Pubkey>) -> Result<()> {
    check_version_compatible_for_exit(&ctx.accounts.protocol_config)?;
    let now = Clock::get()?.unix_timestamp;
    // Create a missing record first: the create is a CPI, and a CPI made after
    // this handler moves lamports directly fails (UnbalancedInstruction).
    ensure_agent_stats(
        &ctx.accounts.worker_stats.to_account_info(),
        &ctx.accounts.authority.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        ctx.accounts.worker.key(),
        ctx.bumps.worker_stats,
    )?;

    let task_key = ctx.accounts.task.key();
    let claim_key = ctx.accounts.claim.key();
    let worker_key = ctx.accounts.worker.key();
    {
        let task = ctx.accounts.task.as_ref();
        let claim = ctx.accounts.claim.as_ref();
        require!(
            releasable_task_status(task.status),
            CoordinationError::ClaimNotReleasable
        );
        require!(!claim.is_completed, CoordinationError::ClaimNotReleasable);
        require!(
            claim.expires_at > 0 && now <= claim.expires_at,
            CoordinationError::ClaimNotReleasable
        );
        require!(
            !is_contest_configured_task(task) && task.task_type != TaskType::BidExclusive,
            CoordinationError::ClaimNotReleasable
        );
        // Review R3-6: only a live bond blocks the release. A settled bond's
        // tombstone stays program-owned and anyone can send it lamports; it is
        // not a bond, as `close_task` reads it.
        require!(
            !completion_bond_is_live(&ctx.accounts.worker_completion_bond.to_account_info())?,
            CoordinationError::ClaimNotReleasable
        );
    }

    // Delivered work under review cannot be walked away from; a submission
    // bounced by a change request is closed with the claim.
    let submission_info = ctx.accounts.task_submission.to_account_info();
    let close_submission = if submission_info.owner == &anchor_lang::system_program::ID
        && submission_info.data_is_empty()
    {
        false
    } else if submission_info.owner == &crate::ID {
        let submission = {
            let data = submission_info.try_borrow_data()?;
            TaskSubmission::try_deserialize(&mut &data[..])
                .map_err(|_| error!(CoordinationError::ClaimNotReleasable))?
        };
        require!(
            submission.claim == claim_key
                && submission.task == task_key
                && submission.status == SubmissionStatus::Rejected,
            CoordinationError::ClaimNotReleasable
        );
        true
    } else {
        return err!(CoordinationError::ClaimNotReleasable);
    };

    // 1. The deposit: back to the worker within the grace, else to the buyer
    // (and the worker's record counts an expired claim). Review R1-1: after a
    // dispute was filed on the task a late release still refunds it (the
    // record still counts the late release).
    let late = !release_refunds_deposit(ctx.accounts.claim.claimed_at, now);
    let deposit_refunded = !late || ctx.accounts.task.dispute_filed();
    if let Some(approved) = recipient {
        let actual = if deposit_refunded { ctx.accounts.authority.key() } else { ctx.accounts.creator.key() };
        require_keys_eq!(approved, actual, CoordinationError::ClaimNotReleasable);
    }
    let claim_info = ctx.accounts.claim.to_account_info();
    if late {
        count_agent_stats(
            &ctx.accounts.worker_stats.to_account_info(),
            worker_key,
            Counter::ClaimsExpired,
            now,
        )?;
    }
    if deposit_refunded {
        refund_claim_deposit(
            &claim_info,
            &ctx.accounts.authority.to_account_info(),
            &ctx.accounts.task,
            task_key,
            worker_key,
            now,
        )?;
    } else {
        // Review R1-2 / R2-3: exactly the posted deposit; anything else closes
        // to the worker with the claim.
        forfeit_claim_deposit(
            &claim_info,
            &ctx.accounts.creator.to_account_info(),
            &ctx.accounts.task,
            task_key,
            worker_key,
            now,
        )?;
    }

    // 2. A bounced (Rejected) submission carries no review counters; return its
    // rent to the worker and tombstone it.
    if close_submission {
        let lamports = submission_info.lamports();
        let authority_info = ctx.accounts.authority.to_account_info();
        **submission_info.try_borrow_mut_lamports()? = 0;
        **authority_info.try_borrow_mut_lamports()? = authority_info
            .lamports()
            .checked_add(lamports)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        let mut data = submission_info.try_borrow_mut_data()?;
        data.fill(0);
        data[..8].copy_from_slice(&[255u8; 8]);
    }

    // 3 and 4. Free the slot and resync the status as `expire_claim` does.
    let task = ctx.accounts.task.as_mut();
    release_claim_slot(task, ctx.accounts.worker.as_mut(), now)?;
    if is_manual_validation_task(task) {
        let validation_config = ctx
            .accounts
            .task_validation_config
            .as_ref()
            .ok_or(CoordinationError::TaskValidationConfigRequired)?;
        ensure_validation_config(validation_config, &task_key, task)?;
        sync_task_validation_status(task, validation_config);
    } else if task.current_workers == 0 && task.status == TaskStatus::InProgress {
        task.status = TaskStatus::Open;
    }

    // 5. Close the claim to the worker wallet.
    ctx.accounts
        .claim
        .close(ctx.accounts.authority.to_account_info())?;

    emit!(ClaimReleased {
        task: task_key,
        claim: claim_key,
        worker_agent: worker_key,
        deposit_refunded,
        timestamp: now,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_live_work_is_releasable() {
        assert!(releasable_task_status(TaskStatus::InProgress));
        assert!(releasable_task_status(TaskStatus::PendingValidation));
        for status in [
            TaskStatus::Open,
            TaskStatus::Disputed,
            TaskStatus::RejectFrozen,
            TaskStatus::Completed,
            TaskStatus::Cancelled,
        ] {
            assert!(!releasable_task_status(status));
        }
        assert_eq!(u32::from(CoordinationError::ClaimNotReleasable), 6427);
    }
}
