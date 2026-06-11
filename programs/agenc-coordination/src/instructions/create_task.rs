//! Create a new task with reward escrow

use crate::errors::CoordinationError;
use crate::events::TaskCreated;
use crate::state::{AgentRegistration, AuthorityRateLimit, ProtocolConfig, Task, TaskEscrow};
use crate::utils::version::check_version_compatible;
use anchor_lang::prelude::*;
use anchor_lang::system_program;
#[cfg(feature = "spl-token-rewards")]
use anchor_spl::associated_token::AssociatedToken;
#[cfg(feature = "spl-token-rewards")]
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use super::completion_helpers::resolve_referrer_snapshot;
use super::launch_controls::require_task_type_index_enabled;
use super::rate_limit_helpers::check_authority_task_creation_rate_limits;
use super::task_init_helpers::{
    increment_total_tasks, init_escrow_fields, init_task_fields, validate_bid_task_mode,
    validate_deadline, validate_task_params,
};
#[cfg(feature = "spl-token-rewards")]
use super::token_helpers::ensure_token_escrow_ata;

#[derive(Accounts)]
#[instruction(task_id: [u8; 32])]
pub struct CreateTask<'info> {
    #[account(
        init,
        payer = creator,
        space = Task::SIZE,
        seeds = [b"task", creator.key().as_ref(), task_id.as_ref()],
        bump
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        init,
        payer = creator,
        space = TaskEscrow::SIZE,
        seeds = [b"escrow", task.key().as_ref()],
        bump
    )]
    pub escrow: Box<Account<'info, TaskEscrow>>,

    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// Creator's agent registration for identity/authorization checks
    #[account(
        seeds = [b"agent", creator_agent.agent_id.as_ref()],
        bump = creator_agent.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub creator_agent: Box<Account<'info, AgentRegistration>>,

    /// Wallet-scoped task/dispute rate limit state shared across all agents
    #[account(
        init_if_needed,
        payer = creator,
        space = AuthorityRateLimit::SIZE,
        seeds = [b"authority_rate_limit", authority.key().as_ref()],
        bump
    )]
    pub authority_rate_limit: Box<Account<'info, AuthorityRateLimit>>,

    /// The authority that owns the creator_agent
    pub authority: Signer<'info>,

    /// The creator who pays for and owns the task
    /// Must match authority to prevent social engineering attacks (#375)
    #[account(
        mut,
        constraint = creator.key() == authority.key() @ CoordinationError::CreatorAuthorityMismatch
    )]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,

    // === Optional SPL Token accounts (only required for token-denominated tasks) ===
    #[cfg(feature = "spl-token-rewards")]
    /// SPL token mint for reward denomination (optional)
    pub reward_mint: Option<Account<'info, Mint>>,

    #[cfg(feature = "spl-token-rewards")]
    /// Creator's token account holding reward tokens (optional)
    #[account(mut)]
    pub creator_token_account: Option<Account<'info, TokenAccount>>,

    #[cfg(feature = "spl-token-rewards")]
    /// Escrow's associated token account for holding reward tokens (optional).
    /// Created via ATA CPI during handler if token task.
    /// CHECK: Validated in handler via ATA derivation check
    #[account(mut)]
    pub token_escrow_ata: Option<UncheckedAccount<'info>>,

    #[cfg(feature = "spl-token-rewards")]
    /// SPL Token program (optional, required for token tasks)
    pub token_program: Option<Program<'info, Token>>,

    #[cfg(feature = "spl-token-rewards")]
    /// Associated Token Account program (optional, required for token tasks)
    pub associated_token_program: Option<Program<'info, AssociatedToken>>,
}

/// Creates a new task.
///
/// # Parameters
/// - `task_type`: Task execution type
///   (`0=Exclusive`, `1=Collaborative`, `2=Competitive`, `3=BidExclusive`).
#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<CreateTask>,
    task_id: [u8; 32],
    required_capabilities: u64,
    description: [u8; 64],
    reward_amount: u64,
    max_workers: u8,
    deadline: i64,
    task_type: u8,
    constraint_hash: Option<[u8; 32]>,
    min_reputation: u16,
    reward_mint: Option<Pubkey>,
    referrer: Option<Pubkey>,
    referrer_fee_bps: u16,
) -> Result<()> {
    validate_task_params(
        &task_id,
        &description,
        required_capabilities,
        max_workers,
        task_type,
        min_reputation,
    )?;
    validate_bid_task_mode(task_type, max_workers, reward_mint)?;
    #[cfg(feature = "mainnet-canary")]
    {
        require!(
            task_type == crate::state::TaskType::Exclusive as u8,
            CoordinationError::InvalidTaskType
        );
        require!(max_workers == 1, CoordinationError::InvalidMaxWorkers);
        require!(reward_mint.is_none(), CoordinationError::InvalidTokenMint);
        require!(constraint_hash.is_none(), CoordinationError::InvalidInput);
        // P6.2 referral fee leg is UNAUDITED money-routing — fail it CLOSED on the
        // conservative live mainnet (canary) surface until Phase 9 / audit. Mirrors the
        // reward_mint / constraint_hash rejections above. This guarantees every canary
        // task has `referrer == default` and `referrer_fee_bps == 0`, so the shared
        // settlement (completion_helpers) always SKIPS the referrer leg on this surface.
        super::task_init_helpers::require_canary_referrer_disabled(referrer, referrer_fee_bps)?;
    }
    // Validate reward is not zero (#540) - not in shared validator since dependent tasks allow zero
    require!(reward_amount > 0, CoordinationError::InvalidReward);

    let clock = Clock::get()?;
    let config = ctx.accounts.protocol_config.as_ref();

    check_version_compatible(config)?;
    require_task_type_index_enabled(config, task_type)?;

    // Validate deadline - must be set and in the future (#575)
    validate_deadline(deadline, &clock, true)?;

    let creator_agent = ctx.accounts.creator_agent.as_ref();
    let authority_rate_limit = ctx.accounts.authority_rate_limit.as_mut();

    // Check wallet-scoped rate limits to prevent multi-agent bypasses under one authority.
    check_authority_task_creation_rate_limits(
        authority_rate_limit,
        ctx.accounts.authority.key(),
        ctx.bumps.authority_rate_limit,
        creator_agent.agent_id,
        config,
        &clock,
    )?;

    // Initialize task-owned state before any external CPI so later logic does not
    // depend on a stale view of freshly funded PDAs.
    let escrow_key = ctx.accounts.escrow.key();
    let protocol_fee_bps = config.protocol_fee_bps;
    let creator_key = ctx.accounts.creator.key();
    let task = ctx.accounts.task.as_mut();
    init_task_fields(
        task,
        task_id,
        creator_key,
        required_capabilities,
        description,
        constraint_hash,
        reward_amount,
        max_workers,
        task_type,
        deadline,
        escrow_key,
        ctx.bumps.task,
        protocol_fee_bps,
        clock.unix_timestamp,
        min_reputation,
        reward_mint,
    )?;

    // P6.2 demand-side referral leg: a creator may credit the embedder who brought
    // them (referrer + bps). No operator leg exists on a direct create_task, so the
    // combined cap is checked against protocol + referrer only. Validated + stamped
    // onto the Task for the settlement split (no HireRecord on a direct create_task).
    // SOL-ONLY (mirrors the operator leg): the settlement split pays the referrer in
    // lamports, so a referrer fee on a token-denominated task is rejected at creation
    // rather than bricking the task at settlement.
    let (referrer_key, referrer_bps) = resolve_referrer_snapshot(
        referrer,
        referrer_fee_bps,
        protocol_fee_bps,
        0, // no operator leg on a direct create_task
        creator_key,
    )?;
    require!(
        referrer_bps == 0 || reward_mint.is_none(),
        CoordinationError::InvalidTokenMint
    );
    task.referrer = referrer_key;
    task.referrer_fee_bps = referrer_bps;

    let escrow = ctx.accounts.escrow.as_mut();
    init_escrow_fields(escrow, task.key(), reward_amount, ctx.bumps.escrow);

    #[cfg(feature = "spl-token-rewards")]
    if let Some(expected_mint) = reward_mint {
        // Token path: validate required token accounts are provided
        require!(
            ctx.accounts.reward_mint.is_some()
                && ctx.accounts.creator_token_account.is_some()
                && ctx.accounts.token_escrow_ata.is_some()
                && ctx.accounts.token_program.is_some()
                && ctx.accounts.associated_token_program.is_some(),
            CoordinationError::MissingTokenAccounts
        );

        let mint = ctx
            .accounts
            .reward_mint
            .as_ref()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        let creator_ta = ctx
            .accounts
            .creator_token_account
            .as_ref()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        let token_escrow_ata = ctx
            .accounts
            .token_escrow_ata
            .as_ref()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        let token_program = ctx
            .accounts
            .token_program
            .as_ref()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        let ata_program = ctx
            .accounts
            .associated_token_program
            .as_ref()
            .ok_or(CoordinationError::MissingTokenAccounts)?;

        // Validate mint matches the provided reward_mint
        require!(
            mint.key() == expected_mint,
            CoordinationError::InvalidTokenMint
        );

        let token_escrow_info = token_escrow_ata.to_account_info();
        if token_escrow_info.owner == &system_program::ID {
            ensure_token_escrow_ata(
                &token_escrow_info,
                &ctx.accounts.creator.to_account_info(),
                &ctx.accounts.escrow.to_account_info(),
                &mint.to_account_info(),
                &ctx.accounts.system_program,
                token_program,
                ata_program,
            )?;
            let created_escrow_ata = ctx
                .accounts
                .token_escrow_ata
                .as_ref()
                .ok_or(CoordinationError::MissingTokenAccounts)?
                .to_account_info();
            require!(
                created_escrow_ata.owner == token_program.key,
                CoordinationError::InvalidTokenEscrow
            );
        } else {
            require!(
                token_escrow_info.owner == token_program.key,
                CoordinationError::InvalidTokenEscrow
            );
            let escrow_ata_mint = token::accessor::mint(&token_escrow_info)
                .map_err(|_| CoordinationError::InvalidTokenEscrow)?;
            require!(
                escrow_ata_mint == mint.key(),
                CoordinationError::InvalidTokenMint
            );
            let escrow_ata_authority = token::accessor::authority(&token_escrow_info)
                .map_err(|_| CoordinationError::InvalidTokenEscrow)?;
            require!(
                escrow_ata_authority == ctx.accounts.escrow.key(),
                CoordinationError::InvalidTokenEscrow
            );
        }

        // Transfer tokens from creator ATA to escrow ATA
        token::transfer(
            CpiContext::new(
                token_program.to_account_info(),
                Transfer {
                    from: creator_ta.to_account_info(),
                    to: ctx
                        .accounts
                        .token_escrow_ata
                        .as_ref()
                        .ok_or(CoordinationError::MissingTokenAccounts)?
                        .to_account_info(),
                    authority: ctx.accounts.creator.to_account_info(),
                },
            ),
            reward_amount,
        )?;
    } else {
        // SOL path: existing lamport transfer (unchanged)
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.creator.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                },
            ),
            reward_amount,
        )?;
    }
    #[cfg(not(feature = "spl-token-rewards"))]
    {
        require!(reward_mint.is_none(), CoordinationError::InvalidTokenMint);
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.creator.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                },
            ),
            reward_amount,
        )?;
    }

    // Update protocol stats
    let protocol_config = ctx.accounts.protocol_config.as_mut();
    increment_total_tasks(protocol_config)?;

    emit!(TaskCreated {
        task_id,
        creator: task.creator,
        required_capabilities,
        reward_amount,
        task_type,
        deadline,
        min_reputation,
        reward_mint,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[cfg(all(test, feature = "mainnet-canary"))]
mod create_task_canary_gate_tests {
    //! Integration-style coverage of the create_task description gate under the
    //! mainnet-canary cfg. These replicate the exact validation sequence the
    //! handler runs before any account mutation (validate_task_params -> bid mode
    //! -> canary preconditions incl. validate_description_is_content_hash), so a
    //! prose description is rejected and a hash-shaped one is accepted on the same
    //! path create_task takes on mainnet.
    use super::super::task_init_helpers::{
        require_canary_referrer_disabled, validate_bid_task_mode,
        validate_description_is_content_hash, validate_task_params,
    };
    use crate::errors::CoordinationError;
    use crate::state::TaskType;

    use anchor_lang::prelude::Pubkey;

    fn run_canary_create_preconditions(description: &[u8; 64]) -> anchor_lang::Result<()> {
        run_canary_create_preconditions_full(description, None, 0)
    }

    /// Replicates the FULL mainnet-canary precondition block from `create_task::handler`,
    /// including the P6.2 referrer fail-closed gate, so the unit test exercises the exact
    /// `require!(referrer.is_none() && referrer_fee_bps == 0, ...)` the handler runs
    /// before any account mutation.
    fn run_canary_create_preconditions_full(
        description: &[u8; 64],
        referrer: Option<Pubkey>,
        referrer_fee_bps: u16,
    ) -> anchor_lang::Result<()> {
        let task_id = [1u8; 32];
        let required_capabilities = 1u64;
        let max_workers = 1u8;
        let task_type = TaskType::Exclusive as u8;
        let min_reputation = 0u16;
        let reward_mint: Option<Pubkey> = None;
        let constraint_hash: Option<[u8; 32]> = None;
        validate_task_params(
            &task_id,
            description,
            required_capabilities,
            max_workers,
            task_type,
            min_reputation,
        )?;
        validate_bid_task_mode(task_type, max_workers, reward_mint)?;
        // mainnet-canary preconditions (mirrors create_task::handler EXACTLY, in order)
        anchor_lang::require!(
            task_type == TaskType::Exclusive as u8,
            CoordinationError::InvalidTaskType
        );
        anchor_lang::require!(max_workers == 1, CoordinationError::InvalidMaxWorkers);
        anchor_lang::require!(reward_mint.is_none(), CoordinationError::InvalidTokenMint);
        anchor_lang::require!(constraint_hash.is_none(), CoordinationError::InvalidInput);
        // P6.2 referral leg fail-closed on the canary surface — calls the SAME source
        // guard the handler runs, so reverting that guard turns these tests red.
        require_canary_referrer_disabled(referrer, referrer_fee_bps)?;
        validate_description_is_content_hash(description)?;
        Ok(())
    }

    fn hash_description() -> [u8; 64] {
        let mut d = [0u8; 64];
        d[..32].copy_from_slice(&[9u8; 32]); // 32-byte digest, zero tail
        d
    }

    #[test]
    fn create_accepts_default_referrer_on_canary() {
        // Sanity: a hash-shaped task with NO referrer leg passes the canary gate. This is
        // the only referral shape the live mainnet surface allows.
        assert!(run_canary_create_preconditions_full(&hash_description(), None, 0).is_ok());
    }

    #[test]
    fn create_rejects_nondefault_referrer_on_canary() {
        // The P6.2 referrer fee leg is UNAUDITED money-routing and must fail CLOSED on
        // the live mainnet (canary) surface. A non-default referrer (with or without a
        // fee) is rejected with InvalidInput before any state change.
        //
        // REVERT-SENSITIVE: against the pre-fix code (no canary referrer gate), this
        // would FALL THROUGH to validate_description_is_content_hash and return Ok — the
        // referrer leg would silently ride onto the live surface.
        let referrer = Some(Pubkey::new_unique());
        let err = run_canary_create_preconditions_full(&hash_description(), referrer, 250)
            .unwrap_err();
        assert_eq!(err, CoordinationError::InvalidInput.into());

        // Even a referrer with a ZERO fee is rejected — the arg-layout itself must not
        // reach the canary surface.
        let err_zero_fee = run_canary_create_preconditions_full(&hash_description(), referrer, 0)
            .unwrap_err();
        assert_eq!(err_zero_fee, CoordinationError::InvalidInput.into());

        // A bare non-zero fee with no referrer pubkey is also rejected.
        let err_fee_only =
            run_canary_create_preconditions_full(&hash_description(), None, 100).unwrap_err();
        assert_eq!(err_fee_only, CoordinationError::InvalidInput.into());
    }

    #[test]
    fn create_accepts_hash_shaped_description() {
        let mut d = [0u8; 64];
        d[..32].copy_from_slice(&[9u8; 32]); // 32-byte digest, zero tail
        assert!(run_canary_create_preconditions(&d).is_ok());
    }

    #[test]
    fn create_rejects_raw_prose_description() {
        let mut d = [0u8; 64];
        let text = b"build me a website and pay 2 sol, contact me at evil-prose-here";
        d[..text.len()].copy_from_slice(text);
        let err = run_canary_create_preconditions(&d).unwrap_err();
        assert_eq!(err, CoordinationError::InvalidDescription.into());
    }

    #[test]
    fn create_rejects_hash_with_readable_tail() {
        let mut d = [0u8; 64];
        d[..32].copy_from_slice(&[9u8; 32]);
        d[50] = b'X'; // smuggled readable byte in the tail
        let err = run_canary_create_preconditions(&d).unwrap_err();
        assert_eq!(err, CoordinationError::InvalidDescription.into());
    }
}
