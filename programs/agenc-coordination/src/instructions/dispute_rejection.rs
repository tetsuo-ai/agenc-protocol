//! Revision 9 (A, B): the worker disputes a revision 9 freeze.
//!
//! `reject_and_freeze` made by revision 9 (`freeze_kind == FREEZE_KIND_DISPUTABLE`)
//! opens a fixed dispute window (`REJECT_DISPUTE_WINDOW_SECS`). Inside it the
//! worker may dispute the rejection once, by posting a bond of
//! `max(10% of the price, 0.01 SOL)` into a `DisputeBond` at
//! `["dispute_bond", task]`. The 2-of-3 multisig then has
//! `REJECT_RULING_WINDOW_SECS` to rule with `resolve_reject_frozen`; with no
//! ruling, `expire_reject_frozen` refunds the buyer and returns the bond.
//!
//! The task stays `RejectFrozen` the whole time, so `cancel_task`, `close_task`
//! and `expire_claim` keep refusing it, and no status transition is added. A
//! second dispute fails at `init` because the bond address is taken. The bond
//! address may already hold lamports someone sent to it; Anchor's `init`
//! allocates over such an address, so that cannot block a dispute.
//!
//! Exit gate: a pause must not make the worker miss its window. A suspended
//! worker cannot dispute; any other agent status can.

use crate::errors::CoordinationError;
use crate::events::{CreatorTrackRecordUpdated, RejectionDisputed};
use crate::instructions::constants::{FREEZE_KIND_DISPUTABLE, REJECT_RULING_WINDOW_SECS};
use crate::instructions::creator_stats_helpers::{bump_creator_counter, CreatorCounter};
use crate::instructions::dispute_bond_helpers::dispute_bond_for_task;
use crate::instructions::reject_frozen_exits::rejection_dispute_window_open;
use crate::state::{
    AgentRegistration, AgentStatus, CreatorStats, DisputeBond, ProtocolConfig, SubmissionStatus,
    Task, TaskClaim, TaskStatus, TaskSubmission, HASH_SIZE,
};
use crate::utils::version::check_version_compatible_for_exit;
use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

/// Maximum byte length of the dispute's evidence pointer (same as a task dispute).
pub const MAX_REJECTION_EVIDENCE_URI_LEN: usize = 256;

#[derive(Accounts)]
pub struct DisputeRejection<'info> {
    #[account(
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        seeds = [b"claim", task.key().as_ref(), claim.worker.as_ref()],
        bump = claim.bump,
        constraint = claim.task == task.key() @ CoordinationError::NotClaimed
    )]
    pub claim: Box<Account<'info, TaskClaim>>,

    #[account(
        seeds = [b"task_submission", claim.key().as_ref()],
        bump = task_submission.bump,
        constraint = task_submission.task == task.key() @ CoordinationError::TaskSubmissionRequired,
        constraint = task_submission.claim == claim.key() @ CoordinationError::TaskSubmissionRequired
    )]
    pub task_submission: Box<Account<'info, TaskSubmission>>,

    /// The frozen claim's worker; only its own wallet can dispute.
    #[account(
        seeds = [b"agent", worker.agent_id.as_ref()],
        bump = worker.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent,
        constraint = worker.key() == claim.worker @ CoordinationError::UnauthorizedAgent
    )]
    pub worker: Box<Account<'info, AgentRegistration>>,

    /// The bond. Its existence means "disputed".
    #[account(
        init,
        payer = authority,
        space = DisputeBond::SIZE,
        seeds = [b"dispute_bond", task.key().as_ref()],
        bump
    )]
    pub dispute_bond: Box<Account<'info, DisputeBond>>,

    /// The buyer's record. It exists: the freeze created it.
    #[account(
        mut,
        seeds = [b"creator_stats", task.creator.as_ref()],
        bump = creator_stats.bump
    )]
    pub creator_stats: Box<Account<'info, CreatorStats>>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// The worker wallet: pays the bond and its rent, and gets the rent back.
    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<DisputeRejection>,
    evidence_hash: [u8; HASH_SIZE],
    evidence_uri: String,
) -> Result<()> {
    check_version_compatible_for_exit(&ctx.accounts.protocol_config)?;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    require!(
        evidence_hash != [0u8; HASH_SIZE],
        CoordinationError::InvalidEvidenceHash
    );
    require!(
        evidence_uri.len() <= MAX_REJECTION_EVIDENCE_URI_LEN,
        CoordinationError::EvidenceTooLong
    );
    require!(
        ctx.accounts.task.status == TaskStatus::RejectFrozen,
        CoordinationError::TaskNotRejectFrozen
    );
    // Only a revision 9 freeze is disputable; a revision 8 freeze keeps its
    // own rules (the multisig may rule, the timeout pays the worker).
    let submission = &ctx.accounts.task_submission;
    require!(
        submission.freeze_kind() == FREEZE_KIND_DISPUTABLE
            && submission.status == SubmissionStatus::Rejected,
        CoordinationError::RejectionNotDisputable
    );
    require!(
        rejection_dispute_window_open(now, submission.review_deadline_at),
        CoordinationError::RejectionDisputeWindowClosed
    );
    // Only a suspension takes the dispute away. Busy and Inactive are flags the
    // worker sets itself, and the frozen claim keeps it from becoming Active
    // again (review R2-2); unsuspend leaves it Inactive.
    require!(
        ctx.accounts.worker.status != AgentStatus::Suspended,
        CoordinationError::AgentSuspended
    );

    let task_key = ctx.accounts.task.key();
    let respondent = ctx.accounts.task.creator;
    let amount = dispute_bond_for_task(ctx.accounts.task.as_ref())?;
    let ruling_deadline = now
        .checked_add(REJECT_RULING_WINDOW_SECS)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // The principal sits on the bond account above its rent.
    transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.authority.to_account_info(),
                to: ctx.accounts.dispute_bond.to_account_info(),
            },
        ),
        amount,
    )?;

    let filer = ctx.accounts.authority.key();
    let bond = ctx.accounts.dispute_bond.as_mut();
    bond.subject = task_key;
    bond.task = task_key;
    bond.filer = filer;
    bond.respondent = respondent;
    bond.amount = amount;
    bond.kind = DisputeBond::KIND_REJECTION;
    bond.filed_at = now;
    bond.ruling_deadline = ruling_deadline;
    bond.bump = ctx.bumps.dispute_bond;
    bond._reserved = [0u8; 24];

    // The buyer's record counts a contested rejection.
    require!(
        ctx.accounts.creator_stats.wallet == respondent,
        CoordinationError::InvalidInput
    );
    let creator_stats_key = ctx.accounts.creator_stats.key();
    let counter = CreatorCounter::RejectionsContested;
    let new_value = bump_creator_counter(&mut ctx.accounts.creator_stats, counter, now)?;
    emit!(CreatorTrackRecordUpdated {
        wallet: respondent,
        creator_stats: creator_stats_key,
        counter: counter.event_variant(),
        new_value,
        timestamp: now,
    });

    emit!(RejectionDisputed {
        task: task_key,
        claim: ctx.accounts.claim.key(),
        worker_agent: ctx.accounts.worker.key(),
        filer,
        bond_amount: amount,
        evidence_hash,
        ruling_deadline,
        timestamp: now,
    });

    Ok(())
}
