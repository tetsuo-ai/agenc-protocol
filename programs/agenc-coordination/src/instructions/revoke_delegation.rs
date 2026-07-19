//! Permissionless retirement of a legacy reputation delegation.
//!
//! Revision 5 disables new delegations: the legacy account never credited its
//! delegatee and only removed reputation from the delegator. Keeping the old
//! owner-signature/cooldown exit would let a delegation raced during the loader
//! upgrade block the post-deploy cutover indefinitely. This exit is therefore
//! permissionless, but every destination is still derived from authenticated
//! on-chain state:
//!
//! - an identity-continuous AgentRegistration routes rent to its recorded
//!   authority;
//! - a closed or discontinuous (re-registered) identity routes rent only to the
//!   canonical protocol treasury.
//!
//! No path restores reputation. Restoring it after a dispute slash would recreate
//! the exact shelter/evasion primitive for which delegation was retired. Mainnet
//! preflight requires a zero delegation set before the upgrade; any record raced
//! after that snapshot is therefore purged rather than made slash-profitable.

use crate::errors::CoordinationError;
use crate::events::ReputationDelegationRetired;
use crate::instructions::program_account_helpers::{
    close_program_account, deserialize_program_account,
};
use crate::state::{AgentRegistration, ProtocolConfig, ReputationDelegation};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RevokeDelegation<'info> {
    /// CHECK: For an identity-continuous delegation this must equal the authority
    /// recorded on `delegator_agent` and is the rent recipient. It deliberately
    /// need not sign: delegation is a retired, non-beneficial feature, and making
    /// the exit permissionless prevents an owner from blocking a mainnet cutover.
    #[account(mut)]
    pub authority: UncheckedAccount<'info>,

    /// CHECK: Address and state are authenticated against `delegation.delegator`
    /// in the handler. Unchecked is required because deployed revision 4 could
    /// close this PDA after creating a delegation.
    #[account(mut)]
    pub delegator_agent: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"reputation_delegation", delegator_agent.key().as_ref(), delegation.delegatee.as_ref()],
        bump = delegation.bump,
        constraint = delegation.delegator == delegator_agent.key() @ CoordinationError::InvalidInput,
        constraint = delegation.key() != delegator_agent.key() @ CoordinationError::InvalidInput
    )]
    pub delegation: Account<'info, ReputationDelegation>,
}

pub fn handler<'info>(ctx: Context<'_, '_, '_, 'info, RevokeDelegation<'info>>) -> Result<()> {
    let clock = Clock::get()?;
    let delegation_info = ctx.accounts.delegation.to_account_info();
    let delegator_info = ctx.accounts.delegator_agent.to_account_info();

    // Accept exactly the deployed account layout. A larger account could be a
    // future version whose reserved bytes have acquired semantics; silently
    // closing it as a legacy record would destroy unknown state.
    require!(
        delegation_info.data_len() == ReputationDelegation::SIZE,
        CoordinationError::CorruptedData
    );
    require!(
        ctx.accounts.delegation._reserved == [0u8; 8],
        CoordinationError::CorruptedData
    );

    let delegation_amount = ctx.accounts.delegation.amount;
    let delegation_delegator = ctx.accounts.delegation.delegator;
    let delegation_delegatee = ctx.accounts.delegation.delegatee;
    let delegation_created_at = ctx.accounts.delegation.created_at;
    let delegation_expires_at = ctx.accounts.delegation.expires_at;

    // These are invariants of every record the deployed revision could create.
    // Validate them before selecting the authenticated rent destination.
    require!(
        delegation_amount > 0
            && delegation_amount <= crate::instructions::constants::MAX_REPUTATION,
        CoordinationError::CorruptedData
    );
    require!(
        delegation_created_at > 0
            && (delegation_expires_at == 0 || delegation_expires_at > delegation_created_at),
        CoordinationError::CorruptedData
    );
    require!(
        delegation_delegator != Pubkey::default()
            && delegation_delegatee != Pubkey::default()
            && delegation_delegator != delegation_delegatee,
        CoordinationError::CorruptedData
    );

    require_keys_eq!(
        delegator_info.key(),
        delegation_delegator,
        CoordinationError::InvalidInput
    );

    if delegator_info.owner == &crate::ID {
        let delegator: AgentRegistration = deserialize_program_account(&delegator_info)
            .map_err(|_| CoordinationError::CorruptedData)?;
        let (expected_agent, expected_bump) =
            Pubkey::find_program_address(&[b"agent", delegator.agent_id.as_ref()], &crate::ID);
        require_keys_eq!(
            expected_agent,
            delegator_info.key(),
            CoordinationError::InvalidInput
        );
        require!(
            delegator.bump == expected_bump,
            CoordinationError::InvalidInput
        );

        // Strict timestamp continuity distinguishes the original registration
        // (including revision-5 RETD tombstones, which preserve registered_at)
        // from a revision-4 close/re-register clone. Equality is intentionally
        // discontinuous because the old binary allowed a same-slot bundle.
        if delegator.registered_at < delegation_created_at {
            require_keys_eq!(
                delegator.authority,
                ctx.accounts.authority.key(),
                CoordinationError::UnauthorizedAgent
            );

            let recovered_rent = delegation_info.lamports();
            close_program_account(&delegation_info, &ctx.accounts.authority.to_account_info())?;

            emit!(ReputationDelegationRetired {
                delegation: ctx.accounts.delegation.key(),
                delegator: delegation_delegator,
                delegatee: delegation_delegatee,
                discarded_reputation: delegation_amount,
                recovered_rent,
                rent_recipient: ctx.accounts.authority.key(),
                identity_continuous: true,
                timestamp: clock.unix_timestamp,
            });
            return Ok(());
        }
    } else {
        // A revision-4 Anchor close produces exactly a system-owned, empty PDA.
        // Lamports may be nonzero because anyone can prefund an address; ownership
        // and empty data, not balance, authenticate absence.
        require!(
            delegator_info.owner == &anchor_lang::system_program::ID
                && delegator_info.data_is_empty(),
            CoordinationError::InvalidAccountOwner
        );
    }

    // Orphan/discontinuous recovery deliberately uses remaining accounts so the
    // three fixed revision-4 account metas stay wire-compatible. Exact ABI:
    //   remaining_accounts[0] = canonical ProtocolConfig (readonly)
    //   remaining_accounts[1] = configured treasury (writable)
    require!(
        ctx.remaining_accounts.len() == 2,
        CoordinationError::ReputationDelegationRecoveryAccountsRequired
    );
    let protocol_info = &ctx.remaining_accounts[0];
    let treasury_info = &ctx.remaining_accounts[1];
    let protocol_config: ProtocolConfig =
        deserialize_program_account(protocol_info).map_err(|_| CoordinationError::CorruptedData)?;
    let (expected_protocol, expected_protocol_bump) =
        Pubkey::find_program_address(&[b"protocol"], &crate::ID);
    require_keys_eq!(
        protocol_info.key(),
        expected_protocol,
        CoordinationError::InvalidInput
    );
    require!(
        protocol_config.bump == expected_protocol_bump,
        CoordinationError::InvalidInput
    );
    require_keys_eq!(
        treasury_info.key(),
        protocol_config.treasury,
        CoordinationError::InvalidTreasury
    );
    require!(
        treasury_info.is_writable,
        CoordinationError::ReputationDelegationRecoveryAccountsRequired
    );
    require!(
        treasury_info.owner == &anchor_lang::system_program::ID
            && treasury_info.data_is_empty()
            && !treasury_info.executable,
        CoordinationError::InvalidTreasury
    );

    let recovered_rent = delegation_info.lamports();
    close_program_account(&delegation_info, treasury_info)?;

    emit!(ReputationDelegationRetired {
        delegation: ctx.accounts.delegation.key(),
        delegator: delegation_delegator,
        delegatee: delegation_delegatee,
        discarded_reputation: delegation_amount,
        recovered_rent,
        rent_recipient: treasury_info.key(),
        identity_continuous: false,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
