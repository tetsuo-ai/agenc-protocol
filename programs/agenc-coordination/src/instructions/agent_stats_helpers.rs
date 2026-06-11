//! Shared helpers for the P6.6 track-record counters on `AgentStats`.
//!
//! `AgentStats` (PDA `["agent_stats", agent]`) holds the negative / non-success
//! counters that don't fit in `AgentRegistration`'s 4 reserved bytes. It is created
//! lazily on first write (`init_if_needed` in the handler) and incremented by the
//! exit/rejection/cancel handlers.
//!
//! Design notes:
//! - These counters are reputation TELEMETRY and never gate settlement, so the
//!   `AgentStats` account is passed OPTIONALLY in each full-surface handler. When the
//!   caller supplies it, the relevant counter is folded in with CHECKED arithmetic and
//!   an `AgentTrackRecordUpdated` event is emitted; when absent the handler is a no-op
//!   for the counter (back-compatible: existing call sites keep working unchanged).
//! - The pure `bump_*` functions below are unit-testable in isolation (each is
//!   revert-sensitive: remove a `checked_add`/field write and the matching test goes
//!   red) and saturate-free — they error on overflow rather than silently wrap, even
//!   though `u64` counters realistically never overflow.

#![cfg(not(feature = "mainnet-canary"))]

use crate::errors::CoordinationError;
use crate::events::{AgentTrackRecordUpdated, TrackRecordCounter};
use crate::state::AgentStats;
use anchor_lang::prelude::*;

/// The five counters `apply_track_record` can bump. Maps 1:1 to `AgentStats` fields
/// and to `TrackRecordCounter` in the emitted event.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Counter {
    TasksRejected,
    DisputesWon,
    DisputesLost,
    ClaimsExpired,
    TotalCancelled,
}

impl Counter {
    fn event_variant(self) -> TrackRecordCounter {
        match self {
            Counter::TasksRejected => TrackRecordCounter::TasksRejected,
            Counter::DisputesWon => TrackRecordCounter::DisputesWon,
            Counter::DisputesLost => TrackRecordCounter::DisputesLost,
            Counter::ClaimsExpired => TrackRecordCounter::ClaimsExpired,
            Counter::TotalCancelled => TrackRecordCounter::TotalCancelled,
        }
    }
}

/// Pure, checked increment of the selected counter on an `AgentStats`. Returns the
/// post-increment value of that counter. Errors on overflow (never wraps/saturates).
///
/// Extracted so each counter's increment is unit-testable independently of account
/// wiring (revert-sensitive: drop the `checked_add` and the test turns red).
pub fn bump_counter(stats: &mut AgentStats, counter: Counter, now: i64) -> Result<u64> {
    let new_value = match counter {
        Counter::TasksRejected => {
            stats.tasks_rejected = stats
                .tasks_rejected
                .checked_add(1)
                .ok_or(CoordinationError::ArithmeticOverflow)?;
            stats.tasks_rejected
        }
        Counter::DisputesWon => {
            stats.disputes_won = stats
                .disputes_won
                .checked_add(1)
                .ok_or(CoordinationError::ArithmeticOverflow)?;
            stats.disputes_won
        }
        Counter::DisputesLost => {
            stats.disputes_lost = stats
                .disputes_lost
                .checked_add(1)
                .ok_or(CoordinationError::ArithmeticOverflow)?;
            stats.disputes_lost
        }
        Counter::ClaimsExpired => {
            stats.claims_expired = stats
                .claims_expired
                .checked_add(1)
                .ok_or(CoordinationError::ArithmeticOverflow)?;
            stats.claims_expired
        }
        Counter::TotalCancelled => {
            stats.total_cancelled = stats
                .total_cancelled
                .checked_add(1)
                .ok_or(CoordinationError::ArithmeticOverflow)?;
            stats.total_cancelled
        }
    };
    stats.last_updated = now;
    Ok(new_value)
}

/// Apply a track-record increment for `agent` against an OPTIONAL `AgentStats`
/// account, initializing its identity fields on first write and emitting
/// `AgentTrackRecordUpdated`. No-op (and `Ok`) when the account is not supplied —
/// the counters are telemetry, not a settlement precondition.
///
/// The caller is responsible for binding the supplied account to the correct
/// `["agent_stats", agent]` PDA via Anchor `seeds`/`bump` constraints (see each
/// handler's `#[derive(Accounts)]`), so this helper trusts the bound account.
pub fn apply_track_record(
    agent_stats: &mut Option<Box<Account<AgentStats>>>,
    agent: Pubkey,
    bump: Option<u8>,
    counter: Counter,
    now: i64,
) -> Result<()> {
    let Some(stats) = agent_stats.as_mut() else {
        return Ok(());
    };
    // The account is present, so Anchor resolved its canonical bump.
    let bump = bump.ok_or(CoordinationError::InvalidInput)?;
    stats.init_if_fresh(agent, bump);
    let stats_key = stats.key();
    let new_value = bump_counter(stats.as_mut(), counter, now)?;
    emit!(AgentTrackRecordUpdated {
        agent,
        agent_stats: stats_key,
        counter: counter.event_variant(),
        new_value,
        timestamp: now,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh(agent: Pubkey) -> AgentStats {
        let mut s = AgentStats::default();
        s.init_if_fresh(agent, 1);
        s
    }

    // === Each counter increments exactly its own field (positive) ===

    #[test]
    fn bump_tasks_rejected_increments_only_that_field() {
        let mut s = fresh(Pubkey::new_unique());
        let v = bump_counter(&mut s, Counter::TasksRejected, 100).unwrap();
        assert_eq!(v, 1);
        assert_eq!(s.tasks_rejected, 1);
        // Revert-sensitive: only the targeted field moves.
        assert_eq!(s.disputes_won, 0);
        assert_eq!(s.disputes_lost, 0);
        assert_eq!(s.claims_expired, 0);
        assert_eq!(s.total_cancelled, 0);
        assert_eq!(s.last_updated, 100);
    }

    #[test]
    fn bump_disputes_won_increments_only_that_field() {
        let mut s = fresh(Pubkey::new_unique());
        let v = bump_counter(&mut s, Counter::DisputesWon, 7).unwrap();
        assert_eq!(v, 1);
        assert_eq!(s.disputes_won, 1);
        assert_eq!(s.disputes_lost, 0);
        assert_eq!(s.tasks_rejected, 0);
    }

    #[test]
    fn bump_disputes_lost_increments_only_that_field() {
        let mut s = fresh(Pubkey::new_unique());
        let v = bump_counter(&mut s, Counter::DisputesLost, 7).unwrap();
        assert_eq!(v, 1);
        assert_eq!(s.disputes_lost, 1);
        assert_eq!(s.disputes_won, 0);
    }

    #[test]
    fn bump_claims_expired_increments_only_that_field() {
        let mut s = fresh(Pubkey::new_unique());
        let v = bump_counter(&mut s, Counter::ClaimsExpired, 7).unwrap();
        assert_eq!(v, 1);
        assert_eq!(s.claims_expired, 1);
        assert_eq!(s.total_cancelled, 0);
    }

    #[test]
    fn bump_total_cancelled_increments_only_that_field() {
        let mut s = fresh(Pubkey::new_unique());
        let v = bump_counter(&mut s, Counter::TotalCancelled, 7).unwrap();
        assert_eq!(v, 1);
        assert_eq!(s.total_cancelled, 1);
        assert_eq!(s.claims_expired, 0);
    }

    // === Repeated bumps accumulate and return the running total ===

    #[test]
    fn repeated_bumps_accumulate() {
        let mut s = fresh(Pubkey::new_unique());
        assert_eq!(bump_counter(&mut s, Counter::TasksRejected, 1).unwrap(), 1);
        assert_eq!(bump_counter(&mut s, Counter::TasksRejected, 2).unwrap(), 2);
        assert_eq!(bump_counter(&mut s, Counter::TasksRejected, 3).unwrap(), 3);
        assert_eq!(s.tasks_rejected, 3);
        assert_eq!(s.last_updated, 3);
    }

    // === Overflow guard (negative) ===

    // Revert-sensitive: swapping `checked_add` for a wrapping add makes this pass
    // silently instead of erroring — the test then goes red on the `is_err` assert.
    #[test]
    fn bump_at_max_errors_instead_of_wrapping() {
        let mut s = fresh(Pubkey::new_unique());
        s.disputes_lost = u64::MAX;
        assert!(bump_counter(&mut s, Counter::DisputesLost, 1).is_err());
        // The field is left untouched on the error path.
        assert_eq!(s.disputes_lost, u64::MAX);
    }
}
