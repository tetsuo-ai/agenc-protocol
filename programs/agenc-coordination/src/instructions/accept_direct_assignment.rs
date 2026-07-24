//! Bilateral direct assignment for a creator-owned Exclusive task.
//!
//! Public `claim_task_with_job_spec` intentionally rejects this rail. Assignment
//! happens only when the creator and the exact worker authority co-sign the same
//! transaction, after the worker has seen a pinned job-spec and attestor snapshot.

use anchor_lang::prelude::*;

use crate::errors::CoordinationError;
use crate::instructions::claim_task::{process_claim, validate_job_spec_pointer, ClaimRoute};
use crate::instructions::completion_helpers::validate_task_dependency_for_assignment;
use crate::instructions::launch_controls::require_direct_assignment_enabled;
use crate::instructions::moderation_gate_helpers::require_content_not_blocked;
use crate::instructions::task_validation_helpers::ensure_validation_config;
use crate::state::{
    AgentRegistration, ProtocolConfig, Task, TaskAttestorConfig, TaskClaim, TaskJobSpec,
    TaskStatus, TaskType, TaskValidationConfig, ValidationMode,
};

#[derive(Accounts)]
pub struct AcceptDirectAssignmentWithJobSpec<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        constraint = task.creator == creator.key() @ CoordinationError::UnauthorizedTaskAction
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        seeds = [b"task_job_spec", task.key().as_ref()],
        bump = task_job_spec.bump,
        constraint = task_job_spec.task == task.key() @ CoordinationError::TaskJobSpecTaskMismatch,
        constraint = task_job_spec.creator == task.creator @ CoordinationError::UnauthorizedTaskAction
    )]
    pub task_job_spec: Box<Account<'info, TaskJobSpec>>,

    #[account(
        seeds = [b"task_validation", task.key().as_ref()],
        bump = task_validation_config.bump,
        constraint = task_validation_config.task == task.key() @ CoordinationError::TaskValidationConfigRequired,
        constraint = task_validation_config.creator == task.creator @ CoordinationError::UnauthorizedTaskAction
    )]
    pub task_validation_config: Box<Account<'info, TaskValidationConfig>>,

    #[account(
        seeds = [b"task_attestor", task.key().as_ref()],
        bump = task_attestor_config.bump,
        constraint = task_attestor_config.task == task.key() @ CoordinationError::TaskAttestorConfigRequired,
        constraint = task_attestor_config.creator == task.creator @ CoordinationError::UnauthorizedTaskAction
    )]
    pub task_attestor_config: Box<Account<'info, TaskAttestorConfig>>,

    /// Direct tasks are created without a listing hire. Pinning this canonical
    /// empty PDA prevents a caller from smuggling a different assignment policy.
    /// CHECK: seeds pin the address; handler requires system-owned empty data.
    #[account(seeds = [b"hire", task.key().as_ref()], bump)]
    pub hire_record: UncheckedAccount<'info>,

    /// CHECK: handler derives this PDA from the pinned job-spec hash and rejects
    /// a content hash that has been blocked after publication.
    pub moderation_block: UncheckedAccount<'info>,

    #[account(
        init,
        payer = worker_authority,
        space = TaskClaim::SIZE,
        seeds = [b"claim", task.key().as_ref(), worker.key().as_ref()],
        bump,
        constraint = claim.key() != task.key() @ CoordinationError::InvalidInput
    )]
    pub claim: Box<Account<'info, TaskClaim>>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    #[account(
        mut,
        seeds = [b"agent", worker.agent_id.as_ref()],
        bump = worker.bump,
        constraint = worker.authority == worker_authority.key() @ CoordinationError::UnauthorizedAgent
    )]
    pub worker: Box<Account<'info, AgentRegistration>>,

    /// The task funder must co-sign the exact worker, job-spec and attestor
    /// snapshot in this instruction.
    pub creator: Signer<'info>,

    /// The intended worker must co-sign before its claim and obligation exist.
    #[account(mut)]
    pub worker_authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub(crate) fn validate_direct_assignment_task(task: &Task) -> Result<()> {
    require!(
        task.is_direct_assignment(),
        CoordinationError::TaskNotDirectAssignment
    );
    require!(
        task.task_type == TaskType::Exclusive && task.max_workers == 1,
        CoordinationError::InvalidDirectAssignmentTask
    );
    require!(
        task.status == TaskStatus::Open && task.current_workers == 0,
        CoordinationError::TaskNotOpen
    );
    Ok(())
}

pub(crate) fn validate_direct_assignment_snapshot(
    task_job_spec: &TaskJobSpec,
    task_validation_config: &TaskValidationConfig,
    task_attestor_config: &TaskAttestorConfig,
    expected_job_spec_hash: [u8; 32],
    expected_job_spec_updated_at: i64,
    expected_attestor: Pubkey,
) -> Result<()> {
    validate_job_spec_pointer(task_job_spec)?;
    require!(
        task_job_spec.job_spec_hash == expected_job_spec_hash
            && task_job_spec.updated_at == expected_job_spec_updated_at,
        CoordinationError::StaleDirectAssignmentAcceptance
    );
    require!(
        task_validation_config.mode == ValidationMode::ExternalAttestation
            && task_attestor_config.attestor == expected_attestor
            && expected_attestor != Pubkey::default(),
        CoordinationError::DirectAssignmentExternalAttestationRequired
    );
    Ok(())
}

pub fn handler(
    ctx: Context<AcceptDirectAssignmentWithJobSpec>,
    expected_job_spec_hash: [u8; 32],
    expected_job_spec_updated_at: i64,
    expected_attestor: Pubkey,
) -> Result<()> {
    require_direct_assignment_enabled(ctx.accounts.protocol_config.as_ref())?;
    let task = ctx.accounts.task.as_ref();
    validate_direct_assignment_task(task)?;
    validate_direct_assignment_snapshot(
        ctx.accounts.task_job_spec.as_ref(),
        ctx.accounts.task_validation_config.as_ref(),
        ctx.accounts.task_attestor_config.as_ref(),
        expected_job_spec_hash,
        expected_job_spec_updated_at,
        expected_attestor,
    )?;
    require_content_not_blocked(
        &ctx.accounts.moderation_block.to_account_info(),
        &expected_job_spec_hash,
    )?;

    ensure_validation_config(
        ctx.accounts.task_validation_config.as_ref(),
        &ctx.accounts.task.key(),
        task,
    )?;
    let hire_info = ctx.accounts.hire_record.to_account_info();
    require!(
        hire_info.owner == &anchor_lang::system_program::ID && hire_info.data_is_empty(),
        CoordinationError::InvalidHireRecord
    );

    let dependency_account_count =
        usize::from(task.dependency_type != crate::state::DependencyType::None);
    require!(
        ctx.remaining_accounts.len() == dependency_account_count,
        CoordinationError::ParentTaskAccountRequired
    );
    validate_task_dependency_for_assignment(task, ctx.remaining_accounts, ctx.program_id)?;

    let task_key = ctx.accounts.task.key();
    let worker_key = ctx.accounts.worker.key();
    process_claim(
        task_key,
        ctx.accounts.task.as_mut(),
        ctx.accounts.claim.as_mut(),
        ctx.accounts.protocol_config.as_ref(),
        worker_key,
        ctx.accounts.worker.as_mut(),
        ctx.bumps.claim,
        ClaimRoute::DirectAssignment,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn direct_task() -> Task {
        let mut task = Task {
            task_type: TaskType::Exclusive,
            max_workers: 1,
            status: TaskStatus::Open,
            ..Task::default()
        };
        task.set_direct_assignment(true);
        task
    }

    #[test]
    fn direct_assignment_task_rejects_public_or_malformed_variants() {
        let task = direct_task();
        assert!(validate_direct_assignment_task(&task).is_ok());

        let err = validate_direct_assignment_task(&Task::default()).unwrap_err();
        assert_eq!(err, CoordinationError::TaskNotDirectAssignment.into());

        let mut malformed = direct_task();
        malformed.max_workers = 2;
        let err = validate_direct_assignment_task(&malformed).unwrap_err();
        assert_eq!(err, CoordinationError::InvalidDirectAssignmentTask.into());
    }

    #[test]
    fn direct_snapshot_binds_job_spec_version_and_attestor() {
        let expected_hash = [7u8; 32];
        let expected_attestor = Pubkey::new_unique();
        let spec = TaskJobSpec {
            job_spec_hash: expected_hash,
            job_spec_uri: "https://example.invalid/duel.json".to_owned(),
            updated_at: 42,
            ..TaskJobSpec::default()
        };
        let validation = TaskValidationConfig {
            mode: ValidationMode::ExternalAttestation,
            ..TaskValidationConfig::default()
        };
        let attestor = TaskAttestorConfig {
            attestor: expected_attestor,
            ..TaskAttestorConfig::default()
        };

        assert!(validate_direct_assignment_snapshot(
            &spec,
            &validation,
            &attestor,
            expected_hash,
            42,
            expected_attestor,
        )
        .is_ok());

        let stale = validate_direct_assignment_snapshot(
            &spec,
            &validation,
            &attestor,
            [8u8; 32],
            42,
            expected_attestor,
        )
        .unwrap_err();
        assert_eq!(
            stale,
            CoordinationError::StaleDirectAssignmentAcceptance.into()
        );

        let wrong_attestor = validate_direct_assignment_snapshot(
            &spec,
            &validation,
            &attestor,
            expected_hash,
            42,
            Pubkey::new_unique(),
        )
        .unwrap_err();
        assert_eq!(
            wrong_attestor,
            CoordinationError::DirectAssignmentExternalAttestationRequired.into()
        );

        let creator_review = TaskValidationConfig {
            mode: ValidationMode::CreatorReview,
            ..validation
        };
        let wrong_mode = validate_direct_assignment_snapshot(
            &spec,
            &creator_review,
            &attestor,
            expected_hash,
            42,
            expected_attestor,
        )
        .unwrap_err();
        assert_eq!(
            wrong_mode,
            CoordinationError::DirectAssignmentExternalAttestationRequired.into()
        );
    }
}
