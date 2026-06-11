//! Complete a task and claim reward

use crate::errors::CoordinationError;
use crate::instructions::bid_settlement_helpers::{
    finalize_bid_task_completion, load_bid_task_completion_meta,
};
#[cfg(not(feature = "mainnet-canary"))]
use crate::instructions::bond_helpers::{settle_completion_bond, BondDisposition};
use crate::instructions::completion_helpers::TokenPaymentAccounts;
use crate::instructions::completion_helpers::{
    build_referrer_leg, calculate_fee_with_reputation, execute_completion_rewards,
    load_task_claim_or_not_claimed, validate_completion_prereqs, validate_task_dependency,
    OperatorLeg,
};
use crate::instructions::task_validation_helpers::is_manual_validation_task;
use crate::instructions::token_helpers::{validate_token_account, validate_unchecked_token_mint};
#[cfg(not(feature = "mainnet-canary"))]
use crate::state::CompletionBond;
use crate::state::{
    AgentRegistration, HireRecord, ProtocolConfig, Task, TaskEscrow, HASH_SIZE, RESULT_DATA_SIZE,
};
use crate::utils::compute_budget::log_compute_units;
use crate::utils::version::check_version_compatible_for_exit;
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

/// Note: Large accounts use Box<Account<...>> to avoid stack overflow
/// Consistent with Anchor best practices for accounts > 10KB
#[derive(Accounts)]
pub struct CompleteTask<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump
    )]
    pub task: Box<Account<'info, Task>>,

    /// CHECK: Claim PDA is validated by seeds and loaded in the handler so a missing
    /// claim can surface `NotClaimed` instead of Anchor's `AccountNotInitialized`.
    #[account(
        mut,
        seeds = [b"claim", task.key().as_ref(), worker.key().as_ref()],
        bump
    )]
    pub claim: UncheckedAccount<'info>,

    /// Note: Escrow account is closed conditionally after the final completion.
    /// For collaborative tasks with multiple workers, it stays open until all complete.
    #[account(
        mut,
        seeds = [b"escrow", task.key().as_ref()],
        bump = escrow.bump
    )]
    pub escrow: Box<Account<'info, TaskEscrow>>,

    /// CHECK: Task creator receives escrow rent - validated to match task.creator
    #[account(
        mut,
        constraint = creator.key() == task.creator @ CoordinationError::InvalidCreator
    )]
    pub creator: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"agent", worker.agent_id.as_ref()],
        bump = worker.bump,
        has_one = authority @ CoordinationError::UnauthorizedAgent
    )]
    pub worker: Box<Account<'info, AgentRegistration>>,

    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// CHECK: Treasury account for protocol fees - validated against protocol_config
    #[account(
        mut,
        constraint = treasury.key() == protocol_config.treasury @ CoordinationError::InvalidInput
    )]
    pub treasury: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,

    // === Optional SPL Token accounts (only required for token-denominated tasks) ===
    /// Token escrow ATA holding reward tokens (optional)
    #[account(mut)]
    pub token_escrow_ata: Option<Account<'info, TokenAccount>>,

    /// Worker's token account to receive reward (optional)
    /// CHECK: Validated in handler; ATA created via CPI if needed
    #[account(mut)]
    pub worker_token_account: Option<UncheckedAccount<'info>>,

    /// Treasury's token account for protocol fees (optional, must pre-exist)
    #[account(mut)]
    pub treasury_token_account: Option<Account<'info, TokenAccount>>,

    /// SPL token mint (optional, must match task.reward_mint)
    pub reward_mint: Option<Account<'info, Mint>>,

    /// SPL Token program (optional, required for token tasks)
    pub token_program: Option<Program<'info, Token>>,

    // === 3-way-split accounts (spec §4) ===
    /// Hire link PDA for this task. ALWAYS required — the caller passes the derived
    /// ["hire", task] address even for non-hired tasks (where it is an empty system
    /// account). A live, program-owned record means the task was hired from a listing
    /// and its operator fee MUST be paid at settlement, so a worker CANNOT omit the
    /// account to pocket the operator's cut. Mirrors close_task's required-hire_record
    /// design (the same dodge an audit caught there).
    /// CHECK: address fixed by seeds; live-vs-absent is decided by `owner` in the
    /// handler, and a live record is deserialized + validated there.
    #[account(
        seeds = [b"hire", task.key().as_ref()],
        bump
    )]
    pub hire_record: UncheckedAccount<'info>,

    /// CHECK: operator payee — validated in the handler to equal hire_record.operator.
    /// Required only when a live hire carries a non-zero operator fee. Receives the
    /// operator fee leg in SOL.
    #[account(mut)]
    pub operator: Option<UncheckedAccount<'info>>,

    /// CHECK: referrer payee — validated in the handler to equal the task's
    /// snapshotted referrer (P6.2 §4 4-way split). Required only when the task carries
    /// a non-zero referrer fee. Receives the referrer fee leg in SOL.
    #[account(mut)]
    pub referrer: Option<UncheckedAccount<'info>>,

    // === Batch 3 completion bonds — REQUIRED + canonical-PDA-pinned (audit F12) ===
    // Refunded on success. Required + seeds-pinned (was Optional) so the Completed
    // transition can never strand a live bond past close_task; settle no-ops on the empty
    // PDA of an un-bonded task. The worker bond is pinned to `authority` (the worker
    // signer, validated `has_one = authority` on `worker`).
    /// CHECK: creator completion bond PDA, seeds-pinned; validated + refunded by helper.
    #[account(
        mut,
        seeds = [b"completion_bond", task.key().as_ref(), creator.key().as_ref()],
        bump
    )]
    pub creator_completion_bond: UncheckedAccount<'info>,
    /// CHECK: worker completion bond PDA, seeds-pinned to the worker signer authority.
    #[account(
        mut,
        seeds = [b"completion_bond", task.key().as_ref(), authority.key().as_ref()],
        bump
    )]
    pub worker_completion_bond: UncheckedAccount<'info>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, CompleteTask<'info>>,
    proof_hash: [u8; HASH_SIZE],
    result_data: Option<[u8; RESULT_DATA_SIZE]>,
) -> Result<()> {
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::UnauthorizedAgent
    );
    handle_complete_task(
        ctx.accounts,
        ctx.remaining_accounts,
        ctx.program_id,
        proof_hash,
        result_data,
    )
}

fn handle_complete_task<'info>(
    accounts: &mut CompleteTask<'info>,
    remaining_accounts: &[AccountInfo<'info>],
    program_id: &Pubkey,
    proof_hash: [u8; HASH_SIZE],
    result_data: Option<[u8; RESULT_DATA_SIZE]>,
) -> Result<()> {
    log_compute_units("complete_task_start");
    require!(
        accounts.authority.is_signer,
        CoordinationError::UnauthorizedAgent
    );

    let task_key = accounts.task.key();
    let mut claim = load_task_claim_or_not_claimed(&accounts.claim, &task_key)?;
    let bid_settlement = load_bid_task_completion_meta(
        accounts.task.as_ref(),
        &task_key,
        &claim,
        remaining_accounts,
    )?;
    let reward_amount_override = bid_settlement
        .as_ref()
        .map(|settlement| settlement.accepted_bid_price);
    let task = &mut accounts.task;
    let escrow = &mut accounts.escrow;
    let worker = &mut accounts.worker;
    let clock = Clock::get()?;

    // Settlement path: an in-flight task must settle even while the protocol is
    // paused or its type is disabled (both gate ENTRY only — spec §7, Decision #4
    // "money never locks"). Paying out already-escrowed funds for completed work
    // is an exit, not new work, so a pause must never strand a worker's reward.
    check_version_compatible_for_exit(&accounts.protocol_config)?;

    // If task has a proof dependency, verify parent task is completed (shared helper)
    validate_task_dependency(task, remaining_accounts, program_id)?;

    // Use the protocol fee locked at task creation (#479), with reputation discount
    let protocol_fee_bps = calculate_fee_with_reputation(task.protocol_fee_bps, worker.reputation);

    // Validate proof_hash is not zero
    require!(proof_hash != [0u8; 32], CoordinationError::InvalidProofHash);

    // Validate result_data is not all zeros (when provided)
    if let Some(ref data) = result_data {
        require!(
            data.iter().any(|&b| b != 0),
            CoordinationError::InvalidResultData
        );
    }

    // Shared validation: status, transition, deadline, claim, competitive guard
    validate_completion_prereqs(task, &claim, &clock)?;

    // CRITICAL: Private tasks MUST use complete_task_private (ZK proof verification).
    // Without this guard, an attacker could bypass ZK proof requirements by calling
    // the public completion path on a task with a non-zero constraint_hash.
    require!(
        !is_manual_validation_task(task),
        CoordinationError::ManualValidationRequiresReviewFlow
    );
    require!(
        task.constraint_hash == [0u8; HASH_SIZE],
        CoordinationError::PrivateTaskRequiresZkProof
    );

    // Build optional token payment accounts
    let token_accounts = if task.reward_mint.is_some() {
        require!(
            accounts.token_escrow_ata.is_some()
                && accounts.worker_token_account.is_some()
                && accounts.treasury_token_account.is_some()
                && accounts.reward_mint.is_some()
                && accounts.token_program.is_some(),
            CoordinationError::MissingTokenAccounts
        );

        let mint = accounts
            .reward_mint
            .as_mut()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        let token_escrow = accounts
            .token_escrow_ata
            .as_mut()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        let treasury_ta = accounts
            .treasury_token_account
            .as_ref()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        let expected_mint = task
            .reward_mint
            .ok_or(CoordinationError::InvalidTokenMint)?;

        require!(
            mint.key() == expected_mint,
            CoordinationError::InvalidTokenMint
        );

        validate_token_account(token_escrow, &mint.key(), &escrow.key())?;
        validate_token_account(treasury_ta, &mint.key(), &accounts.protocol_config.treasury)?;
        let token_escrow_starting_amount =
            anchor_spl::token::accessor::amount(&token_escrow.to_account_info())
                .map_err(|_| CoordinationError::TokenTransferFailed)?;

        let worker_ta_info = accounts
            .worker_token_account
            .as_ref()
            .ok_or(CoordinationError::MissingTokenAccounts)?
            .to_account_info();
        validate_unchecked_token_mint(&worker_ta_info, &mint.key(), &accounts.authority.key())?;

        Some(TokenPaymentAccounts {
            token_escrow_ata: token_escrow,
            token_escrow_starting_amount,
            worker_token_account: worker_ta_info,
            treasury_token_account: treasury_ta.to_account_info(),
            token_program: accounts
                .token_program
                .as_ref()
                .ok_or(CoordinationError::MissingTokenAccounts)?,
            escrow_authority: escrow.to_account_info(),
            escrow_bump: escrow.bump,
            task_key: task.key(),
        })
    } else {
        None
    };

    // Update claim fields (must be set before execute_completion_rewards)
    let claim_result_data = result_data.unwrap_or([0u8; RESULT_DATA_SIZE]);
    claim.proof_hash = proof_hash;
    claim.result_data = claim_result_data;
    claim.is_completed = true;
    claim.completed_at = clock.unix_timestamp;

    log_compute_units("complete_task_validated");

    // §4 3-way split (Batch 2: Task-first, HireRecord fallback).
    // A Batch-2 hire stamps the operator terms onto the Task itself, so settlement
    // reads them straight from the (trusted, program-owned) Task account. The 149
    // pre-Batch-2 tasks (and any hire created before the redeploy) carry
    // `task.operator == default`, so we FALL BACK to the live ["hire", task]
    // HireRecord — never drop this fallback or those operators go unpaid. A worker
    // still cannot dodge the leg: the operator terms come from program-owned state,
    // and the seeds-fixed hire_record account stays required by the struct.
    // Resolve BOTH the operator (supply-side) and referrer (P6.2 demand-side) legs
    // from program-owned state: Task-first (stamped at hire/create), HireRecord
    // fallback for pre-stamp tasks. Neither leg can be dodged — the terms come from
    // trusted on-chain snapshots, and a present leg makes its payee account required.
    let (operator_pubkey, operator_fee_bps_resolved, referrer_pubkey, referrer_fee_bps_resolved) =
        if task.operator != Pubkey::default() || task.referrer != Pubkey::default() {
            (
                task.operator,
                task.operator_fee_bps,
                task.referrer,
                task.referrer_fee_bps,
            )
        } else if accounts.hire_record.owner == &crate::ID {
            let hire_info = accounts.hire_record.to_account_info();
            let hire = {
                let data = hire_info.try_borrow_data()?;
                HireRecord::try_deserialize(&mut &data[..])?
            };
            require!(hire.task == task_key, CoordinationError::InvalidHireRecord);
            (
                hire.operator,
                hire.operator_fee_bps,
                hire.referrer,
                hire.referrer_fee_bps,
            )
        } else {
            (Pubkey::default(), 0, Pubkey::default(), 0)
        };
    let operator_leg = if operator_fee_bps_resolved > 0 && operator_pubkey != Pubkey::default() {
        let op = accounts
            .operator
            .as_ref()
            .ok_or(CoordinationError::MissingOperatorAccount)?;
        require!(
            op.key() == operator_pubkey,
            CoordinationError::InvalidOperatorAccount
        );
        Some(OperatorLeg {
            payee: op.to_account_info(),
            fee_bps: operator_fee_bps_resolved,
        })
    } else {
        None
    };
    let referrer_leg = build_referrer_leg(
        referrer_pubkey,
        referrer_fee_bps_resolved,
        accounts.referrer.as_ref().map(|r| r.as_ref()),
    )?;

    // Execute reward transfer, state updates, event emissions, and conditional escrow closure
    execute_completion_rewards(
        task,
        &mut claim,
        escrow,
        worker,
        &mut accounts.protocol_config,
        &accounts.authority.to_account_info(),
        &accounts.treasury.to_account_info(),
        &accounts.creator.to_account_info(),
        protocol_fee_bps,
        reward_amount_override,
        Some(claim_result_data),
        &clock,
        token_accounts,
        operator_leg,
        referrer_leg,
    )?;

    if let Some(settlement) = &bid_settlement {
        finalize_bid_task_completion(
            remaining_accounts,
            &task_key,
            &claim,
            settlement,
            clock.unix_timestamp,
        )?;
    }

    claim.close(accounts.authority.to_account_info())?;

    // Batch 3 §8: a clean completion means nobody lost — refund BOTH completion bonds to
    // their posters. Required + seeds-pinned accounts (audit F12): always runs, so no live
    // bond survives the Completed transition; settle no-ops on an un-bonded task's empty PDA.
    #[cfg(not(feature = "mainnet-canary"))]
    {
        let task_key = accounts.task.key();
        settle_completion_bond(
            &accounts.creator_completion_bond.to_account_info(),
            &accounts.creator.to_account_info(),
            &task_key,
            CompletionBond::ROLE_CREATOR,
            BondDisposition::Refund,
        )?;
        settle_completion_bond(
            &accounts.worker_completion_bond.to_account_info(),
            &accounts.authority.to_account_info(),
            &task_key,
            CompletionBond::ROLE_WORKER,
            BondDisposition::Refund,
        )?;
    }

    log_compute_units("complete_task_done");

    Ok(())
}
