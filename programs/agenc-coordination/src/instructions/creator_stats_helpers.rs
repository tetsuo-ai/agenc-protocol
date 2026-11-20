//! Revision 9 (E): wallet-keyed `CreatorStats` records, and the dispute
//! outcome rule shared by worker and creator records.
//!
//! `CreatorStats` (PDA `["creator_stats", wallet]`) mirrors `AgentStats` for the
//! task creator. A Task stores only the creator's wallet, so the record is keyed
//! by that wallet and covers bare-wallet buyers and agent buyers alike. Like
//! `AgentStats`, it is telemetry: it never gates settlement.
//!
//! The pure functions here are unit-testable on their own. Each increment is
//! checked (it errors on overflow instead of wrapping).

#![cfg(not(feature = "mainnet-canary"))]

use crate::errors::CoordinationError;
use crate::events::{CreatorRecordCounter, CreatorTrackRecordUpdated};
use crate::instructions::agent_stats_helpers::Counter;
use crate::state::{CreatorStats, ResolutionType};
use anchor_lang::prelude::*;

/// The six counters on `CreatorStats`. Maps 1:1 to its fields and to
/// `CreatorRecordCounter` in the emitted event.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CreatorCounter {
    Rejections,
    RejectionsContested,
    DisputesWon,
    DisputesLost,
    Cancels,
    DepositsReceived,
}

impl CreatorCounter {
    fn event_variant(self) -> CreatorRecordCounter {
        match self {
            CreatorCounter::Rejections => CreatorRecordCounter::Rejections,
            CreatorCounter::RejectionsContested => CreatorRecordCounter::RejectionsContested,
            CreatorCounter::DisputesWon => CreatorRecordCounter::DisputesWon,
            CreatorCounter::DisputesLost => CreatorRecordCounter::DisputesLost,
            CreatorCounter::Cancels => CreatorRecordCounter::Cancels,
            CreatorCounter::DepositsReceived => CreatorRecordCounter::DepositsReceived,
        }
    }
}

/// Pure, checked increment of one counter. Returns the counter's new value.
pub fn bump_creator_counter(
    stats: &mut CreatorStats,
    counter: CreatorCounter,
    now: i64,
) -> Result<u64> {
    let field = match counter {
        CreatorCounter::Rejections => &mut stats.rejections,
        CreatorCounter::RejectionsContested => &mut stats.rejections_contested,
        CreatorCounter::DisputesWon => &mut stats.disputes_won,
        CreatorCounter::DisputesLost => &mut stats.disputes_lost,
        CreatorCounter::Cancels => &mut stats.cancels,
        CreatorCounter::DepositsReceived => &mut stats.deposits_received,
    };
    *field = field
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    let new_value = *field;
    stats.last_updated = now;
    Ok(new_value)
}

/// Apply one increment to a creator record the handler already bound to
/// `["creator_stats", wallet]` by seeds. Sets the identity on first write and
/// emits `CreatorTrackRecordUpdated`. A record whose stored wallet differs from
/// `wallet` is refused (seeds make that impossible; this is defense in depth).
pub fn apply_creator_record(
    stats: &mut Account<CreatorStats>,
    wallet: Pubkey,
    bump: u8,
    counter: CreatorCounter,
    now: i64,
) -> Result<()> {
    stats.init_if_fresh(wallet, bump);
    require!(
        stats.wallet == wallet && stats.validate_reserved_fields(),
        CoordinationError::InvalidInput
    );
    let stats_key = stats.key();
    let new_value = bump_creator_counter(stats, counter, now)?;
    emit!(CreatorTrackRecordUpdated {
        wallet,
        creator_stats: stats_key,
        counter: counter.event_variant(),
        new_value,
        timestamp: now,
    });
    Ok(())
}

/// Which side a ruling went to, for the records.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DisputeRecordOutcome {
    WorkerWon,
    WorkerLost,
}

impl DisputeRecordOutcome {
    /// The worker's `AgentStats` counter for this outcome.
    pub fn worker_counter(self) -> Counter {
        match self {
            DisputeRecordOutcome::WorkerWon => Counter::DisputesWon,
            DisputeRecordOutcome::WorkerLost => Counter::DisputesLost,
        }
    }

    /// The creator's `CreatorStats` counter: the mirror image.
    pub fn creator_counter(self) -> CreatorCounter {
        match self {
            DisputeRecordOutcome::WorkerWon => CreatorCounter::DisputesLost,
            DisputeRecordOutcome::WorkerLost => CreatorCounter::DisputesWon,
        }
    }
}

/// Outcome rule for task disputes (design section 5.3). Records follow the
/// ruling, not the filer's identity:
/// - the worker wins when the creator filed and the ruling rejected it, or the
///   worker filed and a Complete was approved;
/// - the worker loses when the creator filed and a Refund was approved, or the
///   worker filed and the ruling rejected it;
/// - an approved Split is neutral, and so is any approved filing the rule does
///   not name (a creator-filed Complete, a worker-filed Refund).
///
/// This replaces `worker_track_record_outcome`, which counted every non-loss as
/// a win, so a worker whose own dispute was rejected got `disputes_won`.
pub fn task_dispute_record_outcome(
    initiated_by_creator: bool,
    approved: bool,
    resolution: ResolutionType,
) -> Option<DisputeRecordOutcome> {
    match (initiated_by_creator, approved, resolution) {
        (true, false, _) => Some(DisputeRecordOutcome::WorkerWon),
        (false, true, ResolutionType::Complete) => Some(DisputeRecordOutcome::WorkerWon),
        (true, true, ResolutionType::Refund) => Some(DisputeRecordOutcome::WorkerLost),
        (false, false, _) => Some(DisputeRecordOutcome::WorkerLost),
        _ => None,
    }
}

/// Outcome rule for a multisig ruling on a frozen task: approving the
/// completion is a worker win, upholding the rejection a worker loss.
pub fn rejection_ruling_record_outcome(approve_completion: bool) -> DisputeRecordOutcome {
    if approve_completion {
        DisputeRecordOutcome::WorkerWon
    } else {
        DisputeRecordOutcome::WorkerLost
    }
}

/// A cancelled dispute charges only the filer's record (`disputes_lost`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CancelledDisputeCharge {
    /// The worker filed: its `AgentStats.disputes_lost`.
    Worker,
    /// The creator filed: its `CreatorStats.disputes_lost`.
    Creator,
}

pub fn cancelled_dispute_charge(initiated_by_creator: bool) -> CancelledDisputeCharge {
    if initiated_by_creator {
        CancelledDisputeCharge::Creator
    } else {
        CancelledDisputeCharge::Worker
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> CreatorStats {
        let mut s = CreatorStats::default();
        s.init_if_fresh(Pubkey::new_unique(), 1);
        s
    }

    #[test]
    fn each_creator_counter_moves_only_its_field() {
        let all = [
            CreatorCounter::Rejections,
            CreatorCounter::RejectionsContested,
            CreatorCounter::DisputesWon,
            CreatorCounter::DisputesLost,
            CreatorCounter::Cancels,
            CreatorCounter::DepositsReceived,
        ];
        for counter in all {
            let mut s = fresh();
            assert_eq!(bump_creator_counter(&mut s, counter, 42).unwrap(), 1);
            let fields = [
                s.rejections,
                s.rejections_contested,
                s.disputes_won,
                s.disputes_lost,
                s.cancels,
                s.deposits_received,
            ];
            let moved = all.iter().position(|c| *c == counter).unwrap();
            for (i, v) in fields.iter().enumerate() {
                assert_eq!(*v, u64::from(i == moved), "{counter:?} moved field {i}");
            }
            assert_eq!(s.last_updated, 42);
        }
    }

    #[test]
    fn creator_counters_accumulate_and_refuse_overflow() {
        let mut s = fresh();
        assert_eq!(
            bump_creator_counter(&mut s, CreatorCounter::Cancels, 1).unwrap(),
            1
        );
        assert_eq!(
            bump_creator_counter(&mut s, CreatorCounter::Cancels, 2).unwrap(),
            2
        );
        s.disputes_lost = u64::MAX;
        assert!(bump_creator_counter(&mut s, CreatorCounter::DisputesLost, 3).is_err());
        assert_eq!(s.disputes_lost, u64::MAX);
    }

    // The full truth table of the outcome rule. Revert-sensitive: today's
    // `worker_track_record_outcome` gives `DisputesWon` for a worker's own
    // rejected dispute; that row is `WorkerLost` here.
    #[test]
    fn task_dispute_outcome_rule_truth_table() {
        use DisputeRecordOutcome::*;
        use ResolutionType::*;
        let cases = [
            // (creator filed, approved, resolution, expected)
            (true, false, Refund, Some(WorkerWon)),
            (true, false, Complete, Some(WorkerWon)),
            (true, false, Split, Some(WorkerWon)),
            (true, true, Refund, Some(WorkerLost)),
            (true, true, Complete, None),
            (true, true, Split, None),
            (false, true, Complete, Some(WorkerWon)),
            (false, true, Refund, None),
            (false, true, Split, None),
            (false, false, Complete, Some(WorkerLost)),
            (false, false, Refund, Some(WorkerLost)),
            (false, false, Split, Some(WorkerLost)),
        ];
        for (by_creator, approved, resolution, expected) in cases {
            assert_eq!(
                task_dispute_record_outcome(by_creator, approved, resolution),
                expected,
                "creator filed={by_creator} approved={approved} {:?}",
                resolution as u8
            );
        }
    }

    #[test]
    fn creator_counters_mirror_the_worker_outcome() {
        assert_eq!(
            DisputeRecordOutcome::WorkerWon.worker_counter(),
            Counter::DisputesWon
        );
        assert_eq!(
            DisputeRecordOutcome::WorkerWon.creator_counter(),
            CreatorCounter::DisputesLost
        );
        assert_eq!(
            DisputeRecordOutcome::WorkerLost.worker_counter(),
            Counter::DisputesLost
        );
        assert_eq!(
            DisputeRecordOutcome::WorkerLost.creator_counter(),
            CreatorCounter::DisputesWon
        );
    }

    #[test]
    fn rejection_ruling_and_cancel_rules() {
        assert_eq!(
            rejection_ruling_record_outcome(true),
            DisputeRecordOutcome::WorkerWon
        );
        assert_eq!(
            rejection_ruling_record_outcome(false),
            DisputeRecordOutcome::WorkerLost
        );
        assert_eq!(
            cancelled_dispute_charge(true),
            CancelledDisputeCharge::Creator
        );
        assert_eq!(
            cancelled_dispute_charge(false),
            CancelledDisputeCharge::Worker
        );
    }
}
