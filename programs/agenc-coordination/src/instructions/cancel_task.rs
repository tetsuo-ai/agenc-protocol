//! Cancel a task and refund the creator

use crate::errors::CoordinationError;
use crate::events::TaskCancelled;
#[cfg(not(feature = "mainnet-canary"))]
use crate::instructions::agent_stats_helpers::{apply_track_record, Counter};
#[cfg(not(feature = "mainnet-canary"))]
use crate::instructions::bid_settlement_helpers::{
    close_bid_book_without_accepted_bid, settle_accepted_bid, AcceptedBidBondDisposition,
    AcceptedBidBookDisposition,
};
#[cfg(not(feature = "mainnet-canary"))]
use crate::instructions::bond_helpers::{settle_completion_bond, BondDisposition};
use crate::instructions::lamport_transfer::transfer_lamports;
#[cfg(feature = "spl-token-rewards")]
use crate::instructions::token_helpers::{
    close_token_escrow, transfer_tokens_from_escrow, validate_token_account,
};
#[cfg(not(feature = "mainnet-canary"))]
use crate::state::AgentStats;
#[cfg(not(feature = "mainnet-canary"))]
use crate::state::CompletionBond;
#[cfg(not(feature = "mainnet-canary"))]
use crate::state::TaskType;
use crate::state::{AgentRegistration, ProtocolConfig, Task, TaskClaim, TaskEscrow, TaskStatus};
use crate::utils::version::check_version_compatible_for_exit;
use anchor_lang::prelude::*;
#[cfg(feature = "spl-token-rewards")]
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(Accounts)]
pub struct CancelTask<'info> {
    #[account(
        mut,
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        constraint = task.creator == authority.key() @ CoordinationError::UnauthorizedTaskAction
    )]
    pub task: Account<'info, Task>,

    #[account(
        mut,
        seeds = [b"escrow", task.key().as_ref()],
        bump,
        constraint = escrow.key() != task.key() @ CoordinationError::InvalidInput,
        constraint = escrow.owner == &crate::ID @ CoordinationError::InvalidAccountOwner
    )]
    /// CHECK: Escrow PDA is validated by seeds and deserialized in the handler so
    /// cancellation can surface protocol-specific errors before Anchor account loading.
    pub escrow: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub system_program: Program<'info, System>,

    // === Optional SPL Token accounts (only required for token-denominated tasks) ===
    #[cfg(feature = "spl-token-rewards")]
    /// Token escrow ATA holding reward tokens (optional)
    // Boxed: an unboxed `Account<TokenAccount>` here puts the full deserialized
    // token-account struct on the stack and saturates the 4KB SBF frame of the
    // full-surface `cancel_task` trampoline (15 "overwrites values in the frame"
    // warnings). Box moves it to the heap; matches `creator_agent`/`agent_stats`.
    #[account(mut)]
    pub token_escrow_ata: Option<Box<Account<'info, TokenAccount>>>,

    #[cfg(feature = "spl-token-rewards")]
    /// Creator's token account to receive refund (optional)
    /// CHECK: Validated in handler
    #[account(mut)]
    pub creator_token_account: Option<UncheckedAccount<'info>>,

    #[cfg(feature = "spl-token-rewards")]
    /// SPL token mint (optional, must match task.reward_mint)
    // Boxed for the same SBF stack-frame reason as `token_escrow_ata` above.
    pub reward_mint: Option<Box<Account<'info, Mint>>>,

    #[cfg(feature = "spl-token-rewards")]
    /// SPL Token program (optional, required for token tasks)
    pub token_program: Option<Program<'info, Token>>,

    // === Batch 3 completion bonds (REQUIRED + canonical-PDA-pinned, audit F5/F12) ===
    // Required, not optional: a cancel transitions the task to terminal, and a bond
    // left behind on a terminal task can never be reclaimed once the Task PDA is
    // closed (reclaim_completion_bond needs it live). The caller passes the derived
    // PDA even for an un-bonded task (empty system account); settle no-ops on it.
    /// CHECK: creator completion bond PDA, seeds-pinned to the cancelling creator
    /// (== authority); refunded on cancel by settle_completion_bond.
    #[cfg(not(feature = "mainnet-canary"))]
    #[account(
        mut,
        seeds = [b"completion_bond", task.key().as_ref(), authority.key().as_ref()],
        bump
    )]
    pub creator_completion_bond: UncheckedAccount<'info>,
    /// CHECK: worker completion bond PDA, seeds-pinned to the passed worker wallet.
    /// Forfeited to the creator ONLY when that wallet is a live no-show claimant
    /// (audit F-1); otherwise refunded to the poster.
    #[cfg(not(feature = "mainnet-canary"))]
    #[account(
        mut,
        seeds = [b"completion_bond", task.key().as_ref(), worker_bond_authority.key().as_ref()],
        bump
    )]
    pub worker_completion_bond: UncheckedAccount<'info>,
    /// CHECK: worker bond poster wallet; settle_completion_bond validates
    /// == bond.party, and the no-show forfeit additionally binds it to a live claim
    /// (audit F-1).
    #[cfg(not(feature = "mainnet-canary"))]
    #[account(mut)]
    pub worker_bond_authority: UncheckedAccount<'info>,

    /// OPTIONAL (P6.6): the cancelling creator's own agent registration, used to key the
    /// track-record aggregate. Constrained to `authority` so a caller can only attribute
    /// the cancel to THEIR OWN agent (no record-poisoning of a third party). Pass together
    /// with `agent_stats`. Full-surface only — gated so the frozen canary account list for
    /// `cancel_task` is unchanged.
    #[cfg(not(feature = "mainnet-canary"))]
    #[account(
        seeds = [b"agent", creator_agent.agent_id.as_ref()],
        bump = creator_agent.bump,
        constraint = creator_agent.authority == authority.key() @ CoordinationError::UnauthorizedAgent
    )]
    pub creator_agent: Option<Box<Account<'info, AgentRegistration>>>,

    /// OPTIONAL (P6.6): the creator agent's track-record aggregate. When supplied (with
    /// `creator_agent`), a cancel bumps `total_cancelled`. Bound to
    /// `["agent_stats", creator_agent]`, created lazily on first write. Telemetry only.
    #[cfg(not(feature = "mainnet-canary"))]
    #[account(
        init_if_needed,
        payer = authority,
        space = AgentStats::SIZE,
        seeds = [
            b"agent_stats",
            creator_agent
                .as_ref()
                .map(|a| a.key())
                .unwrap_or(crate::ID)
                .as_ref()
        ],
        bump
    )]
    pub agent_stats: Option<Box<Account<'info, AgentStats>>>,
}

pub fn process_cancel_task<'info>(
    ctx: Context<'_, '_, '_, 'info, CancelTask<'info>>,
) -> Result<()> {
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::UnauthorizedTaskAction
    );
    process_cancel_task_impl(ctx.accounts, ctx.remaining_accounts)?;

    // P6.6: fold a successful cancel into the creator agent's `total_cancelled` track
    // record (no-op when the optional `creator_agent` / `agent_stats` accounts are not
    // supplied). Done in the wrapper because it needs `ctx.bumps`. Telemetry only — runs
    // only after the cancel above succeeded.
    #[cfg(not(feature = "mainnet-canary"))]
    {
        // `agent_stats` is keyed on `creator_agent`; the two must be supplied together.
        // Reject `agent_stats` without `creator_agent` so we never write a mis-keyed PDA.
        require!(
            ctx.accounts.agent_stats.is_none() || ctx.accounts.creator_agent.is_some(),
            CoordinationError::UnauthorizedAgent
        );
        if let Some(creator_agent) = ctx.accounts.creator_agent.as_ref() {
            let creator_agent_key = creator_agent.key();
            let now = Clock::get()?.unix_timestamp;
            apply_track_record(
                &mut ctx.accounts.agent_stats,
                creator_agent_key,
                ctx.bumps.agent_stats,
                Counter::TotalCancelled,
                now,
            )?;
        }
    }

    Ok(())
}

pub(crate) fn load_task_escrow<'info>(
    escrow_info: &UncheckedAccount<'info>,
) -> Result<Account<'info, TaskEscrow>> {
    // SAFETY: same rationale as `load_task_claim_or_not_claimed`; the wrapped
    // `AccountInfo` already lives for `'info`.
    let escrow_info_ref: &'info AccountInfo<'info> =
        unsafe { std::mem::transmute(escrow_info.as_ref()) };
    Account::<TaskEscrow>::try_from(escrow_info_ref)
}

fn validate_cancel_prereqs(task: &Task, now: i64) -> Result<()> {
    require!(
        task.status.can_transition_to(TaskStatus::Cancelled),
        CoordinationError::InvalidStatusTransition
    );

    // Audit C-1: an underfilled Collaborative task whose every claimant completes before
    // the deadline lands at InProgress / current_workers == 0 / 0 < completions <
    // required_completions. With no live claim it can never reach required_completions
    // (claim_task is deadline-gated, so the roster can never refill) and every other exit
    // is blocked, so the residual escrow + rent would lock forever. Admit the past-deadline
    // cancel whenever NO live worker remains, regardless of completions — the claimants who
    // completed were already paid at completion time; this refunds only the undistributed
    // remainder to the creator. A live worker (current_workers > 0) still blocks cancel
    // while completions exist, preserving the "don't cancel out from under an active
    // claimant" invariant.
    let can_cancel = match task.status {
        TaskStatus::Open => true,
        TaskStatus::InProgress => {
            task.deadline > 0
                && now > task.deadline
                && (task.completions == 0 || task.current_workers == 0)
        }
        _ => false,
    };

    require!(can_cancel, CoordinationError::TaskCannotBeCancelled);

    // Batch 3 WS-CONTEST (spec §4): a contest that received work is NEVER silently
    // refunded — cancel requires zero live submissions, as a program invariant
    // rather than a status accident. (Status guards above already block
    // PendingValidation; this closes any Open/InProgress-with-live-submission gap.
    // The documented escape stays: a creator who explicitly REJECTS every entry
    // drives live_submissions to 0 — each rejection is public and rent-returned —
    // and may then cancel.)
    if task.is_contest_task() {
        require!(
            task.live_submissions() == 0,
            CoordinationError::ContestHasLiveSubmissions
        );
    }
    Ok(())
}

/// Audit F-1: the wallet a worker completion bond is forfeited against must be one of
/// the live no-show claimant wallets drained by this cancel (the claim triples'
/// rent-recipient keys, each already constrained == the claim worker's authority).
/// Pure + revert-sensitive.
#[cfg(not(feature = "mainnet-canary"))]
fn bond_forfeit_wallet_is_live_noshow(
    worker_wallet: &Pubkey,
    live_worker_wallets: &[Pubkey],
) -> bool {
    live_worker_wallets.iter().any(|w| w == worker_wallet)
}

fn process_cancel_task_impl<'info>(
    accounts: &mut CancelTask<'info>,
    remaining_accounts: &[AccountInfo<'info>],
) -> Result<()> {
    require!(
        accounts.authority.is_signer,
        CoordinationError::UnauthorizedTaskAction
    );
    // Exit path: a paused protocol must still let an escrowed task be cancelled
    // (money never locks, spec §7). Type-disable gates entry only, so it is NOT
    // re-checked here.
    check_version_compatible_for_exit(&accounts.protocol_config)?;
    require!(
        accounts.authority.is_signer,
        CoordinationError::UnauthorizedTaskAction
    );

    let task = &mut accounts.task;
    // SAFETY: `remaining_accounts` entries already carry `'info`; we only need
    // to rebind the slice reference itself so derived sub-slices can be reused
    // across the V2 settlement branches.
    let remaining_accounts: &'info [AccountInfo<'info>] =
        unsafe { std::mem::transmute(remaining_accounts) };
    let clock = Clock::get()?;
    require!(task.bump > 0, CoordinationError::CorruptedData);

    // Validate protocol-level cancellation rules before escrow deserialization.
    validate_cancel_prereqs(task, clock.unix_timestamp)?;

    // #70 fix: capture whether this is a genuine no-show cancel BEFORE the status is
    // mutated to Cancelled. validate_cancel_prereqs only admits two cases — an Open task,
    // or an InProgress task past its deadline with zero completions (a no-show). ONLY the
    // no-show case may forfeit the worker's completion bond to the creator. An Open cancel
    // includes a task reopened by reject_task_result after the worker DELIVERED work and
    // was rejected; forfeiting their bond there would let a malicious creator seize an
    // honest worker's bond (the exact theft #70 was filed to stop), so it is refunded.
    // Only used by the completion-bond block, which is full-surface (non-canary) only.
    // A genuine no-show requires a LIVE claim (current_workers > 0) that lapsed without
    // delivery. Audit C-1 widened the InProgress cancel branch to admit
    // current_workers == 0 with completions > 0; in that state nobody is at fault (every
    // claimant already completed and was paid), so a worker bond present there is
    // REFUNDED, not forfeited. Requiring current_workers > 0 keeps the forfeit scoped to
    // real no-shows and future-proofs it if completion bonds ever extend beyond Exclusive.
    #[cfg(not(feature = "mainnet-canary"))]
    let is_no_show_cancel =
        matches!(task.status, TaskStatus::InProgress) && task.current_workers > 0;

    let mut escrow = load_task_escrow(&accounts.escrow)?;
    require!(escrow.bump > 0, CoordinationError::CorruptedData);

    #[cfg(not(feature = "mainnet-canary"))]
    let (worker_accounts, bid_book_only, accepted_bid_accounts) =
        if task.task_type == TaskType::BidExclusive {
            if task.current_workers == 0 {
                require!(
                    remaining_accounts.len() == 1,
                    CoordinationError::BidSettlementAccountsRequired
                );
                (&remaining_accounts[..0], Some(&remaining_accounts[0]), None)
            } else {
                let worker_accounts_len = usize::from(task.current_workers)
                    .checked_mul(3)
                    .ok_or(CoordinationError::ArithmeticOverflow)?;
                require!(
                    remaining_accounts.len() == worker_accounts_len + 3,
                    CoordinationError::BidSettlementAccountsRequired
                );
                (
                    &remaining_accounts[..worker_accounts_len],
                    None,
                    Some(&remaining_accounts[worker_accounts_len..]),
                )
            }
        } else {
            (remaining_accounts, None, None)
        };
    #[cfg(feature = "mainnet-canary")]
    let worker_accounts = remaining_accounts;

    // If task has workers, require accounts
    if task.current_workers > 0 {
        require!(
            !remaining_accounts.is_empty(),
            CoordinationError::WorkerAccountsRequired
        );
    }

    // Calculate refund (total minus any distributed)
    let refund_amount = escrow
        .amount
        .checked_sub(escrow.distributed)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // Transfer refund to creator
    let is_token_task = task.reward_mint.is_some();
    #[cfg(feature = "spl-token-rewards")]
    let mut token_escrow_starting_amount: Option<u64> = None;
    #[cfg(not(feature = "spl-token-rewards"))]
    require!(!is_token_task, CoordinationError::InvalidTokenMint);
    #[cfg(feature = "spl-token-rewards")]
    if is_token_task {
        // Token path: transfer tokens back to creator
        require!(
            accounts.token_escrow_ata.is_some()
                && accounts.creator_token_account.is_some()
                && accounts.reward_mint.is_some()
                && accounts.token_program.is_some(),
            CoordinationError::MissingTokenAccounts
        );

        let token_escrow = accounts
            .token_escrow_ata
            .as_deref_mut()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        let creator_ta = accounts
            .creator_token_account
            .as_ref()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        let mint = accounts
            .reward_mint
            .as_deref()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        let token_program = accounts
            .token_program
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
        token_escrow_starting_amount = Some(
            anchor_spl::token::accessor::amount(&token_escrow.to_account_info())
                .map_err(|_| CoordinationError::TokenTransferFailed)?,
        );

        let task_key = task.key();
        let task_key_bytes = task_key.to_bytes();
        let bump_slice = [escrow.bump];
        let escrow_seeds: &[&[u8]] = &[b"escrow", task_key_bytes.as_ref(), &bump_slice];

        // Transfer remaining tokens back to creator
        transfer_tokens_from_escrow(
            token_escrow,
            &creator_ta.to_account_info(),
            &escrow.to_account_info(),
            refund_amount,
            escrow_seeds,
            token_program,
        )?;

        // NOTE: Token escrow ATA close is deferred until after worker processing
        // to ensure all claims are resolved before the ATA is closed.
    } else {
        // SOL path: existing lamport transfer (unchanged)
        transfer_lamports(
            &escrow.to_account_info(),
            &accounts.authority.to_account_info(),
            refund_amount,
        )?;
    }
    #[cfg(not(feature = "spl-token-rewards"))]
    {
        transfer_lamports(
            &escrow.to_account_info(),
            &accounts.authority.to_account_info(),
            refund_amount,
        )?;
    }

    // Update task status
    task.status = TaskStatus::Cancelled;
    escrow.is_closed = true;

    emit!(TaskCancelled {
        task_id: task.task_id,
        creator: task.creator,
        refund_amount,
        timestamp: clock.unix_timestamp,
    });

    #[cfg(not(feature = "mainnet-canary"))]
    if let Some(bid_book_info) = bid_book_only {
        close_bid_book_without_accepted_bid(&task.key(), bid_book_info, clock.unix_timestamp)?;
    }

    #[cfg(not(feature = "mainnet-canary"))]
    if let Some(bid_accounts) = accepted_bid_accounts {
        let claim_info = &worker_accounts[0];
        let rent_recipient_info = &worker_accounts[2];
        require!(
            claim_info.owner == &crate::ID,
            CoordinationError::InvalidAccountOwner
        );
        let claim_data = claim_info.try_borrow_data()?;
        let claim = TaskClaim::try_deserialize(&mut &claim_data[..])?;
        require!(claim.task == task.key(), CoordinationError::InvalidInput);
        drop(claim_data);
        let creator_info = accounts.authority.to_account_info();

        settle_accepted_bid(
            &task.key(),
            &claim,
            &bid_accounts[0],
            &bid_accounts[1],
            &bid_accounts[2],
            rent_recipient_info.clone(),
            Some(creator_info),
            clock.unix_timestamp,
            AcceptedBidBookDisposition::Close,
            AcceptedBidBondDisposition::FullSlashToCreator,
        )?;
    }

    // After task cancellation, decrement active_tasks for all claimants.
    // remaining_accounts must contain triples of:
    //   (claim_account, worker_agent_account, worker_authority_rent_recipient)
    // Claim rent is returned to worker authority (not creator) to prevent rent siphoning.
    require!(
        worker_accounts.len() % 3 == 0,
        CoordinationError::InvalidInput
    );
    let num_triples = worker_accounts
        .len()
        .checked_div(3)
        .ok_or(CoordinationError::ArithmeticOverflow)?;

    // SECURITY FIX #361: Validate ALL worker claims are provided BEFORE processing
    // Without this check, a malicious caller could pass only a subset of claims,
    // leaving some workers with permanently inflated active_tasks counters (DoS vector)
    require!(
        num_triples == task.current_workers as usize,
        CoordinationError::IncompleteWorkerAccounts
    );

    // Audit F-1: collect the live no-show worker wallets (each triple's rent recipient
    // is already constrained == worker.authority below) so the completion-bond forfeit
    // can be bound to an actual no-show claimant. Full-surface only (the bond block is
    // cfg'd out of the canary build).
    #[cfg(not(feature = "mainnet-canary"))]
    let mut live_worker_wallets: Vec<Pubkey> = Vec::with_capacity(num_triples);

    for i in 0..num_triples {
        let base = i
            .checked_mul(3)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        let worker_index = base
            .checked_add(1)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        let rent_recipient_index = base
            .checked_add(2)
            .ok_or(CoordinationError::ArithmeticOverflow)?;

        let claim_info = &worker_accounts[base];
        let worker_info = &worker_accounts[worker_index];
        let rent_recipient_info = &worker_accounts[rent_recipient_index];

        // Validate claim belongs to this task
        require!(
            claim_info.owner == &crate::ID,
            CoordinationError::InvalidAccountOwner
        );
        require!(claim_info.is_writable, CoordinationError::InvalidInput);
        let claim_data = claim_info.try_borrow_data()?;
        let claim = TaskClaim::try_deserialize(&mut &claim_data[..])?;
        require!(claim.task == task.key(), CoordinationError::InvalidInput);
        drop(claim_data);

        // Decrement worker's active_tasks
        require!(
            worker_info.owner == &crate::ID,
            CoordinationError::InvalidAccountOwner
        );
        require!(worker_info.is_writable, CoordinationError::InvalidInput);
        require!(
            worker_info.key() == claim.worker,
            CoordinationError::InvalidInput
        );
        let mut worker_data = worker_info.try_borrow_mut_data()?;
        let mut worker = AgentRegistration::try_deserialize(&mut &worker_data[..])?;
        require!(
            worker.authority == rent_recipient_info.key(),
            CoordinationError::InvalidRentRecipient
        );
        require!(
            rent_recipient_info.is_writable,
            CoordinationError::InvalidInput
        );
        #[cfg(not(feature = "mainnet-canary"))]
        live_worker_wallets.push(rent_recipient_info.key());
        // Using saturating_sub intentionally - underflow returns 0 (safe counter decrement)
        worker.active_tasks = worker.active_tasks.saturating_sub(1);
        // Use AnchorSerialize::serialize (Borsh only) — see dispute_helpers.rs comment (fix #960).
        AnchorSerialize::serialize(&worker, &mut &mut worker_data[8..])
            .map_err(|_| anchor_lang::error::ErrorCode::AccountDidNotSerialize)?;

        // Close claim account and return rent to worker authority.
        let claim_lamports = claim_info.lamports();
        **claim_info.try_borrow_mut_lamports()? = 0;
        **rent_recipient_info.try_borrow_mut_lamports()? = rent_recipient_info
            .lamports()
            .checked_add(claim_lamports)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        // Zero out data then write CLOSED_ACCOUNT_DISCRIMINATOR to prevent
        // init_if_needed from re-initializing the claim after cancellation.
        // Without this, claim_data is all zeros which matches a fresh account,
        // allowing a worker to re-claim via init_if_needed bypass.
        let mut claim_data = claim_info.try_borrow_mut_data()?;
        claim_data.fill(0);
        claim_data[..8].copy_from_slice(&[255u8; 8]);
    }

    // Close token escrow ATA AFTER all worker claims are processed
    #[cfg(feature = "spl-token-rewards")]
    if is_token_task {
        let token_escrow = accounts
            .token_escrow_ata
            .as_deref_mut()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        let token_program = accounts
            .token_program
            .as_ref()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        let creator_ta = accounts
            .creator_token_account
            .as_ref()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        let residual_amount = token_escrow_starting_amount
            .ok_or(CoordinationError::MissingTokenAccounts)?
            .checked_sub(refund_amount)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        let task_key = task.key();
        let task_key_bytes = task_key.to_bytes();
        let bump_slice = [escrow.bump];
        let escrow_seeds: &[&[u8]] = &[b"escrow", task_key_bytes.as_ref(), &bump_slice];
        close_token_escrow(
            token_escrow,
            residual_amount,
            &creator_ta.to_account_info(),
            &accounts.authority.to_account_info(),
            &escrow.to_account_info(),
            escrow_seeds,
            token_program,
        )?;
    }

    // Reset current_workers since all workers are removed on cancel
    task.current_workers = 0;

    escrow.close(accounts.authority.to_account_info())?;

    // Batch 3 §8 bond disposition on cancel (authority == creator): refund the
    // creator's bond; forfeit a worker's bond to the creator ONLY on a genuine no-show
    // (see `is_no_show_cancel`), otherwise refund it (audit #70). The bond accounts are
    // REQUIRED + seeds-pinned (audit F5/F12), so a live bond can never be left behind
    // on the terminal task; settle no-ops on an un-bonded task's empty PDA.
    #[cfg(not(feature = "mainnet-canary"))]
    {
        let task_key = accounts.task.key();
        let creator_info = accounts.authority.to_account_info();
        settle_completion_bond(
            &accounts.creator_completion_bond.to_account_info(),
            &creator_info,
            &task_key,
            CompletionBond::ROLE_CREATOR,
            BondDisposition::Refund,
        )?;
        let worker_wallet = accounts.worker_bond_authority.to_account_info();
        // #70 fix: forfeit to the creator ONLY on a genuine no-show; on an Open cancel
        // the worker is not at fault, so refund their bond to them (the poster).
        let disposition = if is_no_show_cancel {
            // Audit F-1: the forfeited bond must belong to a LIVE no-show claimant —
            // one of the workers whose claims are being drained above (their
            // rent-recipient wallets are already constrained == worker.authority).
            // Without this binding a creator could sybil-claim, no-show, and forfeit
            // the bond of an honest, already-rejected worker (whose bond stays
            // hostage while the task is live). settle_completion_bond separately
            // enforces poster_wallet == bond.party + the canonical PDA, so
            // membership here fully pins the forfeit to a real no-show.
            require!(
                bond_forfeit_wallet_is_live_noshow(
                    &worker_wallet.key(),
                    &live_worker_wallets
                ),
                CoordinationError::BondNotTiedToNoShowWorker
            );
            BondDisposition::Forfeit {
                recipient: &creator_info,
            }
        } else {
            BondDisposition::Refund
        };
        settle_completion_bond(
            &accounts.worker_completion_bond.to_account_info(),
            &worker_wallet,
            &task_key,
            CompletionBond::ROLE_WORKER,
            disposition,
        )?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_test_task(status: TaskStatus, deadline: i64, completions: u8) -> Task {
        Task {
            status,
            deadline,
            completions,
            ..Task::default()
        }
    }

    fn assert_anchor_error_code<T>(result: Result<T>, expected: CoordinationError) {
        let expected_code: u32 = expected.into();
        match result {
            Ok(_) => panic!("expected AnchorError code {expected_code}, got success"),
            Err(anchor_lang::error::Error::AnchorError(anchor_err)) => {
                assert_eq!(anchor_err.error_code_number, expected_code);
            }
            Err(other) => {
                panic!("expected AnchorError code {expected_code}, got {other:?}");
            }
        }
    }

    #[test]
    fn open_task_can_be_cancelled() {
        let task = build_test_task(TaskStatus::Open, 0, 0);
        validate_cancel_prereqs(&task, 100).unwrap();
    }

    #[test]
    fn expired_in_progress_task_without_completions_can_be_cancelled() {
        let task = build_test_task(TaskStatus::InProgress, 100, 0);
        validate_cancel_prereqs(&task, 101).unwrap();
    }

    #[test]
    fn in_progress_task_before_deadline_returns_task_cannot_be_cancelled() {
        let task = build_test_task(TaskStatus::InProgress, 100, 0);
        assert_anchor_error_code(
            validate_cancel_prereqs(&task, 100),
            CoordinationError::TaskCannotBeCancelled,
        );
    }

    #[test]
    fn in_progress_task_with_completions_and_live_worker_returns_task_cannot_be_cancelled() {
        // Past deadline, completions > 0, but a worker is still live: cancel stays blocked
        // so the creator can never cancel out from under an active claimant.
        let mut task = build_test_task(TaskStatus::InProgress, 100, 1);
        task.current_workers = 1;
        assert_anchor_error_code(
            validate_cancel_prereqs(&task, 101),
            CoordinationError::TaskCannotBeCancelled,
        );
    }

    // Audit C-1 (revert-sensitive): an underfilled Collaborative task whose claimants all
    // completed sits InProgress with current_workers == 0 and 0 < completions <
    // required_completions. Past the deadline it MUST be cancellable so the residual escrow
    // + rent are recoverable. Reverting the `current_workers == 0` arm of
    // validate_cancel_prereqs turns this red (TaskCannotBeCancelled).
    #[test]
    fn expired_underfilled_task_with_zero_live_workers_can_be_cancelled() {
        let task = Task {
            status: TaskStatus::InProgress,
            deadline: 100,
            completions: 1,
            current_workers: 0,
            required_completions: 3,
            ..Task::default()
        };
        validate_cancel_prereqs(&task, 101).unwrap();
    }

    #[test]
    fn completed_task_returns_invalid_status_transition() {
        let task = build_test_task(TaskStatus::Completed, 0, 0);
        assert_anchor_error_code(
            validate_cancel_prereqs(&task, 100),
            CoordinationError::InvalidStatusTransition,
        );
    }

    #[test]
    fn cancelled_task_returns_invalid_status_transition() {
        let task = build_test_task(TaskStatus::Cancelled, 0, 0);
        assert_anchor_error_code(
            validate_cancel_prereqs(&task, 100),
            CoordinationError::InvalidStatusTransition,
        );
    }

    // === Batch 3 WS-CONTEST cancel guard (spec §4) ===

    fn build_contest_task(status: TaskStatus, deadline: i64, live: u8) -> Task {
        let mut task = Task {
            status,
            deadline,
            task_type: crate::state::TaskType::Competitive,
            ..Task::default()
        };
        task.set_task_schema(Task::TASK_SCHEMA_CONTEST_AWARE);
        task.set_live_submissions(live);
        task
    }

    // Revert-sensitive: removing the contest live_submissions require turns this red.
    #[test]
    fn contest_with_live_submissions_cannot_be_cancelled() {
        let task = build_contest_task(TaskStatus::Open, 100, 1);
        assert_anchor_error_code(
            validate_cancel_prereqs(&task, 50),
            CoordinationError::ContestHasLiveSubmissions,
        );
        // InProgress-with-live-submission gap is closed too.
        let task = build_contest_task(TaskStatus::InProgress, 100, 2);
        assert_anchor_error_code(
            validate_cancel_prereqs(&task, 101),
            CoordinationError::ContestHasLiveSubmissions,
        );
    }

    #[test]
    fn contest_with_zero_live_submissions_can_be_cancelled() {
        // The documented reject-all-refund escape: every entry rejected -> live 0.
        let task = build_contest_task(TaskStatus::Open, 100, 0);
        validate_cancel_prereqs(&task, 50).unwrap();
    }

    #[test]
    fn schema0_competitive_cancel_is_unchanged() {
        // A live pre-batch-3 Competitive task never hits the contest guard, even
        // with a (structurally impossible today) non-zero counter byte.
        let mut task = build_test_task(TaskStatus::Open, 100, 0);
        task.task_type = crate::state::TaskType::Competitive;
        task.set_live_submissions(3); // schema stays 0
        validate_cancel_prereqs(&task, 50).unwrap();
    }

    // Audit F-1 (revert-sensitive): the forfeit wallet must be a live no-show claimant.
    // Dropping the membership check lets a creator forfeit an out-of-set (honest,
    // already-rejected) worker's bond — the second assert turns red.
    #[cfg(not(feature = "mainnet-canary"))]
    #[test]
    fn bond_forfeit_wallet_must_be_live_noshow() {
        let w_honest = Pubkey::new_unique();
        let v_sybil = Pubkey::new_unique();
        // The live no-show set is the claim triples' rent-recipient wallets.
        let live = vec![v_sybil];
        assert!(bond_forfeit_wallet_is_live_noshow(&v_sybil, &live));
        assert!(!bond_forfeit_wallet_is_live_noshow(&w_honest, &live));
        // An empty set (Open cancel / zero live workers) never validates a forfeit —
        // the refund path handles those without consulting this predicate.
        assert!(!bond_forfeit_wallet_is_live_noshow(&w_honest, &[]));
    }
}
