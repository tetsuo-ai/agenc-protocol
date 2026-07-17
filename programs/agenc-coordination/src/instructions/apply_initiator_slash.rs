//! Apply slashing to a dispute initiator when their dispute is rejected.
//!
//! # Permissionless Design
//! Can be called by anyone after dispute resolves unfavorably.
//! This is intentional - ensures slashing cannot be avoided.
//!
//! # Time Window (fix #414)
//! Slashing must occur within 7 days of dispute resolution.
//! After this window, slashing can no longer be applied.

use crate::errors::CoordinationError;
use crate::instructions::constants::PERCENT_BASE;
use crate::instructions::slash_helpers::{
    apply_reputation_penalty, calculate_approval_percentage, transfer_slash_to_treasury,
    validate_slash_window,
};
use crate::state::{AgentRegistration, Dispute, DisputeStatus, ProtocolConfig};
use crate::utils::version::check_version_compatible_for_exit;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ApplyInitiatorSlash<'info> {
    #[account(
        mut,
        seeds = [b"dispute", dispute.dispute_id.as_ref()],
        bump = dispute.bump
    )]
    pub dispute: Box<Account<'info, Dispute>>,

    // NOTE (audit F-2): the Task account was REMOVED from this instruction. It was
    // only ever used for the `dispute.task == task.key()` binding (inherent in the
    // stored `dispute.task`) and an unused local — but hard-requiring it let a task
    // creator `close_task` after a lost dispute and permanently brick this finalizer,
    // evading their own initiator slash. The defendant-side finalizer still needs the
    // Task (reward_mint), so that side is protected by the `current_workers` deferral
    // instead; see resolve_dispute.
    #[account(
        mut,
        seeds = [b"agent", initiator_agent.agent_id.as_ref()],
        bump = initiator_agent.bump
    )]
    pub initiator_agent: Box<Account<'info, AgentRegistration>>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// CHECK: Treasury account to receive slashed lamports
    #[account(
        mut,
        constraint = treasury.key() == protocol_config.treasury @ CoordinationError::InvalidInput
    )]
    pub treasury: UncheckedAccount<'info>,

    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<ApplyInitiatorSlash>) -> Result<()> {
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::InvalidInput
    );

    let dispute = &mut ctx.accounts.dispute;
    let initiator_agent = &mut ctx.accounts.initiator_agent;
    let config = &ctx.accounts.protocol_config;

    // Exit/finalizer gate, matching the sibling apply_dispute_slash. This permissionless
    // finalizer's own docstring says "slashing cannot be avoided", but it previously used
    // the ENTRY gate (rejects while paused) + require_task_type_enabled (entry-only): a
    // pause or a retroactive task-type disable that outlasts the 7-day SLASH_WINDOW would
    // make it permanently unrunnable, silently evading the frivolous-dispute deterrent
    // (audit). The exit gate keeps slashing available while paused; no escrow moves here
    // beyond the initiator's own stake, so it is settlement-class.
    check_version_compatible_for_exit(config)?;
    require!(
        dispute.status == DisputeStatus::Resolved || dispute.status == DisputeStatus::Cancelled,
        CoordinationError::DisputeNotResolved
    );
    require!(
        !dispute.initiator_slash_applied,
        CoordinationError::SlashAlreadyApplied
    );

    // Check slash window hasn't expired (fix #414)
    let clock = Clock::get()?;
    validate_slash_window(dispute.resolved_at, &clock)?;

    require!(
        initiator_agent.key() == dispute.initiator,
        CoordinationError::UnauthorizedAgent
    );

    // Verify initiator was actually a participant in the task being disputed (fix #581)
    // The initiator must have been either:
    // 1. The task creator (dispute.initiator_authority == task.creator), OR
    // 2. A worker who had a valid claim at dispute initiation
    //
    // At dispute creation (initiate_dispute), participation is validated by checking:
    // - task.creator == authority (for creators), OR
    // - initiator_claim.is_some() (for workers with active claims)
    //
    // Verify the initiator_agent's authority matches the stored initiator_authority
    // from the dispute to ensure consistency. Participation itself is pinned by
    // initiate_dispute; `dispute.task` is the stored task binding (audit F-2 — the
    // Task account is no longer loaded here).
    require!(
        initiator_agent.authority == dispute.initiator_authority,
        CoordinationError::NotTaskParticipant
    );

    let initiator_lost = if dispute.status == DisputeStatus::Cancelled {
        // Cancellation = admission of frivolous dispute; always slash
        true
    } else {
        // Resolved (P6.3): read the resolver's RULING bit that `resolve_dispute` wrote
        // into `(votes_for, votes_against)` — (1,0)=approved, (0,1)=rejected. No vote
        // tally is involved; `calculate_approval_percentage` recovers 100%/0% and the
        // same `dispute_threshold` comparison yields the resolver's decision.
        let (_total_votes, approval_pct) =
            calculate_approval_percentage(dispute.votes_for, dispute.votes_against)?;
        let approved = approval_pct >= config.dispute_threshold as u64;
        !approved // Initiator loses if dispute was not approved
    };

    // Only slash the initiator if they lost (dispute rejected or cancelled)
    require!(initiator_lost, CoordinationError::InvalidInput);
    require!(
        initiator_agent.stake > 0,
        CoordinationError::InsufficientStake
    );

    require!(
        config.slash_percentage <= 100,
        CoordinationError::InvalidInput
    );

    let slash_amount = initiator_agent
        .stake
        .checked_mul(config.slash_percentage as u64)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(PERCENT_BASE)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Apply reputation penalty for frivolous dispute (before lamport transfer to satisfy borrow checker)
    apply_reputation_penalty(initiator_agent, &clock)?;

    if slash_amount > 0 {
        initiator_agent.stake = initiator_agent
            .stake
            .checked_sub(slash_amount)
            .ok_or(CoordinationError::ArithmeticOverflow)?;

        // Fix #374: Actually transfer lamports to treasury
        transfer_slash_to_treasury(
            &ctx.accounts.initiator_agent.to_account_info(),
            &ctx.accounts.treasury.to_account_info(),
            slash_amount,
        )?;
    }

    dispute.initiator_slash_applied = true;

    Ok(())
}
