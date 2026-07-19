//! Update an existing skill's content and pricing

use crate::errors::CoordinationError;
use crate::events::SkillUpdated;
use crate::instructions::constants::MIN_SKILL_PRICE;
use crate::state::{AgentRegistration, AgentStatus, ProtocolConfig, SkillRegistration};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

fn next_skill_version(current: u8) -> Result<u8> {
    current
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow.into())
}

#[derive(Accounts)]
pub struct UpdateSkill<'info> {
    #[account(
        mut,
        seeds = [b"skill", author.key().as_ref(), skill.skill_id.as_ref()],
        bump = skill.bump,
        constraint = skill.author == author.key() @ CoordinationError::SkillUnauthorizedUpdate
    )]
    pub skill: Account<'info, SkillRegistration>,

    #[account(
        seeds = [b"agent", author.agent_id.as_ref()],
        bump = author.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub author: Account<'info, AgentRegistration>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub authority: Signer<'info>,
}

pub fn handler(
    ctx: Context<UpdateSkill>,
    content_hash: [u8; 32],
    price: u64,
    tags: Option<[u8; 64]>,
    is_active: Option<bool>,
) -> Result<()> {
    let config = &ctx.accounts.protocol_config;
    check_version_compatible(config)?;

    let author = &ctx.accounts.author;
    require!(
        author.status == AgentStatus::Active,
        CoordinationError::AgentNotActive
    );

    require!(
        content_hash != [0u8; 32],
        CoordinationError::SkillInvalidContentHash
    );
    require!(
        price >= MIN_SKILL_PRICE,
        CoordinationError::SkillPriceBelowMinimum
    );

    let clock = Clock::get()?;
    let skill = &mut ctx.accounts.skill;

    skill.content_hash = content_hash;
    skill.price = price;
    if let Some(new_tags) = tags {
        skill.tags = new_tags;
    }
    if let Some(active) = is_active {
        skill.is_active = active;
    }
    // Version is a buyer-facing concurrency and provenance guard. Saturating at
    // u8::MAX would allow later content/price mutations to reuse version 255,
    // violating the monotonic contract and making version-only indexers stale.
    // Fail the update instead; a future layout migration can widen the counter.
    skill.version = next_skill_version(skill.version)?;
    skill.updated_at = clock.unix_timestamp;

    emit!(SkillUpdated {
        skill: skill.key(),
        author: author.key(),
        content_hash,
        price,
        version: skill.version,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_version_is_strictly_monotonic_and_never_reused() {
        assert_eq!(next_skill_version(1).unwrap(), 2);
        assert_eq!(next_skill_version(u8::MAX - 1).unwrap(), u8::MAX);
        assert!(next_skill_version(u8::MAX).is_err());
    }
}
