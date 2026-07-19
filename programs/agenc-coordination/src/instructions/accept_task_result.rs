//! Accept a Task Validation V2 submission and settle the task reward.

use crate::errors::CoordinationError;
use crate::events::TaskResultAccepted;
#[cfg(not(feature = "mainnet-canary"))]
use crate::instructions::bid_settlement_helpers::{
    finalize_bid_task_completion, load_bid_task_completion_meta,
};
#[cfg(not(feature = "mainnet-canary"))]
use crate::instructions::bond_helpers::{settle_completion_bond, BondDisposition};
#[cfg(not(feature = "mainnet-canary"))]
use crate::instructions::completion_helpers::build_marketplace_fee_legs;
#[cfg(feature = "spl-token-rewards")]
use crate::instructions::completion_helpers::TokenPaymentAccounts;
use crate::instructions::completion_helpers::{
    calculate_fee_with_reputation, execute_completion_rewards, validate_task_dependency,
};
use crate::instructions::task_validation_helpers::{
    decrement_pending_submission_count, ensure_validation_config, ensure_validation_mode,
    is_manual_validation_task, note_submission_left_review, sync_task_validation_status,
    validate_completing_accept_sole_submission, validate_contest_accept_window,
};
#[cfg(feature = "spl-token-rewards")]
use crate::instructions::token_helpers::{
    validate_token_account, validate_token_escrow_account, validate_unchecked_token_mint,
};
#[cfg(not(feature = "mainnet-canary"))]
use crate::state::CompletionBond;
use crate::state::{
    AgentRegistration, ProtocolConfig, SubmissionStatus, Task, TaskClaim, TaskEscrow, TaskStatus,
    TaskSubmission, TaskValidationConfig, ValidationMode,
};
#[cfg(feature = "mainnet-canary")]
use crate::state::{DependencyType, TaskType};
use crate::utils::version::check_version_compatible_for_exit;
use anchor_lang::prelude::*;
#[cfg(feature = "spl-token-rewards")]
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(Accounts)]
pub struct AcceptTaskResult<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Box<Account<'info, Task>>,

    #[account(
        mut,
        seeds = [b"claim", task.key().as_ref(), worker.key().as_ref()],
        bump = claim.bump,
        constraint = claim.task == task.key() @ CoordinationError::NotClaimed,
        constraint = claim.worker == worker.key() @ CoordinationError::NotClaimed
    )]
    pub claim: Box<Account<'info, TaskClaim>>,

    #[account(
        mut,
        seeds = [b"escrow", task.key().as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Box<Account<'info, TaskEscrow>>,

    #[account(
        mut,
        seeds = [b"task_validation", task.key().as_ref()],
        bump = task_validation_config.bump
    )]
    pub task_validation_config: Box<Account<'info, TaskValidationConfig>>,

    #[account(
        mut,
        seeds = [b"task_submission", claim.key().as_ref()],
        bump = task_submission.bump,
        constraint = task_submission.task == task.key() @ CoordinationError::TaskSubmissionRequired,
        constraint = task_submission.claim == claim.key() @ CoordinationError::TaskSubmissionRequired,
        constraint = task_submission.worker == worker.key() @ CoordinationError::TaskSubmissionRequired
    )]
    pub task_submission: Box<Account<'info, TaskSubmission>>,

    #[account(
        mut,
        seeds = [b"agent", worker.agent_id.as_ref()],
        bump = worker.bump
    )]
    pub worker: Box<Account<'info, AgentRegistration>>,

    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// CHECK: Protocol treasury account, validated against protocol config.
    #[account(
        mut,
        constraint = treasury.key() == protocol_config.treasury @ CoordinationError::InvalidInput
    )]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: Creator signer on the normal path. In the frozen canary build only,
    /// this signer becomes the permissionless timeout crank after review_deadline_at;
    /// the actual creator/rent recipient is then carried in the otherwise-unused
    /// writable `operator` slot and revalidated in the handler.
    #[account(
        mut,
        constraint = creator.key() == task.creator || cfg!(feature = "mainnet-canary")
            @ CoordinationError::InvalidCreator
    )]
    pub creator: Signer<'info>,

    /// CHECK: Receives reward payout, validated against worker.authority.
    #[account(
        mut,
        constraint = worker_authority.key() == worker.authority @ CoordinationError::UnauthorizedAgent
    )]
    pub worker_authority: UncheckedAccount<'info>,

    // === §4 operator leg (makes manual-review settlement hire-aware) ===
    /// CHECK: canonical ["hire", task] record. Always supplied on the full surface;
    /// direct tasks pass the empty system-owned PDA. Requiring the address prevents
    /// legacy hired tasks from omitting their unstamped operator/referrer fee terms.
    #[cfg(not(feature = "mainnet-canary"))]
    #[account(
        seeds = [b"hire", task.key().as_ref()],
        bump
    )]
    pub hire_record: UncheckedAccount<'info>,
    /// CHECK: frozen-canary ABI compatibility. Listing hires do not exist on this
    /// surface, so the historical account remains optional. If supplied, the
    /// handler accepts only the canonical empty system-owned ["hire", task] PDA.
    #[cfg(feature = "mainnet-canary")]
    pub hire_record: Option<UncheckedAccount<'info>>,
    /// CHECK: operator payee — validated == the task's resolved operator. Required only
    /// when the task carries a non-zero operator fee (a listing hire); receives the
    /// operator fee leg in SOL.
    #[account(mut)]
    pub operator: Option<UncheckedAccount<'info>>,
    /// CHECK: referrer payee — validated == the task's resolved referrer (P6.2 §4
    /// 4-way split). Required only when the task carries a non-zero referrer fee;
    /// receives the referrer fee leg in SOL.
    #[account(mut)]
    pub referrer: Option<UncheckedAccount<'info>>,

    // === Batch 3 completion bonds — REQUIRED + canonical-PDA-pinned (audit F12) ===
    // Refunded on accept. Made required + seeds-pinned (was Optional) so a Completed
    // transition can NEVER leave a live bond behind: if these were omittable, the bond
    // PDAs would survive into the terminal task, and close_task — which closes the Task
    // PDA — would then make reclaim_completion_bond (needs a live Task) impossible,
    // permanently stranding the bond principal. The caller passes the derived PDA even
    // for un-bonded tasks (an empty system account); settle_completion_bond no-ops on it.
    /// CHECK: creator completion bond PDA, seeds-pinned; validated + refunded by helper.
    #[cfg(not(feature = "mainnet-canary"))]
    #[account(
        mut,
        seeds = [b"completion_bond", task.key().as_ref(), creator.key().as_ref()],
        bump
    )]
    pub creator_completion_bond: UncheckedAccount<'info>,
    /// CHECK: worker completion bond PDA, seeds-pinned to the validated worker authority.
    #[cfg(not(feature = "mainnet-canary"))]
    #[account(
        mut,
        seeds = [b"completion_bond", task.key().as_ref(), worker_authority.key().as_ref()],
        bump
    )]
    pub worker_completion_bond: UncheckedAccount<'info>,

    // === Optional SPL Token accounts (only required for token-denominated tasks) ===
    #[cfg(feature = "spl-token-rewards")]
    #[account(mut)]
    pub token_escrow_ata: Option<Account<'info, TokenAccount>>,

    #[cfg(feature = "spl-token-rewards")]
    /// CHECK: Validated in handler; ATA may be created ahead of review settlement.
    #[account(mut)]
    pub worker_token_account: Option<UncheckedAccount<'info>>,

    #[cfg(feature = "spl-token-rewards")]
    #[account(mut)]
    pub treasury_token_account: Option<Account<'info, TokenAccount>>,

    #[cfg(feature = "spl-token-rewards")]
    pub reward_mint: Option<Account<'info, Mint>>,

    #[cfg(feature = "spl-token-rewards")]
    pub token_program: Option<Program<'info, Token>>,

    pub system_program: Program<'info, System>,
}

fn ensure_accept_review_state(
    task_status: TaskStatus,
    submission_status: SubmissionStatus,
) -> Result<()> {
    require!(
        task_status == TaskStatus::PendingValidation,
        CoordinationError::TaskNotPendingValidation
    );
    require!(
        submission_status == SubmissionStatus::Submitted,
        CoordinationError::SubmissionNotPending
    );
    Ok(())
}

/// The canary timeout branch deliberately supports only the economic shape the
/// canary can create: direct, single-worker, SOL-only tasks with no affiliate or
/// dependency legs. This makes reusing the writable `operator` slot as the stored
/// creator's rent recipient unambiguous and fail-closed.
#[cfg(feature = "mainnet-canary")]
fn ensure_canary_accept_shape(task: &Task) -> Result<()> {
    require!(
        task.task_type == TaskType::Exclusive,
        CoordinationError::InvalidTaskType
    );
    require!(
        task.max_workers == 1 && task.required_completions == 1,
        CoordinationError::InvalidMaxWorkers
    );
    require!(
        task.reward_mint.is_none(),
        CoordinationError::InvalidTokenMint
    );
    require!(
        task.dependency_type == DependencyType::None && task.depends_on.is_none(),
        CoordinationError::InvalidInput
    );
    require!(
        task.operator == Pubkey::default()
            && task.operator_fee_bps == 0
            && task.referrer == Pubkey::default()
            && task.referrer_fee_bps == 0,
        CoordinationError::InvalidInput
    );
    Ok(())
}

/// Return true when the canary signer is acting as a post-timeout crank. Before
/// the deadline, only the stored creator may accept. After it, any signer may
/// crank acceptance, but only when the writable alias account is exactly the
/// stored creator (the escrow-rent recipient cannot be redirected).
#[cfg(feature = "mainnet-canary")]
fn canary_timeout_accept_mode(
    task_creator: Pubkey,
    accept_signer: Pubkey,
    timeout_creator_recipient: Option<Pubkey>,
    review_deadline_at: i64,
    now: i64,
) -> Result<bool> {
    if accept_signer == task_creator {
        require!(
            timeout_creator_recipient.is_none(),
            CoordinationError::InvalidInput
        );
        return Ok(false);
    }

    require!(
        review_deadline_at > 0 && now >= review_deadline_at,
        CoordinationError::ReviewWindowNotElapsed
    );
    require!(
        timeout_creator_recipient == Some(task_creator),
        CoordinationError::InvalidCreator
    );
    Ok(true)
}

#[cfg(feature = "mainnet-canary")]
fn ensure_canary_hire_record_absent(
    task_key: &Pubkey,
    hire_record: Option<&UncheckedAccount<'_>>,
) -> Result<()> {
    if let Some(hire_record) = hire_record {
        let (expected, _) = Pubkey::find_program_address(&[b"hire", task_key.as_ref()], &crate::ID);
        require!(
            hire_record.key() == expected
                && hire_record.owner == &anchor_lang::system_program::ID
                && hire_record.data_is_empty(),
            CoordinationError::InvalidHireRecord
        );
    }
    Ok(())
}

pub fn handler(ctx: Context<AcceptTaskResult>) -> Result<()> {
    // Settlement path: accepting a submission resolves an in-flight, already-
    // escrowed task and pays the worker. It must work while the protocol is paused
    // or the type is disabled (both gate ENTRY only — spec §7, Decision #4 "money
    // never locks"); a pause must not strand escrowed funds mid-settlement.
    check_version_compatible_for_exit(&ctx.accounts.protocol_config)?;
    let clock = Clock::get()?;

    ensure_accept_review_state(
        ctx.accounts.task.status,
        ctx.accounts.task_submission.status,
    )?;
    require!(
        is_manual_validation_task(&ctx.accounts.task),
        CoordinationError::TaskValidationConfigRequired
    );
    ensure_validation_config(
        &ctx.accounts.task_validation_config,
        &ctx.accounts.task.key(),
        &ctx.accounts.task,
    )?;
    ensure_validation_mode(
        &ctx.accounts.task_validation_config,
        ValidationMode::CreatorReview,
    )?;
    #[cfg(feature = "mainnet-canary")]
    let canary_timeout_crank = {
        ensure_canary_accept_shape(&ctx.accounts.task)?;
        ensure_canary_hire_record_absent(
            &ctx.accounts.task.key(),
            ctx.accounts.hire_record.as_ref(),
        )?;
        require!(
            ctx.accounts.referrer.is_none(),
            CoordinationError::InvalidInput
        );
        canary_timeout_accept_mode(
            ctx.accounts.task.creator,
            ctx.accounts.creator.key(),
            ctx.accounts.operator.as_ref().map(|account| account.key()),
            ctx.accounts.task_submission.review_deadline_at,
            clock.unix_timestamp,
        )?
    };

    #[cfg(feature = "mainnet-canary")]
    let creator_recipient_info = if canary_timeout_crank {
        ctx.accounts
            .operator
            .as_ref()
            .ok_or(CoordinationError::InvalidCreator)?
            .to_account_info()
    } else {
        ctx.accounts.creator.to_account_info()
    };
    #[cfg(not(feature = "mainnet-canary"))]
    let creator_recipient_info = ctx.accounts.creator.to_account_info();
    // Batch 3 WS-CONTEST temporal partition (spec §3): a contest winner may be
    // accepted only strictly BEFORE `ghost_at` (afterwards the permissionless
    // ghost-split crank owns settlement), and only once every other live
    // submission has been rejected (losers' claim + submission rent must flow
    // back to them before the task can go terminal). No-op for non-contests.
    validate_contest_accept_window(&ctx.accounts.task, clock.unix_timestamp)?;
    // Audit M-2: block a completing non-Collaborative accept while a peer
    // submission is live. Collaborative tasks are deliberately exempt because
    // reclaim_terminal_claim provides terminal cleanup for Submitted peers.
    // MUST run before this submission leaves the live-submission counter.
    validate_completing_accept_sole_submission(&ctx.accounts.task)?;

    validate_task_dependency(
        ctx.accounts.task.as_ref(),
        ctx.remaining_accounts,
        ctx.program_id,
    )?;
    decrement_pending_submission_count(&mut ctx.accounts.task_validation_config)?;
    note_submission_left_review(&mut ctx.accounts.task)?;

    #[cfg(not(feature = "mainnet-canary"))]
    let bid_completion_meta = load_bid_task_completion_meta(
        ctx.accounts.task.as_ref(),
        &ctx.accounts.task.key(),
        ctx.accounts.claim.as_ref(),
        ctx.remaining_accounts,
    )?;
    #[cfg(not(feature = "mainnet-canary"))]
    let reward_amount_override = bid_completion_meta
        .as_ref()
        .map(|meta| meta.accepted_bid_price);
    #[cfg(feature = "mainnet-canary")]
    let reward_amount_override = None;
    let protocol_fee_bps = calculate_fee_with_reputation(
        ctx.accounts.task.protocol_fee_bps,
        ctx.accounts.worker.reputation,
    );

    #[cfg(feature = "spl-token-rewards")]
    let token_accounts = if ctx.accounts.task.reward_mint.is_some() {
        require!(
            ctx.accounts.token_escrow_ata.is_some()
                && ctx.accounts.worker_token_account.is_some()
                && ctx.accounts.treasury_token_account.is_some()
                && ctx.accounts.reward_mint.is_some()
                && ctx.accounts.token_program.is_some(),
            CoordinationError::MissingTokenAccounts
        );

        let mint = ctx
            .accounts
            .reward_mint
            .as_mut()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        let token_escrow = ctx
            .accounts
            .token_escrow_ata
            .as_mut()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        let treasury_ta = ctx
            .accounts
            .treasury_token_account
            .as_ref()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        let expected_mint = ctx
            .accounts
            .task
            .reward_mint
            .ok_or(CoordinationError::InvalidTokenMint)?;

        require!(
            mint.key() == expected_mint,
            CoordinationError::InvalidTokenMint
        );
        validate_token_escrow_account(
            &token_escrow.to_account_info(),
            &mint.key(),
            &ctx.accounts.escrow.key(),
        )?;
        validate_token_account(
            treasury_ta,
            &mint.key(),
            &ctx.accounts.protocol_config.treasury,
        )?;
        let token_escrow_starting_amount =
            anchor_spl::token::accessor::amount(&token_escrow.to_account_info())
                .map_err(|_| CoordinationError::TokenTransferFailed)?;

        let worker_ta_info = ctx
            .accounts
            .worker_token_account
            .as_ref()
            .ok_or(CoordinationError::MissingTokenAccounts)?
            .to_account_info();
        validate_unchecked_token_mint(
            &worker_ta_info,
            &mint.key(),
            &ctx.accounts.worker_authority.key(),
        )?;

        Some(TokenPaymentAccounts {
            token_escrow_ata: token_escrow,
            token_escrow_starting_amount,
            worker_token_account: worker_ta_info,
            treasury_token_account: treasury_ta.to_account_info(),
            token_program: ctx
                .accounts
                .token_program
                .as_ref()
                .ok_or(CoordinationError::MissingTokenAccounts)?,
            escrow_authority: ctx.accounts.escrow.to_account_info(),
            escrow_bump: ctx.accounts.escrow.bump,
            task_key: ctx.accounts.task.key(),
        })
    } else {
        None
    };
    #[cfg(not(feature = "spl-token-rewards"))]
    let token_accounts = {
        require!(
            ctx.accounts.task.reward_mint.is_none(),
            CoordinationError::InvalidTokenMint
        );
        None
    };

    ctx.accounts.claim.proof_hash = ctx.accounts.task_submission.proof_hash;
    ctx.accounts.claim.result_data = ctx.accounts.task_submission.result_data;
    ctx.accounts.claim.is_completed = true;
    ctx.accounts.claim.is_validated = true;
    ctx.accounts.claim.completed_at = clock.unix_timestamp;

    // Resolve every marketplace leg through the shared Task-first / legacy
    // HireRecord fallback so all completion-style exits enforce identical terms.
    #[cfg(not(feature = "mainnet-canary"))]
    let (operator_leg, referrer_leg) = build_marketplace_fee_legs(
        ctx.accounts.task.as_ref(),
        ctx.accounts.task.key(),
        &ctx.accounts.hire_record.to_account_info(),
        ctx.accounts
            .operator
            .as_ref()
            .map(|account| account.as_ref()),
        ctx.accounts
            .referrer
            .as_ref()
            .map(|account| account.as_ref()),
    )?;
    #[cfg(feature = "mainnet-canary")]
    let (operator_leg, referrer_leg) = (None, None);

    execute_completion_rewards(
        &mut ctx.accounts.task,
        &mut ctx.accounts.claim,
        &mut ctx.accounts.escrow,
        &mut ctx.accounts.worker,
        &mut ctx.accounts.protocol_config,
        &ctx.accounts.worker_authority.to_account_info(),
        &ctx.accounts.treasury.to_account_info(),
        &creator_recipient_info,
        protocol_fee_bps,
        reward_amount_override,
        Some(ctx.accounts.task_submission.result_data),
        &clock,
        token_accounts,
        operator_leg,
        referrer_leg,
    )?;

    ctx.accounts.task_submission.status = SubmissionStatus::Accepted;
    ctx.accounts.task_submission.accepted_at = clock.unix_timestamp;
    ctx.accounts.task_submission.rejected_at = 0;
    ctx.accounts.task_submission.rejection_hash = [0u8; 32];
    if ctx.accounts.task.status != TaskStatus::Completed {
        sync_task_validation_status(&mut ctx.accounts.task, &ctx.accounts.task_validation_config);
    }

    emit!(TaskResultAccepted {
        task: ctx.accounts.task.key(),
        claim: ctx.accounts.claim.key(),
        worker: ctx.accounts.worker.key(),
        accepted_by: ctx.accounts.creator.key(),
        accepted_at: clock.unix_timestamp,
    });

    #[cfg(not(feature = "mainnet-canary"))]
    if let Some(meta) = bid_completion_meta {
        finalize_bid_task_completion(
            ctx.remaining_accounts,
            &ctx.accounts.task.key(),
            ctx.accounts.claim.as_ref(),
            &meta,
            clock.unix_timestamp,
        )?;
    }

    ctx.accounts
        .claim
        .close(ctx.accounts.worker_authority.to_account_info())?;

    // Batch 3 WS-CONTEST §1 (submission-rent return, ALL task types): the worker
    // funded the TaskSubmission PDA — close it back to them at settle instead of
    // leaving its rent for the close_task sweep.
    ctx.accounts
        .task_submission
        .close(ctx.accounts.worker_authority.to_account_info())?;

    // Batch 3 §8: an accepted result means nobody lost — refund BOTH bonds. Required +
    // seeds-pinned accounts (audit F12), so this ALWAYS runs and a live bond can never
    // survive the Completed transition; settle no-ops on an un-bonded task's empty PDA.
    #[cfg(not(feature = "mainnet-canary"))]
    {
        let task_key = ctx.accounts.task.key();
        settle_completion_bond(
            &ctx.accounts.creator_completion_bond.to_account_info(),
            &ctx.accounts.creator.to_account_info(),
            &task_key,
            CompletionBond::ROLE_CREATOR,
            BondDisposition::Refund,
        )?;
        settle_completion_bond(
            &ctx.accounts.worker_completion_bond.to_account_info(),
            &ctx.accounts.worker_authority.to_account_info(),
            &task_key,
            CompletionBond::ROLE_WORKER,
            BondDisposition::Refund,
        )?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_anchor_error_code<T>(result: Result<T>, expected: CoordinationError) {
        let expected_code: u32 = expected.into();
        match result {
            Ok(_) => panic!("expected AnchorError code {expected_code}, got success"),
            Err(anchor_lang::error::Error::AnchorError(anchor_err)) => {
                assert_eq!(anchor_err.error_code_number, expected_code);
            }
            Err(other) => panic!("expected AnchorError code {expected_code}, got {other:?}"),
        }
    }

    #[test]
    fn accept_review_state_rejects_replay_and_non_pending_tasks() {
        ensure_accept_review_state(TaskStatus::PendingValidation, SubmissionStatus::Submitted)
            .unwrap();
        assert_anchor_error_code(
            ensure_accept_review_state(TaskStatus::Completed, SubmissionStatus::Submitted),
            CoordinationError::TaskNotPendingValidation,
        );
        assert_anchor_error_code(
            ensure_accept_review_state(TaskStatus::PendingValidation, SubmissionStatus::Accepted),
            CoordinationError::SubmissionNotPending,
        );
    }

    #[cfg(feature = "mainnet-canary")]
    mod canary {
        use super::*;

        fn canary_task() -> Task {
            Task {
                task_type: TaskType::Exclusive,
                max_workers: 1,
                required_completions: 1,
                dependency_type: DependencyType::None,
                ..Task::default()
            }
        }

        #[test]
        fn timeout_crank_is_rejected_before_review_deadline() {
            let creator = Pubkey::new_unique();
            assert_anchor_error_code(
                canary_timeout_accept_mode(
                    creator,
                    Pubkey::new_unique(),
                    Some(creator),
                    1_000,
                    999,
                ),
                CoordinationError::ReviewWindowNotElapsed,
            );
        }

        #[test]
        fn timeout_crank_rejects_wrong_creator_recipient() {
            let creator = Pubkey::new_unique();
            assert_anchor_error_code(
                canary_timeout_accept_mode(
                    creator,
                    Pubkey::new_unique(),
                    Some(Pubkey::new_unique()),
                    1_000,
                    1_000,
                ),
                CoordinationError::InvalidCreator,
            );
        }

        #[test]
        fn timeout_crank_opens_at_exact_deadline_and_creator_path_stays_immediate() {
            let creator = Pubkey::new_unique();
            assert!(canary_timeout_accept_mode(
                creator,
                Pubkey::new_unique(),
                Some(creator),
                1_000,
                1_000,
            )
            .unwrap());
            assert!(!canary_timeout_accept_mode(creator, creator, None, 1_000, 1).unwrap());
        }

        #[test]
        fn timeout_accept_fails_closed_for_non_canary_money_shapes() {
            ensure_canary_accept_shape(&canary_task()).unwrap();

            let mut task = canary_task();
            task.reward_mint = Some(Pubkey::new_unique());
            assert_anchor_error_code(
                ensure_canary_accept_shape(&task),
                CoordinationError::InvalidTokenMint,
            );

            let mut task = canary_task();
            task.operator = Pubkey::new_unique();
            task.operator_fee_bps = 100;
            assert_anchor_error_code(
                ensure_canary_accept_shape(&task),
                CoordinationError::InvalidInput,
            );

            let mut task = canary_task();
            task.referrer = Pubkey::new_unique();
            task.referrer_fee_bps = 100;
            assert_anchor_error_code(
                ensure_canary_accept_shape(&task),
                CoordinationError::InvalidInput,
            );

            let mut task = canary_task();
            task.depends_on = Some(Pubkey::new_unique());
            task.dependency_type = DependencyType::Proof;
            assert_anchor_error_code(
                ensure_canary_accept_shape(&task),
                CoordinationError::InvalidInput,
            );
        }
    }
}
