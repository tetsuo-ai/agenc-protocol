//! Canonical, legacy-layout-safe loading for parent `Task` accounts.
//!
//! Parent tasks are read through unchecked/remaining accounts because live mainnet
//! still contains recognized append-only layouts shorter than `Task::SIZE`. Every
//! consumer must nevertheless enforce the same owner, discriminator, length, PDA,
//! and bump rules; keeping that logic here prevents settlement, assignment, and bond
//! paths from drifting apart.
//!
//! Revision 9 (C): a parent closed by `close_task` is a 56-byte `TaskMarker` at the
//! same address. It stands for the terminal Task it replaced: a Completed marker is
//! a completed parent, and a Cancelled marker is a parent that is not completed,
//! exactly as the full Cancelled Task was.

use anchor_lang::prelude::*;

use crate::errors::CoordinationError;
use crate::state::{Task, TaskMarker, TaskStatus};

/// What a dependency check reads from a parent task: its status and creator.
/// Both a full `Task` and a revision 9 `TaskMarker` provide them.
#[derive(Clone, Copy)]
pub(crate) struct ParentTaskState {
    pub status: TaskStatus,
    /// Read by `create_dependent_task`, which the canary build does not have.
    #[cfg_attr(feature = "mainnet-canary", allow(dead_code))]
    pub creator: Pubkey,
}

pub(crate) fn load_canonical_parent_task(
    parent_info: &AccountInfo<'_>,
    program_id: &Pubkey,
) -> Result<ParentTaskState> {
    require_keys_eq!(
        *parent_info.owner,
        *program_id,
        CoordinationError::InvalidAccountOwner
    );

    let data = parent_info.try_borrow_data()?;
    // A compacted parent. `close_task` writes a marker only over a Task it
    // verified at its canonical PDA, so owner and discriminator prove that this
    // address held the task; callers have already matched the address to the
    // child's stored `depends_on`. A marker holds only Completed or Cancelled.
    if data.len() == TaskMarker::SIZE && data[..8] == *TaskMarker::DISCRIMINATOR {
        let marker = TaskMarker::try_deserialize(&mut &data[..])
            .map_err(|_| error!(CoordinationError::ParentTaskAccountRequired))?;
        require!(
            marker.validate_reserved_fields(),
            CoordinationError::ParentTaskAccountRequired
        );
        let status = if marker.status == TaskStatus::Completed as u8 {
            TaskStatus::Completed
        } else {
            TaskStatus::Cancelled
        };
        return Ok(ParentTaskState {
            status,
            creator: marker.creator,
        });
    }
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

    Ok(ParentTaskState {
        status: parent.status,
        creator: parent.creator,
    })
}

/// What a task PDA can hold under revision 9: the `Task` itself, or the
/// `TaskMarker` that `close_task` compacted it into.
#[cfg(not(feature = "mainnet-canary"))]
pub(crate) enum TaskOrMarker {
    Task(Box<Task>),
    Marker(TaskMarker),
}

/// Load the account at a task PDA as a `Task` or a `TaskMarker`.
///
/// A `Task` must sit at its canonical PDA, checked with its stored bump exactly
/// as the former `seeds`/`bump = task.bump` constraint did. A marker is proven
/// by owner and discriminator alone: only `close_task` writes one, and only over
/// a Task it verified this way. Any other owner, discriminator or marker shape
/// fails with `InvalidTaskMarker`.
#[cfg(not(feature = "mainnet-canary"))]
pub(crate) fn load_task_or_marker(info: &AccountInfo<'_>) -> Result<TaskOrMarker> {
    require_keys_eq!(*info.owner, crate::ID, CoordinationError::InvalidTaskMarker);
    let data = info.try_borrow_data()?;
    require!(data.len() >= 8, CoordinationError::InvalidTaskMarker);
    if data[..8] == *Task::DISCRIMINATOR {
        let task = Box::new(Task::try_deserialize(&mut &data[..])?);
        let expected = Pubkey::create_program_address(
            &[
                b"task",
                task.creator.as_ref(),
                task.task_id.as_ref(),
                &[task.bump],
            ],
            &crate::ID,
        )
        .map_err(|_| error!(anchor_lang::error::ErrorCode::ConstraintSeeds))?;
        require_keys_eq!(
            expected,
            info.key(),
            anchor_lang::error::ErrorCode::ConstraintSeeds
        );
        return Ok(TaskOrMarker::Task(task));
    }
    if data[..8] == *TaskMarker::DISCRIMINATOR {
        require!(
            data.len() == TaskMarker::SIZE,
            CoordinationError::InvalidTaskMarker
        );
        let marker = TaskMarker::try_deserialize(&mut &data[..])?;
        require!(
            marker.validate_reserved_fields(),
            CoordinationError::InvalidTaskMarker
        );
        return Ok(TaskOrMarker::Marker(marker));
    }
    err!(CoordinationError::InvalidTaskMarker)
}
