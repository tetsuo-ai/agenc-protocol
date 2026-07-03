//! Update the on-chain default trusted-attestor list pointer (P1.2 §5.1),
//! multisig-written.
//!
//! The plain open-roster baseline put the default trust list behind a single npm
//! publish key — quietly re-centralizing the gatekeeping removed on-chain. Instead
//! the pointer (content hash + URI of the signed, versioned, FORKABLE list artifact
//! shipped in `@tetsuo-ai/marketplace-moderation`) lives in a PDA written only under
//! `require_multisig_threshold` — a NEW standalone instruction, never the
//! stake-weighted proposal machinery. `version` is monotonic (rollback detection) and
//! `updated_at` is the deadman: a surface that sees a stale pointer falls back to its
//! own list. The list is advisory display-layer curation — it gates nothing on-chain.

use crate::errors::CoordinationError;
use crate::events::DefaultTrustListUpdated;
use crate::state::{DefaultTrustList, ProtocolConfig, HASH_SIZE, MODERATION_URI_MAX_LEN};
use crate::utils::multisig::{require_multisig_threshold, unique_account_infos};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SetDefaultTrustList<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// Singleton pointer PDA; `init_if_needed` so the first update creates it.
    #[account(
        init_if_needed,
        payer = authority,
        space = DefaultTrustList::SIZE,
        seeds = [b"default_trust_list"],
        bump
    )]
    pub default_trust_list: Box<Account<'info, DefaultTrustList>>,

    /// Fee payer / tx assembler. Approval authority is the multisig threshold over
    /// `remaining_accounts`, exactly like `update_protocol_fee`.
    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<SetDefaultTrustList>,
    list_hash: [u8; HASH_SIZE],
    list_uri: String,
) -> Result<()> {
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::MultisigNotEnoughSigners
    );
    let unique_signers = unique_account_infos(ctx.remaining_accounts);
    require_multisig_threshold(&ctx.accounts.protocol_config, &unique_signers)?;

    validate_trust_list_pointer(&list_hash, &list_uri)?;

    let clock = Clock::get()?;
    let list = ctx.accounts.default_trust_list.as_mut();
    list.list_hash = list_hash;
    list.list_uri = list_uri.clone();
    list.version = list
        .version
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    list.updated_at = clock.unix_timestamp;
    list.updated_by = ctx.accounts.authority.key();
    list.bump = ctx.bumps.default_trust_list;

    emit!(DefaultTrustListUpdated {
        list_hash,
        list_uri,
        version: list.version,
        updated_by: ctx.accounts.authority.key(),
        timestamp: clock.unix_timestamp,
    });
    Ok(())
}

pub fn validate_trust_list_pointer(list_hash: &[u8; HASH_SIZE], list_uri: &str) -> Result<()> {
    require!(
        list_hash.iter().any(|byte| *byte != 0),
        CoordinationError::InvalidTrustList
    );
    require!(
        !list_uri.trim().is_empty(),
        CoordinationError::InvalidTrustList
    );
    require!(
        list_uri.len() <= MODERATION_URI_MAX_LEN,
        CoordinationError::InvalidTrustList
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_complete_pointer() {
        let mut hash = [0u8; HASH_SIZE];
        hash[0] = 9;
        assert!(
            validate_trust_list_pointer(&hash, "agenc://trust-list/sha256/abc").is_ok()
        );
    }

    #[test]
    fn rejects_zero_hash_and_empty_uri() {
        let mut hash = [0u8; HASH_SIZE];
        hash[0] = 9;
        assert!(validate_trust_list_pointer(&[0u8; HASH_SIZE], "agenc://x").is_err());
        assert!(validate_trust_list_pointer(&hash, "  ").is_err());
        assert!(
            validate_trust_list_pointer(&hash, &"a".repeat(MODERATION_URI_MAX_LEN + 1)).is_err()
        );
    }
}
