//! Shared lamport transfer helper with checked arithmetic.
//!
//! Consolidates the repeated pattern of `checked_sub` from source + `checked_add`
//! to destination into a single function, ensuring overflow/underflow safety.

use crate::errors::CoordinationError;
use anchor_lang::prelude::*;

/// Transfer `amount` lamports from one account to another using checked arithmetic.
///
/// Returns `Ok(())` immediately if `amount == 0` (no-op).
/// Returns `CoordinationError::ArithmeticOverflow` on underflow or overflow.
///
pub fn transfer_lamports<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    // A same-account transfer is economically a no-op, but callers generally
    // account it as a real withdrawal. In particular, a fee payee aliased to
    // escrow would leave the purported fee in escrow for the creator to recover
    // at close. Reject the primitive globally before either balance is touched.
    require!(
        from.key() != to.key(),
        CoordinationError::LamportTransferAccountAlias
    );
    **from.try_borrow_mut_lamports()? = from
        .lamports()
        .checked_sub(amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    **to.try_borrow_mut_lamports()? = to
        .lamports()
        .checked_add(amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    Ok(())
}

/// Credit `amount` lamports to an account using checked arithmetic.
///
/// Use this when the source account has already been debited separately
/// (e.g., Split resolution where escrow is debited once for the total,
/// then two recipients are credited individually).
///
/// Returns `Ok(())` immediately if `amount == 0`.
pub fn credit_lamports(to: &AccountInfo<'_>, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    **to.try_borrow_mut_lamports()? = to
        .lamports()
        .checked_add(amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    Ok(())
}

/// Debit `amount` lamports from an account using checked arithmetic.
///
/// Use this when the destination account will be credited separately.
///
/// Returns `Ok(())` immediately if `amount == 0`.
pub fn debit_lamports(from: &AccountInfo<'_>, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    **from.try_borrow_mut_lamports()? = from
        .lamports()
        .checked_sub(amount)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn positive_same_account_transfer_is_rejected_without_mutation() {
        let key = Pubkey::new_unique();
        let owner = crate::ID;
        let mut lamports = 100;
        let mut data = [];
        let account = AccountInfo::new(
            &key,
            false,
            true,
            &mut lamports,
            &mut data,
            &owner,
            false,
            0,
        );

        assert!(transfer_lamports(&account, &account, 1).is_err());
        assert_eq!(account.lamports(), 100);
    }

    #[test]
    fn zero_same_account_transfer_remains_a_noop() {
        let key = Pubkey::new_unique();
        let owner = crate::ID;
        let mut lamports = 100;
        let mut data = [];
        let account = AccountInfo::new(
            &key,
            false,
            true,
            &mut lamports,
            &mut data,
            &owner,
            false,
            0,
        );

        transfer_lamports(&account, &account, 0).unwrap();
        assert_eq!(account.lamports(), 100);
    }
}
