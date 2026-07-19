//! Canonical, legacy-layout-safe loading for parent `Task` accounts.
//!
//! Parent tasks are read through unchecked/remaining accounts because live mainnet
//! still contains recognized append-only layouts shorter than `Task::SIZE`. Every
//! consumer must nevertheless enforce the same owner, discriminator, length, PDA,
//! and bump rules; keeping that logic here prevents settlement, assignment, and bond
//! paths from drifting apart.

use anchor_lang::prelude::*;

use crate::errors::CoordinationError;
use crate::state::Task;

pub(crate) fn load_canonical_parent_task(
    parent_info: &AccountInfo<'_>,
    program_id: &Pubkey,
) -> Result<Task> {
    require_keys_eq!(
        *parent_info.owner,
        *program_id,
        CoordinationError::InvalidAccountOwner
    );

    let data = parent_info.try_borrow_data()?;
    let recognized_legacy = matches!(data.len(), Task::OLD_TASK_SIZE | Task::BATCH2_TASK_SIZE);
    require!(
        recognized_legacy || data.len() >= Task::SIZE,
        CoordinationError::ParentTaskAccountRequired
    );

    let parent = if data.len() >= Task::SIZE {
        Task::try_deserialize(&mut &data[..])
            .map_err(|_| error!(CoordinationError::ParentTaskAccountRequired))?
    } else {
        let mut padded = vec![0u8; Task::SIZE];
        padded[..data.len()].copy_from_slice(&data);
        Task::try_deserialize(&mut &padded[..])
            .map_err(|_| error!(CoordinationError::ParentTaskAccountRequired))?
    };

    let (canonical_parent, canonical_bump) = Pubkey::find_program_address(
        &[b"task", parent.creator.as_ref(), parent.task_id.as_ref()],
        program_id,
    );
    require_keys_eq!(
        parent_info.key(),
        canonical_parent,
        CoordinationError::ParentTaskAccountRequired
    );
    require!(
        parent.bump == canonical_bump,
        CoordinationError::ParentTaskAccountRequired
    );

    Ok(parent)
}
