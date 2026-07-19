//! Safe helpers for dynamically supplied program accounts.
//!
//! Anchor's `Account::try_from` requires `&'info AccountInfo<'info>`, which is
//! intentionally stricter than the short borrows obtained from
//! `UncheckedAccount` and `Context::remaining_accounts`. Dynamic accounts in
//! this program never need to retain an `AccountInfo` reference: load their
//! state by value, persist explicit mutations, and close through the original
//! `AccountInfo` instead.

use crate::errors::CoordinationError;
use anchor_lang::error::{Error, ErrorCode};
use anchor_lang::prelude::*;

/// Deserialize a program account by value while preserving Anchor's owner and
/// initialization error behavior.
pub(crate) fn deserialize_program_account<T>(account_info: &AccountInfo<'_>) -> Result<T>
where
    T: AccountDeserialize + Owner,
{
    if account_info.owner == &system_program::ID && account_info.lamports() == 0 {
        return Err(ErrorCode::AccountNotInitialized.into());
    }
    if account_info.owner != &T::owner() {
        return Err(Error::from(ErrorCode::AccountOwnedByWrongProgram)
            .with_pubkeys((*account_info.owner, T::owner())));
    }

    let data = account_info.try_borrow_data()?;
    T::try_deserialize(&mut &data[..])
}

/// Persist an already-deserialized program account without rewriting its
/// discriminator. Dynamic accounts are not part of Anchor's `AccountsExit`
/// traversal, so every non-terminal mutation must call this explicitly.
#[cfg(any(not(feature = "mainnet-canary"), test))]
pub(crate) fn persist_program_account<T>(account_info: &AccountInfo<'_>, state: &T) -> Result<()>
where
    T: AnchorSerialize,
{
    require!(account_info.is_writable, CoordinationError::InvalidInput);
    require!(
        account_info.owner == &crate::ID,
        CoordinationError::InvalidAccountOwner
    );
    let mut data = account_info.try_borrow_mut_data()?;
    let state_bytes = data
        .get_mut(8..)
        .ok_or(anchor_lang::error::ErrorCode::AccountDidNotSerialize)?;
    AnchorSerialize::serialize(state, &mut &mut state_bytes[..])
        .map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotSerialize.into())
}

/// Close a program-owned account using the same observable state transition as
/// Anchor 0.32's private `common::close`: transfer all lamports, assign the
/// source to the system program, and truncate its data to zero bytes.
pub(crate) fn close_program_account<'info>(
    source: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
) -> Result<()> {
    require!(
        source.is_writable && destination.is_writable,
        CoordinationError::InvalidInput
    );
    require!(
        source.key() != destination.key(),
        CoordinationError::InvalidInput
    );
    require!(
        source.owner == &crate::ID,
        CoordinationError::InvalidAccountOwner
    );

    let source_lamports = source.lamports();
    let destination_lamports = destination
        .lamports()
        .checked_add(source_lamports)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    **destination.try_borrow_mut_lamports()? = destination_lamports;
    **source.try_borrow_mut_lamports()? = 0;
    source.assign(&system_program::ID);
    source.resize(0).map_err(Into::into)
}

/// Fallibly select one dynamically supplied account without widening the
/// borrow beyond the lifetime of the containing slice.
#[cfg(any(not(feature = "mainnet-canary"), test))]
pub(crate) fn remaining_account_at<'accounts, 'info>(
    remaining_accounts: &'accounts [AccountInfo<'info>],
    index: usize,
    error: CoordinationError,
) -> Result<&'accounts AccountInfo<'info>> {
    remaining_accounts.get(index).ok_or(error.into())
}

/// Fallibly select a subrange of dynamically supplied accounts while retaining
/// the slice's real borrow lifetime.
#[cfg(any(not(feature = "mainnet-canary"), test))]
pub(crate) fn remaining_account_range<'accounts, 'info>(
    remaining_accounts: &'accounts [AccountInfo<'info>],
    range: core::ops::Range<usize>,
    error: CoordinationError,
) -> Result<&'accounts [AccountInfo<'info>]> {
    remaining_accounts.get(range).ok_or(error.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::TaskEscrow;

    fn anchor_error_code(error: anchor_lang::error::Error) -> u32 {
        match error {
            anchor_lang::error::Error::AnchorError(error) => error.error_code_number,
            other => panic!("expected AnchorError, got {other:?}"),
        }
    }

    fn expect_error<T>(result: Result<T>) -> anchor_lang::error::Error {
        match result {
            Ok(_) => panic!("expected account helper to fail"),
            Err(error) => error,
        }
    }

    fn serialized_escrow(amount: u64) -> Vec<u8> {
        let escrow = TaskEscrow {
            task: Pubkey::new_unique(),
            amount,
            distributed: 7,
            is_closed: false,
            bump: 3,
        };
        let mut data = Vec::new();
        escrow.try_serialize(&mut data).unwrap();
        data.resize(TaskEscrow::SIZE, 0);
        data
    }

    #[test]
    fn deserialize_matches_anchor_for_uninitialized_and_wrong_owner_accounts() {
        let key = Pubkey::new_unique();
        let system_owner = system_program::ID;
        let mut lamports = 0;
        let mut empty_data = [];
        let uninitialized = AccountInfo::new(
            &key,
            false,
            false,
            &mut lamports,
            &mut empty_data,
            &system_owner,
            false,
            0,
        );
        assert_eq!(
            anchor_error_code(expect_error(deserialize_program_account::<TaskEscrow>(
                &uninitialized,
            ))),
            ErrorCode::AccountNotInitialized as u32,
        );

        let mut prefunded_lamports = 1;
        let mut prefunded_data = [];
        let prefunded = AccountInfo::new(
            &key,
            false,
            false,
            &mut prefunded_lamports,
            &mut prefunded_data,
            &system_owner,
            false,
            0,
        );
        assert_eq!(
            anchor_error_code(expect_error(deserialize_program_account::<TaskEscrow>(
                &prefunded,
            ))),
            ErrorCode::AccountOwnedByWrongProgram as u32,
        );
    }

    #[test]
    fn persist_preserves_discriminator_and_round_trips_state() {
        let key = Pubkey::new_unique();
        let owner = crate::ID;
        let mut lamports = 1_000_000;
        let mut data = serialized_escrow(11);
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
        let discriminator = account.try_borrow_data().unwrap()[..8].to_vec();

        let mut escrow = deserialize_program_account::<TaskEscrow>(&account).unwrap();
        escrow.amount = 99;
        escrow.distributed = 42;
        persist_program_account(&account, &escrow).unwrap();

        assert_eq!(&account.try_borrow_data().unwrap()[..8], discriminator);
        let reloaded = deserialize_program_account::<TaskEscrow>(&account).unwrap();
        assert_eq!(reloaded.amount, 99);
        assert_eq!(reloaded.distributed, 42);
        assert_eq!(reloaded.task, escrow.task);
    }

    #[test]
    fn persist_rejects_readonly_or_foreign_accounts_before_mutation() {
        let key = Pubkey::new_unique();
        let owner = crate::ID;
        let foreign_owner = Pubkey::new_unique();
        let mut readonly_lamports = 1_000_000;
        let mut readonly_data = serialized_escrow(11);
        let readonly = AccountInfo::new(
            &key,
            false,
            false,
            &mut readonly_lamports,
            &mut readonly_data,
            &owner,
            false,
            0,
        );
        let state = deserialize_program_account::<TaskEscrow>(&readonly).unwrap();
        assert!(persist_program_account(&readonly, &state).is_err());

        let mut foreign_lamports = 1_000_000;
        let mut foreign_data = serialized_escrow(11);
        let foreign = AccountInfo::new(
            &key,
            false,
            true,
            &mut foreign_lamports,
            &mut foreign_data,
            &foreign_owner,
            false,
            0,
        );
        assert!(persist_program_account(&foreign, &state).is_err());
    }

    #[test]
    fn remaining_account_access_is_fallible_and_keeps_order() {
        let first_key = Pubkey::new_unique();
        let second_key = Pubkey::new_unique();
        let owner = system_program::ID;
        let mut first_lamports = 0;
        let mut second_lamports = 0;
        let mut first_data = [];
        let mut second_data = [];
        let accounts = [
            AccountInfo::new(
                &first_key,
                false,
                false,
                &mut first_lamports,
                &mut first_data,
                &owner,
                false,
                0,
            ),
            AccountInfo::new(
                &second_key,
                false,
                false,
                &mut second_lamports,
                &mut second_data,
                &owner,
                false,
                0,
            ),
        ];

        assert_eq!(
            remaining_account_at(&accounts, 1, CoordinationError::InvalidInput)
                .unwrap()
                .key(),
            second_key,
        );
        assert!(remaining_account_at(&accounts, 2, CoordinationError::InvalidInput).is_err());
        let range =
            remaining_account_range(&accounts, 0..2, CoordinationError::InvalidInput).unwrap();
        assert_eq!(range[0].key(), first_key);
        assert_eq!(range[1].key(), second_key);
        assert!(remaining_account_range(&accounts, 1..3, CoordinationError::InvalidInput).is_err());
    }

    // AccountInfo::resize mirrors the runtime ABI and writes the new length to
    // the eight-byte header immediately before the data pointer. Host fixtures
    // therefore need the same header; this unsafe code is test-only.
    fn leak_runtime_data(data: Vec<u8>) -> &'static mut [u8] {
        let len = data.len();
        let mut storage = Vec::with_capacity(8 + len);
        storage.extend_from_slice(&(len as u64).to_le_bytes());
        storage.extend_from_slice(&data);
        let raw: *mut [u8] = Box::into_raw(storage.into_boxed_slice());
        // SAFETY: `raw` is intentionally leaked and owns the eight-byte header
        // plus `len` data bytes. The returned region is therefore valid for the
        // full test and has the header expected by `AccountInfo::resize`.
        unsafe {
            let data_ptr = (raw as *mut u8).add(8);
            std::slice::from_raw_parts_mut(data_ptr, len)
        }
    }

    #[test]
    fn close_matches_anchor_owner_data_and_lamport_semantics() {
        let source_key = Box::leak(Box::new(Pubkey::new_unique()));
        let destination_key = Box::leak(Box::new(Pubkey::new_unique()));
        let source_owner = Box::leak(Box::new(crate::ID));
        let destination_owner = Box::leak(Box::new(system_program::ID));
        let source_lamports = Box::leak(Box::new(123));
        let destination_lamports = Box::leak(Box::new(77));
        let destination_data = Box::leak(Vec::new().into_boxed_slice());
        let source = AccountInfo::new(
            source_key,
            false,
            true,
            source_lamports,
            leak_runtime_data(serialized_escrow(11)),
            source_owner,
            false,
            0,
        );
        let destination = AccountInfo::new(
            destination_key,
            false,
            true,
            destination_lamports,
            destination_data,
            destination_owner,
            false,
            0,
        );

        close_program_account(&source, &destination).unwrap();

        assert_eq!(source.lamports(), 0);
        assert_eq!(destination.lamports(), 200);
        assert_eq!(source.owner, &system_program::ID);
        assert_eq!(source.data_len(), 0);
    }

    #[test]
    fn close_rejects_aliases_before_moving_lamports() {
        let key = Pubkey::new_unique();
        let owner = crate::ID;
        let mut lamports = 123;
        let mut data = serialized_escrow(11);
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

        assert!(close_program_account(&account, &account).is_err());
        assert_eq!(account.lamports(), 123);
        assert_eq!(account.owner, &crate::ID);
        assert!(!account.data_is_empty());
    }
}
