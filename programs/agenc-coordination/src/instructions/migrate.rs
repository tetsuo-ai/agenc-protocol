//! Protocol migration instruction
//!
//! Handles state migration between protocol versions.
//! Only callable by the upgrade authority (multisig gated).

use crate::errors::CoordinationError;
use crate::events::{MigrationCompleted, ProtocolVersionUpdated, TaskMigrated};
use crate::state::{ProtocolConfig, Task, CURRENT_PROTOCOL_VERSION, MIN_SUPPORTED_VERSION};
use crate::utils::multisig::{require_multisig_threshold, unique_account_infos};
use anchor_lang::prelude::*;
use anchor_lang::system_program;

#[derive(Accounts)]
pub struct MigrateProtocol<'info> {
    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub authority: Signer<'info>,
}

/// Migrate protocol configuration to a new version
/// This instruction handles state changes required when upgrading the program
///
/// # Arguments
/// * `target_version` - The version to migrate to
///
/// # Migration Flow
/// 1. Verify caller has upgrade authority (multisig)
/// 2. Validate source and target versions
/// 3. Apply version-specific migrations
/// 4. Update version fields
/// 5. Emit migration event
pub fn handler(ctx: Context<MigrateProtocol>, target_version: u8) -> Result<()> {
    let config = &mut ctx.accounts.protocol_config;
    let clock = Clock::get()?;
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::MultisigNotEnoughSigners
    );

    // Require multisig approval for migrations
    let unique_signers = unique_account_infos(ctx.remaining_accounts);
    require_multisig_threshold(config, &unique_signers)?;

    // Validate reserved fields are zeroed before migration (defense-in-depth).
    // If padding contains non-zero data, the account may be corrupted or
    // a previous migration wrote unexpected data.
    require!(
        config.validate_padding_fields(),
        CoordinationError::CorruptedData
    );

    let current_version = config.protocol_version;

    // Validate migration path
    require!(
        target_version > current_version,
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

    // Apply migrations sequentially
    let first_version = current_version
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    for version in first_version..=target_version {
        apply_migration(config, version)?;
    }

    // Update version
    let old_version = config.protocol_version;
    config.protocol_version = target_version;

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

    Ok(())
}

/// Per-Task realloc migration to the Batch-2 layout (Task 382B -> 432B).
///
/// Grows each of the 149 live Task accounts and zero-fills the appended
/// operator/operator_fee_bps/_reserved tail. Multisig/upgrade-authority gated, NOT
/// permissionless. VERSION-UNGATED: it must run while `protocol_version == 1` so the
/// binary can be deployed first, all tasks migrated, and the version bumped LAST
/// (the reverse order would brick in-flight tasks via the version gate). Idempotent:
/// a task already at the new size is a no-op, so the sweep is safely re-runnable.
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

    /// Funds the rent top-up for the +50-byte growth.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Migrate one Task account to the Batch-2 layout. `dry_run` validates the
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
        if len >= Task::SIZE {
            // Idempotent: already migrated (or larger). Confirm it is genuinely a Task
            // (validates the discriminator) and no-op.
            Task::try_deserialize(&mut &data[..])
                .map_err(|_| CoordinationError::TaskDiscriminatorMismatch)?;
            return Ok(());
        }
        require!(
            len == Task::OLD_TASK_SIZE,
            CoordinationError::TaskNotMigratable
        );
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

    // Grow the account, then EXPLICITLY zero the appended 50 bytes so
    // operator=default / fee=0 / _reserved=0 regardless of resize's zero-init
    // semantics — a non-zeroed tail would deserialize as a garbage operator payee.
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
}
