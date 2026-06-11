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
