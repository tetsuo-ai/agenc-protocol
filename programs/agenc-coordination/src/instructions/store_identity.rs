//! P5.2 — permissionless store/marketplace identity (batch 2).
//!
//! Three full-module-only instructions over the address-keyed `["store", owner]`
//! PDA (`docs/P5_2_STORE_IDENTITY_SPEC.md` §7, ratified 2026-07-03):
//!
//! - `register_store` — permissionless, self-signed, self-paid; deposits the
//!   hardcoded 0.05 SOL `STORE_REGISTRATION_BOND_LAMPORTS` onto the PDA via an
//!   in-handler CPI (the P1.2 finding-5 discipline: ENFORCE the bond, don't
//!   assume it).
//! - `update_store` — owner-only; bumps the monotonic `version`.
//! - `close_store` — owner-only; refunds rent + bond in ONE close. No exit
//!   cooldown: nothing money-bearing consumes `Store` in v1 (spec §7.2), so
//!   there is no scam-then-exit window to close.
//!
//! The fee fields are advertised DEFAULTS, not enforcement — listings and hires
//! keep snapshotting terms exactly as today. The handle is DISPLAY-ONLY and not
//! unique on-chain (spec §6); the on-chain floor is charset validation only.
//! No authority, no multisig, no attestor anywhere in the lifecycle (the
//! `CREDIBLE_EXIT.md` test).

#![cfg(not(feature = "mainnet-canary"))]

use crate::errors::CoordinationError;
use crate::events::{StoreClosed, StoreRegistered, StoreUpdated};
use crate::instructions::constants::{
    MAX_OPERATOR_FEE_BPS, MAX_REFERRER_FEE_BPS, STORE_REGISTRATION_BOND_LAMPORTS,
};
use crate::state::{
    validate_store_handle, validate_verified_domain, Store, STORE_METADATA_URI_MAX_LEN,
};
use anchor_lang::prelude::*;
use anchor_lang::system_program;

/// Shared pure validation for register/update args. Every rule is the subject of
/// a unit test below (remove one `require!` and a test turns red):
///  1. handle charset floor (`validate_store_handle`);
///  2. bounded metadata URI (empty allowed = no manifest pinned yet);
///  3. per-leg fee caps (`MAX_REFERRER_FEE_BPS` / `MAX_OPERATOR_FEE_BPS`);
///  4. operator-fee pairing (non-default payee iff fee > 0 — the
///     `create_service_listing` rule, both directions);
///  5. domain floor (`validate_verified_domain`-equivalent; empty = hosted-only).
pub(crate) fn validate_store_args(
    handle: &[u8; 32],
    metadata_uri: &str,
    referrer_fee_bps: u16,
    operator: &Pubkey,
    operator_fee_bps: u16,
    domain: &str,
) -> Result<()> {
    require!(
        validate_store_handle(handle),
        CoordinationError::InvalidStoreHandle
    );
    require!(
        metadata_uri.len() <= STORE_METADATA_URI_MAX_LEN,
        CoordinationError::InvalidStoreMetadataUri
    );
    require!(
        referrer_fee_bps <= MAX_REFERRER_FEE_BPS,
        CoordinationError::ReferrerFeeTooHigh
    );
    require!(
        operator_fee_bps <= MAX_OPERATOR_FEE_BPS,
        CoordinationError::ListingOperatorFeeTooHigh
    );
    // Pairing, both directions: a fee with no payee silently drops the leg; a
    // payee with no fee advertises a meaningless default.
    require!(
        (operator_fee_bps > 0) == (*operator != Pubkey::default()),
        CoordinationError::InvalidStoreOperatorTerms
    );
    require!(
        domain.is_empty() || validate_verified_domain(domain),
        CoordinationError::InvalidStoreDomain
    );
    Ok(())
}

/// The manifest hash and URI must be pinned TOGETHER: both set (a fetchable
/// manifest with an on-chain integrity commitment) or both empty (no manifest
/// pinned). A non-zero hash with an empty URI advertises an integrity commitment
/// for something unfetchable; a URI with an all-zero hash serves a manifest with
/// no integrity pin. Both contradict the `Store` struct's "all-zero/empty = no
/// manifest pinned" semantics, so reject them at register/update.
pub(crate) fn validate_store_manifest(metadata_hash: &[u8; 32], metadata_uri: &str) -> Result<()> {
    // Parity check: hash-set XOR uri-empty must never disagree — i.e. hash set
    // iff uri present. (Written as `!=` for clippy::nonminimal_bool; identical to
    // the original `(hash set) == !(uri empty)`.)
    require!(
        (*metadata_hash != [0u8; 32]) != metadata_uri.is_empty(),
        CoordinationError::InvalidStoreManifest
    );
    Ok(())
}

// ================================ register_store ================================

#[derive(Accounts)]
pub struct RegisterStore<'info> {
    /// `init` ⇒ one store per wallet (the live product invariant); registering
    /// twice fails at account creation, and a re-register after close re-inits a
    /// fresh entry.
    #[account(
        init,
        payer = owner,
        space = Store::SIZE,
        seeds = [b"store", owner.key().as_ref()],
        bump
    )]
    pub store: Box<Account<'info, Store>>,

    /// The self-registering store owner. No authority constraint — this is the
    /// permissionless path. Pays rent AND the registration bond.
    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn register_handler(
    ctx: Context<RegisterStore>,
    handle: [u8; 32],
    metadata_hash: [u8; 32],
    metadata_uri: String,
    referrer_fee_bps: u16,
    operator: Pubkey,
    operator_fee_bps: u16,
    domain: String,
) -> Result<()> {
    validate_store_args(
        &handle,
        &metadata_uri,
        referrer_fee_bps,
        &operator,
        operator_fee_bps,
        &domain,
    )?;
    validate_store_manifest(&metadata_hash, &metadata_uri)?;
    let clock = Clock::get()?;

    // Deposit the bond via an in-handler CPI that cannot be skipped (mirrors
    // register_moderation_attestor).
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.owner.to_account_info(),
                to: ctx.accounts.store.to_account_info(),
            },
        ),
        STORE_REGISTRATION_BOND_LAMPORTS,
    )?;

    // Post-condition (defense in depth): the PDA actually holds rent + bond.
    let rent_min = Rent::get()?.minimum_balance(Store::SIZE);
    let required = rent_min
        .checked_add(STORE_REGISTRATION_BOND_LAMPORTS)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    require!(
        ctx.accounts.store.to_account_info().lamports() >= required,
        CoordinationError::StoreBondMissing
    );

    let owner_key = ctx.accounts.owner.key();
    let store_key = ctx.accounts.store.key();
    let store = ctx.accounts.store.as_mut();
    store.owner = owner_key;
    store.handle = handle;
    store.metadata_hash = metadata_hash;
    store.metadata_uri = metadata_uri;
    store.referrer_fee_bps = referrer_fee_bps;
    store.operator = operator;
    store.operator_fee_bps = operator_fee_bps;
    store.domain = domain;
    store.bond_lamports = STORE_REGISTRATION_BOND_LAMPORTS;
    store.version = 1;
    store.created_at = clock.unix_timestamp;
    store.updated_at = clock.unix_timestamp;
    store.bump = ctx.bumps.store;
    store._reserved = [0u8; 64];

    emit!(StoreRegistered {
        store: store_key,
        owner: owner_key,
        handle,
        bond_lamports: STORE_REGISTRATION_BOND_LAMPORTS,
        timestamp: clock.unix_timestamp,
    });
    Ok(())
}

// ================================= update_store =================================

#[derive(Accounts)]
pub struct UpdateStore<'info> {
    #[account(
        mut,
        seeds = [b"store", owner.key().as_ref()],
        bump = store.bump,
        has_one = owner @ CoordinationError::UnauthorizedTaskAction
    )]
    pub store: Box<Account<'info, Store>>,

    pub owner: Signer<'info>,
}

pub fn update_handler(
    ctx: Context<UpdateStore>,
    handle: [u8; 32],
    metadata_hash: [u8; 32],
    metadata_uri: String,
    referrer_fee_bps: u16,
    operator: Pubkey,
    operator_fee_bps: u16,
    domain: String,
) -> Result<()> {
    validate_store_args(
        &handle,
        &metadata_uri,
        referrer_fee_bps,
        &operator,
        operator_fee_bps,
        &domain,
    )?;
    validate_store_manifest(&metadata_hash, &metadata_uri)?;
    let clock = Clock::get()?;

    let owner_key = ctx.accounts.owner.key();
    let store_key = ctx.accounts.store.key();
    let store = ctx.accounts.store.as_mut();
    store.handle = handle;
    store.metadata_hash = metadata_hash;
    store.metadata_uri = metadata_uri;
    store.referrer_fee_bps = referrer_fee_bps;
    store.operator = operator;
    store.operator_fee_bps = operator_fee_bps;
    store.domain = domain;
    // Monotonic version for indexer staleness/CAS. No bond change on update.
    store.version = store
        .version
        .checked_add(1)
        .ok_or(CoordinationError::ArithmeticOverflow)?;
    store.updated_at = clock.unix_timestamp;

    emit!(StoreUpdated {
        store: store_key,
        owner: owner_key,
        handle,
        version: store.version,
        timestamp: clock.unix_timestamp,
    });
    Ok(())
}

// ================================= close_store ==================================

#[derive(Accounts)]
pub struct CloseStore<'info> {
    /// `close = owner` refunds rent + the bond (held as excess lamports on the
    /// PDA) to the owner in one step — never confiscatable, owner-only.
    #[account(
        mut,
        close = owner,
        seeds = [b"store", owner.key().as_ref()],
        bump = store.bump,
        has_one = owner @ CoordinationError::UnauthorizedTaskAction
    )]
    pub store: Box<Account<'info, Store>>,

    #[account(mut)]
    pub owner: Signer<'info>,
}

pub fn close_handler(ctx: Context<CloseStore>) -> Result<()> {
    let clock = Clock::get()?;
    // The account is closed by Anchor (`close = owner`) AFTER this handler returns,
    // so its current balance is exactly what will be refunded to the owner: rent +
    // bond + any lamports sent to the PDA post-registration.
    let refunded_lamports = ctx.accounts.store.to_account_info().lamports();
    emit!(StoreClosed {
        store: ctx.accounts.store.key(),
        owner: ctx.accounts.owner.key(),
        bond_lamports: ctx.accounts.store.bond_lamports,
        refunded_lamports,
        timestamp: clock.unix_timestamp,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handle_bytes(s: &str) -> [u8; 32] {
        let mut h = [0u8; 32];
        h[..s.len()].copy_from_slice(s.as_bytes());
        h
    }

    fn ok_args() -> ([u8; 32], String, u16, Pubkey, u16, String) {
        (
            handle_bytes("acme"),
            "https://acme.example/.well-known/agenc-store.json".to_string(),
            500,
            Pubkey::new_unique(),
            1000,
            "acme.example".to_string(),
        )
    }

    #[test]
    fn accepts_valid_store_args() {
        let (h, uri, rbps, op, obps, domain) = ok_args();
        assert!(validate_store_args(&h, &uri, rbps, &op, obps, &domain).is_ok());
        // Hosted-only store: empty domain, empty URI, no legs.
        assert!(
            validate_store_args(&h, "", 0, &Pubkey::default(), 0, "").is_ok(),
            "empty URI/domain and no fee legs must be a valid hosted-only store"
        );
    }

    // Revert-sensitive: drop the handle require! and this goes red.
    #[test]
    fn rejects_invalid_handle() {
        let (_, uri, rbps, op, obps, domain) = ok_args();
        let err =
            validate_store_args(&handle_bytes("Ac me"), &uri, rbps, &op, obps, &domain).unwrap_err();
        assert_eq!(err, CoordinationError::InvalidStoreHandle.into());
    }

    // Revert-sensitive: drop the URI-length require! and this goes red.
    #[test]
    fn rejects_overlong_metadata_uri() {
        let (h, _, rbps, op, obps, domain) = ok_args();
        let uri = "a".repeat(STORE_METADATA_URI_MAX_LEN + 1);
        let err = validate_store_args(&h, &uri, rbps, &op, obps, &domain).unwrap_err();
        assert_eq!(err, CoordinationError::InvalidStoreMetadataUri.into());
        let max = "a".repeat(STORE_METADATA_URI_MAX_LEN);
        assert!(validate_store_args(&h, &max, rbps, &op, obps, &domain).is_ok());
    }

    // Revert-sensitive: drop the per-leg caps and these go red.
    #[test]
    fn rejects_fees_over_per_leg_caps() {
        let (h, uri, _, op, _, domain) = ok_args();
        let err = validate_store_args(&h, &uri, MAX_REFERRER_FEE_BPS + 1, &op, 100, &domain)
            .unwrap_err();
        assert_eq!(err, CoordinationError::ReferrerFeeTooHigh.into());
        let err = validate_store_args(&h, &uri, 100, &op, MAX_OPERATOR_FEE_BPS + 1, &domain)
            .unwrap_err();
        assert_eq!(err, CoordinationError::ListingOperatorFeeTooHigh.into());
        assert!(
            validate_store_args(&h, &uri, MAX_REFERRER_FEE_BPS, &op, MAX_OPERATOR_FEE_BPS, &domain)
                .is_ok()
        );
    }

    // Revert-sensitive: drop the pairing require! and both directions go red.
    #[test]
    fn rejects_unpaired_operator_terms() {
        let (h, uri, rbps, op, _, domain) = ok_args();
        // Fee with default payee.
        let err =
            validate_store_args(&h, &uri, rbps, &Pubkey::default(), 100, &domain).unwrap_err();
        assert_eq!(err, CoordinationError::InvalidStoreOperatorTerms.into());
        // Payee with zero fee.
        let err = validate_store_args(&h, &uri, rbps, &op, 0, &domain).unwrap_err();
        assert_eq!(err, CoordinationError::InvalidStoreOperatorTerms.into());
    }

    // Revert-sensitive: drop the manifest pairing require! and both mismatch
    // directions go red; the two matched cases must stay OK.
    #[test]
    fn manifest_hash_and_uri_must_be_paired() {
        let nonzero = [7u8; 32];
        let zero = [0u8; 32];
        let uri = "https://acme.example/.well-known/agenc-store.json";
        // Matched: both set, or both empty.
        assert!(validate_store_manifest(&nonzero, uri).is_ok());
        assert!(validate_store_manifest(&zero, "").is_ok());
        // Mismatched: hash with no URI, or URI with no hash.
        assert_eq!(
            validate_store_manifest(&nonzero, "").unwrap_err(),
            CoordinationError::InvalidStoreManifest.into()
        );
        assert_eq!(
            validate_store_manifest(&zero, uri).unwrap_err(),
            CoordinationError::InvalidStoreManifest.into()
        );
    }

    // Revert-sensitive: drop the domain require! and this goes red.
    #[test]
    fn rejects_invalid_domain() {
        let (h, uri, rbps, op, obps, _) = ok_args();
        for bad in [".acme.example", "acme.example.", "ac me.example"] {
            let err = validate_store_args(&h, &uri, rbps, &op, obps, bad).unwrap_err();
            assert_eq!(err, CoordinationError::InvalidStoreDomain.into(), "{bad}");
        }
    }

    #[test]
    fn store_bond_is_the_ratified_005_sol() {
        assert_eq!(STORE_REGISTRATION_BOND_LAMPORTS, 50_000_000);
    }
}
