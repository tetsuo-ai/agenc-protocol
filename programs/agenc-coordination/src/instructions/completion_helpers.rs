//! Shared helper functions for task completion logic.
//!
//! Used by both `complete_task` (public) and `complete_task_private` (ZK) instructions.

use crate::errors::CoordinationError;
use crate::events::{
    reputation_reason, OperatorFeePaid, ReferrerFeePaid, ReputationChanged, RewardDistributed,
    TaskCompleted,
};
use crate::instructions::constants::{
    BASIS_POINTS_DIVISOR, MAX_COMBINED_FEE_BPS, MAX_OPERATOR_FEE_BPS, MAX_REFERRER_FEE_BPS,
    MAX_REPUTATION, REPUTATION_PER_COMPLETION, WORKER_FLOOR_BPS,
};
use crate::instructions::lamport_transfer::transfer_lamports;
#[cfg(feature = "spl-token-rewards")]
use crate::instructions::token_helpers::{
    close_token_escrow_account_info, transfer_tokens_from_escrow,
};
use crate::state::{
    AgentRegistration, DependencyType, ProtocolConfig, Task, TaskClaim, TaskEscrow, TaskStatus,
    TaskType, RESULT_DATA_SIZE,
};
use crate::utils::compute_budget::{calculate_reputation_fee_discount, calculate_tiered_fee};
use anchor_lang::prelude::*;
#[cfg(feature = "spl-token-rewards")]
use anchor_spl::token::{self, Token, TokenAccount};
#[cfg(not(feature = "spl-token-rewards"))]
use core::marker::PhantomData;

/// Calculate worker reward and protocol fee from task reward amount.
///
/// For collaborative tasks, splits reward among required completions.
/// For exclusive/competitive tasks, uses full reward amount.
fn calculate_reward_split_for_amount(
    reward_per_worker: u64,
    protocol_fee_bps: u16,
) -> Result<(u64, u64)> {
    let protocol_fee = reward_per_worker
        .checked_mul(protocol_fee_bps as u64)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(BASIS_POINTS_DIVISOR)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    let worker_reward = reward_per_worker
        .checked_sub(protocol_fee)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Ensure worker gets at least 1 lamport
    require!(worker_reward > 0, CoordinationError::RewardTooSmall);

    Ok((worker_reward, protocol_fee))
}

pub fn calculate_reward_split(task: &Task, protocol_fee_bps: u16) -> Result<(u64, u64)> {
    let reward_per_worker = calculate_reward_per_worker(task)?;
    calculate_reward_split_for_amount(reward_per_worker, protocol_fee_bps)
}

/// Calculate worker reward and protocol fee with volume-based tiered discounts (issue #40).
///
/// High-volume creators (measured by completed_tasks on their agent account) receive
/// reduced protocol fees. This incentivizes protocol usage while maintaining revenue.
///
/// See [`calculate_tiered_fee`] for tier thresholds and discount amounts.
pub fn calculate_reward_split_tiered(
    task: &Task,
    base_fee_bps: u16,
    creator_completed_tasks: u64,
) -> Result<(u64, u64, u16)> {
    let effective_fee_bps = calculate_tiered_fee(base_fee_bps, creator_completed_tasks);
    let reward_per_worker = calculate_reward_per_worker(task)?;
    let (worker_reward, protocol_fee) =
        calculate_reward_split_for_amount(reward_per_worker, effective_fee_bps)?;
    Ok((worker_reward, protocol_fee, effective_fee_bps))
}

/// Calculate per-worker reward based on task type.
///
/// Note: Remainder distribution is deterministic based on worker index.
/// First N workers get +1 lamport where N = total % num_workers.
/// This is predictable but fair across all workers.
fn calculate_reward_per_worker(task: &Task) -> Result<u64> {
    match task.task_type {
        TaskType::Collaborative => {
            let num_workers = task.required_completions as u64;
            let base_share = task
                .reward_amount
                .checked_div(num_workers)
                .ok_or(CoordinationError::ArithmeticOverflow)?;
            let remainder = task
                .reward_amount
                .checked_rem(num_workers)
                .ok_or(CoordinationError::ArithmeticOverflow)?;

            // Give extra 1 lamport to first `remainder` workers
            let worker_index = task.completions as u64;
            if worker_index < remainder {
                Ok(base_share
                    .checked_add(1)
                    .ok_or(CoordinationError::ArithmeticOverflow)?)
            } else {
                Ok(base_share)
            }
        }
        TaskType::Competitive | TaskType::Exclusive | TaskType::BidExclusive => {
            Ok(task.reward_amount)
        }
    }
}

/// Optional token accounts for SPL token task rewards.
/// When `None` is passed for this in `execute_completion_rewards`, the SOL path is used.
///
/// Uses owned `AccountInfo` values (not references) to avoid lifetime conflicts
/// with mutable borrows of task/claim/escrow in handler functions.
#[cfg(feature = "spl-token-rewards")]
pub struct TokenPaymentAccounts<'a, 'info> {
    pub token_escrow_ata: &'a mut Account<'info, TokenAccount>,
    pub token_escrow_starting_amount: u64,
    pub worker_token_account: AccountInfo<'info>,
    pub treasury_token_account: AccountInfo<'info>,
    pub token_program: &'a Program<'info, Token>,
    pub escrow_authority: AccountInfo<'info>,
    pub escrow_bump: u8,
    pub task_key: Pubkey,
}

/// Placeholder used when SPL rewards are not compiled into a canary binary.
#[cfg(not(feature = "spl-token-rewards"))]
pub struct TokenPaymentAccounts<'a, 'info> {
    _marker: PhantomData<(&'a (), &'info ())>,
}

/// Load a task claim while preserving protocol-level `NotClaimed` semantics.
///
/// Anchor account deserialization returns `AccountNotInitialized` when a closed claim PDA is
/// passed in. For negative completion paths we want the protocol error instead.
pub fn load_task_claim_or_not_claimed<'info>(
    claim_info: &UncheckedAccount<'info>,
    task_key: &Pubkey,
) -> Result<Account<'info, TaskClaim>> {
    if claim_info.owner == &anchor_lang::solana_program::system_program::ID
        && claim_info.lamports() == 0
    {
        return err!(CoordinationError::NotClaimed);
    }

    // SAFETY: `UncheckedAccount<'info>` stores an `&'info AccountInfo<'info>`.
    // The wrapper borrow can be shorter than `'info`, but the wrapped account
    // reference itself is valid for the full instruction lifetime.
    let claim_info_ref: &'info AccountInfo<'info> =
        unsafe { std::mem::transmute(claim_info.as_ref()) };
    let claim = Account::<TaskClaim>::try_from(claim_info_ref)?;
    require!(claim.task == *task_key, CoordinationError::NotClaimed);
    Ok(claim)
}

/// Transfer tokens from escrow ATA to worker and treasury ATAs via PDA-signed CPI.
#[cfg(feature = "spl-token-rewards")]
fn transfer_token_rewards<'a, 'info>(
    ta: &mut TokenPaymentAccounts<'a, 'info>,
    worker_reward: u64,
    protocol_fee: u64,
) -> Result<()> {
    let task_key_bytes = ta.task_key.to_bytes();
    let bump_slice = [ta.escrow_bump];
    let escrow_seeds: &[&[u8]] = &[b"escrow", task_key_bytes.as_ref(), &bump_slice];

    if worker_reward > 0 {
        transfer_tokens_from_escrow(
            ta.token_escrow_ata,
            &ta.worker_token_account,
            &ta.escrow_authority,
            worker_reward,
            escrow_seeds,
            ta.token_program,
        )?;
    }

    if protocol_fee > 0 {
        let remaining_balance = token::accessor::amount(&ta.token_escrow_ata.to_account_info())
            .map_err(|_| CoordinationError::TokenTransferFailed)?;
        require!(
            remaining_balance >= protocol_fee,
            CoordinationError::InsufficientEscrowBalance
        );
        transfer_tokens_from_escrow(
            ta.token_escrow_ata,
            &ta.treasury_token_account,
            &ta.escrow_authority,
            protocol_fee,
            escrow_seeds,
            ta.token_program,
        )?;
    }

    Ok(())
}

/// Transfer lamports from escrow to worker and treasury.
pub fn transfer_rewards<'info>(
    escrow: &mut Account<'info, TaskEscrow>,
    worker_account: &AccountInfo<'info>,
    treasury: &AccountInfo<'info>,
    worker_reward: u64,
    protocol_fee: u64,
    operator: Option<(&AccountInfo<'info>, u64)>,
    referrer: Option<(&AccountInfo<'info>, u64)>,
) -> Result<()> {
    transfer_lamports(&escrow.to_account_info(), worker_account, worker_reward)?;
    transfer_lamports(&escrow.to_account_info(), treasury, protocol_fee)?;
    // §4 3-way split: pay the operator (embedding-site) leg when present. The
    // 2-way path passes `None`, so its behavior is unchanged.
    if let Some((operator_account, operator_fee)) = operator {
        if operator_fee > 0 {
            transfer_lamports(&escrow.to_account_info(), operator_account, operator_fee)?;
        }
    }
    // §4 4-way split (P6.2): pay the referrer (demand-side embedder) leg when
    // present. `None` (the common case) leaves behavior unchanged.
    if let Some((referrer_account, referrer_fee)) = referrer {
        if referrer_fee > 0 {
            transfer_lamports(&escrow.to_account_info(), referrer_account, referrer_fee)?;
        }
    }
    Ok(())
}

/// Update claim state after completion.
///
/// Tracks both worker_reward and protocol_fee in escrow.distributed to
/// accurately reflect total funds withdrawn. This prevents remaining_funds
/// from being overestimated during dispute resolution.
pub fn update_claim_state(
    claim: &mut Account<TaskClaim>,
    escrow: &mut Account<TaskEscrow>,
    worker_reward: u64,
    protocol_fee: u64,
) -> Result<()> {
    claim.reward_paid = worker_reward;

    let total_withdrawn = worker_reward
        .checked_add(protocol_fee)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    escrow.distributed = escrow
        .distributed
        .checked_add(total_withdrawn)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    Ok(())
}

/// Update task state after completion. Returns true if task is fully completed.
///
/// For private completions, pass `None` for result_data to zero the result field.
fn update_task_completion_counters(task: &mut Task) -> Result<()> {
    task.current_workers = task
        .current_workers
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    task.completions = task
        .completions
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    Ok(())
}

pub fn update_task_state(
    task: &mut Account<Task>,
    timestamp: i64,
    escrow: &mut Account<TaskEscrow>,
    result_data: Option<[u8; RESULT_DATA_SIZE]>,
) -> Result<bool> {
    update_task_completion_counters(task)?;

    let completed = task.completions >= task.required_completions;
    if completed {
        task.status = TaskStatus::Completed;
        task.completed_at = timestamp;
        // Private completions pass None to preserve privacy
        task.result = result_data.unwrap_or([0u8; RESULT_DATA_SIZE]);
        escrow.is_closed = true;
    }

    Ok(completed)
}

/// Update worker statistics after task completion.
/// Returns `(old_reputation, new_reputation)` for event emission.
pub fn update_worker_state(
    worker: &mut Account<AgentRegistration>,
    reward: u64,
    timestamp: i64,
) -> Result<(u16, u16)> {
    worker.tasks_completed = worker
        .tasks_completed
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    worker.total_earned = worker
        .total_earned
        .checked_add(reward)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    worker.active_tasks = worker
        .active_tasks
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    worker.last_active = timestamp;
    // Reputation uses saturating_add intentionally - reputation overflow to MAX_REPUTATION
    // is the intended behavior (capped at 10000), not an error condition
    let old_rep = worker.reputation;
    worker.reputation = worker
        .reputation
        .saturating_add(REPUTATION_PER_COMPLETION)
        .min(MAX_REPUTATION);
    Ok((old_rep, worker.reputation))
}

/// Update protocol statistics after task completion.
pub fn update_protocol_stats(config: &mut Account<ProtocolConfig>, reward: u64) -> Result<()> {
    config.completed_tasks = config
        .completed_tasks
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    config.total_value_distributed = config
        .total_value_distributed
        .checked_add(reward)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    Ok(())
}

/// Validate that a task is ready for completion.
///
/// Shared by `complete_task` (public) and `complete_task_private` (ZK).
/// Checks status, status transition, deadline, claim, and competitive-task guard.
///
/// NOTE: This function intentionally does NOT check agent suspension status.
/// Agents that claimed a task before being suspended should still be able to
/// complete it and receive their reward. Suspension prevents new claims
/// (enforced in `claim_task.rs`), not completion of existing work.
pub fn validate_completion_prereqs(task: &Task, claim: &TaskClaim, clock: &Clock) -> Result<()> {
    // Defense-in-depth: reject terminal states with specific error codes (#959)
    require!(
        task.status != TaskStatus::Completed,
        CoordinationError::TaskAlreadyCompleted
    );
    require!(
        task.status != TaskStatus::Cancelled,
        CoordinationError::TaskCannotBeCancelled
    );

    require!(
        task.status == TaskStatus::InProgress,
        CoordinationError::TaskNotInProgress
    );
    require!(
        task.status.can_transition_to(TaskStatus::Completed),
        CoordinationError::InvalidStatusTransition
    );
    if task.deadline > 0 {
        require!(
            clock.unix_timestamp <= task.deadline,
            CoordinationError::DeadlinePassed
        );
    }
    require!(
        !claim.is_completed,
        CoordinationError::ClaimAlreadyCompleted
    );
    if task.task_type == TaskType::Competitive {
        require!(
            task.completions == 0,
            CoordinationError::CompetitiveTaskAlreadyWon
        );
    }
    Ok(())
}

/// Validate that a task's dependency requirements are met before completion.
///
/// If the task has a `DependencyType::Proof` dependency, the parent task must be
/// provided in `remaining_accounts[0]` and must have `TaskStatus::Completed`.
///
/// Shared by `complete_task` (public) and `complete_task_private` (ZK).
pub fn validate_task_dependency(
    task: &Task,
    remaining_accounts: &[AccountInfo],
    program_id: &Pubkey,
) -> Result<()> {
    if task.dependency_type == DependencyType::Proof {
        // Parent task account must be provided in remaining_accounts
        let parent_task_key = task
            .depends_on
            .ok_or(CoordinationError::InvalidDependencyType)?;

        // Get parent task from remaining_accounts
        require!(
            !remaining_accounts.is_empty(),
            CoordinationError::ParentTaskAccountRequired
        );
        let parent_task_info = &remaining_accounts[0];

        // Validate the account matches the expected parent
        require!(
            parent_task_info.key() == parent_task_key,
            CoordinationError::InvalidInput
        );

        // Validate owner is this program
        require!(
            parent_task_info.owner == program_id,
            CoordinationError::InvalidAccountOwner
        );

        // Deserialize and check parent task status.
        // BRICK-SAFE: the 149 live parents are at OLD_TASK_SIZE(382) until migrated,
        // but the Task type is now SIZE(466). Borsh tolerates trailing bytes
        // but NOT missing ones, so a raw `Task::try_deserialize` of a 382B parent would
        // FAIL and brick create_dependent_task against every un-migrated parent. Since
        // the new fields are append-only, zero-pad a short legacy account up to SIZE
        // (operator=default/fee=0/_reserved=0) before deserializing; we only read
        // `status`, which lives entirely within the unchanged 374-byte prefix.
        let parent_data = parent_task_info.try_borrow_data()?;
        let parent_task = if parent_data.len() >= Task::SIZE {
            Task::try_deserialize(&mut &parent_data[..])
                .map_err(|_| CoordinationError::InvalidInput)?
        } else {
            require!(
                parent_data.len() >= Task::OLD_TASK_SIZE,
                CoordinationError::InvalidInput
            );
            let mut buf = parent_data.to_vec();
            buf.resize(Task::SIZE, 0);
            Task::try_deserialize(&mut &buf[..]).map_err(|_| CoordinationError::InvalidInput)?
        };

        require!(
            parent_task.status == TaskStatus::Completed,
            CoordinationError::ParentTaskNotCompleted
        );
    }

    Ok(())
}

/// Calculate protocol fee with reputation-based discount.
///
/// Uses the task-locked fee (not current protocol config) per PR #479.
/// Floors at 1 bps to prevent zero-fee completion.
pub fn calculate_fee_with_reputation(task_protocol_fee_bps: u16, worker_reputation: u16) -> u16 {
    let rep_discount = calculate_reputation_fee_discount(worker_reputation);
    task_protocol_fee_bps.saturating_sub(rep_discount).max(1)
}

/// The optional operator (embedding-site) leg of a 3-way settlement (spec §4).
///
/// Present only for tasks minted by `hire_from_listing`, which records the
/// operator payee + fee snapshot in a `HireRecord`. `payee` receives the operator
/// fee in lamports; `fee_bps` is the snapshotted operator fee in basis points.
pub struct OperatorLeg<'info> {
    pub payee: AccountInfo<'info>,
    pub fee_bps: u16,
}

/// Compute the operator fee leg from a settlement `base` (= reward-per-worker, i.e.
/// `worker_reward + protocol_fee` of the 2-way split) and enforce the spec §4
/// economic invariants.
///
/// Invariants (defense in depth — the bps are already bounded at listing creation
/// by `MAX_OPERATOR_FEE_BPS`, and protocol fees by `MAX_PROTOCOL_FEE_BPS`):
///   * operator fee ≤ `MAX_OPERATOR_FEE_BPS`
///   * after both the AgenC (protocol) and operator legs, the worker keeps
///     ≥ `WORKER_FLOOR_BPS` of `base`
pub fn calculate_operator_fee(
    base: u64,
    protocol_fee_bps: u16,
    operator_fee_bps: u16,
) -> Result<u64> {
    require!(
        operator_fee_bps <= MAX_OPERATOR_FEE_BPS,
        CoordinationError::ListingOperatorFeeTooHigh
    );
    // Worker floor, checked in bps to avoid rounding ambiguity: the combined fee
    // legs must leave the worker at least WORKER_FLOOR_BPS.
    let combined_bps = (protocol_fee_bps as u64)
        .checked_add(operator_fee_bps as u64)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let worker_bps = BASIS_POINTS_DIVISOR
        .checked_sub(combined_bps)
        .ok_or(CoordinationError::WorkerRewardBelowFloor)?;
    require!(
        worker_bps >= WORKER_FLOOR_BPS as u64,
        CoordinationError::WorkerRewardBelowFloor
    );
    let operator_fee = base
        .checked_mul(operator_fee_bps as u64)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(BASIS_POINTS_DIVISOR)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    Ok(operator_fee)
}

/// The optional referrer (demand-side embedder) leg of a 4-way settlement (spec §4,
/// P6.2). Present only for tasks whose hire/create snapshotted a non-zero referrer
/// fee onto the `Task` (or its `HireRecord`). `payee` receives the referrer fee in
/// lamports; `fee_bps` is the snapshotted referrer fee in basis points.
pub struct ReferrerLeg<'info> {
    pub payee: AccountInfo<'info>,
    pub fee_bps: u16,
}

/// Compute the operator + referrer fee legs from a settlement `base` and enforce the
/// spec §4 4-way economic invariants in ONE place, so the combined-cap math can
/// never disagree between the two legs.
///
/// Invariants (defense in depth; the bps are also bounded at their source):
///   * operator fee ≤ `MAX_OPERATOR_FEE_BPS`
///   * referrer fee ≤ `MAX_REFERRER_FEE_BPS`
///   * COMBINED CAP: `protocol + operator + referrer ≤ MAX_COMBINED_FEE_BPS`
///     (4000 bps), i.e. the worker ALWAYS keeps ≥ `WORKER_FLOOR_BPS` (6000).
///
/// Returns `(operator_fee, referrer_fee)` in lamports (each floored independently,
/// so the worker keeps any rounding dust).
pub fn calculate_combined_fees(
    base: u64,
    protocol_fee_bps: u16,
    operator_fee_bps: u16,
    referrer_fee_bps: u16,
) -> Result<(u64, u64)> {
    require!(
        operator_fee_bps <= MAX_OPERATOR_FEE_BPS,
        CoordinationError::ListingOperatorFeeTooHigh
    );
    require!(
        referrer_fee_bps <= MAX_REFERRER_FEE_BPS,
        CoordinationError::ReferrerFeeTooHigh
    );
    // Combined cap, checked in bps to avoid rounding ambiguity: protocol + operator +
    // referrer must leave the worker at least WORKER_FLOOR_BPS. The cap is the
    // BINDING money-safety invariant for the 4-way split.
    let combined_bps = (protocol_fee_bps as u64)
        .checked_add(operator_fee_bps as u64)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_add(referrer_fee_bps as u64)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    require!(
        combined_bps <= MAX_COMBINED_FEE_BPS as u64,
        CoordinationError::CombinedFeeAboveCap
    );
    let worker_bps = BASIS_POINTS_DIVISOR
        .checked_sub(combined_bps)
        .ok_or(CoordinationError::CombinedFeeAboveCap)?;
    require!(
        worker_bps >= WORKER_FLOOR_BPS as u64,
        CoordinationError::CombinedFeeAboveCap
    );
    let operator_fee = base
        .checked_mul(operator_fee_bps as u64)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(BASIS_POINTS_DIVISOR)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let referrer_fee = base
        .checked_mul(referrer_fee_bps as u64)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(BASIS_POINTS_DIVISOR)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    Ok((operator_fee, referrer_fee))
}

/// Normalize + validate referrer args at snapshot time (hire / create-task), so a
/// bad referral is rejected at task creation rather than surfacing only at
/// settlement. Returns the canonical `(referrer_pubkey, referrer_fee_bps)` to stamp
/// onto the Task / HireRecord:
///   * `referrer == None` OR `referrer_fee_bps == 0` → `(default, 0)` (no leg).
///   * otherwise validates the per-leg cap, the combined cap against the (already
///     bounded) protocol + operator fees, and the no-self-deal guard.
///
/// `operator_fee_bps` is the operator leg that will co-exist on this task (0 when
/// there is none), so the combined cap is enforced at creation with the SAME math
/// the settlement path uses.
pub fn resolve_referrer_snapshot(
    referrer: Option<Pubkey>,
    referrer_fee_bps: u16,
    protocol_fee_bps: u16,
    operator_fee_bps: u16,
    creator: Pubkey,
) -> Result<(Pubkey, u16)> {
    let referrer_key = referrer.unwrap_or_default();
    if referrer_key == Pubkey::default() || referrer_fee_bps == 0 {
        // No leg. A non-zero fee with a default/absent payee is meaningless — reject
        // so the args can't silently drop the fee.
        require!(
            referrer_fee_bps == 0 || referrer_key != Pubkey::default(),
            CoordinationError::MissingReferrerAccount
        );
        return Ok((Pubkey::default(), 0));
    }
    require!(
        referrer_fee_bps <= MAX_REFERRER_FEE_BPS,
        CoordinationError::ReferrerFeeTooHigh
    );
    // Combined cap (protocol + operator + referrer ≤ MAX_COMBINED_FEE_BPS) checked at
    // creation — same invariant as settlement, surfaced early.
    let combined = (protocol_fee_bps as u32)
        .checked_add(operator_fee_bps as u32)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_add(referrer_fee_bps as u32)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    require!(
        combined <= MAX_COMBINED_FEE_BPS as u32,
        CoordinationError::CombinedFeeAboveCap
    );
    // No self-deal: the buyer/creator cannot pay themselves the referrer leg.
    require!(
        referrer_key != creator,
        CoordinationError::ReferrerIsCreator
    );
    Ok((referrer_key, referrer_fee_bps))
}

/// Build the optional `ReferrerLeg` from a snapshotted `(referrer, referrer_fee_bps)`
/// and the optional referrer payee account, mirroring the per-caller operator-leg
/// construction. Returns `Ok(None)` when there is no referrer leg (fee 0 or default
/// payee), or validates the supplied account matches the snapshot. A worker cannot
/// dodge the leg: the snapshot comes from program-owned state (the Task / its
/// HireRecord), and the leg becomes REQUIRED whenever the snapshot carries a fee.
pub fn build_referrer_leg<'info>(
    referrer: Pubkey,
    referrer_fee_bps: u16,
    referrer_account: Option<&AccountInfo<'info>>,
) -> Result<Option<ReferrerLeg<'info>>> {
    if referrer_fee_bps == 0 || referrer == Pubkey::default() {
        return Ok(None);
    }
    let acct = referrer_account.ok_or(CoordinationError::MissingReferrerAccount)?;
    require!(
        acct.key() == referrer,
        CoordinationError::InvalidReferrerAccount
    );
    Ok(Some(ReferrerLeg {
        payee: acct.clone(),
        fee_bps: referrer_fee_bps,
    }))
}

/// Execute reward transfer, state updates, event emissions, and conditional escrow closure.
///
/// Shared by both `complete_task` (public) and `complete_task_private` (ZK) handlers.
///
/// When all required completions are done (`task.completions >= task.required_completions`),
/// the escrow account is closed with Anchor's close helper so remaining lamports
/// are transferred to the creator and the account is assigned back to the system
/// program. For collaborative tasks with multiple workers, the escrow stays open
/// until the final completion.
///
/// # Preconditions
///
/// The caller MUST set these claim fields before calling:
/// - `claim.proof_hash`
/// - `claim.result_data`
/// - `claim.is_completed`
/// - `claim.completed_at`
///
/// The `TaskCompleted` event reads `proof_hash` and `result_data` from the claim.
pub fn execute_completion_rewards<'a, 'info>(
    task: &mut Account<'info, Task>,
    claim: &mut Account<'info, TaskClaim>,
    escrow: &mut Account<'info, TaskEscrow>,
    worker: &mut Account<'info, AgentRegistration>,
    protocol_config: &mut Account<'info, ProtocolConfig>,
    authority_info: &AccountInfo<'info>,
    treasury_info: &AccountInfo<'info>,
    creator_info: &AccountInfo<'info>,
    protocol_fee_bps: u16,
    reward_amount_override: Option<u64>,
    result_data_for_task: Option<[u8; RESULT_DATA_SIZE]>,
    clock: &Clock,
    token_accounts: Option<TokenPaymentAccounts<'a, 'info>>,
    operator_leg: Option<OperatorLeg<'info>>,
    referrer_leg: Option<ReferrerLeg<'info>>,
) -> Result<()> {
    let settlement_amount = reward_amount_override.unwrap_or(task.reward_amount);
    let (mut worker_reward, protocol_fee) = match reward_amount_override {
        Some(amount) => calculate_reward_split_for_amount(amount, protocol_fee_bps)?,
        None => calculate_reward_split(task, protocol_fee_bps)?,
    };

    // §4 3-/4-way split: resolve the active operator + referrer fee bps (0 when a leg
    // is absent or its payee is default), then carve BOTH legs out of the worker's
    // share through a SINGLE combined-cap calculation so the math can never disagree.
    // STRICTLY gated — when neither leg is supplied (every existing and non-hire,
    // non-referred task), both fees are 0 and the 2-way behavior below is
    // byte-for-byte unchanged. Both legs are SOL-only (they originate from on-chain
    // snapshots set on SOL hires), so a present leg forbids the token path.
    let operator_active = matches!(
        operator_leg.as_ref(),
        Some(leg) if leg.fee_bps > 0 && leg.payee.key() != Pubkey::default()
    );
    let referrer_active = matches!(
        referrer_leg.as_ref(),
        Some(leg) if leg.fee_bps > 0 && leg.payee.key() != Pubkey::default()
    );
    let operator_fee_bps = if operator_active {
        operator_leg.as_ref().map(|l| l.fee_bps).unwrap_or(0)
    } else {
        0
    };
    let referrer_fee_bps = if referrer_active {
        referrer_leg.as_ref().map(|l| l.fee_bps).unwrap_or(0)
    } else {
        0
    };

    let (operator_fee, referrer_fee) = if operator_active || referrer_active {
        require!(
            task.reward_mint.is_none() && token_accounts.is_none(),
            CoordinationError::InvalidTokenMint
        );
        let base = worker_reward
            .checked_add(protocol_fee)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        let (op_fee, ref_fee) =
            calculate_combined_fees(base, protocol_fee_bps, operator_fee_bps, referrer_fee_bps)?;
        // Carve both legs out of the worker's share (protocol fee was already split
        // off above). The combined cap guarantees the worker stays ≥ WORKER_FLOOR_BPS,
        // but re-check > 0 to the lamport for the rounding/dust edge.
        let total_legs = op_fee
            .checked_add(ref_fee)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        worker_reward = worker_reward
            .checked_sub(total_legs)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        require!(worker_reward > 0, CoordinationError::RewardTooSmall);
        (op_fee, ref_fee)
    } else {
        (0, 0)
    };

    // Checks: validate escrow balance for SOL path before any state mutations.
    if token_accounts.is_none() {
        let total = worker_reward
            .checked_add(protocol_fee)
            .ok_or(CoordinationError::ArithmeticOverflow)?
            .checked_add(operator_fee)
            .ok_or(CoordinationError::ArithmeticOverflow)?
            .checked_add(referrer_fee)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        require!(
            escrow.to_account_info().lamports() >= total,
            CoordinationError::InsufficientEscrowBalance
        );
    }

    // Effects: update all internal state BEFORE external CPIs.
    // This follows the checks-effects-interactions pattern to prevent
    // stale state reads via Token-2022 transfer hooks or future CPI callbacks.
    update_claim_state(claim, escrow, worker_reward, protocol_fee)?;
    // The operator + referrer legs are also withdrawn from escrow — track them in
    // `distributed` so dispute remaining-funds accounting stays accurate.
    let extra_legs = operator_fee
        .checked_add(referrer_fee)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    if extra_legs > 0 {
        escrow.distributed = escrow
            .distributed
            .checked_add(extra_legs)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
    }
    let task_completed =
        update_task_state(task, clock.unix_timestamp, escrow, result_data_for_task)?;
    let (old_rep, new_rep) = update_worker_state(worker, worker_reward, clock.unix_timestamp)?;

    if old_rep != new_rep {
        emit!(ReputationChanged {
            agent_id: worker.agent_id,
            old_reputation: old_rep,
            new_reputation: new_rep,
            reason: reputation_reason::COMPLETION,
            timestamp: clock.unix_timestamp,
        });
    }

    if task_completed {
        update_protocol_stats(protocol_config, settlement_amount)?;
    }

    emit!(TaskCompleted {
        task_id: task.task_id,
        worker: worker.key(),
        proof_hash: claim.proof_hash,
        result_data: claim.result_data,
        reward_paid: worker_reward,
        timestamp: clock.unix_timestamp,
    });

    emit!(RewardDistributed {
        task_id: task.task_id,
        recipient: worker.key(),
        amount: worker_reward,
        protocol_fee,
        timestamp: clock.unix_timestamp,
    });

    // §4 3-way split: announce the operator leg and prepare it for transfer. Both
    // are no-ops when `operator_fee == 0` (the 2-way path).
    if operator_fee > 0 {
        if let Some(leg) = operator_leg.as_ref() {
            emit!(OperatorFeePaid {
                task_id: task.task_id,
                operator: leg.payee.key(),
                amount: operator_fee,
                operator_fee_bps: leg.fee_bps,
                timestamp: clock.unix_timestamp,
            });
        }
    }
    // §4 4-way split (P6.2): announce the referrer leg and prepare it for transfer.
    // No-op when `referrer_fee == 0` (the common path).
    if referrer_fee > 0 {
        if let Some(leg) = referrer_leg.as_ref() {
            emit!(ReferrerFeePaid {
                task_id: task.task_id,
                referrer: leg.payee.key(),
                amount: referrer_fee,
                referrer_fee_bps: leg.fee_bps,
                timestamp: clock.unix_timestamp,
            });
        }
    }
    let operator_xfer: Option<(&AccountInfo<'info>, u64)> = if operator_fee > 0 {
        operator_leg.as_ref().map(|leg| (&leg.payee, operator_fee))
    } else {
        None
    };
    let referrer_xfer: Option<(&AccountInfo<'info>, u64)> = if referrer_fee > 0 {
        referrer_leg.as_ref().map(|leg| (&leg.payee, referrer_fee))
    } else {
        None
    };

    // Interactions: external CPIs AFTER all state updates and events.
    #[cfg(feature = "spl-token-rewards")]
    {
        let mut token_accounts = token_accounts;
        if let Some(ref mut ta) = token_accounts {
            transfer_token_rewards(ta, worker_reward, protocol_fee)?;
        } else {
            transfer_rewards(
                escrow,
                authority_info,
                treasury_info,
                worker_reward,
                protocol_fee,
                operator_xfer,
                referrer_xfer,
            )?;
        }

        // Only close escrow when task is fully completed (all required completions done).
        // For collaborative tasks with max_workers > 1, this keeps the escrow open
        // for subsequent workers to complete and receive their share.
        if task_completed {
            if let Some(ref mut ta) = token_accounts {
                // Close token escrow ATA first, return rent to creator
                let task_key_bytes = ta.task_key.to_bytes();
                let bump_slice = [ta.escrow_bump];
                let escrow_seeds: &[&[u8]] = &[b"escrow", task_key_bytes.as_ref(), &bump_slice];
                let transferred_total = worker_reward
                    .checked_add(protocol_fee)
                    .ok_or(CoordinationError::ArithmeticOverflow)?;
                let residual_amount = ta
                    .token_escrow_starting_amount
                    .checked_sub(transferred_total)
                    .ok_or(CoordinationError::ArithmeticOverflow)?;
                close_token_escrow_account_info(
                    ta.token_escrow_ata,
                    residual_amount,
                    &ta.treasury_token_account,
                    creator_info,
                    &ta.escrow_authority,
                    escrow_seeds,
                    ta.token_program,
                )?;
            }
            // Always close the escrow PDA (returns rent-exempt SOL to creator).
            // Anchor's close helper also assigns the account to the system program and
            // resizes it to zero, preventing exit serialization from writing TaskEscrow
            // data back into a zero-lamport account and failing the runtime rent check.
            close_escrow_to_creator(escrow, creator_info)?;
        }
    }

    #[cfg(not(feature = "spl-token-rewards"))]
    {
        let _ = token_accounts;
        require!(
            task.reward_mint.is_none(),
            CoordinationError::InvalidTokenMint
        );
        transfer_rewards(
            escrow,
            authority_info,
            treasury_info,
            worker_reward,
            protocol_fee,
            operator_xfer,
            referrer_xfer,
        )?;
        if task_completed {
            close_escrow_to_creator(escrow, creator_info)?;
        }
    }

    Ok(())
}

fn close_escrow_to_creator<'info>(
    escrow: &mut Account<'info, TaskEscrow>,
    creator_info: &AccountInfo<'info>,
) -> Result<()> {
    escrow.close(creator_info.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{DependencyType, TaskStatus};

    // ---- §4 3-way operator-fee split ----

    #[test]
    fn test_operator_fee_basic_math() {
        // base 1_000_000, protocol 100 bps (1%), operator 1000 bps (10%)
        // operator leg = 1_000_000 * 1000 / 10000 = 100_000
        let fee = calculate_operator_fee(1_000_000, 100, 1000).unwrap();
        assert_eq!(fee, 100_000);
    }

    #[test]
    fn test_operator_fee_zero_bps_is_zero() {
        assert_eq!(calculate_operator_fee(1_000_000, 100, 0).unwrap(), 0);
    }

    #[test]
    fn test_operator_fee_rejects_over_cap() {
        // operator_fee_bps above MAX_OPERATOR_FEE_BPS must be rejected.
        assert!(calculate_operator_fee(1_000_000, 100, MAX_OPERATOR_FEE_BPS + 1).is_err());
        assert!(calculate_operator_fee(1_000_000, 100, MAX_OPERATOR_FEE_BPS).is_ok());
    }

    #[test]
    fn test_operator_fee_enforces_worker_floor() {
        // Combined fee legs must leave the worker >= WORKER_FLOOR_BPS (6000).
        // protocol 2001 + operator 2000 = 4001 combined -> worker 5999 < 6000 -> err.
        // (operator stays within its own cap so this isolates the floor check.)
        assert!(calculate_operator_fee(1_000_000, 2001, MAX_OPERATOR_FEE_BPS).is_err());
        // Boundary: 2000 + 2000 = 4000 combined -> worker exactly 6000 -> ok.
        assert!(calculate_operator_fee(1_000_000, 2000, MAX_OPERATOR_FEE_BPS).is_ok());
    }

    #[test]
    fn test_operator_fee_rounds_down() {
        // 7 * 1000 / 10000 = 0.7 -> floors to 0 (worker keeps the dust).
        assert_eq!(calculate_operator_fee(7, 100, 1000).unwrap(), 0);
    }

    // ---- §4 4-way combined operator + referrer split (P6.2) ----

    #[test]
    fn test_combined_fees_4way_basic_math() {
        // base 1_000_000, protocol 100 bps (1%), operator 1000 bps (10%), referrer
        // 500 bps (5%). operator = 100_000, referrer = 50_000.
        let (op, rf) = calculate_combined_fees(1_000_000, 100, 1000, 500).unwrap();
        assert_eq!(op, 100_000);
        assert_eq!(rf, 50_000);
    }

    #[test]
    fn test_combined_fees_referrer_only() {
        // No operator leg: operator 0, referrer 2000 bps (20%) -> referrer = 200_000.
        let (op, rf) = calculate_combined_fees(1_000_000, 100, 0, 2000).unwrap();
        assert_eq!(op, 0);
        assert_eq!(rf, 200_000);
    }

    #[test]
    fn test_combined_fees_zero_legs_is_zero() {
        let (op, rf) = calculate_combined_fees(1_000_000, 100, 0, 0).unwrap();
        assert_eq!(op, 0);
        assert_eq!(rf, 0);
    }

    #[test]
    fn test_combined_fees_rejects_referrer_over_cap() {
        // referrer_fee_bps above MAX_REFERRER_FEE_BPS is rejected.
        assert!(calculate_combined_fees(1_000_000, 100, 0, MAX_REFERRER_FEE_BPS + 1).is_err());
        assert!(calculate_combined_fees(1_000_000, 100, 0, MAX_REFERRER_FEE_BPS).is_ok());
    }

    #[test]
    fn test_combined_fees_enforces_combined_cap() {
        // protocol 2000 + operator 2000 + referrer 1 = 4001 > MAX_COMBINED_FEE_BPS
        // (4000) -> rejected. The combined cap is the BINDING money-safety invariant.
        assert!(calculate_combined_fees(1_000_000, 2000, 2000, 1).is_err());
        // Boundary: 2000 + 1000 + 1000 = 4000 -> worker exactly 6000 -> ok.
        let (op, rf) = calculate_combined_fees(1_000_000, 2000, 1000, 1000).unwrap();
        assert_eq!(op, 100_000);
        assert_eq!(rf, 100_000);
    }

    #[test]
    fn test_combined_cap_constant_leaves_worker_floor() {
        // MAX_COMBINED_FEE_BPS + WORKER_FLOOR_BPS must be exactly 100% — the worker
        // floor is the complement of the combined fee cap.
        assert_eq!(
            MAX_COMBINED_FEE_BPS as u64 + WORKER_FLOOR_BPS as u64,
            BASIS_POINTS_DIVISOR
        );
    }

    #[test]
    fn test_combined_fees_round_down_independently() {
        // base 7, both legs 1000 bps: 7*1000/10000 = 0.7 -> 0 each (worker keeps dust).
        let (op, rf) = calculate_combined_fees(7, 100, 1000, 1000).unwrap();
        assert_eq!(op, 0);
        assert_eq!(rf, 0);
    }

    // ---- referrer snapshot validation (P6.2) ----

    #[test]
    fn test_resolve_referrer_none_is_no_leg() {
        let creator = Pubkey::new_unique();
        let (key, bps) = resolve_referrer_snapshot(None, 0, 100, 0, creator).unwrap();
        assert_eq!(key, Pubkey::default());
        assert_eq!(bps, 0);
    }

    #[test]
    fn test_resolve_referrer_zero_fee_is_no_leg() {
        // A referrer pubkey with 0 fee snapshots as no-leg.
        let creator = Pubkey::new_unique();
        let referrer = Pubkey::new_unique();
        let (key, bps) = resolve_referrer_snapshot(Some(referrer), 0, 100, 0, creator).unwrap();
        assert_eq!(key, Pubkey::default());
        assert_eq!(bps, 0);
    }

    #[test]
    fn test_resolve_referrer_nonzero_fee_default_payee_rejected() {
        // A non-zero fee with an absent/default payee is a misconfiguration — reject so
        // the fee can't be silently dropped.
        let creator = Pubkey::new_unique();
        assert!(resolve_referrer_snapshot(None, 500, 100, 0, creator).is_err());
        assert!(resolve_referrer_snapshot(Some(Pubkey::default()), 500, 100, 0, creator).is_err());
    }

    #[test]
    fn test_resolve_referrer_valid_snapshot() {
        let creator = Pubkey::new_unique();
        let referrer = Pubkey::new_unique();
        let (key, bps) =
            resolve_referrer_snapshot(Some(referrer), 500, 100, 1000, creator).unwrap();
        assert_eq!(key, referrer);
        assert_eq!(bps, 500);
    }

    #[test]
    fn test_resolve_referrer_self_deal_rejected() {
        // The creator cannot pay themselves the referrer leg.
        let creator = Pubkey::new_unique();
        assert!(resolve_referrer_snapshot(Some(creator), 500, 100, 0, creator).is_err());
    }

    #[test]
    fn test_resolve_referrer_combined_cap_at_creation() {
        // protocol 2000 + operator 2000 + referrer 1 = 4001 -> rejected at snapshot.
        let creator = Pubkey::new_unique();
        let referrer = Pubkey::new_unique();
        assert!(resolve_referrer_snapshot(Some(referrer), 1, 2000, 2000, creator).is_err());
        // 2000 + 1000 + 1000 = 4000 -> ok.
        assert!(resolve_referrer_snapshot(Some(referrer), 1000, 2000, 1000, creator).is_ok());
    }

    #[test]
    fn test_resolve_referrer_over_per_leg_cap_rejected() {
        let creator = Pubkey::new_unique();
        let referrer = Pubkey::new_unique();
        assert!(
            resolve_referrer_snapshot(Some(referrer), MAX_REFERRER_FEE_BPS + 1, 0, 0, creator)
                .is_err()
        );
    }

    /// Create a test task with configurable parameters
    fn build_test_task_fixture(
        task_type: TaskType,
        reward_amount: u64,
        required_completions: u8,
        completions: u8,
    ) -> Task {
        Task {
            task_id: [0u8; 32],
            creator: Pubkey::default(),
            required_capabilities: 0,
            description: [0u8; 64],
            constraint_hash: [0u8; 32],
            reward_amount,
            max_workers: 1,
            current_workers: 1,
            status: TaskStatus::InProgress,
            task_type,
            created_at: 0,
            deadline: 0,
            completed_at: 0,
            escrow: Pubkey::default(),
            result: [0u8; 64],
            required_completions,
            completions,
            bump: 0,
            protocol_fee_bps: 100, // 1% default for tests
            depends_on: None,
            dependency_type: DependencyType::default(),
            min_reputation: 0,
            reward_mint: None,
            operator: Pubkey::default(),
            operator_fee_bps: 0,
            _reserved: [0u8; 16],
            referrer: Pubkey::default(),
            referrer_fee_bps: 0,
        }
    }

    fn leak_pubkey(key: Pubkey) -> &'static Pubkey {
        Box::leak(Box::new(key))
    }

    fn leak_lamports(lamports: u64) -> &'static mut u64 {
        Box::leak(Box::new(lamports))
    }

    fn leak_data(data: Vec<u8>) -> &'static mut [u8] {
        // Solana's `AccountInfo::realloc` (invoked by `Account::close`) writes the
        // new length to the 8 bytes immediately BEFORE the data pointer — real
        // runtime accounts carry that header. A plain `Box::leak`'d slice has
        // nothing before it, so that write lands before the allocation and
        // corrupts heap metadata (double free / corrupted size on a later free).
        // Prepend an 8-byte length header and return the data region after it, so
        // realloc's write to `(data_ptr - 8)` stays inside our owned allocation.
        let len = data.len();
        let mut buf = Vec::with_capacity(8 + len);
        buf.extend_from_slice(&(len as u64).to_le_bytes());
        buf.extend_from_slice(&data);
        let raw: *mut [u8] = Box::into_raw(buf.into_boxed_slice());
        // SAFETY: `raw` is a leaked (never-freed) allocation of `8 + len` bytes, so
        // the returned 'static slice is sound and the 8-byte header before it is
        // valid owned memory.
        unsafe {
            let data_ptr = (raw as *mut u8).add(8);
            std::slice::from_raw_parts_mut(data_ptr, len)
        }
    }

    fn build_unchecked_account(
        key: Pubkey,
        owner: Pubkey,
        lamports: u64,
        data: Vec<u8>,
    ) -> UncheckedAccount<'static> {
        let account_info = AccountInfo::new(
            leak_pubkey(key),
            false,
            true,
            leak_lamports(lamports),
            leak_data(data),
            leak_pubkey(owner),
            false,
            0,
        );
        UncheckedAccount::try_from(Box::leak(Box::new(account_info)))
    }

    fn serialize_account<T: AccountSerialize>(account: &T) -> Vec<u8> {
        let mut data = Vec::new();
        account.try_serialize(&mut data).unwrap();
        data
    }

    fn assert_anchor_error_code<T>(result: Result<T>, expected: CoordinationError) {
        let expected_code: u32 = expected.into();
        match result {
            Ok(_) => panic!("expected AnchorError code {expected_code}, got success"),
            Err(anchor_lang::error::Error::AnchorError(anchor_err)) => {
                assert_eq!(anchor_err.error_code_number, expected_code);
            }
            Err(other) => {
                panic!("expected AnchorError code {expected_code}, got {other:?}");
            }
        }
    }

    mod load_task_claim_or_not_claimed_tests {
        use super::*;
        use anchor_lang::solana_program::system_program;

        #[test]
        fn test_closed_claim_pda_returns_not_claimed() {
            let task_key = Pubkey::new_unique();
            let claim_account =
                build_unchecked_account(Pubkey::new_unique(), system_program::ID, 0, Vec::new());

            assert_anchor_error_code(
                load_task_claim_or_not_claimed(&claim_account, &task_key),
                CoordinationError::NotClaimed,
            );
        }

        #[test]
        fn test_initialized_claim_deserializes_successfully() {
            let task_key = Pubkey::new_unique();
            let worker = Pubkey::new_unique();
            let claim = TaskClaim {
                task: task_key,
                worker,
                bump: 1,
                ..TaskClaim::default()
            };
            let claim_account = build_unchecked_account(
                Pubkey::new_unique(),
                crate::ID,
                1,
                serialize_account(&claim),
            );

            let loaded = load_task_claim_or_not_claimed(&claim_account, &task_key).unwrap();

            assert_eq!(loaded.task, task_key);
            assert_eq!(loaded.worker, worker);
            assert_eq!(loaded.bump, 1);
        }

        #[test]
        fn test_claim_for_different_task_returns_not_claimed() {
            let expected_task = Pubkey::new_unique();
            let claim = TaskClaim {
                task: Pubkey::new_unique(),
                worker: Pubkey::new_unique(),
                bump: 1,
                ..TaskClaim::default()
            };
            let claim_account = build_unchecked_account(
                Pubkey::new_unique(),
                crate::ID,
                1,
                serialize_account(&claim),
            );

            assert_anchor_error_code(
                load_task_claim_or_not_claimed(&claim_account, &expected_task),
                CoordinationError::NotClaimed,
            );
        }
    }

    mod close_escrow_to_creator_tests {
        use super::*;
        use anchor_lang::solana_program::system_program;

        #[test]
        fn closes_escrow_without_exit_serializing_zero_lamport_data() {
            let escrow_key = Pubkey::new_unique();
            let creator_key = Pubkey::new_unique();
            let starting_escrow_lamports = 5_000;
            let starting_creator_lamports = 100;
            let escrow_state = TaskEscrow {
                task: Pubkey::new_unique(),
                amount: 10_000,
                distributed: 10_000,
                is_closed: true,
                bump: 1,
            };
            let escrow_info = AccountInfo::new(
                leak_pubkey(escrow_key),
                false,
                true,
                leak_lamports(starting_escrow_lamports),
                leak_data(serialize_account(&escrow_state)),
                leak_pubkey(crate::ID),
                false,
                0,
            );
            let creator_info = AccountInfo::new(
                leak_pubkey(creator_key),
                false,
                true,
                leak_lamports(starting_creator_lamports),
                leak_data(Vec::new()),
                leak_pubkey(system_program::ID),
                false,
                0,
            );
            let mut escrow = Account::<TaskEscrow>::try_from(Box::leak(Box::new(escrow_info)))
                .expect("escrow account should deserialize");

            close_escrow_to_creator(&mut escrow, &creator_info)
                .expect("escrow close should succeed");
            escrow
                .exit(&crate::ID)
                .expect("closed escrow should not be serialized on exit");

            let closed_escrow = escrow.to_account_info();
            assert_eq!(closed_escrow.lamports(), 0);
            assert_eq!(
                creator_info.lamports(),
                starting_creator_lamports + starting_escrow_lamports
            );
            assert_eq!(closed_escrow.owner, &system_program::ID);
            assert!(closed_escrow.data_is_empty());
        }
    }

    mod calculate_reward_per_worker_tests {
        use super::*;

        #[test]
        fn test_exclusive_task_full_reward() {
            let task = build_test_task_fixture(TaskType::Exclusive, 1000, 1, 0);
            let reward = calculate_reward_per_worker(&task).unwrap();
            assert_eq!(reward, 1000);
        }

        #[test]
        fn test_competitive_task_full_reward() {
            let task = build_test_task_fixture(TaskType::Competitive, 1000, 1, 0);
            let reward = calculate_reward_per_worker(&task).unwrap();
            assert_eq!(reward, 1000);
        }

        #[test]
        fn test_bid_exclusive_task_full_reward() {
            let task = build_test_task_fixture(TaskType::BidExclusive, 1000, 1, 0);
            let reward = calculate_reward_per_worker(&task).unwrap();
            assert_eq!(reward, 1000);
        }

        #[test]
        fn test_collaborative_task_even_split() {
            // 1000 / 4 = 250 per worker
            let task = build_test_task_fixture(TaskType::Collaborative, 1000, 4, 0);
            let reward = calculate_reward_per_worker(&task).unwrap();
            assert_eq!(reward, 250);
        }

        #[test]
        fn test_collaborative_task_fair_rounding_first_worker_gets_extra() {
            // 1003 / 4 = 250 with remainder 3
            // First 3 workers (indices 0,1,2) get 251, last worker gets 250
            let task = build_test_task_fixture(TaskType::Collaborative, 1003, 4, 0);
            let reward = calculate_reward_per_worker(&task).unwrap();
            assert_eq!(reward, 251); // Worker 0 gets +1
        }

        #[test]
        fn test_collaborative_task_fair_rounding_middle_worker() {
            // 1003 / 4 = 250 with remainder 3
            // Worker index 2 (third worker) still gets +1
            let task = build_test_task_fixture(TaskType::Collaborative, 1003, 4, 2);
            let reward = calculate_reward_per_worker(&task).unwrap();
            assert_eq!(reward, 251); // Worker 2 gets +1
        }

        #[test]
        fn test_collaborative_task_fair_rounding_last_worker_no_extra() {
            // 1003 / 4 = 250 with remainder 3
            // Last worker (index 3) doesn't get extra since 3 >= remainder
            let task = build_test_task_fixture(TaskType::Collaborative, 1003, 4, 3);
            let reward = calculate_reward_per_worker(&task).unwrap();
            assert_eq!(reward, 250); // Worker 3 gets base only
        }

        #[test]
        fn test_collaborative_task_fair_rounding_all_workers() {
            // 1003 / 4 = 250 with remainder 3
            // Verify total: 251 + 251 + 251 + 250 = 1003
            let mut total = 0u64;
            for i in 0..4 {
                let task = build_test_task_fixture(TaskType::Collaborative, 1003, 4, i);
                total += calculate_reward_per_worker(&task).unwrap();
            }
            assert_eq!(total, 1003);
        }

        #[test]
        fn test_collaborative_single_worker() {
            let task = build_test_task_fixture(TaskType::Collaborative, 1000, 1, 0);
            let reward = calculate_reward_per_worker(&task).unwrap();
            assert_eq!(reward, 1000);
        }

        #[test]
        fn test_large_reward_no_overflow() {
            let task =
                build_test_task_fixture(TaskType::Exclusive, u64::MAX.saturating_sub(1), 1, 0);
            let reward = calculate_reward_per_worker(&task).unwrap();
            assert_eq!(reward, u64::MAX.saturating_sub(1));
        }
    }

    mod calculate_reward_split_tests {
        use super::*;

        #[test]
        fn test_zero_protocol_fee() {
            let task = build_test_task_fixture(TaskType::Exclusive, 1000, 1, 0);
            let (worker, fee) = calculate_reward_split(&task, 0).unwrap();
            assert_eq!(worker, 1000);
            assert_eq!(fee, 0);
        }

        #[test]
        fn test_1_percent_fee() {
            // 1% = 100 basis points
            let task = build_test_task_fixture(TaskType::Exclusive, 10000, 1, 0);
            let (worker, fee) = calculate_reward_split(&task, 100).unwrap();
            assert_eq!(fee, 100); // 1% of 10000
            assert_eq!(worker, 9900);
        }

        #[test]
        fn test_10_percent_fee() {
            // 10% = 1000 basis points
            let task = build_test_task_fixture(TaskType::Exclusive, 10000, 1, 0);
            let (worker, fee) = calculate_reward_split(&task, 1000).unwrap();
            assert_eq!(fee, 1000); // 10% of 10000
            assert_eq!(worker, 9000);
        }

        #[test]
        fn test_fee_rounds_down() {
            // 1% of 99 = 0.99, rounds down to 0
            let task = build_test_task_fixture(TaskType::Exclusive, 99, 1, 0);
            let (worker, fee) = calculate_reward_split(&task, 100).unwrap();
            assert_eq!(fee, 0);
            assert_eq!(worker, 99);
        }

        #[test]
        fn test_collaborative_with_fee() {
            // 4 workers, 10000 total = 2500 each
            // 5% fee on 2500 = 125
            let task = build_test_task_fixture(TaskType::Collaborative, 10000, 4, 0);
            let (worker, fee) = calculate_reward_split(&task, 500).unwrap();
            assert_eq!(fee, 125); // 5% of 2500
            assert_eq!(worker, 2375);
        }

        #[test]
        fn test_max_fee_100_percent() {
            // 100% = 10000 basis points - takes all funds, leaving 0 for worker
            // This must fail with RewardTooSmall since worker_reward == 0
            let task = build_test_task_fixture(TaskType::Exclusive, 1000, 1, 0);
            let result = calculate_reward_split(&task, 10000);
            assert!(result.is_err(), "100% fee should fail: worker gets nothing");
        }

        #[test]
        fn test_small_reward_small_fee() {
            // 1 lamport reward with 1% fee = 0 fee (rounds down)
            let task = build_test_task_fixture(TaskType::Exclusive, 1, 1, 0);
            let (worker, fee) = calculate_reward_split(&task, 100).unwrap();
            assert_eq!(fee, 0);
            assert_eq!(worker, 1);
        }

        #[test]
        fn test_bid_price_override_fee_split() {
            let (worker, fee) = calculate_reward_split_for_amount(8_000, 500).unwrap();
            assert_eq!(fee, 400);
            assert_eq!(worker, 7_600);
        }
    }

    mod edge_cases {
        use super::*;

        #[test]
        fn test_zero_reward() {
            // Zero reward must fail with RewardTooSmall since worker gets nothing
            let task = build_test_task_fixture(TaskType::Exclusive, 0, 1, 0);
            let result = calculate_reward_split(&task, 100);
            assert!(
                result.is_err(),
                "Zero reward should fail: worker gets nothing"
            );
        }

        #[test]
        fn test_max_completions() {
            let task = build_test_task_fixture(TaskType::Collaborative, 25500, 255, 254);
            let reward = calculate_reward_per_worker(&task).unwrap();
            // 25500 / 255 = 100, remainder 0
            assert_eq!(reward, 100);
        }
    }

    mod task_state_counter_tests {
        use super::*;

        #[test]
        fn test_completion_counters_update_together() {
            let mut task = build_test_task_fixture(TaskType::Collaborative, 1000, 3, 1);
            task.current_workers = 2;

            update_task_completion_counters(&mut task).unwrap();

            assert_eq!(task.current_workers, 1);
            assert_eq!(task.completions, 2);
        }

        #[test]
        fn test_completion_counters_fail_on_worker_underflow() {
            let mut task = build_test_task_fixture(TaskType::Collaborative, 1000, 3, 1);
            task.current_workers = 0;

            let result = update_task_completion_counters(&mut task);

            assert!(result.is_err(), "worker counter underflow should fail");
        }
    }

    mod tiered_fee_tests {
        use super::*;

        #[test]
        fn test_tiered_split_base_tier() {
            // New creator with 0 completed tasks -> no discount
            let task = build_test_task_fixture(TaskType::Exclusive, 10000, 1, 0);
            let (worker, fee, effective_bps) =
                calculate_reward_split_tiered(&task, 100, 0).unwrap();
            assert_eq!(effective_bps, 100); // No discount
            assert_eq!(fee, 100);
            assert_eq!(worker, 9900);
        }

        #[test]
        fn test_tiered_split_bronze() {
            // Creator with 50 completed tasks -> 10 bps discount
            let task = build_test_task_fixture(TaskType::Exclusive, 10000, 1, 0);
            let (worker, fee, effective_bps) =
                calculate_reward_split_tiered(&task, 100, 50).unwrap();
            assert_eq!(effective_bps, 90); // 10 bps discount
            assert_eq!(fee, 90);
            assert_eq!(worker, 9910);
        }

        #[test]
        fn test_tiered_split_gold() {
            // Creator with 1000+ completed tasks -> 40 bps discount
            let task = build_test_task_fixture(TaskType::Exclusive, 10000, 1, 0);
            let (worker, fee, effective_bps) =
                calculate_reward_split_tiered(&task, 100, 1500).unwrap();
            assert_eq!(effective_bps, 60); // 40 bps discount
            assert_eq!(fee, 60);
            assert_eq!(worker, 9940);
        }

        #[test]
        fn test_tiered_split_collaborative() {
            // 4 workers, 10000 total = 2500 each, bronze tier
            let task = build_test_task_fixture(TaskType::Collaborative, 10000, 4, 0);
            let (worker, fee, effective_bps) =
                calculate_reward_split_tiered(&task, 500, 100).unwrap();
            assert_eq!(effective_bps, 490); // 10 bps discount on 500
            assert_eq!(fee, 122); // 4.9% of 2500 = 122.5 -> rounds down
            assert_eq!(worker, 2378);
        }
    }
}
