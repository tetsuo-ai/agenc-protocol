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
    decrement_pending_submission_count, ensure_validation_config, is_manual_validation_task,
    note_submission_left_review,
};
use crate::instructions::validation::validate_account_owner;
use crate::state::{
    AgentRegistration, Dispute, HireRecord, SubmissionStatus, Task, TaskClaim, TaskSubmission,
    TaskValidationConfig,
};
use anchor_lang::prelude::*;

/// Fixed wire stride for each additional collaborative worker:
/// `(claim, worker registration, task submission evidence)`.
///
/// The submission meta is mandatory. Its exact system-owned empty PDA proves
/// absence; a live program-owned submission is swept before its claim closes.
pub(crate) const DISPUTE_PEER_BUNDLE_STRIDE: usize = 3;

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
    let operator_active = terms.operator_fee_bps > 0 && terms.operator != Pubkey::default();
    let referrer_active = terms.referrer_fee_bps > 0 && terms.referrer != Pubkey::default();
    if !operator_active && !referrer_active {
        return Ok(0);
    }
    let operator_fee_bps = if operator_active {
        terms.operator_fee_bps
    } else {
        0
    };
    let referrer_fee_bps = if referrer_active {
        terms.referrer_fee_bps
    } else {
        0
    };
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

/// Validate the retired-voter/provenance invariant and exact peer-bundle
/// cardinality before any cleanup mutation. The accepted account count for 1–4
/// total workers is therefore exactly 0, 3, 6, or 9.
fn validate_dispute_peer_bundle_cardinality(
    current_workers: u8,
    total_voters: u8,
    account_count: usize,
) -> Result<usize> {
    require!(
        total_voters == 0 || total_voters == Dispute::INITIATOR_OUTCOME_COUNTER_MARKER,
        CoordinationError::CorruptedData
    );
    require!(
        account_count % DISPUTE_PEER_BUNDLE_STRIDE == 0,
        CoordinationError::InvalidInput
    );
    let actual = account_count
        .checked_div(DISPUTE_PEER_BUNDLE_STRIDE)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    require!(
        actual == expected_peer_bundles(current_workers),
        CoordinationError::IncompleteWorkerAccounts
    );
    Ok(actual)
}

/// Checks for duplicate workers in collaborative peer bundles (fix #826).
///
/// Iterates over `(claim, worker, task_submission)` bundles and ensures no worker
/// appears twice.
/// This prevents `active_tasks` over-decrement via repeated `saturating_sub(1)`.
fn check_duplicate_peer_workers(
    remaining_accounts: &[AccountInfo],
    primary_worker: Pubkey,
) -> Result<()> {
    let mut seen_workers: HashSet<Pubkey> = HashSet::new();
    seen_workers.insert(primary_worker);
    for i in (0..remaining_accounts.len()).step_by(DISPUTE_PEER_BUNDLE_STRIDE) {
        let worker_index = i
            .checked_add(1)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        let worker_key = remaining_accounts
            .get(worker_index)
            .ok_or(CoordinationError::IncompleteWorkerAccounts)?
            .key();
        require!(
            seen_workers.insert(worker_key),
            CoordinationError::InvalidInput
        );
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct ValidatedPeerBundle {
    submission_live: bool,
    submission_submitted: bool,
}

/// Read-only validation for one `(claim, worker, task_submission)` bundle.
/// Every bundle in the instruction is validated before the first mutation, so a
/// malformed later peer cannot leave an earlier peer partially cleaned in helper
/// tests or future non-transactional reuse.
fn validate_worker_claim_bundle<'info>(
    claim_info: &AccountInfo<'info>,
    worker_info: &AccountInfo<'info>,
    submission_info: &AccountInfo<'info>,
    task_key: &Pubkey,
    program_id: &Pubkey,
) -> Result<ValidatedPeerBundle> {
    validate_account_owner(claim_info)?;
    validate_account_owner(worker_info)?;
    require!(claim_info.is_writable, CoordinationError::InvalidInput);
    require!(worker_info.is_writable, CoordinationError::InvalidInput);

    // Validate claim PDA derivation to prevent crafted program-owned accounts
    let (expected_claim_pda, expected_claim_bump) = Pubkey::find_program_address(
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
        claim.worker == worker_info.key() && claim.bump == expected_claim_bump,
        CoordinationError::InvalidInput
    );
    drop(claim_data);

    // Bind the worker registration itself, not only the claim's stored worker key.
    // A program-owned account with the right discriminator must still be the
    // canonical `["agent", agent_id]` PDA with its canonical bump.
    {
        let worker_data = worker_info.try_borrow_data()?;
        let worker_reg = AgentRegistration::try_deserialize(&mut &worker_data[..])?;
        let (expected_worker_pda, expected_worker_bump) =
            Pubkey::find_program_address(&[b"agent", worker_reg.agent_id.as_ref()], program_id);
        require!(
            worker_info.key() == expected_worker_pda && worker_reg.bump == expected_worker_bump,
            CoordinationError::InvalidInput
        );
    }

    let (expected_submission_pda, expected_submission_bump) =
        Pubkey::find_program_address(&[b"task_submission", claim_info.key().as_ref()], program_id);
    require!(
        submission_info.key() == expected_submission_pda,
        CoordinationError::TaskSubmissionRequired
    );
    if submission_info.owner == &anchor_lang::system_program::ID && submission_info.data_is_empty()
    {
        return Ok(ValidatedPeerBundle {
            submission_live: false,
            submission_submitted: false,
        });
    }
    require!(
        submission_info.owner == program_id,
        CoordinationError::InvalidAccountOwner
    );
    require!(
        submission_info.is_writable,
        CoordinationError::TaskSubmissionRequired
    );
    let submission = {
        let submission_data = submission_info.try_borrow_data()?;
        TaskSubmission::try_deserialize(&mut &submission_data[..])
            .map_err(|_| CoordinationError::TaskSubmissionRequired)?
    };
    require!(
        submission.task == *task_key
            && submission.claim == claim_info.key()
            && submission.worker == worker_info.key()
            && submission.bump == expected_submission_bump,
        CoordinationError::TaskSubmissionRequired
    );

    Ok(ValidatedPeerBundle {
        submission_live: true,
        submission_submitted: submission.status == SubmissionStatus::Submitted,
    })
}

/// Mutate one bundle only after the whole peer vector has passed read-only
/// validation and aggregate counter-conservation checks.
fn settle_validated_worker_claim_bundle<'info>(
    task: &mut Task,
    claim_info: &AccountInfo<'info>,
    worker_info: &AccountInfo<'info>,
    submission_info: &AccountInfo<'info>,
    task_key: &Pubkey,
    validated: ValidatedPeerBundle,
    validation_config: Option<&mut Account<'info, TaskValidationConfig>>,
) -> Result<()> {
    // Submission cleanup MUST precede claim close. Once the claim is destroyed,
    // no later terminal path can safely recover its derived submission or debt.
    if validated.submission_live {
        sweep_dispute_submission(
            task,
            task_key,
            &claim_info.key(),
            &worker_info.key(),
            worker_info,
            submission_info,
            validation_config,
        )?;
    }

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

/// Validate and settle every additional collaborative worker in one shared
/// implementation used by both dispute resolution and expiry.
///
/// Validation is deliberately front-loaded for the whole account vector: the
/// retired voter count, exact bundle stride, expected 1–4 worker cardinality,
/// and duplicate-worker set are checked before any claim or submission mutation.
/// Each bundle then enforces canonical claim/submission PDAs and preserves both
/// task-level and validation-config submission counters.
pub(crate) fn process_dispute_peer_bundles<'info>(
    task: &mut Task,
    task_key: &Pubkey,
    peer_accounts: &[AccountInfo<'info>],
    total_voters: u8,
    primary_worker: Pubkey,
    mut validation_config: Option<&mut Account<'info, TaskValidationConfig>>,
    program_id: &Pubkey,
) -> Result<()> {
    validate_dispute_peer_bundle_cardinality(
        task.current_workers,
        total_voters,
        peer_accounts.len(),
    )?;
    check_duplicate_peer_workers(peer_accounts, primary_worker)?;

    let mut validated_bundles =
        Vec::with_capacity(peer_accounts.len() / DISPUTE_PEER_BUNDLE_STRIDE);
    let mut submitted_peer_count: u8 = 0;
    for bundle in peer_accounts.chunks_exact(DISPUTE_PEER_BUNDLE_STRIDE) {
        let validated =
            validate_worker_claim_bundle(&bundle[0], &bundle[1], &bundle[2], task_key, program_id)?;
        if validated.submission_submitted {
            submitted_peer_count = submitted_peer_count
                .checked_add(1)
                .ok_or(CoordinationError::ArithmeticOverflow)?;
        }
        validated_bundles.push(validated);
    }

    // Aggregate preflight: every Submitted peer carries one unit of Task counter
    // debt and, for manual validation, one unit of config counter debt. Check the
    // full batch before sweeping the first account.
    if submitted_peer_count > 0 {
        if task.task_schema() >= Task::TASK_SCHEMA_CONTEST_AWARE {
            require!(
                task.live_submissions() >= submitted_peer_count,
                CoordinationError::ArithmeticOverflow
            );
        }
        if is_manual_validation_task(task) {
            let config = validation_config
                .as_ref()
                .ok_or(CoordinationError::TaskValidationConfigRequired)?;
            let (expected_config, expected_config_bump) =
                Pubkey::find_program_address(&[b"task_validation", task_key.as_ref()], program_id);
            require!(
                config.key() == expected_config && config.bump == expected_config_bump,
                CoordinationError::TaskValidationConfigRequired
            );
            ensure_validation_config(config, task_key, task)?;
            require!(
                config.pending_submission_count() >= u16::from(submitted_peer_count),
                CoordinationError::ArithmeticOverflow
            );
        }
    }

    for (bundle, validated) in peer_accounts
        .chunks_exact(DISPUTE_PEER_BUNDLE_STRIDE)
        .zip(validated_bundles)
    {
        let peer_validation_config = validation_config.as_deref_mut();
        settle_validated_worker_claim_bundle(
            task,
            &bundle[0],
            &bundle[1],
            &bundle[2],
            task_key,
            validated,
            peer_validation_config,
        )?;
    }

    Ok(())
}

/// Number of EXTRA collaborative peer bundles a dispute exit must process in
/// `remaining_accounts`, beyond the single primary defendant: `current_workers - 1`,
/// floored at 0. Uses `saturating_sub` (not `checked_sub`) so a `current_workers == 0`
/// dispute yields 0 expected pairs instead of an arithmetic underflow that would lock the
/// disputed escrow (#72 defense-in-depth). The underflow's trigger is closed by the
/// `expire_claim` escrow-lock fix, but the arithmetic must not error if it ever recurs.
pub(crate) fn expected_peer_bundles(current_workers: u8) -> usize {
    usize::from(current_workers.saturating_sub(1))
}

/// Bind the primary dispute defendant, claim, task, and payout wallet.
///
/// Both resolution and expiry require this exact bundle regardless of the task's
/// potentially drifted `current_workers` telemetry. Keeping one validator prevents
/// the two money-moving exits from developing subtly different account rules.
pub(crate) fn validate_dispute_worker_accounts(
    dispute: &Dispute,
    worker: &Option<Box<Account<AgentRegistration>>>,
    worker_claim: &Option<Box<Account<TaskClaim>>>,
    worker_wallet: &Option<UncheckedAccount>,
    task_key: &Pubkey,
) -> Result<()> {
    let worker = worker
        .as_ref()
        .ok_or(CoordinationError::WorkerAgentRequired)?;
    let worker_claim = worker_claim
        .as_ref()
        .ok_or(CoordinationError::WorkerClaimRequired)?;
    let worker_wallet = worker_wallet
        .as_ref()
        .ok_or(CoordinationError::IncompleteWorkerAccounts)?;

    require!(
        worker.key() == dispute.defendant,
        CoordinationError::WorkerNotInDispute
    );
    require!(
        worker.key() == worker_claim.worker,
        CoordinationError::UnauthorizedAgent
    );
    require!(
        worker_claim.task == *task_key,
        CoordinationError::NotClaimed
    );
    require!(
        worker_wallet.key() == worker.authority,
        CoordinationError::UnauthorizedAgent
    );

    Ok(())
}

/// Audit F-9: sweep the defendant's live TaskSubmission on a dispute exit.
///
/// This is the live-account half of [`settle_dispute_submission_evidence`]. That
/// wrapper makes the account non-skippable and distinguishes a canonical empty
/// PDA from a live program-owned submission before entering here.
///
/// - it is bound by owner + canonical seeds + task + claim + worker;
/// - the review counters are decremented IFF it is still `Submitted` (still carrying
///   counter debt — a bounced/accepted submission was already accounted at its own
///   transition); the task-level counter is schema-gated via
///   `note_submission_left_review`, and the validation-config counter is decremented
///   for manual tasks (the config account is then REQUIRED);
/// - the account is closed to a worker-controlled rent destination (the primary
///   worker authority, or the canonical peer AgentRegistration PDA) and tombstoned
///   against re-init.
///
/// - every live status is closed on the now-terminalizing exit. Non-`Submitted`
///   statuses carry no review-counter debt, but their worker-funded rent must not
///   be stranded either.
fn sweep_dispute_submission<'info>(
    task: &mut Task,
    task_key: &Pubkey,
    claim_key: &Pubkey,
    worker_agent_key: &Pubkey,
    rent_recipient: &AccountInfo<'info>,
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
    let (expected_submission, expected_bump) =
        Pubkey::find_program_address(&[b"task_submission", claim_key.as_ref()], &crate::ID);
    require!(
        submission_info.key() == expected_submission
            && submission.task == *task_key
            && submission.claim == *claim_key
            && submission.worker == *worker_agent_key
            && submission.bump == expected_bump,
        CoordinationError::TaskSubmissionRequired
    );

    if submission.status == SubmissionStatus::Submitted {
        if is_manual_validation_task(task) {
            let config =
                validation_config.ok_or(CoordinationError::TaskValidationConfigRequired)?;
            let (expected_config, expected_config_bump) =
                Pubkey::find_program_address(&[b"task_validation", task_key.as_ref()], &crate::ID);
            require!(
                config.key() == expected_config && config.bump == expected_config_bump,
                CoordinationError::TaskValidationConfigRequired
            );
            ensure_validation_config(config, task_key, task)?;
            // Validate every account and counter precondition before mutating
            // either counter. On-chain failures roll back atomically; this order
            // also keeps the helper locally side-effect-free on validation errors.
            require!(
                config.pending_submission_count() > 0,
                CoordinationError::ArithmeticOverflow
            );
            if task.task_schema() >= Task::TASK_SCHEMA_CONTEST_AWARE {
                require!(
                    task.live_submissions() > 0,
                    CoordinationError::ArithmeticOverflow
                );
            }
            note_submission_left_review(task)?;
            decrement_pending_submission_count(config)?;
        } else {
            note_submission_left_review(task)?;
        }
    }

    // Return worker-funded submission rent to the caller-authenticated worker
    // destination and tombstone against re-init. Primary cleanup supplies the
    // authority wallet; peer cleanup supplies the canonical worker Agent PDA, in
    // line with the existing peer-claim rent path.
    let lamports = submission_info.lamports();
    **submission_info.try_borrow_mut_lamports()? = 0;
    **rent_recipient.try_borrow_mut_lamports()? = rent_recipient
        .lamports()
        .checked_add(lamports)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let mut data = submission_info.try_borrow_mut_data()?;
    data.fill(0);
    data[..8].copy_from_slice(&[255u8; 8]);

    Ok(())
}

/// Non-skippable TaskSubmission evidence for terminal dispute exits.
///
/// The wire account remains `Option<UncheckedAccount>` to preserve the deployed
/// account list, but the handler requires a real account meta. At the canonical
/// `['task_submission', claim]` address exactly two shapes are accepted:
///
/// - program-owned TaskSubmission: validate, settle counter debt, return its rent;
/// - system-owned + empty data: authenticated proof that no live submission exists.
///
/// `None`, a substituted address, malformed data, or any other owner fails closed.
/// Requiring the empty PDA address (rather than treating omission as absence) stops
/// a resolver or permissionless expirer from hiding live work and permanently
/// stranding the submission/config after the claim is closed.
pub(crate) fn settle_dispute_submission_evidence<'info>(
    task: &mut Task,
    task_key: &Pubkey,
    claim_key: &Pubkey,
    worker_agent_key: &Pubkey,
    rent_recipient: &AccountInfo<'info>,
    submission_info: Option<&AccountInfo<'info>>,
    validation_config: Option<&mut Account<'info, TaskValidationConfig>>,
    program_id: &Pubkey,
) -> Result<bool> {
    let submission_info = submission_info.ok_or(CoordinationError::TaskSubmissionRequired)?;
    let (expected_submission, _) =
        Pubkey::find_program_address(&[b"task_submission", claim_key.as_ref()], program_id);
    require!(
        submission_info.key() == expected_submission,
        CoordinationError::TaskSubmissionRequired
    );

    if submission_info.owner == &anchor_lang::system_program::ID && submission_info.data_is_empty()
    {
        return Ok(false);
    }
    require!(
        submission_info.owner == program_id,
        CoordinationError::InvalidAccountOwner
    );
    require!(
        submission_info.is_writable,
        CoordinationError::TaskSubmissionRequired
    );

    sweep_dispute_submission(
        task,
        task_key,
        claim_key,
        worker_agent_key,
        rent_recipient,
        submission_info,
        validation_config,
    )?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expected_peer_bundles_saturates_at_zero() {
        // Load-bearing: input 0 must yield 0, not underflow. A `checked_sub` would Err here.
        assert_eq!(expected_peer_bundles(0), 0);
        assert_eq!(expected_peer_bundles(1), 0);
        assert_eq!(expected_peer_bundles(2), 1);
        assert_eq!(expected_peer_bundles(5), 4);
        assert_eq!(expected_peer_bundles(u8::MAX), 254);
    }

    #[test]
    fn expected_peer_bundles_diverges_from_checked_sub_only_at_zero() {
        // saturating and checked agree for every c >= 1; they diverge ONLY at 0
        // (saturating == 0 vs checked == Err). Reverting to checked_sub turns the
        // input-0 assertion above red.
        for c in 1u8..=u8::MAX {
            assert_eq!(
                expected_peer_bundles(c),
                usize::from(c.checked_sub(1).unwrap())
            );
        }
        assert!(0u8.checked_sub(1).is_none());
        assert_eq!(expected_peer_bundles(0), 0);
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
            &key,
            false,
            false,
            &mut lamports,
            &mut data,
            &owner,
            false,
            0,
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
            &key,
            false,
            false,
            &mut lamports,
            &mut data,
            &owner,
            false,
            0,
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

    fn test_account_info<'a>(
        key: &'a Pubkey,
        owner: &'a Pubkey,
        writable: bool,
        lamports: &'a mut u64,
        data: &'a mut [u8],
    ) -> AccountInfo<'a> {
        AccountInfo::new(key, false, writable, lamports, data, owner, false, 0)
    }

    fn serialize_submission(submission: &TaskSubmission) -> Vec<u8> {
        let mut data = vec![0u8; TaskSubmission::SIZE];
        submission.try_serialize(&mut &mut data[..]).unwrap();
        data
    }

    fn serialize_claim(claim: &TaskClaim) -> Vec<u8> {
        let mut data = vec![0u8; TaskClaim::SIZE];
        claim.try_serialize(&mut &mut data[..]).unwrap();
        data
    }

    fn serialize_worker(worker: &AgentRegistration) -> Vec<u8> {
        let mut data = vec![0u8; AgentRegistration::SIZE];
        worker.try_serialize(&mut &mut data[..]).unwrap();
        data
    }

    fn serialize_validation_config(config: &TaskValidationConfig) -> Vec<u8> {
        let mut data = vec![0u8; TaskValidationConfig::SIZE];
        config.try_serialize(&mut &mut data[..]).unwrap();
        data
    }

    #[test]
    fn peer_bundle_wire_shape_is_exact_for_one_through_four_workers() {
        for current_workers in 1u8..=4 {
            let expected_accounts = usize::from(current_workers - 1)
                .checked_mul(DISPUTE_PEER_BUNDLE_STRIDE)
                .unwrap();
            assert_eq!(
                validate_dispute_peer_bundle_cardinality(current_workers, 0, expected_accounts)
                    .unwrap(),
                usize::from(current_workers - 1),
            );

            // Omitting even one peer-submission meta fails closed. Adding an
            // unparsed trailing meta is rejected too.
            if expected_accounts > 0 {
                assert!(validate_dispute_peer_bundle_cardinality(
                    current_workers,
                    0,
                    expected_accounts - 1,
                )
                .is_err());
            }
            assert!(validate_dispute_peer_bundle_cardinality(
                current_workers,
                0,
                expected_accounts + 1,
            )
            .is_err());
        }

        // Retired voter accounts can never be reinterpreted as peer bundles.
        assert!(validate_dispute_peer_bundle_cardinality(1, 1, 0).is_err());
    }

    #[test]
    fn mixed_peer_submissions_clear_every_child_and_counter_before_terminal_close() {
        let task_key = Pubkey::new_unique();
        let creator = Pubkey::new_unique();
        let primary_worker = Pubkey::new_unique();
        let mut task = Task {
            creator,
            task_type: crate::state::TaskType::Collaborative,
            current_workers: 3,
            constraint_hash: crate::state::MANUAL_VALIDATION_SENTINEL,
            ..Task::default()
        };
        task.set_task_schema(Task::TASK_SCHEMA_CONTEST_AWARE);
        task.set_live_submissions(1);

        let (config_key, config_bump) =
            Pubkey::find_program_address(&[b"task_validation", task_key.as_ref()], &crate::ID);
        let mut config = TaskValidationConfig {
            task: task_key,
            creator,
            mode: crate::state::ValidationMode::CreatorReview,
            bump: config_bump,
            ..TaskValidationConfig::default()
        };
        config.set_pending_submission_count(1);
        let mut config_lamports = 1;
        let mut config_data = serialize_validation_config(&config);
        let config_info = test_account_info(
            &config_key,
            &crate::ID,
            true,
            &mut config_lamports,
            config_data.as_mut_slice(),
        );
        let mut config_account = Account::<TaskValidationConfig>::try_from(&config_info).unwrap();

        // Peer 1 has a live Submitted record and therefore carries both counter
        // debt and worker-funded submission rent.
        let peer1_agent_id = [1u8; 32];
        let (peer1_worker_key, peer1_worker_bump) =
            Pubkey::find_program_address(&[b"agent", peer1_agent_id.as_ref()], &crate::ID);
        let peer1_worker = AgentRegistration {
            agent_id: peer1_agent_id,
            active_tasks: 1,
            bump: peer1_worker_bump,
            ..AgentRegistration::default()
        };
        let mut peer1_worker_lamports = 100;
        let mut peer1_worker_data = serialize_worker(&peer1_worker);
        let peer1_worker_info = test_account_info(
            &peer1_worker_key,
            &crate::ID,
            true,
            &mut peer1_worker_lamports,
            peer1_worker_data.as_mut_slice(),
        );
        let (peer1_claim_key, peer1_claim_bump) = Pubkey::find_program_address(
            &[b"claim", task_key.as_ref(), peer1_worker_key.as_ref()],
            &crate::ID,
        );
        let peer1_claim = TaskClaim {
            task: task_key,
            worker: peer1_worker_key,
            bump: peer1_claim_bump,
            ..TaskClaim::default()
        };
        let mut peer1_claim_lamports = 50;
        let mut peer1_claim_data = serialize_claim(&peer1_claim);
        let peer1_claim_info = test_account_info(
            &peer1_claim_key,
            &crate::ID,
            true,
            &mut peer1_claim_lamports,
            peer1_claim_data.as_mut_slice(),
        );
        let (peer1_submission_key, peer1_submission_bump) = Pubkey::find_program_address(
            &[b"task_submission", peer1_claim_key.as_ref()],
            &crate::ID,
        );
        let peer1_submission = TaskSubmission {
            task: task_key,
            claim: peer1_claim_key,
            worker: peer1_worker_key,
            status: SubmissionStatus::Submitted,
            bump: peer1_submission_bump,
            ..TaskSubmission::default()
        };
        let mut peer1_submission_lamports = 30;
        let mut peer1_submission_data = serialize_submission(&peer1_submission);
        let peer1_submission_info = test_account_info(
            &peer1_submission_key,
            &crate::ID,
            true,
            &mut peer1_submission_lamports,
            peer1_submission_data.as_mut_slice(),
        );

        // Peer 2 never submitted, but still supplies the exact empty canonical
        // submission PDA so absence cannot be forged by omission.
        let peer2_agent_id = [2u8; 32];
        let (peer2_worker_key, peer2_worker_bump) =
            Pubkey::find_program_address(&[b"agent", peer2_agent_id.as_ref()], &crate::ID);
        let peer2_worker = AgentRegistration {
            agent_id: peer2_agent_id,
            active_tasks: 1,
            bump: peer2_worker_bump,
            ..AgentRegistration::default()
        };
        let mut peer2_worker_lamports = 200;
        let mut peer2_worker_data = serialize_worker(&peer2_worker);
        let peer2_worker_info = test_account_info(
            &peer2_worker_key,
            &crate::ID,
            true,
            &mut peer2_worker_lamports,
            peer2_worker_data.as_mut_slice(),
        );
        let (peer2_claim_key, peer2_claim_bump) = Pubkey::find_program_address(
            &[b"claim", task_key.as_ref(), peer2_worker_key.as_ref()],
            &crate::ID,
        );
        let peer2_claim = TaskClaim {
            task: task_key,
            worker: peer2_worker_key,
            bump: peer2_claim_bump,
            ..TaskClaim::default()
        };
        let mut peer2_claim_lamports = 60;
        let mut peer2_claim_data = serialize_claim(&peer2_claim);
        let peer2_claim_info = test_account_info(
            &peer2_claim_key,
            &crate::ID,
            true,
            &mut peer2_claim_lamports,
            peer2_claim_data.as_mut_slice(),
        );
        let (peer2_submission_key, _) = Pubkey::find_program_address(
            &[b"task_submission", peer2_claim_key.as_ref()],
            &crate::ID,
        );
        let mut peer2_submission_lamports = 0;
        let mut peer2_submission_data = Vec::new();
        let peer2_submission_info = test_account_info(
            &peer2_submission_key,
            &anchor_lang::system_program::ID,
            true,
            &mut peer2_submission_lamports,
            peer2_submission_data.as_mut_slice(),
        );

        let correct_order = vec![
            peer1_claim_info.clone(),
            peer1_worker_info.clone(),
            peer1_submission_info.clone(),
            peer2_claim_info.clone(),
            peer2_worker_info.clone(),
            peer2_submission_info.clone(),
        ];

        // Account order is part of the wire contract. Swapping worker and
        // submission cannot pass canonical claim/worker binding.
        let wrong_order = vec![
            peer1_claim_info.clone(),
            peer1_submission_info.clone(),
            peer1_worker_info.clone(),
            peer2_claim_info.clone(),
            peer2_worker_info.clone(),
            peer2_submission_info.clone(),
        ];
        assert!(process_dispute_peer_bundles(
            &mut task,
            &task_key,
            &wrong_order,
            0,
            primary_worker,
            Some(&mut config_account),
            &crate::ID,
        )
        .is_err());
        assert_eq!(task.live_submissions(), 1);
        assert_eq!(config_account.pending_submission_count(), 1);
        assert_eq!(peer1_claim_info.lamports(), 50);
        assert_eq!(peer1_submission_info.lamports(), 30);

        // Stale task and validation counters each fail before rent movement or
        // tombstoning, preserving conservation on corrupted legacy state.
        task.set_live_submissions(0);
        assert!(process_dispute_peer_bundles(
            &mut task,
            &task_key,
            &correct_order,
            0,
            primary_worker,
            Some(&mut config_account),
            &crate::ID,
        )
        .is_err());
        task.set_live_submissions(1);
        config_account.set_pending_submission_count(0);
        assert!(process_dispute_peer_bundles(
            &mut task,
            &task_key,
            &correct_order,
            0,
            primary_worker,
            Some(&mut config_account),
            &crate::ID,
        )
        .is_err());
        config_account.set_pending_submission_count(1);
        assert_eq!(peer1_claim_info.lamports(), 50);
        assert_eq!(peer1_submission_info.lamports(), 30);

        process_dispute_peer_bundles(
            &mut task,
            &task_key,
            &correct_order,
            0,
            primary_worker,
            Some(&mut config_account),
            &crate::ID,
        )
        .unwrap();

        assert_eq!(task.live_submissions(), 0);
        assert_eq!(config_account.pending_submission_count(), 0);
        assert_eq!(peer1_claim_info.lamports(), 0);
        assert_eq!(peer1_submission_info.lamports(), 0);
        assert_eq!(peer1_worker_info.lamports(), 180);
        assert_eq!(peer2_claim_info.lamports(), 0);
        assert_eq!(peer2_worker_info.lamports(), 260);
        assert_eq!(
            &peer1_claim_info.try_borrow_data().unwrap()[..8],
            &[255u8; 8]
        );
        assert_eq!(
            &peer1_submission_info.try_borrow_data().unwrap()[..8],
            &[255u8; 8]
        );
        assert_eq!(
            &peer2_claim_info.try_borrow_data().unwrap()[..8],
            &[255u8; 8]
        );

        let peer1_after = {
            let data = peer1_worker_info.try_borrow_data().unwrap();
            AgentRegistration::try_deserialize(&mut &data[..]).unwrap()
        };
        let peer2_after = {
            let data = peer2_worker_info.try_borrow_data().unwrap();
            AgentRegistration::try_deserialize(&mut &data[..]).unwrap()
        };
        assert_eq!(peer1_after.active_tasks, 0);
        assert_eq!(peer2_after.active_tasks, 0);

        // Resolve/Expire performs this final primary-worker transition after peer
        // cleanup. At that point no child/counter debt remains to brick close_task.
        task.current_workers = 0;
        assert_eq!(task.current_workers, 0);
        assert_eq!(task.live_submissions(), 0);
        assert_eq!(config_account.pending_submission_count(), 0);
    }

    // Revert-sensitive: omission is not absence. Only the exact derived empty
    // PDA proves there is no live submission; a substituted empty account fails.
    #[test]
    fn dispute_submission_absence_is_canonical_and_non_skippable() {
        let task_key = Pubkey::new_unique();
        let claim_key = Pubkey::new_unique();
        let worker_key = Pubkey::new_unique();
        let mut task = Task::default();
        let wallet_key = Pubkey::new_unique();
        let mut wallet_lamports = 17;
        let mut wallet_data = Vec::new();
        let wallet_info = test_account_info(
            &wallet_key,
            &anchor_lang::system_program::ID,
            true,
            &mut wallet_lamports,
            wallet_data.as_mut_slice(),
        );

        assert!(settle_dispute_submission_evidence(
            &mut task,
            &task_key,
            &claim_key,
            &worker_key,
            &wallet_info,
            None,
            None,
            &crate::ID,
        )
        .is_err());

        let forged_key = Pubkey::new_unique();
        let mut forged_lamports = 0;
        let mut forged_data = Vec::new();
        let forged_info = test_account_info(
            &forged_key,
            &anchor_lang::system_program::ID,
            true,
            &mut forged_lamports,
            forged_data.as_mut_slice(),
        );
        assert!(settle_dispute_submission_evidence(
            &mut task,
            &task_key,
            &claim_key,
            &worker_key,
            &wallet_info,
            Some(&forged_info),
            None,
            &crate::ID,
        )
        .is_err());

        let (submission_key, _) =
            Pubkey::find_program_address(&[b"task_submission", claim_key.as_ref()], &crate::ID);
        let mut absent_lamports = 0;
        let mut absent_data = Vec::new();
        let absent_info = test_account_info(
            &submission_key,
            &anchor_lang::system_program::ID,
            true,
            &mut absent_lamports,
            absent_data.as_mut_slice(),
        );
        assert!(!settle_dispute_submission_evidence(
            &mut task,
            &task_key,
            &claim_key,
            &worker_key,
            &wallet_info,
            Some(&absent_info),
            None,
            &crate::ID,
        )
        .unwrap());
        assert_eq!(wallet_info.lamports(), 17);
    }

    // A live Submitted record carries two pieces of debt: Task.live_submissions
    // and TaskValidationConfig.pending_submission_count. The terminal exit must
    // clear both, return all worker-funded rent, and tombstone the PDA atomically.
    #[test]
    fn live_dispute_submission_clears_counters_and_returns_rent() {
        let task_key = Pubkey::new_unique();
        let claim_key = Pubkey::new_unique();
        let worker_key = Pubkey::new_unique();
        let creator = Pubkey::new_unique();

        let mut task = Task {
            creator,
            constraint_hash: crate::state::MANUAL_VALIDATION_SENTINEL,
            ..Task::default()
        };
        task.set_task_schema(Task::TASK_SCHEMA_CONTEST_AWARE);
        task.set_live_submissions(1);

        let (submission_key, submission_bump) =
            Pubkey::find_program_address(&[b"task_submission", claim_key.as_ref()], &crate::ID);
        let submission = TaskSubmission {
            task: task_key,
            claim: claim_key,
            worker: worker_key,
            status: SubmissionStatus::Submitted,
            bump: submission_bump,
            ..TaskSubmission::default()
        };
        let mut submission_lamports = 9_999;
        let mut submission_data = serialize_submission(&submission);
        let submission_info = test_account_info(
            &submission_key,
            &crate::ID,
            true,
            &mut submission_lamports,
            submission_data.as_mut_slice(),
        );

        let (config_key, config_bump) =
            Pubkey::find_program_address(&[b"task_validation", task_key.as_ref()], &crate::ID);
        let mut config = TaskValidationConfig {
            task: task_key,
            creator,
            mode: crate::state::ValidationMode::CreatorReview,
            bump: config_bump,
            ..TaskValidationConfig::default()
        };
        config.set_pending_submission_count(1);
        let mut config_lamports = 1;
        let mut config_data = serialize_validation_config(&config);
        let config_info = test_account_info(
            &config_key,
            &crate::ID,
            true,
            &mut config_lamports,
            config_data.as_mut_slice(),
        );
        let mut config_account = Account::<TaskValidationConfig>::try_from(&config_info).unwrap();

        let wallet_key = Pubkey::new_unique();
        let mut wallet_lamports = 11;
        let mut wallet_data = Vec::new();
        let wallet_info = test_account_info(
            &wallet_key,
            &anchor_lang::system_program::ID,
            true,
            &mut wallet_lamports,
            wallet_data.as_mut_slice(),
        );

        assert!(settle_dispute_submission_evidence(
            &mut task,
            &task_key,
            &claim_key,
            &worker_key,
            &wallet_info,
            Some(&submission_info),
            Some(&mut config_account),
            &crate::ID,
        )
        .unwrap());
        assert_eq!(task.live_submissions(), 0);
        assert_eq!(config_account.pending_submission_count(), 0);
        assert_eq!(submission_info.lamports(), 0);
        assert_eq!(wallet_info.lamports(), 10_010);
        assert_eq!(&submission_data[..8], &[255u8; 8]);
    }

    #[test]
    fn submitted_dispute_evidence_requires_canonical_validation_config() {
        let task_key = Pubkey::new_unique();
        let claim_key = Pubkey::new_unique();
        let worker_key = Pubkey::new_unique();
        let creator = Pubkey::new_unique();
        let mut task = Task {
            creator,
            constraint_hash: crate::state::MANUAL_VALIDATION_SENTINEL,
            ..Task::default()
        };
        task.set_task_schema(Task::TASK_SCHEMA_CONTEST_AWARE);
        task.set_live_submissions(1);

        let (submission_key, submission_bump) =
            Pubkey::find_program_address(&[b"task_submission", claim_key.as_ref()], &crate::ID);
        let submission = TaskSubmission {
            task: task_key,
            claim: claim_key,
            worker: worker_key,
            status: SubmissionStatus::Submitted,
            bump: submission_bump,
            ..TaskSubmission::default()
        };
        let mut submission_lamports = 123;
        let mut submission_data = serialize_submission(&submission);
        let submission_info = test_account_info(
            &submission_key,
            &crate::ID,
            true,
            &mut submission_lamports,
            submission_data.as_mut_slice(),
        );
        let wallet_key = Pubkey::new_unique();
        let mut wallet_lamports = 0;
        let mut wallet_data = Vec::new();
        let wallet_info = test_account_info(
            &wallet_key,
            &anchor_lang::system_program::ID,
            true,
            &mut wallet_lamports,
            wallet_data.as_mut_slice(),
        );

        assert!(settle_dispute_submission_evidence(
            &mut task,
            &task_key,
            &claim_key,
            &worker_key,
            &wallet_info,
            Some(&submission_info),
            None,
            &crate::ID,
        )
        .is_err());
        assert_eq!(task.live_submissions(), 1);
        assert_eq!(submission_info.lamports(), 123);
        assert_eq!(wallet_info.lamports(), 0);
    }
}
