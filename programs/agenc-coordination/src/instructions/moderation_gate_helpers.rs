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
use crate::instructions::constants::DEFAULT_MODERATION_LIVENESS_WINDOW_SECS;
use crate::state::{
    moderation_block_status, ListingModeration, ModerationBlock, ModerationConfig, TaskModeration,
    HASH_SIZE,
};

fn validate_moderation_block_record(
    block: &ModerationBlock,
    expected_content_hash: &[u8; HASH_SIZE],
) -> Result<()> {
    let (_, expected_bump) = Pubkey::find_program_address(
        &[b"moderation_block", expected_content_hash.as_ref()],
        &crate::ID,
    );
    require!(
        block.content_hash == *expected_content_hash,
        CoordinationError::InvalidModerationBlockAccount
    );
    require!(
        block.bump == expected_bump,
        CoordinationError::InvalidModerationBlockAccount
    );
    require!(
        matches!(
            block.status,
            moderation_block_status::CLEARED | moderation_block_status::BLOCKED
        ),
        CoordinationError::InvalidModerationBlockAccount
    );
    require!(
        block.validate_reserved_fields(),
        CoordinationError::InvalidModerationBlockAccount
    );
    Ok(())
}

/// P1.3 liveness deadman (batch-2 A2, `docs/MODERATION_LIVENESS.md`): `true` when
/// the moderation authority has been silent — no `configure_task_moderation` /
/// `moderation_heartbeat` bump of `updated_at` — for longer than the liveness
/// window, so the ALLOW gates relax to moderation-optional. Pure + revert-sensitive.
///
/// Trigger analysis: `updated_at` moves only under an authority signature, so no
/// third party can force or prevent relaxation; one heartbeat instantly re-arms.
/// `window_secs == 0` reads as the 90-day default (the live mainnet config's
/// zeroed reserved bytes). `updated_at == 0` (an account that was never written —
/// unreachable for a real config, whose `configure` always stamps it) stays STRICT:
/// the deadman only fires on evidence of a once-live, now-silent authority.
///
/// The BLOCK floor (`require_content_not_blocked`) is deliberately NOT consulted
/// here and is never relaxed.
pub fn moderation_liveness_relaxed(updated_at: i64, window_secs: u32, now: i64) -> bool {
    if updated_at <= 0 {
        return false;
    }
    let effective_window: i64 = if window_secs > 0 {
        window_secs as i64
    } else {
        DEFAULT_MODERATION_LIVENESS_WINDOW_SECS as i64
    };
    now > updated_at.saturating_add(effective_window)
}

/// Convenience wrapper reading the heartbeat + carved window off the config the
/// gates already load.
pub fn moderation_gate_relaxed(config: &ModerationConfig, now: i64) -> bool {
    moderation_liveness_relaxed(config.updated_at, config.liveness_window_secs(), now)
}

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
    T::try_deserialize(&mut data.as_ref())
        .map_err(|_| error!(CoordinationError::InvalidModerationRecord))
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
    let (v2, v2_bump) = Pubkey::find_program_address(
        &[
            b"task_moderation_v2",
            task_key.as_ref(),
            job_spec_hash.as_ref(),
            moderator.as_ref(),
        ],
        &crate::ID,
    );
    let (legacy, legacy_bump) = Pubkey::find_program_address(
        &[
            b"task_moderation",
            task_key.as_ref(),
            job_spec_hash.as_ref(),
        ],
        &crate::ID,
    );
    let slot = classify_moderation_record_address(record_info.key, &v2, &legacy)?;

    let record: TaskModeration = deserialize_program_record(record_info)?;
    let expected_bump = match slot {
        ModerationRecordSlot::V2 => v2_bump,
        ModerationRecordSlot::Legacy => legacy_bump,
    };
    require!(
        record.bump == expected_bump,
        CoordinationError::InvalidModerationRecord
    );
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
    let (v2, v2_bump) = Pubkey::find_program_address(
        &[
            b"listing_moderation_v2",
            listing_key.as_ref(),
            listing_spec_hash.as_ref(),
            moderator.as_ref(),
        ],
        &crate::ID,
    );
    let (legacy, legacy_bump) = Pubkey::find_program_address(
        &[
            b"listing_moderation",
            listing_key.as_ref(),
            listing_spec_hash.as_ref(),
        ],
        &crate::ID,
    );
    let slot = classify_moderation_record_address(record_info.key, &v2, &legacy)?;

    let record: ListingModeration = deserialize_program_record(record_info)?;
    let expected_bump = match slot {
        ModerationRecordSlot::V2 => v2_bump,
        ModerationRecordSlot::Legacy => legacy_bump,
    };
    require!(
        record.bump == expected_bump,
        CoordinationError::InvalidModerationRecord
    );
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
        validate_moderation_block_record(&block, content_hash)?;
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

    #[test]
    fn block_records_fail_closed_on_unknown_status_hash_or_reserved_bytes() {
        let hash = [7u8; HASH_SIZE];
        let (_, bump) =
            Pubkey::find_program_address(&[b"moderation_block", hash.as_ref()], &crate::ID);
        let mut block = ModerationBlock {
            content_hash: hash,
            status: moderation_block_status::CLEARED,
            bump,
            ..ModerationBlock::default()
        };
        assert!(validate_moderation_block_record(&block, &hash).is_ok());

        block.status = 2;
        assert!(validate_moderation_block_record(&block, &hash).is_err());
        block.status = moderation_block_status::CLEARED;
        assert!(validate_moderation_block_record(&block, &[8u8; HASH_SIZE]).is_err());
        block._reserved[0] = 1;
        assert!(validate_moderation_block_record(&block, &hash).is_err());
    }

    // === P1.3 liveness deadman (batch-2 A2) ===
    use crate::instructions::constants::MIN_MODERATION_LIVENESS_WINDOW_SECS;

    const DAY: i64 = 86_400;

    // Revert-sensitive: forcing the predicate to `false` (reverting the deadman)
    // turns the past-the-window assertions red; forcing it `true` turns the
    // inside-the-window assertions red.
    #[test]
    fn liveness_relaxes_only_past_the_default_window() {
        let heartbeat = 1_700_000_000i64;
        let window = DEFAULT_MODERATION_LIVENESS_WINDOW_SECS as i64;
        // Inside the window (incl. the exact boundary): STRICT.
        assert!(!moderation_liveness_relaxed(heartbeat, 0, heartbeat));
        assert!(!moderation_liveness_relaxed(
            heartbeat,
            0,
            heartbeat + window - 1
        ));
        assert!(!moderation_liveness_relaxed(
            heartbeat,
            0,
            heartbeat + window
        ));
        // One past the boundary: RELAXED.
        assert!(moderation_liveness_relaxed(
            heartbeat,
            0,
            heartbeat + window + 1
        ));
    }

    #[test]
    fn liveness_default_window_is_90_days() {
        assert_eq!(DEFAULT_MODERATION_LIVENESS_WINDOW_SECS as i64, 90 * DAY);
        assert!(MIN_MODERATION_LIVENESS_WINDOW_SECS as i64 == DAY);
    }

    #[test]
    fn liveness_respects_a_configured_window() {
        let heartbeat = 1_700_000_000i64;
        let window: u32 = 7 * DAY as u32;
        assert!(!moderation_liveness_relaxed(
            heartbeat,
            window,
            heartbeat + 7 * DAY
        ));
        assert!(moderation_liveness_relaxed(
            heartbeat,
            window,
            heartbeat + 7 * DAY + 1
        ));
        // A configured window overrides the default entirely (7d << 90d).
        assert!(moderation_liveness_relaxed(
            heartbeat,
            window,
            heartbeat + 8 * DAY
        ));
    }

    // A never-written heartbeat (0) or corrupt negative timestamp stays STRICT —
    // the deadman fires only on evidence of a once-live, now-silent authority.
    #[test]
    fn liveness_never_relaxes_without_a_recorded_heartbeat() {
        assert!(!moderation_liveness_relaxed(0, 0, i64::MAX));
        assert!(!moderation_liveness_relaxed(-1, 0, i64::MAX));
    }

    // Overflow edge: a heartbeat near i64::MAX must not wrap into "relaxed".
    #[test]
    fn liveness_saturates_instead_of_wrapping() {
        assert!(!moderation_liveness_relaxed(i64::MAX - 10, 0, i64::MAX));
    }

    #[test]
    fn gate_relaxed_reads_config_heartbeat_and_carved_window() {
        let mut config = ModerationConfig {
            updated_at: 1_000,
            ..ModerationConfig::default()
        };
        let window = DEFAULT_MODERATION_LIVENESS_WINDOW_SECS as i64;
        assert!(!moderation_gate_relaxed(&config, 1_000 + window));
        assert!(moderation_gate_relaxed(&config, 1_001 + window));
        // Carved custom window is honored through the accessor.
        config.set_liveness_window_secs(2 * DAY as u32);
        assert!(!moderation_gate_relaxed(&config, 1_000 + 2 * DAY));
        assert!(moderation_gate_relaxed(&config, 1_001 + 2 * DAY));
    }
}
