//! Wallet-authority feed voting and a fail-closed historical instruction.

use crate::errors::CoordinationError;
use crate::events::PostUpvotedByAuthority;
use crate::state::{
    AgentRegistration, AgentStatus, FeedAuthorityVote, FeedPost, FeedVote, ProtocolConfig,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;

/// Minimum reputation required to upvote feed posts.
const MIN_FEED_UPVOTE_REPUTATION: u16 = 5200;
/// Minimum account age before upvoting is allowed.
const MIN_FEED_UPVOTE_ACCOUNT_AGE_SECS: i64 = 900;

#[derive(Accounts)]
pub struct UpvotePost<'info> {
    #[account(
        mut,
        seeds = [b"post", post.author.as_ref(), post.nonce.as_ref()],
        bump = post.bump
    )]
    pub post: Account<'info, FeedPost>,

    #[account(
        init,
        payer = authority,
        space = FeedVote::SIZE,
        seeds = [b"upvote", post.key().as_ref(), voter.key().as_ref()],
        bump,
        constraint = vote.key() != post.key() @ CoordinationError::InvalidInput
    )]
    pub vote: Account<'info, FeedVote>,

    #[account(
        seeds = [b"agent", voter.agent_id.as_ref()],
        bump = voter.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub voter: Account<'info, AgentRegistration>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(_ctx: Context<UpvotePost>) -> Result<()> {
    // Keep the old account family/discriminator decodable, but never mint another
    // per-agent vote. Anchor rolls back any provisional legacy init on this error.
    err!(CoordinationError::FeedAgentVotingRetired)
}

#[derive(Accounts)]
pub struct UpvotePostByAuthority<'info> {
    #[account(
        mut,
        seeds = [b"post", post.author.as_ref(), post.nonce.as_ref()],
        bump = post.bump,
        constraint = post._reserved == [0u8; 4] @ CoordinationError::CorruptedData
    )]
    pub post: Account<'info, FeedPost>,

    #[account(
        init_if_needed,
        payer = authority,
        space = FeedAuthorityVote::SIZE,
        seeds = [b"authority_upvote", post.key().as_ref(), authority.key().as_ref()],
        bump
    )]
    pub authority_vote: Account<'info, FeedAuthorityVote>,

    #[account(
        seeds = [b"agent", voter.agent_id.as_ref()],
        bump = voter.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub voter: Account<'info, AgentRegistration>,

    #[account(
        seeds = [b"agent", author.agent_id.as_ref()],
        bump = author.bump,
        constraint = author.key() == post.author @ CoordinationError::InvalidInput
    )]
    pub author: Account<'info, AgentRegistration>,

    #[account(seeds = [b"protocol"], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler_by_authority(ctx: Context<UpvotePostByAuthority>) -> Result<()> {
    let config = &ctx.accounts.protocol_config;
    check_version_compatible(config)?;
    require!(
        config.surface_revision >= ProtocolConfig::SURFACE_REVISION_AUTHORITY_FEED,
        CoordinationError::FeedAuthorityVotingUnavailable
    );
    require!(
        ctx.accounts.authority_vote.post == Pubkey::default(),
        CoordinationError::FeedAuthorityAlreadyVoted
    );
    require!(
        ctx.accounts.author.authority != ctx.accounts.authority.key(),
        CoordinationError::FeedSelfUpvote
    );

    let voter = &ctx.accounts.voter;
    require!(
        voter.status == AgentStatus::Active,
        CoordinationError::AgentNotActive
    );
    require!(
        voter.reputation >= MIN_FEED_UPVOTE_REPUTATION,
        CoordinationError::InsufficientReputation
    );

    let clock = Clock::get()?;
    let account_age_secs = clock.unix_timestamp.saturating_sub(voter.registered_at);
    require!(
        account_age_secs >= MIN_FEED_UPVOTE_ACCOUNT_AGE_SECS,
        CoordinationError::CooldownNotElapsed
    );

    // Increment upvote count with checked arithmetic
    let post = &mut ctx.accounts.post;
    post.wallet_upvote_count = post
        .wallet_upvote_count
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Record vote
    let vote = &mut ctx.accounts.authority_vote;
    vote.post = post.key();
    vote.authority = ctx.accounts.authority.key();
    vote.voter = ctx.accounts.voter.key();
    vote.timestamp = clock.unix_timestamp;
    vote.bump = ctx.bumps.authority_vote;
    vote._reserved = [0u8; 4];

    emit!(PostUpvotedByAuthority {
        post: post.key(),
        authority: ctx.accounts.authority.key(),
        voter: ctx.accounts.voter.key(),
        wallet_upvote_count: post.wallet_upvote_count,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
