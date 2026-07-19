//! Volume- and reputation-based fee calculations.
//!
//! This module intentionally does not publish static compute-unit recommendations.
//! Such limits become unsafe when instruction shape changes unless they are generated
//! from repeatable compiled-program measurements with reviewed headroom.

// ============================================================================
// Fee Tier Structure
// ============================================================================
//
// Volume-based fee discounts incentivize protocol usage while maintaining
// revenue. Tiers are based on the creator's total completed tasks.

/// Fee tier thresholds and discount percentages.
/// Each tier specifies (min_completed_tasks, discount_bps).
/// Discount is applied to the base protocol_fee_bps.
///
/// Example with base fee of 100 bps (1%):
///   - Tier 0 (0-49 tasks):    0 bps discount  -> 1.00% effective
///   - Tier 1 (50-199 tasks):  10 bps discount  -> 0.90% effective
///   - Tier 2 (200-999 tasks): 25 bps discount  -> 0.75% effective
///   - Tier 3 (1000+ tasks):   40 bps discount  -> 0.60% effective
pub const FEE_TIER_THRESHOLDS: [(u64, u16); 4] = [
    (0, 0),     // Base tier: no discount
    (50, 10),   // Bronze: 10 bps discount after 50 completed tasks
    (200, 25),  // Silver: 25 bps discount after 200 completed tasks
    (1000, 40), // Gold: 40 bps discount after 1000 completed tasks
];

/// Maximum discount in basis points (cannot exceed base fee)
pub const MAX_FEE_DISCOUNT_BPS: u16 = 40;

/// Calculate the effective protocol fee after volume discount.
///
/// Returns zero when governance explicitly configured a free protocol. Positive
/// base fees retain a 1-bps floor so a discount cannot accidentally erase a fee.
///
/// # Arguments
/// * `base_fee_bps` - The base protocol fee in basis points
/// * `completed_tasks` - The creator's total completed tasks (for tier lookup)
pub fn calculate_tiered_fee(base_fee_bps: u16, completed_tasks: u64) -> u16 {
    // Zero is a first-class protocol policy: initialize_protocol,
    // update_protocol_fee, and governance FeeChange all accept it. Preserve that
    // sentinel before applying discounts or the positive-fee floor.
    if base_fee_bps == 0 {
        return 0;
    }

    let mut discount_bps: u16 = 0;

    // Walk tiers in reverse to find the highest applicable tier
    for &(threshold, discount) in FEE_TIER_THRESHOLDS.iter().rev() {
        if completed_tasks >= threshold {
            discount_bps = discount;
            break;
        }
    }

    // Apply the discount while keeping an explicitly positive fee positive.
    base_fee_bps.saturating_sub(discount_bps).max(1)
}

// ============================================================================
// Reputation-Based Fee Discount
// ============================================================================
//
// Workers with high reputation receive reduced protocol fees at completion time.
// This stacks with volume-based discounts.

/// Reputation fee tier thresholds and discount amounts.
/// Each tier specifies (min_reputation, discount_bps).
pub const REPUTATION_FEE_TIERS: [(u16, u16); 4] = [
    (0, 0),     // No discount below 8000
    (8000, 5),  // 5 bps discount at 8000+ reputation
    (9000, 10), // 10 bps discount at 9000+ reputation
    (9500, 15), // 15 bps discount at 9500+ reputation
];

/// Calculate reputation-based fee discount in basis points.
///
/// Returns the discount amount to subtract from the protocol fee.
/// The caller preserves an explicit zero-fee policy and floors only positive
/// protocol fees at 1 bps.
pub fn calculate_reputation_fee_discount(reputation: u16) -> u16 {
    let mut discount_bps: u16 = 0;

    // Walk tiers in reverse to find the highest applicable tier
    for &(threshold, discount) in REPUTATION_FEE_TIERS.iter().rev() {
        if reputation >= threshold {
            discount_bps = discount;
            break;
        }
    }

    discount_bps
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tiered_fee_base_tier() {
        // 0 completed tasks -> no discount
        assert_eq!(calculate_tiered_fee(100, 0), 100);
        assert_eq!(calculate_tiered_fee(100, 49), 100);
    }

    #[test]
    fn test_tiered_fee_bronze() {
        // 50+ completed tasks -> 10 bps discount
        assert_eq!(calculate_tiered_fee(100, 50), 90);
        assert_eq!(calculate_tiered_fee(100, 199), 90);
    }

    #[test]
    fn test_tiered_fee_silver() {
        // 200+ completed tasks -> 25 bps discount
        assert_eq!(calculate_tiered_fee(100, 200), 75);
        assert_eq!(calculate_tiered_fee(100, 999), 75);
    }

    #[test]
    fn test_tiered_fee_gold() {
        // 1000+ completed tasks -> 40 bps discount
        assert_eq!(calculate_tiered_fee(100, 1000), 60);
        assert_eq!(calculate_tiered_fee(100, 10000), 60);
    }

    #[test]
    fn test_tiered_fee_minimum_floor() {
        // Even with max discount, fee should be at least 1 bps
        assert_eq!(calculate_tiered_fee(1, 1000), 1);
        // When base fee is less than discount, floor to 1
        assert_eq!(calculate_tiered_fee(30, 1000), 1);
    }

    #[test]
    fn test_tiered_fee_zero_base() {
        // An explicit zero is the governance-configured free-protocol mode.
        assert_eq!(calculate_tiered_fee(0, 0), 0);
        assert_eq!(calculate_tiered_fee(0, 1000), 0);
    }

    #[test]
    fn test_tiered_fee_large_base() {
        // 1000 bps (10%) is used here as an example fee input, not the cap.
        assert_eq!(calculate_tiered_fee(1000, 0), 1000);
        assert_eq!(calculate_tiered_fee(1000, 1000), 960);
    }

    #[test]
    fn test_reputation_fee_discount_no_discount() {
        assert_eq!(calculate_reputation_fee_discount(0), 0);
        assert_eq!(calculate_reputation_fee_discount(5000), 0);
        assert_eq!(calculate_reputation_fee_discount(7999), 0);
    }

    #[test]
    fn test_reputation_fee_discount_tier_1() {
        assert_eq!(calculate_reputation_fee_discount(8000), 5);
        assert_eq!(calculate_reputation_fee_discount(8999), 5);
    }

    #[test]
    fn test_reputation_fee_discount_tier_2() {
        assert_eq!(calculate_reputation_fee_discount(9000), 10);
        assert_eq!(calculate_reputation_fee_discount(9499), 10);
    }

    #[test]
    fn test_reputation_fee_discount_tier_3() {
        assert_eq!(calculate_reputation_fee_discount(9500), 15);
        assert_eq!(calculate_reputation_fee_discount(10000), 15);
    }
}
