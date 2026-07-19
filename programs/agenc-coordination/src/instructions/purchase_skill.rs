//! Purchase a skill (SOL or SPL token, with protocol fee)

use crate::errors::CoordinationError;
use crate::events::SkillPurchased;
use crate::instructions::constants::BASIS_POINTS_DIVISOR;
use crate::state::{
    AgentRegistration, AgentStatus, ProtocolConfig, PurchaseRecord, SkillRegistration,
};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct PurchaseSkill<'info> {
    #[account(
        mut,
        seeds = [b"skill", skill.author.as_ref(), skill.skill_id.as_ref()],
        bump = skill.bump
    )]
    pub skill: Box<Account<'info, SkillRegistration>>,

    #[account(
        init,
        payer = authority,
        space = PurchaseRecord::SIZE,
        seeds = [b"skill_purchase", skill.key().as_ref(), buyer.key().as_ref()],
        bump
    )]
    pub purchase_record: Account<'info, PurchaseRecord>,

    #[account(
        seeds = [b"agent", buyer.agent_id.as_ref()],
        bump = buyer.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub buyer: Box<Account<'info, AgentRegistration>>,

    /// Skill author's agent registration
    #[account(
        seeds = [b"agent", author_agent.agent_id.as_ref()],
        bump = author_agent.bump,
        constraint = skill.author == author_agent.key() @ CoordinationError::InvalidInput
    )]
    pub author_agent: Box<Account<'info, AgentRegistration>>,

    /// CHECK: Validated as author_agent.authority
    #[account(
        mut,
        constraint = author_wallet.key() == author_agent.authority @ CoordinationError::InvalidInput
    )]
    pub author_wallet: UncheckedAccount<'info>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// CHECK: Validated as protocol_config.treasury
    #[account(
        mut,
        constraint = treasury.key() == protocol_config.treasury @ CoordinationError::InvalidTreasury
    )]
    pub treasury: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,

    // === Optional SPL Token accounts ===
    /// SPL token mint for price denomination (optional)
    pub price_mint: Option<Account<'info, Mint>>,

    /// Buyer's token account (optional)
    #[account(mut)]
    pub buyer_token_account: Option<Account<'info, TokenAccount>>,

    /// Author's token account (optional)
    #[account(mut)]
    pub author_token_account: Option<Account<'info, TokenAccount>>,

    /// Treasury's token account (optional)
    #[account(mut)]
    pub treasury_token_account: Option<Account<'info, TokenAccount>>,

    /// SPL Token program (optional)
    pub token_program: Option<Program<'info, Token>>,
}

pub fn handler(
    ctx: Context<PurchaseSkill>,
    expected_price: u64,
    expected_version: u8,
    expected_content_hash: [u8; 32],
) -> Result<()> {
    let config = &ctx.accounts.protocol_config;
    check_version_compatible(config)?;

    let buyer = &ctx.accounts.buyer;
    require!(
        buyer.status == AgentStatus::Active,
        CoordinationError::AgentNotActive
    );
    require!(
        ctx.accounts.author_agent.status != AgentStatus::Suspended
            && !ctx.accounts.author_agent.is_retired_identity(),
        CoordinationError::AgentNotActive
    );

    let skill = &ctx.accounts.skill;
    require!(skill.is_active, CoordinationError::SkillNotActive);

    require!(
        buyer.key() != skill.author,
        CoordinationError::SkillSelfPurchase
    );
    require!(
        ctx.accounts.authority.key() != ctx.accounts.author_wallet.key(),
        CoordinationError::SkillSelfPurchase
    );

    let clock = Clock::get()?;
    let price = skill.price;
    require!(
        price <= expected_price,
        CoordinationError::SkillPriceChanged
    );
    require!(
        skill.version == expected_version,
        CoordinationError::SkillVersionChanged
    );
    require!(
        skill.content_hash == expected_content_hash,
        CoordinationError::SkillContentChanged
    );
    let mut protocol_fee = 0u64;

    if price > 0 || skill.price_mint.is_some() {
        if skill.price_mint.is_some() {
            // SPL token payment path
            require!(
                ctx.accounts.price_mint.is_some()
                    && ctx.accounts.buyer_token_account.is_some()
                    && ctx.accounts.author_token_account.is_some()
                    && ctx.accounts.treasury_token_account.is_some()
                    && ctx.accounts.token_program.is_some(),
                CoordinationError::MissingTokenAccounts
            );

            let mint = ctx
                .accounts
                .price_mint
                .as_ref()
                .ok_or(CoordinationError::MissingTokenAccounts)?;
            let expected_mint = skill
                .price_mint
                .ok_or(CoordinationError::InvalidTokenMint)?;
            require!(
                mint.key() == expected_mint,
                CoordinationError::InvalidTokenMint
            );

            // Calculate fee
            // u128 intermediates (audit F-16): price.checked_mul(bps) overflows
            // u64 for prices above ~9.2e15; the post-division fee always fits.
            protocol_fee = (price as u128)
                .checked_mul(config.protocol_fee_bps as u128)
                .ok_or(CoordinationError::ArithmeticOverflow)?
                .checked_div(BASIS_POINTS_DIVISOR as u128)
                .ok_or(CoordinationError::ArithmeticOverflow)? as u64;
            let author_share = price
                .checked_sub(protocol_fee)
                .ok_or(CoordinationError::ArithmeticOverflow)?;

            let buyer_ta = ctx
                .accounts
                .buyer_token_account
                .as_ref()
                .ok_or(CoordinationError::MissingTokenAccounts)?;
            let author_ta = ctx
                .accounts
                .author_token_account
                .as_ref()
                .ok_or(CoordinationError::MissingTokenAccounts)?;
            let treasury_ta = ctx
                .accounts
                .treasury_token_account
                .as_ref()
                .ok_or(CoordinationError::MissingTokenAccounts)?;
            let token_program = ctx
                .accounts
                .token_program
                .as_ref()
                .ok_or(CoordinationError::MissingTokenAccounts)?;

            // Validate token account mints match the skill's price mint
            let expected_mint = mint.key();
            require!(
                buyer_ta.mint == expected_mint,
                CoordinationError::InvalidTokenMint
            );
            require!(
                author_ta.mint == expected_mint,
                CoordinationError::InvalidTokenMint
            );
            require!(
                treasury_ta.mint == expected_mint,
                CoordinationError::InvalidTokenMint
            );

            // Validate token account ownership
            require!(
                buyer_ta.owner == ctx.accounts.authority.key(),
                CoordinationError::InvalidInput
            );
            require!(
                author_ta.owner == ctx.accounts.author_wallet.key(),
                CoordinationError::InvalidInput
            );
            require!(
                treasury_ta.owner == ctx.accounts.treasury.key(),
                CoordinationError::InvalidInput
            );

            // Transfer author_share to author
            if author_share > 0 {
                token::transfer(
                    CpiContext::new(
                        token_program.to_account_info(),
                        Transfer {
                            from: buyer_ta.to_account_info(),
                            to: author_ta.to_account_info(),
                            authority: ctx.accounts.authority.to_account_info(),
                        },
                    ),
                    author_share,
                )?;
            }

            // Transfer protocol_fee to treasury
            if protocol_fee > 0 {
                token::transfer(
                    CpiContext::new(
                        token_program.to_account_info(),
                        Transfer {
                            from: buyer_ta.to_account_info(),
                            to: treasury_ta.to_account_info(),
                            authority: ctx.accounts.authority.to_account_info(),
                        },
                    ),
                    protocol_fee,
                )?;
            }
        } else {
            // SOL payment path
            // u128 intermediates (audit F-16): price.checked_mul(bps) overflows
            // u64 for prices above ~9.2e15; the post-division fee always fits.
            protocol_fee = (price as u128)
                .checked_mul(config.protocol_fee_bps as u128)
                .ok_or(CoordinationError::ArithmeticOverflow)?
                .checked_div(BASIS_POINTS_DIVISOR as u128)
                .ok_or(CoordinationError::ArithmeticOverflow)? as u64;
            let author_share = price
                .checked_sub(protocol_fee)
                .ok_or(CoordinationError::ArithmeticOverflow)?;

            // Transfer author_share to author wallet
            if author_share > 0 {
                system_program::transfer(
                    CpiContext::new(
                        ctx.accounts.system_program.to_account_info(),
                        system_program::Transfer {
                            from: ctx.accounts.authority.to_account_info(),
                            to: ctx.accounts.author_wallet.to_account_info(),
                        },
                    ),
                    author_share,
                )?;
            }

            // Transfer protocol_fee to treasury
            if protocol_fee > 0 {
                system_program::transfer(
                    CpiContext::new(
                        ctx.accounts.system_program.to_account_info(),
                        system_program::Transfer {
                            from: ctx.accounts.authority.to_account_info(),
                            to: ctx.accounts.treasury.to_account_info(),
                        },
                    ),
                    protocol_fee,
                )?;
            }
        }
    }

    // Update skill download count
    let skill = &mut ctx.accounts.skill;
    skill.download_count = skill
        .download_count
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Record purchase
    let purchase_record = &mut ctx.accounts.purchase_record;
    purchase_record.skill = skill.key();
    purchase_record.buyer = buyer.key();
    purchase_record.price_paid = price;
    purchase_record.timestamp = clock.unix_timestamp;
    purchase_record.bump = ctx.bumps.purchase_record;
    purchase_record.snapshot_content_version(skill.version);

    emit!(SkillPurchased {
        skill: skill.key(),
        buyer: buyer.key(),
        author: ctx.accounts.author_agent.key(),
        content_hash: skill.content_hash,
        content_version: skill.version,
        price_paid: price,
        protocol_fee,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
