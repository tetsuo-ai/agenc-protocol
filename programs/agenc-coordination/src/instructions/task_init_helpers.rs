//! Shared helpers for task initialization (create_task + create_dependent_task)

use crate::errors::CoordinationError;
use crate::instructions::constants::{
    DISPUTE_SAFE_MAX_WORKERS, MAX_DEADLINE_SECONDS, MAX_REPUTATION,
};
use crate::state::{DependencyType, ProtocolConfig, Task, TaskEscrow, TaskStatus, TaskType};
use anchor_lang::prelude::*;

/// Validates common task parameters shared between create_task and create_dependent_task.
///
/// Does NOT validate reward_amount; every caller reaches the collaborative-share
/// funding check at the shared `init_task_fields` boundary.
pub fn validate_task_params(
    task_id: &[u8; 32],
    description: &[u8; 64],
    required_capabilities: u64,
    max_workers: u8,
    task_type: u8,
    min_reputation: u16,
) -> Result<()> {
    // Validate task_id is not zero (#367)
    require!(*task_id != [0u8; 32], CoordinationError::InvalidTaskId);
    // Validate description is not empty (#369)
    require!(
        *description != [0u8; 64],
        CoordinationError::InvalidDescription
    );
    // Validate required_capabilities is not zero (#413)
    require!(
        required_capabilities != 0,
        CoordinationError::InvalidRequiredCapabilities
    );
    // Validate max_workers bounds (#412)
    require!(
        max_workers > 0 && max_workers <= DISPUTE_SAFE_MAX_WORKERS,
        CoordinationError::InvalidMaxWorkers
    );
    require!(task_type <= 3, CoordinationError::InvalidTaskType);
    // `Exclusive` settles after one completion and its bond/finalizer paths can
    // name only one worker. Allowing max_workers > 1 created extra live claims
    // that could outlive terminal settlement. Competitive and Collaborative are
    // the explicit multi-worker modes.
    if task_type == TaskType::Exclusive as u8 {
        require!(max_workers == 1, CoordinationError::InvalidMaxWorkers);
    }
    require!(
        min_reputation <= MAX_REPUTATION,
        CoordinationError::InvalidMinReputation
    );

    Ok(())
}

#[cfg(test)]
mod task_param_tests {
    use super::*;

    fn params(max_workers: u8, task_type: u8) -> Result<()> {
        validate_task_params(&[1u8; 32], &[2u8; 64], 1, max_workers, task_type, 0)
    }

    #[test]
    fn exclusive_tasks_are_single_worker_only() {
        assert!(params(1, TaskType::Exclusive as u8).is_ok());
        assert!(params(2, TaskType::Exclusive as u8).is_err());
        assert!(params(2, TaskType::Collaborative as u8).is_ok());
        assert!(params(2, TaskType::Competitive as u8).is_ok());
    }

    #[test]
    fn multi_worker_creation_is_capped_at_dispute_safe_limit() {
        assert!(params(DISPUTE_SAFE_MAX_WORKERS, TaskType::Collaborative as u8).is_ok());
        assert!(params(DISPUTE_SAFE_MAX_WORKERS + 1, TaskType::Collaborative as u8).is_err());
        assert!(params(DISPUTE_SAFE_MAX_WORKERS + 1, TaskType::Competitive as u8).is_err());
    }

    #[test]
    fn initial_completion_cardinality_matches_task_type() {
        assert_eq!(
            initial_required_completions(TaskType::Collaborative as u8, 4),
            4
        );
        for task_type in [
            TaskType::Exclusive,
            TaskType::Competitive,
            TaskType::BidExclusive,
        ] {
            assert_eq!(initial_required_completions(task_type as u8, 4), 1);
        }
    }
}

/// Enforce that the on-chain `description` carries only a content-commitment hash,
/// never human-readable prose. The field is `[u8; 64]`; the agent kit commits
/// `sha256(content)` as the 32-byte digest in bytes `0..32` with bytes `32..64`
/// zeroed (see agenc-marketplace-agent-kit `toOnChainDescriptionCommitment`). This
/// rejects any task whose description has a non-zero tail, so a caller bypassing the
/// kit cannot smuggle up to 64 bytes of readable (potentially un-moderated) text into
/// the on-chain account. Full task text lives only in the content-addressed,
/// moderation-gated job spec.
///
/// Note: this enforces the hash *layout* (32-byte digest + zero tail). Binding the
/// digest to a specific moderation attestation (so creation provably matches
/// moderated content) is the separate pre-task attestation gate (Option A) tracked
/// in this PR's design doc.
pub fn validate_description_is_content_hash(description: &[u8; 64]) -> Result<()> {
    require!(
        description[32..].iter().all(|&b| b == 0),
        CoordinationError::InvalidDescription
    );
    require!(
        description[..32].iter().any(|&b| b != 0),
        CoordinationError::InvalidDescription
    );
    Ok(())
}

/// Keep new ZK-private obligations off-chain until the complete proof stack is
/// production-ready on mainnet.
///
/// `complete_task_private` remains available as a dormant exit path so a later
/// audited deployment can settle any deliberately migrated obligation. Creation
/// must nevertheless fail closed today: the verifier programs hard-coded by the
/// current binary are not deployed on mainnet, and this repository does not yet
/// contain an auditable RISC Zero guest that proves the task statement.
pub fn require_private_task_creation_disabled(constraint_hash: Option<[u8; 32]>) -> Result<()> {
    require!(
        constraint_hash.is_none(),
        CoordinationError::PrivateTaskCreationDisabled
    );
    Ok(())
}

/// Fail-closed guard for the P6.2 referral fee leg on the restricted mainnet-canary
/// surface. The referrer 4th settlement leg is UNAUDITED money-routing and must NOT be
/// exposed on the live mainnet surface until Phase 9 / audit. Rejecting a non-default
/// referrer here (mirroring the canary reward_mint / constraint_hash rejections)
/// guarantees every canary task has `referrer == default` and `referrer_fee_bps == 0`,
/// so the shared settlement always SKIPS the referrer leg on the canary surface.
///
/// Shared so the unit test exercises the EXACT predicate the handler enforces (the test
/// goes red if this guard is removed or weakened).
pub fn require_canary_referrer_disabled(
    referrer: Option<Pubkey>,
    referrer_fee_bps: u16,
) -> Result<()> {
    require!(
        referrer.is_none() && referrer_fee_bps == 0,
        CoordinationError::InvalidInput
    );
    Ok(())
}

/// Validates Marketplace V2 task restrictions that depend on reward denomination.
pub fn validate_bid_task_mode(
    task_type: u8,
    max_workers: u8,
    reward_mint: Option<Pubkey>,
) -> Result<()> {
    if task_type == 3 {
        require!(
            max_workers == 1,
            CoordinationError::BidExclusiveRequiresSingleWorker
        );
        require!(reward_mint.is_none(), CoordinationError::BidTaskSolOnly);
    }

    Ok(())
}

/// Validates a task deadline.
///
/// If `required` is true, the deadline must be > 0 (uses `InvalidDeadline`).
/// If the deadline is set (> 0), it must be in the future (uses `InvalidInput`).
pub fn validate_deadline(deadline: i64, clock: &Clock, required: bool) -> Result<()> {
    if required {
        require!(deadline > 0, CoordinationError::InvalidDeadline);
    }
    if deadline > 0 {
        require!(
            deadline > clock.unix_timestamp,
            CoordinationError::InvalidInput
        );
        require!(
            deadline <= clock.unix_timestamp.saturating_add(MAX_DEADLINE_SECONDS),
            CoordinationError::InvalidDeadline
        );
    }
    Ok(())
}

/// Initializes common task fields. Sets `dependency_type = None` and `depends_on = None`
/// by default; callers should override these after if the task has dependencies.
pub fn init_task_fields(
    task: &mut Task,
    task_id: [u8; 32],
    creator: Pubkey,
    required_capabilities: u64,
    description: [u8; 64],
    constraint_hash: Option<[u8; 32]>,
    reward_amount: u64,
    max_workers: u8,
    task_type: u8,
    deadline: i64,
    escrow_key: Pubkey,
    bump: u8,
    protocol_fee_bps: u16,
    timestamp: i64,
    min_reputation: u16,
    reward_mint: Option<Pubkey>,
) -> Result<()> {
    // Central fail-closed boundary shared by every Task initializer, including
    // direct, dependent, humanless, and listing-hire creation paths. Handler-level
    // checks provide an early explicit error; this guard prevents a future caller
    // from bypassing the release gate by invoking the shared initializer directly.
    require_private_task_creation_disabled(constraint_hash)?;

    // Resolve and validate every fallible invariant before mutating `task`. This
    // keeps the shared helper atomic even in native/unit callers that do not have
    // Solana transaction rollback around an error.
    let resolved_task_type = match task_type {
        0 => TaskType::Exclusive,
        1 => TaskType::Collaborative,
        2 => TaskType::Competitive,
        3 => TaskType::BidExclusive,
        _ => return Err(CoordinationError::InvalidTaskType.into()),
    };
    let required_completions = initial_required_completions(task_type, max_workers);
    super::completion_helpers::validate_reward_covers_required_completions(
        resolved_task_type,
        reward_amount,
        required_completions,
    )?;
    if resolved_task_type == TaskType::Competitive {
        require!(
            reward_mint.is_none(),
            CoordinationError::ContestSolRewardOnly
        );
        require!(deadline > 0, CoordinationError::InvalidDeadline);
    }

    task.task_id = task_id;
    task.creator = creator;
    task.required_capabilities = required_capabilities;
    task.description = description;
    task.constraint_hash = [0u8; 32];
    task.reward_amount = reward_amount;
    task.max_workers = max_workers;
    task.current_workers = 0;
    task.status = TaskStatus::Open;
    task.task_type = resolved_task_type;
    task.created_at = timestamp;
    task.deadline = deadline;
    task.completed_at = 0;
    task.escrow = escrow_key;
    task.result = [0u8; 64];
    task.completions = 0;
    task.required_completions = required_completions;
    task.bump = bump;
    task.protocol_fee_bps = protocol_fee_bps;
    task.dependency_type = DependencyType::None;
    task.depends_on = None;
    task.min_reputation = min_reputation;
    task.reward_mint = reward_mint;
    // Append-only Batch-2 / P6.2 fields: default to "no leg" on init. The hire +
    // referrer paths stamp these afterward; create_task leaves them as no-leg unless
    // a referrer is supplied. (`init` zero-fills, but set them explicitly so a reused
    // account can never carry a stale operator/referrer payee.)
    task.operator = Pubkey::default();
    task.operator_fee_bps = 0;
    task.referrer = Pubkey::default();
    task.referrer_fee_bps = 0;
    // Batch 3 WS-CONTEST: every task created from this build onward is
    // contest-aware (spec §2). Live pre-batch-3 accounts read schema 0 from their
    // zeroed reserved bytes and keep today's exact semantics.
    task.set_task_schema(Task::TASK_SCHEMA_CONTEST_AWARE);
    task.set_live_submissions(0);

    Ok(())
}

/// Initial completion cardinality used by both task initialization and the
/// creation-time reward funding preflight. Keeping it in one helper prevents the
/// admission check from drifting away from settlement share math.
pub(crate) fn initial_required_completions(task_type: u8, max_workers: u8) -> u8 {
    if task_type == TaskType::Collaborative as u8 {
        max_workers
    } else {
        1
    }
}

/// Initializes escrow account fields.
pub fn init_escrow_fields(escrow: &mut TaskEscrow, task_key: Pubkey, amount: u64, bump: u8) {
    escrow.task = task_key;
    escrow.amount = amount;
    escrow.distributed = 0;
    escrow.is_closed = false;
    escrow.bump = bump;
}

/// Increments protocol_config.total_tasks with checked arithmetic.
pub fn increment_total_tasks(protocol_config: &mut ProtocolConfig) -> Result<()> {
    protocol_config.total_tasks = protocol_config
        .total_tasks
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    Ok(())
}

#[cfg(test)]
mod contest_init_tests {
    use super::*;

    fn init(task_type: u8, deadline: i64, reward_mint: Option<Pubkey>) -> Result<Task> {
        let mut task = Task::default();
        init_task_fields(
            &mut task,
            [1u8; 32],
            Pubkey::new_unique(),
            1,
            [2u8; 64],
            None,
            1_000_000,
            3,
            task_type,
            deadline,
            Pubkey::new_unique(),
            255,
            100,
            1_700_000_000,
            0,
            reward_mint,
        )?;
        Ok(task)
    }

    // Revert-sensitive: dropping the schema stamp in init_task_fields turns this red.
    #[test]
    fn new_tasks_are_stamped_contest_aware() {
        let task = init(0, 1_700_003_600, None).unwrap();
        assert_eq!(task.task_schema(), Task::TASK_SCHEMA_CONTEST_AWARE);
        assert_eq!(task.live_submissions(), 0);
    }

    #[test]
    fn competitive_creation_requires_sol_reward() {
        // Spec §3: contests are SOL-only — an SPL contest must never be able to
        // reach a ghost_at state it cannot exit.
        let err = init(2, 1_700_003_600, Some(Pubkey::new_unique()))
            .err()
            .unwrap();
        assert_eq!(err, CoordinationError::ContestSolRewardOnly.into());
        // SPL rewards stay fine for non-contest types.
        assert!(init(0, 1_700_003_600, Some(Pubkey::new_unique())).is_ok());
    }

    #[test]
    fn competitive_creation_requires_deadline() {
        let err = init(2, 0, None).err().unwrap();
        assert_eq!(err, CoordinationError::InvalidDeadline.into());
        assert!(init(2, 1_700_003_600, None).is_ok());
    }
}

#[cfg(test)]
mod collaborative_funding_tests {
    use super::*;

    fn init_collaborative(reward_amount: u64, reward_mint: Option<Pubkey>) -> Result<Task> {
        let mut task = Task::default();
        init_task_fields(
            &mut task,
            [1u8; 32],
            Pubkey::new_unique(),
            1,
            [2u8; 64],
            None,
            reward_amount,
            4,
            TaskType::Collaborative as u8,
            1_700_003_600,
            Pubkey::new_unique(),
            255,
            100,
            1_700_000_000,
            0,
            reward_mint,
        )?;
        Ok(task)
    }

    #[test]
    fn shared_initializer_enforces_exact_collaborative_share_floor_for_sol_and_tokens() {
        for reward_mint in [None, Some(Pubkey::new_unique())] {
            assert!(init_collaborative(3, reward_mint).is_err());
            let task = init_collaborative(4, reward_mint).unwrap();
            assert_eq!(task.required_completions, 4);
            assert_eq!(task.reward_amount, 4);
            assert!(init_collaborative(5, reward_mint).is_ok());
        }
    }

    #[test]
    fn rejected_collaborative_funding_does_not_partially_mutate_task() {
        let mut task = Task {
            creator: Pubkey::new_unique(),
            reward_amount: 99,
            ..Task::default()
        };
        let before = task.try_to_vec().unwrap();
        let result = init_task_fields(
            &mut task,
            [1u8; 32],
            Pubkey::new_unique(),
            1,
            [2u8; 64],
            None,
            3,
            4,
            TaskType::Collaborative as u8,
            1_700_003_600,
            Pubkey::new_unique(),
            255,
            100,
            1_700_000_000,
            0,
            None,
        );
        assert!(result.is_err());
        assert_eq!(task.try_to_vec().unwrap(), before);
    }
}

#[cfg(test)]
mod private_task_release_gate_tests {
    use super::*;

    fn init_with_constraint(constraint_hash: Option<[u8; 32]>) -> Result<Task> {
        let mut task = Task::default();
        init_task_fields(
            &mut task,
            [1u8; 32],
            Pubkey::new_unique(),
            1,
            [2u8; 64],
            constraint_hash,
            1_000_000,
            1,
            TaskType::Exclusive as u8,
            1_700_003_600,
            Pubkey::new_unique(),
            255,
            100,
            1_700_000_000,
            0,
            None,
        )?;
        Ok(task)
    }

    #[test]
    fn shared_initializer_keeps_every_creation_surface_fail_closed() {
        assert!(init_with_constraint(None).is_ok());

        for constraint_hash in [
            [0u8; 32],
            [7u8; 32],
            crate::state::MANUAL_VALIDATION_SENTINEL,
        ] {
            let err = init_with_constraint(Some(constraint_hash))
                .err()
                .expect("private task creation must fail closed");
            assert_eq!(err, CoordinationError::PrivateTaskCreationDisabled.into());
        }
    }

    #[test]
    fn release_gate_returns_the_dedicated_error() {
        let err = require_private_task_creation_disabled(Some([9u8; 32])).unwrap_err();
        assert_eq!(err, CoordinationError::PrivateTaskCreationDisabled.into());
        assert!(require_private_task_creation_disabled(None).is_ok());
    }
}

#[cfg(test)]
mod description_hash_tests {
    use super::*;

    #[test]
    fn accepts_hash_shaped_description() {
        let mut d = [0u8; 64];
        d[..32].copy_from_slice(&[7u8; 32]); // 32-byte digest, zero tail
        assert!(validate_description_is_content_hash(&d).is_ok());
    }

    #[test]
    fn rejects_readable_tail() {
        let mut d = [0u8; 64];
        d[..32].copy_from_slice(&[7u8; 32]);
        d[40] = b'A'; // readable byte in the zero tail
        assert!(validate_description_is_content_hash(&d).is_err());
    }

    #[test]
    fn rejects_all_zero_digest() {
        let d = [0u8; 64];
        assert!(validate_description_is_content_hash(&d).is_err());
    }

    #[test]
    fn rejects_raw_prose() {
        // 64 bytes of readable text (the pre-#210 behaviour) has a non-zero tail.
        let mut d = [0u8; 64];
        let text = b"this is a long human readable task description that is prose!!";
        d[..text.len()].copy_from_slice(text);
        assert!(validate_description_is_content_hash(&d).is_err());
    }
}
