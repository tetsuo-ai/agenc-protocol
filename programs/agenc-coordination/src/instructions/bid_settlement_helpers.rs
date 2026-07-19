use crate::errors::CoordinationError;
use crate::instructions::lamport_transfer::transfer_lamports;
use crate::instructions::program_account_helpers::{
    close_program_account, deserialize_program_account, persist_program_account,
    remaining_account_at,
};
use crate::state::{
    BidBookState, BidderMarketState, DependencyType, Task, TaskBid, TaskBidBook, TaskBidState,
    TaskClaim, TaskType,
};
use anchor_lang::prelude::*;

pub(crate) struct BidTaskCompletionMeta {
    pub settlement_offset: usize,
    pub accepted_bid_price: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AcceptedBidBookDisposition {
    Close,
    Reopen,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AcceptedBidBondDisposition {
    Refund,
    FullSlashToCreator,
    SnapshottedNoShowSlashToCreator,
}

/// Convert objective no-show eligibility into the common accepted-bid bond
/// policy used by claim expiry, task cancellation, and dispute expiry.
pub(crate) fn accepted_bid_no_show_bond_disposition(
    no_show_penalty_allowed: bool,
) -> AcceptedBidBondDisposition {
    if no_show_penalty_allowed {
        AcceptedBidBondDisposition::SnapshottedNoShowSlashToCreator
    } else {
        AcceptedBidBondDisposition::Refund
    }
}

/// The number of non-bid leading entries in `remaining_accounts` for a
/// bid-settlement path: a Proof-dependency parent occupies slot 0 (see
/// `validate_task_dependency`), so bid accounts start at 1 for those tasks.
/// Audit F-14: EVERY bid-settlement path must use this offset — the accept
/// paths always did, but the reject/expire paths hardcoded indexes 0..2, so a
/// uniform-layout client ([parent, bid…]) was misread there (fail-closed at
/// best). Pure + revert-sensitive.
pub(crate) fn bid_settlement_offset(task: &Task) -> usize {
    match task.dependency_type {
        DependencyType::Proof => 1,
        _ => 0,
    }
}

/// Completion paths must present a parent for every dependency type. Exit/reject
/// paths continue using `bid_settlement_offset`, which only preserves the legacy
/// Proof slot and never makes a speculative Data/Ordering child depend on its
/// parent merely to unwind.
pub(crate) fn bid_completion_settlement_offset(task: &Task) -> usize {
    match task.dependency_type {
        DependencyType::None => 0,
        DependencyType::Data | DependencyType::Ordering | DependencyType::Proof => 1,
    }
}

fn validate_bid_settlement_accounts<'info>(
    task_key: &Pubkey,
    claim: &TaskClaim,
    bid_book_info: &AccountInfo<'info>,
    accepted_bid_info: &AccountInfo<'info>,
    bid_book: &TaskBidBook,
    accepted_bid: &TaskBid,
    bidder_market_state: &BidderMarketState,
    bidder_authority_info: &AccountInfo<'info>,
) -> Result<()> {
    require!(bid_book.task == *task_key, CoordinationError::InvalidInput);
    require!(
        bid_book.state == BidBookState::Accepted,
        CoordinationError::BidBookNotAccepted
    );
    require!(
        accepted_bid.task == *task_key,
        CoordinationError::InvalidInput
    );
    require!(
        accepted_bid.bid_book == bid_book_info.key(),
        CoordinationError::InvalidInput
    );
    require!(
        accepted_bid.bidder == claim.worker,
        CoordinationError::InvalidInput
    );
    require!(
        accepted_bid.state == TaskBidState::Accepted,
        CoordinationError::BidBookNotAccepted
    );
    require!(
        bid_book.accepted_bid == Some(accepted_bid_info.key()),
        CoordinationError::BidBookNotAccepted
    );
    require!(
        bidder_market_state.bidder == claim.worker,
        CoordinationError::InvalidInput
    );
    require!(
        accepted_bid.bidder_authority == bidder_authority_info.key(),
        CoordinationError::UnauthorizedAgent
    );
    Ok(())
}

fn load_accepted_bid_settlement_accounts<'info>(
    task_key: &Pubkey,
    claim: &TaskClaim,
    bid_book_info: &AccountInfo<'info>,
    accepted_bid_info: &AccountInfo<'info>,
    bidder_market_state_info: &AccountInfo<'info>,
    bidder_authority_info: &AccountInfo<'info>,
) -> Result<(TaskBidBook, TaskBid, BidderMarketState)> {
    require!(
        bid_book_info.is_writable
            && accepted_bid_info.is_writable
            && bidder_market_state_info.is_writable
            && bidder_authority_info.is_writable,
        CoordinationError::InvalidInput
    );
    require!(
        bid_book_info.owner == &crate::ID
            && accepted_bid_info.owner == &crate::ID
            && bidder_market_state_info.owner == &crate::ID,
        CoordinationError::InvalidAccountOwner
    );

    let bid_book = deserialize_program_account::<TaskBidBook>(bid_book_info)?;
    let accepted_bid = deserialize_program_account::<TaskBid>(accepted_bid_info)?;
    let bidder_market_state =
        deserialize_program_account::<BidderMarketState>(bidder_market_state_info)?;

    validate_bid_settlement_accounts(
        task_key,
        claim,
        bid_book_info,
        accepted_bid_info,
        &bid_book,
        &accepted_bid,
        &bidder_market_state,
        bidder_authority_info,
    )?;

    Ok((bid_book, accepted_bid, bidder_market_state))
}

/// Load and fully bind an accepted bid before any escrow payout uses its price.
/// Settlement callers must not deserialize only the `TaskBid`: the accepted book,
/// claim worker, bidder state, and authority are all part of the authorization
/// chain that makes `requested_reward_lamports` the actual contract amount.
pub(crate) fn load_accepted_bid_contract_price<'info>(
    task_key: &Pubkey,
    claim: &TaskClaim,
    bid_book_info: &AccountInfo<'info>,
    accepted_bid_info: &AccountInfo<'info>,
    bidder_market_state_info: &AccountInfo<'info>,
    bidder_authority_info: &AccountInfo<'info>,
) -> Result<u64> {
    let (_, accepted_bid, _) = load_accepted_bid_settlement_accounts(
        task_key,
        claim,
        bid_book_info,
        accepted_bid_info,
        bidder_market_state_info,
        bidder_authority_info,
    )?;
    Ok(accepted_bid.requested_reward_lamports)
}

fn calculate_bid_bond_slash_amount(bond_lamports: u64, slash_bps: u16) -> Result<u64> {
    require!(slash_bps <= 10_000, CoordinationError::InvalidInput);
    let slash_amount = (bond_lamports as u128)
        .checked_mul(slash_bps as u128)
        .ok_or(CoordinationError::ArithmeticOverflow)?
        .checked_div(10_000u128)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    u64::try_from(slash_amount).map_err(|_| CoordinationError::ArithmeticOverflow.into())
}

fn apply_bid_book_disposition(
    bid_book: &mut TaskBidBook,
    now: i64,
    disposition: AcceptedBidBookDisposition,
) -> Result<()> {
    bid_book.active_bids = bid_book
        .active_bids
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bid_book.state = match disposition {
        AcceptedBidBookDisposition::Close => BidBookState::Closed,
        AcceptedBidBookDisposition::Reopen => BidBookState::Open,
    };
    if disposition == AcceptedBidBookDisposition::Reopen {
        bid_book.accepted_bid = None;
    }
    bid_book.version = bid_book
        .version
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bid_book.updated_at = now;
    Ok(())
}

fn decrement_bidder_active_bid_count(bidder_market_state: &mut BidderMarketState) -> Result<()> {
    bidder_market_state.active_bid_count = bidder_market_state
        .active_bid_count
        .checked_sub(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    Ok(())
}

pub(crate) fn load_bid_task_completion_meta(
    task: &Task,
    task_key: &Pubkey,
    claim: &TaskClaim,
    remaining_accounts: &[AccountInfo<'_>],
) -> Result<Option<BidTaskCompletionMeta>> {
    if task.task_type != TaskType::BidExclusive {
        return Ok(None);
    }

    let offset = bid_completion_settlement_offset(task);
    let min_accounts = offset
        .checked_add(4)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    require!(
        remaining_accounts.len() >= min_accounts,
        CoordinationError::BidSettlementAccountsRequired
    );

    let accepted_bid_index = offset
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let bidder_state_index = offset
        .checked_add(2)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let bidder_authority_index = offset
        .checked_add(3)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let bid_book_info = remaining_account_at(
        remaining_accounts,
        offset,
        CoordinationError::BidSettlementAccountsRequired,
    )?;
    let accepted_bid_info = remaining_account_at(
        remaining_accounts,
        accepted_bid_index,
        CoordinationError::BidSettlementAccountsRequired,
    )?;
    let bidder_market_state_info = remaining_account_at(
        remaining_accounts,
        bidder_state_index,
        CoordinationError::BidSettlementAccountsRequired,
    )?;
    let bidder_authority_info = remaining_account_at(
        remaining_accounts,
        bidder_authority_index,
        CoordinationError::BidSettlementAccountsRequired,
    )?;

    let (_, accepted_bid, _) = load_accepted_bid_settlement_accounts(
        task_key,
        claim,
        bid_book_info,
        accepted_bid_info,
        bidder_market_state_info,
        bidder_authority_info,
    )?;

    Ok(Some(BidTaskCompletionMeta {
        settlement_offset: offset,
        accepted_bid_price: accepted_bid.requested_reward_lamports,
    }))
}

pub(crate) fn finalize_bid_task_completion(
    remaining_accounts: &[AccountInfo<'_>],
    task_key: &Pubkey,
    claim: &TaskClaim,
    meta: &BidTaskCompletionMeta,
    now: i64,
) -> Result<()> {
    let accepted_bid_index = meta
        .settlement_offset
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let bidder_state_index = meta
        .settlement_offset
        .checked_add(2)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let bidder_authority_index = meta
        .settlement_offset
        .checked_add(3)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let bid_book_info = remaining_account_at(
        remaining_accounts,
        meta.settlement_offset,
        CoordinationError::BidSettlementAccountsRequired,
    )?;
    let accepted_bid_info = remaining_account_at(
        remaining_accounts,
        accepted_bid_index,
        CoordinationError::BidSettlementAccountsRequired,
    )?;
    let bidder_market_state_info = remaining_account_at(
        remaining_accounts,
        bidder_state_index,
        CoordinationError::BidSettlementAccountsRequired,
    )?;
    let bidder_authority_info = remaining_account_at(
        remaining_accounts,
        bidder_authority_index,
        CoordinationError::BidSettlementAccountsRequired,
    )?;

    settle_accepted_bid(
        task_key,
        claim,
        bid_book_info,
        accepted_bid_info,
        bidder_market_state_info,
        bidder_authority_info.clone(),
        None,
        now,
        AcceptedBidBookDisposition::Close,
        AcceptedBidBondDisposition::Refund,
    )?;

    Ok(())
}

pub(crate) fn close_bid_book_without_accepted_bid(
    task_key: &Pubkey,
    bid_book_info: &AccountInfo<'_>,
    now: i64,
) -> Result<()> {
    let (expected_bid_book, _) =
        Pubkey::find_program_address(&[b"bid_book", task_key.as_ref()], &crate::ID);
    require!(
        bid_book_info.key() == expected_bid_book,
        CoordinationError::InvalidInput
    );

    // A BidExclusive task can exist before `initialize_bid_book` is ever called.
    // Cancellation is an exit path and must not require creating new marketplace
    // state first. Treat the canonical empty system-owned PDA as an absent book.
    // Do not require zero lamports: anyone may pre-fund a PDA, and accepting an
    // empty pre-funded system account avoids turning a 1-lamport donation into a
    // permanent cancellation DoS.
    if bid_book_info.owner == &anchor_lang::system_program::ID && bid_book_info.data_is_empty() {
        return Ok(());
    }

    require!(bid_book_info.is_writable, CoordinationError::InvalidInput);
    require!(
        bid_book_info.owner == &crate::ID,
        CoordinationError::InvalidAccountOwner
    );

    let mut bid_book = deserialize_program_account::<TaskBidBook>(bid_book_info)?;
    require!(bid_book.task == *task_key, CoordinationError::InvalidInput);

    bid_book.state = BidBookState::Closed;
    bid_book.version = bid_book
        .version
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    bid_book.updated_at = now;

    persist_program_account(bid_book_info, &bid_book)?;

    Ok(())
}

pub(crate) fn settle_accepted_bid<'info>(
    task_key: &Pubkey,
    claim: &TaskClaim,
    bid_book_info: &AccountInfo<'info>,
    accepted_bid_info: &AccountInfo<'info>,
    bidder_market_state_info: &AccountInfo<'info>,
    bidder_authority_info: AccountInfo<'info>,
    creator_info: Option<AccountInfo<'info>>,
    now: i64,
    book_disposition: AcceptedBidBookDisposition,
    bond_disposition: AcceptedBidBondDisposition,
) -> Result<()> {
    let (mut bid_book, accepted_bid, mut bidder_market_state) =
        load_accepted_bid_settlement_accounts(
            task_key,
            claim,
            bid_book_info,
            accepted_bid_info,
            bidder_market_state_info,
            &bidder_authority_info,
        )?;

    let slash_amount = match bond_disposition {
        AcceptedBidBondDisposition::Refund => 0,
        AcceptedBidBondDisposition::FullSlashToCreator => accepted_bid.bond_lamports,
        AcceptedBidBondDisposition::SnapshottedNoShowSlashToCreator => {
            calculate_bid_bond_slash_amount(
                accepted_bid.bond_lamports,
                accepted_bid.accepted_no_show_slash_bps,
            )?
        }
    };

    if slash_amount > 0 {
        let creator_info = creator_info.ok_or(CoordinationError::InvalidCreator)?;
        require!(creator_info.is_writable, CoordinationError::InvalidInput);
        transfer_lamports(accepted_bid_info, &creator_info, slash_amount)?;
    }

    apply_bid_book_disposition(&mut bid_book, now, book_disposition)?;
    decrement_bidder_active_bid_count(&mut bidder_market_state)?;
    persist_program_account(bid_book_info, &bid_book)?;
    persist_program_account(bidder_market_state_info, &bidder_market_state)?;
    close_program_account(accepted_bid_info, &bidder_authority_info)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Audit F-14 (revert-sensitive): every bid-settlement path must honor the
    // Proof-dependency offset. Reverting to hardcoded 0 breaks the Proof case.
    #[test]
    fn bid_settlement_offset_matches_dependency_type() {
        let mut task = Task {
            dependency_type: DependencyType::None,
            ..Task::default()
        };
        assert_eq!(bid_settlement_offset(&task), 0);
        task.dependency_type = DependencyType::Data;
        assert_eq!(bid_settlement_offset(&task), 0);
        task.dependency_type = DependencyType::Ordering;
        assert_eq!(bid_settlement_offset(&task), 0);
        task.dependency_type = DependencyType::Proof;
        assert_eq!(bid_settlement_offset(&task), 1);
    }

    #[test]
    fn bid_completion_offset_reserves_parent_for_every_dependency() {
        let mut task = Task::default();
        assert_eq!(bid_completion_settlement_offset(&task), 0);
        for dependency_type in [
            DependencyType::Data,
            DependencyType::Ordering,
            DependencyType::Proof,
        ] {
            task.dependency_type = dependency_type;
            assert_eq!(bid_completion_settlement_offset(&task), 1);
        }
    }

    #[test]
    fn test_calculate_bid_bond_slash_amount() {
        assert_eq!(
            calculate_bid_bond_slash_amount(1_000_000, 2_500).unwrap(),
            250_000
        );
        assert_eq!(calculate_bid_bond_slash_amount(1_000_000, 0).unwrap(), 0);
        assert_eq!(
            calculate_bid_bond_slash_amount(1_000_000, 10_000).unwrap(),
            1_000_000
        );
        assert_eq!(
            calculate_bid_bond_slash_amount(u64::MAX, 10_000).unwrap(),
            u64::MAX
        );
        assert!(calculate_bid_bond_slash_amount(u64::MAX, 10_001).is_err());
    }

    #[test]
    fn accepted_bid_no_show_policy_is_partial_and_evidence_gated() {
        assert_eq!(
            accepted_bid_no_show_bond_disposition(true),
            AcceptedBidBondDisposition::SnapshottedNoShowSlashToCreator,
        );
        assert_eq!(
            accepted_bid_no_show_bond_disposition(false),
            AcceptedBidBondDisposition::Refund,
        );
        assert_ne!(
            accepted_bid_no_show_bond_disposition(true),
            AcceptedBidBondDisposition::FullSlashToCreator,
        );
    }

    #[test]
    fn cancel_accepts_a_never_initialized_canonical_bid_book() {
        let task_key = Pubkey::new_unique();
        let (book_key, _) =
            Pubkey::find_program_address(&[b"bid_book", task_key.as_ref()], &crate::ID);
        // Prefunding must not turn the absent-book proof into a cancellation DoS.
        let mut lamports = 1u64;
        let mut data: [u8; 0] = [];
        let book_info = AccountInfo::new(
            &book_key,
            false,
            false,
            &mut lamports,
            &mut data,
            &anchor_lang::system_program::ID,
            false,
            0,
        );

        close_bid_book_without_accepted_bid(&task_key, &book_info, 100).unwrap();
        assert_eq!(book_info.lamports(), 1);
    }

    #[test]
    fn cancel_rejects_a_foreign_empty_account_as_the_bid_book() {
        let task_key = Pubkey::new_unique();
        let foreign_key = Pubkey::new_unique();
        let mut lamports = 0u64;
        let mut data: [u8; 0] = [];
        let book_info = AccountInfo::new(
            &foreign_key,
            false,
            false,
            &mut lamports,
            &mut data,
            &anchor_lang::system_program::ID,
            false,
            0,
        );

        assert!(close_bid_book_without_accepted_bid(&task_key, &book_info, 100).is_err());
    }

    #[test]
    fn test_apply_bid_book_disposition_close_preserves_accepted_bid() {
        let accepted_bid = Pubkey::new_unique();
        let mut bid_book = TaskBidBook {
            state: BidBookState::Accepted,
            accepted_bid: Some(accepted_bid),
            version: 4,
            active_bids: 3,
            updated_at: 10,
            ..TaskBidBook::default()
        };

        apply_bid_book_disposition(&mut bid_book, 42, AcceptedBidBookDisposition::Close).unwrap();

        assert!(bid_book.state == BidBookState::Closed);
        assert_eq!(bid_book.accepted_bid, Some(accepted_bid));
        assert_eq!(bid_book.active_bids, 2);
        assert_eq!(bid_book.version, 5);
        assert_eq!(bid_book.updated_at, 42);
    }

    #[test]
    fn test_apply_bid_book_disposition_reopen_clears_accepted_bid() {
        let mut bid_book = TaskBidBook {
            state: BidBookState::Accepted,
            accepted_bid: Some(Pubkey::new_unique()),
            version: 9,
            active_bids: 1,
            updated_at: 10,
            ..TaskBidBook::default()
        };

        apply_bid_book_disposition(&mut bid_book, 77, AcceptedBidBookDisposition::Reopen).unwrap();

        assert!(bid_book.state == BidBookState::Open);
        assert_eq!(bid_book.accepted_bid, None);
        assert_eq!(bid_book.active_bids, 0);
        assert_eq!(bid_book.version, 10);
        assert_eq!(bid_book.updated_at, 77);
    }

    #[test]
    fn accepted_bid_settlement_unlocks_exactly_one_bidder_slot() {
        let mut bidder_state = BidderMarketState {
            active_bid_count: 1,
            ..BidderMarketState::default()
        };
        decrement_bidder_active_bid_count(&mut bidder_state).unwrap();
        assert_eq!(bidder_state.active_bid_count, 0);

        // A duplicate settle must fail instead of wrapping and manufacturing an
        // enormous active-bid count. The bid account close in settle_accepted_bid
        // independently prevents the real instruction from being replayed.
        assert!(decrement_bidder_active_bid_count(&mut bidder_state).is_err());
        assert_eq!(bidder_state.active_bid_count, 0);
    }
}
