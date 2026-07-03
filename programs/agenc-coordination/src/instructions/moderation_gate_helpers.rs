//! P1.2 consumption-gate helpers shared by `set_task_job_spec`, `hire_from_listing`
//! and `hire_from_listing_humanless` (§4.4 + §5.2).
//!
//! The v2 moderator-keyed record seeds put the moderator INSIDE the primary record's
//! seed — circular for Anchor's declarative constraints — so the record account
//! arrives as an `UncheckedAccount` and this module re-implements each dropped Anchor
//! constraint as an explicit check: canonical PDA (v2-else-legacy), `owner ==
//! crate::ID`, discriminator (via `try_deserialize`), and the record↔gate binding
//! (task/creator/hash on the task side, listing/hash on the hire side, and always
//! `record.moderator == presented moderator`). A wrong-seed or forged account fails
//! CLOSED — nothing loads, the gate rejects.
//!
//! The BLOCK floor (§5.2) is deliberately NOT caller-chosen: the gate derives the
//! `["moderation_block", content_hash]` address in-handler from the hash it is
//! already gating, so omission or address-substitution cannot skip it.

use anchor_lang::prelude::*;

use crate::errors::CoordinationError;
use crate::state::{ListingModeration, ModerationBlock, TaskModeration, HASH_SIZE};

/// Which seed generation a presented moderation-record account matched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModerationRecordSlot {
    /// `["…_moderation_v2", parent, hash, moderator]` — the post-P1.2 write path.
    V2,
    /// `["…_moderation", parent, hash]` — pre-P1.2 records, FROZEN at upgrade
    /// (post-upgrade `record_*` writes only v2 seeds). Accepted during the grace
    /// window; unforgeable because every legacy write required authorization.
    Legacy,
}

/// Classify a presented record address against the two canonical derivations.
/// Pure — the revert-sensitive unit surface for the PDA re-check.
pub fn classify_moderation_record_address(
    presented: &Pubkey,
    v2: &Pubkey,
    legacy: &Pubkey,
) -> Result<ModerationRecordSlot> {
    if presented == v2 {
        Ok(ModerationRecordSlot::V2)
    } else if presented == legacy {
        Ok(ModerationRecordSlot::Legacy)
    } else {
        Err(error!(CoordinationError::InvalidModerationRecord))
    }
}

/// Owner + discriminator + deserialize for a manually-loaded moderation record.
/// Replaces Anchor's `Account<T>` checks on the now-Unchecked record slot.
fn deserialize_program_record<T: AccountDeserialize>(info: &AccountInfo) -> Result<T> {
    require!(
        info.owner == &crate::ID,
        CoordinationError::InvalidModerationRecord
    );
    let data = info.try_borrow_data()?;
    // `try_deserialize` enforces the 8-byte account discriminator, so a
    // program-owned account of a DIFFERENT type cannot masquerade as a record.
    T::try_deserialize(&mut data.as_ref()).map_err(|_| error!(CoordinationError::InvalidModerationRecord))
}

/// Load the task-side moderation record from the v2-else-legacy slot and re-check
/// every binding the declarative constraints used to enforce.
///
/// Returns the deserialized record; the caller still runs the byte-identical
/// downstream attestation checks (`validate_task_moderation_for_job_spec`).
pub fn load_task_moderation_record(
    record_info: &AccountInfo,
    task_key: &Pubkey,
    task_creator: &Pubkey,
    job_spec_hash: &[u8; HASH_SIZE],
    moderator: &Pubkey,
) -> Result<TaskModeration> {
    let (v2, _) = Pubkey::find_program_address(
        &[
            b"task_moderation_v2",
            task_key.as_ref(),
            job_spec_hash.as_ref(),
            moderator.as_ref(),
        ],
        &crate::ID,
    );
    let (legacy, _) = Pubkey::find_program_address(
        &[b"task_moderation", task_key.as_ref(), job_spec_hash.as_ref()],
        &crate::ID,
    );
    classify_moderation_record_address(record_info.key, &v2, &legacy)?;

    let record: TaskModeration = deserialize_program_record(record_info)?;
    // The record must have been authored by the presented moderator — on the v2 slot
    // this re-confirms the seed, on the legacy slot it binds the caller's `moderator`
    // argument to the stored author (so the attestor sub-binding checks the right key).
    require!(
        record.moderator == *moderator,
        CoordinationError::UnauthorizedTaskModerator
    );
    require!(
        record.task == *task_key,
        CoordinationError::TaskModerationTaskMismatch
    );
    require!(
        record.creator == *task_creator,
        CoordinationError::TaskModerationTaskMismatch
    );
    require!(
        record.job_spec_hash == *job_spec_hash,
        CoordinationError::TaskModerationHashMismatch
    );
    Ok(record)
}

/// Listing mirror of [`load_task_moderation_record`] for both hire gates.
pub fn load_listing_moderation_record(
    record_info: &AccountInfo,
    listing_key: &Pubkey,
    listing_spec_hash: &[u8; HASH_SIZE],
    moderator: &Pubkey,
) -> Result<ListingModeration> {
    let (v2, _) = Pubkey::find_program_address(
        &[
            b"listing_moderation_v2",
            listing_key.as_ref(),
            listing_spec_hash.as_ref(),
            moderator.as_ref(),
        ],
        &crate::ID,
    );
    let (legacy, _) = Pubkey::find_program_address(
        &[
            b"listing_moderation",
            listing_key.as_ref(),
            listing_spec_hash.as_ref(),
        ],
        &crate::ID,
    );
    classify_moderation_record_address(record_info.key, &v2, &legacy)?;

    let record: ListingModeration = deserialize_program_record(record_info)?;
    require!(
        record.moderator == *moderator,
        CoordinationError::UnauthorizedTaskModerator
    );
    require!(
        record.listing == *listing_key,
        CoordinationError::TaskModerationTaskMismatch
    );
    require!(
        record.job_spec_hash == *listing_spec_hash,
        CoordinationError::TaskModerationHashMismatch
    );
    Ok(record)
}

/// The BLOCK floor (§5.2): hard-reject a multisig-blocked content hash, regardless
/// of which CLEAN attestor the caller presents.
///
/// The expected address is DERIVED HERE from the same hash the gate is checking, so
/// the caller cannot substitute a different account. Absent block = pass:
/// - system-owned + zero data = no block ever set (lamport-prefunding the address
///   cannot forge a block — it carries no program data);
/// - program-owned = a real `ModerationBlock`; only `status == BLOCKED` rejects
///   (a CLEARED block passes — the account is the audit trail).
///
/// This makes the floor a fail-OPEN blacklist: multisig key-death preserves
/// publishing; nothing can be gated *in* through this account.
pub fn require_content_not_blocked(
    block_info: &AccountInfo,
    content_hash: &[u8; HASH_SIZE],
) -> Result<()> {
    let (expected, _) =
        Pubkey::find_program_address(&[b"moderation_block", content_hash.as_ref()], &crate::ID);
    require!(
        block_info.key == &expected,
        CoordinationError::InvalidModerationBlockAccount
    );

    if block_info.owner == &crate::ID {
        let data = block_info.try_borrow_data()?;
        let block = ModerationBlock::try_deserialize(&mut data.as_ref())
            .map_err(|_| error!(CoordinationError::InvalidModerationBlockAccount))?;
        require!(!block.is_blocked(), CoordinationError::ContentBlocked);
    } else {
        require!(
            block_info.owner == &anchor_lang::system_program::ID && block_info.data_is_empty(),
            CoordinationError::InvalidModerationBlockAccount
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_v2_and_legacy_addresses() {
        let v2 = Pubkey::new_unique();
        let legacy = Pubkey::new_unique();

        assert_eq!(
            classify_moderation_record_address(&v2, &v2, &legacy).unwrap(),
            ModerationRecordSlot::V2
        );
        assert_eq!(
            classify_moderation_record_address(&legacy, &v2, &legacy).unwrap(),
            ModerationRecordSlot::Legacy
        );
    }

    // Revert-sensitive (PDA re-check): a record at NEITHER canonical derivation is
    // rejected — this is the manual replacement for Anchor's dropped `seeds =` check.
    #[test]
    fn rejects_a_record_at_a_foreign_address() {
        let v2 = Pubkey::new_unique();
        let legacy = Pubkey::new_unique();
        let foreign = Pubkey::new_unique();

        let err = classify_moderation_record_address(&foreign, &v2, &legacy).unwrap_err();
        assert_eq!(err, CoordinationError::InvalidModerationRecord.into());
    }

    // v2 wins when the two derivations collide on the same presented key (cannot
    // happen for distinct seed prefixes, but the order is load-bearing for reads).
    #[test]
    fn prefers_v2_when_presented_matches_both() {
        let same = Pubkey::new_unique();
        assert_eq!(
            classify_moderation_record_address(&same, &same, &same).unwrap(),
            ModerationRecordSlot::V2
        );
    }
}
