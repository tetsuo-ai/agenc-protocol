//! Record a domain-verification attestation for an agent (P7.3 step 2).
//!
//! A trusted attestor records that operator domain `D` was proven to control agent `A`.
//! The OFF-CHAIN proof of domain control (a DNS `TXT` record or `.well-known` file
//! containing the agent PDA + a signed challenge) is the attestor SERVICE's job (a later
//! wave); on-chain we only record that a TRUSTED attestor verified domain D for agent A,
//! so `verified` + domain becomes trustlessly readable.
//!
//! Authorization MIRRORS `record_listing_moderation` / `record_task_moderation` EXACTLY:
//! the recorder must be the GLOBAL moderation authority (`ModerationConfig.moderation_authority`)
//! OR a registered (non-revoked) `ModerationAttestor`. Reusing `require_moderation_authorized`
//! means verifications come from the SAME trusted roster that gates moderation.
//!
//! Full-surface only (`#[cfg(not(feature = "mainnet-canary"))]`): the canary surface stays
//! frozen at 25 instructions.

use anchor_lang::prelude::*;

use crate::errors::CoordinationError;
use crate::events::AgentVerified;
use crate::instructions::record_task_moderation::require_moderation_authorized;
use crate::state::{
    is_valid_agent_verification_method, validate_verified_domain, AgentRegistration,
    AgentVerification, ModerationAttestor, ModerationConfig,
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

    /// The recording signer. Authorization (global moderation authority OR a registered
    /// attestor) is checked in the handler, not as an account constraint here — mirroring
    /// `record_*_moderation`.
    #[account(mut)]
    pub attestor: Signer<'info>,

    /// OPTIONAL: a registered moderation-attestor roster entry. When supplied (and
    /// `attestor == moderation_attestor.attestor`), authorizes a non-global-authority
    /// attestor to record. Bound to `["moderation_attestor", attestor]` — Anchor enforces
    /// the canonical PDA, so a forged/mismatched entry fails account resolution, and a
    /// REVOKED attestor's PDA is closed and fails to load (cannot attest). This instruction
    /// is full-surface only, so this field carries no canary-surface implications.
    #[account(
        seeds = [b"moderation_attestor", attestor.key().as_ref()],
        bump = moderation_attestor.bump,
        constraint = moderation_attestor.attestor == attestor.key()
            @ CoordinationError::ModerationAttestorMismatch
    )]
    pub moderation_attestor: Option<Box<Account<'info, ModerationAttestor>>>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RecordAgentVerification>,
    verified_domain: String,
    method: u8,
    expires_at: i64,
) -> Result<()> {
    // Authorization: global moderation authority OR a registered (non-revoked) attestor.
    // A supplied attestor account is canonical-PDA + `attestor == signer` bound by the
    // account constraints above; a revoked attestor's PDA is closed and fails to load, so
    // it can never reach here as `Some`. Reuses the EXACT moderation auth helper.
    require_moderation_authorized(
        ctx.accounts.attestor.key(),
        ctx.accounts.moderation_config.moderation_authority,
        ctx.accounts.moderation_attestor.is_some(),
    )?;

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

    // --- authorization mirrors record_*_moderation EXACTLY (same helper) ---

    #[test]
    fn global_authority_is_authorized_without_an_attestor_entry() {
        let auth = Pubkey::new_unique();
        assert!(require_moderation_authorized(auth, auth, false).is_ok());
    }

    #[test]
    fn registered_attestor_who_is_not_the_authority_is_authorized() {
        let auth = Pubkey::new_unique();
        let attestor = Pubkey::new_unique();
        assert!(require_moderation_authorized(attestor, auth, true).is_ok());
    }

    #[test]
    fn random_signer_with_no_attestor_entry_is_rejected() {
        // Mirrors record_listing_moderation's stranger-rejection: neither the global
        // authority NOR a supplied (registered) attestor entry -> rejected. This is also
        // the revoked-attestor case (closed PDA fails to load, so attestor_supplied=false).
        let auth = Pubkey::new_unique();
        let stranger = Pubkey::new_unique();
        let err = require_moderation_authorized(stranger, auth, false).unwrap_err();
        assert_eq!(
            err,
            CoordinationError::UnauthorizedModerationAttestor.into()
        );
    }
}
