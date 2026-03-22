//! Shared SPL token transfer helpers for token-denominated task rewards.
//!
//! These functions handle token CPI calls (transfer, close) with PDA-signed contexts.
//! The escrow PDA acts as the token authority for all token operations.

use crate::errors::CoordinationError;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_lang::system_program;
use anchor_spl::associated_token::{self, AssociatedToken};
use anchor_spl::token::{self, Token, TokenAccount};

fn require_token_program(program: &AccountInfo<'_>) -> Result<()> {
    require!(
        program.key() == anchor_spl::token::ID,
        CoordinationError::InvalidInput
    );
    require!(program.executable, CoordinationError::InvalidAccountOwner);
    Ok(())
}

fn require_associated_token_program(program: &Program<'_, AssociatedToken>) -> Result<()> {
    require!(
        program.key() == associated_token::ID,
        CoordinationError::InvalidInput
    );
    Ok(())
}

fn transfer_tokens_from_escrow_account_info<'info>(
    token_escrow: &AccountInfo<'info>,
    recipient_ata: &AccountInfo<'info>,
    escrow_authority: &AccountInfo<'info>,
    amount: u64,
    escrow_seeds: &[&[u8]],
    token_program: &AccountInfo<'info>,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    require_token_program(token_program)?;

    let transfer_ix = anchor_spl::token::spl_token::instruction::transfer(
        token_program.key,
        token_escrow.key,
        recipient_ata.key,
        escrow_authority.key,
        &[],
        amount,
    )
    .map_err(|_| CoordinationError::TokenTransferFailed)?;
    invoke_signed(
        &transfer_ix,
        &[
            token_escrow.clone(),
            recipient_ata.clone(),
            escrow_authority.clone(),
            token_program.clone(),
        ],
        &[escrow_seeds],
    )
    .map_err(|_| CoordinationError::TokenTransferFailed)?;

    Ok(())
}

fn close_token_account_account_info<'info>(
    token_escrow: &AccountInfo<'info>,
    rent_recipient: &AccountInfo<'info>,
    escrow_authority: &AccountInfo<'info>,
    escrow_seeds: &[&[u8]],
    token_program: &AccountInfo<'info>,
) -> Result<()> {
    require_token_program(token_program)?;

    let close_ix = anchor_spl::token::spl_token::instruction::close_account(
        token_program.key,
        token_escrow.key,
        rent_recipient.key,
        escrow_authority.key,
        &[],
    )
    .map_err(|_| CoordinationError::TokenTransferFailed)?;
    invoke_signed(
        &close_ix,
        &[
            token_escrow.clone(),
            rent_recipient.clone(),
            escrow_authority.clone(),
            token_program.clone(),
        ],
        &[escrow_seeds],
    )
    .map_err(|_| CoordinationError::TokenTransferFailed)?;

    Ok(())
}

/// Transfer tokens from escrow ATA to a recipient ATA using PDA-signed CPI.
///
/// # Arguments
/// * `token_escrow` - The escrow's associated token account (source)
/// * `recipient_ata` - The recipient's associated token account (destination)
/// * `escrow_authority` - The escrow PDA that owns the token account
/// * `amount` - Number of tokens to transfer
/// * `escrow_seeds` - PDA signer seeds: `[b"escrow", task_key, &[bump]]`
/// * `token_program` - SPL Token program
pub fn transfer_tokens_from_escrow<'info>(
    token_escrow: &mut Account<'info, TokenAccount>,
    recipient_ata: &AccountInfo<'info>,
    escrow_authority: &AccountInfo<'info>,
    amount: u64,
    escrow_seeds: &[&[u8]],
    token_program: &Program<'info, Token>,
) -> Result<()> {
    transfer_tokens_from_escrow_account_info(
        &token_escrow.to_account_info(),
        recipient_ata,
        escrow_authority,
        amount,
        escrow_seeds,
        &token_program.to_account_info(),
    )
}

/// Close an escrow token account, first sweeping any residual token dust to a
/// validated destination token account.
///
/// This hardens all close paths against unsolicited-token griefing where extra
/// inbound tokens would otherwise make `close_account` fail and revert the flow.
pub fn close_token_escrow_account_info<'info>(
    token_escrow: &mut Account<'info, TokenAccount>,
    expected_residual_amount: u64,
    dust_recipient_ata: &AccountInfo<'info>,
    rent_recipient: &AccountInfo<'info>,
    escrow_authority: &AccountInfo<'info>,
    escrow_seeds: &[&[u8]],
    token_program: &Program<'info, Token>,
) -> Result<()> {
    // Sweep full live balance at close-time, not just caller-computed residuals.
    // This prevents close-account failures from unsolicited token deposits.
    let live_balance = token::accessor::amount(&token_escrow.to_account_info())
        .map_err(|_| CoordinationError::TokenTransferFailed)?;
    if live_balance != expected_residual_amount {
        msg!(
            "token escrow close residual mismatch: expected {}, live {}",
            expected_residual_amount,
            live_balance
        );
    }

    if live_balance > 0 {
        transfer_tokens_from_escrow_account_info(
            &token_escrow.to_account_info(),
            dust_recipient_ata,
            escrow_authority,
            live_balance,
            escrow_seeds,
            &token_program.to_account_info(),
        )?;
    }

    let remaining_balance = token::accessor::amount(&token_escrow.to_account_info())
        .map_err(|_| CoordinationError::TokenTransferFailed)?;
    require!(
        remaining_balance == 0,
        CoordinationError::TokenTransferFailed
    );

    close_token_account_account_info(
        &token_escrow.to_account_info(),
        rent_recipient,
        escrow_authority,
        escrow_seeds,
        &token_program.to_account_info(),
    )
}

/// Close an escrow token account, returning rent to `rent_recipient` via PDA-signed CPI.
///
/// # Arguments
/// * `token_escrow` - The escrow's associated token account to close
/// * `residual_amount` - Known residual balance to sweep before close
/// * `dust_recipient_ata` - Token account that receives any residual token dust
/// * `rent_recipient` - Account to receive the rent-exempt lamports
/// * `escrow_authority` - The escrow PDA that owns the token account
/// * `escrow_seeds` - PDA signer seeds: `[b"escrow", task_key, &[bump]]`
/// * `token_program` - SPL Token program
pub fn close_token_escrow<'info>(
    token_escrow: &mut Account<'info, TokenAccount>,
    residual_amount: u64,
    dust_recipient_ata: &AccountInfo<'info>,
    rent_recipient: &AccountInfo<'info>,
    escrow_authority: &AccountInfo<'info>,
    escrow_seeds: &[&[u8]],
    token_program: &Program<'info, Token>,
) -> Result<()> {
    close_token_escrow_account_info(
        token_escrow,
        residual_amount,
        dust_recipient_ata,
        rent_recipient,
        escrow_authority,
        escrow_seeds,
        token_program,
    )
}

pub fn ensure_token_escrow_ata<'info>(
    token_escrow_ata: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    escrow_authority: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    system_program: &Program<'info, System>,
    token_program: &Program<'info, Token>,
    ata_program: &Program<'info, AssociatedToken>,
) -> Result<()> {
    require_token_program(&token_program.to_account_info())?;
    require_associated_token_program(ata_program)?;

    if token_escrow_ata.owner != &system_program::ID {
        return Ok(());
    }

    let create_ix = associated_token::spl_associated_token_account::instruction::create_associated_token_account(
        payer.key,
        escrow_authority.key,
        mint.key,
        token_program.key,
    );
    invoke(
        &create_ix,
        &[
            payer.clone(),
            token_escrow_ata.clone(),
            escrow_authority.clone(),
            mint.clone(),
            system_program.to_account_info(),
            token_program.to_account_info(),
        ],
    )
    .map_err(|_| CoordinationError::TokenTransferFailed)?;

    Ok(())
}

/// Validate that a token account has the expected mint and owner.
pub fn validate_token_account(
    token_account: &TokenAccount,
    expected_mint: &Pubkey,
    expected_owner: &Pubkey,
) -> Result<()> {
    require!(
        token_account.mint == *expected_mint,
        CoordinationError::InvalidTokenMint
    );
    require!(
        token_account.owner == *expected_owner,
        CoordinationError::InvalidTokenEscrow
    );
    Ok(())
}

/// Validate an UncheckedAccount is a valid SPL token account with the expected mint
/// and authority (SPL token account owner).
///
/// Used for worker_token_account which is UncheckedAccount to allow flexible
/// destination, but must still be a valid token account with the correct mint
/// and must be owned by the expected authority to prevent reward theft.
///
/// SPL TokenAccount layout (first 72 bytes):
/// - bytes  0..32: mint pubkey
/// - bytes 32..64: owner (authority) pubkey
/// - bytes 64..72: amount (u64 LE)
pub fn validate_unchecked_token_mint(
    account: &AccountInfo,
    expected_mint: &Pubkey,
    expected_owner: &Pubkey,
) -> Result<()> {
    require!(
        account.owner == &anchor_spl::token::ID,
        CoordinationError::InvalidTokenEscrow
    );
    let data = account.try_borrow_data()?;
    require!(data.len() >= 72, CoordinationError::InvalidTokenEscrow);

    // Validate mint (bytes 0..32)
    let mint_bytes: [u8; 32] = data[0..32]
        .try_into()
        .map_err(|_| error!(CoordinationError::InvalidTokenEscrow))?;
    let mint = Pubkey::new_from_array(mint_bytes);
    require!(mint == *expected_mint, CoordinationError::InvalidTokenMint);

    // Validate token account authority (bytes 32..64)
    let owner_bytes: [u8; 32] = data[32..64]
        .try_into()
        .map_err(|_| error!(CoordinationError::InvalidTokenEscrow))?;
    let owner = Pubkey::new_from_array(owner_bytes);
    require!(
        owner == *expected_owner,
        CoordinationError::InvalidTokenAccountOwner
    );

    Ok(())
}
