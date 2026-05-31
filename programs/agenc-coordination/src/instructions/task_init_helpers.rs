//! Shared helpers for task initialization (create_task + create_dependent_task)

use crate::errors::CoordinationError;
use crate::instructions::constants::{MAX_DEADLINE_SECONDS, MAX_REPUTATION};
use crate::state::{
    DependencyType, ProtocolConfig, Task, TaskEscrow, TaskStatus, TaskType,
    MANUAL_VALIDATION_SENTINEL,
};
use anchor_lang::prelude::*;

/// Validates common task parameters shared between create_task and create_dependent_task.
///
/// Does NOT validate reward_amount (differs: create_task requires > 0, dependent tasks allow 0).
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
        max_workers > 0 && max_workers <= 100,
        CoordinationError::InvalidMaxWorkers
    );
    require!(task_type <= 3, CoordinationError::InvalidTaskType);
    require!(
        min_reputation <= MAX_REPUTATION,
        CoordinationError::InvalidMinReputation
    );

    Ok(())
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
    if let Some(hash) = constraint_hash {
        require!(
            hash != MANUAL_VALIDATION_SENTINEL,
            CoordinationError::InvalidInput
        );
    }

    task.task_id = task_id;
    task.creator = creator;
    task.required_capabilities = required_capabilities;
    task.description = description;
    task.constraint_hash = constraint_hash.unwrap_or([0u8; 32]);
    task.reward_amount = reward_amount;
    task.max_workers = max_workers;
    task.current_workers = 0;
    task.status = TaskStatus::Open;
    task.task_type = match task_type {
        0 => TaskType::Exclusive,
        1 => TaskType::Collaborative,
        2 => TaskType::Competitive,
        3 => TaskType::BidExclusive,
        _ => return Err(CoordinationError::InvalidTaskType.into()),
    };
    task.created_at = timestamp;
    task.deadline = deadline;
    task.completed_at = 0;
    task.escrow = escrow_key;
    task.result = [0u8; 64];
    task.completions = 0;
    task.required_completions = if task_type == 1 { max_workers } else { 1 };
    task.bump = bump;
    task.protocol_fee_bps = protocol_fee_bps;
    task.dependency_type = DependencyType::None;
    task.depends_on = None;
    task.min_reputation = min_reputation;
    task.reward_mint = reward_mint;

    Ok(())
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
