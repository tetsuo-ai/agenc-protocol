//! Apply slashing after dispute resolution.
//!
//! # Permissionless Design
//! Can be called by anyone after dispute resolves unfavorably.
//! This is intentional - ensures slashing cannot be avoided.
//!
//! # Time Window (fix #414)
//! Slashing must occur within 7 days of dispute resolution.
//! After this window, slashing can no longer be applied.

use crate::errors::CoordinationError;
use crate::instructions::slash_helpers::{
    apply_reputation_penalty, calculate_approval_percentage, calculate_slash_amount,
    transfer_slash_to_treasury, SLASH_WINDOW,
};
use crate::instructions::token_helpers::{
    close_token_escrow, transfer_tokens_from_escrow, validate_token_account,
};
use crate::state::{
    AgentRegistration, Dispute, DisputeStatus, ProtocolConfig, ResolutionType, Task, TaskClaim,
    TaskEscrow,
};
use crate::utils::version::check_version_compatible_for_exit;
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(Accounts)]
pub struct ApplyDisputeSlash<'info> {
    #[account(
        mut,
        seeds = [b"dispute", dispute.dispute_id.as_ref()],
        bump = dispute.bump
    )]
    pub dispute: Box<Account<'info, Dispute>>,

    #[account(
        mut, // F-2: this finalizer frees the deferred worker slot in current_workers.
        seeds = [b"task", task.creator.as_ref(), task.task_id.as_ref()],
        bump = task.bump,
        constraint = dispute.task == task.key() @ CoordinationError::TaskNotFound
    )]
    pub task: Box<Account<'info, Task>>,

    /// The losing worker's claim. resolve_dispute deliberately DEFERS closing this when a
    /// slash is pending (fix #838) so this finalizer can re-validate it; this instruction
    /// is the designated finalizer, so it closes the claim and returns its rent to the
    /// worker authority (audit: previously left read-only, permanently stranding the rent
    /// the non-slash path returns).
    #[account(
        mut,
        close = worker_authority,
        seeds = [b"claim", task.key().as_ref(), worker_claim.worker.as_ref()],
        bump = worker_claim.bump,
        constraint = worker_claim.task == task.key() @ CoordinationError::NotClaimed
    )]
    pub worker_claim: Box<Account<'info, TaskClaim>>,

    #[account(
        mut,
        seeds = [b"agent", worker_agent.agent_id.as_ref()],
        bump = worker_agent.bump
    )]
    pub worker_agent: Box<Account<'info, AgentRegistration>>,

    /// CHECK: the losing worker's authority — receives the closed claim's rent. Validated
    /// against worker_agent.authority so the rent cannot be redirected.
    #[account(
        mut,
        constraint = worker_authority.key() == worker_agent.authority @ CoordinationError::UnauthorizedAgent
    )]
    pub worker_authority: UncheckedAccount<'info>,

    #[account(
        seeds = [b"protocol"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,

    /// CHECK: Treasury account to receive slashed lamports
    #[account(
        mut,
        constraint = treasury.key() == protocol_config.treasury @ CoordinationError::InvalidInput
    )]
    pub treasury: UncheckedAccount<'info>,

    pub authority: Signer<'info>,

    // === Optional SPL Token slash accounts (token-denominated tasks only) ===
    /// Escrow PDA for the disputed task (kept open until slash for token disputes)
    #[account(mut)]
    pub escrow: Option<Box<Account<'info, TaskEscrow>>>,

    /// Token escrow ATA holding deferred slash amount
    #[account(mut)]
    pub token_escrow_ata: Option<Box<Account<'info, TokenAccount>>>,

    /// Treasury token ATA receiving slashed tokens
    #[account(mut)]
    pub treasury_token_account: Option<Box<Account<'info, TokenAccount>>>,

    /// SPL mint for task rewards (must match task.reward_mint)
    pub reward_mint: Option<Box<Account<'info, Mint>>>,

    /// SPL Token program
    pub token_program: Option<Program<'info, Token>>,
}

pub fn handler(ctx: Context<ApplyDisputeSlash>) -> Result<()> {
    require!(
        ctx.accounts.authority.is_signer,
        CoordinationError::InvalidInput
    );

    let dispute = &mut ctx.accounts.dispute;
    let worker_agent = &mut ctx.accounts.worker_agent;
    let config = &ctx.accounts.protocol_config;

    // Settlement path: this finalizes the slash + the token slash reserve that
    // resolve_dispute deferred (resolve_dispute is itself exit-safe). It must work
    // while the protocol is paused or the type is disabled (both gate ENTRY only —
    // spec §7, Decision #4 "money never locks"). There is NO alternative unwind
    // once the dispute is Resolved (expire_dispute requires DisputeStatus::Active),
    // and the 7-day SLASH_WINDOW means a pause that outlasts it would otherwise
    // strand the deferred token reserve permanently.
    check_version_compatible_for_exit(config)?;
    // Verify the worker being slashed is the actual defendant (fix #827)
    // Prevents slashing wrong worker on collaborative tasks with multiple claimants
    require!(
        worker_agent.key() == dispute.defendant,
        CoordinationError::WorkerNotInDispute
    );

    // Belt-and-suspenders: also verify worker has a valid claim on the disputed task
    require!(
        ctx.accounts.worker_claim.task == dispute.task
            && ctx.accounts.worker_claim.worker == worker_agent.key(),
        CoordinationError::WorkerNotInDispute
    );

    require!(
        dispute.status == DisputeStatus::Resolved,
        CoordinationError::DisputeNotResolved
    );

    let clock = Clock::get()?;
    let slash_window_open =
        clock.unix_timestamp <= dispute.resolved_at.saturating_add(SLASH_WINDOW);

    // P6.3: `votes_for`/`votes_against` are no longer an arbiter tally — `resolve_dispute`
    // now writes a 1-bit RULING into them ((1,0)=approved, (0,1)=rejected). The same
    // `calculate_approval_percentage` against `dispute_threshold` therefore recovers the
    // resolver's decision exactly: 100% (>= threshold) when approved, 0% when rejected.
    let (_total_votes, approval_pct) =
        calculate_approval_percentage(dispute.votes_for, dispute.votes_against)?;

    // Determine if the dispute was approved (ruling bit reads >= threshold percentage)
    let approved = approval_pct >= config.dispute_threshold as u64;

    // Determine if the worker lost the dispute and should be slashed:
    // - If dispute is APPROVED:
    //   - Refund: Worker failed, creator gets money back -> worker lost (slash)
    //   - Split: Partial failure, funds split -> worker lost (slash)
    //   - Complete: Worker vindicated, gets paid -> worker won (no slash)
    // - If dispute is REJECTED (not approved):
    //   - The resolver ruled in the worker's favor -> worker won (no slash)
    //
    // Fix for issue #136: Previously, rejected disputes incorrectly set worker_lost=true,
    // causing innocent workers to be slashed even when the dispute was ruled against the
    // initiator.
    let worker_lost = if approved {
        // Dispute approved: slash worker unless resolution favors them (Complete)
        dispute.resolution_type != ResolutionType::Complete
    } else {
        // Dispute rejected: worker was vindicated, do NOT slash
        false
    };

    require!(worker_lost, CoordinationError::InvalidInput);

    let is_token_task = ctx.accounts.task.reward_mint.is_some();

    // Audit M-3 (follow-up): a token task's deferred slash reserve is provable ONLY from
    // the escrow PDA's liveness — resolve_dispute leaves it open with is_closed == false
    // iff a reserve was deferred, and keeps the drained PDA readable otherwise. Require
    // the escrow account for token tasks and bind it to THIS task BEFORE trusting its
    // is_closed flag: otherwise a caller could pass a different, already-closed escrow to
    // fake "no reserve", take the stake-slash-only path, close the worker_claim (a
    // mandatory account here) and strand a live reserve forever — reachable in-window
    // AND lapsed, permissionlessly. Fails closed: a token task cannot be finalized at
    // all without its escrow account.
    let deferred_token_reserve = if is_token_task {
        let escrow = ctx
            .accounts
            .escrow
            .as_ref()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        require!(
            escrow.task == ctx.accounts.task.key() && ctx.accounts.task.escrow == escrow.key(),
            CoordinationError::TaskNotFound
        );
        !escrow.is_closed
    } else {
        false
    };

    // An explicit token-settlement attempt is signalled by the four SETTLEMENT accounts
    // (the escrow PDA itself is deliberately excluded: it is mandatory for token tasks
    // now, so counting it would force every token-task call into the settlement branch
    // and break the no-reserve stake-slash / finalize-only paths).
    let settlement_accounts_provided = token_slash_accounts_provided(
        ctx.accounts.token_escrow_ata.is_some(),
        ctx.accounts.treasury_token_account.is_some(),
        ctx.accounts.reward_mint.is_some(),
        ctx.accounts.token_program.is_some(),
    );
    validate_slash_application_window(dispute.slash_applied, settlement_accounts_provided)?;

    // Token settlement is required whenever a deferred reserve is LIVE — not merely when
    // the caller chose to provide token accounts (the caller-provided signal was the
    // reserve-stranding hole). A token task whose escrow proves no reserve (is_closed)
    // may still take the stake-slash-only path.
    let token_task_requires_settlement =
        token_slash_settlement_required(worker_lost, deferred_token_reserve);

    // If the slash window has elapsed, disallow lamport/reputation slashing but still allow
    // settlement of deferred token slash reserves so escrow cannot remain permanently locked.
    //
    // Audit M-3: when the window has lapsed AND there is no token reserve to settle (a SOL
    // task, or a token task whose escrow proves is_closed), the stake slash is forfeited —
    // but this call must STILL finalize the defendant bookkeeping below (clear
    // disputes_as_defendant, mark the dispute applied). Previously it returned
    // SlashWindowExpired here, so the finalizer could never run and disputes_as_defendant
    // stayed > 0 forever, permanently blocking withdraw_reputation_stake AND deregister_agent
    // (both require disputes_as_defendant == 0) — locking the worker's reputation and
    // registration stake. Fall through in that case with no slash applied.
    let finalize_only =
        finalize_only_after_window(slash_window_open, token_task_requires_settlement);

    // Calculate slash from stake snapshot and cap by current stake (fix #836).
    let apply_stake_slash = should_apply_stake_slash(dispute.slash_applied, slash_window_open);
    let slash_amount = if apply_stake_slash {
        calculate_slash_amount(
            dispute.worker_stake_at_dispute,
            worker_agent.stake,
            config.slash_percentage,
        )?
    } else {
        0
    };

    if apply_stake_slash {
        // Apply reputation penalty for losing the dispute (before lamport transfer to satisfy borrow checker)
        apply_reputation_penalty(worker_agent, &clock)?;
        if slash_amount > 0 {
            worker_agent.stake = worker_agent
                .stake
                .checked_sub(slash_amount)
                .ok_or(CoordinationError::ArithmeticOverflow)?;
        }
    } else if !slash_window_open {
        msg!("slash window expired; settling token reserve without stake/reputation slash");
    }

    if settlement_accounts_provided || token_task_requires_settlement {
        require!(
            ctx.accounts.escrow.is_some()
                && ctx.accounts.token_escrow_ata.is_some()
                && ctx.accounts.treasury_token_account.is_some()
                && ctx.accounts.reward_mint.is_some()
                && ctx.accounts.token_program.is_some(),
            CoordinationError::MissingTokenAccounts
        );

        let escrow = ctx
            .accounts
            .escrow
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
        let mint = ctx
            .accounts
            .reward_mint
            .as_ref()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        let token_program = ctx
            .accounts
            .token_program
            .as_ref()
            .ok_or(CoordinationError::MissingTokenAccounts)?;
        let expected_mint = ctx
            .accounts
            .task
            .reward_mint
            .ok_or(CoordinationError::InvalidTokenMint)?;
        let token_escrow_starting_amount =
            anchor_spl::token::accessor::amount(&token_escrow.to_account_info())
                .map_err(|_| CoordinationError::TokenTransferFailed)?;

        require!(
            escrow.task == ctx.accounts.task.key() && ctx.accounts.task.escrow == escrow.key(),
            CoordinationError::TaskNotFound
        );
        require!(
            mint.key() == expected_mint,
            CoordinationError::InvalidTokenMint
        );
        validate_token_account(token_escrow, &mint.key(), &escrow.key())?;
        validate_token_account(
            treasury_ta,
            &mint.key(),
            &ctx.accounts.protocol_config.treasury,
        )?;

        let task_key_bytes = ctx.accounts.task.key().to_bytes();
        let bump_slice = [escrow.bump];
        let escrow_seeds: &[&[u8]] = &[b"escrow", task_key_bytes.as_ref(), &bump_slice];

        // ResolveDispute leaves only the token slash reserve in escrow ATA.
        // Settling the slash transfers the full remaining escrow token balance.
        let token_slash_amount = token_escrow_starting_amount;
        if token_slash_amount > 0 {
            transfer_tokens_from_escrow(
                token_escrow,
                &treasury_ta.to_account_info(),
                &escrow.to_account_info(),
                token_slash_amount,
                escrow_seeds,
                token_program,
            )?;
        }
        let residual_amount = token_escrow_starting_amount
            .checked_sub(token_slash_amount)
            .ok_or(CoordinationError::ArithmeticOverflow)?;

        close_token_escrow(
            token_escrow,
            residual_amount,
            &treasury_ta.to_account_info(),
            &ctx.accounts.treasury.to_account_info(),
            &escrow.to_account_info(),
            escrow_seeds,
            token_program,
        )?;

        escrow.is_closed = true;
        escrow.close(ctx.accounts.treasury.to_account_info())?;
    }

    // If neither lamports nor token reserves can be slashed, fail explicitly — UNLESS the
    // slash window lapsed with nothing to settle (audit M-3 `finalize_only`), where we
    // intentionally apply no slash and fall through solely to clear the defendant
    // bookkeeping so the worker's stake cannot lock forever.
    require!(
        slash_amount > 0 || token_task_requires_settlement || finalize_only,
        CoordinationError::InvalidSlashAmount
    );

    // Perform lamport transfer after all CPIs. Direct lamport mutations are
    // checked against CPI boundaries by the runtime.
    if slash_amount > 0 {
        let worker_agent_info = worker_agent.to_account_info();
        transfer_slash_to_treasury(
            &worker_agent_info,
            &ctx.accounts.treasury.to_account_info(),
            slash_amount,
        )?;
    }

    if !dispute.slash_applied {
        worker_agent.disputes_as_defendant = worker_agent.disputes_as_defendant.saturating_sub(1);
        worker_agent.last_active = clock.unix_timestamp;
        dispute.slash_applied = true;
        // Audit F-2: this finalizer closes the deferred worker_claim on every successful
        // path (the `close = worker_authority` constraint), so free BOTH slots
        // resolve_dispute deliberately left — current_workers on the task and
        // active_tasks on the worker (kept consistent by the resolve-side change).
        // saturating_sub for legacy disputes (their counts were zeroed at resolve).
        ctx.accounts.task.current_workers = ctx.accounts.task.current_workers.saturating_sub(1);
        worker_agent.active_tasks = worker_agent.active_tasks.saturating_sub(1);
    }

    Ok(())
}

/// True when any of the four settlement-only token accounts is provided. The escrow PDA
/// is intentionally NOT an input: it is mandatory for token tasks, so it cannot signal an
/// explicit settlement attempt.
fn token_slash_accounts_provided(
    token_escrow: bool,
    treasury_token_account: bool,
    reward_mint: bool,
    token_program: bool,
) -> bool {
    token_escrow || treasury_token_account || reward_mint || token_program
}

fn validate_slash_application_window(
    slash_applied: bool,
    token_accounts_provided: bool,
) -> Result<()> {
    require!(
        !slash_applied || token_accounts_provided,
        CoordinationError::SlashAlreadyApplied
    );

    Ok(())
}

/// Token settlement is required exactly when the worker lost AND a deferred token slash
/// reserve is live (derived in the handler from the bound escrow PDA's liveness — never
/// from which accounts the caller happened to provide, which was the stranding hole).
fn token_slash_settlement_required(worker_lost: bool, deferred_token_reserve: bool) -> bool {
    worker_lost && deferred_token_reserve
}

fn should_apply_stake_slash(slash_applied: bool, slash_window_open: bool) -> bool {
    !slash_applied && slash_window_open
}

/// Audit M-3: after the slash window lapses with no token reserve to settle, the stake
/// slash is forfeited but the finalizer must still clear the defendant bookkeeping
/// (disputes_as_defendant) so the worker's stake cannot lock forever. True in exactly that
/// "finalize-only, no slash" case; every other case runs a real slash or token settlement.
/// Safe for token tasks now: `token_task_requires_settlement` is true whenever a reserve
/// is live, so this path can never close the worker_claim over an unsettled reserve.
fn finalize_only_after_window(slash_window_open: bool, token_task_requires_settlement: bool) -> bool {
    !slash_window_open && !token_task_requires_settlement
}

#[cfg(test)]
mod tests {
    use super::*;

    // Audit M-3 (revert-sensitive on the predicate): only a lapsed window with nothing to
    // settle is finalize-only. Widening it would skip real slashes; narrowing it back to
    // `false` re-locks the worker's stake after the window (the original bug).
    #[test]
    fn finalize_only_after_window_matrix() {
        assert!(finalize_only_after_window(false, false));
        assert!(!finalize_only_after_window(true, false));
        assert!(!finalize_only_after_window(false, true));
        assert!(!finalize_only_after_window(true, true));
    }

    // M-3 follow-up (revert-sensitive): settlement is forced by a LIVE deferred reserve,
    // not by the caller providing token accounts. Keying on the caller's accounts again
    // turns the first assert red and re-opens the permissionless reserve-stranding.
    #[test]
    fn token_settlement_required_only_when_reserve_deferred() {
        // Worker lost + reserve live -> settlement mandatory (full token account set).
        assert!(token_slash_settlement_required(true, true));
        // Worker lost, no reserve -> stake-slash-only path stays available.
        assert!(!token_slash_settlement_required(true, false));
        // Worker not lost -> never settles (unreachable past the worker_lost require).
        assert!(!token_slash_settlement_required(false, true));
    }

    #[test]
    fn already_applied_stake_slash_can_continue_with_token_settlement() {
        assert!(validate_slash_application_window(true, true).is_ok());
    }

    #[test]
    fn already_applied_stake_slash_rejects_duplicate_stake_only_call() {
        let err = validate_slash_application_window(true, false).unwrap_err();

        assert_eq!(err, CoordinationError::SlashAlreadyApplied.into());
    }

    #[test]
    fn stake_slash_is_skipped_after_it_has_already_been_applied() {
        assert!(!should_apply_stake_slash(true, true));
    }

    #[test]
    fn stake_slash_applies_only_inside_the_slash_window() {
        assert!(should_apply_stake_slash(false, true));
        assert!(!should_apply_stake_slash(false, false));
    }

    #[test]
    fn any_token_settlement_account_counts_as_explicit_settlement_attempt() {
        assert!(token_slash_accounts_provided(true, false, false, false));
        assert!(token_slash_accounts_provided(false, false, false, true));
        assert!(!token_slash_accounts_provided(false, false, false, false));
    }
}
