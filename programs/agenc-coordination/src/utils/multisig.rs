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
    require_unconflicted_multisig_threshold(config, remaining_accounts, &[])
}

/// Revision 9: the conflicted-approver threshold. Identical to
/// `require_multisig_threshold` (same checks, same errors, same order), except
/// that an owner listed in `conflicted` never counts toward the threshold, even
/// when it signs. Duplicate signers count once (the signer set is a set).
///
/// Callers list every party with a stake in the ruling: the task creator, the
/// worker wallet, and each live operator or referrer payee. If fewer than the
/// threshold of unconflicted owners can sign, the ruling cannot be made and the
/// unruled default applies.
pub fn require_unconflicted_multisig_threshold(
    config: &ProtocolConfig,
    remaining_accounts: &[AccountInfo],
    conflicted: &[Pubkey],
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
        if signer_keys.contains(owner) && !conflicted.contains(owner) {
            approvals += 1;
        }
    }

    if approvals < threshold {
        return Err(error!(CoordinationError::MultisigNotEnoughSigners));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_2_of_3(owners: [Pubkey; 3]) -> ProtocolConfig {
        let mut multisig_owners = [Pubkey::default(); ProtocolConfig::MAX_MULTISIG_OWNERS];
        multisig_owners[..3].copy_from_slice(&owners);
        ProtocolConfig {
            multisig_threshold: 2,
            multisig_owners_len: 3,
            multisig_owners,
            ..ProtocolConfig::default()
        }
    }

    fn signer<'a>(key: &'a Pubkey, lamports: &'a mut u64, owner: &'a Pubkey) -> AccountInfo<'a> {
        AccountInfo::new(key, true, false, lamports, &mut [], owner, false, 0)
    }

    fn threshold_with(
        owners: [Pubkey; 3],
        signers: &[Pubkey],
        conflicted: &[Pubkey],
    ) -> Result<()> {
        let config = config_2_of_3(owners);
        let system = system_program::ID;
        let mut lamports: Vec<u64> = vec![1; signers.len()];
        let infos: Vec<AccountInfo> = signers
            .iter()
            .zip(lamports.iter_mut())
            .map(|(k, l)| signer(k, l, &system))
            .collect();
        require_unconflicted_multisig_threshold(&config, &infos, conflicted)
    }

    #[test]
    fn unconflicted_threshold_matches_the_plain_threshold_when_nothing_is_conflicted() {
        let owners = [
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        ];
        assert!(threshold_with(owners, &[owners[0], owners[1]], &[]).is_ok());
        assert!(threshold_with(owners, &[owners[0]], &[]).is_err());
    }

    // Revert-sensitive: dropping the `!conflicted.contains` term lets a
    // conflicted owner's signature carry a ruling it has a stake in.
    #[test]
    fn conflicted_owners_never_count_even_when_they_sign() {
        let owners = [
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        ];
        // Owner 0 is the creator: owners 0 and 1 signing is only one approval.
        assert!(threshold_with(owners, &[owners[0], owners[1]], &[owners[0]]).is_err());
        // The two unconflicted owners still carry it.
        assert!(threshold_with(owners, &[owners[1], owners[2]], &[owners[0]]).is_ok());
        // All three sign, two conflicted: not enough.
        assert!(threshold_with(
            owners,
            &[owners[0], owners[1], owners[2]],
            &[owners[0], owners[2]]
        )
        .is_err());
    }

    #[test]
    fn duplicate_signers_count_once() {
        let owners = [
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        ];
        assert!(threshold_with(owners, &[owners[1], owners[1]], &[]).is_err());
        assert!(threshold_with(owners, &[owners[1], owners[1], owners[2]], &[owners[0]]).is_ok());
    }

    #[test]
    fn a_non_owner_conflict_entry_changes_nothing() {
        let owners = [
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        ];
        let stranger = Pubkey::new_unique();
        assert!(threshold_with(owners, &[owners[0], owners[1]], &[stranger]).is_ok());
    }
}
