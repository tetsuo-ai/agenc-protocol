//! Disabled entry point for the retired reputation-delegation feature.

use crate::errors::CoordinationError;
use crate::state::{AgentRegistration, ReputationDelegation};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct DelegateReputation<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"agent", delegator_agent.agent_id.as_ref()],
        bump = delegator_agent.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent,
    )]
    pub delegator_agent: Account<'info, AgentRegistration>,

    #[account(
        seeds = [b"agent", delegatee_agent.agent_id.as_ref()],
        bump = delegatee_agent.bump,
        constraint = delegatee_agent.key() != delegator_agent.key() @ CoordinationError::ReputationCannotDelegateSelf
    )]
    pub delegatee_agent: Account<'info, AgentRegistration>,

    #[account(
        init,
        payer = authority,
        space = ReputationDelegation::SIZE,
        seeds = [b"reputation_delegation", delegator_agent.key().as_ref(), delegatee_agent.key().as_ref()],
        bump
    )]
    pub delegation: Account<'info, ReputationDelegation>,

    pub system_program: Program<'info, System>,
}

pub fn handler(_ctx: Context<DelegateReputation>, _amount: u16, _expires_at: i64) -> Result<()> {
    // This account type never credited or influenced the delegatee anywhere in
    // the protocol; it only parked the delegator's reputation and later restored
    // it. That made it a pre-positioned shelter from dispute reputation slashes.
    // Mainnet preflight proves there are no live delegations, so rev5 disables
    // new entry unconditionally while retaining revoke_delegation as an exit for
    // any legacy/devnet record. Keep the ABI stable, but fail before mutation.
    err!(CoordinationError::ReputationDelegationDisabled)
}
