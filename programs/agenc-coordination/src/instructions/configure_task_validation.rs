//! Configure Task Validation V2 for an existing task.

use crate::errors::CoordinationError;
use crate::events::TaskValidationConfigured;
use crate::instructions::launch_controls::require_task_type_enabled;
use crate::instructions::task_validation_helpers::{
    validate_attestor, validate_configurable_task, validate_review_window_for_mode,
    validate_task_supports_validation_mode, validate_validation_mode, validate_validator_quorum,
};
#[cfg(not(feature = "mainnet-canary"))]
use crate::state::TaskType;
use crate::state::{
    ProtocolConfig, Task, TaskAttestorConfig, TaskValidationConfig, ValidationMode,
    MANUAL_VALIDATION_SENTINEL,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ConfigureTaskValidation<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        constraint = task.creator == creator.key() @ CoordinationError::UnauthorizedTaskAction
    )]
    pub task: Account<'info, Task>,

    #[account(
        init_if_needed,
        payer = creator,
        space = TaskValidationConfig::SIZE,
        seeds = [b"task_validation", task.key().as_ref()],
        bump
    )]
    pub task_validation_config: Account<'info, TaskValidationConfig>,

    #[account(
        init_if_needed,
        payer = creator,
        space = TaskAttestorConfig::SIZE,
        seeds = [b"task_attestor", task.key().as_ref()],
        bump
    )]
    pub task_attestor_config: Account<'info, TaskAttestorConfig>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// Hire link PDA for this task. ALWAYS required — the caller passes the derived
    /// ["hire", task] address even for non-hired tasks (where it is an empty system
    /// account). If it is a live, program-owned HireRecord the task was hired from a
    /// listing, and reconfiguring it for manual validation would route settlement
    /// through accept_task_result, which does not pay the operator leg (the operator
    /// fee is only settled on the hire/complete_task path) — so the handler rejects
    /// it. Making it required (not optional) means the gate cannot be skipped.
    /// CHECK: address fixed by seeds; live-vs-absent decided by `owner` in the handler.
    #[account(
        seeds = [b"hire", task.key().as_ref()],
        bump
    )]
    pub hire_record: UncheckedAccount<'info>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<ConfigureTaskValidation>,
    mode: u8,
    review_window_secs: i64,
    validator_quorum: u8,
    attestor: Option<Pubkey>,
) -> Result<()> {
    check_version_compatible(&ctx.accounts.protocol_config)?;
    require_task_type_enabled(&ctx.accounts.protocol_config, ctx.accounts.task.task_type)?;

    // A hired task (live, program-owned HireRecord) must settle on the hire/complete_task
    // path so its operator fee is paid; reconfiguring it for manual validation would
    // route settlement through accept_task_result, which is not hire-aware and would
    // silently drop the operator's cut. Reject it. (Non-hired tasks pass the empty
    // system-owned ["hire", task] PDA and proceed.)
    // Revision 9 (D): every hire now creates its own CreatorReview config, so this
    // refusal also keeps a hire's config immutable.
    require!(
        ctx.accounts.hire_record.owner != &crate::ID,
        CoordinationError::HiredTaskValidationUnsupported
    );

    let parsed_mode = validate_validation_mode(mode)?;
    #[cfg(feature = "mainnet-canary")]
    {
        require!(
            parsed_mode == ValidationMode::CreatorReview,
            CoordinationError::InvalidValidationMode
        );
    }
    require!(
        parsed_mode != ValidationMode::Auto,
        CoordinationError::InvalidValidationMode
    );
    // Validator identities are permissionless and the VALIDATOR capability is
    // self-asserted, so a newly configured quorum cannot provide Byzantine or
    // Sybil resistance. Fail closed for new configurations in the hardened
    // binary. The validate_task_result branch remains available solely to settle
    // any legacy quorum configuration proven by deployment preflight.
    require!(
        parsed_mode != ValidationMode::ValidatorQuorum,
        CoordinationError::InvalidValidationMode
    );
    // Revision 9 (A): every reviewed single-worker task needs a working freeze.
    #[cfg(not(feature = "mainnet-canary"))]
    validate_rev9_review_mode(&ctx.accounts.task, parsed_mode)?;
    validate_review_window_for_mode(parsed_mode, review_window_secs)?;
    validate_validator_quorum(parsed_mode, validator_quorum)?;
    validate_attestor(parsed_mode, attestor)?;
    validate_configurable_task(&ctx.accounts.task)?;
    validate_task_supports_validation_mode(&ctx.accounts.task, parsed_mode)?;

    // The ValidatorQuorum / ExternalAttestation settlement path (validate_task_result)
    // pays NO referrer leg (it calls execute_completion_rewards with referrer_leg = None),
    // so configuring a referrer-bearing task for those modes would silently stiff the
    // referrer and over-pay the worker the referrer's share (audit). Only CreatorReview
    // (accept_task_result / auto_accept_task_result) honors task.referrer_fee_bps. Fail
    // closed: refuse to switch a referred task into a mode that cannot pay the leg.
    if parsed_mode != ValidationMode::CreatorReview {
        require!(
            ctx.accounts.task.referrer_fee_bps == 0,
            CoordinationError::InvalidInput
        );
    }

    let task_key = ctx.accounts.task.key();
    let task = &mut ctx.accounts.task;
    let config = &mut ctx.accounts.task_validation_config;
    let clock = Clock::get()?;

    if config.task != Pubkey::default() {
        require!(
            config.task == task_key,
            CoordinationError::TaskValidationAlreadyConfigured
        );
        require!(
            config.creator == task.creator,
            CoordinationError::UnauthorizedTaskAction
        );
    }

    config.task = task_key;
    config.creator = task.creator;
    config.mode = parsed_mode;
    config.review_window_secs = review_window_secs;
    config.set_validator_quorum(validator_quorum);
    config.set_pending_submission_count(0);
    if config.created_at == 0 {
        config.created_at = clock.unix_timestamp;
    }
    config.updated_at = clock.unix_timestamp;
    config.bump = ctx.bumps.task_validation_config;

    let attestor_config = &mut ctx.accounts.task_attestor_config;
    attestor_config.task = task_key;
    attestor_config.creator = task.creator;
    // Defense-in-depth self-attestation guard: a provided attestor must not be the task
    // creator. The worker.authority check cannot happen here (no worker is bound pre-claim);
    // it is enforced at settlement in validate_task_result's ExternalAttestation branch.
    if let Some(att) = attestor {
        require!(att != task.creator, CoordinationError::InvalidAttestor);
    }
    attestor_config.attestor = attestor.unwrap_or_default();
    if attestor_config.created_at == 0 {
        attestor_config.created_at = clock.unix_timestamp;
    }
    attestor_config.updated_at = clock.unix_timestamp;
    attestor_config.bump = ctx.bumps.task_attestor_config;

    task.constraint_hash = MANUAL_VALIDATION_SENTINEL;

    emit!(TaskValidationConfigured {
        task: task_key,
        creator: task.creator,
        mode,
        review_window_secs,
        validator_quorum,
        attestor,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

/// Revision 9 (A) closures for NEW validation configs, so every reviewed task has
/// a working freeze:
/// - ExternalAttestation closes like ValidatorQuorum: a creator-chosen attestor
///   could reject and the creator could then cancel for a free refund.
/// - CreatorReview needs a SOL reward (the freeze settles in lamports only) and a
///   task type the freeze accepts (it refuses BidExclusive). Contests and bid
///   tasks are already SOL-only, so this changes nothing for them.
///
/// Existing configs are untouched (this runs only when configuring).
#[cfg(not(feature = "mainnet-canary"))]
pub(crate) fn validate_rev9_review_mode(task: &Task, mode: ValidationMode) -> Result<()> {
    require!(
        mode != ValidationMode::ExternalAttestation,
        CoordinationError::ValidationModeClosed
    );
    if mode == ValidationMode::CreatorReview {
        require!(
            task.reward_mint.is_none() && task.task_type != TaskType::BidExclusive,
            CoordinationError::CreatorReviewUnsupportedForTask
        );
    }
    Ok(())
}

#[cfg(all(test, not(feature = "mainnet-canary")))]
mod tests {
    use super::*;

    fn code(result: Result<()>) -> u32 {
        match result {
            Err(anchor_lang::error::Error::AnchorError(e)) => e.error_code_number,
            other => panic!("expected an AnchorError, got {other:?}"),
        }
    }

    #[test]
    fn rev9_closes_attestation_and_unfreezable_creator_review() {
        let sol = Task::default();
        assert!(validate_rev9_review_mode(&sol, ValidationMode::CreatorReview).is_ok());
        assert_eq!(
            code(validate_rev9_review_mode(
                &sol,
                ValidationMode::ExternalAttestation
            )),
            u32::from(CoordinationError::ValidationModeClosed)
        );
        let token = Task {
            reward_mint: Some(Pubkey::new_unique()),
            ..Task::default()
        };
        assert_eq!(
            code(validate_rev9_review_mode(
                &token,
                ValidationMode::CreatorReview
            )),
            u32::from(CoordinationError::CreatorReviewUnsupportedForTask)
        );
        let bid = Task {
            task_type: TaskType::BidExclusive,
            ..Task::default()
        };
        assert_eq!(
            code(validate_rev9_review_mode(
                &bid,
                ValidationMode::CreatorReview
            )),
            u32::from(CoordinationError::CreatorReviewUnsupportedForTask)
        );
        // Collaborative and contest (Competitive) SOL tasks keep CreatorReview.
        for task_type in [TaskType::Collaborative, TaskType::Competitive] {
            let t = Task {
                task_type,
                ..Task::default()
            };
            assert!(validate_rev9_review_mode(&t, ValidationMode::CreatorReview).is_ok());
        }
        assert_eq!(u32::from(CoordinationError::ValidationModeClosed), 6428);
        assert_eq!(
            u32::from(CoordinationError::CreatorReviewUnsupportedForTask),
            6429
        );
    }
}
