//! Initialize protocol configuration
//!
//! # Parameters
//!
//! - `dispute_threshold`: Approval-percentage threshold used when terminal dispute
//!   outcomes are interpreted by slash finalizers. Must be in range 1-99 (inclusive).
//!   Current resolver rulings are stored as binary 100%/0% outcomes; historical
//!   disputes may contain vote totals under the retired arbiter model.
//! - `protocol_fee_bps`: Fee charged on task completions in basis points (max 2000 = 20%).
//! - `min_stake`: Minimum stake required for agent registration. It also initializes
//!   the historically named `min_arbiter_stake` governance weight basis.
//! - `min_stake_for_dispute`: Minimum stake required to initiate a dispute (at least 1,000 lamports).
//! - `multisig_threshold`: Number of signatures required for multisig operations.
//! - `multisig_owners`: List of authorized multisig signers.

use crate::errors::CoordinationError;
use crate::events::ProtocolInitialized;
use crate::instructions::constants::{
    DEFAULT_DISPUTE_INITIATION_COOLDOWN, DEFAULT_MAX_DISPUTES_PER_24H, DEFAULT_MAX_TASKS_PER_24H,
    DEFAULT_TASK_CREATION_COOLDOWN, MAX_PROTOCOL_FEE_BPS,
};
use crate::instructions::rate_limit_helpers::is_valid_dispute_stake_limit;
use crate::state::{ProtocolConfig, CURRENT_PROTOCOL_VERSION, MIN_SUPPORTED_VERSION};
use crate::utils::multisig::validate_multisig_owners;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(
        init,
        payer = authority,
        space = ProtocolConfig::SIZE,
        seeds = [b"protocol"],
        bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// Treasury account to receive protocol fees. Production clients must request
    /// the custody key's signature in generated account metas.
    #[cfg(not(feature = "mainnet-canary"))]
    pub treasury: Signer<'info>,

    /// CHECK: The frozen canary IDL historically marks treasury as a non-signer.
    /// The handler still requires this account to be a system-owned signer, so
    /// transactions must explicitly promote the meta and provide its signature.
    #[cfg(feature = "mainnet-canary")]
    pub treasury: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    /// Second multisig signer required at initialization to prevent single-party setup.
    /// Must be different from authority and must be in multisig_owners.
    /// This ensures at least two parties are involved in protocol initialization (fix #556).
    pub second_signer: Signer<'info>,

    pub system_program: Program<'info, System>,
    // NOTE: remaining_accounts[0] must be the program's ProgramData account (fix #839).
    // Validated in handler: PDA derivation + owner check + upgrade authority match.
}

/// Minimum reasonable stake value (0.001 SOL in lamports)
const MIN_REASONABLE_STAKE: u64 = 1_000_000;

/// `UpgradeableLoaderState::ProgramData`'s stable bincode enum discriminant.
///
/// The upgradeable loader stores this little-endian `u32` before the slot and
/// upgrade-authority fields. Checking the owner and canonical PDA alone is not
/// sufficient before interpreting bytes at the ProgramData offsets: a different
/// loader-state variant must fail closed instead of being parsed as ProgramData.
const PROGRAM_DATA_STATE_TAG: u32 = 3;

/// Initialize the protocol configuration with the given parameters.
///
/// # Arguments
///
/// * `dispute_threshold` - Approval-percentage threshold used by terminal dispute
///   slash finalizers. Valid range: 1-99 (inclusive). Current resolver rulings encode
///   approved/rejected as 100%/0%; historical disputes may contain vote totals.
/// * `protocol_fee_bps` - Protocol fee in basis points (0-2000, where 2000 = 20%).
/// * `min_stake` - Minimum agent-registration stake and governance weight basis
///   (must be >= 0.001 SOL).
/// * `min_stake_for_dispute` - Minimum stake required to initiate a dispute (at least 1,000 lamports).
/// * `multisig_threshold` - Number of signatures required for multisig operations.
/// * `multisig_owners` - List of authorized multisig signers.
///
/// # Errors
///
/// Returns [`CoordinationError::InvalidDisputeThreshold`] if dispute_threshold is 0 or >= 100.
/// Returns [`CoordinationError::InvalidMinStake`] below the dispute anti-spam floor.
pub fn handler(
    ctx: Context<InitializeProtocol>,
    dispute_threshold: u8,
    protocol_fee_bps: u16,
    min_stake: u64,
    min_stake_for_dispute: u64,
    multisig_threshold: u8,
    multisig_owners: Vec<Pubkey>,
) -> Result<()> {
    require!(
        ctx.accounts.protocol_config.authority == Pubkey::default(),
        CoordinationError::ProtocolAlreadyInitialized
    );
    // Verify the caller is the program's upgrade authority (fix #839)
    // The ProgramData account must be passed as remaining_accounts[0]
    let program_data_info = ctx
        .remaining_accounts
        .first()
        .ok_or(CoordinationError::UnauthorizedUpgrade)?;

    // Verify the ProgramData PDA matches: findProgramAddress([program_id], bpf_loader_upgradeable)
    let (expected_program_data, _) =
        Pubkey::find_program_address(&[crate::ID.as_ref()], &bpf_loader_upgradeable::id());
    require!(
        program_data_info.key() == expected_program_data,
        CoordinationError::UnauthorizedUpgrade
    );

    // Verify the account is owned by BPF Loader Upgradeable
    require!(
        program_data_info.owner == &bpf_loader_upgradeable::id(),
        CoordinationError::InvalidAccountOwner
    );

    // Deserialize ProgramData and verify upgrade authority matches signer.
    let data = program_data_info.try_borrow_data()?;
    // ProgramData layout: 4 bytes (enum tag) + 8 bytes (slot) + 1 byte
    // (option tag) + 32 bytes (authority). Validate the loader-state variant
    // before interpreting the variant-specific offsets below.
    require!(data.len() >= 45, CoordinationError::CorruptedData);
    let state_tag = u32::from_le_bytes(
        data[0..4]
            .try_into()
            .map_err(|_| error!(CoordinationError::CorruptedData))?,
    );
    require!(
        state_tag == PROGRAM_DATA_STATE_TAG,
        CoordinationError::CorruptedData
    );
    let has_authority = data[12];
    require!(has_authority == 1, CoordinationError::UnauthorizedUpgrade); // Must have upgrade authority
    let authority_bytes: [u8; 32] = data[13..45]
        .try_into()
        .map_err(|_| error!(CoordinationError::CorruptedData))?;
    let upgrade_authority = Pubkey::new_from_array(authority_bytes);
    require!(
        upgrade_authority == ctx.accounts.authority.key(),
        CoordinationError::UnauthorizedUpgrade
    );
    drop(data);

    // Runtime multisig validation accepts only system-owned signer wallets. Apply
    // the same rule at bootstrap so a PDA signer cannot help initialize a
    // threshold that no permitted runtime signer set can ever satisfy.
    require!(
        ctx.accounts.authority.owner == &anchor_lang::system_program::ID
            && ctx.accounts.second_signer.owner == &anchor_lang::system_program::ID,
        CoordinationError::MultisigInvalidSigners
    );

    // Preserve the deployed threshold domain: 1-99 inclusive.
    require!(
        dispute_threshold > 0 && dispute_threshold < 100,
        CoordinationError::InvalidDisputeThreshold
    );
    require!(
        protocol_fee_bps <= MAX_PROTOCOL_FEE_BPS,
        CoordinationError::InvalidProtocolFee
    );
    // Ensure minimum stake is sensible (fixes #586)
    require!(
        min_stake >= MIN_REASONABLE_STAKE,
        CoordinationError::StakeTooLow
    );
    // Match every post-init mutation path: a fresh deployment must neither begin
    // below the anti-spam floor nor set a value that excludes every minimally
    // registered worker from dispute access.
    require!(
        is_valid_dispute_stake_limit(min_stake_for_dispute, min_stake),
        CoordinationError::InvalidMinStake
    );
    require!(
        !multisig_owners.is_empty(),
        CoordinationError::MultisigInvalidSigners
    );
    require!(
        multisig_owners.len() <= ProtocolConfig::MAX_MULTISIG_OWNERS,
        CoordinationError::MultisigInvalidSigners
    );
    require!(
        // Fix #505: Require threshold < owners count to ensure protocol remains
        // operational even if one key is lost. This prevents lockout scenarios.
        multisig_threshold >= 2 && (multisig_threshold as usize) < multisig_owners.len(),
        CoordinationError::MultisigInvalidThreshold
    );

    // Validate multisig owners BEFORE writing config (fix #61)
    validate_multisig_owners(&multisig_owners)?;

    // Fix #556: Require second_signer to be different from authority
    // This prevents a single party from initializing the protocol alone
    require!(
        ctx.accounts.authority.key() != ctx.accounts.second_signer.key(),
        CoordinationError::MultisigDuplicateSigner
    );

    // Both authority and second_signer must be in multisig_owners
    require!(
        multisig_owners.contains(&ctx.accounts.authority.key()),
        CoordinationError::MultisigInvalidSigners
    );
    require!(
        multisig_owners.contains(&ctx.accounts.second_signer.key()),
        CoordinationError::MultisigInvalidSigners
    );

    // Count signers: authority + second_signer + any additional in remaining_accounts
    let mut valid_signers = 2usize; // authority and second_signer are always counted

    // Fix #822: Track counted keys to prevent duplicate signer entries from inflating the count
    let mut counted_keys = std::collections::BTreeSet::new();
    counted_keys.insert(ctx.accounts.authority.key());
    counted_keys.insert(ctx.accounts.second_signer.key());

    // Add any additional signers from remaining_accounts (skip [0] which is ProgramData)
    for acc in ctx.remaining_accounts.iter().skip(1) {
        // Fix #840: Match require_multisig validation — only system-owned accounts
        // can be valid multisig signers. This prevents PDAs that are signers via CPI
        // from being counted during initialization but rejected during runtime operations.
        if acc.is_signer
            && acc.owner == &anchor_lang::system_program::ID
            && multisig_owners.contains(acc.key)
            && !counted_keys.contains(acc.key)
        {
            counted_keys.insert(*acc.key);
            valid_signers += 1;
        }
    }

    require!(
        valid_signers >= multisig_threshold as usize,
        CoordinationError::MultisigNotEnoughSigners
    );

    // Fix #448: Validate treasury is not the default pubkey
    require!(
        ctx.accounts.treasury.key() != Pubkey::default(),
        CoordinationError::InvalidTreasury
    );
    // Custody isolation: an arbitrary protocol-owned account may contain escrow,
    // stake, bond principal, or critical state. Configuring one as the treasury
    // would let TreasurySpend governance drain and delete it. Until a dedicated
    // typed vault exists, only an explicitly consenting system-owned signer is a
    // valid treasury.
    let treasury_is_system_owned = ctx.accounts.treasury.owner == &anchor_lang::system_program::ID;
    require!(treasury_is_system_owned, CoordinationError::InvalidTreasury);
    require!(
        ctx.accounts.treasury.is_signer,
        CoordinationError::TreasuryNotSpendable
    );

    // Now safe to write config
    let config = &mut ctx.accounts.protocol_config;
    config.authority = ctx.accounts.authority.key();
    config.treasury = ctx.accounts.treasury.key();
    config.dispute_threshold = dispute_threshold;
    config.protocol_fee_bps = protocol_fee_bps;
    config.min_arbiter_stake = min_stake;
    config.min_agent_stake = min_stake;
    config.max_claim_duration = ProtocolConfig::DEFAULT_MAX_CLAIM_DURATION;
    config.max_dispute_duration = ProtocolConfig::DEFAULT_MAX_DISPUTE_DURATION;
    config.total_agents = 0;
    config.total_tasks = 0;
    config.completed_tasks = 0;
    config.total_value_distributed = 0;
    config.bump = ctx.bumps.protocol_config;
    config.multisig_threshold = multisig_threshold;
    config.multisig_owners_len = multisig_owners.len() as u8;
    // Rate limiting defaults (can be updated post-deployment via update instruction)
    config.task_creation_cooldown = DEFAULT_TASK_CREATION_COOLDOWN;
    config.max_tasks_per_24h = DEFAULT_MAX_TASKS_PER_24H;
    config.dispute_initiation_cooldown = DEFAULT_DISPUTE_INITIATION_COOLDOWN;
    config.max_disputes_per_24h = DEFAULT_MAX_DISPUTES_PER_24H;
    config.min_stake_for_dispute = min_stake_for_dispute;
    // The account is created via `init` (zero-filled), NOT via Default, so any field that
    // must not be 0 has to be set explicitly. state_update_cooldown was missed (audit):
    // it landed at 0 on every fresh deploy, and update_state treats 0 as "disabled", so
    // the fix-#415 per-agent anti-spam cooldown was permanently off with no instruction
    // able to enable it. Match ProtocolConfig::default() (60s). This initializer
    // only affects newly created configs; it does not retroactively mutate an
    // existing deployment.
    config.state_update_cooldown = 60;
    // Compile-time assertion: DEFAULT_SLASH_PERCENTAGE must not exceed 100%
    const _: () = assert!(ProtocolConfig::DEFAULT_SLASH_PERCENTAGE <= 100);
    config.slash_percentage = ProtocolConfig::DEFAULT_SLASH_PERCENTAGE;
    config.voting_period = ProtocolConfig::DEFAULT_VOTING_PERIOD;
    // Versioning
    config.protocol_version = CURRENT_PROTOCOL_VERSION;
    config.min_supported_version = MIN_SUPPORTED_VERSION;
    config.protocol_paused = false;
    config.disabled_task_type_mask = 0;
    // P6.5: stamp the deployed surface this binary actually exposes.
    // - Full build  -> stamp the exact current wire contract, so a fresh
    //   dev/devnet/localnet deploy advertises every capability this binary exposes
    //   without a manual `update_launch_controls` step.
    // - Canary build -> only the restricted 25-ix surface is live: stamp 0
    //   (unstamped/conservative) so a fresh canary cluster never claims the full
    //   surface. An existing config is not re-initialized here; legacy layouts are
    //   brought forward by `migrate_protocol` (surface_revision = 0) and stamped by
    //   an operator if/when the corresponding surface is deployed.
    #[cfg(not(feature = "mainnet-canary"))]
    {
        config.surface_revision = ProtocolConfig::SURFACE_REVISION_CURRENT;
    }
    #[cfg(feature = "mainnet-canary")]
    {
        config.surface_revision = 0;
    }
    // Fix #497: Explicitly zero all slots before populating to ensure no data leakage.
    config.multisig_owners = [Pubkey::default(); ProtocolConfig::MAX_MULTISIG_OWNERS];
    for (index, owner) in multisig_owners.iter().enumerate() {
        config.multisig_owners[index] = *owner;
    }

    emit!(ProtocolInitialized {
        authority: config.authority,
        treasury: config.treasury,
        dispute_threshold,
        protocol_fee_bps,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use anchor_lang::prelude::Pubkey;
    use anchor_lang::ToAccountMetas;

    #[test]
    fn treasury_signer_meta_matches_the_deployed_surface() {
        let treasury = Pubkey::new_unique();
        let accounts = crate::__client_accounts_initialize_protocol::InitializeProtocol {
            protocol_config: Pubkey::new_unique(),
            treasury,
            authority: Pubkey::new_unique(),
            second_signer: Pubkey::new_unique(),
            system_program: Pubkey::new_unique(),
        };

        let treasury_meta = accounts
            .to_account_metas(None)
            .into_iter()
            .find(|meta| meta.pubkey == treasury)
            .expect("treasury meta should be present");

        assert_eq!(
            treasury_meta.is_signer,
            !cfg!(feature = "mainnet-canary"),
            "production must request treasury consent in the IDL while the canary wire flags stay frozen",
        );
    }
}
