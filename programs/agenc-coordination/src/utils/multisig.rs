//! Multisig approval helpers
//!
//! AUTHORITY MODEL (audit F-18 — the single documented model): admin instructions
//! fall into exactly two classes. (1) MULTISIG-gated: the M-of-N owner set on the
//! `["protocol"]` ProtocolConfig must co-sign in `remaining_accounts`
//! (`require_multisig_threshold` below); the instruction's own signer is the
//! proposer and does NOT count toward the threshold unless also listed. (2)
//! AUTHORITY-bound: the signer must equal `protocol_config.authority`
//! (`initialize_zk_config` keeps this belt-and-suspenders ON TOP of the multisig
//! gate). Anything else (a bare signer with no binding) is not an admin path.
//! `require_multisig_threshold` is the ONLY threshold enforcer — the legacy
//! `require_multisig` variant was removed (zero callers).

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use std::collections::BTreeSet;

use crate::errors::CoordinationError;
use crate::state::ProtocolConfig;

/// Validate multisig owner pubkeys before config is written
pub fn validate_multisig_owners(owners: &[Pubkey]) -> Result<()> {
    for (index, owner) in owners.iter().enumerate() {
        require!(
            *owner != Pubkey::default(),
            CoordinationError::MultisigDefaultSigner
        );
        let next_index = index
            .checked_add(1)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        for other in owners.iter().skip(next_index) {
            require!(*owner != *other, CoordinationError::MultisigDuplicateSigner);
        }
    }
    Ok(())
}

pub fn unique_account_infos<'info>(accounts: &[AccountInfo<'info>]) -> Vec<AccountInfo<'info>> {
    let mut seen = BTreeSet::new();
    let mut unique = Vec::with_capacity(accounts.len());
    for account in accounts {
        if seen.insert(*account.key) {
            unique.push(account.clone());
        }
    }
    unique
}

pub fn require_multisig_threshold(
    config: &ProtocolConfig,
    remaining_accounts: &[AccountInfo],
) -> Result<()> {
    let owners_len = config.multisig_owners_len as usize;
    let threshold = config.multisig_threshold as usize;

    if owners_len == 0 || owners_len > ProtocolConfig::MAX_MULTISIG_OWNERS {
        return Err(error!(CoordinationError::MultisigInvalidSigners));
    }

    if threshold < 2 || threshold > owners_len {
        return Err(error!(CoordinationError::MultisigInvalidThreshold));
    }

    let mut signer_keys = BTreeSet::new();
    for account in remaining_accounts {
        if !account.is_signer {
            continue;
        }
        if account.owner != &system_program::ID {
            return Err(error!(CoordinationError::MultisigSignerNotSystemOwned));
        }
        signer_keys.insert(*account.key);
    }

    let mut approvals = 0usize;
    for owner in config.multisig_owners[..owners_len].iter() {
        if owner == &Pubkey::default() {
            return Err(error!(CoordinationError::MultisigDefaultSigner));
        }
        if signer_keys.contains(owner) {
            approvals += 1;
        }
    }

    if approvals < threshold {
        return Err(error!(CoordinationError::MultisigNotEnoughSigners));
    }

    Ok(())
}
