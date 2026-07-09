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

/// Batch 4 (docs/design/batch-4-goods.md): the GOODS market ships dark and is
/// turned on by stamping `surface_revision = SURFACE_REVISION_BATCH4` via
/// `update_launch_controls` — the FIRST enforcing use of the revision stamp
/// (previously advisory/SDK-only). Rolling the stamp back to
/// `SURFACE_REVISION_BATCH3` is the coarse kill switch: it disables every
/// goods instruction without touching any other surface. Fail-closed on an
/// unstamped/older config.
pub fn require_goods_enabled(protocol_config: &ProtocolConfig) -> Result<()> {
    require!(
        protocol_config.surface_revision >= ProtocolConfig::SURFACE_REVISION_BATCH4,
        CoordinationError::GoodsSurfaceNotEnabled
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

    #[test]
    fn goods_gate_requires_batch4_stamp() {
        // Batch 4: goods handlers are fail-closed below revision 4 — the live
        // mainnet config (stamped 3) rejects goods until the ceremony stamps 4,
        // and rolling back to 3 is the coarse kill switch.
        let mut config = ProtocolConfig::default();
        for below in [
            0u16,
            ProtocolConfig::SURFACE_REVISION_FULL,
            ProtocolConfig::SURFACE_REVISION_BATCH2,
            ProtocolConfig::SURFACE_REVISION_BATCH3,
        ] {
            config.surface_revision = below;
            assert!(
                require_goods_enabled(&config).is_err(),
                "revision {below} must reject goods"
            );
        }
        config.surface_revision = ProtocolConfig::SURFACE_REVISION_BATCH4;
        assert!(require_goods_enabled(&config).is_ok());
        // Monotonic: any future revision keeps goods enabled.
        config.surface_revision = ProtocolConfig::SURFACE_REVISION_BATCH4 + 1;
        assert!(require_goods_enabled(&config).is_ok());
    }
}
