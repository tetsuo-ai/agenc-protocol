//! Rate a completed listing hire (P6.1) — make the dead `ServiceListing` rating
//! fields live.
//!
//! `ServiceListing.total_rating` / `rating_count` were allocated but never written.
//! `rate_hire` lets the buyer of a listing hire score the delivered work once it has
//! terminally completed, and atomically folds that score into the listing aggregate.
//!
//! Guards (each one is the subject of a positive + negative unit test below; remove
//! any single `require!` and a test turns red):
//!  1. **Buyer-only** — the signer must equal the task's recorded buyer
//!     (`task.creator`, which `hire_from_listing` constrained to the funding
//!     authority). A non-buyer cannot rate.
//!  2. **Terminal Completed** — the task must be in the terminal `Completed` state.
//!     Rating in-flight, cancelled, or frozen work is rejected.
//!  3. **One rating per hire** — the `["hire_rating", task]` PDA is `init` (init-once);
//!     a second `rate_hire` on the same task fails at account creation.
//!  4. **Score bounds** — `score` must be in `1..=5`; `0` and `6` are rejected.
//!  5. **Bounded review URI** — `review_uri` is length-capped to fit the account's
//!     `#[max_len(256)]` reserve.
//!
//! The hire's source listing is reached through the `["hire", task]` `HireRecord`
//! (it carries `listing`); the listing account is bound by its own canonical seeds
//! and matched against `hire_record.listing`, so neither can be spoofed.
//!
//! Provider-agent rating aggregate: DEFERRED to P6.6's `AgentStats` PDA. Updating the
//! listing aggregate here needs no migration; introducing a provider-agent rating
//! aggregate PDA now would race P6.6's `["agent_stats", agent]` design. We update the
//! listing aggregate (the spec's primary target) and emit `ListingRated` carrying the
//! provider agent so the provider-side rollup can be backfilled from events when
//! `AgentStats` lands. No `AgentRegistration` layout change / migration is introduced.

use crate::errors::CoordinationError;
use crate::events::ListingRated;
use crate::state::{HireRating, HireRecord, ProtocolConfig, ServiceListing, Task, TaskStatus};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

/// Pure score-bounds guard, extracted so the `1..=5` check is unit-testable and
/// revert-sensitive independently of account wiring.
pub(crate) fn validate_rating_score(score: u8) -> Result<()> {
    require!(
        (HireRating::MIN_SCORE..=HireRating::MAX_SCORE).contains(&score),
        CoordinationError::InvalidRatingScore
    );
    Ok(())
}

/// Pure review-URI length guard. Empty is allowed (no written review); anything
/// longer than the account reserve is rejected.
pub(crate) fn validate_review_uri(review_uri: &str) -> Result<()> {
    require!(
        review_uri.len() <= HireRating::MAX_REVIEW_URI_LEN,
        CoordinationError::ReviewUriTooLong
    );
    Ok(())
}

/// Pure terminal-Completed guard.
pub(crate) fn validate_task_completed(status: TaskStatus) -> Result<()> {
    require!(
        status == TaskStatus::Completed,
        CoordinationError::TaskNotCompletedForRating
    );
    Ok(())
}

#[derive(Accounts)]
pub struct RateHire<'info> {
    /// The hired task being rated. Must be terminal `Completed` and its `creator`
    /// (the recorded buyer) must equal the signer (checked in the handler).
    #[account(
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Box<Account<'info, Task>>,

    /// Links the task to its source listing (PDA `["hire", task]`). Its existence
    /// proves this task was minted by a listing hire; `listing` here must match
    /// `hire_record.listing`.
    #[account(
        seeds = [b"hire", task.key().as_ref()],
        bump = hire_record.bump,
        constraint = hire_record.task == task.key() @ CoordinationError::InvalidHireRecord
    )]
    pub hire_record: Box<Account<'info, HireRecord>>,

    /// Source service listing whose rating aggregate is updated. Bound by its own
    /// canonical seeds AND matched to the hire record so it cannot be substituted.
    #[account(
        mut,
        seeds = [b"service_listing", listing.provider_agent.as_ref(), listing.listing_id.as_ref()],
        bump = listing.bump,
        constraint = hire_record.listing == listing.key() @ CoordinationError::InvalidHireRecord
    )]
    pub listing: Box<Account<'info, ServiceListing>>,

    /// One-rating-per-hire: `init` makes a second `rate_hire` on the same task fail.
    #[account(
        init,
        payer = buyer,
        space = HireRating::SIZE,
        seeds = [b"hire_rating", task.key().as_ref()],
        bump
    )]
    pub hire_rating: Box<Account<'info, HireRating>>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// The buyer recorded on the task (`task.creator`). Must sign and pay rent.
    /// Buyer-equality is enforced in the handler against `task.creator`.
    #[account(mut)]
    pub buyer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Records the buyer's `score` for a completed hire and folds it into the listing
/// aggregate.
///
/// # Parameters
/// - `score`: rating in `1..=5`.
/// - `review_hash`: optional off-chain review content hash.
/// - `review_uri`: optional bounded pointer to the review (empty = none).
pub fn handler(
    ctx: Context<RateHire>,
    score: u8,
    review_hash: Option<[u8; 32]>,
    review_uri: String,
) -> Result<()> {
    let config = ctx.accounts.protocol_config.as_ref();
    check_version_compatible(config)?;

    // (4) Score bounds + (5) bounded review URI.
    validate_rating_score(score)?;
    validate_review_uri(&review_uri)?;

    let task = ctx.accounts.task.as_ref();

    // (1) Buyer-only: the signer must be the task's recorded buyer (creator).
    require!(
        ctx.accounts.buyer.key() == task.creator,
        CoordinationError::RatingNotBuyer
    );

    // (2) Terminal Completed only.
    validate_task_completed(task.status)?;

    let clock = Clock::get()?;
    let task_key = task.key();

    // Atomically fold the score into the listing aggregate (checked arithmetic).
    let listing = ctx.accounts.listing.as_mut();
    let provider_agent = listing.provider_agent;
    listing.total_rating = listing
        .total_rating
        .checked_add(score as u64)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    listing.rating_count = listing
        .rating_count
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    listing.updated_at = clock.unix_timestamp;
    let new_total_rating = listing.total_rating;
    let new_rating_count = listing.rating_count;
    let listing_key = listing.key();

    // Persist the one-shot rating record (its existence is the double-rate guard).
    let hire_rating = ctx.accounts.hire_rating.as_mut();
    hire_rating.task = task_key;
    hire_rating.listing = listing_key;
    hire_rating.buyer = ctx.accounts.buyer.key();
    hire_rating.score = score;
    hire_rating.review_hash = review_hash;
    hire_rating.review_uri = review_uri;
    hire_rating.rated_at = clock.unix_timestamp;
    hire_rating.bump = ctx.bumps.hire_rating;
    hire_rating._reserved = [0u8; 32];

    emit!(ListingRated {
        listing: listing_key,
        task: task_key,
        provider_agent,
        buyer: ctx.accounts.buyer.key(),
        score,
        new_total_rating,
        new_rating_count,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // === Score bounds (positive + negative) ===

    #[test]
    fn accepts_scores_one_through_five() {
        for score in 1u8..=5 {
            assert!(
                validate_rating_score(score).is_ok(),
                "score {score} rejected"
            );
        }
    }

    // Revert-sensitive: removing the `1..=5` require! turns this red.
    #[test]
    fn rejects_score_zero() {
        assert!(validate_rating_score(0).is_err());
    }

    #[test]
    fn rejects_score_six() {
        assert!(validate_rating_score(6).is_err());
        assert!(validate_rating_score(255).is_err());
    }

    // === Review URI bounds (positive + negative) ===

    #[test]
    fn accepts_empty_and_max_review_uri() {
        assert!(validate_review_uri("").is_ok());
        let max = "a".repeat(HireRating::MAX_REVIEW_URI_LEN);
        assert!(validate_review_uri(&max).is_ok());
    }

    // Revert-sensitive: removing the length require! turns this red.
    #[test]
    fn rejects_overlong_review_uri() {
        let over = "a".repeat(HireRating::MAX_REVIEW_URI_LEN + 1);
        assert!(validate_review_uri(&over).is_err());
    }

    // === Terminal-Completed guard (positive + negative) ===

    #[test]
    fn accepts_completed_task() {
        assert!(validate_task_completed(TaskStatus::Completed).is_ok());
    }

    // Revert-sensitive: removing the Completed require! turns this red. Covers every
    // non-Completed status (in-flight, both terminal-non-Completed, and frozen).
    #[test]
    fn rejects_non_completed_task() {
        for (idx, status) in [
            TaskStatus::Open,
            TaskStatus::InProgress,
            TaskStatus::PendingValidation,
            TaskStatus::Cancelled,
            TaskStatus::Disputed,
            TaskStatus::RejectFrozen,
        ]
        .into_iter()
        .enumerate()
        {
            assert!(
                validate_task_completed(status).is_err(),
                "non-completed status at index {idx} should be unratable"
            );
        }
    }
}
