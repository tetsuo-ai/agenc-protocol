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
    MAX_REPUTATION, REPUTATION_FEE_LAMPORTS_PER_POINT, REPUTATION_PER_COMPLETION, WORKER_FLOOR_BPS,
};
use crate::instructions::lamport_transfer::transfer_lamports;
use crate::instructions::program_account_helpers::deserialize_program_account;
use crate::instructions::task_parent_helpers::load_canonical_parent_task;
#[cfg(feature = "spl-token-rewards")]
use crate::instructions::token_helpers::{
    close_token_escrow_account_info, transfer_tokens_from_escrow,
};
use crate::state::{
    AgentRegistration, DependencyType, HireRecord, ProtocolConfig, Task, TaskClaim, TaskEscrow,
    TaskStatus, TaskType, RESULT_DATA_SIZE,
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
/// pub(crate): Batch 3 `distribute_ghost_share` reuses the SAME split math for
/// each ghost slice (spec §3 — never fork the settlement math).
pub(crate) fn calculate_reward_split_for_amount(
    reward_per_worker: u64,
    protocol_fee_bps: u16,
) -> Result<(u64, u64)> {
    // u128 intermediates (audit F-16): reward.checked_mul(bps) overflows u64 for
    // rewards above ~1.8e15 lamports, DoS-ing settlement. The post-division result
    // always fits (fee <= base).
    let protocol_fee = (reward_per_worker as u128)
        .checked_mul(protocol_fee_bps as u128)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(BASIS_POINTS_DIVISOR as u128)
        .ok_or(CoordinationError::ArithmeticOverflow)? as u64;

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

/// Validate the creation-time funding floor implied by the collaborative share
/// formula below. Each required completion must have at least one gross reward
/// unit; otherwise the first `reward_amount` workers consume the remainder and a
/// later worker deterministically reaches `RewardTooSmall`, making successful
/// completion impossible.
pub(crate) fn validate_reward_covers_required_completions(
    task_type: TaskType,
    reward_amount: u64,
    required_completions: u8,
) -> Result<()> {
    if task_type == TaskType::Collaborative {
        require!(
            required_completions > 0 && reward_amount >= u64::from(required_completions),
            CoordinationError::RewardTooSmall
        );
    }
    Ok(())
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
pub fn load_task_claim_or_not_claimed(
    claim_info: &UncheckedAccount<'_>,
    task_key: &Pubkey,
) -> Result<TaskClaim> {
    if claim_info.owner == &anchor_lang::solana_program::system_program::ID
        && claim_info.lamports() == 0
    {
        return err!(CoordinationError::NotClaimed);
    }

    let claim = deserialize_program_account::<TaskClaim>(claim_info.as_ref())?;
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
    claim: &mut TaskClaim,
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

/// Denomination of a completed task's reward.
///
/// Protocol-wide value and agent earnings counters are SOL-denominated. Keeping the
/// denomination explicit prevents arbitrary SPL-token base units from poisoning those
/// counters or being mistaken for economic reputation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RewardDenomination {
    Sol,
    SplToken,
}

/// Calculate reputation earned from an economically settled completion.
///
/// Only irrecoverable SOL protocol fees count. The award is proportional and capped,
/// so dust tasks cannot wash reputation while large legitimate tasks cannot mint more
/// than the established per-completion maximum.
pub fn completion_reputation_gain(protocol_fee: u64, denomination: RewardDenomination) -> u16 {
    if denomination != RewardDenomination::Sol {
        return 0;
    }

    protocol_fee
        .checked_div(REPUTATION_FEE_LAMPORTS_PER_POINT)
        .unwrap_or(0)
        .min(REPUTATION_PER_COMPLETION as u64) as u16
}

/// Update worker statistics after task completion.
///
/// `total_earned` is explicitly SOL-denominated and therefore excludes SPL-token
/// rewards. Telemetry counters saturate instead of blocking a real settlement if a
/// legacy value is already at its integer ceiling. Returns `(old_reputation,
/// new_reputation)` for event emission.
pub fn update_worker_state(
    worker: &mut AgentRegistration,
    reward: u64,
    protocol_fee: u64,
    denomination: RewardDenomination,
    timestamp: i64,
) -> Result<(u16, u16)> {
    worker.tasks_completed = worker.tasks_completed.saturating_add(1);
    if denomination == RewardDenomination::Sol {
        worker.total_earned = worker.total_earned.saturating_add(reward);
    }
    worker.active_tasks = worker
        .active_tasks
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    worker.last_active = timestamp;
    // Reputation uses saturating_add intentionally: reaching MAX_REPUTATION is an
    // expected cap, not an error that should revert settlement.
    let old_rep = worker.reputation;
    let reputation_gain = completion_reputation_gain(protocol_fee, denomination);
    worker.reputation = worker
        .reputation
        .saturating_add(reputation_gain)
        .min(MAX_REPUTATION);
    Ok((old_rep, worker.reputation))
}

/// Update protocol statistics after task completion.
///
/// `total_value_distributed` is SOL-denominated and excludes unpriced SPL-token
/// units. Both values are telemetry: saturation must never freeze task settlement.
pub fn update_protocol_stats(
    config: &mut ProtocolConfig,
    reward: u64,
    denomination: RewardDenomination,
) {
    config.completed_tasks = config.completed_tasks.saturating_add(1);
    if denomination == RewardDenomination::Sol {
        config.total_value_distributed = config.total_value_distributed.saturating_add(reward);
    }
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

/// Validate that a task's dependency requirements are met before settlement.
/// Every dependency type requires the canonical parent to be Completed.
pub fn validate_task_dependency(
    task: &Task,
    remaining_accounts: &[AccountInfo],
    program_id: &Pubkey,
) -> Result<()> {
    if task.dependency_type != DependencyType::None {
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

        let parent_task = load_canonical_parent_task(parent_task_info, program_id)?;

        require!(
            parent_task.status == TaskStatus::Completed,
            CoordinationError::ParentTaskNotCompleted
        );
    }

    Ok(())
}

/// Assignment-time dependency gate. Every dependency type requires a completed
/// parent before a worker or bidder can take on an obligation. Allowing Data or
/// Ordering work to be assigned speculatively lets a malicious creator cancel the
/// parent, make the child impossible to complete, and later seize a worker's
/// no-show bond. Speculation may happen off-chain, but on-chain assignment cannot
/// create that asymmetric principal risk.
pub fn validate_task_dependency_for_assignment(
    task: &Task,
    remaining_accounts: &[AccountInfo],
    program_id: &Pubkey,
) -> Result<()> {
    validate_task_dependency(task, remaining_accounts, program_id)
}

/// Calculate protocol fee with reputation-based discount.
///
/// Uses the task-locked fee (not current protocol config) per PR #479.
/// Preserves an explicitly snapshotted zero-fee policy. Positive fees retain a
/// 1-bps floor so a reputation discount cannot erase them accidentally.
pub fn calculate_fee_with_reputation(task_protocol_fee_bps: u16, worker_reputation: u16) -> u16 {
    if task_protocol_fee_bps == 0 {
        return 0;
    }
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
    // u128 intermediates (audit F-16): base.checked_mul(bps) overflows u64 for
    // large rewards; the post-division fee always fits.
    let operator_fee = (base as u128)
        .checked_mul(operator_fee_bps as u128)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(BASIS_POINTS_DIVISOR as u128)
        .ok_or(CoordinationError::ArithmeticOverflow)? as u64;
    let referrer_fee = (base as u128)
        .checked_mul(referrer_fee_bps as u128)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(BASIS_POINTS_DIVISOR as u128)
        .ok_or(CoordinationError::ArithmeticOverflow)? as u64;
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

/// Resolve the immutable marketplace fee snapshot and build its payout legs.
///
/// Newer hires stamp the terms directly on `Task`; legacy hires retain them only
/// in the canonical `HireRecord`. Callers must seeds-pin `hire_record` to
/// `["hire", task]` in their `Accounts` struct before using this helper. An absent
/// record is accepted only as an empty system-owned account, preventing a caller
/// from substituting arbitrary data to suppress or redirect a fee leg.
pub fn build_marketplace_fee_legs<'info>(
    task: &Task,
    task_key: Pubkey,
    hire_record: &AccountInfo<'info>,
    operator_account: Option<&AccountInfo<'info>>,
    referrer_account: Option<&AccountInfo<'info>>,
) -> Result<(Option<OperatorLeg<'info>>, Option<ReferrerLeg<'info>>)> {
    let legacy_hire = if hire_record.owner == &crate::ID {
        let data = hire_record.try_borrow_data()?;
        let hire = HireRecord::try_deserialize(&mut &data[..])?;
        require!(hire.task == task_key, CoordinationError::InvalidHireRecord);
        Some(hire)
    } else {
        require!(
            hire_record.owner == &anchor_lang::system_program::ID && hire_record.data_is_empty(),
            CoordinationError::InvalidHireRecord
        );
        None
    };

    let (operator, operator_fee_bps, referrer, referrer_fee_bps) =
        if task.operator != Pubkey::default() || task.referrer != Pubkey::default() {
            (
                task.operator,
                task.operator_fee_bps,
                task.referrer,
                task.referrer_fee_bps,
            )
        } else if let Some(hire) = legacy_hire.as_ref() {
            (
                hire.operator,
                hire.operator_fee_bps,
                hire.referrer,
                hire.referrer_fee_bps,
            )
        } else {
            (Pubkey::default(), 0, Pubkey::default(), 0)
        };

    validate_marketplace_payee_destinations(
        task_key,
        task.escrow,
        task.creator,
        operator,
        operator_fee_bps,
        referrer,
        referrer_fee_bps,
    )?;

    let operator_leg = if operator_fee_bps > 0 && operator != Pubkey::default() {
        let account = operator_account.ok_or(CoordinationError::MissingOperatorAccount)?;
        require!(
            account.key() == operator,
            CoordinationError::InvalidOperatorAccount
        );
        Some(OperatorLeg {
            payee: account.clone(),
            fee_bps: operator_fee_bps,
        })
    } else {
        None
    };
    let referrer_leg = build_referrer_leg(referrer, referrer_fee_bps, referrer_account)?;

    Ok((operator_leg, referrer_leg))
}

/// Bind active marketplace payees away from task-owned lifecycle accounts.
///
/// A payee equal to the escrow makes a direct lamport transfer a net-zero while
/// settlement accounting records it as paid; closing escrow then returns the
/// retained fee to the creator. A payee equal to the Task similarly parks the fee
/// in a creator-closed lifecycle account. Creation paths call this before funding,
/// and settlement calls it again through `build_marketplace_fee_legs` for defense
/// in depth and legacy-state fail-closed behavior.
pub(crate) fn validate_marketplace_payee_destinations(
    task_key: Pubkey,
    escrow_key: Pubkey,
    creator: Pubkey,
    operator: Pubkey,
    operator_fee_bps: u16,
    referrer: Pubkey,
    referrer_fee_bps: u16,
) -> Result<()> {
    if operator_fee_bps > 0 {
        require!(
            operator != Pubkey::default(),
            CoordinationError::ListingOperatorRequired
        );
        require!(operator != creator, CoordinationError::OperatorIsCreator);
        require!(
            operator != task_key && operator != escrow_key,
            CoordinationError::MarketplacePayeeAccountAlias
        );
    }
    if referrer_fee_bps > 0 {
        require!(
            referrer != Pubkey::default(),
            CoordinationError::MissingReferrerAccount
        );
        require!(referrer != creator, CoordinationError::ReferrerIsCreator);
        require!(
            referrer != task_key && referrer != escrow_key,
            CoordinationError::MarketplacePayeeAccountAlias
        );
    }
    Ok(())
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
    claim: &mut TaskClaim,
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
    let denomination = if task.reward_mint.is_none() {
        RewardDenomination::Sol
    } else {
        RewardDenomination::SplToken
    };
    let (old_rep, new_rep) = update_worker_state(
        worker,
        worker_reward,
        protocol_fee,
        denomination,
        clock.unix_timestamp,
    )?;

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
        update_protocol_stats(protocol_config, settlement_amount, denomination);
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

    #[test]
    fn reputation_discount_preserves_explicit_free_protocol_policy() {
        for reputation in [0, 8_000, 9_000, 9_500, 10_000] {
            assert_eq!(calculate_fee_with_reputation(0, reputation), 0);
        }
        // A positive task snapshot remains positive even when the configured
        // reputation discount is larger than the snapshot.
        assert_eq!(calculate_fee_with_reputation(1, 10_000), 1);
        assert_eq!(calculate_fee_with_reputation(10, 10_000), 1);
    }

    #[test]
    fn reputation_requires_irrecoverable_sol_protocol_fees() {
        assert_eq!(completion_reputation_gain(0, RewardDenomination::Sol), 0);
        assert_eq!(
            completion_reputation_gain(
                REPUTATION_FEE_LAMPORTS_PER_POINT - 1,
                RewardDenomination::Sol,
            ),
            0
        );
        assert_eq!(
            completion_reputation_gain(REPUTATION_FEE_LAMPORTS_PER_POINT, RewardDenomination::Sol,),
            1
        );
        assert_eq!(
            completion_reputation_gain(
                REPUTATION_FEE_LAMPORTS_PER_POINT * REPUTATION_PER_COMPLETION as u64,
                RewardDenomination::Sol,
            ),
            REPUTATION_PER_COMPLETION
        );
        assert_eq!(
            completion_reputation_gain(u64::MAX, RewardDenomination::Sol),
            REPUTATION_PER_COMPLETION,
            "one settlement can never exceed the established completion cap"
        );
        assert_eq!(
            completion_reputation_gain(u64::MAX, RewardDenomination::SplToken),
            0,
            "arbitrary token base units have no trusted SOL valuation"
        );
    }

    #[test]
    fn token_completion_cannot_poison_sol_earnings_or_reputation() {
        let mut worker = AgentRegistration {
            tasks_completed: u64::MAX,
            total_earned: 42,
            reputation: 3_000,
            active_tasks: 1,
            ..AgentRegistration::default()
        };

        let (old_rep, new_rep) = update_worker_state(
            &mut worker,
            u64::MAX,
            u64::MAX,
            RewardDenomination::SplToken,
            123,
        )
        .unwrap();

        assert_eq!(worker.tasks_completed, u64::MAX);
        assert_eq!(worker.total_earned, 42);
        assert_eq!(worker.active_tasks, 0);
        assert_eq!(worker.last_active, 123);
        assert_eq!((old_rep, new_rep), (3_000, 3_000));
    }

    #[test]
    fn saturated_telemetry_never_blocks_a_completion() {
        let mut worker = AgentRegistration {
            tasks_completed: u64::MAX,
            total_earned: u64::MAX,
            reputation: MAX_REPUTATION - 1,
            active_tasks: 1,
            ..AgentRegistration::default()
        };
        update_worker_state(
            &mut worker,
            1,
            REPUTATION_FEE_LAMPORTS_PER_POINT,
            RewardDenomination::Sol,
            456,
        )
        .unwrap();
        assert_eq!(worker.tasks_completed, u64::MAX);
        assert_eq!(worker.total_earned, u64::MAX);
        assert_eq!(worker.reputation, MAX_REPUTATION);

        let mut config = ProtocolConfig {
            completed_tasks: u64::MAX,
            total_value_distributed: u64::MAX,
            ..ProtocolConfig::default()
        };
        update_protocol_stats(&mut config, u64::MAX, RewardDenomination::SplToken);
        update_protocol_stats(&mut config, 1, RewardDenomination::Sol);
        assert_eq!(config.completed_tasks, u64::MAX);
        assert_eq!(config.total_value_distributed, u64::MAX);
    }

    #[test]
    fn token_value_is_excluded_from_global_sol_aggregate() {
        let mut config = ProtocolConfig {
            completed_tasks: 7,
            total_value_distributed: 99,
            ..ProtocolConfig::default()
        };

        update_protocol_stats(&mut config, u64::MAX, RewardDenomination::SplToken);
        assert_eq!(config.completed_tasks, 8);
        assert_eq!(config.total_value_distributed, 99);

        update_protocol_stats(&mut config, 1, RewardDenomination::Sol);
        assert_eq!(config.completed_tasks, 9);
        assert_eq!(config.total_value_distributed, 100);
    }

    #[test]
    fn collaborative_reward_funding_enforces_the_exact_completion_boundary() {
        assert!(
            validate_reward_covers_required_completions(TaskType::Collaborative, 3, 4,).is_err()
        );
        assert!(
            validate_reward_covers_required_completions(TaskType::Collaborative, 4, 4,).is_ok()
        );
        assert!(
            validate_reward_covers_required_completions(TaskType::Collaborative, 5, 4,).is_ok()
        );
        assert!(validate_reward_covers_required_completions(TaskType::Exclusive, 1, 4,).is_ok());
    }

    #[test]
    fn collaborative_boundary_gives_every_required_completion_one_unit() {
        let mut task = build_test_task_fixture(TaskType::Collaborative, 4, 4, 0);
        for completion in 0..4 {
            task.completions = completion;
            assert_eq!(calculate_reward_per_worker(&task).unwrap(), 1);
            assert_eq!(calculate_reward_split(&task, 0).unwrap(), (1, 0));
        }

        task.reward_amount = 3;
        task.completions = 3;
        assert_eq!(calculate_reward_per_worker(&task).unwrap(), 0);
        assert!(calculate_reward_split(&task, 0).is_err());
    }

    #[test]
    fn active_marketplace_payees_cannot_alias_creator_task_or_escrow() {
        let task = Pubkey::new_unique();
        let escrow = Pubkey::new_unique();
        let creator = Pubkey::new_unique();
        let operator = Pubkey::new_unique();
        let referrer = Pubkey::new_unique();

        assert!(validate_marketplace_payee_destinations(
            task, escrow, creator, operator, 100, referrer, 100,
        )
        .is_ok());
        for alias in [creator, task, escrow] {
            assert!(validate_marketplace_payee_destinations(
                task, escrow, creator, alias, 100, referrer, 100,
            )
            .is_err());
            assert!(validate_marketplace_payee_destinations(
                task, escrow, creator, operator, 100, alias, 100,
            )
            .is_err());
        }
    }

    #[test]
    fn inactive_marketplace_payee_values_do_not_create_a_fee_leg() {
        let task = Pubkey::new_unique();
        let escrow = Pubkey::new_unique();
        let creator = Pubkey::new_unique();
        // Legacy listings may carry a non-default operator with zero fee. Since
        // no money moves, retaining this shape is backward-compatible and safe.
        assert!(validate_marketplace_payee_destinations(
            task,
            escrow,
            creator,
            escrow,
            0,
            Pubkey::default(),
            0,
        )
        .is_ok());
    }

    // ---- §4 4-way combined operator + referrer split (P6.2) ----
    // (`calculate_combined_fees` subsumes the retired `calculate_operator_fee`:
    // pass `referrer_fee_bps = 0` for the pure operator leg.)

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

    // Audit F-16 (revert-sensitive): u64 checked_mul fee math overflows for rewards
    // above u64::MAX / 10000 (~1.8e15 lamports); the u128 intermediates handle the
    // full u64 reward range. Reverting to u64 mul turns these red (ArithmeticOverflow).
    #[test]
    fn test_fee_math_handles_u64_scale_rewards() {
        let huge = u64::MAX / 4; // ~4.6e18 lamports
        let (worker_reward, protocol_fee) = calculate_reward_split_for_amount(huge, 100).unwrap();
        assert_eq!(protocol_fee, huge / 100);
        assert_eq!(worker_reward, huge - huge / 100);

        let (op, rf) = calculate_combined_fees(huge, 100, 1000, 500).unwrap();
        assert_eq!(op, huge / 10);
        assert_eq!(rf, huge / 20);
    }

    #[test]
    fn test_combined_fees_rejects_referrer_over_cap() {
        // referrer_fee_bps above MAX_REFERRER_FEE_BPS is rejected.
        assert!(calculate_combined_fees(1_000_000, 100, 0, MAX_REFERRER_FEE_BPS + 1).is_err());
        assert!(calculate_combined_fees(1_000_000, 100, 0, MAX_REFERRER_FEE_BPS).is_ok());
    }

    #[test]
    fn test_combined_fees_rejects_operator_over_cap() {
        // Per-leg operator cap is enforced independently of the referrer leg — the
        // coverage the retired `calculate_operator_fee` used to carry.
        assert!(calculate_combined_fees(1_000_000, 100, MAX_OPERATOR_FEE_BPS + 1, 0).is_err());
        assert!(calculate_combined_fees(1_000_000, 100, MAX_OPERATOR_FEE_BPS, 0).is_ok());
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

    #[test]
    fn assignment_requires_parent_for_every_dependency_type() {
        for dependency_type in [
            DependencyType::Data,
            DependencyType::Ordering,
            DependencyType::Proof,
        ] {
            let mut task = build_test_task_fixture(TaskType::Exclusive, 10_000, 1, 0);
            task.depends_on = Some(Pubkey::new_unique());
            task.dependency_type = dependency_type;

            assert_anchor_error_code(
                validate_task_dependency_for_assignment(&task, &[], &crate::ID),
                CoordinationError::ParentTaskAccountRequired,
            );
        }
    }

    #[test]
    fn assignment_without_dependency_needs_no_parent_account() {
        let task = build_test_task_fixture(TaskType::Exclusive, 10_000, 1, 0);
        validate_task_dependency_for_assignment(&task, &[], &crate::ID).unwrap();
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

    mod marketplace_fee_leg_tests {
        use super::*;
        use anchor_lang::solana_program::system_program;

        #[test]
        fn task_snapshot_requires_and_binds_both_payees() {
            let task_key = Pubkey::new_unique();
            let operator = Pubkey::new_unique();
            let referrer = Pubkey::new_unique();
            let mut task = build_test_task_fixture(TaskType::Exclusive, 10_000, 1, 0);
            task.operator = operator;
            task.operator_fee_bps = 500;
            task.referrer = referrer;
            task.referrer_fee_bps = 250;

            let hire =
                build_unchecked_account(Pubkey::new_unique(), system_program::ID, 0, Vec::new());
            let operator_account =
                build_unchecked_account(operator, system_program::ID, 1, Vec::new());
            let referrer_account =
                build_unchecked_account(referrer, system_program::ID, 1, Vec::new());
            let hire_info = hire.to_account_info();
            let operator_info = operator_account.to_account_info();
            let referrer_info = referrer_account.to_account_info();

            let (operator_leg, referrer_leg) = build_marketplace_fee_legs(
                &task,
                task_key,
                &hire_info,
                Some(&operator_info),
                Some(&referrer_info),
            )
            .unwrap();

            let operator_leg = operator_leg.unwrap();
            let referrer_leg = referrer_leg.unwrap();
            assert_eq!(operator_leg.payee.key(), operator);
            assert_eq!(operator_leg.fee_bps, 500);
            assert_eq!(referrer_leg.payee.key(), referrer);
            assert_eq!(referrer_leg.fee_bps, 250);
        }

        #[test]
        fn legacy_hire_record_is_the_fallback_fee_source() {
            let task_key = Pubkey::new_unique();
            let operator = Pubkey::new_unique();
            let referrer = Pubkey::new_unique();
            let task = build_test_task_fixture(TaskType::Exclusive, 10_000, 1, 0);
            let hire_state = HireRecord {
                task: task_key,
                listing: Pubkey::new_unique(),
                operator,
                operator_fee_bps: 400,
                bump: 1,
                designated_provider: Pubkey::default(),
                referrer,
                referrer_fee_bps: 200,
            };
            let hire = build_unchecked_account(
                Pubkey::new_unique(),
                crate::ID,
                1,
                serialize_account(&hire_state),
            );
            let operator_account =
                build_unchecked_account(operator, system_program::ID, 1, Vec::new());
            let referrer_account =
                build_unchecked_account(referrer, system_program::ID, 1, Vec::new());
            let hire_info = hire.to_account_info();
            let operator_info = operator_account.to_account_info();
            let referrer_info = referrer_account.to_account_info();

            let (operator_leg, referrer_leg) = build_marketplace_fee_legs(
                &task,
                task_key,
                &hire_info,
                Some(&operator_info),
                Some(&referrer_info),
            )
            .unwrap();

            assert_eq!(operator_leg.unwrap().fee_bps, 400);
            assert_eq!(referrer_leg.unwrap().fee_bps, 200);
        }

        #[test]
        fn substituted_nonempty_absent_hire_account_fails_closed() {
            let task_key = Pubkey::new_unique();
            let task = build_test_task_fixture(TaskType::Exclusive, 10_000, 1, 0);
            let forged =
                build_unchecked_account(Pubkey::new_unique(), system_program::ID, 1, vec![1]);
            let forged_info = forged.to_account_info();

            assert_anchor_error_code(
                build_marketplace_fee_legs(&task, task_key, &forged_info, None, None),
                CoordinationError::InvalidHireRecord,
            );
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
        fn test_tiered_split_preserves_free_protocol_policy() {
            let task = build_test_task_fixture(TaskType::Exclusive, 10_000, 1, 0);
            let (worker, fee, effective_bps) =
                calculate_reward_split_tiered(&task, 0, 10_000).unwrap();
            assert_eq!(effective_bps, 0);
            assert_eq!(fee, 0);
            assert_eq!(worker, 10_000);
        }

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
