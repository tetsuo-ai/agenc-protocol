//! Attach or update a content-addressed job specification pointer for a task.

use crate::errors::CoordinationError;
use crate::events::TaskJobSpecSet;
use crate::instructions::launch_controls::require_task_type_enabled;
#[cfg(not(feature = "mainnet-canary"))]
use crate::instructions::moderation_gate_helpers::{
    load_task_moderation_record, moderation_gate_relaxed, require_content_not_blocked,
};
#[cfg(not(feature = "mainnet-canary"))]
use crate::state::ModerationAttestor;
use crate::state::{
    is_publishable_task_moderation_status, ModerationConfig, ProtocolConfig, Task, TaskJobSpec,
    TaskModeration, TaskStatus, HASH_SIZE, TASK_JOB_SPEC_URI_MAX_LEN,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[cfg_attr(
    not(feature = "mainnet-canary"),
    instruction(job_spec_hash: [u8; HASH_SIZE], job_spec_uri: String, moderator: Pubkey)
)]
#[cfg_attr(feature = "mainnet-canary", instruction(job_spec_hash: [u8; HASH_SIZE]))]
pub struct SetTaskJobSpec<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        constraint = task.creator == creator.key() @ CoordinationError::UnauthorizedTaskAction
    )]
    pub task: Account<'info, Task>,

    #[account(
        seeds = [b"moderation_config"],
        bump = moderation_config.bump
    )]
    pub moderation_config: Account<'info, ModerationConfig>,

    /// P1.2 §4.4 — the v2-else-legacy moderation record slot. The v2 seed carries the
    /// moderator INSIDE the primary record's derivation (circular for Anchor's
    /// declarative seeds), so this arrives unchecked and the handler re-implements
    /// every dropped constraint via `load_task_moderation_record`: canonical PDA
    /// (v2 first, frozen-legacy fallback), `owner == crate::ID`, discriminator, and
    /// the task/creator/hash/moderator bindings. A wrong-seed account fails CLOSED.
    ///
    /// CHECK: validated in the handler by `load_task_moderation_record` (canonical
    /// v2/legacy PDA + owner + discriminator + field bindings).
    #[cfg(not(feature = "mainnet-canary"))]
    pub task_moderation: UncheckedAccount<'info>,

    /// Canary build: the FROZEN pre-P1.2 declarative constraints (legacy seed).
    #[cfg(feature = "mainnet-canary")]
    #[account(
        seeds = [b"task_moderation", task.key().as_ref(), job_spec_hash.as_ref()],
        bump = task_moderation.bump,
        constraint = task_moderation.task == task.key()
            @ CoordinationError::TaskModerationTaskMismatch,
        constraint = task_moderation.creator == task.creator
            @ CoordinationError::TaskModerationTaskMismatch,
        constraint = task_moderation.job_spec_hash == job_spec_hash
            @ CoordinationError::TaskModerationHashMismatch
    )]
    pub task_moderation: Account<'info, TaskModeration>,

    /// OPTIONAL: a registered moderation-attestor roster entry that unlocks the
    /// publish gate when the moderation was authored by a non-global-authority
    /// attestor. P1.2: bound by seeds to the EXPLICIT `moderator` instruction argument
    /// (the caller chooses which attestor's verdict it consumes — §4.4), with
    /// `attestor == moderator`, so Anchor enforces the canonical roster PDA. A forged
    /// or mismatched entry fails account resolution; a REVOKED attestor's PDA is
    /// closed and fails to load (fail-closed, the WP-A1 property this refactor must
    /// not regress). Only needed when `moderator != moderation_authority`; the global
    /// authority path passes with this absent (`None`). Full-surface only.
    #[cfg(not(feature = "mainnet-canary"))]
    #[account(
        seeds = [b"moderation_attestor", moderator.as_ref()],
        bump = moderation_attestor.bump,
        constraint = moderation_attestor.attestor == moderator
            @ CoordinationError::ModerationAttestorMismatch
    )]
    pub moderation_attestor: Option<Box<Account<'info, ModerationAttestor>>>,

    /// P1.2 §5.2 — the REQUIRED BLOCK-floor slot. The handler derives
    /// `["moderation_block", job_spec_hash]` itself and rejects a mismatched address,
    /// so the caller can neither omit nor substitute it; a multisig-BLOCKED hash
    /// hard-rejects regardless of which CLEAN attestor is presented.
    ///
    /// CHECK: validated in the handler by `require_content_not_blocked`
    /// (handler-derived canonical PDA; system-owned/empty = pass).
    #[cfg(not(feature = "mainnet-canary"))]
    pub moderation_block: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = creator,
        space = TaskJobSpec::SIZE,
        seeds = [b"task_job_spec", task.key().as_ref()],
        bump
    )]
    pub task_job_spec: Account<'info, TaskJobSpec>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Full-surface handler (P1.2 §4.4): takes the EXPLICIT `moderator` argument — the
/// risk-bearing caller chooses which attestor's verdict it consumes, and the tx
/// permanently records whose attestation was relied on.
#[cfg(not(feature = "mainnet-canary"))]
pub fn handler(
    ctx: Context<SetTaskJobSpec>,
    job_spec_hash: [u8; HASH_SIZE],
    job_spec_uri: String,
    moderator: Pubkey,
) -> Result<()> {
    validate_task_job_spec_inputs(&job_spec_hash, &job_spec_uri)?;
    check_version_compatible(&ctx.accounts.protocol_config)?;

    let clock = Clock::get()?;
    let task_key = ctx.accounts.task.key();
    let task = &ctx.accounts.task;
    require_task_type_enabled(&ctx.accounts.protocol_config, task.task_type)?;
    validate_task_job_spec_mutable(task)?;

    // §5.2 BLOCK floor first: a multisig takedown hard-rejects the hash regardless of
    // any CLEAN attestation presented below. Handler-derived — cannot be skipped.
    require_content_not_blocked(
        &ctx.accounts.moderation_block.to_account_info(),
        &job_spec_hash,
    )?;

    // P1.3 liveness deadman (batch-2 A2, docs/MODERATION_LIVENESS.md): when the
    // moderation authority has been silent past the liveness window, the ALLOW
    // gate relaxes to moderation-optional — the record slot may be an empty PDA
    // and no attestation is required. The BLOCK floor above already ran and is
    // NEVER relaxed. A heartbeat instantly re-arms the strict path.
    let relaxed = moderation_gate_relaxed(&ctx.accounts.moderation_config, clock.unix_timestamp);

    // Roster path: the attestor entry is Anchor-bound to ["moderation_attestor",
    // moderator]. A revoked attestor's PDA is closed and fails to load (fail-closed,
    // unchanged from WP-A1); an EXITING attestor no longer unlocks — the window
    // closes at request, not finalize (§4.2).
    let unlocking_attestor: Option<Pubkey> = ctx
        .accounts
        .moderation_attestor
        .as_ref()
        .map(|entry| entry.attestor);
    if let Some(entry) = ctx.accounts.moderation_attestor.as_ref() {
        require!(!entry.is_exiting(), CoordinationError::AttestorExiting);
    }

    if !relaxed {
        // §4.4 v2-else-legacy record load: canonical PDA, owner, discriminator and
        // task/creator/hash/moderator bindings all re-checked manually.
        let record = load_task_moderation_record(
            &ctx.accounts.task_moderation.to_account_info(),
            &task_key,
            &task.creator,
            &job_spec_hash,
            &moderator,
        )?;

        validate_task_moderation_for_job_spec(
            &ctx.accounts.moderation_config,
            &record,
            task_key,
            task,
            &job_spec_hash,
            clock.unix_timestamp,
            unlocking_attestor.is_some(),
        )?;
    }

    let task_creator = task.creator;
    write_job_spec(
        &mut ctx.accounts.task_job_spec,
        ctx.bumps.task_job_spec,
        task_key,
        task_creator,
        job_spec_hash,
        job_spec_uri,
        unlocking_attestor,
        clock.unix_timestamp,
    )
}

/// Canary handler: the FROZEN pre-P1.2 surface (declaratively-bound legacy record,
/// no moderator argument, no attestor, no BLOCK floor).
#[cfg(feature = "mainnet-canary")]
pub fn handler(
    ctx: Context<SetTaskJobSpec>,
    job_spec_hash: [u8; HASH_SIZE],
    job_spec_uri: String,
) -> Result<()> {
    validate_task_job_spec_inputs(&job_spec_hash, &job_spec_uri)?;
    check_version_compatible(&ctx.accounts.protocol_config)?;

    let clock = Clock::get()?;
    let task_key = ctx.accounts.task.key();
    let task = &ctx.accounts.task;
    require_task_type_enabled(&ctx.accounts.protocol_config, task.task_type)?;
    validate_task_job_spec_mutable(task)?;

    validate_task_moderation_for_job_spec(
        &ctx.accounts.moderation_config,
        &ctx.accounts.task_moderation,
        task_key,
        task,
        &job_spec_hash,
        clock.unix_timestamp,
        false,
    )?;

    let task_creator = task.creator;
    write_job_spec(
        &mut ctx.accounts.task_job_spec,
        ctx.bumps.task_job_spec,
        task_key,
        task_creator,
        job_spec_hash,
        job_spec_uri,
        None,
        clock.unix_timestamp,
    )
}

/// Shared write tail: idempotency guards, field writes, event.
#[allow(clippy::too_many_arguments)]
fn write_job_spec(
    task_job_spec: &mut TaskJobSpec,
    bump: u8,
    task_key: Pubkey,
    task_creator: Pubkey,
    job_spec_hash: [u8; HASH_SIZE],
    job_spec_uri: String,
    unlocking_attestor: Option<Pubkey>,
    now: i64,
) -> Result<()> {
    if task_job_spec.task != Pubkey::default() {
        require!(
            task_job_spec.task == task_key,
            CoordinationError::TaskJobSpecTaskMismatch
        );
        require!(
            task_job_spec.creator == task_creator,
            CoordinationError::UnauthorizedTaskAction
        );
    }

    task_job_spec.task = task_key;
    task_job_spec.creator = task_creator;
    task_job_spec.job_spec_hash = job_spec_hash;
    task_job_spec.job_spec_uri = job_spec_uri.clone();
    if task_job_spec.created_at == 0 {
        task_job_spec.created_at = now;
    }
    task_job_spec.updated_at = now;
    task_job_spec.bump = bump;

    emit!(TaskJobSpecSet {
        task: task_key,
        creator: task_creator,
        job_spec_hash,
        job_spec_uri,
        moderation_attestor: unlocking_attestor,
        timestamp: now,
    });

    Ok(())
}

pub fn validate_task_job_spec_mutable(task: &Task) -> Result<()> {
    require!(
        task.status == TaskStatus::Open && task.current_workers == 0 && task.completions == 0,
        CoordinationError::TaskValidationImmutableAfterClaim
    );

    Ok(())
}

pub fn validate_task_job_spec_inputs(
    job_spec_hash: &[u8; HASH_SIZE],
    job_spec_uri: &str,
) -> Result<()> {
    require!(
        job_spec_hash.iter().any(|byte| *byte != 0),
        CoordinationError::InvalidTaskJobSpecHash
    );
    require!(
        !job_spec_uri.trim().is_empty(),
        CoordinationError::InvalidTaskJobSpecUri
    );
    require!(
        job_spec_uri.len() <= TASK_JOB_SPEC_URI_MAX_LEN,
        CoordinationError::InvalidTaskJobSpecUri
    );

    Ok(())
}

/// Validate a task-level moderation attestation at job-spec publish time.
///
/// WP-A1: the attestation's `moderator` is accepted when it is EITHER the global
/// `ModerationConfig.moderation_authority` OR a registered, non-revoked
/// `ModerationAttestor` (signalled by `attestor_supplied`). `attestor_supplied` is `true`
/// only when the caller passed a `ModerationAttestor` PDA that Anchor already validated by
/// canonical seeds off `task_moderation.moderator` AND `attestor == task_moderation.moderator`
/// — so this helper does not re-derive that binding; presence is proof. A revoked attestor
/// cannot reach here with `attestor_supplied == true` because its PDA is closed and fails to
/// load at account resolution. All other attestation checks (task/creator/hash binding,
/// publishable status, risk score, expiry) are unchanged, so a roster attestor can only
/// unlock a genuinely publishable, correctly-bound attestation.
pub fn validate_task_moderation_for_job_spec(
    moderation_config: &ModerationConfig,
    task_moderation: &TaskModeration,
    task_key: Pubkey,
    task: &Task,
    job_spec_hash: &[u8; HASH_SIZE],
    now: i64,
    attestor_supplied: bool,
) -> Result<()> {
    require!(
        moderation_config.enabled,
        CoordinationError::TaskModerationRequired
    );
    require!(
        moderation_config.moderation_authority != Pubkey::default(),
        CoordinationError::InvalidTaskModerationAuthority
    );
    require!(
        task_moderation.moderator == moderation_config.moderation_authority || attestor_supplied,
        CoordinationError::UnauthorizedTaskModerator
    );
    require!(
        task_moderation.task == task_key,
        CoordinationError::TaskModerationTaskMismatch
    );
    require!(
        task_moderation.creator == task.creator,
        CoordinationError::TaskModerationTaskMismatch
    );
    require!(
        task_moderation.job_spec_hash == *job_spec_hash,
        CoordinationError::TaskModerationHashMismatch
    );
    require!(
        is_publishable_task_moderation_status(task_moderation.status),
        CoordinationError::TaskModerationRejected
    );
    require!(
        task_moderation.risk_score <= crate::state::TASK_MODERATION_RISK_SCORE_MAX,
        CoordinationError::InvalidTaskModerationRiskScore
    );
    require!(
        task_moderation.expires_at == 0 || task_moderation.expires_at >= now,
        CoordinationError::TaskModerationExpired
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::task_moderation_status;

    #[test]
    fn validates_non_empty_hash_and_uri() {
        let mut hash = [0u8; HASH_SIZE];
        hash[0] = 1;

        assert!(validate_task_job_spec_inputs(&hash, "agenc://job-spec/sha256/abc").is_ok());
    }

    #[test]
    fn rejects_zero_hash() {
        let err = validate_task_job_spec_inputs(&[0u8; HASH_SIZE], "agenc://job-spec/sha256/abc")
            .unwrap_err();

        assert_eq!(err, CoordinationError::InvalidTaskJobSpecHash.into());
    }

    #[test]
    fn rejects_empty_uri() {
        let mut hash = [0u8; HASH_SIZE];
        hash[0] = 1;
        let err = validate_task_job_spec_inputs(&hash, " \t ").unwrap_err();

        assert_eq!(err, CoordinationError::InvalidTaskJobSpecUri.into());
    }

    #[test]
    fn rejects_oversized_uri() {
        let mut hash = [0u8; HASH_SIZE];
        hash[0] = 1;
        let uri = "a".repeat(TASK_JOB_SPEC_URI_MAX_LEN + 1);
        let err = validate_task_job_spec_inputs(&hash, &uri).unwrap_err();

        assert_eq!(err, CoordinationError::InvalidTaskJobSpecUri.into());
    }

    #[test]
    fn allows_job_spec_mutation_before_work_starts() {
        let task = Task {
            status: TaskStatus::Open,
            current_workers: 0,
            completions: 0,
            ..Task::default()
        };

        assert!(validate_task_job_spec_mutable(&task).is_ok());
    }

    #[test]
    fn rejects_job_spec_mutation_after_claim() {
        let task = Task {
            status: TaskStatus::InProgress,
            current_workers: 1,
            completions: 0,
            ..Task::default()
        };
        let err = validate_task_job_spec_mutable(&task).unwrap_err();

        assert_eq!(
            err,
            CoordinationError::TaskValidationImmutableAfterClaim.into()
        );
    }

    #[test]
    fn rejects_job_spec_mutation_after_completion_recorded() {
        let task = Task {
            status: TaskStatus::Open,
            current_workers: 0,
            completions: 1,
            ..Task::default()
        };
        let err = validate_task_job_spec_mutable(&task).unwrap_err();

        assert_eq!(
            err,
            CoordinationError::TaskValidationImmutableAfterClaim.into()
        );
    }

    #[test]
    fn rejects_job_spec_mutation_in_terminal_or_disputed_states() {
        for status in [
            TaskStatus::PendingValidation,
            TaskStatus::Completed,
            TaskStatus::Cancelled,
            TaskStatus::Disputed,
        ] {
            let task = Task {
                status,
                current_workers: 0,
                completions: 0,
                ..Task::default()
            };
            let err = validate_task_job_spec_mutable(&task).unwrap_err();

            assert_eq!(
                err,
                CoordinationError::TaskValidationImmutableAfterClaim.into()
            );
        }
    }

    fn moderation_case(
        status: u8,
        expires_at: i64,
    ) -> (
        ModerationConfig,
        TaskModeration,
        Pubkey,
        Task,
        [u8; HASH_SIZE],
    ) {
        let moderation_authority = Pubkey::new_unique();
        let task_key = Pubkey::new_unique();
        let creator = Pubkey::new_unique();
        let mut hash = [0u8; HASH_SIZE];
        hash[0] = 1;

        (
            ModerationConfig {
                moderation_authority,
                enabled: true,
                ..ModerationConfig::default()
            },
            TaskModeration {
                task: task_key,
                creator,
                job_spec_hash: hash,
                status,
                risk_score: 0,
                expires_at,
                moderator: moderation_authority,
                ..TaskModeration::default()
            },
            task_key,
            Task {
                creator,
                ..Task::default()
            },
            hash,
        )
    }

    #[test]
    fn allows_clean_or_human_approved_moderation() {
        for status in [
            task_moderation_status::CLEAN,
            task_moderation_status::HUMAN_APPROVED,
        ] {
            let (config, moderation, task_key, task, hash) = moderation_case(status, 0);

            assert!(validate_task_moderation_for_job_spec(
                &config,
                &moderation,
                task_key,
                &task,
                &hash,
                100,
                false,
            )
            .is_ok());
        }
    }

    // WP-A1 revert-sensitive: a registered attestor (moderator != global authority) unlocks
    // the publish gate. Against the pre-fix predicate (`moderator == authority`) this errors,
    // turning the test red.
    #[test]
    fn allows_registered_roster_attestor_moderator() {
        let (mut config, mut moderation, task_key, task, hash) =
            moderation_case(task_moderation_status::CLEAN, 0);
        // The attestation was authored by a roster attestor, NOT the global authority.
        config.moderation_authority = Pubkey::new_unique();
        moderation.moderator = Pubkey::new_unique();
        assert_ne!(moderation.moderator, config.moderation_authority);

        assert!(validate_task_moderation_for_job_spec(
            &config,
            &moderation,
            task_key,
            &task,
            &hash,
            100,
            true, // a valid ModerationAttestor roster entry was supplied
        )
        .is_ok());
    }

    // WP-A1 fail-closed guard: a non-authority moderator WITHOUT a roster entry is rejected
    // (the gate never fails open).
    #[test]
    fn rejects_non_authority_moderator_without_attestor() {
        let (mut config, mut moderation, task_key, task, hash) =
            moderation_case(task_moderation_status::CLEAN, 0);
        config.moderation_authority = Pubkey::new_unique();
        moderation.moderator = Pubkey::new_unique();

        let err = validate_task_moderation_for_job_spec(
            &config, &moderation, task_key, &task, &hash, 100, false,
        )
        .unwrap_err();

        assert_eq!(err, CoordinationError::UnauthorizedTaskModerator.into());
    }

    // WP-A1: a supplied roster entry does NOT bypass the other attestation invariants — a
    // blocked status still fails even for a roster attestor.
    #[test]
    fn roster_attestor_cannot_publish_blocked_status() {
        let (mut config, mut moderation, task_key, task, hash) =
            moderation_case(task_moderation_status::BLOCKED, 0);
        config.moderation_authority = Pubkey::new_unique();
        moderation.moderator = Pubkey::new_unique();

        let err = validate_task_moderation_for_job_spec(
            &config, &moderation, task_key, &task, &hash, 100, true,
        )
        .unwrap_err();

        assert_eq!(err, CoordinationError::TaskModerationRejected.into());
    }

    #[test]
    fn rejects_blocked_or_suspicious_moderation() {
        for status in [
            task_moderation_status::SUSPICIOUS,
            task_moderation_status::BLOCKED,
            task_moderation_status::SCANNER_UNAVAILABLE,
            task_moderation_status::HUMAN_REJECTED,
        ] {
            let (config, moderation, task_key, task, hash) = moderation_case(status, 0);
            let err = validate_task_moderation_for_job_spec(
                &config,
                &moderation,
                task_key,
                &task,
                &hash,
                100,
                false,
            )
            .unwrap_err();

            assert_eq!(err, CoordinationError::TaskModerationRejected.into());
        }
    }

    #[test]
    fn rejects_expired_moderation() {
        let (config, moderation, task_key, task, hash) =
            moderation_case(task_moderation_status::CLEAN, 99);
        let err = validate_task_moderation_for_job_spec(
            &config,
            &moderation,
            task_key,
            &task,
            &hash,
            100,
            false,
        )
        .unwrap_err();

        assert_eq!(err, CoordinationError::TaskModerationExpired.into());
    }
}
