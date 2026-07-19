//! Initiate a dispute for conflict resolution

use crate::errors::CoordinationError;
use crate::events::DisputeInitiated;
use crate::instructions::launch_controls::require_task_type_enabled;
use crate::instructions::task_validation_helpers::is_contest_configured_task;
use crate::state::{
    AgentRegistration, AgentStatus, AuthorityRateLimit, Dispute, DisputeStatus, ProtocolConfig,
    ResolutionType, SubmissionStatus, Task, TaskClaim, TaskStatus, TaskSubmission,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

use super::rate_limit_helpers::{check_authority_rate_limits, RateLimitAction};

/// Maximum evidence string length
const MAX_EVIDENCE_LEN: usize = 256;

#[derive(Accounts)]
#[instruction(dispute_id: [u8; 32], task_id: [u8; 32])]
pub struct InitiateDispute<'info> {
    #[account(
        init,
        payer = authority,
        space = Dispute::SIZE,
        seeds = [b"dispute", dispute_id.as_ref()],
        bump
    )]
    pub dispute: Box<Account<'info, Dispute>>,

    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        constraint = task.task_id == task_id @ CoordinationError::TaskNotFound,
        constraint = task.key() != dispute.key() @ CoordinationError::InvalidInput
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        mut,
        seeds = [b"agent", agent.agent_id.as_ref()],
        bump = agent.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub agent: Box<Account<'info, AgentRegistration>>,

    /// Wallet-scoped task/dispute rate limit state shared across all agents
    #[account(
        init_if_needed,
        payer = authority,
        space = AuthorityRateLimit::SIZE,
        seeds = [b"authority_rate_limit", authority.key().as_ref()],
        bump
    )]
    pub authority_rate_limit: Box<Account<'info, AuthorityRateLimit>>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// Initiator's live claim; required when the initiator is a worker.
    #[account(
        seeds = [b"claim", task.key().as_ref(), agent.key().as_ref()],
        bump,
    )]
    pub initiator_claim: Option<Box<Account<'info, TaskClaim>>>,

    /// Worker agent to be disputed; required when initiator is task creator.
    #[account(mut)]
    pub worker_agent: Option<Box<Account<'info, AgentRegistration>>>,

    /// Defendant's live claim; required when the initiator is task creator.
    pub worker_claim: Option<Box<Account<'info, TaskClaim>>>,

    /// Submitted delivery record; required for worker-initiated disputes. A
    /// submission never substitutes for the live claim required by both exits.
    pub task_submission: Option<Box<Account<'info, TaskSubmission>>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, InitiateDispute<'info>>,
    dispute_id: [u8; 32],
    task_id: [u8; 32],
    evidence_hash: [u8; 32],
    resolution_type: u8,
    evidence: String,
) -> Result<()> {
    let dispute = ctx.accounts.dispute.as_mut();
    let task = ctx.accounts.task.as_mut();
    let config = ctx.accounts.protocol_config.as_ref();
    let clock = Clock::get()?;
    let task_submission = ctx
        .accounts
        .task_submission
        .as_ref()
        .map(|task_submission| {
            require!(
                task_submission.task == task.key(),
                CoordinationError::TaskSubmissionRequired
            );
            Ok((
                task_submission.worker,
                task_submission.claim,
                task_submission.status,
            ))
        })
        .transpose()?;

    // A frozen (terminally-rejected) task cannot be disputed, and a disputed task
    // cannot be frozen. Keep the explicit guard local to this money-locking entry.
    require!(
        task.status != TaskStatus::RejectFrozen,
        CoordinationError::TaskFrozenCannotDispute
    );

    check_version_compatible(config)?;
    require_task_type_enabled(config, task.task_type)?;

    // Verify agent is active
    require!(
        ctx.accounts.agent.status == AgentStatus::Active,
        CoordinationError::AgentNotActive
    );

    // Batch 3 WS-CONTEST: contests carry NO dispute apparatus (founder ruling —
    // losers lose nothing; the winner is protected by the ghost-split guarantee).
    // A Disputed transition would also freeze accept AND the ghost crank for every
    // entrant, breaking the spec's "no re-entry via Disputed" partition invariant.
    // FIX ROUND: gate on contest-CONFIGURED (schema-1 Competitive AND manual
    // CreatorReview), not the type-wide predicate — an AUTO-validation Competitive
    // task never enters the contest lifecycle (no ghost-split replaces its
    // recourse), so it keeps dispute access exactly as before batch 3.
    require!(
        !is_contest_configured_task(task),
        CoordinationError::ContestFlowUnsupported
    );

    // Verify task is in a disputable state
    validate_disputable_task_state(task.status)?;

    // Verify task has workers to dispute (fix #502)
    validate_disputable_worker_count(task.current_workers)?;

    // Compare task.creator (wallet) with authority (signer's wallet), not agent PDA.
    // Every dispute must bind a LIVE claim so both resolution exits can close it.
    // A worker initiator must additionally bind a live Submitted record: allowing
    // a bare no-show claim to self-dispute let the no-show evade the completion-
    // bond forfeit and hold the creator's escrow until expiry.
    let is_creator = task.creator == ctx.accounts.authority.key();
    if !is_creator {
        let claim = ctx
            .accounts
            .initiator_claim
            .as_ref()
            .ok_or(CoordinationError::NotTaskParticipant)?;
        require!(
            claim.task == task.key() && claim.worker == ctx.accounts.agent.key(),
            CoordinationError::NotTaskParticipant
        );
        // Workers with completed claims cannot dispute - they already got paid
        require!(
            !claim.is_completed,
            CoordinationError::ClaimAlreadyCompleted
        );
        require!(
            claim.expires_at > clock.unix_timestamp,
            CoordinationError::ClaimExpired
        );
        let (submission_worker, submission_claim, submission_status) = task_submission
            .as_ref()
            .ok_or(CoordinationError::TaskSubmissionRequired)?;
        require!(
            *submission_worker == ctx.accounts.agent.key()
                && *submission_claim == claim.key()
                && is_disputable_submission_status(*submission_status),
            CoordinationError::TaskSubmissionRequired
        );
    }

    // Validate resolution type
    require!(resolution_type <= 2, CoordinationError::InvalidInput);

    // Validate evidence hash is not zero
    require!(
        evidence_hash != [0u8; 32],
        CoordinationError::InvalidEvidenceHash
    );

    require!(
        evidence.len() <= MAX_EVIDENCE_LEN,
        CoordinationError::EvidenceTooLong
    );

    // === Rate Limiting Checks ===

    // Check minimum stake requirement for dispute initiation (griefing resistance)
    // Creator-initiated disputes require 2x stake to prevent abuse (fix #407)
    if config.min_stake_for_dispute > 0 {
        if is_creator {
            // Creator disputes require 2x the minimum stake to discourage frivolous disputes
            // that could grief workers who claimed the task in good faith
            let creator_min_stake = config
                .min_stake_for_dispute
                .checked_mul(2)
                .ok_or(CoordinationError::ArithmeticOverflow)?;
            require!(
                ctx.accounts.agent.stake >= creator_min_stake,
                CoordinationError::InsufficientStakeForCreatorDispute
            );
        } else {
            require!(
                ctx.accounts.agent.stake >= config.min_stake_for_dispute,
                CoordinationError::InsufficientStakeForDispute
            );
        }
    }

    // Check wallet-scoped rate limits to prevent multi-agent bypasses under one authority.
    let agent_id = ctx.accounts.agent.agent_id;
    check_authority_rate_limits(
        ctx.accounts.authority_rate_limit.as_mut(),
        ctx.accounts.authority.key(),
        ctx.bumps.authority_rate_limit,
        agent_id,
        config,
        &clock,
        RateLimitAction::DisputeInitiation,
    )?;

    let agent = ctx.accounts.agent.as_mut();

    // Retain the conservative timestamp/cooldown anchor as a second layer against
    // immediate identity/stake recycling after dispute initiation. The pending
    // outcome counter below is the non-expiring liability gate; this timestamp is
    // no longer relied upon to prove that every dispute has reached a terminal
    // initiator outcome.
    agent.last_dispute_initiated = clock.unix_timestamp;
    // The retired arbiter-vote byte is now an ABI-preserving count of initiator
    // outcomes that still need the permissionless finalizer. Do not decrement it
    // in resolve/cancel/expire: `apply_initiator_slash` is the single atomic point
    // that either applies a loss or records a no-fault terminal outcome. This
    // blocks stale Active disputes and cancel+deregister races without adding an
    // initiator account to every dispute exit.
    agent.note_dispute_initiated()?;

    // === Determine Worker Stake to Snapshot (fix #550) ===
    // Snapshot the worker's stake at dispute initiation time to prevent
    // attackers from withdrawing stake before being slashed.
    let worker_stake = if !is_creator {
        // Initiator is the worker - use their stake
        agent.stake
    } else {
        // Initiator is the creator - need worker_agent to identify the worker
        let worker = ctx
            .accounts
            .worker_agent
            .as_ref()
            .ok_or(CoordinationError::WorkerAgentRequired)?;
        let w_claim = ctx
            .accounts
            .worker_claim
            .as_ref()
            .ok_or(CoordinationError::WorkerClaimRequired)?;
        require!(w_claim.task == task.key(), CoordinationError::TaskNotFound);
        require!(
            w_claim.worker == worker.key(),
            CoordinationError::UnauthorizedAgent
        );
        if let Some((submission_worker, submission_claim, _)) = task_submission.as_ref() {
            require!(
                *submission_worker == worker.key() && *submission_claim == w_claim.key(),
                CoordinationError::TaskSubmissionRequired
            );
        }

        worker.stake
    };

    // === Initialize Dispute ===

    dispute.dispute_id = dispute_id;
    dispute.task = task.key();
    dispute.initiator = agent.key();
    dispute.initiator_authority = ctx.accounts.authority.key();
    dispute.evidence_hash = evidence_hash;
    dispute.resolution_type = match resolution_type {
        0 => ResolutionType::Refund,
        1 => ResolutionType::Complete,
        2 => ResolutionType::Split,
        _ => return Err(CoordinationError::InvalidInput.into()),
    };
    dispute.status = DisputeStatus::Active;
    dispute.created_at = clock.unix_timestamp;
    dispute.resolved_at = 0;
    dispute.votes_for = 0;
    dispute.votes_against = 0;
    // Retired vote/quorum layout field. The sentinel proves this new dispute
    // owns exactly one unit of the initiator AgentRegistration counter. Legacy
    // disputes retain zero and therefore cannot consume a later counter unit.
    dispute.total_voters = Dispute::INITIATOR_OUTCOME_COUNTER_MARKER;
    dispute.voting_deadline = clock
        .unix_timestamp
        .checked_add(config.voting_period)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    dispute.expires_at = clock
        .unix_timestamp
        .checked_add(config.max_dispute_duration)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    dispute.slash_applied = false;
    dispute.initiator_slash_applied = false;
    dispute.worker_stake_at_dispute = worker_stake;
    dispute.initiated_by_creator = is_creator;
    dispute.bump = ctx.bumps.dispute;

    // Bind the defendant worker at dispute initiation (fix #827)
    // This prevents slashing the wrong worker on collaborative tasks.
    dispute.defendant = if is_creator {
        // Creator path: worker_agent was already validated above (lines 182-203)
        ctx.accounts
            .worker_agent
            .as_ref()
            .ok_or(CoordinationError::WorkerAgentRequired)?
            .key()
    } else {
        // Worker path: the initiating agent is the subject of the dispute
        agent.key()
    };

    // Mark task as disputed
    task.status = TaskStatus::Disputed;

    // Increment disputes_as_defendant for the bound defendant (fix #544, #842)
    // This is now deterministic and no longer caller-controlled via remaining_accounts.
    if is_creator {
        let defendant_worker = ctx
            .accounts
            .worker_agent
            .as_mut()
            .ok_or(CoordinationError::WorkerAgentRequired)?;
        increment_defendant_counter(defendant_worker.as_mut())?;
    } else {
        increment_defendant_counter(agent)?;
    }

    emit!(DisputeInitiated {
        dispute_id,
        task_id,
        initiator: agent.key(),
        defendant: dispute.defendant,
        resolution_type,
        voting_deadline: dispute.voting_deadline,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

fn increment_defendant_counter(worker: &mut Account<AgentRegistration>) -> Result<()> {
    worker.disputes_as_defendant = worker
        .disputes_as_defendant
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    Ok(())
}

fn is_disputable_submission_status(status: SubmissionStatus) -> bool {
    status == SubmissionStatus::Submitted
}

fn validate_disputable_task_state(status: TaskStatus) -> Result<()> {
    // One dispute per task. A second dispute would leave surplus defendant
    // bookkeeping that can never be cleared after the first one settles.
    require!(
        status != TaskStatus::Disputed,
        CoordinationError::InvalidStatusTransition
    );

    // Disputes are admitted only while a live claim is represented in the task
    // counters. The old durable-submission bypass admitted Open/current_workers=0
    // states whose claim was already closed; neither resolution exit could then
    // run, permanently pinning the task and defendant.
    require!(
        status == TaskStatus::InProgress || status == TaskStatus::PendingValidation,
        CoordinationError::TaskNotInProgress
    );
    require!(
        status.can_transition_to(TaskStatus::Disputed),
        CoordinationError::InvalidStatusTransition
    );

    Ok(())
}

fn validate_disputable_worker_count(current_workers: u8) -> Result<()> {
    require!(current_workers > 0, CoordinationError::NoWorkers);
    require!(
        current_workers <= crate::instructions::constants::DISPUTE_SAFE_MAX_WORKERS,
        CoordinationError::InvalidMaxWorkers
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // A submitted record never substitutes for a live claim/task state. Terminal,
    // frozen, and Open tasks cannot enter an unexitable Disputed state.
    #[test]
    fn only_live_claim_task_states_are_disputable() {
        for status in [
            TaskStatus::Open,
            TaskStatus::Completed,
            TaskStatus::Cancelled,
            TaskStatus::RejectFrozen,
        ] {
            assert!(
                validate_disputable_task_state(status).is_err(),
                "status without a live represented claim must not be disputable"
            );
        }
        assert!(validate_disputable_task_state(TaskStatus::InProgress).is_ok());
        assert!(validate_disputable_task_state(TaskStatus::PendingValidation).is_ok());
    }

    #[test]
    fn submitted_submission_is_disputable_evidence() {
        assert!(is_disputable_submission_status(SubmissionStatus::Submitted));
    }

    #[test]
    fn rejected_submission_is_not_disputable_evidence() {
        assert!(!is_disputable_submission_status(SubmissionStatus::Rejected));
    }

    #[test]
    fn rejected_submission_does_not_bypass_terminal_task_state() {
        let err = validate_disputable_task_state(TaskStatus::Completed).unwrap_err();

        assert_eq!(err, CoordinationError::TaskNotInProgress.into());
    }

    #[test]
    fn rejected_submission_does_not_bypass_missing_worker_count() {
        let err = validate_disputable_worker_count(0).unwrap_err();

        assert_eq!(err, CoordinationError::NoWorkers.into());
    }

    #[test]
    fn submitted_record_does_not_revive_a_released_claim_slot() {
        assert!(is_disputable_submission_status(SubmissionStatus::Submitted));
        assert!(validate_disputable_task_state(TaskStatus::Open).is_err());
        assert!(validate_disputable_worker_count(0).is_err());
    }

    // Revert-sensitive: a second dispute would pin surplus defendant bookkeeping.
    #[test]
    fn already_disputed_task_cannot_be_redisputed_normal_path() {
        let err = validate_disputable_task_state(TaskStatus::Disputed).unwrap_err();
        assert_eq!(err, CoordinationError::InvalidStatusTransition.into());
    }
}
