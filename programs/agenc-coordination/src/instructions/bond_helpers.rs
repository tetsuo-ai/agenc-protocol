//! Shared settlement for completion bonds (Batch 3 §8).
//!
//! A single source of truth so every exit path (accept / complete / auto-accept /
//! expire_claim no-show / cancel / dispute resolve / dispute expire) disposes a bond
//! the same way and none diverges. SOL-only v1. Bonds are passed as remaining_accounts
//! and are OPTIONAL: a missing / non-bond / already-settled account is a safe no-op, so
//! a task that never posted bonds settles exactly as before.

use crate::errors::CoordinationError;
use crate::events::{BondForfeited, BondRefunded};
use crate::state::CompletionBond;
use anchor_lang::prelude::*;

/// What to do with a bond at settlement.
pub(crate) enum BondDisposition<'a, 'info> {
    /// Return the full balance (rent + principal) to the poster.
    Refund,
    /// Move the principal to `recipient`, return the rent to the poster.
    Forfeit {
        recipient: &'a AccountInfo<'info>,
    },
}

/// Settle one completion bond. No-op when `bond_info` is not a live, program-owned
/// CompletionBond for `(task_key, expected_role)` — so callers can always pass the
/// seeds-derived bond account and let un-bonded tasks fall through unchanged.
///
/// Validates: program ownership, the PDA derivation (`["completion_bond", task,
/// party]`), task binding, role, and that `poster_wallet == bond.party`.
pub(crate) fn settle_completion_bond<'info>(
    bond_info: &AccountInfo<'info>,
    poster_wallet: &AccountInfo<'info>,
    task_key: &Pubkey,
    expected_role: u8,
    disposition: BondDisposition<'_, 'info>,
) -> Result<()> {
    // Not a live program-owned account -> no bond posted (or already settled/purged).
    if bond_info.owner != &crate::ID {
        return Ok(());
    }
    {
        // Tombstoned (already settled within this tx) -> no-op.
        let data = bond_info.try_borrow_data()?;
        if data.len() < 8 || data[..8] == [255u8; 8] {
            return Ok(());
        }
    }

    let bond = {
        let data = bond_info.try_borrow_data()?;
        CompletionBond::try_deserialize(&mut &data[..])
            .map_err(|_| CoordinationError::MissingCompletionBondAccount)?
    };
    require!(bond.task == *task_key, CoordinationError::BondTaskMismatch);
    require!(bond.role == expected_role, CoordinationError::BondRoleMismatch);
    require!(
        poster_wallet.key() == bond.party,
        CoordinationError::BondPartyMismatch
    );
    // Defense-in-depth: confirm the account is the canonical bond PDA, so a crafted
    // program-owned account cannot be substituted.
    let (expected_pda, _) = Pubkey::find_program_address(
        &[b"completion_bond", task_key.as_ref(), bond.party.as_ref()],
        &crate::ID,
    );
    require!(
        bond_info.key() == expected_pda,
        CoordinationError::MissingCompletionBondAccount
    );

    let principal = bond.amount;
    let timestamp = Clock::get()?.unix_timestamp;

    if let BondDisposition::Forfeit { recipient } = &disposition {
        if principal > 0 {
            **bond_info.try_borrow_mut_lamports()? = bond_info
                .lamports()
                .checked_sub(principal)
                .ok_or(CoordinationError::ArithmeticOverflow)?;
            **recipient.try_borrow_mut_lamports()? = recipient
                .lamports()
                .checked_add(principal)
                .ok_or(CoordinationError::ArithmeticOverflow)?;
        }
    }

    // Return the remaining balance (rent, plus principal on a Refund) to the poster
    // and tombstone the account so it cannot be re-settled.
    let remaining = bond_info.lamports();
    **bond_info.try_borrow_mut_lamports()? = 0;
    **poster_wallet.try_borrow_mut_lamports()? = poster_wallet
        .lamports()
        .checked_add(remaining)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    {
        let mut data = bond_info.try_borrow_mut_data()?;
        data.fill(0);
        data[..8].copy_from_slice(&[255u8; 8]);
    }

    match disposition {
        BondDisposition::Refund => emit!(BondRefunded {
            task: *task_key,
            party: bond.party,
            role: bond.role,
            amount: principal,
            timestamp,
        }),
        BondDisposition::Forfeit { recipient } => emit!(BondForfeited {
            task: *task_key,
            party: bond.party,
            role: bond.role,
            amount: principal,
            recipient: recipient.key(),
            timestamp,
        }),
    }

    Ok(())
}
