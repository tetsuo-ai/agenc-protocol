//! Revision 9 (E): one shared create-if-missing path for the record PDAs
//! (`AgentStats` at `["agent_stats", agent]`, `CreatorStats` at
//! `["creator_stats", wallet]`).
//!
//! Records are required on every reject, freeze, cancel, ruling and expiry, and
//! whoever sends the instruction creates a missing one. Anchor's
//! `init_if_needed` expands about 6.4 KB of program code at every site, which
//! the revision 9 record wiring would repeat at more than fifteen sites. These
//! functions are that expansion written once: the instruction context pins the
//! record address with `seeds` (an `UncheckedAccount`, so the wire and the IDL
//! entry are unchanged), and the handler calls them.
//!
//! Two phases, because the create is a system-program CPI:
//! - `ensure_*` creates a missing record and sets its identity. Call it before
//!   the handler moves any lamports directly: a CPI made after direct lamport
//!   moves fails with `UnbalancedInstruction` (the runtime sees the payer's new
//!   balance without the matching debit on an account outside the CPI).
//!   Anchor's `init_if_needed` runs in the same place, before the handler.
//! - `count_*` increments one counter on the record and emits the event. It
//!   makes no CPI and can run anywhere after `ensure_*`.
//!
//! The create follows Anchor's `init_if_needed` exactly:
//! - a system-owned address is created with the record's rent-exempt minimum,
//!   paid by `payer`; a pre-funded address (lamports but no data) is topped up,
//!   allocated and assigned instead, so a stranger's transfer can never block it;
//! - a program-owned address must already hold this record type (discriminator
//!   checked) at exactly its size and be rent exempt;
//! - anything else fails.

#![cfg(not(feature = "mainnet-canary"))]

use crate::errors::CoordinationError;
use crate::events::{AgentTrackRecordUpdated, CreatorTrackRecordUpdated};
use crate::instructions::agent_stats_helpers::{bump_counter, Counter};
use crate::instructions::creator_stats_helpers::{bump_creator_counter, CreatorCounter};
use crate::state::{AgentStats, CreatorStats};
use anchor_lang::prelude::*;
use anchor_lang::system_program::{
    allocate, assign, create_account, transfer, Allocate, Assign, CreateAccount, Transfer,
};

/// Create the record PDA if it does not exist yet. Returns `true` when it was
/// created in this call (its data is then all zero, with no discriminator yet).
fn create_record_if_missing<'info>(
    record: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    signer_seeds: &[&[u8]],
    space: usize,
) -> Result<bool> {
    let rent = Rent::get()?;
    if record.owner == &crate::ID {
        require!(
            record.data_len() == space && rent.is_exempt(record.lamports(), space),
            CoordinationError::InvalidInput
        );
        return Ok(false);
    }
    require!(
        record.owner == &anchor_lang::system_program::ID && record.data_is_empty(),
        CoordinationError::InvalidAccountOwner
    );
    require!(
        system_program.key() == anchor_lang::system_program::ID,
        CoordinationError::InvalidInput
    );
    let required = rent.minimum_balance(space);
    let signer = &[signer_seeds];
    if record.lamports() == 0 {
        create_account(
            CpiContext::new_with_signer(
                system_program.clone(),
                CreateAccount {
                    from: payer.clone(),
                    to: record.clone(),
                },
                signer,
            ),
            required,
            space as u64,
            &crate::ID,
        )?;
    } else {
        let shortfall = required.saturating_sub(record.lamports());
        if shortfall > 0 {
            transfer(
                CpiContext::new(
                    system_program.clone(),
                    Transfer {
                        from: payer.clone(),
                        to: record.clone(),
                    },
                ),
                shortfall,
            )?;
        }
        allocate(
            CpiContext::new_with_signer(
                system_program.clone(),
                Allocate {
                    account_to_allocate: record.clone(),
                },
                signer,
            ),
            space as u64,
        )?;
        assign(
            CpiContext::new_with_signer(
                system_program.clone(),
                Assign {
                    account_to_assign: record.clone(),
                },
                signer,
            ),
            &crate::ID,
        )?;
    }
    Ok(true)
}

fn load_agent_stats(record: &AccountInfo) -> Result<AgentStats> {
    require!(
        record.owner == &crate::ID,
        CoordinationError::InvalidAccountOwner
    );
    let data = record.try_borrow_data()?;
    AgentStats::try_deserialize(&mut &data[..])
}

fn store_agent_stats(record: &AccountInfo, stats: &AgentStats) -> Result<()> {
    let mut data = record.try_borrow_mut_data()?;
    stats.try_serialize(&mut &mut data[..])
}

fn load_creator_stats(record: &AccountInfo) -> Result<CreatorStats> {
    require!(
        record.owner == &crate::ID,
        CoordinationError::InvalidAccountOwner
    );
    let data = record.try_borrow_data()?;
    CreatorStats::try_deserialize(&mut &data[..])
}

fn store_creator_stats(record: &AccountInfo, stats: &CreatorStats) -> Result<()> {
    let mut data = record.try_borrow_mut_data()?;
    stats.try_serialize(&mut &mut data[..])
}

/// Phase 1 for the worker record at `record` (seeds-pinned by the instruction
/// context to `["agent_stats", agent]` with canonical `bump`): create it when
/// missing and set its identity. Call before the handler moves any lamports.
pub(crate) fn ensure_agent_stats<'info>(
    record: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    agent: Pubkey,
    bump: u8,
) -> Result<()> {
    let created = create_record_if_missing(
        record,
        payer,
        system_program,
        &[b"agent_stats", agent.as_ref(), &[bump]],
        AgentStats::SIZE,
    )?;
    let mut stats = if created {
        AgentStats::default()
    } else {
        load_agent_stats(record)?
    };
    stats.init_if_fresh(agent, bump);
    require!(stats.agent == agent, CoordinationError::InvalidInput);
    store_agent_stats(record, &stats)
}

/// Phase 2: increment `counter` on a worker record that `ensure_agent_stats`
/// prepared, and emit `AgentTrackRecordUpdated`. No CPI.
pub(crate) fn count_agent_stats(
    record: &AccountInfo,
    agent: Pubkey,
    counter: Counter,
    now: i64,
) -> Result<()> {
    let mut stats = load_agent_stats(record)?;
    require!(stats.agent == agent, CoordinationError::InvalidInput);
    let new_value = bump_counter(&mut stats, counter, now)?;
    store_agent_stats(record, &stats)?;
    emit!(AgentTrackRecordUpdated {
        agent,
        agent_stats: record.key(),
        counter: counter.event_variant(),
        new_value,
        timestamp: now,
    });
    Ok(())
}

/// Phase 1 for the creator record at `record` (seeds-pinned by the instruction
/// context to `["creator_stats", wallet]` with canonical `bump`): create it
/// when missing and set its identity. Call before the handler moves any
/// lamports.
pub(crate) fn ensure_creator_stats<'info>(
    record: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    wallet: Pubkey,
    bump: u8,
) -> Result<()> {
    let created = create_record_if_missing(
        record,
        payer,
        system_program,
        &[b"creator_stats", wallet.as_ref(), &[bump]],
        CreatorStats::SIZE,
    )?;
    let mut stats = if created {
        CreatorStats::default()
    } else {
        load_creator_stats(record)?
    };
    stats.init_if_fresh(wallet, bump);
    require!(stats.wallet == wallet, CoordinationError::InvalidInput);
    store_creator_stats(record, &stats)
}

/// Phase 2: increment `counter` on a creator record that `ensure_creator_stats`
/// prepared, and emit `CreatorTrackRecordUpdated`. No CPI.
pub(crate) fn count_creator_stats(
    record: &AccountInfo,
    wallet: Pubkey,
    counter: CreatorCounter,
    now: i64,
) -> Result<()> {
    let mut stats = load_creator_stats(record)?;
    require!(stats.wallet == wallet, CoordinationError::InvalidInput);
    let new_value = bump_creator_counter(&mut stats, counter, now)?;
    store_creator_stats(record, &stats)?;
    emit!(CreatorTrackRecordUpdated {
        wallet,
        creator_stats: record.key(),
        counter: counter.event_variant(),
        new_value,
        timestamp: now,
    });
    Ok(())
}
