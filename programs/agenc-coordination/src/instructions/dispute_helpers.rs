//! Shared helper functions for dispute resolution and expiration.
//!
//! These helpers process `remaining_accounts` for both `resolve_dispute` and
//! `expire_dispute` instructions, avoiding code duplication across the two
//! instruction handlers.

use std::collections::HashSet;

use crate::errors::CoordinationError;
use crate::instructions::completion_helpers::calculate_operator_fee;
use crate::instructions::lamport_transfer::transfer_lamports;
use crate::instructions::validation::validate_account_owner;
use crate::state::{AgentRegistration, HireRecord, TaskClaim};
use anchor_lang::prelude::*;

/// Pay the operator (embedding-site) leg out of a HIRED task's dispute payout so a
/// dispute cannot bypass the §4 3-way split (audit: operators were unpaid when a hired
/// task settled via resolve_dispute/expire_dispute instead of complete_task).
///
/// `hire_record` is the REQUIRED ["hire", task] account: a live, program-owned
/// HireRecord means the task was hired. When hired with a non-zero operator fee, this
/// carves `operator_fee` from `worker_gross` (the lamports the worker is about to be
/// paid), transfers it to the operator from the escrow, and returns the fee so the
/// caller pays the worker `worker_gross - fee`. Returns 0 for a non-hired task (empty,
/// system-owned PDA) or a zero-fee hire. Hired tasks are SOL-only, so this is a
/// lamport-only path. Defense-in-depth: validates the HireRecord is bound to this task
/// and that the operator account matches the snapshot.
/// Resolve the operator terms (payee + fee bps) for a task settling via a dispute,
/// Task-first with a HireRecord fallback. A Batch-2 hire stamps the operator onto the
/// Task itself (trusted program-owned state); the 149 pre-Batch-2 tasks carry
/// `task.operator == default`, so fall back to the live ["hire", task] HireRecord —
/// never drop this fallback or those operators go unpaid. Returns (default, 0) for a
/// non-hired / non-operator task.
pub(crate) fn resolve_task_operator_terms(
    task_operator: Pubkey,
    task_operator_fee_bps: u16,
    hire_record: &AccountInfo,
    task_key: &Pubkey,
) -> Result<(Pubkey, u16)> {
    if task_operator != Pubkey::default() {
        return Ok((task_operator, task_operator_fee_bps));
    }
    if hire_record.owner != &crate::ID {
        return Ok((Pubkey::default(), 0)); // non-hired task: empty system-owned PDA
    }
    let hire = {
        let data = hire_record.try_borrow_data()?;
        HireRecord::try_deserialize(&mut &data[..])?
    };
    require!(hire.task == *task_key, CoordinationError::InvalidHireRecord);
    Ok((hire.operator, hire.operator_fee_bps))
}

pub(crate) fn pay_dispute_operator_fee<'info>(
    operator_pubkey: Pubkey,
    operator_fee_bps: u16,
    operator: Option<AccountInfo<'info>>,
    escrow: &AccountInfo<'info>,
    worker_gross: u64,
) -> Result<u64> {
    if operator_fee_bps == 0 || operator_pubkey == Pubkey::default() {
        return Ok(0);
    }
    let op = operator.ok_or(CoordinationError::MissingOperatorAccount)?;
    require!(
        op.key() == operator_pubkey,
        CoordinationError::InvalidOperatorAccount
    );
    // Disputes take no protocol fee, so pass protocol_fee_bps = 0; calculate_operator_fee
    // still enforces the operator cap and the worker floor against the gross.
    let fee = calculate_operator_fee(worker_gross, 0, operator_fee_bps)?;
    if fee > 0 {
        transfer_lamports(escrow, &op, fee)?;
    }
    Ok(fee)
}

/// Validates the structure of `remaining_accounts` for dispute processing.
///
/// P6.3: the arbiter vote/quorum model is retired, so a dispute NEVER records a voter
/// (`total_voters` is always 0). `remaining_accounts` therefore carry ONLY additional
/// collaborative (claim, worker) pairs, which must come in twos. There is no longer an
/// arbiter prefix; the function returns the (always-zero) arbiter-account count purely
/// so the call sites keep a stable shape.
pub(crate) fn validate_remaining_accounts_structure(
    remaining_accounts: &[AccountInfo],
    total_voters: u8,
) -> Result<usize> {
    // Defense-in-depth: a post-retirement dispute can never carry voters. If a caller
    // somehow passes a non-zero count, reject rather than silently treating leading
    // worker pairs as arbiter pairs.
    require!(total_voters == 0, CoordinationError::InvalidInput);

    // All remaining accounts must come in (claim, worker) pairs.
    require!(
        remaining_accounts.len() % 2 == 0,
        CoordinationError::InvalidInput
    );

    Ok(0)
}

/// Checks for duplicate workers in remaining_accounts (fix #826).
///
/// Iterates over (claim, worker) pairs and ensures no worker appears twice.
/// This prevents `active_tasks` over-decrement via repeated `saturating_sub(1)`.
///
/// P6.3: `arbiter_accounts` is always 0 now (no arbiter prefix), so iteration starts at
/// index 0; the parameter is kept for a stable call-site shape.
pub(crate) fn check_duplicate_workers(
    remaining_accounts: &[AccountInfo],
    arbiter_accounts: usize,
    primary_worker: Option<Pubkey>,
) -> Result<()> {
    let mut seen_workers: HashSet<Pubkey> = HashSet::new();
    if let Some(worker_key) = primary_worker {
        seen_workers.insert(worker_key);
    }
    for i in (arbiter_accounts..remaining_accounts.len()).step_by(2) {
        let worker_index = i
            .checked_add(1)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        let worker_key = remaining_accounts[worker_index].key();
        require!(
            seen_workers.insert(worker_key),
            CoordinationError::InvalidInput
        );
    }
    Ok(())
}

/// Processes a single (claim, worker) pair from remaining_accounts.
///
/// Validates ownership, PDA derivation, deserializes the claim, verifies it belongs
/// to the task and matches the worker, then decrements the worker's active_tasks counter.
/// Used for collaborative tasks where multiple workers claimed the task.
pub(crate) fn process_worker_claim_pair(
    claim_info: &AccountInfo,
    worker_info: &AccountInfo,
    task_key: &Pubkey,
    program_id: &Pubkey,
) -> Result<()> {
    validate_account_owner(claim_info)?;
    validate_account_owner(worker_info)?;
    require!(claim_info.is_writable, CoordinationError::InvalidInput);

    // Validate claim PDA derivation to prevent crafted program-owned accounts
    let (expected_claim_pda, _) = Pubkey::find_program_address(
        &[b"claim", task_key.as_ref(), worker_info.key().as_ref()],
        program_id,
    );
    require!(
        claim_info.key() == expected_claim_pda,
        CoordinationError::InvalidInput
    );

    let claim_data = claim_info.try_borrow_data()?;
    let claim = TaskClaim::try_deserialize(&mut &**claim_data)?;
    require!(claim.task == *task_key, CoordinationError::InvalidInput);
    require!(
        claim.worker == worker_info.key(),
        CoordinationError::InvalidInput
    );
    drop(claim_data);

    require!(worker_info.is_writable, CoordinationError::InvalidInput);
    let mut worker_data = worker_info.try_borrow_mut_data()?;
    let mut worker_reg = AgentRegistration::try_deserialize(&mut &**worker_data)?;
    // Using saturating_sub intentionally - underflow returns 0 (safe counter decrement)
    worker_reg.active_tasks = worker_reg.active_tasks.saturating_sub(1);
    // Use AnchorSerialize::serialize (Borsh only) instead of AccountSerialize::try_serialize,
    // which would double-write the discriminator and corrupt the account data (fix #960).
    AnchorSerialize::serialize(&worker_reg, &mut &mut worker_data[8..])
        .map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotSerialize)?;
    drop(worker_data);

    // Close the processed claim account. Rent is credited to the worker PDA so
    // funds remain recoverable via normal agent lifecycle and no stale claims
    // block cleanup flows after dispute resolution/expiration.
    let claim_lamports = claim_info.lamports();
    **claim_info.try_borrow_mut_lamports()? = 0;
    **worker_info.try_borrow_mut_lamports()? = worker_info
        .lamports()
        .checked_add(claim_lamports)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Mark as closed to block `init_if_needed` reinitialization on the same PDA.
    let mut claim_data_mut = claim_info.try_borrow_mut_data()?;
    claim_data_mut.fill(0);
    claim_data_mut[..8].copy_from_slice(&[255u8; 8]);

    Ok(())
}

/// Number of EXTRA collaborative `(claim, worker)` pairs a dispute exit must process in
/// `remaining_accounts`, beyond the single primary defendant: `current_workers - 1`,
/// floored at 0. Uses `saturating_sub` (not `checked_sub`) so a `current_workers == 0`
/// dispute yields 0 expected pairs instead of an arithmetic underflow that would lock the
/// disputed escrow (#72 defense-in-depth). The underflow's trigger is closed by the
/// `expire_claim` escrow-lock fix, but the arithmetic must not error if it ever recurs.
pub(crate) fn expected_worker_pairs(current_workers: u8) -> usize {
    usize::from(current_workers.saturating_sub(1))
}

/// The dispute defendant's claim binding in `validate_worker_accounts` is ALWAYS required,
/// for every `current_workers` value INCLUDING 0. Adversarial review (#72) established that
/// gating the binding on `current_workers == 0` unlocks NO reachable escrow (the
/// closed-claim / zero-worker dispute state is unreachable after the escrow-lock fix) while
/// adding fund-routing branches — a net risk for zero benefit. This predicate is a TRIPWIRE:
/// it must stay unconditionally `true` (pinned by a unit test), so any future attempt to
/// relax the defendant binding by worker count fails a test instead of silently shipping.
pub(crate) fn defendant_claim_required(_current_workers: u8) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expected_worker_pairs_saturates_at_zero() {
        // Load-bearing: input 0 must yield 0, not underflow. A `checked_sub` would Err here.
        assert_eq!(expected_worker_pairs(0), 0);
        assert_eq!(expected_worker_pairs(1), 0);
        assert_eq!(expected_worker_pairs(2), 1);
        assert_eq!(expected_worker_pairs(5), 4);
        assert_eq!(expected_worker_pairs(u8::MAX), 254);
    }

    #[test]
    fn expected_worker_pairs_diverges_from_checked_sub_only_at_zero() {
        // saturating and checked agree for every c >= 1; they diverge ONLY at 0
        // (saturating == 0 vs checked == Err). Reverting to checked_sub turns the
        // input-0 assertion above red.
        for c in 1u8..=u8::MAX {
            assert_eq!(
                expected_worker_pairs(c),
                usize::from(c.checked_sub(1).unwrap())
            );
        }
        assert!(0u8.checked_sub(1).is_none());
        assert_eq!(expected_worker_pairs(0), 0);
    }

    #[test]
    fn defendant_claim_binding_is_never_gated_on_worker_count() {
        // #72 tripwire: the defendant claim must be required for EVERY worker count,
        // including 0. A future change relaxing the binding to skip `current_workers == 0`
        // would make this predicate `!= 0`, flipping defendant_claim_required(0) to false.
        assert!(defendant_claim_required(0));
        assert!(defendant_claim_required(1));
        assert!(defendant_claim_required(u8::MAX));
    }
}
