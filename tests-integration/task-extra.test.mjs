// In-process litesvm integration tests for additional task-lifecycle instructions
// that are NOT covered by marketplace.test.mjs:
//
//   create_dependent_task   auto_accept_task_result   validate_task_result
//   claim_task              apply_initiator_slash
//
// Executes the COMPILED program (target/deploy/agenc_coordination.so) end-to-end.
// Helper code (manual-validation setup, agent registration, moderation/publish flow)
// is adapted from marketplace.test.mjs — those helpers are not exported, so the
// parts needed here are replicated locally per the test-suite convention.
//
// Run:  cd .. && node --test tests-integration/task-extra.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  coder, enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode, isClosed,
  injectAgentStake, freshWorld,
  BN, Keypair, SystemProgram,
} from "./harness.mjs";

// Capability bits (state.rs::capability). COMPUTE = 1<<0, VALIDATOR = 1<<8.
const CAP_COMPUTE = 1;
const CAP_VALIDATOR = 1 << 8;

// ---------------------------------------------------------------------------
// Shared local helpers (replicated from marketplace.test.mjs's private helpers)
// ---------------------------------------------------------------------------

/// Register a fresh, funded agent with the given capabilities. Returns
/// { kp, prog, agentPda }.
async function registerAgent(w, capabilities) {
  const kp = Keypair.generate();
  w.svm.airdrop(kp.publicKey, BigInt(10e9));
  const prog = makeProgram(kp);
  const agentId = id32();
  const [agentPda] = pda([enc("agent"), agentId]);
  expectOk(
    send(w.svm, await prog.methods
      .registerAgent(arr(agentId), new BN(capabilities), "http://extra.test", null, new BN(0))
      .accounts({ agent: agentPda, protocolConfig: w.protocolPda, authority: kp.publicKey, systemProgram: SystemProgram.programId })
      .instruction(), [kp]),
    "register agent",
  );
  return { kp, prog, agentPda };
}

/// Create + configure a manual-validation task (non-hired) by the buyer with an
/// explicit validation mode (1 = CreatorReview, 2 = ValidatorQuorum). Mirrors
/// marketplace.test.mjs::setupManualTask but exposes mode/quorum/reviewWindow.
async function setupManualTask(w, { mode = 1, reviewWindow = 3600, validatorQuorum = 0, reward = 2_000_000, capabilities = CAP_COMPUTE, taskType = 0, maxWorkers = 1 } = {}) {
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const [validation] = pda([enc("task_validation"), task.toBuffer()]);
  const [attestor] = pda([enc("task_attestor"), task.toBuffer()]);
  const [hireRecord] = pda([enc("hire"), task.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(capabilities), arr(desc), new BN(reward), maxWorkers, new BN(now + 3600), taskType, null, 0, null, null, 0)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "manual:create_task");
  // ValidatorQuorum / ExternalAttestation require review_window == 0; CreatorReview requires > 0.
  const rw = mode === 1 ? reviewWindow : 0;
  expectOk(send(w.svm, await w.buyerProg.methods
    .configureTaskValidation(mode, new BN(rw), validatorQuorum, null)
    .accounts({ task, taskValidationConfig: validation, taskAttestorConfig: attestor, protocolConfig: w.protocolPda, hireRecord, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "manual:configure");
  return { task, escrow, validation, attestor, reward };
}

/// Moderate + publish a job spec for a task, then have the given worker claim and
/// submit a result. Returns the claim/submission PDAs + reward. Requires a
/// moderation-enabled world. `workerProg`/`workerAgent`/`workerKp` default to the
/// provider (the freshWorld worker).
async function publishClaimSubmit(w, { task, validation }, { workerProg = w.providerProg, workerAgent = w.providerAgent, workerKp = w.provider } = {}) {
  const modProg = makeProgram(w.modAuth);
  const jobHash = id32();
  const [taskMod] = pda([enc("task_moderation"), task.toBuffer(), Buffer.from(jobHash)]);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "publish:mod");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/extra")
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "publish:job-spec");

  const [claim] = pda([enc("claim"), task.toBuffer(), workerAgent.toBuffer()]);
  expectOk(send(w.svm, await workerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: workerAgent, authority: workerKp.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [workerKp]), "publish:claim");

  const [submission] = pda([enc("task_submission"), claim.toBuffer()]);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  expectOk(send(w.svm, await workerProg.methods
    .submitTaskResult(arr(id32()), arr(desc))
    .accounts({ task, claim, taskValidationConfig: validation, taskSubmission: submission, protocolConfig: w.protocolPda, worker: workerAgent, authority: workerKp.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [workerKp]), "publish:submit");
  return { claim, submission, jobSpec };
}

// ===========================================================================
// create_dependent_task
// ===========================================================================

/// Create a plain parent task (Open) by the buyer that a dependent task can hang off.
async function createParentTask(w, { reward = 1_000_000, capabilities = CAP_COMPUTE } = {}) {
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(capabilities), arr(desc), new BN(reward), 1, new BN(now + 3600), 0, null, 0, null, null, 0)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "parent:create_task");
  return task;
}

/// Build (but don't send) a create_dependent_task instruction for the buyer.
async function dependentIx(w, parentTask, { dependencyType = 1, reward = 2_000_000, capabilities = CAP_COMPUTE, taskId = id32() } = {}) {
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  const ix = await w.buyerProg.methods
    .createDependentTask(arr(taskId), new BN(capabilities), arr(desc), new BN(reward), 1, new BN(now + 3600), 0, null, dependencyType, 0, null)
    .accounts({
      task, escrow, parentTask, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent,
      authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey,
      systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null,
      tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null,
    })
    .instruction();
  return { ix, task, escrow };
}

test("create_dependent_task: links to parent + funds escrow (Data dependency)", async () => {
  const w = await freshWorld({});
  const parent = await createParentTask(w);
  const reward = 2_000_000;
  const { ix, task, escrow } = await dependentIx(w, parent, { dependencyType: 1, reward });
  expectOk(send(w.svm, ix, [w.buyer]), "create_dependent_task");

  const t = decode(w.svm, "Task", task);
  assert.ok(t.depends_on !== null, "depends_on is set");
  assert.equal(t.depends_on.toBase58(), parent.toBase58(), "depends_on points at the parent task");
  assert.ok(t.dependency_type?.Data !== undefined, `dependency_type == Data (got ${JSON.stringify(t.dependency_type)})`);
  assert.equal(Number(t.reward_amount), reward, "reward_amount recorded on the task");

  const e = decode(w.svm, "TaskEscrow", escrow);
  assert.equal(Number(e.amount), reward, "escrow funded with the full reward");
  assert.ok(Number(w.svm.getBalance(escrow)) >= reward, "escrow account holds at least the reward in lamports");
});

test("create_dependent_task: zero reward is rejected (RewardTooSmall)", async () => {
  const w = await freshWorld({});
  const parent = await createParentTask(w);
  const { ix } = await dependentIx(w, parent, { dependencyType: 1, reward: 0 });
  expectFail(send(w.svm, ix, [w.buyer]), "RewardTooSmall", "zero-reward dependent task");
});

test("create_dependent_task: out-of-range dependency_type is rejected (InvalidDependencyType)", async () => {
  const w = await freshWorld({});
  const parent = await createParentTask(w);
  const { ix } = await dependentIx(w, parent, { dependencyType: 0 }); // valid range is 1..=3
  expectFail(send(w.svm, ix, [w.buyer]), "InvalidDependencyType", "dependency_type = 0");
});

// ===========================================================================
// claim_task  (plain claim — fail-closed stub)
// ===========================================================================
//
// NOTE: the on-chain `claim_task` handler is intentionally fail-closed: it ALWAYS
// returns CoordinationError::TaskJobSpecRequired (it cannot prove the worker saw
// the moderated immutable job spec). Workers must use claim_task_with_job_spec
// instead. There is therefore NO positive path that creates a claim PDA via the
// plain claim — the negative test below is the complete coverage of this ABI.

test("claim_task: plain claim is fail-closed and rejects (TaskJobSpecRequired)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  // A plain Open task the worker would try to claim without a job-spec pointer.
  const m = await setupManualTask(w, { mode: 1 });
  const [claim] = pda([enc("claim"), m.task.toBuffer(), w.providerAgent.toBuffer()]);
  expectFail(
    send(w.svm, await w.providerProg.methods
      .claimTask()
      .accounts({ task: m.task, claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
      .instruction(), [w.provider]),
    "TaskJobSpecRequired", "plain claim_task is fail-closed",
  );
  assert.ok(isClosed(w.svm, claim), "no claim PDA was created (tx reverted)");
});

// ===========================================================================
// auto_accept_task_result
// ===========================================================================

/// Drive a CreatorReview task to a pending submission, returning settlement handles.
async function setupAutoAccept(w, { reviewWindow = 3600 } = {}) {
  const m = await setupManualTask(w, { mode: 1, reviewWindow });
  const { claim, submission } = await publishClaimSubmit(w, m);
  return { ...m, claim, submission };
}

/// Build the auto_accept_task_result instruction (SOL task, no bonds/tokens).
async function autoAcceptIx(w, r, signerKp) {
  return makeProgram(signerKp).methods
    .autoAcceptTaskResult()
    .accounts({
      task: r.task, claim: r.claim, escrow: r.escrow, taskValidationConfig: r.validation,
      taskSubmission: r.submission, worker: w.providerAgent, protocolConfig: w.protocolPda,
      treasury: w.admin.publicKey, creator: w.buyer.publicKey, workerAuthority: w.provider.publicKey,
      operator: null, referrer: null, hireRecord: null,
      creatorCompletionBond: null, workerCompletionBond: null, authority: signerKp.publicKey,
      tokenEscrowAta: null, workerTokenAccount: null, treasuryTokenAccount: null,
      rewardMint: null, tokenProgram: null, systemProgram: SystemProgram.programId,
    })
    .instruction();
}

test("auto_accept_task_result: before the review window it is rejected (ReviewWindowNotElapsed)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await setupAutoAccept(w, { reviewWindow: 3600 });
  // Any signer may call it; the buyer (admin of nothing here) tries early.
  expectFail(send(w.svm, await autoAcceptIx(w, r, w.buyer), [w.buyer]), "ReviewWindowNotElapsed", "auto-accept before deadline");
});

test("auto_accept_task_result: after the window ANY signer settles and pays the worker", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const reviewWindow = 3600;
  const r = await setupAutoAccept(w, { reviewWindow });

  // warp clock past task_submission.review_deadline_at (submitted_at + reviewWindow).
  const c = w.svm.getClock();
  c.unixTimestamp = c.unixTimestamp + BigInt(reviewWindow + 10);
  w.svm.setClock(c);

  // A neutral, unrelated signer (not creator/worker) triggers the timeout settlement.
  const stranger = Keypair.generate();
  w.svm.airdrop(stranger.publicKey, BigInt(10e9));

  const workerBalBefore = Number(w.svm.getBalance(w.provider.publicKey));
  expectOk(send(w.svm, await autoAcceptIx(w, r, stranger), [stranger]), "auto_accept after deadline");

  const t = decode(w.svm, "Task", r.task);
  assert.ok(t.status.Completed !== undefined, `task Completed after auto-accept (got ${JSON.stringify(t.status)})`);
  assert.ok(Number(w.svm.getBalance(w.provider.publicKey)) > workerBalBefore, "worker paid the reward on auto-accept");
  assert.ok(isClosed(w.svm, r.claim), "claim closed on auto-accept");
  assert.ok(isClosed(w.svm, r.escrow), "escrow closed on auto-accept");
});

// ===========================================================================
// validate_task_result  (ValidatorQuorum mode)
// ===========================================================================

/// Build a validate_task_result instruction signed by a validator agent.
async function validateIx(w, r, { validatorKp, validatorAgent, approved = true }) {
  const [vote] = pda([enc("task_validation_vote"), r.submission.toBuffer(), validatorKp.publicKey.toBuffer()]);
  return makeProgram(validatorKp).methods
    .validateTaskResult(approved)
    .accounts({
      task: r.task, claim: r.claim, escrow: r.escrow, taskValidationConfig: r.validation,
      taskAttestorConfig: null, taskSubmission: r.submission, taskValidationVote: vote,
      worker: w.providerAgent, protocolConfig: w.protocolPda, validatorAgent,
      treasury: w.admin.publicKey, creator: w.buyer.publicKey, workerAuthority: w.provider.publicKey,
      reviewer: validatorKp.publicKey, tokenEscrowAta: null, workerTokenAccount: null,
      treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, systemProgram: SystemProgram.programId,
    })
    .instruction();
}

test("validate_task_result: validator quorum approvals pay the worker", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const quorum = 2;
  const m = await setupManualTask(w, { mode: 2, validatorQuorum: quorum });
  const { claim, submission } = await publishClaimSubmit(w, m);
  const r = { ...m, claim, submission };

  // Two distinct validator agents that hold the VALIDATOR capability bit.
  const v1 = await registerAgent(w, CAP_VALIDATOR);
  const v2 = await registerAgent(w, CAP_VALIDATOR);

  const workerBalBefore = Number(w.svm.getBalance(w.provider.publicKey));

  // First approval: below quorum, settlement does not fire yet.
  expectOk(send(w.svm, await validateIx(w, r, { validatorKp: v1.kp, validatorAgent: v1.agentPda, approved: true }), [v1.kp]), "validate vote #1");
  assert.ok(decode(w.svm, "Task", r.task).status.Completed === undefined, "task not yet completed below quorum");

  // Second approval: reaches quorum -> worker paid, claim closed.
  expectOk(send(w.svm, await validateIx(w, r, { validatorKp: v2.kp, validatorAgent: v2.agentPda, approved: true }), [v2.kp]), "validate vote #2");

  const t = decode(w.svm, "Task", r.task);
  assert.ok(t.status.Completed !== undefined, `task Completed at quorum (got ${JSON.stringify(t.status)})`);
  assert.ok(Number(w.svm.getBalance(w.provider.publicKey)) > workerBalBefore, "worker paid on quorum approval");
  assert.ok(isClosed(w.svm, r.claim), "claim closed on quorum settlement");
  assert.ok(isClosed(w.svm, r.escrow), "escrow closed on quorum settlement");
});

test("validate_task_result: an agent without the VALIDATOR capability is rejected (UnauthorizedTaskValidator)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const m = await setupManualTask(w, { mode: 2, validatorQuorum: 1 });
  const { claim, submission } = await publishClaimSubmit(w, m);
  const r = { ...m, claim, submission };

  // A registered agent WITHOUT the VALIDATOR bit (COMPUTE only) tries to validate.
  const notValidator = await registerAgent(w, CAP_COMPUTE);
  expectFail(
    send(w.svm, await validateIx(w, r, { validatorKp: notValidator.kp, validatorAgent: notValidator.agentPda, approved: true }), [notValidator.kp]),
    "UnauthorizedTaskValidator", "non-validator agent cannot validate",
  );
});

// ===========================================================================
// apply_initiator_slash
// ===========================================================================
//
// Slashing the dispute initiator requires a resolved/cancelled dispute the
// initiator LOST. The simplest deterministic loss is a CANCELLED dispute:
// cancel_dispute is treated as an admission of a frivolous dispute (always slash),
// requires no arbiter quorum, and is callable by the initiator before any votes.

/// Worker initiates a dispute on an in-progress task, gives the worker agent a
/// slashable stake, then cancels the dispute (-> DisputeStatus::Cancelled).
/// Returns the dispute PDA + initiator (worker) agent handles.
async function setupLostDispute(w, { stake = 2_000_000 } = {}) {
  // Open + publish a manual task and have the worker claim it (claim is required
  // for the worker to be a dispute participant), but do NOT submit a result.
  const m = await setupManualTask(w, { mode: 1 });
  const modProg = makeProgram(w.modAuth);
  const jobHash = id32();
  const [taskMod] = pda([enc("task_moderation"), m.task.toBuffer(), Buffer.from(jobHash)]);
  const [jobSpec] = pda([enc("task_job_spec"), m.task.toBuffer()]);
  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task: m.task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "slash:mod");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/slash")
    .accounts({ protocolConfig: w.protocolPda, task: m.task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "slash:job-spec");
  const [claim] = pda([enc("claim"), m.task.toBuffer(), w.providerAgent.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task: m.task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "slash:claim");

  // Give the worker agent (the dispute initiator) a slashable stake.
  await injectAgentStake(w.svm, w.providerAgent, stake);

  // Worker opens a dispute (worker = initiator + defendant), then cancels it.
  const taskId = decode(w.svm, "Task", m.task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [initRate] = pda([enc("authority_rate_limit"), w.provider.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .initiateDispute(arr(disputeId), arr(taskId), arr(Buffer.alloc(32, 1)), 0, "evidence")
    .accounts({ dispute, task: m.task, agent: w.providerAgent, authorityRateLimit: initRate, protocolConfig: w.protocolPda, initiatorClaim: claim, workerAgent: null, workerClaim: null, taskSubmission: null, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "slash:initiate");

  // Cancel (no votes cast) -> DisputeStatus::Cancelled => initiator always loses.
  // cancel_dispute requires dispute.defendant as the single remaining account.
  expectOk(send(w.svm, await w.providerProg.methods
    .cancelDispute()
    .accounts({ protocolConfig: w.protocolPda, dispute, task: m.task, authority: w.provider.publicKey })
    .remainingAccounts([{ pubkey: w.providerAgent, isSigner: false, isWritable: true }])
    .instruction(), [w.provider]), "slash:cancel");

  return { dispute, task: m.task, initiatorAgent: w.providerAgent };
}

/// Build the apply_initiator_slash instruction.
async function applyInitiatorSlashIx(w, r, signerKp) {
  return makeProgram(signerKp).methods
    .applyInitiatorSlash()
    .accounts({
      dispute: r.dispute, task: r.task, initiatorAgent: r.initiatorAgent,
      protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: signerKp.publicKey,
    })
    .instruction();
}

test("apply_initiator_slash: a lost (cancelled) dispute slashes the initiator's stake", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const stake = 2_000_000;
  const r = await setupLostDispute(w, { stake });

  const stakeBefore = Number(decode(w.svm, "AgentRegistration", r.initiatorAgent).stake);
  assert.equal(stakeBefore, stake, "initiator stake set before slash");

  // Permissionless: anyone can apply the slash after an unfavorable resolution.
  const caller = Keypair.generate();
  w.svm.airdrop(caller.publicKey, BigInt(10e9));
  expectOk(send(w.svm, await applyInitiatorSlashIx(w, r, caller), [caller]), "apply_initiator_slash");

  const stakeAfter = Number(decode(w.svm, "AgentRegistration", r.initiatorAgent).stake);
  // slash_percentage = 50 (harness default) -> half the stake is removed.
  assert.ok(stakeAfter < stakeBefore, `initiator stake decreased (before ${stakeBefore}, after ${stakeAfter})`);
  assert.equal(stakeAfter, stakeBefore - Math.floor(stakeBefore * 0.5), "exactly slash_percentage (50%) removed");
  assert.equal(decode(w.svm, "Dispute", r.dispute).initiator_slash_applied, true, "dispute marked initiator_slash_applied");
});

test("apply_initiator_slash: applying the slash twice is rejected (SlashAlreadyApplied)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await setupLostDispute(w, { stake: 2_000_000 });

  const caller = Keypair.generate();
  w.svm.airdrop(caller.publicKey, BigInt(10e9));
  expectOk(send(w.svm, await applyInitiatorSlashIx(w, r, caller), [caller]), "apply_initiator_slash (first)");

  // A byte-identical retry is deduped by litesvm — expire the blockhash first.
  w.svm.expireBlockhash();
  expectFail(send(w.svm, await applyInitiatorSlashIx(w, r, caller), [caller]), "SlashAlreadyApplied", "second slash rejected");
});
