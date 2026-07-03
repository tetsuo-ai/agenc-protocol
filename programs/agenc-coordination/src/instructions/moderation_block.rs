//! The BLOCK-only global takedown floor (P1.2 §5.2), multisig-written.
//!
//! `set_moderation_block` / `clear_moderation_block` are gated by
//! `require_multisig_threshold` over `ProtocolConfig.multisig_owners` — the SAME
//! direct M-of-N check `update_protocol_fee` uses, NEVER the single-key
//! moderation-authority `record_*` path and NEVER the stake-weighted proposal
//! machinery. The block account is keyed by CONTENT HASH alone so a takedown cannot
//! be evaded by re-minting the same content under a fresh task/listing PDA; all three
//! consumption gates derive the address in-handler from the hash they already gate,
//! so the caller cannot omit or substitute it.
//!
//! This is a discretionary multisig takedown lever, accepted as the price of not
//! hosting structurally un-takedownable illegal/sanctioned supply on an
//! escrow-custodying program. It is bounded two ways: it can only BLOCK (never allow
//! anything in — a fail-open blacklist; key-death preserves publishing), and every
//! block carries a REQUIRED on-chain rationale (`rationale_hash` + `rationale_uri`,
//! the `resolve_dispute` precedent). Blocks are indefinite until cleared; `clear`
//! keeps the account open as the audit trail.

use crate::errors::CoordinationError;
use crate::events::{ModerationBlockCleared, ModerationBlockSet};
use crate::state::{
    moderation_block_status, ModerationBlock, ProtocolConfig, HASH_SIZE, MODERATION_URI_MAX_LEN,
};
use crate::utils::multisig::{require_multisig_threshold, unique_account_infos};
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(content_hash: [u8; HASH_SIZE])]
pub struct SetModerationBlock<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// `init_if_needed`: a cleared block can be re-set (same PDA, audit trail intact)
    /// and a live block's rationale can be updated.
    #[account(
        init_if_needed,
        payer = authority,
        space = ModerationBlock::SIZE,
        seeds = [b"moderation_block", content_hash.as_ref()],
        bump
    )]
    pub moderation_block: Box<Account<'info, ModerationBlock>>,

    /// Fee payer / tx assembler. Approval authority is the multisig threshold over
    /// `remaining_accounts`, exactly like `update_protocol_fee`.
    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler_set(
    ctx: Context<SetModerationBlock>,
    content_hash: [u8; HASH_SIZE],
    rationale_hash: [u8; HASH_SIZE],
    rationale_uri: String,
) -> Result<()> {
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::MultisigNotEnoughSigners
    );
    let unique_signers = unique_account_infos(ctx.remaining_accounts);
    require_multisig_threshold(&ctx.accounts.protocol_config, &unique_signers)?;

    require!(
        content_hash.iter().any(|byte| *byte != 0),
        CoordinationError::InvalidTaskJobSpecHash
    );
    validate_block_rationale(&rationale_hash, &rationale_uri)?;

    let clock = Clock::get()?;
    let block = ctx.accounts.moderation_block.as_mut();
    block.content_hash = content_hash;
    block.status = moderation_block_status::BLOCKED;
    block.rationale_hash = rationale_hash;
    block.rationale_uri = rationale_uri.clone();
    if block.set_at == 0 {
        block.set_at = clock.unix_timestamp;
    }
    block.updated_at = clock.unix_timestamp;
    block.updated_by = ctx.accounts.authority.key();
    block.bump = ctx.bumps.moderation_block;

    emit!(ModerationBlockSet {
        content_hash,
        rationale_hash,
        rationale_uri,
        updated_by: ctx.accounts.authority.key(),
        timestamp: clock.unix_timestamp,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ClearModerationBlock<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// Seeded by its own stored `content_hash` (canonical PDA). Stays open after the
    /// clear — the on-chain audit trail of the takedown.
    #[account(
        mut,
        seeds = [b"moderation_block", moderation_block.content_hash.as_ref()],
        bump = moderation_block.bump
    )]
    pub moderation_block: Box<Account<'info, ModerationBlock>>,

    pub authority: Signer<'info>,
}

pub fn handler_clear(ctx: Context<ClearModerationBlock>) -> Result<()> {
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::MultisigNotEnoughSigners
    );
    let unique_signers = unique_account_infos(ctx.remaining_accounts);
    require_multisig_threshold(&ctx.accounts.protocol_config, &unique_signers)?;

    let clock = Clock::get()?;
    let block = ctx.accounts.moderation_block.as_mut();
    block.status = moderation_block_status::CLEARED;
    block.updated_at = clock.unix_timestamp;
    block.updated_by = ctx.accounts.authority.key();

    emit!(ModerationBlockCleared {
        content_hash: block.content_hash,
        updated_by: ctx.accounts.authority.key(),
        timestamp: clock.unix_timestamp,
    });
    Ok(())
}

/// The rationale is REQUIRED on every block (spec §5.2, review finding 9): non-zero
/// hash, non-empty and bounded URI.
pub fn validate_block_rationale(
    rationale_hash: &[u8; HASH_SIZE],
    rationale_uri: &str,
) -> Result<()> {
    require!(
        rationale_hash.iter().any(|byte| *byte != 0),
        CoordinationError::InvalidModerationRationale
    );
    require!(
        !rationale_uri.trim().is_empty(),
        CoordinationError::InvalidModerationRationale
    );
    require!(
        rationale_uri.len() <= MODERATION_URI_MAX_LEN,
        CoordinationError::InvalidModerationRationale
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_complete_rationale() {
        let mut hash = [0u8; HASH_SIZE];
        hash[0] = 7;
        assert!(validate_block_rationale(&hash, "agenc://takedown/sha256/abc").is_ok());
    }

    #[test]
    fn rejects_zero_rationale_hash() {
        let err = validate_block_rationale(&[0u8; HASH_SIZE], "agenc://takedown/abc").unwrap_err();
        assert_eq!(err, CoordinationError::InvalidModerationRationale.into());
    }

    #[test]
    fn rejects_empty_rationale_uri() {
        let mut hash = [0u8; HASH_SIZE];
        hash[0] = 7;
        let err = validate_block_rationale(&hash, " \t ").unwrap_err();
        assert_eq!(err, CoordinationError::InvalidModerationRationale.into());
    }

    #[test]
    fn rejects_oversized_rationale_uri() {
        let mut hash = [0u8; HASH_SIZE];
        hash[0] = 7;
        let uri = "a".repeat(MODERATION_URI_MAX_LEN + 1);
        let err = validate_block_rationale(&hash, &uri).unwrap_err();
        assert_eq!(err, CoordinationError::InvalidModerationRationale.into());
    }
}
