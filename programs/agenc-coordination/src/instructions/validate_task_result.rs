//! Record a validator quorum vote or external attestation for a submitted result.

use crate::errors::CoordinationError;
use crate::events::{TaskResultAccepted, TaskResultRejected, TaskResultValidationRecorded};
use crate::instructions::bid_settlement_helpers::{
    bid_settlement_offset, finalize_bid_task_completion, load_bid_task_completion_meta,
    settle_accepted_bid, AcceptedBidBondDisposition, AcceptedBidBookDisposition,
};
#[cfg(not(feature = "mainnet-canary"))]
use crate::instructions::bond_helpers::{settle_completion_bond, BondDisposition};
use crate::instructions::completion_helpers::TokenPaymentAccounts;
use crate::instructions::completion_helpers::{
    calculate_fee_with_reputation, execute_completion_rewards, validate_task_dependency,
};
use crate::instructions::program_account_helpers::remaining_account_at;
use crate::instructions::task_validation_helpers::{
    decrement_pending_submission_count, ensure_validation_config, is_manual_validation_task,
    note_submission_left_review, release_claim_slot, sync_task_validation_status,
    validate_completing_accept_sole_submission, validate_contest_accept_window,
};
use crate::instructions::token_helpers::{
    validate_token_account, validate_token_escrow_account, validate_unchecked_token_mint,
};
#[cfg(not(feature = "mainnet-canary"))]
use crate::state::CompletionBond;
use crate::state::{
    capability, AgentRegistration, AgentStatus, ProtocolConfig, SubmissionStatus, Task,
    TaskAttestorConfig, TaskClaim, TaskEscrow, TaskStatus, TaskSubmission, TaskValidationConfig,
    TaskValidationVote, ValidationMode,
};
use crate::utils::version::check_version_compatible_for_exit;
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(Accounts)]
pub struct ValidateTaskResult<'info> {
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
        seeds = [b"task_attestor", task.key().as_ref()],
        bump = task_attestor_config.bump
    )]
    pub task_attestor_config: Option<Box<Account<'info, TaskAttestorConfig>>>,

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
        init_if_needed,
        payer = reviewer,
        space = TaskValidationVote::SIZE,
        seeds = [b"task_validation_vote", task_submission.key().as_ref(), reviewer.key().as_ref()],
        bump
    )]
    pub task_validation_vote: Box<Account<'info, TaskValidationVote>>,

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

    /// Optional validator agent for validator-quorum mode, validated in handler.
    /// Writable because a quorum vote must lock the registration stake against
    /// immediate identity recycling (see `last_vote_timestamp` in the handler).
    #[account(mut)]
    pub validator_agent: Option<Box<Account<'info, AgentRegistration>>>,

    /// CHECK: Protocol treasury account, validated against protocol config.
    #[account(
        mut,
        constraint = treasury.key() == protocol_config.treasury @ CoordinationError::InvalidInput
    )]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: Receives escrow rent on final settlement, validated against task.creator.
    #[account(
        mut,
        constraint = creator.key() == task.creator @ CoordinationError::InvalidCreator
    )]
    pub creator: UncheckedAccount<'info>,

    /// CHECK: Claim rent and rewards are returned to the worker wallet.
    #[account(
        mut,
        constraint = worker_authority.key() == worker.authority @ CoordinationError::UnauthorizedAgent
    )]
    pub worker_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub reviewer: Signer<'info>,

    #[account(mut)]
    pub token_escrow_ata: Option<Account<'info, TokenAccount>>,

    /// CHECK: Validated in handler; ATA may be created ahead of settlement.
    #[account(mut)]
    pub worker_token_account: Option<UncheckedAccount<'info>>,

    #[account(mut)]
    pub treasury_token_account: Option<Account<'info, TokenAccount>>,

    pub reward_mint: Option<Account<'info, Mint>>,

    pub token_program: Option<Program<'info, Token>>,

    pub system_program: Program<'info, System>,

    // === Batch 3 completion bonds — REQUIRED + canonical-PDA-pinned (2026-07 swarm) ===
    // A quorum/attestation completing accept is a SUCCESS — refund both bonds.
    // Required, not optional: this completing path previously settled NO bonds at
    // all, so a live worker/creator bond could be omitted into the terminal task
    // and stranded past close_task (the one gap in the F12/F5 hardening). The
    // caller passes the seeds-derived PDA even for an un-bonded task (an empty
    // system account); settle_completion_bond no-ops on it.
    /// CHECK: creator completion bond PDA, seeds-pinned; refunded by helper.
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
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, ValidateTaskResult<'info>>,
    approved: bool,
) -> Result<()> {
    // Settlement path: validating a submission resolves an in-flight, already-
    // escrowed task and settles payout. It must work while the protocol is paused
    // or the type is disabled (both gate ENTRY only — spec §7, Decision #4 "money
    // never locks"); a pause must not strand escrowed funds mid-settlement.
    check_version_compatible_for_exit(&ctx.accounts.protocol_config)?;
    let clock = Clock::get()?;

    require!(
        ctx.accounts.task.status == TaskStatus::PendingValidation,
        CoordinationError::TaskNotPendingValidation
    );
    require!(
        is_manual_validation_task(&ctx.accounts.task),
        CoordinationError::TaskValidationConfigRequired
    );
    ensure_validation_config(
        &ctx.accounts.task_validation_config,
        &ctx.accounts.task.key(),
        &ctx.accounts.task,
    )?;
    require!(
        ctx.accounts.task_submission.status == SubmissionStatus::Submitted,
        CoordinationError::SubmissionNotPending
    );

    let external_attestation =
        ctx.accounts.task_validation_config.mode == ValidationMode::ExternalAttestation;
    let (reviewer_agent_key, quorum) = match ctx.accounts.task_validation_config.mode {
        ValidationMode::ValidatorQuorum => {
            let validator_agent = ctx
                .accounts
                .validator_agent
                .as_mut()
                .ok_or(CoordinationError::ValidatorAgentRequired)?;
            let validator_agent_key = validator_agent.key();
            let validator_authority = validator_agent.authority;
            let validator_status = validator_agent.status;
            let validator_capabilities = validator_agent.capabilities;
            require!(
                validator_authority == ctx.accounts.reviewer.key(),
                CoordinationError::UnauthorizedAgent
            );
            require!(
                validator_status == AgentStatus::Active,
                CoordinationError::AgentNotActive
            );
            require!(
                (validator_capabilities & capability::VALIDATOR) == capability::VALIDATOR,
                CoordinationError::UnauthorizedTaskValidator
            );
            // Audit (2026-07 swarm): the VALIDATOR capability bit is self-asserted —
            // a worker could register sybil agents with the bit set and approve
            // their own submission for rent-level cost, draining the escrow with
            // zero capital at risk. Every quorum vote now requires the
            // anti-griefing stake floor (config.min_stake_for_dispute), so each
            // vote has real capital staked during review. This is friction, NOT
            // byzantine resistance (docs/DESIGN_DECISIONS.md D8).
            require!(
                validator_agent.stake >= ctx.accounts.protocol_config.min_stake_for_dispute,
                CoordinationError::UnauthorizedTaskValidator
            );
            require!(
                ctx.accounts.reviewer.key() != ctx.accounts.task.creator
                    && ctx.accounts.reviewer.key() != ctx.accounts.worker.authority
                    && validator_agent_key != ctx.accounts.worker.key(),
                CoordinationError::UnauthorizedTaskValidator
            );

            // A validator's registration stake is the only capital backing this
            // self-asserted role. Persist the vote time before returning so the
            // deregistration cooldown cannot be bypassed by voting, withdrawing
            // the same stake, and registering a fresh wallet for the next quorum
            // slot. `max` preserves a longer governance lock stored in this
            // layout-stable legacy field.
            validator_agent.last_vote_timestamp = validator_agent
                .last_vote_timestamp
                .max(clock.unix_timestamp);
            (
                validator_agent_key,
                ctx.accounts.task_validation_config.validator_quorum(),
            )
        }
        ValidationMode::ExternalAttestation => {
            let attestor_config = ctx
                .accounts
                .task_attestor_config
                .as_ref()
                .ok_or(CoordinationError::TaskAttestorConfigRequired)?;
            require!(
                attestor_config.task == ctx.accounts.task.key(),
                CoordinationError::TaskAttestorConfigRequired
            );
            require!(
                attestor_config.attestor == ctx.accounts.reviewer.key(),
                CoordinationError::InvalidAttestor
            );
            // Self-attestation guard (parity with the ValidatorQuorum branch above): the
            // attestor must be an INDEPENDENT third party, never the task creator or the
            // worker's authority — otherwise a party rubber-stamps its own completion and
            // drains escrow. Load-bearing here because worker.authority isn't known until
            // a worker is bound (configure runs pre-claim).
            require!(
                attestor_config.attestor != ctx.accounts.task.creator
                    && attestor_config.attestor != ctx.accounts.worker.authority,
                CoordinationError::InvalidAttestor
            );
            (Pubkey::default(), 1)
        }
        _ => return err!(CoordinationError::ValidationModeMismatch),
    };

    let vote = &mut ctx.accounts.task_validation_vote;
    if vote.submission != Pubkey::default() {
        require!(
            vote.submission == ctx.accounts.task_submission.key(),
            CoordinationError::TaskSubmissionRequired
        );
        require!(
            vote.submission_round != ctx.accounts.task_submission.submission_count,
            CoordinationError::ValidationAlreadyRecorded
        );
    }

    vote.submission = ctx.accounts.task_submission.key();
    vote.reviewer = ctx.accounts.reviewer.key();
    vote.reviewer_agent = reviewer_agent_key;
    vote.submission_round = ctx.accounts.task_submission.submission_count;
    vote.approved = approved;
    vote.voted_at = clock.unix_timestamp;
    vote.bump = ctx.bumps.task_validation_vote;

    let approval_count = if approved {
        let next = ctx
            .accounts
            .task_submission
            .approval_count()
            .checked_add(1)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        ctx.accounts.task_submission.set_approval_count(next);
        next
    } else {
        ctx.accounts.task_submission.approval_count()
    };
    let rejection_count = if approved {
        ctx.accounts.task_submission.rejection_count()
    } else {
        let next = ctx
            .accounts
            .task_submission
            .rejection_count()
            .checked_add(1)
            .ok_or(CoordinationError::ArithmeticOverflow)?;
        ctx.accounts.task_submission.set_rejection_count(next);
        next
    };

    emit!(TaskResultValidationRecorded {
        task: ctx.accounts.task.key(),
        claim: ctx.accounts.claim.key(),
        reviewer: ctx.accounts.reviewer.key(),
        reviewer_agent: reviewer_agent_key,
        approved,
        submission_count: ctx.accounts.task_submission.submission_count,
        approval_count,
        rejection_count,
        recorded_at: clock.unix_timestamp,
    });

    let reached_acceptance = approval_count >= quorum;
    let reached_rejection = rejection_count >= quorum;
    if !reached_acceptance && !reached_rejection {
        return Ok(());
    }

    if reached_acceptance {
        // A historical quorum/attestation config can still be attached to a
        // contest-aware Competitive task even though new configuration is disabled.
        // Apply the contest time/sole-submission partition explicitly: the generic
        // completing guard deliberately defers contest enforcement to this helper.
        validate_contest_accept_window(&ctx.accounts.task, clock.unix_timestamp)?;
        // Every other completing non-collaborative accept must likewise be sole-live.
        // Both checks run before counter mutation while this submission is counted.
        validate_completing_accept_sole_submission(&ctx.accounts.task)?;

        validate_task_dependency(
            ctx.accounts.task.as_ref(),
            ctx.remaining_accounts,
            ctx.program_id,
        )?;
        decrement_pending_submission_count(&mut ctx.accounts.task_validation_config)?;
        note_submission_left_review(&mut ctx.accounts.task)?;

        let bid_completion_meta = load_bid_task_completion_meta(
            ctx.accounts.task.as_ref(),
            &ctx.accounts.task.key(),
            ctx.accounts.claim.as_ref(),
            ctx.remaining_accounts,
        )?;
        let reward_amount_override = bid_completion_meta
            .as_ref()
            .map(|meta| meta.accepted_bid_price);
        let protocol_fee_bps = calculate_fee_with_reputation(
            ctx.accounts.task.protocol_fee_bps,
            ctx.accounts.worker.reputation,
        );

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

        ctx.accounts.claim.proof_hash = ctx.accounts.task_submission.proof_hash;
        ctx.accounts.claim.result_data = ctx.accounts.task_submission.result_data;
        ctx.accounts.claim.is_completed = true;
        ctx.accounts.claim.is_validated = true;
        ctx.accounts.claim.completed_at = clock.unix_timestamp;

        execute_completion_rewards(
            &mut ctx.accounts.task,
            &mut ctx.accounts.claim,
            &mut ctx.accounts.escrow,
            &mut ctx.accounts.worker,
            &mut ctx.accounts.protocol_config,
            &ctx.accounts.worker_authority.to_account_info(),
            &ctx.accounts.treasury.to_account_info(),
            &ctx.accounts.creator.to_account_info(),
            protocol_fee_bps,
            reward_amount_override,
            Some(ctx.accounts.task_submission.result_data),
            &clock,
            token_accounts,
            None, // operator leg: unreachable for hired tasks — configure_task_validation
            // rejects any live-HireRecord task (HiredTaskValidationUnsupported), so an
            // operator-bearing task can never reach Quorum/ExternalAttestation. The
            // hire-aware settlement paths are complete_task (Auto) and accept/auto_accept (CreatorReview).
            None, // referrer leg: same unreachability — a referred hire never reaches this path.
        )?;

        ctx.accounts.task_submission.status = SubmissionStatus::Accepted;
        ctx.accounts.task_submission.accepted_at = clock.unix_timestamp;
        ctx.accounts.task_submission.rejected_at = 0;
        ctx.accounts.task_submission.rejection_hash = [0u8; 32];
        if ctx.accounts.task.status != TaskStatus::Completed {
            sync_task_validation_status(
                &mut ctx.accounts.task,
                &ctx.accounts.task_validation_config,
            );
        }

        emit!(TaskResultAccepted {
            task: ctx.accounts.task.key(),
            claim: ctx.accounts.claim.key(),
            worker: ctx.accounts.worker.key(),
            accepted_by: ctx.accounts.reviewer.key(),
            accepted_at: clock.unix_timestamp,
        });

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
        // Batch 3 WS-CONTEST §1 (submission-rent return): the worker funded the
        // accepted TaskSubmission PDA — close it back to them at settle. The
        // REJECT branch below intentionally keeps the submission alive: quorum
        // resubmission rounds key TaskValidationVote replay protection on
        // `submission_count`, which a close-and-reinit would reset.
        ctx.accounts
            .task_submission
            .close(ctx.accounts.worker_authority.to_account_info())?;

        // Batch 3 §8 + 2026-07 swarm (F12/F5 parity): an accepted result means
        // nobody lost — refund BOTH completion bonds. Required + seeds-pinned
        // accounts, so a live bond can never be omitted into the Completed task
        // (this completing path previously settled NO bonds at all).
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
        // External attestation is a one-reviewer quorum, so reaching this branch
        // resolves the round immediately. Return the reviewer's vote-account rent
        // instead of leaving one permanent PDA per attestation. Validator-quorum
        // votes remain durable until that legacy round reaches its own cleanup rail.
        if external_attestation {
            ctx.accounts
                .task_validation_vote
                .close(ctx.accounts.reviewer.to_account_info())?;
        }
        return Ok(());
    }

    decrement_pending_submission_count(&mut ctx.accounts.task_validation_config)?;
    note_submission_left_review(&mut ctx.accounts.task)?;

    let claim_key = ctx.accounts.claim.key();
    let worker_key = ctx.accounts.claim.worker;
    ctx.accounts.claim.proof_hash = [0u8; 32];
    ctx.accounts.claim.result_data = [0u8; 64];
    ctx.accounts.claim.is_completed = false;
    ctx.accounts.claim.is_validated = false;
    ctx.accounts.claim.completed_at = 0;

    release_claim_slot(
        &mut ctx.accounts.task,
        &mut ctx.accounts.worker,
        clock.unix_timestamp,
    )?;

    ctx.accounts.task_submission.status = SubmissionStatus::Rejected;
    ctx.accounts.task_submission.accepted_at = 0;
    ctx.accounts.task_submission.rejected_at = clock.unix_timestamp;
    ctx.accounts.task_submission.rejection_hash = [0u8; 32];

    if ctx.accounts.task.task_type == crate::state::TaskType::BidExclusive {
        // Audit F-14: honor the Proof-dependency offset exactly like the accept paths.
        let offset = bid_settlement_offset(&ctx.accounts.task);
        require!(
            ctx.remaining_accounts.len()
                >= offset
                    .checked_add(3)
                    .ok_or(CoordinationError::ArithmeticOverflow)?,
            CoordinationError::BidSettlementAccountsRequired
        );

        let bid_book_info = remaining_account_at(
            ctx.remaining_accounts,
            offset,
            CoordinationError::BidSettlementAccountsRequired,
        )?;
        let accepted_bid_info = remaining_account_at(
            ctx.remaining_accounts,
            offset
                .checked_add(1)
                .ok_or(CoordinationError::ArithmeticOverflow)?,
            CoordinationError::BidSettlementAccountsRequired,
        )?;
        let bidder_market_state_info = remaining_account_at(
            ctx.remaining_accounts,
            offset
                .checked_add(2)
                .ok_or(CoordinationError::ArithmeticOverflow)?,
            CoordinationError::BidSettlementAccountsRequired,
        )?;

        settle_accepted_bid(
            &ctx.accounts.task.key(),
            ctx.accounts.claim.as_ref(),
            bid_book_info,
            accepted_bid_info,
            bidder_market_state_info,
            ctx.accounts.worker_authority.to_account_info(),
            None,
            clock.unix_timestamp,
            AcceptedBidBookDisposition::Reopen,
            AcceptedBidBondDisposition::Refund,
        )?;
    }

    sync_task_validation_status(&mut ctx.accounts.task, &ctx.accounts.task_validation_config);

    emit!(TaskResultRejected {
        task: ctx.accounts.task.key(),
        claim: claim_key,
        worker: worker_key,
        rejected_by: ctx.accounts.reviewer.key(),
        rejection_hash: [0u8; 32],
        rejected_at: clock.unix_timestamp,
    });

    // Rejection releases and closes the worker claim. Refund its completion
    // bond at that same boundary so a later task cancel/close never needs to
    // discover a bond belonging to a worker no longer recorded on the Task.
    #[cfg(not(feature = "mainnet-canary"))]
    settle_completion_bond(
        &ctx.accounts.worker_completion_bond.to_account_info(),
        &ctx.accounts.worker_authority.to_account_info(),
        &ctx.accounts.task.key(),
        CompletionBond::ROLE_WORKER,
        BondDisposition::Refund,
    )?;

    ctx.accounts
        .claim
        .close(ctx.accounts.worker_authority.to_account_info())?;

    // A rejected external attestation also resolves its one-vote round. Closing
    // the vote permits a later resubmission to initialize a fresh round while
    // refunding the attestor who paid this PDA's rent.
    if external_attestation {
        ctx.accounts
            .task_validation_vote
            .close(ctx.accounts.reviewer.to_account_info())?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use anchor_lang::prelude::Pubkey;
    use anchor_lang::ToAccountMetas;

    #[test]
    fn validator_agent_is_writable_so_votes_lock_registration_stake() {
        let validator_agent = Pubkey::new_unique();
        let accounts = crate::__client_accounts_validate_task_result::ValidateTaskResult {
            task: Pubkey::new_unique(),
            claim: Pubkey::new_unique(),
            escrow: Pubkey::new_unique(),
            task_validation_config: Pubkey::new_unique(),
            task_attestor_config: None,
            task_submission: Pubkey::new_unique(),
            task_validation_vote: Pubkey::new_unique(),
            worker: Pubkey::new_unique(),
            protocol_config: Pubkey::new_unique(),
            validator_agent: Some(validator_agent),
            treasury: Pubkey::new_unique(),
            creator: Pubkey::new_unique(),
            worker_authority: Pubkey::new_unique(),
            reviewer: Pubkey::new_unique(),
            token_escrow_ata: None,
            worker_token_account: None,
            treasury_token_account: None,
            reward_mint: None,
            token_program: None,
            system_program: Pubkey::new_unique(),
            #[cfg(not(feature = "mainnet-canary"))]
            creator_completion_bond: Pubkey::new_unique(),
            #[cfg(not(feature = "mainnet-canary"))]
            worker_completion_bond: Pubkey::new_unique(),
        };

        let validator_meta = accounts
            .to_account_metas(None)
            .into_iter()
            .find(|meta| meta.pubkey == validator_agent)
            .expect("validator agent meta should be present");

        assert!(
            validator_meta.is_writable,
            "validator votes must persist the deregistration stake lock"
        );
    }
}
