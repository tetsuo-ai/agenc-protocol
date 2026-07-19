//! Shared SPL token transfer helpers for token-denominated task rewards.
//!
//! These functions handle token CPI calls (transfer, close) with PDA-signed contexts.
//! The escrow PDA acts as the token authority for all token operations.

use crate::errors::CoordinationError;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_lang::system_program;
use anchor_spl::token::{self, Mint, Token, TokenAccount};
use spl_associated_token_account_client::{
    address::get_associated_token_address_with_program_id,
    instruction::create_associated_token_account, program::ID as ASSOCIATED_TOKEN_PROGRAM_ID,
};

/// Lightweight typed marker for the canonical Associated Token Account program.
///
/// Keeping this as `Program<AssociatedToken>` preserves Anchor's program-ID and
/// executable checks, plus the existing IDL/account wire contract, without
/// linking the full ATA + Token-2022 implementation into the classic-SPL build.
#[derive(Clone)]
pub struct AssociatedToken;

impl anchor_lang::Id for AssociatedToken {
    fn id() -> Pubkey {
        ASSOCIATED_TOKEN_PROGRAM_ID
    }
}

/// Reject token rewards whose custody can be frozen after a worker accepts the
/// job. A mint with any live freeze authority lets the creator freeze the escrow
/// ATA after performance and permanently block every payout/refund/close path.
/// An already-frozen ATA remains unsafe even if the authority was later revoked.
pub fn validate_token_reward_custody(mint: &Mint, escrow_ata: &AccountInfo) -> Result<()> {
    require!(
        mint.freeze_authority.is_none(),
        CoordinationError::TokenMintFreezeAuthorityEnabled
    );
    require!(
        escrow_ata.owner == &anchor_spl::token::ID,
        CoordinationError::InvalidTokenEscrow
    );
    let data = escrow_ata.try_borrow_data()?;
    let account = TokenAccount::try_deserialize_unchecked(&mut data.as_ref())
        .map_err(|_| error!(CoordinationError::InvalidTokenEscrow))?;
    require!(
        account.state == anchor_spl::token::spl_token::state::AccountState::Initialized,
        CoordinationError::TokenEscrowFrozen
    );
    Ok(())
}

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
        program.key() == ASSOCIATED_TOKEN_PROGRAM_ID,
        CoordinationError::InvalidInput
    );
    Ok(())
}

/// Validate the single canonical classic-SPL escrow account for a task.
///
/// Mint + token-authority checks are not sufficient: anyone can pre-initialize an
/// arbitrary token account whose token authority is the escrow PDA. If task ingress
/// or a terminal settlement accepts that account, clients deriving the canonical ATA
/// can no longer find the funded custody account, and a substituted account can leave
/// the real reward account stranded after the task becomes terminal. Every task-token
/// path therefore binds custody to the classic Token Program ATA derived from
/// `(escrow_authority, mint)`.
pub fn validate_token_escrow_account(
    account: &AccountInfo<'_>,
    expected_mint: &Pubkey,
    escrow_authority: &Pubkey,
) -> Result<()> {
    let expected_address = get_associated_token_address_with_program_id(
        escrow_authority,
        expected_mint,
        &anchor_spl::token::ID,
    );
    require!(
        account.key() == expected_address,
        CoordinationError::InvalidTokenEscrow
    );
    validate_unchecked_token_mint(account, expected_mint, escrow_authority)
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
    let escrow_mint =
        token::accessor::mint(token_escrow).map_err(|_| CoordinationError::InvalidTokenEscrow)?;
    validate_token_escrow_account(token_escrow, &escrow_mint, escrow_authority.key)?;

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
    let escrow_mint =
        token::accessor::mint(token_escrow).map_err(|_| CoordinationError::InvalidTokenEscrow)?;
    validate_token_escrow_account(token_escrow, &escrow_mint, escrow_authority.key)?;

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
    // A system-owned account is only an uninitialized ATA placeholder when it
    // has no allocated data.  Never pass an arbitrary system account with data
    // into the ATA program as though it were absent.
    require!(
        token_escrow_ata.data_is_empty(),
        CoordinationError::InvalidTokenEscrow
    );

    let create_ix = create_associated_token_account(
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
    require!(
        token_account.state == anchor_spl::token::spl_token::state::AccountState::Initialized,
        CoordinationError::TokenEscrowFrozen
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
    let token_account = TokenAccount::try_deserialize_unchecked(&mut data.as_ref())
        .map_err(|_| error!(CoordinationError::InvalidTokenEscrow))?;
    require!(
        token_account.mint == *expected_mint,
        CoordinationError::InvalidTokenMint
    );
    require!(
        token_account.owner == *expected_owner,
        CoordinationError::InvalidTokenAccountOwner
    );
    require!(
        token_account.state == anchor_spl::token::spl_token::state::AccountState::Initialized,
        CoordinationError::TokenEscrowFrozen
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::program_pack::Pack;
    use anchor_spl::token::spl_token::state::{Account as SplTokenAccount, AccountState};

    fn packed_token_account(mint: Pubkey, authority: Pubkey, state: AccountState) -> Vec<u8> {
        let account = SplTokenAccount {
            mint,
            owner: authority,
            state,
            ..SplTokenAccount::default()
        };
        let mut data = vec![0u8; SplTokenAccount::LEN];
        SplTokenAccount::pack(account, &mut data).unwrap();
        data
    }

    fn validate_data(data: &mut [u8], mint: Pubkey, authority: Pubkey) -> Result<()> {
        let key = Pubkey::new_unique();
        let owner = anchor_spl::token::ID;
        let mut lamports = 1;
        let info = AccountInfo::new(&key, false, false, &mut lamports, data, &owner, false, 0);
        validate_unchecked_token_mint(&info, &mint, &authority)
    }

    fn validate_escrow_data_at(
        data: &mut [u8],
        account_key: Pubkey,
        mint: Pubkey,
        escrow_authority: Pubkey,
    ) -> Result<()> {
        let owner = anchor_spl::token::ID;
        let mut lamports = 1;
        let info = AccountInfo::new(
            &account_key,
            false,
            true,
            &mut lamports,
            data,
            &owner,
            false,
            0,
        );
        validate_token_escrow_account(&info, &mint, &escrow_authority)
    }

    #[test]
    fn unchecked_destination_requires_a_complete_initialized_token_account() {
        let mint = Pubkey::new_unique();
        let authority = Pubkey::new_unique();
        let mut valid = packed_token_account(mint, authority, AccountState::Initialized);
        assert!(validate_data(&mut valid, mint, authority).is_ok());

        // The previous prefix-only parser accepted this 72-byte byte string.
        let mut truncated = vec![0u8; 72];
        truncated[..32].copy_from_slice(mint.as_ref());
        truncated[32..64].copy_from_slice(authority.as_ref());
        assert!(validate_data(&mut truncated, mint, authority).is_err());
    }

    #[test]
    fn unchecked_destination_rejects_frozen_accounts() {
        let mint = Pubkey::new_unique();
        let authority = Pubkey::new_unique();
        let mut frozen = packed_token_account(mint, authority, AccountState::Frozen);
        assert!(validate_data(&mut frozen, mint, authority).is_err());
    }

    #[test]
    fn preinitialized_noncanonical_task_escrow_is_rejected_at_ingress() {
        let mint = Pubkey::new_unique();
        let escrow_authority = Pubkey::new_unique();
        let noncanonical = Pubkey::new_unique();
        let mut account = packed_token_account(mint, escrow_authority, AccountState::Initialized);

        // The token contents are otherwise perfect. The address alone must make
        // the preinitialized-account branch fail closed.
        assert!(validate_data(&mut account.clone(), mint, escrow_authority).is_ok());
        assert!(
            validate_escrow_data_at(&mut account, noncanonical, mint, escrow_authority,).is_err()
        );
    }

    #[test]
    fn terminal_settlement_cannot_substitute_another_escrow_owned_account() {
        let mint = Pubkey::new_unique();
        let escrow_authority = Pubkey::new_unique();
        let canonical = get_associated_token_address_with_program_id(
            &escrow_authority,
            &mint,
            &anchor_spl::token::ID,
        );
        let substituted = Pubkey::new_unique();

        let mut canonical_data =
            packed_token_account(mint, escrow_authority, AccountState::Initialized);
        assert!(
            validate_escrow_data_at(&mut canonical_data, canonical, mint, escrow_authority,)
                .is_ok()
        );

        let mut substituted_data =
            packed_token_account(mint, escrow_authority, AccountState::Initialized);
        assert!(validate_escrow_data_at(
            &mut substituted_data,
            substituted,
            mint,
            escrow_authority,
        )
        .is_err());
    }
}
