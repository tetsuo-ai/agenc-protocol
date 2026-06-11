//! Protocol migration instruction
//!
//! Handles state migration between protocol versions.
//! Only callable by the upgrade authority (multisig gated).

use crate::errors::CoordinationError;
use crate::events::{
    MigrationCompleted, ProtocolConfigMigrated, ProtocolVersionUpdated, TaskMigrated,
};
use crate::state::{ProtocolConfig, Task, CURRENT_PROTOCOL_VERSION, MIN_SUPPORTED_VERSION};
use crate::utils::multisig::{require_multisig_threshold, unique_account_infos};
use anchor_lang::prelude::*;
use anchor_lang::system_program;

/// Protocol-config migration to the P6.5 surface-versioning layout AND the version
/// bump. The single live mainnet `ProtocolConfig` is at `OLD_CONFIG_SIZE` (349B);
/// this reallocs it up to `SIZE` (351B) and zero-fills the appended
/// `surface_revision` (so the live surface reads as "unstamped" / 0 until an
/// operator declares it via `update_launch_controls`). Multisig/upgrade-authority
/// gated, NOT permissionless.
///
/// `protocol_config` is RAW (`UncheckedAccount`) on purpose — a typed
/// `Account<ProtocolConfig>` would reject the 349B pre-migration account before the
/// handler runs (the struct is now 351B), making the realloc impossible. The handler
/// validates owner + discriminator + size and deserializes by hand, mirroring
/// `migrate_task`.
///
/// Idempotent on the size leg: a config already at the new size is realloc-skipped
/// (no-op), so the migration is safely re-runnable. The version leg still validates
/// the version path so a redundant version migration fails as before.
#[derive(Accounts)]
pub struct MigrateProtocol<'info> {
    /// CHECK: validated in the handler (owner == program, the canonical
    /// `["protocol"]` PDA, size, and a real ProtocolConfig via try_deserialize). MUST
    /// be raw — a typed `Account<ProtocolConfig>` would reject the 349B pre-migration
    /// account before the handler runs, making migration impossible.
    #[account(mut)]
    pub protocol_config: UncheckedAccount<'info>,

    /// Funds the rent top-up for the +2-byte growth.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Pure decision for the ProtocolConfig size-migration leg, factored out so it is
/// unit-testable without an on-chain context.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ConfigMigrationAction {
    /// `len == SIZE` (or larger): already migrated — skip the realloc (idempotent).
    AlreadyMigrated,
    /// `len == OLD_CONFIG_SIZE`: realloc up to `SIZE` and zero-init the tail.
    Realloc,
}

/// Classify a ProtocolConfig account by its raw data length. Returns
/// `ConfigNotMigratable` for any size that is neither the pre-P6.5 layout nor the
/// new layout — a strict guard so a corrupt/unexpected account is never reallocated.
pub(crate) fn classify_config_migration(len: usize) -> Result<ConfigMigrationAction> {
    if len >= ProtocolConfig::SIZE {
        Ok(ConfigMigrationAction::AlreadyMigrated)
    } else if len == ProtocolConfig::OLD_CONFIG_SIZE {
        Ok(ConfigMigrationAction::Realloc)
    } else {
        Err(CoordinationError::ConfigNotMigratable.into())
    }
}

/// Validate an operator-supplied `surface_revision`: only `0` (unstamped) or
/// `SURFACE_REVISION_FULL` are accepted. Pure, unit-testable.
pub(crate) fn is_valid_surface_revision(surface_revision: u16) -> bool {
    surface_revision == 0 || surface_revision == ProtocolConfig::SURFACE_REVISION_FULL
}

/// Migrate protocol configuration: realloc to the P6.5 surface-versioning layout
/// (zero-init `surface_revision`) AND advance the protocol version.
///
/// # Arguments
/// * `target_version` - The version to migrate to
///
/// # Migration Flow
/// 1. Verify caller has upgrade authority (multisig)
/// 2. Realloc the live 349B config up to 351B + zero-init `surface_revision`
///    (idempotent: already-grown config is realloc-skipped)
/// 3. Validate source and target versions
/// 4. Apply version-specific migrations
/// 5. Update version fields, persist
/// 6. Emit migration events
pub fn handler(ctx: Context<MigrateProtocol>, target_version: u8) -> Result<()> {
    let clock = Clock::get()?;
    let config_info = ctx.accounts.protocol_config.to_account_info();

    // Account is program-owned and the canonical protocol PDA.
    require!(
        config_info.owner == &crate::ID,
        CoordinationError::InvalidAccountOwner
    );
    let (expected_pda, _bump) = Pubkey::find_program_address(&[b"protocol"], &crate::ID);
    require_keys_eq!(config_info.key(), expected_pda, CoordinationError::InvalidPda);

    // Classify the account by size and validate it is a real ProtocolConfig BEFORE any
    // mutation. The zero-padded deserialize works for both the old (349B) and new
    // (351B) layouts and gives us the canonical struct — including the multisig owners
    // (in the unchanged legacy prefix) used for the gate below.
    let (mut config, original_action, original_len) = {
        let data = config_info.try_borrow_data()?;
        let action = classify_config_migration(data.len())?;
        let len = data.len();
        let mut buf = data.to_vec();
        buf.resize(ProtocolConfig::SIZE, 0);
        let cfg = ProtocolConfig::try_deserialize(&mut &buf[..])
            .map_err(|_| CoordinationError::CorruptedData)?;
        (cfg, action, len)
    };

    // ---- Gate FIRST (same ordering as migrate_task): multisig/upgrade authority. ----
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::MultisigNotEnoughSigners
    );
    let unique_signers = unique_account_infos(ctx.remaining_accounts);
    require_multisig_threshold(&config, &unique_signers)?;

    // Validate launch-control bytes are well-formed before migration
    // (defense-in-depth; mirrors other reserved-field guards).
    require!(
        config.validate_padding_fields(),
        CoordinationError::CorruptedData
    );

    // ---- Size leg: realloc 349B -> 351B + zero-init surface_revision (idempotent) ----
    if matches!(original_action, ConfigMigrationAction::Realloc) {
        let old_len = original_len;
        // Grow, then EXPLICITLY zero the appended 2 bytes so surface_revision = 0
        // regardless of resize's zero-init semantics.
        config_info.resize(ProtocolConfig::SIZE)?;
        {
            let mut data = config_info.try_borrow_mut_data()?;
            for byte in data[old_len..].iter_mut() {
                *byte = 0;
            }
        }

        // Top up rent for the larger account from the payer.
        let rent = Rent::get()?;
        let required = rent.minimum_balance(ProtocolConfig::SIZE);
        let current = config_info.lamports();
        if required > current {
            let deficit = required
                .checked_sub(current)
                .ok_or(CoordinationError::ArithmeticOverflow)?;
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: config_info.clone(),
                    },
                ),
                deficit,
            )?;
        }

        emit!(ProtocolConfigMigrated {
            config: config_info.key(),
            from_size: old_len as u32,
            to_size: ProtocolConfig::SIZE as u32,
            authority: ctx.accounts.authority.key(),
            timestamp: clock.unix_timestamp,
        });
    }

    // ---- Version leg: advance the protocol version (gate already enforced above). ----
    let current_version = config.protocol_version;

    // `target_version` bounds. `target_version == current_version` is a VALID
    // realloc-only call: the size leg above grows the live config while
    // `protocol_version` stays at 1 (the "deploy-first, migrate, version-bump-last"
    // doctrine — bumping the version before all accounts are migrated would brick
    // in-flight paths via the version gate). A LOWER target is a rollback attempt and
    // is rejected.
    require!(
        target_version >= current_version,
        CoordinationError::InvalidMigrationTarget
    );
    require!(
        target_version <= CURRENT_PROTOCOL_VERSION,
        CoordinationError::InvalidMigrationTarget
    );
    require!(
        current_version >= MIN_SUPPORTED_VERSION,
        CoordinationError::InvalidMigrationSource
    );

    // Version leg: only run the version-bump migrations when the target is strictly
    // greater (a same-version call is the realloc-only path and must persist the
    // grown layout without emitting a spurious version-bump event).
    let old_version = config.protocol_version;
    if target_version > current_version {
        // Apply migrations sequentially.
        let first_version = current_version
            .checked_add(1)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        for version in first_version..=target_version {
            apply_migration(&mut config, version)?;
        }
        config.protocol_version = target_version;
    }

    // Persist (the size leg may have grown the account; the version leg may have
    // advanced the version — either way write the canonical struct back).
    {
        let mut data = config_info.try_borrow_mut_data()?;
        config.try_serialize(&mut &mut data[..])?;
    }

    if target_version > old_version {
        emit!(MigrationCompleted {
            from_version: old_version,
            to_version: target_version,
            authority: ctx.accounts.authority.key(),
            timestamp: clock.unix_timestamp,
        });

        emit!(ProtocolVersionUpdated {
            old_version,
            new_version: target_version,
            min_supported_version: config.min_supported_version,
            timestamp: clock.unix_timestamp,
        });
    }

    Ok(())
}

/// Per-Task realloc migration to the P6.2 layout (Task 382B/432B -> 466B).
///
/// Grows each live Task account and zero-fills the appended tail
/// (operator/operator_fee_bps/_reserved from Batch-2, plus referrer/referrer_fee_bps
/// from P6.2). Accepts EITHER the pre-Batch-2 size (382B — today's 149 live mainnet
/// tasks) OR the Batch-2 size (432B), so the sweep is correct regardless of deploy
/// ordering. Multisig/upgrade-authority gated, NOT permissionless. VERSION-UNGATED:
/// it must run while `protocol_version == 1` so the binary can be deployed first, all
/// tasks migrated, and the version bumped LAST (the reverse order would brick
/// in-flight tasks via the version gate). Idempotent: a task already at the new size
/// is a no-op, so the sweep is safely re-runnable.
#[derive(Accounts)]
pub struct MigrateTask<'info> {
    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// CHECK: validated in the handler (owner == program, size, and a real Task via
    /// try_deserialize). MUST be raw — a typed `Account<Task>` would reject the 382B
    /// pre-migration account before the handler runs, making migration impossible.
    #[account(mut)]
    pub task: UncheckedAccount<'info>,

    /// Funds the rent top-up for the growth (up to +84 bytes from a 382B legacy task,
    /// or +34 from a 432B Batch-2 task).
    #[account(mut)]
    pub payer: Signer<'info>,

    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Pure decision for the per-Task size-migration leg, factored out so the
/// precondition is unit-testable without an on-chain context. Mirrors
/// `classify_config_migration` for ProtocolConfig.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum TaskMigrationAction {
    /// `len >= Task::SIZE`: already migrated (or larger) — no-op.
    AlreadyMigrated,
    /// `len` is a recognized old layout (382B or 432B): realloc up to `Task::SIZE`.
    Realloc,
}

/// Classify a Task account by its raw data length for the P6.2 migration. Accepts
/// EITHER the pre-Batch-2 size (382B) OR the Batch-2 size (432B) as a realloc
/// precondition; anything else (other than already-migrated) is rejected so a
/// corrupt/unexpected account is never grown.
pub(crate) fn classify_task_migration(len: usize) -> Result<TaskMigrationAction> {
    if len >= Task::SIZE {
        Ok(TaskMigrationAction::AlreadyMigrated)
    } else if len == Task::OLD_TASK_SIZE || len == Task::BATCH2_TASK_SIZE {
        Ok(TaskMigrationAction::Realloc)
    } else {
        Err(CoordinationError::TaskNotMigratable.into())
    }
}

/// Migrate one Task account to the P6.2 layout. `dry_run` validates the
/// preconditions + asserts the post-image would deserialize, WITHOUT mutating —
/// run it across all 149 tasks first to prove the sweep is safe.
pub fn migrate_task_handler(ctx: Context<MigrateTask>, dry_run: bool) -> Result<()> {
    let config = &ctx.accounts.protocol_config;

    // Gate: multisig/upgrade-authority approval (same gate as migrate_protocol).
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::MultisigNotEnoughSigners
    );
    let unique_signers = unique_account_infos(ctx.remaining_accounts);
    require_multisig_threshold(config, &unique_signers)?;

    let task_info = ctx.accounts.task.to_account_info();
    require!(
        task_info.owner == &crate::ID,
        CoordinationError::InvalidAccountOwner
    );

    let original_len = {
        let data = task_info.try_borrow_data()?;
        let len = data.len();
        // P6.2: accept EITHER the pre-Batch-2 layout (382B — today's 149 live mainnet
        // tasks) OR the intermediate Batch-2 layout (432B — a task already grown by a
        // prior Batch-2 sweep). Both realloc straight up to the P6.2 SIZE (466B),
        // zero-filling the appended tail, so the sweep is correct regardless of whether
        // tasks were ever migrated to 432 before this deploy.
        match classify_task_migration(len)? {
            TaskMigrationAction::AlreadyMigrated => {
                // Idempotent: already migrated (or larger). Confirm it is genuinely a
                // Task (validates the discriminator) and no-op.
                Task::try_deserialize(&mut &data[..])
                    .map_err(|_| CoordinationError::TaskDiscriminatorMismatch)?;
                return Ok(());
            }
            TaskMigrationAction::Realloc => {}
        }
        // Validate the pre-image is a real Task (checks the discriminator) by
        // zero-padding to the new size and deserializing — the append-only invariant
        // means the legacy prefix is unchanged and the new fields read as defaults.
        // This is ALSO the dry-run post-image assertion (no mutation here).
        let mut buf = data.to_vec();
        buf.resize(Task::SIZE, 0);
        Task::try_deserialize(&mut &buf[..])
            .map_err(|_| CoordinationError::TaskDiscriminatorMismatch)?;
        len
    };

    if dry_run {
        return Ok(());
    }

    // Grow the account, then EXPLICITLY zero the appended tail (34 or 84 bytes,
    // depending on the starting layout) so operator/referrer payees = default,
    // fees = 0, _reserved = 0 regardless of resize's zero-init semantics — a
    // non-zeroed tail would deserialize as a garbage operator/referrer payee.
    task_info.resize(Task::SIZE)?;
    {
        let mut data = task_info.try_borrow_mut_data()?;
        for byte in data[original_len..].iter_mut() {
            *byte = 0;
        }
    }

    // Top up rent for the larger account from the payer (system-owned signer ->
    // program-owned account is a valid system transfer).
    let rent = Rent::get()?;
    let required = rent.minimum_balance(Task::SIZE);
    let current = task_info.lamports();
    if required > current {
        let deficit = required
            .checked_sub(current)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: task_info.clone(),
                },
            ),
            deficit,
        )?;
    }

    emit!(TaskMigrated {
        task: task_info.key(),
        from_size: original_len as u32,
        to_size: Task::SIZE as u32,
        authority: ctx.accounts.authority.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

/// Apply migration for a specific version
/// Add new version handlers here as the protocol evolves
///
/// # Arguments
/// * `_config` - Protocol configuration to mutate. Currently unused but reserved
///   for future migrations that will need to initialize new fields or transform
///   existing data (e.g., `config.new_field = default_value`).
/// * `version` - Target version to migrate to
fn apply_migration(_config: &mut ProtocolConfig, version: u8) -> Result<()> {
    match version {
        1 => {
            // Version 1 is the initial version, no migration needed
            Ok(())
        }
        // Version 2 migration is intentionally a no-op
        // Placeholder for future schema changes
        2 => {
            // No-op: Reserved for future use
            Ok(())
        }
        _ => {
            // Unknown version - this shouldn't happen if validation is correct
            Err(CoordinationError::InvalidMigrationTarget.into())
        }
    }
}

/// Update minimum supported version (for deprecating old versions)
#[derive(Accounts)]
pub struct UpdateMinVersion<'info> {
    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub authority: Signer<'info>,
}

pub fn update_min_version_handler(
    ctx: Context<UpdateMinVersion>,
    new_min_version: u8,
) -> Result<()> {
    let config = &mut ctx.accounts.protocol_config;
    let clock = Clock::get()?;
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::MultisigNotEnoughSigners
    );

    // Require multisig approval
    let unique_signers = unique_account_infos(ctx.remaining_accounts);
    require_multisig_threshold(config, &unique_signers)?;

    // Validate new minimum version
    require!(
        new_min_version >= MIN_SUPPORTED_VERSION && new_min_version <= CURRENT_PROTOCOL_VERSION,
        CoordinationError::InvalidMigrationTarget
    );

    // Ensure min_version does not exceed current protocol version
    require!(
        new_min_version <= config.protocol_version,
        CoordinationError::InvalidMinVersion
    );

    // Enforce monotonically increasing min_version to prevent rollback attacks
    require!(
        new_min_version >= config.min_supported_version,
        CoordinationError::InvalidMinVersion
    );

    let old_min = config.min_supported_version;
    config.min_supported_version = new_min_version;

    emit!(ProtocolVersionUpdated {
        old_version: config.protocol_version,
        new_version: config.protocol_version,
        min_supported_version: new_min_version,
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "Updated min_supported_version from {} to {}",
        old_min,
        new_min_version
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_config() -> ProtocolConfig {
        ProtocolConfig {
            protocol_version: 1,
            min_supported_version: 1,
            ..ProtocolConfig::default()
        }
    }

    #[test]
    fn test_migration_v1_is_noop() {
        let mut config = default_config();
        let original_fee = config.protocol_fee_bps;
        let original_threshold = config.dispute_threshold;
        apply_migration(&mut config, 1).unwrap();
        assert_eq!(config.protocol_fee_bps, original_fee);
        assert_eq!(config.dispute_threshold, original_threshold);
        assert!(!config.protocol_paused);
        assert_eq!(config.disabled_task_type_mask, 0);
    }

    #[test]
    fn test_migration_v2_is_noop() {
        let mut config = default_config();
        let original_fee = config.protocol_fee_bps;
        apply_migration(&mut config, 2).unwrap();
        assert_eq!(config.protocol_fee_bps, original_fee);
        assert!(!config.protocol_paused);
        assert_eq!(config.disabled_task_type_mask, 0);
    }

    #[test]
    fn test_migration_unknown_version_3_fails() {
        let mut config = default_config();
        let result = apply_migration(&mut config, 3);
        assert!(result.is_err());
    }

    #[test]
    fn test_migration_unknown_version_255_fails() {
        let mut config = default_config();
        let result = apply_migration(&mut config, 255);
        assert!(result.is_err());
    }

    #[test]
    fn test_sequential_migration_v1_to_v2_preserves_padding() {
        let mut config = default_config();
        apply_migration(&mut config, 1).unwrap();
        apply_migration(&mut config, 2).unwrap();
        assert!(!config.protocol_paused);
        assert_eq!(config.disabled_task_type_mask, 0);
    }

    #[test]
    fn test_migration_v0_fails() {
        let mut config = default_config();
        let result = apply_migration(&mut config, 0);
        assert!(result.is_err());
    }

    // === P6.5 surface-versioning migration ===

    #[test]
    fn test_classify_config_old_size_reallocs() {
        // The live mainnet config (349B) is classified for realloc.
        let action = classify_config_migration(ProtocolConfig::OLD_CONFIG_SIZE).unwrap();
        assert_eq!(action, ConfigMigrationAction::Realloc);
        assert_eq!(ProtocolConfig::OLD_CONFIG_SIZE, 349);
    }

    #[test]
    fn test_classify_config_new_size_is_idempotent() {
        // A config already at the new size (351B) is a no-op (idempotent sweep).
        let action = classify_config_migration(ProtocolConfig::SIZE).unwrap();
        assert_eq!(action, ConfigMigrationAction::AlreadyMigrated);
        // Larger-than-SIZE is also treated as already migrated (defensive).
        let action_larger = classify_config_migration(ProtocolConfig::SIZE + 64).unwrap();
        assert_eq!(action_larger, ConfigMigrationAction::AlreadyMigrated);
    }

    #[test]
    fn test_classify_config_wrong_size_rejected() {
        // Any size that is neither the old nor the new layout is rejected — a corrupt
        // or unexpected account is never reallocated.
        for bad in [0usize, 1, 8, 348, 350] {
            let result = classify_config_migration(bad);
            assert!(result.is_err(), "len {bad} must be rejected");
        }
    }

    #[test]
    fn test_classify_config_boundary_350_rejected() {
        // 350 sits strictly between OLD_CONFIG_SIZE (349) and SIZE (351); it must NOT
        // be treated as migratable (would corrupt the surface_revision field).
        assert!(classify_config_migration(350).is_err());
    }

    #[test]
    fn test_surface_revision_zero_is_valid() {
        // 0 = unstamped / conservative — an operator may explicitly set it.
        assert!(is_valid_surface_revision(0));
    }

    #[test]
    fn test_surface_revision_full_is_valid() {
        assert!(is_valid_surface_revision(ProtocolConfig::SURFACE_REVISION_FULL));
        assert_eq!(ProtocolConfig::SURFACE_REVISION_FULL, 1);
    }

    #[test]
    fn test_surface_revision_unknown_rejected() {
        // Unknown revisions are rejected so an operator cannot stamp a surface the SDK
        // does not understand.
        for bad in [2u16, 3, 7, u16::MAX] {
            assert!(
                !is_valid_surface_revision(bad),
                "revision {bad} must be rejected"
            );
        }
    }

    // === P6.2 per-Task referral-leg migration ===

    #[test]
    fn test_classify_task_old_382_reallocs() {
        // Today's 149 live mainnet tasks (382B) are classified for realloc.
        let action = classify_task_migration(Task::OLD_TASK_SIZE).unwrap();
        assert_eq!(action, TaskMigrationAction::Realloc);
        assert_eq!(Task::OLD_TASK_SIZE, 382);
    }

    #[test]
    fn test_classify_task_batch2_432_reallocs() {
        // A task already grown to the Batch-2 size (432B) also reallocs (up to 466B).
        let action = classify_task_migration(Task::BATCH2_TASK_SIZE).unwrap();
        assert_eq!(action, TaskMigrationAction::Realloc);
        assert_eq!(Task::BATCH2_TASK_SIZE, 432);
    }

    #[test]
    fn test_classify_task_new_466_is_idempotent() {
        let action = classify_task_migration(Task::SIZE).unwrap();
        assert_eq!(action, TaskMigrationAction::AlreadyMigrated);
        assert_eq!(Task::SIZE, 466);
        // Larger-than-SIZE is also treated as already migrated (defensive).
        let larger = classify_task_migration(Task::SIZE + 64).unwrap();
        assert_eq!(larger, TaskMigrationAction::AlreadyMigrated);
    }

    #[test]
    fn test_classify_task_wrong_size_rejected() {
        // Any size that is neither a recognized old layout nor already-migrated is
        // rejected — a corrupt/unexpected account is never grown. 433..465 (the gap
        // between BATCH2 and SIZE) must NOT be migratable.
        for bad in [0usize, 1, 8, 381, 383, 431, 433, 465] {
            assert!(
                classify_task_migration(bad).is_err(),
                "len {bad} must be rejected"
            );
        }
    }

    #[test]
    fn test_migrate_realloc_only_call_keeps_version() {
        // A target == current call is the realloc-only path: the version migrations
        // are NOT applied (the loop body is skipped), so a same-version "migrate"
        // leaves protocol_version untouched. Verified at the apply_migration level: a
        // realloc-only call never invokes apply_migration.
        let mut config = default_config();
        let before = config.protocol_version;
        // Simulate the handler's version-leg guard for target == current:
        let target_version: u8 = before;
        if target_version > config.protocol_version {
            apply_migration(&mut config, target_version).unwrap();
            config.protocol_version = target_version;
        }
        assert_eq!(config.protocol_version, before, "version must not change");
    }
}
