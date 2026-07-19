//! Claim a task to signal intent to work on it

use crate::errors::CoordinationError;
use crate::events::{reputation_reason, ReputationChanged, TaskClaimed};
use crate::instructions::completion_helpers::validate_task_dependency_for_assignment;
use crate::instructions::constants::{
    CONTEST_ENTRY_DEPOSIT_LAMPORTS, DISPUTE_SAFE_MAX_WORKERS, MAX_REPUTATION, REPUTATION_DECAY_MIN,
    REPUTATION_DECAY_PERIOD, REPUTATION_DECAY_RATE,
};
use crate::instructions::launch_controls::require_task_type_enabled;
#[cfg(not(feature = "mainnet-canary"))]
use crate::instructions::moderation_gate_helpers::require_content_not_blocked;
use crate::instructions::task_validation_helpers::{
    is_contest_configured_task, is_manual_validation_task,
};
use crate::state::{
    AgentRegistration, AgentStatus, ProtocolConfig, Task, TaskClaim, TaskJobSpec, TaskStatus,
    TaskType,
};
#[cfg(not(feature = "mainnet-canary"))]
use crate::state::{HireRecord, ServiceListing};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ClaimTask<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        init_if_needed,
        payer = authority,
        space = TaskClaim::SIZE,
        seeds = [b"claim", task.key().as_ref(), worker.key().as_ref()],
        bump,
        constraint = claim.key() != task.key() @ CoordinationError::InvalidInput
    )]
    pub claim: Box<Account<'info, TaskClaim>>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        mut,
        seeds = [b"agent", worker.agent_id.as_ref()],
        bump = worker.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub worker: Box<Account<'info, AgentRegistration>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimTaskWithJobSpec<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        seeds = [b"task_job_spec", task.key().as_ref()],
        bump = task_job_spec.bump,
        constraint = task_job_spec.task == task.key() @ CoordinationError::TaskJobSpecTaskMismatch,
        constraint = task_job_spec.creator == task.creator @ CoordinationError::UnauthorizedTaskAction
    )]
    pub task_job_spec: Box<Account<'info, TaskJobSpec>>,

    /// CHECK: canonical hire-link PDA is seeds-pinned here; the handler validates
    /// owner, discriminator, task binding, and designated provider when live.
    /// A live record designates the only
    /// provider agent allowed to claim; a direct task supplies the empty system
    /// account at the same PDA. Full surface only because listing hires are not
    /// part of the canary program.
    #[cfg(not(feature = "mainnet-canary"))]
    #[account(seeds = [b"hire", task.key().as_ref()], bump)]
    pub hire_record: UncheckedAccount<'info>,

    /// Legacy fallback for pre-hardening HireRecords whose former reserved field
    /// is zero. When needed, this must be the exact stored ServiceListing and the
    /// handler derives the designated provider from its immutable provider_agent.
    /// CHECK: optional; fully owner/discriminator/PDA/binding checked in handler.
    #[cfg(not(feature = "mainnet-canary"))]
    pub legacy_listing: Option<UncheckedAccount<'info>>,

    /// Canonical content-hash BLOCK floor. Rechecked at assignment time so a
    /// takedown recorded after publication actually stops new work.
    /// CHECK: handler derives and validates the PDA from task_job_spec.job_spec_hash.
    #[cfg(not(feature = "mainnet-canary"))]
    pub moderation_block: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = authority,
        space = TaskClaim::SIZE,
        seeds = [b"claim", task.key().as_ref(), worker.key().as_ref()],
        bump,
        constraint = claim.key() != task.key() @ CoordinationError::InvalidInput
    )]
    pub claim: Box<Account<'info, TaskClaim>>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        mut,
        seeds = [b"agent", worker.agent_id.as_ref()],
        bump = worker.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub worker: Box<Account<'info, AgentRegistration>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(_ctx: Context<ClaimTask>) -> Result<()> {
    // Legacy claim_task has no TaskJobSpec account, so it cannot prove the worker
    // saw the moderated immutable job spec. Keep the ABI but fail closed.
    Err(error!(CoordinationError::TaskJobSpecRequired))
}

pub fn handler_with_job_spec(ctx: Context<ClaimTaskWithJobSpec>) -> Result<()> {
    validate_job_spec_pointer(ctx.accounts.task_job_spec.as_ref())?;

    #[cfg(not(feature = "mainnet-canary"))]
    {
        require_content_not_blocked(
            &ctx.accounts.moderation_block.to_account_info(),
            &ctx.accounts.task_job_spec.job_spec_hash,
        )?;
        validate_hired_provider(
            &ctx.accounts.hire_record.to_account_info(),
            ctx.accounts
                .legacy_listing
                .as_ref()
                .map(|listing| listing.to_account_info()),
            &ctx.accounts.task.key(),
            &ctx.accounts.worker.key(),
        )?;
    }

    // A Proof-dependent task is not safe to assign before its parent is
    // Completed. Otherwise the creator can cancel the parent after assignment,
    // make completion impossible, then forfeit the trapped worker's bond as a
    // supposed no-show. Parent lives in remaining_accounts[0] for Proof tasks.
    validate_task_dependency_for_assignment(
        ctx.accounts.task.as_ref(),
        ctx.remaining_accounts,
        ctx.program_id,
    )?;

    let task_key = ctx.accounts.task.key();
    let worker_key = ctx.accounts.worker.key();

    process_claim(
        task_key,
        ctx.accounts.task.as_mut(),
        ctx.accounts.claim.as_mut(),
        ctx.accounts.protocol_config.as_ref(),
        worker_key,
        ctx.accounts.worker.as_mut(),
        ctx.bumps.claim,
    )?;

    // FIX 4 (anti-slop contest entry deposit): a contest-configured claim carries
    // a refundable CONTEST_ENTRY_DEPOSIT_LAMPORTS as SURPLUS LAMPORTS on the claim
    // PDA (no TaskClaim layout change). Refunded in full on every exit where the
    // worker submitted (accept/reject/ghost-split close the claim with all its
    // lamports to the worker — losers lose nothing); forfeited to the protocol
    // treasury on no-show exits (expire_claim / reclaim_terminal_claim). Prices
    // the slot-squat DoS that fully-refundable claim rent made free. Only contest
    // claims pay; every other task type (and schema-0) is unchanged. (Canary
    // builds are contest-incapable by construction, so this branch is dead there.)
    if is_contest_configured_task(&ctx.accounts.task) {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: ctx.accounts.claim.to_account_info(),
                },
            ),
            CONTEST_ENTRY_DEPOSIT_LAMPORTS,
        )?;
    }

    Ok(())
}

/// Bind a listing hire to the provider the buyer selected. The canonical empty
/// PDA is the explicit proof that a direct task has no hire restriction.
#[cfg(not(feature = "mainnet-canary"))]
fn validate_hired_provider(
    hire_info: &AccountInfo,
    legacy_listing_info: Option<AccountInfo>,
    task: &Pubkey,
    worker: &Pubkey,
) -> Result<()> {
    let (expected, expected_bump) =
        Pubkey::find_program_address(&[b"hire", task.as_ref()], &crate::ID);
    require!(
        hire_info.key() == expected,
        CoordinationError::InvalidHireRecord
    );

    if hire_info.owner == &crate::ID {
        let data = hire_info.try_borrow_data()?;
        let hire = HireRecord::try_deserialize(&mut &data[..])
            .map_err(|_| error!(CoordinationError::InvalidHireRecord))?;
        require!(
            hire.task == *task && hire.bump == expected_bump,
            CoordinationError::InvalidHireRecord
        );
        if hire.designated_provider == Pubkey::default() {
            let listing_info = legacy_listing_info
                .as_ref()
                .ok_or(CoordinationError::InvalidHireRecord)?;
            require!(
                listing_info.key() == hire.listing && listing_info.owner == &crate::ID,
                CoordinationError::InvalidHireRecord
            );
            let listing_data = listing_info.try_borrow_data()?;
            let listing = ServiceListing::try_deserialize(&mut &listing_data[..])
                .map_err(|_| error!(CoordinationError::InvalidHireRecord))?;
            let (expected_listing, listing_bump) = Pubkey::find_program_address(
                &[
                    b"service_listing",
                    listing.provider_agent.as_ref(),
                    listing.listing_id.as_ref(),
                ],
                &crate::ID,
            );
            require!(
                expected_listing == listing_info.key() && listing.bump == listing_bump,
                CoordinationError::InvalidHireRecord
            );
            require!(
                listing.provider_agent == *worker,
                CoordinationError::UnauthorizedAgent
            );
        } else {
            require!(
                hire.designated_provider == *worker,
                CoordinationError::UnauthorizedAgent
            );
        }
    } else {
        require!(
            hire_info.owner == &anchor_lang::system_program::ID && hire_info.data_is_empty(),
            CoordinationError::InvalidHireRecord
        );
    }
    Ok(())
}

fn validate_job_spec_pointer(task_job_spec: &TaskJobSpec) -> Result<()> {
    require!(
        task_job_spec.job_spec_hash.iter().any(|byte| *byte != 0),
        CoordinationError::InvalidTaskJobSpecHash
    );
    require!(
        !task_job_spec.job_spec_uri.trim().is_empty(),
        CoordinationError::InvalidTaskJobSpecUri
    );

    Ok(())
}

pub(crate) fn has_required_assignment_stake(stake: u64, minimum_stake: u64) -> bool {
    stake >= minimum_stake
}

fn process_claim(
    task_key: Pubkey,
    task: &mut Account<Task>,
    claim: &mut Account<TaskClaim>,
    config: &Account<ProtocolConfig>,
    worker_key: Pubkey,
    worker: &mut Account<AgentRegistration>,
    claim_bump: u8,
) -> Result<()> {
    let clock = Clock::get()?;

    check_version_compatible(config)?;
    require_task_type_enabled(config, task.task_type)?;

    // Prevent self-task claiming: worker authority must differ from task creator (fix #831)
    // Without this check, the same wallet can fabricate its own work history and, when
    // paying a qualifying fee, buy reputation without an independent counterparty.
    require!(
        worker.authority != task.creator,
        CoordinationError::SelfTaskNotAllowed
    );

    // Check if worker already has a claim on this task (fix #480)
    // claimed_at > 0 indicates an existing claim (not freshly initialized)
    if claim.claimed_at > 0 {
        // Worker already completed this task
        require!(
            !claim.is_completed,
            CoordinationError::ClaimAlreadyCompleted
        );
        // Worker has an active (incomplete) claim - already claimed
        return Err(CoordinationError::AlreadyClaimed.into());
    }

    // Validate task state - manual-validation collaborative tasks may continue to accept
    // new claims while earlier submissions are pending review. Batch 3 WS-CONTEST:
    // contests (schema-1 Competitive, CreatorReview) behave the same way — the first
    // entrant's submission must not lock later entrants out of the contest (any
    // registered agent may enter up to max_workers until the deadline).
    let claimable_during_pending_validation = task.status == TaskStatus::PendingValidation
        && (task.task_type == TaskType::Collaborative || task.is_contest_task())
        && is_manual_validation_task(task);
    require!(
        task.status == TaskStatus::Open
            || task.status == TaskStatus::InProgress
            || claimable_during_pending_validation,
        CoordinationError::TaskNotOpen
    );
    require!(
        task.task_type != TaskType::BidExclusive,
        CoordinationError::BidTaskRequiresAcceptance
    );

    // Validate status transition is allowed (fix #538)
    require!(
        task.status.can_transition_to(TaskStatus::InProgress),
        CoordinationError::InvalidStatusTransition
    );

    // Check deadline
    if task.deadline > 0 {
        require!(
            clock.unix_timestamp < task.deadline,
            CoordinationError::TaskExpired
        );
    }

    // Legacy tasks may advertise max_workers up to 100. Do not admit more live
    // claims than the single-transaction dispute unwind can safely carry.
    let effective_max_workers = task.max_workers.min(DISPUTE_SAFE_MAX_WORKERS);
    require!(
        task.current_workers < effective_max_workers,
        CoordinationError::TaskFullyClaimed
    );

    // Check worker is active
    require!(
        worker.status == AgentStatus::Active,
        CoordinationError::AgentNotActive
    );

    // A worker whose registration stake was depleted by an earlier slash must
    // replenish through the identity lifecycle before accepting more economic
    // obligations. Otherwise the same zero-principal identity could repeatedly
    // claim work while every later stake slash was necessarily zero. This is a
    // current assignment gate only; existing claims retain all terminal exits.
    require!(
        has_required_assignment_stake(worker.stake, config.min_agent_stake),
        CoordinationError::InsufficientStake
    );

    // Check worker has required capabilities
    require!(
        (worker.capabilities & task.required_capabilities) == task.required_capabilities,
        CoordinationError::InsufficientCapabilities
    );

    // Apply passive reputation decay for inactivity
    let inactive_periods = clock
        .unix_timestamp
        .saturating_sub(worker.last_active)
        .checked_div(REPUTATION_DECAY_PERIOD)
        .unwrap_or(0);
    if inactive_periods > 0 && worker.reputation > REPUTATION_DECAY_MIN {
        // Clamp periods to prevent u16 truncation (max useful = MAX_REPUTATION / DECAY_RATE + 1)
        let max_periods = i64::from(
            MAX_REPUTATION
                .checked_div(REPUTATION_DECAY_RATE)
                .unwrap_or(0),
        )
        .saturating_add(1);
        let capped_periods = inactive_periods.min(max_periods) as u16;
        let decay = capped_periods.saturating_mul(REPUTATION_DECAY_RATE);
        let old_rep = worker.reputation;
        worker.reputation = worker
            .reputation
            .saturating_sub(decay)
            .max(REPUTATION_DECAY_MIN);
        if worker.reputation != old_rep {
            emit!(ReputationChanged {
                agent_id: worker.agent_id,
                old_reputation: old_rep,
                new_reputation: worker.reputation,
                reason: reputation_reason::DECAY,
                timestamp: clock.unix_timestamp,
            });
        }
    }

    // Check worker meets minimum reputation requirement
    if task.min_reputation > 0 {
        require!(
            worker.reputation >= task.min_reputation,
            CoordinationError::InsufficientReputation
        );
    }

    // Check worker doesn't have too many active tasks
    const MAX_ACTIVE_TASKS: u16 = 10;
    require!(
        worker.active_tasks < MAX_ACTIVE_TASKS,
        CoordinationError::MaxActiveTasksReached
    );

    // Calculate claim expiration
    // Add buffer past deadline so workers can complete and submit proof
    const COMPLETION_BUFFER: i64 = 3600; // 1 hour buffer
    let expires_at = if task.deadline > 0 {
        task.deadline
            .checked_add(COMPLETION_BUFFER)
            .ok_or(CoordinationError::ArithmeticOverflow)?
    } else {
        clock
            .unix_timestamp
            .checked_add(config.max_claim_duration)
            .ok_or(CoordinationError::ArithmeticOverflow)?
    };

    // Initialize claim
    claim.task = task_key;
    claim.worker = worker_key;
    claim.claimed_at = clock.unix_timestamp;
    claim.expires_at = expires_at;
    claim.completed_at = 0;
    claim.proof_hash = [0u8; 32];
    claim.result_data = [0u8; 64];
    claim.is_completed = false;
    claim.is_validated = false;
    claim.reward_paid = 0;
    claim.bump = claim_bump;

    // Update task
    task.current_workers = task
        .current_workers
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    if task.status != TaskStatus::PendingValidation {
        task.status = TaskStatus::InProgress;
    }

    // Update worker
    worker.active_tasks = worker
        .active_tasks
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    worker.last_active = clock.unix_timestamp;

    emit!(TaskClaimed {
        task_id: task.task_id,
        worker: worker_key,
        current_workers: task.current_workers,
        max_workers: task.max_workers,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assignment_stake_floor_is_inclusive() {
        assert!(!has_required_assignment_stake(0, 1));
        assert!(!has_required_assignment_stake(9_999_999, 10_000_000));
        assert!(has_required_assignment_stake(10_000_000, 10_000_000));
        assert!(has_required_assignment_stake(10_000_001, 10_000_000));
    }

    fn task_job_spec(job_spec_hash: [u8; 32], job_spec_uri: &str) -> TaskJobSpec {
        TaskJobSpec {
            task: Pubkey::new_unique(),
            creator: Pubkey::new_unique(),
            job_spec_hash,
            job_spec_uri: job_spec_uri.to_string(),
            created_at: 1,
            updated_at: 1,
            bump: 255,
            _reserved: [0; 7],
        }
    }

    #[test]
    fn validates_non_empty_job_spec_pointer() {
        let pointer = task_job_spec([1; 32], "agenc://job-spec/sha256/test");

        assert!(validate_job_spec_pointer(&pointer).is_ok());
    }

    #[test]
    fn rejects_zero_hash_job_spec_pointer() {
        let pointer = task_job_spec([0; 32], "agenc://job-spec/sha256/test");

        assert!(validate_job_spec_pointer(&pointer).is_err());
    }

    #[test]
    fn rejects_blank_uri_job_spec_pointer() {
        let pointer = task_job_spec([1; 32], "   ");

        assert!(validate_job_spec_pointer(&pointer).is_err());
    }
}
