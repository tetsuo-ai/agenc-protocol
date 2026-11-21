//! Revision 9 (B): dispute bonds.
//!
//! Every dispute costs the filer a bond of `max(10% of the disputed amount,
//! 0.01 SOL)`, held as lamports above the rent of a `DisputeBond` account at
//! `["dispute_bond", subject]` (subject = the task for a dispute of a
//! rejection, the Dispute account for a task dispute). The loser's principal
//! goes to the winner; the rent always goes back to the filer.
//!
//! "No bond" is decided by ownership, never by balance: a system-owned account
//! with no data at the canonical bond address is "no bond" (a task dispute
//! filed before the upgrade, or an undisputed freeze). Anyone can send lamports
//! to that address, so a lamport test would let a stranger block a refund. Such
//! lamports are not the program's to move and are left untouched.

#![cfg(not(feature = "mainnet-canary"))]

use crate::errors::CoordinationError;
use crate::events::DisputeBondSettled;
use crate::instructions::claim_deposit_helpers::{bps_with_floor, sol_worker_share_lamports};
use crate::instructions::constants::{DISPUTE_BOND_BPS, MIN_DISPUTE_BOND_LAMPORTS};
use crate::state::{DisputeBond, Task};
use anchor_lang::prelude::*;

/// Bond for a disputed amount: `max(amount x 1,000 / 10,000, 10,000,000)`.
pub fn dispute_bond_lamports(disputed_amount: u64) -> Result<u64> {
    bps_with_floor(disputed_amount, DISPUTE_BOND_BPS, MIN_DISPUTE_BOND_LAMPORTS)
}

/// The bond a filer posts on this task: 10% of the task reward for a
/// single-worker task, of the defendant's share for a Collaborative task, with
/// the 0.01 SOL floor. A token-reward task pays the floor. On a BidExclusive
/// task the reward is the creator's budget, at least the accepted price (a bid
/// may ask up to it): the price lives on the TaskBid, which `initiate_dispute`
/// does not read, so the bond can only be higher than 10% of the price, never
/// lower (review R2-11; 0 live bid tasks).
pub fn dispute_bond_for_task(task: &Task) -> Result<u64> {
    dispute_bond_lamports(sol_worker_share_lamports(task)?)
}

/// How a bonded dispute ended (design section 2.2, bond table).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BondEnding {
    /// A ruling upheld the filer (an approval, including an approved Split).
    FilerUpheld,
    /// A ruling went against the filer.
    FilerRejected,
    /// No ruling before the window closed.
    Unruled,
    /// The filer cancelled its own dispute.
    FilerCancelled,
}

/// Where the bond principal goes. The rent always goes to the filer.
pub fn bond_principal_goes_to_filer(ending: BondEnding) -> bool {
    match ending {
        BondEnding::FilerUpheld | BondEnding::Unruled => true,
        BondEnding::FilerRejected | BondEnding::FilerCancelled => false,
    }
}

/// The result of settling a bond address.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct BondSettlement {
    /// False when the address held no bond (nothing moved).
    pub bonded: bool,
    /// Principal moved to `principal_recipient`.
    pub amount: u64,
    /// Who received the principal (default pubkey when there was no bond).
    pub principal_recipient: Pubkey,
}

impl BondSettlement {
    const NONE: Self = Self {
        bonded: false,
        amount: 0,
        principal_recipient: Pubkey::new_from_array([0u8; 32]),
    };
}

/// The canonical bond address for a subject (task or Dispute account).
pub fn dispute_bond_address(subject: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[DisputeBond::SEED, subject.as_ref()], &crate::ID)
}

/// True when the account is "no bond": system-owned with zero data. Balance is
/// deliberately ignored (see the module note).
pub fn is_empty_bond_address(bond_info: &AccountInfo) -> bool {
    bond_info.owner == &anchor_lang::system_program::ID && bond_info.data_is_empty()
}

/// Load and fully validate a live bond: owner, discriminator, canonical seeds
/// and bump, kind, subject, task and reserved bytes.
pub fn load_live_dispute_bond(
    bond_info: &AccountInfo,
    subject: &Pubkey,
    task: &Pubkey,
    expected_kind: u8,
) -> Result<DisputeBond> {
    let (expected_address, expected_bump) = dispute_bond_address(subject);
    require!(
        bond_info.key() == expected_address,
        CoordinationError::InvalidDisputeBond
    );
    require!(
        bond_info.owner == &crate::ID,
        CoordinationError::InvalidDisputeBond
    );
    let bond = {
        let data = bond_info.try_borrow_data()?;
        DisputeBond::try_deserialize(&mut &data[..])
            .map_err(|_| error!(CoordinationError::InvalidDisputeBond))?
    };
    require!(
        bond.bump == expected_bump
            && bond.kind == expected_kind
            && bond.subject == *subject
            && bond.task == *task
            && bond.validate_reserved_fields(),
        CoordinationError::InvalidDisputeBond
    );
    Ok(bond)
}

/// Settle the bond at `bond_info` for `subject`.
///
/// - The canonical empty system account means "no bond": nothing moves.
/// - A live bond is validated (`load_live_dispute_bond`), the filer and
///   respondent accounts must equal the stored wallets, the principal moves
///   to the filer or the respondent by `ending`, everything left (rent, plus
///   any lamports donated to the address) goes to the filer, and the account
///   is tombstoned (`[255; 8]`), the same pattern as `close_task`.
/// - Anything else at the address fails with `InvalidDisputeBond`.
pub fn settle_dispute_bond<'info>(
    bond_info: &AccountInfo<'info>,
    subject: &Pubkey,
    task: &Pubkey,
    expected_kind: u8,
    filer_info: &AccountInfo<'info>,
    respondent_info: &AccountInfo<'info>,
    ending: BondEnding,
    now: i64,
) -> Result<BondSettlement> {
    let (expected_address, _) = dispute_bond_address(subject);
    require!(
        bond_info.key() == expected_address,
        CoordinationError::InvalidDisputeBond
    );
    if is_empty_bond_address(bond_info) {
        return Ok(BondSettlement::NONE);
    }

    let bond = load_live_dispute_bond(bond_info, subject, task, expected_kind)?;
    require!(
        filer_info.key() == bond.filer && respondent_info.key() == bond.respondent,
        CoordinationError::InvalidDisputeBond
    );
    require!(
        bond_info.is_writable && filer_info.is_writable,
        CoordinationError::InvalidDisputeBond
    );

    let to_filer = bond_principal_goes_to_filer(ending);
    let principal_recipient = if to_filer {
        bond.filer
    } else {
        require!(
            respondent_info.is_writable,
            CoordinationError::InvalidDisputeBond
        );
        bond.respondent
    };

    // Principal leaves first (to the respondent when the filer lost); the
    // remaining balance, which is the rent plus the principal when the filer
    // keeps it, then goes to the filer.
    let total = bond_info.lamports();
    require!(total >= bond.amount, CoordinationError::InvalidDisputeBond);
    if !to_filer && bond.amount > 0 {
        **bond_info.try_borrow_mut_lamports()? = total
            .checked_sub(bond.amount)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        **respondent_info.try_borrow_mut_lamports()? = respondent_info
            .lamports()
            .checked_add(bond.amount)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
    }
    let remaining = bond_info.lamports();
    **bond_info.try_borrow_mut_lamports()? = 0;
    **filer_info.try_borrow_mut_lamports()? = filer_info
        .lamports()
        .checked_add(remaining)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    {
        let mut data = bond_info.try_borrow_mut_data()?;
        data.fill(0);
        data[..8].copy_from_slice(&[255u8; 8]);
    }

    emit!(DisputeBondSettled {
        subject: *subject,
        kind: bond.kind,
        recipient: principal_recipient,
        amount: bond.amount,
        timestamp: now,
    });

    Ok(BondSettlement {
        bonded: true,
        amount: bond.amount,
        principal_recipient,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::TaskType;

    #[test]
    fn bond_is_ten_percent_with_a_centisol_floor() {
        // P = 0.1 SOL: the floor (0.01 SOL) equals 10%.
        assert_eq!(dispute_bond_lamports(100_000_000).unwrap(), 10_000_000);
        // P = 1 SOL: 10%.
        assert_eq!(dispute_bond_lamports(1_000_000_000).unwrap(), 100_000_000);
        // P = 0.005 SOL: the floor is twice the price.
        assert_eq!(dispute_bond_lamports(5_000_000).unwrap(), 10_000_000);
        assert_eq!(dispute_bond_lamports(0).unwrap(), 10_000_000);
        assert_eq!(dispute_bond_lamports(100_000_010).unwrap(), 10_000_001);
    }

    #[test]
    fn bond_uses_the_collaborative_share() {
        let collab = Task {
            task_type: TaskType::Collaborative,
            reward_amount: 3_000_000_000,
            required_completions: 3,
            ..Task::default()
        };
        // Share 1 SOL -> bond 0.1 SOL.
        assert_eq!(dispute_bond_for_task(&collab).unwrap(), 100_000_000);
        let exclusive = Task {
            reward_amount: 3_000_000_000,
            ..Task::default()
        };
        assert_eq!(dispute_bond_for_task(&exclusive).unwrap(), 300_000_000);
    }

    // Design section 2.2 bond table, principal column.
    #[test]
    fn bond_disposition_table() {
        assert!(bond_principal_goes_to_filer(BondEnding::FilerUpheld));
        assert!(bond_principal_goes_to_filer(BondEnding::Unruled));
        assert!(!bond_principal_goes_to_filer(BondEnding::FilerRejected));
        assert!(!bond_principal_goes_to_filer(BondEnding::FilerCancelled));
    }

    fn info<'a>(
        key: &'a Pubkey,
        owner: &'a Pubkey,
        lamports: &'a mut u64,
        data: &'a mut [u8],
        writable: bool,
    ) -> AccountInfo<'a> {
        AccountInfo::new(key, false, writable, lamports, data, owner, false, 0)
    }

    fn bond_bytes(bond: &DisputeBond) -> Vec<u8> {
        let mut data = Vec::new();
        bond.try_serialize(&mut data).unwrap();
        data.resize(DisputeBond::SIZE, 0);
        data
    }

    // "No bond" is ownership-based: a pre-funded empty system account at the
    // canonical address settles as no bond and its lamports stay put.
    #[test]
    fn prefunded_empty_bond_address_is_no_bond() {
        let subject = Pubkey::new_unique();
        let task = Pubkey::new_unique();
        let (bond_key, _) = dispute_bond_address(&subject);
        let system = anchor_lang::system_program::ID;
        let (filer_key, respondent_key) = (Pubkey::new_unique(), Pubkey::new_unique());
        let mut bond_lamports = 7_777_777u64;
        let mut bond_data: [u8; 0] = [];
        let bond = info(&bond_key, &system, &mut bond_lamports, &mut bond_data, true);
        let (mut fl, mut rl) = (1u64, 2u64);
        let (mut fd, mut rd): ([u8; 0], [u8; 0]) = ([], []);
        let filer = info(&filer_key, &system, &mut fl, &mut fd, true);
        let respondent = info(&respondent_key, &system, &mut rl, &mut rd, true);
        assert!(is_empty_bond_address(&bond));
        let out = settle_dispute_bond(
            &bond,
            &subject,
            &task,
            DisputeBond::KIND_REJECTION,
            &filer,
            &respondent,
            BondEnding::FilerRejected,
            5,
        )
        .unwrap();
        assert_eq!(out, BondSettlement::NONE);
        assert_eq!(
            bond.lamports(),
            7_777_777,
            "donated lamports are not ours to move"
        );
        assert_eq!(filer.lamports(), 1);
        assert_eq!(respondent.lamports(), 2);

        // A non-canonical address is refused even when empty.
        let other = Pubkey::new_unique();
        let mut ol = 0u64;
        let mut od: [u8; 0] = [];
        let wrong = info(&other, &system, &mut ol, &mut od, true);
        assert!(settle_dispute_bond(
            &wrong,
            &subject,
            &task,
            DisputeBond::KIND_REJECTION,
            &filer,
            &respondent,
            BondEnding::Unruled,
            5,
        )
        .is_err());
    }

    fn live_bond(subject: Pubkey, task: Pubkey, filer: Pubkey, respondent: Pubkey) -> DisputeBond {
        let (_, bump) = dispute_bond_address(&subject);
        DisputeBond {
            subject,
            task,
            filer,
            respondent,
            amount: 10_000_000,
            kind: DisputeBond::KIND_REJECTION,
            filed_at: 1,
            ruling_deadline: 2,
            bump,
            _reserved: [0u8; 24],
        }
    }

    // Exact lamport movement for every ending: principal by the table, the
    // rest (rent plus any donation) to the filer, and the account tombstoned.
    #[test]
    fn settle_moves_exact_lamports_for_every_ending() {
        const RENT: u64 = 1_595_120;
        const DONATION: u64 = 3;
        for ending in [
            BondEnding::FilerUpheld,
            BondEnding::FilerRejected,
            BondEnding::Unruled,
            BondEnding::FilerCancelled,
        ] {
            let subject = Pubkey::new_unique();
            let task = subject;
            let (filer_key, respondent_key) = (Pubkey::new_unique(), Pubkey::new_unique());
            let (bond_key, _) = dispute_bond_address(&subject);
            let program = crate::ID;
            let system = anchor_lang::system_program::ID;
            let bond_state = live_bond(subject, task, filer_key, respondent_key);
            let mut data = bond_bytes(&bond_state);
            let mut bond_lamports = RENT + 10_000_000 + DONATION;
            let bond = info(&bond_key, &program, &mut bond_lamports, &mut data, true);
            let (mut fl, mut rl) = (100u64, 200u64);
            let (mut fd, mut rd): ([u8; 0], [u8; 0]) = ([], []);
            let filer = info(&filer_key, &system, &mut fl, &mut fd, true);
            let respondent = info(&respondent_key, &system, &mut rl, &mut rd, true);

            let out = settle_dispute_bond(
                &bond,
                &subject,
                &task,
                DisputeBond::KIND_REJECTION,
                &filer,
                &respondent,
                ending,
                9,
            )
            .unwrap();
            assert!(out.bonded);
            assert_eq!(out.amount, 10_000_000);
            assert_eq!(bond.lamports(), 0);
            if bond_principal_goes_to_filer(ending) {
                assert_eq!(out.principal_recipient, filer_key);
                assert_eq!(filer.lamports(), 100 + RENT + 10_000_000 + DONATION);
                assert_eq!(respondent.lamports(), 200);
            } else {
                assert_eq!(out.principal_recipient, respondent_key);
                assert_eq!(filer.lamports(), 100 + RENT + DONATION);
                assert_eq!(respondent.lamports(), 200 + 10_000_000);
            }
            let d = bond.try_borrow_data().unwrap();
            assert_eq!(&d[..8], &[255u8; 8]);
            assert!(d[8..].iter().all(|b| *b == 0));
        }
    }

    #[test]
    fn settle_refuses_wrong_filer_or_respondent() {
        let subject = Pubkey::new_unique();
        let task = subject;
        let (filer_key, respondent_key) = (Pubkey::new_unique(), Pubkey::new_unique());
        let (bond_key, _) = dispute_bond_address(&subject);
        let program = crate::ID;
        let system = anchor_lang::system_program::ID;
        let mut data = bond_bytes(&live_bond(subject, task, filer_key, respondent_key));
        let mut bl = 11_595_120u64;
        let bond = info(&bond_key, &program, &mut bl, &mut data, true);
        let stranger = Pubkey::new_unique();
        let (mut sl, mut rl, mut fl) = (0u64, 0u64, 0u64);
        let (mut sd, mut rd, mut fd): ([u8; 0], [u8; 0], [u8; 0]) = ([], [], []);
        let stranger_info = info(&stranger, &system, &mut sl, &mut sd, true);
        let respondent = info(&respondent_key, &system, &mut rl, &mut rd, true);
        let filer = info(&filer_key, &system, &mut fl, &mut fd, true);
        for (f, r) in [(&stranger_info, &respondent), (&filer, &stranger_info)] {
            assert!(settle_dispute_bond(
                &bond,
                &subject,
                &task,
                DisputeBond::KIND_REJECTION,
                f,
                r,
                BondEnding::FilerRejected,
                1,
            )
            .is_err());
        }
        assert_eq!(
            bond.lamports(),
            11_595_120,
            "a refused settle moves nothing"
        );
    }

    #[test]
    fn live_bond_load_checks_seeds_kind_subject_task_and_reserved() {
        let subject = Pubkey::new_unique();
        let task = Pubkey::new_unique();
        let (bond_key, bump) = dispute_bond_address(&subject);
        let program = crate::ID;
        let good = DisputeBond {
            subject,
            task,
            filer: Pubkey::new_unique(),
            respondent: Pubkey::new_unique(),
            amount: 10_000_000,
            kind: DisputeBond::KIND_REJECTION,
            filed_at: 1,
            ruling_deadline: 2,
            bump,
            _reserved: [0u8; 24],
        };

        let mut data = bond_bytes(&good);
        let mut lamports = 11_595_120u64;
        let acc = info(&bond_key, &program, &mut lamports, &mut data, true);
        assert!(load_live_dispute_bond(&acc, &subject, &task, DisputeBond::KIND_REJECTION).is_ok());
        // Wrong kind, task or subject.
        assert!(
            load_live_dispute_bond(&acc, &subject, &task, DisputeBond::KIND_TASK_DISPUTE).is_err()
        );
        assert!(load_live_dispute_bond(
            &acc,
            &subject,
            &Pubkey::new_unique(),
            DisputeBond::KIND_REJECTION
        )
        .is_err());
        assert!(load_live_dispute_bond(
            &acc,
            &Pubkey::new_unique(),
            &task,
            DisputeBond::KIND_REJECTION
        )
        .is_err());

        // A tampered reserved byte or bump fails closed.
        let mut tampered = good.clone();
        tampered._reserved[0] = 9;
        let mut d = bond_bytes(&tampered);
        let mut l = 1u64;
        let acc = info(&bond_key, &program, &mut l, &mut d, true);
        assert!(
            load_live_dispute_bond(&acc, &subject, &task, DisputeBond::KIND_REJECTION).is_err()
        );
        let mut tampered = good.clone();
        tampered.bump = bump.wrapping_add(1);
        let mut d = bond_bytes(&tampered);
        let mut l = 1u64;
        let acc = info(&bond_key, &program, &mut l, &mut d, true);
        assert!(
            load_live_dispute_bond(&acc, &subject, &task, DisputeBond::KIND_REJECTION).is_err()
        );

        // Owned by another program: refused.
        let foreign = Pubkey::new_unique();
        let mut d = bond_bytes(&good);
        let mut l = 1u64;
        let acc = info(&bond_key, &foreign, &mut l, &mut d, true);
        assert!(
            load_live_dispute_bond(&acc, &subject, &task, DisputeBond::KIND_REJECTION).is_err()
        );

        // A tombstone (already settled in this transaction) is not "no bond".
        let mut d = vec![0u8; DisputeBond::SIZE];
        d[..8].copy_from_slice(&[255u8; 8]);
        let mut l = 0u64;
        let acc = info(&bond_key, &program, &mut l, &mut d, true);
        assert!(!is_empty_bond_address(&acc));
        assert!(
            load_live_dispute_bond(&acc, &subject, &task, DisputeBond::KIND_REJECTION).is_err()
        );
    }
}
