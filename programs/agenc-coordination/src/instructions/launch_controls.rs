//! Launch control helpers for fail-closed marketplace operations.

use anchor_lang::prelude::*;

use crate::errors::CoordinationError;
use crate::state::{ProtocolConfig, TaskType};

/// Only the currently defined task-type bits may be toggled.
pub const TASK_TYPE_DISABLE_MASK: u8 = ProtocolConfig::TASK_TYPE_DISABLE_MASK;

pub fn task_type_mask(task_type: TaskType) -> u8 {
    1u8 << (task_type as u8)
}

pub fn require_task_type_enabled(
    protocol_config: &ProtocolConfig,
    task_type: TaskType,
) -> Result<()> {
    let mask = task_type_mask(task_type);
    require!(
        protocol_config.disabled_task_type_mask & mask == 0,
        CoordinationError::TaskTypeDisabled
    );
    Ok(())
}

pub fn require_task_type_index_enabled(
    protocol_config: &ProtocolConfig,
    task_type: u8,
) -> Result<()> {
    require!(task_type <= 3, CoordinationError::InvalidTaskType);
    require!(
        protocol_config.disabled_task_type_mask & (1u8 << task_type) == 0,
        CoordinationError::TaskTypeDisabled
    );
    Ok(())
}

pub fn validate_disabled_task_type_mask(disabled_task_type_mask: u8) -> Result<()> {
    require!(
        disabled_task_type_mask & !TASK_TYPE_DISABLE_MASK == 0,
        CoordinationError::InvalidTaskType
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_type_disable_mask_rejects_disabled_type() {
        let mut config = ProtocolConfig::default();
        config.disabled_task_type_mask = task_type_mask(TaskType::Exclusive);

        assert!(require_task_type_enabled(&config, TaskType::Collaborative).is_ok());
        assert!(require_task_type_enabled(&config, TaskType::Exclusive).is_err());
        assert!(require_task_type_index_enabled(&config, TaskType::Exclusive as u8).is_err());
    }

    #[test]
    fn task_type_disable_mask_rejects_unknown_bits() {
        assert!(validate_disabled_task_type_mask(TASK_TYPE_DISABLE_MASK).is_ok());
        assert!(validate_disabled_task_type_mask(0b0001_0000).is_err());
    }
}
