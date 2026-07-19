//! Shared helpers for Task Validation V2.

use crate::errors::CoordinationError;
use crate::instructions::constants::SELECTION_WINDOW_SECS;
use crate::state::{
    AgentRegistration, Task, TaskStatus, TaskType, TaskValidationConfig, ValidationMode,
    MANUAL_VALIDATION_SENTINEL,
};
use anchor_lang::prelude::*;

/// Default creator-review window: 24 hours.
pub const DEFAULT_REVIEW_WINDOW_SECS: i64 = 86_400;
/// Maximum creator-review window accepted by the protocol: 7 days.
pub const MAX_REVIEW_WINDOW_SECS: i64 = 604_800;

pub fn is_manual_validation_task(task: &Task) -> bool {
    task.constraint_hash == MANUAL_VALIDATION_SENTINEL
}

pub fn validate_validation_mode(mode: u8) -> Result<ValidationMode> {
    match mode {
        0 => Ok(ValidationMode::Auto),
        1 => Ok(ValidationMode::CreatorReview),
        2 => Ok(ValidationMode::ValidatorQuorum),
        3 => Ok(ValidationMode::ExternalAttestation),
        _ => err!(CoordinationError::InvalidValidationMode),
    }
}

pub fn validate_review_window_for_mode(
    mode: ValidationMode,
    review_window_secs: i64,
) -> Result<()> {
    match mode {
        ValidationMode::CreatorReview => {
            require!(
                review_window_secs > 0,
                CoordinationError::InvalidReviewWindow
            );
            require!(
                review_window_secs <= MAX_REVIEW_WINDOW_SECS,
                CoordinationError::InvalidReviewWindow
            );
        }
        ValidationMode::ValidatorQuorum | ValidationMode::ExternalAttestation => {
            require!(
                review_window_secs == 0,
                CoordinationError::InvalidReviewWindow
            );
        }
        ValidationMode::Auto => return err!(CoordinationError::InvalidValidationMode),
    }

    Ok(())
}

pub fn validate_validator_quorum(mode: ValidationMode, validator_quorum: u8) -> Result<()> {
    match mode {
        ValidationMode::ValidatorQuorum => {
            require!(
                validator_quorum > 0,
                CoordinationError::InvalidValidatorQuorum
            );
        }
        ValidationMode::CreatorReview | ValidationMode::ExternalAttestation => {
            require!(
                validator_quorum == 0,
                CoordinationError::InvalidValidatorQuorum
            );
        }
        ValidationMode::Auto => return err!(CoordinationError::InvalidValidationMode),
    }

    Ok(())
}

pub fn validate_attestor(mode: ValidationMode, attestor: Option<Pubkey>) -> Result<()> {
    match mode {
        ValidationMode::ExternalAttestation => {
            let attestor = attestor.ok_or(CoordinationError::InvalidAttestor)?;
            require!(
                attestor != Pubkey::default(),
                CoordinationError::InvalidAttestor
            );
        }
        ValidationMode::CreatorReview | ValidationMode::ValidatorQuorum => {
            require!(attestor.is_none(), CoordinationError::InvalidAttestor);
        }
        ValidationMode::Auto => return err!(CoordinationError::InvalidValidationMode),
    }

    Ok(())
}

pub fn validate_task_supports_validation_mode(task: &Task, mode: ValidationMode) -> Result<()> {
    // Batch 3 WS-CONTEST: schema-1 Competitive tasks + CreatorReview ARE contests —
    // the creator reviews entries (accept/reject before `ghost_at`, the
    // permissionless ghost-split after). Only CreatorReview is a contest judging
    // mode; quorum/attestation stay unsupported. Schema-0 Competitive tasks keep
    // today's exact behavior (rejected for every manual mode).
    //
    // FIX ROUND (canary latent lock): the mainnet-canary build compiles the contest
    // ENTRY rails but `distribute_ghost_share` is full-module-only — a canary-built
    // deployment could otherwise mint a contest that becomes unexitable after
    // `ghost_at`. Gate the CreatorReview-for-Competitive allowance OFF under the
    // canary feature so canary builds are contest-INCAPABLE by construction
    // (Competitive rejects every manual mode, exactly the pre-batch-3 behavior).
    if task.task_type == TaskType::Competitive {
        #[cfg(feature = "mainnet-canary")]
        {
            let _ = mode;
            return err!(CoordinationError::ValidationModeUnsupportedTaskType);
        }
        #[cfg(not(feature = "mainnet-canary"))]
        require!(
            task.task_schema() >= Task::TASK_SCHEMA_CONTEST_AWARE
                && mode == ValidationMode::CreatorReview,
            CoordinationError::ValidationModeUnsupportedTaskType
        );
    }
    require!(
        task.constraint_hash == [0u8; 32] || is_manual_validation_task(task),
        CoordinationError::ManualValidationPrivateTaskUnsupported
    );

    // Bid-exclusive flows remain single-worker even when reviewed.
    if task.task_type == TaskType::BidExclusive {
        require!(
            mode != ValidationMode::ValidatorQuorum || task.max_workers == 1,
            CoordinationError::ValidationModeUnsupportedTaskType
        );
    }

    Ok(())
}

pub fn validate_configurable_task(task: &Task) -> Result<()> {
    require!(
        task.status == TaskStatus::Open,
        CoordinationError::TaskValidationImmutableAfterClaim
    );
    require!(
        task.current_workers == 0 && task.completions == 0,
        CoordinationError::TaskValidationImmutableAfterClaim
    );
    Ok(())
}

pub fn ensure_validation_config(
    config: &TaskValidationConfig,
    task_key: &Pubkey,
    task: &Task,
) -> Result<()> {
    require!(
        config.task == *task_key,
        CoordinationError::TaskValidationConfigRequired
    );
    require!(
        config.creator == task.creator,
        CoordinationError::UnauthorizedTaskAction
    );
    Ok(())
}

pub fn ensure_validation_mode(
    config: &TaskValidationConfig,
    expected: ValidationMode,
) -> Result<()> {
    require!(
        config.mode == expected,
        CoordinationError::ValidationModeMismatch
    );
    Ok(())
}

pub fn increment_pending_submission_count(config: &mut TaskValidationConfig) -> Result<()> {
    let next = config
        .pending_submission_count()
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    config.set_pending_submission_count(next);
    Ok(())
}

pub fn decrement_pending_submission_count(config: &mut TaskValidationConfig) -> Result<()> {
    let next = config
        .pending_submission_count()
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    config.set_pending_submission_count(next);
    Ok(())
}

pub fn sync_task_validation_status(task: &mut Task, config: &TaskValidationConfig) {
    // Terminal/frozen states are sticky: never let a stray sync recompute (and thus
    // silently un-freeze a RejectFrozen task back to Open/InProgress/PendingValidation,
    // or revive a Completed one). RejectFrozen exits only via resolve/expire_reject_frozen.
    if task.status == TaskStatus::Completed || task.status == TaskStatus::RejectFrozen {
        return;
    }

    task.status = if config.pending_submission_count() > 0 {
        TaskStatus::PendingValidation
    } else if task.current_workers > 0 {
        TaskStatus::InProgress
    } else {
        TaskStatus::Open
    };
}

// ---------------------------------------------------------------------------
// Batch 3 WS-CONTEST: live-submission accounting + the ghost temporal partition
// ---------------------------------------------------------------------------

/// A submission entered `Submitted`: bump the Task-level live-submission counter.
/// Schema-gated no-op for pre-batch-3 tasks (their counter bytes stay untouched,
/// preserving byte-identical behavior; splitting on an undercount would drain
/// escrow with submitters unpaid — spec §2).
pub fn note_submission_entered_review(task: &mut Task) -> Result<()> {
    if task.task_schema() < Task::TASK_SCHEMA_CONTEST_AWARE {
        return Ok(());
    }
    let next = task
        .live_submissions()
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    task.set_live_submissions(next);
    Ok(())
}

/// A submission left `Submitted` (accept/reject/change-request/freeze/ghost-pay):
/// decrement the Task-level live-submission counter. Schema-gated no-op for
/// pre-batch-3 tasks; underflow on a schema-1 task is counter corruption and
/// fails closed.
pub fn note_submission_left_review(task: &mut Task) -> Result<()> {
    if task.task_schema() < Task::TASK_SCHEMA_CONTEST_AWARE {
        return Ok(());
    }
    let next = task
        .live_submissions()
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    task.set_live_submissions(next);
    Ok(())
}

/// A contest-CONFIGURED task: schema-1 `Competitive` AND actually configured for
/// manual (CreatorReview — the only mode `validate_task_supports_validation_mode`
/// permits for Competitive) validation. This is the conjunction that decides
/// whether a task actually ENTERS the contest lifecycle (PendingValidation →
/// accept/reject/ghost-split). An AUTO-validation schema-1 Competitive task never
/// does — it keeps the pre-batch-3 flows (including dispute recourse), so gates
/// that REMOVE recourse must use this predicate, not the broader
/// [`Task::is_contest_task`] (which is correct for creation-time gates where the
/// validation mode is not yet known).
pub fn is_contest_configured_task(task: &Task) -> bool {
    task.is_contest_task() && is_manual_validation_task(task)
}

/// The contest ghost boundary: `ghost_at = deadline + SELECTION_WINDOW_SECS`.
/// Only meaningful for contest tasks; creation enforces `deadline > 0` for them,
/// and a zero deadline here fails closed rather than yielding a bogus boundary.
pub fn contest_ghost_at(task: &Task) -> Result<i64> {
    require!(task.deadline > 0, CoordinationError::InvalidDeadline);
    task.deadline
        .checked_add(SELECTION_WINDOW_SECS)
        .ok_or_else(|| error!(CoordinationError::ArithmeticOverflow))
}

/// Temporal-partition guard for the creator-side contest settle (accept):
/// permitted strictly BEFORE `ghost_at`. Pure + revert-sensitive.
pub fn validate_contest_accept_window(task: &Task, now: i64) -> Result<()> {
    if !task.is_contest_task() {
        return Ok(());
    }
    require!(
        now < contest_ghost_at(task)?,
        CoordinationError::ContestSelectionWindowElapsed
    );
    // A contest winner may be accepted only once every OTHER live submission has
    // been rejected/resolved. Without this, accepting flips the task Completed
    // while loser claims + submissions are still live — with no exit path left
    // (reject/expire both require a non-terminal task), permanently stranding
    // loser rent and the Task account itself (current_workers can never reach 0).
    require!(
        task.live_submissions() == 1,
        CoordinationError::ContestAcceptRequiresSoleLiveSubmission
    );
    Ok(())
}

/// A non-collaborative manual-review accept that completes the task must be the
/// sole live submission. Contest tasks are covered by
/// `validate_contest_accept_window`; Collaborative tasks deliberately allow a
/// completing accept with excess submitted workers because
/// `reclaim_terminal_claim` provides their permissionless, full-refund cleanup.
/// Keeping the old sole-submission rule for Collaborative tasks made timeout
/// auto-accept deadlock forever whenever more results were submitted than the
/// remaining completion slots.
///
/// Schema-gated exactly like `note_submission_entered_review` / `note_submission_left_review`:
/// a schema-0 (pre-batch-3) task NEVER maintains `live_submissions()` — it reads 0 forever —
/// so requiring `== 1` here would hard-fail EVERY completing accept on a legacy
/// manual-validation task (`required_completions == 1` makes each exclusive accept
/// completing) and strand its escrow on the frozen canary surface. Schema-0 keeps
/// byte-identical pre-guard behavior; the drain this guard stops needs the schema-1
/// live-submission accounting to exist at all.
pub fn validate_completing_accept_sole_submission(task: &Task) -> Result<()> {
    if task.is_contest_task() {
        return Ok(());
    }
    if task.task_type == TaskType::Collaborative {
        return Ok(());
    }
    if task.task_schema() < Task::TASK_SCHEMA_CONTEST_AWARE {
        return Ok(());
    }
    let will_complete = task.completions.saturating_add(1) >= task.required_completions;
    if will_complete {
        require!(
            task.live_submissions() == 1,
            CoordinationError::CompletingAcceptRequiresSoleLiveSubmission
        );
    }
    Ok(())
}

/// Temporal-partition guard for the creator-side contest REJECT (fix round —
/// symmetric with the accept window): permitted strictly BEFORE `ghost_at`.
/// Without it a creator could front-run the ghost cranks after `ghost_at`,
/// reject every entry (driving the task to Open), cancel, and claw back the
/// prize — hollowing out the ghost-split guarantee. From `ghost_at` onward the
/// crank owns every live submission. Pure + revert-sensitive.
pub fn validate_contest_reject_window(task: &Task, now: i64) -> Result<()> {
    if !task.is_contest_task() {
        return Ok(());
    }
    require!(
        now < contest_ghost_at(task)?,
        CoordinationError::ContestSelectionWindowElapsed
    );
    Ok(())
}

pub fn release_claim_slot(
    task: &mut Task,
    worker: &mut AgentRegistration,
    released_at: i64,
) -> Result<()> {
    task.current_workers = task
        .current_workers
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    worker.active_tasks = worker
        .active_tasks
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    worker.last_active = released_at;
    Ok(())
}

/// Audit F-15: counter decrement that never bricks on legacy counter drift.
/// `reclaim_terminal_claim` and `expire_claim` are the designated un-brickers for
/// stranded claims — a `checked_sub` underflow there would itself permanently
/// brick the recovery path (the codebase deliberately uses saturating_sub for
/// counters that may carry pre-migration drift). Pure + revert-sensitive.
pub trait SaturatingDec {
    fn saturating_dec(self) -> Self;
}

impl SaturatingDec for u8 {
    fn saturating_dec(self) -> Self {
        self.saturating_sub(1)
    }
}

impl SaturatingDec for u16 {
    fn saturating_dec(self) -> Self {
        self.saturating_sub(1)
    }
}

pub fn saturating_dec_counter<T: SaturatingDec>(v: T) -> T {
    v.saturating_dec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sync_task_validation_status_prefers_pending_submission_state() {
        let mut task = Task {
            status: TaskStatus::InProgress,
            current_workers: 1,
            ..Task::default()
        };
        let mut config = TaskValidationConfig::default();
        config.set_pending_submission_count(2);

        sync_task_validation_status(&mut task, &config);

        assert!(task.status == TaskStatus::PendingValidation);
    }

    #[test]
    fn test_sync_task_validation_status_restores_in_progress_when_claims_remain() {
        let mut task = Task {
            status: TaskStatus::PendingValidation,
            current_workers: 2,
            ..Task::default()
        };
        let config = TaskValidationConfig::default();

        sync_task_validation_status(&mut task, &config);

        assert!(task.status == TaskStatus::InProgress);
    }

    #[test]
    fn test_sync_task_validation_status_reopens_task_without_claims() {
        let mut task = Task {
            status: TaskStatus::PendingValidation,
            current_workers: 0,
            ..Task::default()
        };
        let config = TaskValidationConfig::default();

        sync_task_validation_status(&mut task, &config);

        assert!(task.status == TaskStatus::Open);
    }

    #[test]
    fn test_sync_task_validation_status_preserves_completed_terminal_state() {
        let mut task = Task {
            status: TaskStatus::Completed,
            current_workers: 1,
            ..Task::default()
        };
        let mut config = TaskValidationConfig::default();
        config.set_pending_submission_count(1);

        sync_task_validation_status(&mut task, &config);

        assert!(task.status == TaskStatus::Completed);
    }

    #[test]
    fn test_sync_task_validation_status_preserves_reject_frozen_state() {
        // A frozen task must stay frozen — a stray sync (e.g. a pending submission or
        // a remaining worker) must NOT recompute it back to PendingValidation/InProgress.
        let mut task = Task {
            status: TaskStatus::RejectFrozen,
            current_workers: 1,
            ..Task::default()
        };
        let mut config = TaskValidationConfig::default();
        config.set_pending_submission_count(1);

        sync_task_validation_status(&mut task, &config);

        assert!(task.status == TaskStatus::RejectFrozen);
    }

    #[test]
    fn test_release_claim_slot_updates_counters_and_last_active() {
        let mut task = Task {
            current_workers: 2,
            ..Task::default()
        };
        let mut worker = AgentRegistration {
            active_tasks: 3,
            last_active: 10,
            ..AgentRegistration::default()
        };

        release_claim_slot(&mut task, &mut worker, 42).expect("slot release should succeed");

        assert_eq!(task.current_workers, 1);
        assert_eq!(worker.active_tasks, 2);
        assert_eq!(worker.last_active, 42);
    }

    #[test]
    fn test_release_claim_slot_rejects_underflow() {
        let mut task = Task::default();
        let mut worker = AgentRegistration::default();

        assert!(release_claim_slot(&mut task, &mut worker, 42).is_err());
    }

    // Audit F-15 (revert-sensitive): the recovery-path decrement saturates at 0
    // instead of underflow-erroring on drifted counters. checked_sub turns the
    // first assert red (0 would error instead of returning 0).
    #[test]
    fn saturating_dec_counter_never_bricks_on_drift() {
        assert_eq!(saturating_dec_counter(0u8), 0);
        assert_eq!(saturating_dec_counter(1u8), 0);
        assert_eq!(saturating_dec_counter(5u8), 4);
        assert_eq!(saturating_dec_counter(u8::MAX), u8::MAX - 1);
        assert_eq!(saturating_dec_counter(0u16), 0);
        assert_eq!(saturating_dec_counter(1u16), 0);
        assert_eq!(saturating_dec_counter(500u16), 499);
        assert_eq!(saturating_dec_counter(u16::MAX), u16::MAX - 1);
    }

    #[test]
    fn test_pending_submission_count_round_trip() {
        let mut config = TaskValidationConfig::default();

        increment_pending_submission_count(&mut config).expect("increment should succeed");
        increment_pending_submission_count(&mut config).expect("second increment should succeed");
        assert_eq!(config.pending_submission_count(), 2);

        decrement_pending_submission_count(&mut config).expect("decrement should succeed");
        assert_eq!(config.pending_submission_count(), 1);
    }

    #[test]
    fn test_pending_submission_count_rejects_underflow() {
        let mut config = TaskValidationConfig::default();

        assert!(decrement_pending_submission_count(&mut config).is_err());
    }

    #[test]
    fn test_pending_submission_count_rejects_overflow() {
        let mut config = TaskValidationConfig::default();
        config.set_pending_submission_count(u16::MAX);

        assert!(increment_pending_submission_count(&mut config).is_err());
    }

    // === Batch 3 WS-CONTEST helpers ===

    fn contest_task(deadline: i64, live: u8) -> Task {
        let mut task = Task {
            task_type: TaskType::Competitive,
            deadline,
            ..Task::default()
        };
        task.set_task_schema(Task::TASK_SCHEMA_CONTEST_AWARE);
        task.set_live_submissions(live);
        task
    }

    // === Audit M-2: completing-accept sole-submission guard ===

    fn schema1_task(task_type: TaskType, required: u8, completions: u8, live: u8) -> Task {
        let mut task = Task {
            task_type,
            required_completions: required,
            completions,
            ..Task::default()
        };
        task.set_task_schema(Task::TASK_SCHEMA_CONTEST_AWARE);
        task.set_live_submissions(live);
        task
    }

    // Collaborative stragglers have a terminal Submitted cleanup path, so a
    // completing timeout accept must not depend on the creator returning.
    #[test]
    fn completing_accept_allows_collaborative_straggler_cleanup() {
        // required_completions = 2. A non-completing accept (0 -> 1) may leave peers live.
        let task = schema1_task(TaskType::Collaborative, 2, 0, 2);
        assert!(validate_completing_accept_sole_submission(&task).is_ok());
        // The completing accept (1 -> 2) may leave a straggler for terminal reclaim.
        let task = schema1_task(TaskType::Collaborative, 2, 1, 2);
        assert!(validate_completing_accept_sole_submission(&task).is_ok());
        // The completing accept as the sole live submission is allowed.
        let task = schema1_task(TaskType::Collaborative, 2, 1, 1);
        assert!(validate_completing_accept_sole_submission(&task).is_ok());
    }

    #[test]
    fn completing_accept_guard_noops_for_contest() {
        // Contest is covered by validate_contest_accept_window; this guard defers to it.
        let task = schema1_task(TaskType::Competitive, 1, 0, 3);
        assert!(validate_completing_accept_sole_submission(&task).is_ok());
    }

    #[test]
    fn completing_accept_still_rejects_non_collaborative_orphans() {
        let task = schema1_task(TaskType::Exclusive, 1, 0, 2);
        assert!(validate_completing_accept_sole_submission(&task).is_err());
    }

    // Revert-sensitive (canary regression): schema-0 tasks never maintain live_submissions(),
    // so an ungated guard hard-fails EVERY completing accept on a legacy manual-validation
    // task (required_completions == 1 makes each exclusive accept completing), stranding the
    // escrow on the frozen 25-instruction surface. Dropping the schema gate turns this red.
    #[test]
    fn completing_accept_guard_noops_for_schema0() {
        // Legacy exclusive task (required_completions == 1): every accept is completing,
        // live_submissions() reads 0 — the guard must not fire.
        let mut exclusive = Task {
            required_completions: 1,
            completions: 0,
            ..Task::default()
        };
        exclusive.set_live_submissions(0);
        assert!(validate_completing_accept_sole_submission(&exclusive).is_ok());
        // Legacy collaborative task: completing accept with (untrackable) peers is
        // byte-identical to the pre-guard behavior.
        let collaborative = Task {
            task_type: TaskType::Collaborative,
            required_completions: 2,
            completions: 1,
            ..Task::default()
        };
        assert!(validate_completing_accept_sole_submission(&collaborative).is_ok());
    }

    #[test]
    fn test_live_submission_counter_round_trip_schema1() {
        let mut task = contest_task(1_000, 0);
        note_submission_entered_review(&mut task).unwrap();
        note_submission_entered_review(&mut task).unwrap();
        assert_eq!(task.live_submissions(), 2);
        note_submission_left_review(&mut task).unwrap();
        assert_eq!(task.live_submissions(), 1);
    }

    #[test]
    fn test_live_submission_counter_underflow_fails_closed() {
        let mut task = contest_task(1_000, 0);
        assert!(note_submission_left_review(&mut task).is_err());
    }

    // Revert-sensitive: dropping the schema gate makes schema-0 tasks write the
    // counter byte (no longer byte-identical) and turns these red.
    #[test]
    fn test_live_submission_counter_is_noop_for_schema0() {
        let mut task = Task {
            task_type: TaskType::Competitive,
            deadline: 1_000,
            ..Task::default()
        };
        note_submission_entered_review(&mut task).unwrap();
        assert_eq!(
            task._reserved, [0u8; 16],
            "schema-0 reserved bytes untouched"
        );
        // Decrement on schema-0 must not underflow-error either (no-op).
        note_submission_left_review(&mut task).unwrap();
        assert_eq!(task._reserved, [0u8; 16]);
    }

    #[test]
    fn test_contest_ghost_at_is_deadline_plus_window() {
        let task = contest_task(1_000, 1);
        assert_eq!(
            contest_ghost_at(&task).unwrap(),
            1_000 + SELECTION_WINDOW_SECS
        );
        assert_eq!(SELECTION_WINDOW_SECS, 172_800);
    }

    #[test]
    fn test_contest_ghost_at_rejects_zero_deadline() {
        let task = contest_task(0, 1);
        assert!(contest_ghost_at(&task).is_err());
    }

    // Revert-sensitive: removing the `now < ghost_at` require turns this red
    // (temporal partition, spec §3).
    #[test]
    fn test_contest_accept_window_forbids_accept_at_or_after_ghost_at() {
        let task = contest_task(1_000, 1);
        let ghost_at = 1_000 + SELECTION_WINDOW_SECS;
        assert!(validate_contest_accept_window(&task, ghost_at - 1).is_ok());
        let at = validate_contest_accept_window(&task, ghost_at).unwrap_err();
        assert_eq!(at, CoordinationError::ContestSelectionWindowElapsed.into());
        assert!(validate_contest_accept_window(&task, ghost_at + 1).is_err());
    }

    // Revert-sensitive: removing the sole-live-submission require turns this red.
    #[test]
    fn test_contest_accept_window_requires_sole_live_submission() {
        let task = contest_task(1_000, 2);
        let err = validate_contest_accept_window(&task, 1_001).unwrap_err();
        assert_eq!(
            err,
            CoordinationError::ContestAcceptRequiresSoleLiveSubmission.into()
        );
    }

    #[test]
    fn test_contest_accept_window_is_noop_for_non_contests() {
        // Schema-0 Competitive (live mainnet task) and schema-1 Exclusive pass
        // through untouched — byte-identical semantics for non-contests.
        let legacy = Task {
            task_type: TaskType::Competitive,
            deadline: 1_000,
            ..Task::default()
        };
        assert!(validate_contest_accept_window(&legacy, i64::MAX).is_ok());

        let mut exclusive = Task {
            deadline: 1_000,
            ..Task::default()
        };
        exclusive.set_task_schema(Task::TASK_SCHEMA_CONTEST_AWARE);
        assert!(validate_contest_accept_window(&exclusive, i64::MAX).is_ok());
    }

    // Revert-sensitive (FIX 2): removing the `now < ghost_at` require in
    // validate_contest_reject_window turns this red — a creator could front-run
    // the ghost cranks, reject-all, and claw back the prize.
    #[test]
    fn test_contest_reject_window_forbids_reject_at_or_after_ghost_at() {
        let task = contest_task(1_000, 2);
        let ghost_at = 1_000 + SELECTION_WINDOW_SECS;
        assert!(validate_contest_reject_window(&task, ghost_at - 1).is_ok());
        let at = validate_contest_reject_window(&task, ghost_at).unwrap_err();
        assert_eq!(at, CoordinationError::ContestSelectionWindowElapsed.into());
        assert!(validate_contest_reject_window(&task, ghost_at + 1).is_err());
    }

    #[test]
    fn test_contest_reject_window_is_noop_for_non_contests() {
        let legacy = Task {
            task_type: TaskType::Competitive,
            deadline: 1_000,
            ..Task::default()
        };
        assert!(validate_contest_reject_window(&legacy, i64::MAX).is_ok());
    }

    // FIX 3: the recourse-removing gates key on contest-CONFIGURED (schema-1
    // Competitive AND manual validation), not on the type-wide predicate — an
    // auto-mode Competitive task never enters the contest lifecycle and must keep
    // its dispute recourse.
    #[test]
    fn test_is_contest_configured_requires_manual_validation() {
        let mut auto_competitive = contest_task(1_000, 0);
        // Default constraint_hash is zeroed — an auto-validation task.
        assert!(auto_competitive.is_contest_task());
        assert!(!is_contest_configured_task(&auto_competitive));

        auto_competitive.constraint_hash = MANUAL_VALIDATION_SENTINEL;
        assert!(is_contest_configured_task(&auto_competitive));

        let mut manual_exclusive = Task {
            constraint_hash: MANUAL_VALIDATION_SENTINEL,
            deadline: 1_000,
            ..Task::default()
        };
        manual_exclusive.set_task_schema(Task::TASK_SCHEMA_CONTEST_AWARE);
        assert!(!is_contest_configured_task(&manual_exclusive));
    }

    #[test]
    fn test_competitive_manual_validation_mode_support() {
        // Schema-1 Competitive: CreatorReview allowed (full module), quorum/attestation rejected.
        let contest = contest_task(1_000, 0);
        // FIX 7 (canary latent lock): under the mainnet-canary feature the
        // CreatorReview-for-Competitive allowance is OFF — the canary build is
        // contest-incapable by construction (distribute_ghost_share is
        // full-module-only, so a canary contest could never exit after ghost_at).
        #[cfg(feature = "mainnet-canary")]
        assert!(
            validate_task_supports_validation_mode(&contest, ValidationMode::CreatorReview)
                .is_err()
        );
        #[cfg(not(feature = "mainnet-canary"))]
        assert!(
            validate_task_supports_validation_mode(&contest, ValidationMode::CreatorReview).is_ok()
        );
        assert!(
            validate_task_supports_validation_mode(&contest, ValidationMode::ValidatorQuorum)
                .is_err()
        );
        assert!(validate_task_supports_validation_mode(
            &contest,
            ValidationMode::ExternalAttestation
        )
        .is_err());

        // Schema-0 Competitive keeps today's behavior: every manual mode rejected.
        let legacy = Task {
            task_type: TaskType::Competitive,
            ..Task::default()
        };
        assert!(
            validate_task_supports_validation_mode(&legacy, ValidationMode::CreatorReview).is_err()
        );
    }
}
