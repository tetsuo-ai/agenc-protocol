//! Atomically stamp a reviewed mainnet release boundary.
//!
//! Off-chain preflight still proves the complete SBF and semantic IDL. This
//! instruction closes the final read-to-stamp race by locking every mutable
//! dependency in the stamp transaction and re-validating the exact reviewed
//! account images on-chain before `surface_revision` is written.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;
use solana_sha256_hasher::hash;

use crate::errors::CoordinationError;
use crate::events::ReleaseSurfaceStamped;
use crate::instructions::launch_controls::validate_disabled_task_type_mask;
use crate::instructions::moderation_gate_helpers::moderation_liveness_relaxed;
use crate::state::{BidMarketplaceConfig, ModerationConfig, ProtocolConfig};
use crate::utils::multisig::{require_multisig_threshold, unique_account_infos};

const PROGRAMDATA_METADATA_BYTES: usize = 45;
const PROGRAMDATA_VARIANT: u32 = 3;
const ANCHOR_IDL_SEED: &str = "anchor:idl";

// This log-backed marker is intentionally reachable from the production-only
// release-stamp handler so build consumers can distinguish the reviewed default
// SBF from same-program-id development feature builds. Keep all values the same
// byte length so profile mutation regressions can preserve ELF structure.
#[cfg(feature = "private-zk")]
const SBF_BUILD_PROFILE: &str = "AGENC_SBF_PROFILE=PRIVATE_ZK_V1";
#[cfg(all(not(feature = "private-zk"), feature = "validation-timings"))]
const SBF_BUILD_PROFILE: &str = "AGENC_SBF_PROFILE=VALIDATION_V1";
#[cfg(all(not(feature = "private-zk"), not(feature = "validation-timings")))]
const SBF_BUILD_PROFILE: &str = "AGENC_SBF_PROFILE=PRODUCTION_V1";

#[derive(Accounts)]
pub struct StampReleaseSurface<'info> {
    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        seeds = [b"bid_marketplace"],
        bump = bid_marketplace_config.bump
    )]
    pub bid_marketplace_config: Box<Account<'info, BidMarketplaceConfig>>,

    #[account(
        seeds = [b"moderation_config"],
        bump = moderation_config.bump
    )]
    pub moderation_config: Box<Account<'info, ModerationConfig>>,

    /// CHECK: canonical upgradeable-loader ProgramData, validated completely
    /// below before any state write. Read-only inclusion also takes the runtime
    /// account lock against a concurrent loader upgrade.
    pub program_data: UncheckedAccount<'info>,

    /// CHECK: canonical Anchor IDL address/owner/hash are validated below.
    pub anchor_idl: UncheckedAccount<'info>,

    /// CHECK: address, owner, executable bit, and full data hash are explicit
    /// reviewed arguments. Its read lock prevents a concurrent custody-policy
    /// mutation from crossing the stamp boundary.
    pub upgrade_authority_custody: UncheckedAccount<'info>,

    pub authority: Signer<'info>,
}

fn require_account_data_hash(account: &AccountInfo<'_>, expected: &[u8; 32]) -> Result<()> {
    let data = account.try_borrow_data()?;
    require!(
        hash(data.as_ref()).to_bytes() == *expected,
        CoordinationError::ReleaseBoundaryDigestMismatch
    );
    Ok(())
}

fn validate_program_data_boundary(
    data: &[u8],
    expected_slot: u64,
    expected_payload_len: u32,
    expected_upgrade_authority: &Pubkey,
    current_slot: u64,
) -> Result<()> {
    let expected_len = PROGRAMDATA_METADATA_BYTES
        .checked_add(expected_payload_len as usize)
        .ok_or_else(|| error!(CoordinationError::ReleaseBoundaryAccountMismatch))?;
    require!(
        data.len() == expected_len,
        CoordinationError::ReleaseBoundaryAccountMismatch
    );
    let variant = u32::from_le_bytes(
        data[0..4]
            .try_into()
            .map_err(|_| error!(CoordinationError::ReleaseBoundaryAccountMismatch))?,
    );
    require!(
        variant == PROGRAMDATA_VARIANT,
        CoordinationError::ReleaseBoundaryAccountMismatch
    );
    let observed_slot = u64::from_le_bytes(
        data[4..12]
            .try_into()
            .map_err(|_| error!(CoordinationError::ReleaseBoundaryAccountMismatch))?,
    );
    require!(
        observed_slot == expected_slot,
        CoordinationError::ReleaseBoundaryAccountMismatch
    );
    // A confirmed reviewed snapshot necessarily comes from a completed earlier
    // slot. Requiring a later stamp slot prevents two different upgrades in the
    // stamp slot from sharing the same loader slot marker.
    require!(
        expected_slot < current_slot,
        CoordinationError::ReleaseProgramDataNotSettled
    );
    require!(
        data[12] == 1,
        CoordinationError::ReleaseBoundaryAccountMismatch
    );
    let observed_authority = Pubkey::new_from_array(
        data[13..45]
            .try_into()
            .map_err(|_| error!(CoordinationError::ReleaseBoundaryAccountMismatch))?,
    );
    require_keys_eq!(
        observed_authority,
        *expected_upgrade_authority,
        CoordinationError::ReleaseBoundaryAccountMismatch
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<StampReleaseSurface>,
    disabled_task_type_mask: u8,
    surface_revision: u16,
    expected_protocol_config_hash: [u8; 32],
    expected_program_data_slot: u64,
    expected_program_data_payload_len: u32,
    expected_upgrade_authority: Pubkey,
    expected_bid_config_hash: [u8; 32],
    expected_moderation_config_hash: [u8; 32],
    expected_idl_account_hash: [u8; 32],
    expected_custody_address: Pubkey,
    expected_custody_owner: Pubkey,
    expected_custody_account_hash: [u8; 32],
) -> Result<()> {
    msg!(SBF_BUILD_PROFILE);
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::MultisigNotEnoughSigners
    );
    let unique_signers = unique_account_infos(ctx.remaining_accounts);
    require_multisig_threshold(&ctx.accounts.protocol_config, &unique_signers)?;

    require!(
        ctx.accounts.protocol_config.protocol_paused,
        CoordinationError::ReleaseStampRequiresPaused
    );
    validate_disabled_task_type_mask(disabled_task_type_mask)?;
    require!(
        surface_revision == ProtocolConfig::SURFACE_REVISION_CURRENT,
        CoordinationError::InvalidSurfaceRevision
    );
    require_account_data_hash(
        &ctx.accounts.protocol_config.to_account_info(),
        &expected_protocol_config_hash,
    )?;
    require_keys_eq!(
        ctx.accounts.bid_marketplace_config.authority,
        ctx.accounts.protocol_config.authority,
        CoordinationError::ReleaseBoundaryAccountMismatch
    );
    require_keys_eq!(
        ctx.accounts.moderation_config.authority,
        ctx.accounts.protocol_config.authority,
        CoordinationError::ReleaseBoundaryAccountMismatch
    );

    let clock = Clock::get()?;
    require!(
        ctx.accounts.moderation_config.updated_at > 0
            && (!ctx.accounts.moderation_config.enabled
                || !moderation_liveness_relaxed(
                    ctx.accounts.moderation_config.updated_at,
                    ctx.accounts.moderation_config.liveness_window_secs(),
                    clock.unix_timestamp,
                )),
        CoordinationError::ReleaseBoundaryAccountMismatch
    );
    require_account_data_hash(
        &ctx.accounts.bid_marketplace_config.to_account_info(),
        &expected_bid_config_hash,
    )?;
    require_account_data_hash(
        &ctx.accounts.moderation_config.to_account_info(),
        &expected_moderation_config_hash,
    )?;

    let loader = bpf_loader_upgradeable::id();
    let (canonical_program_data, _) = Pubkey::find_program_address(&[crate::ID.as_ref()], &loader);
    require_keys_eq!(
        ctx.accounts.program_data.key(),
        canonical_program_data,
        CoordinationError::ReleaseBoundaryAccountMismatch
    );
    require_keys_eq!(
        *ctx.accounts.program_data.owner,
        loader,
        CoordinationError::ReleaseBoundaryAccountMismatch
    );
    require!(
        !ctx.accounts.program_data.executable,
        CoordinationError::ReleaseBoundaryAccountMismatch
    );
    {
        let program_data = ctx.accounts.program_data.try_borrow_data()?;
        validate_program_data_boundary(
            program_data.as_ref(),
            expected_program_data_slot,
            expected_program_data_payload_len,
            &expected_upgrade_authority,
            clock.slot,
        )?;
    }

    let (idl_base, _) = Pubkey::find_program_address(&[], &crate::ID);
    let canonical_idl = Pubkey::create_with_seed(&idl_base, ANCHOR_IDL_SEED, &crate::ID)
        .map_err(|_| error!(CoordinationError::ReleaseBoundaryAccountMismatch))?;
    require_keys_eq!(
        ctx.accounts.anchor_idl.key(),
        canonical_idl,
        CoordinationError::ReleaseBoundaryAccountMismatch
    );
    require_keys_eq!(
        *ctx.accounts.anchor_idl.owner,
        crate::ID,
        CoordinationError::ReleaseBoundaryAccountMismatch
    );
    require!(
        !ctx.accounts.anchor_idl.executable,
        CoordinationError::ReleaseBoundaryAccountMismatch
    );
    require_account_data_hash(
        &ctx.accounts.anchor_idl.to_account_info(),
        &expected_idl_account_hash,
    )?;

    require_keys_eq!(
        ctx.accounts.upgrade_authority_custody.key(),
        expected_custody_address,
        CoordinationError::ReleaseBoundaryAccountMismatch
    );
    require_keys_eq!(
        *ctx.accounts.upgrade_authority_custody.owner,
        expected_custody_owner,
        CoordinationError::ReleaseBoundaryAccountMismatch
    );
    require!(
        !ctx.accounts.upgrade_authority_custody.executable,
        CoordinationError::ReleaseBoundaryAccountMismatch
    );
    require_account_data_hash(
        &ctx.accounts.upgrade_authority_custody.to_account_info(),
        &expected_custody_account_hash,
    )?;

    let config = &mut ctx.accounts.protocol_config;
    config.disabled_task_type_mask = disabled_task_type_mask;
    config.surface_revision = surface_revision;

    emit!(ReleaseSurfaceStamped {
        authority: ctx.accounts.authority.key(),
        surface_revision,
        disabled_task_type_mask,
        program_data_slot: expected_program_data_slot,
        protocol_config_hash: expected_protocol_config_hash,
        bid_config_hash: expected_bid_config_hash,
        moderation_config_hash: expected_moderation_config_hash,
        idl_account_hash: expected_idl_account_hash,
        custody_account_hash: expected_custody_account_hash,
        timestamp: clock.unix_timestamp,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn program_data(slot: u64, authority: Pubkey, payload_len: usize) -> Vec<u8> {
        let mut data = vec![0u8; PROGRAMDATA_METADATA_BYTES + payload_len];
        data[0..4].copy_from_slice(&PROGRAMDATA_VARIANT.to_le_bytes());
        data[4..12].copy_from_slice(&slot.to_le_bytes());
        data[12] = 1;
        data[13..45].copy_from_slice(authority.as_ref());
        data
    }

    #[test]
    fn program_data_boundary_requires_exact_settled_snapshot() {
        let authority = Pubkey::new_unique();
        let data = program_data(50, authority, 123);
        assert!(validate_program_data_boundary(&data, 50, 123, &authority, 51).is_ok());
        assert!(validate_program_data_boundary(&data, 49, 123, &authority, 51).is_err());
        assert!(validate_program_data_boundary(&data, 50, 122, &authority, 51).is_err());
        assert!(validate_program_data_boundary(&data, 50, 123, &authority, 50).is_err());
        assert!(
            validate_program_data_boundary(&data, 50, 123, &Pubkey::new_unique(), 51,).is_err()
        );
    }
}
