//! Fuzz target for the Batch-4 GOODS market money + supply invariants
//! (docs/design/batch-4-goods.md). Model-based, mirroring the on-chain
//! `purchase_good` split + supply burn-down; asserts the invariants the
//! adversarial review targets over randomized price/fee/supply/buy sequences.

use proptest::prelude::*;

const BASIS_POINTS_DIVISOR: u64 = 10_000;
const MAX_PROTOCOL_FEE_BPS: u16 = 2_000;
const MAX_OPERATOR_FEE_BPS: u16 = 2_000;
const MAX_COMBINED_FEE_BPS: u16 = 4_000;
const WORKER_FLOOR_BPS: u16 = 6_000;

/// Mirror of `split_good_price` — the pure fee split.
/// Returns `(seller, protocol, operator)` or `None` if the fee config is invalid
/// (over-cap), exactly like the on-chain `calculate_combined_fees` rejection.
fn split(price: u64, protocol_bps: u16, operator_bps: u16) -> Option<(u64, u64, u64)> {
    if operator_bps > MAX_OPERATOR_FEE_BPS {
        return None;
    }
    let combined = protocol_bps as u64 + operator_bps as u64;
    if combined > MAX_COMBINED_FEE_BPS as u64 {
        return None;
    }
    if (BASIS_POINTS_DIVISOR - combined) < WORKER_FLOOR_BPS as u64 {
        return None;
    }
    let protocol = price.checked_mul(protocol_bps as u64)? / BASIS_POINTS_DIVISOR;
    let operator = price.checked_mul(operator_bps as u64)? / BASIS_POINTS_DIVISOR;
    let seller = price.checked_sub(protocol)?.checked_sub(operator)?;
    Some((seller, protocol, operator))
}

/// Mirror of the on-chain listing supply state.
struct Listing {
    total_supply: u64,
    sold_count: u64,
    receipts: std::collections::BTreeSet<u64>, // serials minted (init-once model)
}

impl Listing {
    /// Attempt a single purchase at `expected_serial`, mirroring the handler
    /// gates: sold-out, serial pin, receipt-init-once. Returns the minted serial
    /// on success.
    fn purchase(&mut self, expected_serial: u64) -> Result<u64, &'static str> {
        if self.sold_count >= self.total_supply {
            return Err("sold_out");
        }
        if expected_serial != self.sold_count {
            return Err("serial_stale");
        }
        // Receipt PDA init is once-per-serial.
        if self.receipts.contains(&expected_serial) {
            return Err("receipt_exists");
        }
        self.receipts.insert(expected_serial);
        self.sold_count += 1;
        Ok(expected_serial)
    }

    fn restock(&mut self, delta: u64) -> Result<(), &'static str> {
        if delta == 0 {
            return Err("zero_delta");
        }
        self.total_supply = self.total_supply.checked_add(delta).ok_or("overflow")?;
        Ok(())
    }
}

proptest! {
    /// INVARIANT 1: the three legs always sum EXACTLY to the price (no lamports
    /// created or destroyed), for every valid fee config.
    #[test]
    fn legs_sum_to_price(price in 1u64..=1_000_000_000u64,
                         protocol_bps in 0u16..=MAX_PROTOCOL_FEE_BPS,
                         operator_bps in 0u16..=MAX_OPERATOR_FEE_BPS) {
        if let Some((seller, protocol, operator)) = split(price, protocol_bps, operator_bps) {
            prop_assert_eq!(seller + protocol + operator, price);
            // dust never leaves the seller: each fee is floored
            prop_assert!(protocol <= price * protocol_bps as u64 / BASIS_POINTS_DIVISOR + 1);
        }
    }

    /// INVARIANT 2: the worker/seller floor holds at every accepted fee config —
    /// the seller never nets below WORKER_FLOOR_BPS of a (large) price.
    #[test]
    fn seller_keeps_floor(price in 10_000u64..=1_000_000_000u64,
                          protocol_bps in 0u16..=MAX_PROTOCOL_FEE_BPS,
                          operator_bps in 0u16..=MAX_OPERATOR_FEE_BPS) {
        if let Some((seller, _p, _o)) = split(price, protocol_bps, operator_bps) {
            let floor = price / BASIS_POINTS_DIVISOR * WORKER_FLOOR_BPS as u64;
            prop_assert!(seller >= floor);
        }
    }

    /// INVARIANT 3: supply can NEVER over-sell and each serial is unique, over an
    /// arbitrary interleaving of correct-serial and wrong-serial purchase attempts.
    #[test]
    fn supply_never_oversells(total in 1u64..=64u64,
                              attempts in prop::collection::vec(0u64..80u64, 0..200)) {
        let mut listing = Listing { total_supply: total, sold_count: 0, receipts: Default::default() };
        for serial in attempts {
            let _ = listing.purchase(serial); // ignore rejects (stale/sold-out)
        }
        // never sold more than supply
        prop_assert!(listing.sold_count <= listing.total_supply);
        // exactly sold_count distinct receipts, all in [0, sold_count)
        prop_assert_eq!(listing.receipts.len() as u64, listing.sold_count);
        for &serial in &listing.receipts {
            prop_assert!(serial < listing.sold_count);
        }
    }

    /// INVARIANT 4: a valid sequential purchase run of length min(demand, supply)
    /// mints exactly the contiguous serials 0..sold, and restock strictly raises
    /// the ceiling additively.
    #[test]
    fn sequential_run_and_restock(total in 1u64..=32u64,
                                  demand in 0u64..40u64,
                                  restock in 0u64..16u64) {
        let mut listing = Listing { total_supply: total, sold_count: 0, receipts: Default::default() };
        let mut minted = Vec::new();
        for _ in 0..demand {
            match listing.purchase(listing.sold_count) {
                Ok(s) => minted.push(s),
                Err("sold_out") => break,
                Err(_) => unreachable!("correct serial never stale/dup in a sequential run"),
            }
        }
        let expected = demand.min(total);
        prop_assert_eq!(minted.len() as u64, expected);
        prop_assert_eq!(minted, (0..expected).collect::<Vec<_>>());

        let before = listing.total_supply;
        if restock > 0 {
            listing.restock(restock).unwrap();
            prop_assert_eq!(listing.total_supply, before + restock);
            // restock never reduces supply below what's already sold
            prop_assert!(listing.total_supply >= listing.sold_count);
        }
    }
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn over_cap_operator_rejected() {
        assert!(split(1_000_000, 500, MAX_OPERATOR_FEE_BPS + 1).is_none());
        // combined cap: 2000 + 2001 > 4000
        assert!(split(1_000_000, MAX_PROTOCOL_FEE_BPS, MAX_OPERATOR_FEE_BPS + 1).is_none());
    }

    #[test]
    fn max_fees_leave_exact_floor() {
        let (seller, protocol, operator) =
            split(1_000_000, MAX_PROTOCOL_FEE_BPS, MAX_OPERATOR_FEE_BPS).unwrap();
        assert_eq!((seller, protocol, operator), (600_000, 200_000, 200_000));
    }
}
