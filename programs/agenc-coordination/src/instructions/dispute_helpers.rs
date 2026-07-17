//! Shared helper functions for dispute resolution and expiration.
//!
//! These helpers process `remaining_accounts` for both `resolve_dispute` and
//! `expire_dispute` instructions, avoiding code duplication across the two
//! instruction handlers.

use std::collections::HashSet;

use crate::errors::CoordinationError;
use crate::events::{OperatorFeePaid, ReferrerFeePaid};
use crate::instructions::completion_helpers::calculate_combined_fees;
use crate::instructions::lamport_transfer::transfer_lamports;
use crate::instructions::task_validation_helpers::{
    decrement_pending_submission_count, is_manual_validation_task, note_submission_left_review,
};
use crate::instructions::validation::validate_account_owner;
use crate::state::{
    AgentRegistration, HireRecord, SubmissionStatus, Task, TaskClaim, TaskSubmission,
    TaskValidationConfig,
};
use anchor_lang::prelude::*;

/// The marketplace fee terms (operator + referrer snapshots) a dispute exit must
/// honor. Both legs ride together (P3.6 §3.3: dispute settlements honor the
/// snapshotted marketplace legs, waive the protocol fee).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MarketplaceTerms {
    pub operator: Pubkey,
    pub operator_fee_bps: u16,
    pub referrer: Pubkey,
    pub referrer_fee_bps: u16,
}

impl MarketplaceTerms {
    pub(crate) const NONE: MarketplaceTerms = MarketplaceTerms {
        operator: Pubkey::new_from_array([0u8; 32]),
        operator_fee_bps: 0,
        referrer: Pubkey::new_from_array([0u8; 32]),
        referrer_fee_bps: 0,
    };
}

/// Resolve the marketplace terms (operator + referrer payees and fee bps) for a task
/// settling via a dispute exit — Task-first with a HireRecord fallback, mirroring
/// `accept_task_result`. A Batch-2 hire (and every referred `create_task`) stamps the
/// terms onto the Task itself (trusted program-owned state); the 149 pre-Batch-2
/// tasks carry `task.operator == default`, so fall back to the live ["hire", task]
/// HireRecord — never drop this fallback or those operators go unpaid. Returns
/// `MarketplaceTerms::NONE` for a non-hired / non-operator / non-referred task.
pub(crate) fn resolve_task_marketplace_terms(
    task_operator: Pubkey,
    task_operator_fee_bps: u16,
    task_referrer: Pubkey,
    task_referrer_fee_bps: u16,
    hire_record: &AccountInfo,
    task_key: &Pubkey,
) -> Result<MarketplaceTerms> {
    if task_operator != Pubkey::default() || task_referrer != Pubkey::default() {
        return Ok(MarketplaceTerms {
            operator: task_operator,
            operator_fee_bps: task_operator_fee_bps,
            referrer: task_referrer,
            referrer_fee_bps: task_referrer_fee_bps,
        });
    }
    if hire_record.owner != &crate::ID {
        return Ok(MarketplaceTerms::NONE); // non-hired task: empty system-owned PDA
    }
    let hire = {
        let data = hire_record.try_borrow_data()?;
        HireRecord::try_deserialize(&mut &data[..])?
    };
    require!(hire.task == *task_key, CoordinationError::InvalidHireRecord);
    Ok(MarketplaceTerms {
        operator: hire.operator,
        operator_fee_bps: hire.operator_fee_bps,
        referrer: hire.referrer,
        referrer_fee_bps: hire.referrer_fee_bps,
    })
}

/// Pay the operator (embedding-site) AND referrer (demand-side embedder) legs out of
/// a dispute exit's worker payout, so a dispute cannot bypass the §4 3-/4-way split
/// (P3.6 §3.3: the operator retrofit precedent, now completed with the referrer leg —
/// previously a referred task disputed to Complete/Split silently over-paid the
/// worker the referrer's share).
///
/// Carves both fees from `worker_gross` (the lamports the worker is about to be
/// paid), transfers each to its snapshotted payee from the escrow, and returns the
/// combined fee so the caller pays the worker `worker_gross - total`. Disputes take
/// no protocol fee (ratified policy), so `calculate_combined_fees` runs with
/// `protocol_fee_bps = 0` — it still enforces both per-leg caps and the worker
/// floor against the gross, with the SAME math the settlement paths use. Absent
/// legs (default payee / zero bps) are no-ops, so an unreferred, non-hired dispute
/// is byte-identical to before. Both legs are SOL-only (the snapshots originate
/// from SOL hires/creates). Emits `OperatorFeePaid` / `ReferrerFeePaid` for each
/// non-zero leg so indexers see dispute-path fee legs like any other settlement.
pub(crate) fn pay_dispute_marketplace_legs<'info>(
    terms: &MarketplaceTerms,
    operator: Option<AccountInfo<'info>>,
    referrer: Option<AccountInfo<'info>>,
    escrow: &AccountInfo<'info>,
    worker_gross: u64,
    task_id: [u8; 32],
    now: i64,
) -> Result<u64> {
    let operator_active =
        terms.operator_fee_bps > 0 && terms.operator != Pubkey::default();
    let referrer_active =
        terms.referrer_fee_bps > 0 && terms.referrer != Pubkey::default();
    if !operator_active && !referrer_active {
        return Ok(0);
    }
    let operator_fee_bps = if operator_active { terms.operator_fee_bps } else { 0 };
    let referrer_fee_bps = if referrer_active { terms.referrer_fee_bps } else { 0 };
    // Disputes take no protocol fee, so protocol_fee_bps = 0; the combined-cap +
    // worker-floor invariants still bind against the gross.
    let (operator_fee, referrer_fee) =
        calculate_combined_fees(worker_gross, 0, operator_fee_bps, referrer_fee_bps)?;

    if operator_active {
        let op = operator.ok_or(CoordinationError::MissingOperatorAccount)?;
        require!(
            op.key() == terms.operator,
            CoordinationError::InvalidOperatorAccount
        );
        if operator_fee > 0 {
            transfer_lamports(escrow, &op, operator_fee)?;
            emit!(OperatorFeePaid {
                task_id,
                operator: terms.operator,
                amount: operator_fee,
                operator_fee_bps,
                timestamp: now,
            });
        }
    }
    if referrer_active {
        let rf = referrer.ok_or(CoordinationError::MissingReferrerAccount)?;
        require!(
            rf.key() == terms.referrer,
            CoordinationError::InvalidReferrerAccount
        );
        if referrer_fee > 0 {
            transfer_lamports(escrow, &rf, referrer_fee)?;
            emit!(ReferrerFeePaid {
                task_id,
                referrer: terms.referrer,
                amount: referrer_fee,
                referrer_fee_bps,
                timestamp: now,
            });
        }
    }
    operator_fee
        .checked_add(referrer_fee)
        .ok_or_else(|| error!(CoordinationError::ArithmeticOverflow))
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

/// Audit F-9: sweep the defendant's TaskSubmission on a dispute exit (resolve/expire).
/// Dispute exits otherwise left the submission account live on a terminal task — the
/// review counters stuck at 1 and the worker's submission rent recoverable only via
/// the creator-gated close_task. When the submission is supplied here (an optional
/// trailing account, so callers and the frozen IDL are unaffected):
/// - it is bound by owner + canonical seeds + task + claim + worker;
/// - the review counters are decremented IFF it is still `Submitted` (still carrying
///   counter debt — a bounced/accepted submission was already accounted at its own
///   transition); the task-level counter is schema-gated via
///   `note_submission_left_review`, and the validation-config counter is decremented
///   for manual tasks (the config account is then REQUIRED);
/// - the account is closed to the worker authority (never the crank or creator) and
///   tombstoned against re-init.
///
/// Anything else (live submission in another state) is left for close_task.
pub(crate) fn sweep_dispute_submission<'info>(
    task: &mut Task,
    task_key: &Pubkey,
    claim_key: &Pubkey,
    worker_agent_key: &Pubkey,
    worker_wallet: &AccountInfo<'info>,
    submission_info: &AccountInfo<'info>,
    validation_config: Option<&mut Account<'_, TaskValidationConfig>>,
) -> Result<()> {
    require!(
        submission_info.owner == &crate::ID,
        CoordinationError::InvalidAccountOwner
    );
    let submission = {
        let data = submission_info.try_borrow_data()?;
        TaskSubmission::try_deserialize(&mut &data[..])
            .map_err(|_| CoordinationError::TaskSubmissionRequired)?
    };
    let (expected_submission, _) = Pubkey::find_program_address(
        &[b"task_submission", claim_key.as_ref()],
        &crate::ID,
    );
    require!(
        submission_info.key() == expected_submission
            && submission.task == *task_key
            && submission.claim == *claim_key
            && submission.worker == *worker_agent_key,
        CoordinationError::TaskSubmissionRequired
    );

    if submission.status == SubmissionStatus::Submitted {
        note_submission_left_review(task)?;
        if is_manual_validation_task(task) {
            let config = validation_config.ok_or(CoordinationError::TaskValidationConfigRequired)?;
            require!(
                config.task == *task_key,
                CoordinationError::TaskValidationConfigRequired
            );
            decrement_pending_submission_count(config)?;
        }
    }

    // Return the worker-funded submission rent to the worker authority (constrained
    // by the caller == worker.authority) and tombstone against re-init.
    let lamports = submission_info.lamports();
    **submission_info.try_borrow_mut_lamports()? = 0;
    **worker_wallet.try_borrow_mut_lamports()? = worker_wallet
        .lamports()
        .checked_add(lamports)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let mut data = submission_info.try_borrow_mut_data()?;
    data.fill(0);
    data[..8].copy_from_slice(&[255u8; 8]);

    Ok(())
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

    // === Batch-2 A3: marketplace-terms resolution for dispute exits ===

    #[test]
    fn marketplace_terms_none_is_all_defaults() {
        assert_eq!(MarketplaceTerms::NONE.operator, Pubkey::default());
        assert_eq!(MarketplaceTerms::NONE.operator_fee_bps, 0);
        assert_eq!(MarketplaceTerms::NONE.referrer, Pubkey::default());
        assert_eq!(MarketplaceTerms::NONE.referrer_fee_bps, 0);
    }

    fn system_owned_empty_account() -> (Pubkey, Pubkey) {
        (Pubkey::new_unique(), anchor_lang::system_program::ID)
    }

    // Task-first: a referred-but-not-hired task (create_task with a referrer)
    // must resolve its referrer terms from the Task even though the hire PDA is
    // the empty system-owned account. Revert-sensitive: against the operator-only
    // helper this returned (default, 0) for the referrer and the dispute leaked
    // the referrer's share to the worker.
    #[test]
    fn resolves_referred_task_terms_from_the_task() {
        let (key, owner) = system_owned_empty_account();
        let mut lamports = 0u64;
        let mut data: [u8; 0] = [];
        let hire_info = AccountInfo::new(
            &key, false, false, &mut lamports, &mut data, &owner, false, 0,
        );
        let referrer = Pubkey::new_unique();
        let task_key = Pubkey::new_unique();
        let terms = resolve_task_marketplace_terms(
            Pubkey::default(),
            0,
            referrer,
            500,
            &hire_info,
            &task_key,
        )
        .unwrap();
        assert_eq!(terms.referrer, referrer);
        assert_eq!(terms.referrer_fee_bps, 500);
        assert_eq!(terms.operator, Pubkey::default());
        assert_eq!(terms.operator_fee_bps, 0);
    }

    #[test]
    fn resolves_non_hired_non_referred_task_to_none() {
        let (key, owner) = system_owned_empty_account();
        let mut lamports = 0u64;
        let mut data: [u8; 0] = [];
        let hire_info = AccountInfo::new(
            &key, false, false, &mut lamports, &mut data, &owner, false, 0,
        );
        let terms = resolve_task_marketplace_terms(
            Pubkey::default(),
            0,
            Pubkey::default(),
            0,
            &hire_info,
            &Pubkey::new_unique(),
        )
        .unwrap();
        assert_eq!(terms, MarketplaceTerms::NONE);
    }
}
