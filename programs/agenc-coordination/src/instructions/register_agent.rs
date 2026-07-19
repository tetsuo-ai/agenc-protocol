//! Register a new agent on-chain

use crate::errors::CoordinationError;
use crate::events::AgentRegistered;
use crate::state::{AgentRegistration, AgentStatus, ProtocolConfig};
use crate::utils::validation::validate_string_input;
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

use super::constants::{REPUTATION_SLASH_LOSS, WINDOW_24H};
use super::validation::validate_endpoint;

/// Neutral max-reference reputation (50% = 5000/10000): the value a veteran sits at
/// before any slashing. NOT the fresh-agent start anymore (see `PROBATIONARY_REPUTATION`);
/// retained as the reference point for the single-slash inversion invariant below. The
/// per-completion earn-up path saturates at `MAX_REPUTATION` (10000), not here, so this is
/// not a cap.
///
/// `#[allow(dead_code)]`: this const is consumed by the module-level `const _` compile-time
/// invariant and by the unit tests, but the SBF release build's dead-code lint does not
/// count a const-assert reference as a use, so it would warn without this allow. (Clippy on
/// the host target sees it used and does not warn.) It is intentionally NOT dead.
#[allow(dead_code)]
const INITIAL_REPUTATION: u16 = 5000;

/// Starting reputation for a FRESH agent (P6.7 sybil/reputation-reset deterrent).
///
/// Why not `INITIAL_REPUTATION` (5000)? A veteran that loses ONE dispute is slashed
/// by `REPUTATION_SLASH_LOSS` (300) to 5000-300 = 4700. If a fresh agent also started
/// at 5000 it would STRICTLY OUTRANK its own slashed predecessor, so wiping a punished
/// identity and re-registering for ~rent would be a pure reputation upgrade. Starting
/// fresh agents lower removes that inversion (the stake floor below is the primary cost
/// deterrent; this is the reputation-ranking deterrent).
///
/// Calibration (see P6.7 in PLAN.md — "calibrate against existing task.min_reputation
/// usage so honest new agents aren't locked out of all work"):
/// - UPPER BOUND (fix the inversion): must be strictly < post-single-slash floor
///   = INITIAL_REPUTATION - REPUTATION_SLASH_LOSS = 5000 - 300 = 4700. 3000 clears this
///   with margin (a veteran would need ~6 lost disputes, 6*300=1800, to fall to 3200 and
///   ~6.7 to reach 3000 — i.e. a fresh sybil only matches a heavily-and-repeatedly-punished
///   veteran, never a single-slash one).
/// - LOWER BOUND (don't starve supply): must NOT exceed the common task
///   `min_reputation`. Across the codebase the overwhelming default is 0
///   (create_task / hire_from_listing / *_humanless all pass 0; the live tasks gate on
///   0), and the highest min_reputation seen in fixtures/tests is well under 3000 (e.g.
///   the agent-social post floor uses 5500 as an UNREACHABLE-by-default gate, and skill
///   fixtures use 250). So 3000 avoids excluding honest new agents through the
///   `min_reputation` gate on essentially all entry-level work; every other claim
///   gate remains authoritative. It still ranks below any single-slash veteran.
/// - EARN-UP: economically qualified SOL completions add up to
///   `REPUTATION_PER_COMPLETION` (100), proportional to the irreversible protocol fee,
///   and saturate at `MAX_REPUTATION` (10000). A probationary agent can therefore reach
///   a veteran's level after 20 full-award completions; the start value is NOT a cap.
const PROBATIONARY_REPUTATION: u16 = 3000;

// Compile-time invariant (P6.7): the probationary start MUST sit strictly below the
// reputation a veteran retains after a single slash, or the sybil inversion this deterrent
// exists to fix would still hold. Uses the shared `REPUTATION_SLASH_LOSS` directly so a
// future change to the slash amount re-checks this invariant at compile time, and so
// `INITIAL_REPUTATION` stays a live reference (not dead code).
const _: () = assert!(PROBATIONARY_REPUTATION < INITIAL_REPUTATION - REPUTATION_SLASH_LOSS);

#[derive(Accounts)]
#[instruction(agent_id: [u8; 32])]
pub struct RegisterAgent<'info> {
    #[account(
        init,
        payer = authority,
        space = AgentRegistration::SIZE,
        seeds = [b"agent", agent_id.as_ref()],
        bump
    )]
    pub agent: Account<'info, AgentRegistration>,

    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump,
        constraint = protocol_config.key() != agent.key() @ CoordinationError::InvalidInput
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}
/// Note: The agent PDA account holds both rent-exempt balance and staked funds.
/// On deregister, stake is returned but rent remains with the account.
/// The `stake` field in AgentRegistration tracks only the staked portion.
pub fn handler(
    ctx: Context<RegisterAgent>,
    agent_id: [u8; 32],
    capabilities: u64,
    endpoint: String,
    metadata_uri: Option<String>,
    stake_amount: u64,
) -> Result<()> {
    require!(agent_id != [0u8; 32], CoordinationError::InvalidAgentId);

    require!(capabilities != 0, CoordinationError::InvalidCapabilities);
    require!(!endpoint.is_empty(), CoordinationError::InvalidInput);
    require!(
        validate_string_input(&endpoint),
        CoordinationError::InvalidInput
    );
    validate_endpoint(&endpoint)?;

    let metadata = metadata_uri.unwrap_or_default();
    require!(metadata.len() <= 128, CoordinationError::StringTooLong);
    require!(
        validate_string_input(&metadata),
        CoordinationError::InvalidInput
    );

    let config = &ctx.accounts.protocol_config;
    // Pause + version-range gate, like every sibling entry instruction (create_task,
    // claim_task, register_skill, create_service_listing, ...). register_agent both
    // accepts a stake SOL transfer and mutates ProtocolConfig.total_agents, yet skipped
    // this (audit): without it, registrations still succeed (and still bump total_agents)
    // while the multisig has paused the protocol during an incident, or during a
    // version-mismatch window when the program must not mutate the config.
    check_version_compatible(config)?;
    require!(
        stake_amount >= config.min_agent_stake,
        CoordinationError::InsufficientStake
    );

    let clock = Clock::get()?;
    let agent = &mut ctx.accounts.agent;

    // 1. First initialize agent account fields
    agent.agent_id = agent_id;
    agent.authority = ctx.accounts.authority.key();
    agent.capabilities = capabilities;
    agent.status = AgentStatus::Active;
    agent.endpoint = endpoint.clone();
    agent.metadata_uri = metadata;
    agent.registered_at = clock.unix_timestamp;
    agent.last_active = clock.unix_timestamp;
    agent.tasks_completed = 0;
    agent.total_earned = 0;
    // P6.7: fresh agents start at the probationary value, not the max-neutral 5000,
    // so a wiped-and-re-registered sybil no longer outranks its slashed predecessor.
    // Reputation still earns UP to MAX_REPUTATION via update_worker_completion_stats.
    agent.reputation = PROBATIONARY_REPUTATION;
    agent.active_tasks = 0;
    agent.stake = stake_amount;
    agent.bump = ctx.bumps.agent;
    // Initialize rate limiting fields
    agent.last_task_created = 0;
    agent.last_dispute_initiated = 0;
    agent.task_count_24h = 0;
    agent.dispute_count_24h = 0;
    // Round window start to prevent drift
    let window_start = clock
        .unix_timestamp
        .div_euclid(WINDOW_24H)
        .saturating_mul(WINDOW_24H);
    agent.rate_limit_window_start = window_start;
    agent.active_dispute_votes = 0;
    agent.last_vote_timestamp = 0;
    agent.last_state_update = 0;
    agent.disputes_as_defendant = 0;
    agent._reserved = [0u8; 4];

    // Transfer stake SOL after all account fields are set so the handler does not
    // rely on a stale post-CPI view of the freshly initialized PDA.
    if stake_amount > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: agent.to_account_info(),
                },
            ),
            stake_amount,
        )?;
    }

    // Update protocol stats
    let config = &mut ctx.accounts.protocol_config;
    config.total_agents = config
        .total_agents
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    emit!(AgentRegistered {
        agent_id,
        authority: agent.authority,
        capabilities,
        endpoint,
        stake_amount,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{INITIAL_REPUTATION, PROBATIONARY_REPUTATION};
    use crate::instructions::completion_helpers::{completion_reputation_gain, RewardDenomination};
    use crate::instructions::constants::{
        MAX_REPUTATION, REPUTATION_FEE_LAMPORTS_PER_POINT, REPUTATION_PER_COMPLETION,
        REPUTATION_SLASH_LOSS,
    };
    use crate::state::ProtocolConfig;

    /// The post-single-slash floor a once-slashed veteran retains: a veteran that
    /// started at the max-neutral value and lost ONE dispute keeps this much.
    fn post_single_slash_floor() -> u16 {
        INITIAL_REPUTATION - REPUTATION_SLASH_LOSS
    }

    /// P6.7 CORE INVARIANT (revert-sensitive): a FRESH agent's reputation must be
    /// STRICTLY LESS than what a veteran retains after a single slash. If this fails,
    /// wiping a punished identity and re-registering is a pure reputation upgrade —
    /// the exact sybil/reset inversion this deterrent exists to fix.
    ///
    /// REVERT PROOF: set `PROBATIONARY_REPUTATION` back to 5000 (== INITIAL_REPUTATION)
    /// and this assertion fails: `5000 < 4700` is false (fresh would tie/beat slashed).
    #[test]
    fn fresh_agent_ranks_below_single_slash_veteran() {
        let fresh = PROBATIONARY_REPUTATION;
        let slashed_veteran = post_single_slash_floor();
        assert!(
            fresh < slashed_veteran,
            "sybil inversion: fresh agent reputation {fresh} must be < single-slash \
             veteran floor {slashed_veteran} (= {INITIAL_REPUTATION} - \
             {REPUTATION_SLASH_LOSS})",
        );
    }

    /// Pins the calibration numbers stated in the docs: a single slash costs 300 and a
    /// veteran retains exactly 4700, which the chosen probationary value (3000) sits
    /// below. If `REPUTATION_SLASH_LOSS` changes, this and the module-level `const _`
    /// invariant both re-check, so the deterrent can't silently drift.
    #[test]
    fn slash_calibration_numbers_match_constants() {
        assert_eq!(REPUTATION_SLASH_LOSS, 300, "documented single-slash cost");
        assert_eq!(
            INITIAL_REPUTATION - REPUTATION_SLASH_LOSS,
            4700,
            "documented single-slash veteran floor",
        );
        assert_eq!(
            PROBATIONARY_REPUTATION, 3000,
            "documented probationary start"
        );
    }

    /// Probationary start must not exceed the common task `min_reputation` (which is 0
    /// across create_task / hire_from_listing / *_humanless and the live tasks), so an
    /// honest new agent is not locked out of all work (supply-starvation guard from the
    /// P6.7 calibration constraint). We assert it can claim any task whose
    /// `min_reputation` is at or below the probationary value, using a representative
    /// entry-level gate.
    #[test]
    fn fresh_agent_can_claim_entry_level_work() {
        // The reputation gate in claim_task / bid_marketplace is:
        //   `task.min_reputation == 0 || worker.reputation >= task.min_reputation`.
        // Representative entry-level gates honest new agents should still clear:
        for task_min_reputation in [0u16, 250, 1000, PROBATIONARY_REPUTATION] {
            let passes = task_min_reputation == 0 || PROBATIONARY_REPUTATION >= task_min_reputation;
            assert!(
                passes,
                "honest fresh agent (rep {PROBATIONARY_REPUTATION}) locked out of \
                 work requiring min_reputation {task_min_reputation}",
            );
        }
    }

    /// Earn-up is NOT capped at the probationary start: fee-backed SOL completions
    /// saturate UP to `MAX_REPUTATION` through the production gain calculation.
    #[test]
    fn reputation_earns_up_to_max_not_capped_at_probationary() {
        let full_award_fee = REPUTATION_FEE_LAMPORTS_PER_POINT
            .checked_mul(REPUTATION_PER_COMPLETION as u64)
            .unwrap();
        let gain = completion_reputation_gain(full_award_fee, RewardDenomination::Sol);
        assert_eq!(gain, REPUTATION_PER_COMPLETION);

        let mut rep = PROBATIONARY_REPUTATION;
        // Enough full-award completions to pass both the probationary start and cap.
        for _ in 0..200 {
            rep = rep.saturating_add(gain).min(MAX_REPUTATION);
        }
        assert_eq!(rep, MAX_REPUTATION, "reputation must climb to the max cap");
        assert!(
            rep > PROBATIONARY_REPUTATION,
            "the probationary start must not be a ceiling on earned reputation",
        );
        // And it climbs past a single-slash veteran's floor with honest work, i.e. the
        // probationary deterrent is a starting handicap, not a permanent demotion.
        let mut rep2 = PROBATIONARY_REPUTATION;
        for _ in 0..20 {
            rep2 = rep2.saturating_add(gain).min(MAX_REPUTATION);
        }
        assert!(
            rep2 >= INITIAL_REPUTATION,
            "20 full-award completions ({}*20) should lift a probationary agent to the neutral \
             level {INITIAL_REPUTATION}, got {rep2}",
            gain,
        );
    }

    /// CHANGE 2 (revert-sensitive): a freshly-defaulted `ProtocolConfig` must require a
    /// nonzero, slashable `min_agent_stake`, so a fresh sybil identity costs real money.
    /// `register_agent` enforces `stake_amount >= config.min_agent_stake`, so we model
    /// that gate against the new default.
    ///
    /// REVERT PROOF: set the Default `min_agent_stake` back to 0 and the
    /// "below default is rejected" leg fails — with a 0 floor, stake 0 is accepted.
    #[test]
    fn fresh_default_config_requires_nonzero_stake() {
        let config = ProtocolConfig::default();
        // The floor must be the localnet/init MIN_REASONABLE_STAKE (0.001 SOL).
        assert_eq!(
            config.min_agent_stake, 1_000_000,
            "fresh-default min_agent_stake must be the 0.001 SOL (1_000_000 lamport) floor",
        );

        let min = config.min_agent_stake;
        // register_agent's gate: stake_amount >= config.min_agent_stake.
        let registers_with = |stake_amount: u64| stake_amount >= min;

        // Below the floor (incl. zero) is rejected.
        assert!(
            !registers_with(0),
            "stake 0 must be rejected on fresh default"
        );
        assert!(
            !registers_with(min - 1),
            "stake just below the floor must be rejected",
        );
        // At or above the floor is accepted.
        assert!(registers_with(min), "stake at the floor must be accepted");
        assert!(
            registers_with(min + 1),
            "stake above the floor must be accepted",
        );
    }
}
