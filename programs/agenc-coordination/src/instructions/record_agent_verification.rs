//! Record a domain-verification attestation for an agent (P7.3 step 2).
//!
//! A trusted attestor records that operator domain `D` was proven to control agent `A`.
//! The OFF-CHAIN proof of domain control (a DNS `TXT` record or `.well-known` file
//! containing the agent PDA + a signed challenge) is the attestor SERVICE's job (a later
//! wave); on-chain we only record that a TRUSTED attestor verified domain D for agent A,
//! so `verified` + domain becomes trustlessly readable.
//!
//! Authorization (P1.2 §4.6, Open Question 7: DECOUPLED): the recorder must be the
//! GLOBAL moderation authority (`ModerationConfig.moderation_authority`) ONLY. Before
//! P1.2 this rode the `ModerationAttestor` roster; with permissionless registration
//! that would let any bonded self-registered key (a) mint "operator domain D controls
//! agent A" badges for domains it does not control, and (b) clobber another
//! attestor's verification through the single `["agent_verification", agent]` slot.
//! Domain-verification is a different trust question from content moderation and
//! does not ride the open roster in v1 (no money gate consumes it — P7.3 badge only).
//!
//! Full-surface only (`#[cfg(not(feature = "mainnet-canary"))]`): the canary surface stays
//! frozen at 25 instructions.

use anchor_lang::prelude::*;

use crate::errors::CoordinationError;
use crate::events::AgentVerified;
use crate::state::{
    is_valid_agent_verification_method, validate_verified_domain, AgentRegistration,
    AgentVerification, ModerationConfig,
};

#[derive(Accounts)]
pub struct RecordAgentVerification<'info> {
    #[account(seeds = [b"moderation_config"], bump = moderation_config.bump)]
    pub moderation_config: Account<'info, ModerationConfig>,

    /// The agent being verified, pinned to its canonical `["agent", agent_id]` PDA.
    #[account(
        seeds = [b"agent", agent.agent_id.as_ref()],
        bump = agent.bump
    )]
    pub agent: Account<'info, AgentRegistration>,

    /// Domain-verification attestation. `init_if_needed` so re-verification overwrites the
    /// same PDA in place. Keyed only by `agent` (one current verification per agent).
    #[account(
        init_if_needed,
        payer = attestor,
        space = AgentVerification::SIZE,
        seeds = [b"agent_verification", agent.key().as_ref()],
        bump
    )]
    pub agent_verification: Account<'info, AgentVerification>,

    /// The recording signer. P1.2 §4.6: must be the GLOBAL moderation authority —
    /// the roster no longer authorizes domain verification (decoupled from the
    /// permissionless open roster; checked in the handler).
    #[account(mut)]
    pub attestor: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RecordAgentVerification>,
    verified_domain: String,
    method: u8,
    expires_at: i64,
) -> Result<()> {
    // P1.2 §4.6 (decoupled): the GLOBAL moderation authority only. The open roster
    // must not mint domain badges — a bonded self-registered key could otherwise
    // claim domains it does not control and clobber the single per-agent slot.
    require!(
        ctx.accounts.attestor.key() == ctx.accounts.moderation_config.moderation_authority,
        CoordinationError::UnauthorizedModerationAttestor
    );
    require!(
        ctx.accounts.agent.status != crate::state::AgentStatus::Suspended
            && !ctx.accounts.agent.is_retired_identity(),
        CoordinationError::AgentNotActive
    );

    require!(
        validate_verified_domain(&verified_domain),
        CoordinationError::InvalidVerifiedDomain
    );
    require!(
        is_valid_agent_verification_method(method),
        CoordinationError::InvalidAgentVerificationMethod
    );
    require!(expires_at >= 0, CoordinationError::InvalidVerifiedDomain);

    let clock = Clock::get()?;
    if expires_at != 0 {
        require!(
            expires_at > clock.unix_timestamp,
            CoordinationError::InvalidVerifiedDomain
        );
    }

    let agent_key = ctx.accounts.agent.key();
    let v = &mut ctx.accounts.agent_verification;
    v.agent = agent_key;
    v.verified_domain = verified_domain.clone();
    v.method = method;
    v.verified_by = ctx.accounts.attestor.key();
    v.verified_at = clock.unix_timestamp;
    v.expires_at = expires_at;
    // Re-verification clears any prior revocation (a fresh attestation).
    v.revoked = false;
    v.bump = ctx.bumps.agent_verification;

    emit!(AgentVerified {
        agent: agent_key,
        verified_domain,
        method,
        verified_by: ctx.accounts.attestor.key(),
        verified_at: clock.unix_timestamp,
        expires_at,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::agent_verification_method;

    // --- domain validation gate (the on-chain sanity floor) ---

    #[test]
    fn accepts_a_clean_domain() {
        assert!(validate_verified_domain("operator.example.com"));
    }

    #[test]
    fn rejects_empty_domain() {
        assert!(!validate_verified_domain(""));
    }

    #[test]
    fn rejects_overlong_domain() {
        // 254 chars (one over the 253-octet DNS cap), kept label-legal.
        let long =
            "a".repeat(63) + "." + &"b".repeat(63) + "." + &"c".repeat(63) + "." + &"d".repeat(62);
        assert_eq!(long.len(), 254);
        assert!(!validate_verified_domain(&long));
    }

    #[test]
    fn rejects_bad_charset() {
        assert!(!validate_verified_domain("bad domain.com"));
        assert!(!validate_verified_domain("https://x.com"));
        assert!(!validate_verified_domain("under_score.com"));
    }

    // --- method validation gate ---

    #[test]
    fn accepts_known_methods() {
        assert!(is_valid_agent_verification_method(
            agent_verification_method::TXT_RECORD
        ));
        assert!(is_valid_agent_verification_method(
            agent_verification_method::WELL_KNOWN
        ));
    }

    #[test]
    fn rejects_unknown_method() {
        assert!(!is_valid_agent_verification_method(7));
    }

    // --- authorization (P1.2 §4.6: decoupled) ---
    // The handler gates on `attestor == moderation_config.moderation_authority` alone;
    // the roster no longer authorizes domain verification. The equality check needs no
    // pure-fn test here — the litesvm coverage asserts a registered roster attestor is
    // REJECTED at record/revoke_agent_verification post-decouple.
}
