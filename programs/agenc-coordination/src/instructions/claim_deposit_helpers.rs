//! Revision 9 (E): claim deposit math.
//!
//! Every non-contest claim made through `claim_task_with_job_spec` puts down
//! `max(10% of the worker's share, 0.005 SOL)` as surplus lamports on the claim
//! account (the same pattern as the contest entry deposit). It comes back on the
//! worker's first delivery and goes to the buyer when the claim ends without a
//! delivery after its expiry. A forfeit takes exactly the posted deposit (review
//! R1-2 / R2-3); anything else above the rent minimum is the worker's.

#![cfg(not(feature = "mainnet-canary"))]

use crate::errors::CoordinationError;
use crate::events::ClaimDepositSettled;
use crate::instructions::constants::{
    BASIS_POINTS_DIVISOR, CLAIM_DEPOSIT_BPS, CLAIM_RELEASE_GRACE_SECS, MIN_CLAIM_DEPOSIT_LAMPORTS,
};
use crate::instructions::lamport_transfer::transfer_lamports;
use crate::state::{Task, TaskType};
use anchor_lang::prelude::*;

/// The worker's share of the reward, in lamports: the whole reward for a
/// single-worker task, `reward_amount / required_completions` for a
/// Collaborative task. A token-reward task has no SOL-denominated share (its
/// reward is in token base units), so it reads as 0 and the SOL floors apply.
/// Integer division rounds down.
pub fn sol_worker_share_lamports(task: &Task) -> Result<u64> {
    if task.reward_mint.is_some() {
        return Ok(0);
    }
    if task.task_type == TaskType::Collaborative {
        let parts = u64::from(task.required_completions.max(1));
        return task
            .reward_amount
            .checked_div(parts)
            .ok_or_else(|| error!(CoordinationError::ArithmeticOverflow));
    }
    Ok(task.reward_amount)
}

/// `max(rate_bps / 10,000 of amount, floor)` with checked, widened math.
pub fn bps_with_floor(amount: u64, rate_bps: u64, floor: u64) -> Result<u64> {
    let scaled = u128::from(amount)
        .checked_mul(u128::from(rate_bps))
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(u128::from(BASIS_POINTS_DIVISOR))
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let scaled = u64::try_from(scaled).map_err(|_| CoordinationError::ArithmeticOverflow)?;
    Ok(scaled.max(floor))
}

/// Claim deposit for a worker share: `max(share x 1,000 / 10,000, 5,000,000)`.
pub fn claim_deposit_lamports(share: u64) -> Result<u64> {
    bps_with_floor(share, CLAIM_DEPOSIT_BPS, MIN_CLAIM_DEPOSIT_LAMPORTS)
}

/// `release_claim` refunds the deposit when the claim is released within the
/// grace (inclusive at exactly `claimed_at + CLAIM_RELEASE_GRACE_SECS`); after
/// that the deposit goes to the buyer.
pub fn release_refunds_deposit(claimed_at: i64, now: i64) -> bool {
    now <= claimed_at.saturating_add(CLAIM_RELEASE_GRACE_SECS)
}

/// Lamports on a claim above its rent-exempt minimum. For a revision 9 claim
/// this is its deposit; a claim funded at an older, higher rent rate also holds
/// its own excess rent here, which is not a deposit (review R1-2 / R2-3).
pub fn claim_surplus_lamports(claim_info: &AccountInfo) -> Result<u64> {
    let rent_min = Rent::get()?.minimum_balance(claim_info.data_len());
    Ok(claim_info.lamports().saturating_sub(rent_min))
}

/// The deposit a non-contest claim on `task` posted. The claim stores no copy,
/// but every input is fixed once the task exists (the reward, the task type
/// and the completion count), so it is recomputed from the task.
pub fn posted_claim_deposit_lamports(task: &Task) -> Result<u64> {
    claim_deposit_lamports(sol_worker_share_lamports(task)?)
}

/// Review R1-2 / R2-3: a forfeit takes exactly the posted deposit `due`, and only
/// when the claim's surplus reaches it. A smaller surplus is old-rate rent (or
/// rent left over after a rate cut), which is the worker's own and closes to it
/// with the rent.
pub fn forfeitable_deposit(surplus: u64, due: u64) -> u64 {
    if surplus >= due {
        due
    } else {
        0
    }
}

/// Move exactly the forfeitable part of a claim's surplus to `recipient` and
/// return it. Direct lamport move: callers make every CPI first.
pub fn take_forfeitable_deposit<'info>(
    claim_info: &AccountInfo<'info>,
    recipient: &AccountInfo<'info>,
    due: u64,
) -> Result<u64> {
    let amount = forfeitable_deposit(claim_surplus_lamports(claim_info)?, due);
    if amount > 0 {
        transfer_lamports(claim_info, recipient, amount)?;
    }
    Ok(amount)
}

/// Forfeit a non-contest claim's deposit to the buyer (`recipient`): exactly the
/// posted deposit when the surplus reaches it, else nothing. Emits
/// `ClaimDepositSettled` (forfeited) when it moves. Returns the amount moved.
pub fn forfeit_claim_deposit<'info>(
    claim_info: &AccountInfo<'info>,
    recipient: &AccountInfo<'info>,
    task: &Task,
    task_key: Pubkey,
    worker_agent: Pubkey,
    now: i64,
) -> Result<u64> {
    let amount =
        take_forfeitable_deposit(claim_info, recipient, posted_claim_deposit_lamports(task)?)?;
    if amount > 0 {
        emit!(ClaimDepositSettled {
            task: task_key,
            claim: claim_info.key(),
            worker_agent,
            recipient: recipient.key(),
            amount,
            forfeited: true,
            timestamp: now,
        });
    }
    Ok(amount)
}

/// Return a non-contest claim's surplus to the worker wallet: the whole
/// surplus moves, and `ClaimDepositSettled` (not forfeited) is emitted only when
/// it holds the posted deposit (old-rate rent alone is no deposit). Returns the
/// amount moved. Direct lamport move: callers make every CPI first.
pub fn refund_claim_deposit<'info>(
    claim_info: &AccountInfo<'info>,
    worker_wallet: &AccountInfo<'info>,
    task: &Task,
    task_key: Pubkey,
    worker_agent: Pubkey,
    now: i64,
) -> Result<u64> {
    let amount = claim_surplus_lamports(claim_info)?;
    if amount == 0 {
        return Ok(0);
    }
    transfer_lamports(claim_info, worker_wallet, amount)?;
    if amount >= posted_claim_deposit_lamports(task)? {
        emit!(ClaimDepositSettled {
            task: task_key,
            claim: claim_info.key(),
            worker_agent,
            recipient: worker_wallet.key(),
            amount,
            forfeited: false,
            timestamp: now,
        });
    }
    Ok(amount)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(task_type: TaskType, reward: u64, required: u8) -> Task {
        Task {
            task_type,
            reward_amount: reward,
            required_completions: required,
            ..Task::default()
        }
    }

    // Review R1-2 / R2-3. Revert-sensitive: forfeiting the whole surplus turns
    // the old-rate and over-deposit cases red.
    #[test]
    fn a_forfeit_takes_exactly_the_posted_deposit_and_only_when_present() {
        let due = 20_000_000;
        // The live old-rate excess: (128 + 203) x (6,960 - 5,080).
        assert_eq!(forfeitable_deposit(622_280, due), 0);
        assert_eq!(forfeitable_deposit(due - 1, due), 0);
        assert_eq!(forfeitable_deposit(due, due), due);
        // A deposit plus old-rate rent: only the deposit.
        assert_eq!(forfeitable_deposit(due + 622_280, due), due);
        assert_eq!(forfeitable_deposit(0, due), 0);
    }

    #[test]
    fn deposit_is_ten_percent_with_a_half_centisol_floor() {
        // P = 0.1 SOL -> 0.01 SOL.
        assert_eq!(claim_deposit_lamports(100_000_000).unwrap(), 10_000_000);
        // At and below 0.05 SOL the floor wins.
        assert_eq!(claim_deposit_lamports(50_000_000).unwrap(), 5_000_000);
        assert_eq!(claim_deposit_lamports(5_000_000).unwrap(), 5_000_000);
        assert_eq!(claim_deposit_lamports(0).unwrap(), 5_000_000);
        // Just above the crossover the rate wins.
        assert_eq!(claim_deposit_lamports(50_000_010).unwrap(), 5_000_001);
        // No overflow at the top of the range.
        assert_eq!(claim_deposit_lamports(u64::MAX).unwrap(), u64::MAX / 10);
    }

    #[test]
    fn share_is_the_reward_or_the_collaborative_part() {
        assert_eq!(
            sol_worker_share_lamports(&task(TaskType::Exclusive, 100, 1)).unwrap(),
            100
        );
        assert_eq!(
            sol_worker_share_lamports(&task(TaskType::Competitive, 100, 1)).unwrap(),
            100
        );
        // Collaborative: integer share of the reward.
        assert_eq!(
            sol_worker_share_lamports(&task(TaskType::Collaborative, 100_000_000, 3)).unwrap(),
            33_333_333
        );
        // A zero required_completions never divides by zero.
        assert_eq!(
            sol_worker_share_lamports(&task(TaskType::Collaborative, 90, 0)).unwrap(),
            90
        );
        // Token rewards have no SOL share: the floor applies.
        let mut token = task(TaskType::Exclusive, 1_000_000_000, 1);
        token.reward_mint = Some(Pubkey::new_unique());
        assert_eq!(sol_worker_share_lamports(&token).unwrap(), 0);
        assert_eq!(
            claim_deposit_lamports(sol_worker_share_lamports(&token).unwrap()).unwrap(),
            MIN_CLAIM_DEPOSIT_LAMPORTS
        );
    }

    #[test]
    fn release_grace_edges() {
        let claimed_at = 1_000;
        let g = CLAIM_RELEASE_GRACE_SECS;
        assert!(release_refunds_deposit(claimed_at, claimed_at));
        assert!(release_refunds_deposit(claimed_at, claimed_at + g - 1));
        assert!(release_refunds_deposit(claimed_at, claimed_at + g));
        assert!(!release_refunds_deposit(claimed_at, claimed_at + g + 1));
        #[cfg(not(feature = "validation-timings"))]
        assert_eq!(g, 3_600);
        #[cfg(feature = "validation-timings")]
        assert_eq!(g, 60);
    }
}
