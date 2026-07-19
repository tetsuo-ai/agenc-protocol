//! Update protocol treasury (multisig gated).
//!
//! This provides a safe recovery path if the original treasury configuration
//! becomes unusable, and allows rotating treasury custody over time.

use crate::errors::CoordinationError;
use crate::events::TreasuryUpdated;
use crate::state::ProtocolConfig;
use crate::utils::multisig::{require_multisig_threshold, unique_account_infos};
use anchor_lang::prelude::*;
use anchor_lang::system_program;

#[derive(Accounts)]
pub struct UpdateTreasury<'info> {
    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// Must be a system-owned signer. Production clients request the new custody
    /// key's signature through this typed account in generated account metas.
    #[cfg(not(feature = "mainnet-canary"))]
    pub new_treasury: Signer<'info>,

    /// CHECK: The frozen canary IDL historically marks new_treasury as a
    /// non-signer. The handler retains the system-owner and runtime-signature
    /// checks, so canary transactions must explicitly promote and sign this meta.
    #[cfg(feature = "mainnet-canary")]
    pub new_treasury: UncheckedAccount<'info>,

    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<UpdateTreasury>) -> Result<()> {
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::MultisigNotEnoughSigners
    );
    let unique_signers = unique_account_infos(ctx.remaining_accounts);
    require_multisig_threshold(&ctx.accounts.protocol_config, &unique_signers)?;

    let new_treasury = &ctx.accounts.new_treasury;
    require!(
        new_treasury.key() != Pubkey::default(),
        CoordinationError::InvalidTreasury
    );

    let is_system_owned_signer =
        new_treasury.owner == &system_program::ID && new_treasury.is_signer;
    require!(
        is_system_owned_signer,
        CoordinationError::TreasuryNotSpendable
    );

    let config = &mut ctx.accounts.protocol_config;
    require!(
        new_treasury.key() != config.treasury,
        CoordinationError::InvalidInput
    );

    let old_treasury = config.treasury;
    config.treasury = new_treasury.key();

    let updated_by = ctx.accounts.authority.key();

    emit!(TreasuryUpdated {
        old_treasury,
        new_treasury: config.treasury,
        updated_by,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use anchor_lang::prelude::Pubkey;
    use anchor_lang::ToAccountMetas;

    #[test]
    fn new_treasury_signer_meta_matches_the_deployed_surface() {
        let new_treasury = Pubkey::new_unique();
        let accounts = crate::__client_accounts_update_treasury::UpdateTreasury {
            protocol_config: Pubkey::new_unique(),
            new_treasury,
            authority: Pubkey::new_unique(),
        };

        let new_treasury_meta = accounts
            .to_account_metas(None)
            .into_iter()
            .find(|meta| meta.pubkey == new_treasury)
            .expect("new treasury meta should be present");

        assert_eq!(
            new_treasury_meta.is_signer,
            !cfg!(feature = "mainnet-canary"),
            "production must request treasury consent in the IDL while the canary wire flags stay frozen",
        );
    }
}
