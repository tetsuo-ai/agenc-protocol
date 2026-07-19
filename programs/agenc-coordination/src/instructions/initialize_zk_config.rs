//! Initialize trusted ZK image ID configuration (release-disabled).
//!
//! Authorization is still checked with the M-of-N multisig, but this release always
//! returns `PrivateTaskCreationDisabled` before writing the trust root. The verifier
//! IDs compiled into the private completion path are not deployed on mainnet and the
//! repository does not contain an auditable guest, so accepting an image ID would
//! falsely imply that private settlement is ready.

use crate::errors::CoordinationError;
use crate::instructions::zk_config_helpers::reject_zk_activation;
use crate::state::{ProtocolConfig, ZkConfig, HASH_SIZE};
use crate::utils::multisig::{require_multisig_threshold, unique_account_infos};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct InitializeZkConfig<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump,
        has_one = authority @ CoordinationError::UnauthorizedProtocolAuthority,
        constraint = protocol_config.key() != zk_config.key() @ CoordinationError::InvalidInput
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        init,
        payer = authority,
        space = ZkConfig::SIZE,
        seeds = [b"zk_config"],
        bump
    )]
    pub zk_config: Account<'info, ZkConfig>,

    #[account(
        mut,
        constraint = authority.key() != protocol_config.key() @ CoordinationError::InvalidInput,
        constraint = authority.key() != zk_config.key() @ CoordinationError::InvalidInput
    )]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeZkConfig>, _active_image_id: [u8; HASH_SIZE]) -> Result<()> {
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::UnauthorizedProtocolAuthority
    );
    require!(
        ctx.accounts.zk_config.active_image_id == [0u8; HASH_SIZE]
            && ctx.accounts.zk_config.bump == 0,
        CoordinationError::InvalidInput
    );
    require!(
        ctx.accounts.authority.key() == ctx.accounts.protocol_config.authority,
        CoordinationError::UnauthorizedProtocolAuthority
    );
    // Audit H-5: multisig-gate the ONE-SHOT init exactly like the rotation
    // (update_zk_image_id). The active ZK image ID is the root of trust for
    // complete_task_private escrow settlement; a single compromised authority key setting a
    // malicious initial image would enable escrow theft across every ZK-private task until
    // the multisig rotated it. Require the same M-of-N threshold (co-signers in
    // remaining_accounts) that gates the rotation and the treasury / protocol-fee controls.
    let unique_signers = unique_account_infos(ctx.remaining_accounts);
    require_multisig_threshold(&ctx.accounts.protocol_config, &unique_signers)?;
    require_keys_neq!(
        ctx.accounts.protocol_config.key(),
        ctx.accounts.zk_config.key(),
        CoordinationError::InvalidInput
    );

    // Do not write ZkConfig in this release. The `init` account creation is
    // transactionally rolled back with this error, so no misleading trust-root
    // account survives and private task creation remains disabled.
    reject_zk_activation()
}
