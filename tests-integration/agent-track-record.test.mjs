// In-process litesvm integration tests for the P6.6 AgentStats track-record counters.
//
// Executes the COMPILED program (target/deploy/agenc_coordination.so) end-to-end and
// drives three real lifecycles that each bump a different counter on the NEW
// `AgentStats` aggregate PDA (["agent_stats", agent]):
//   - reject_task_result  -> worker.tasks_rejected += 1
//   - cancel_task         -> creator_agent.total_cancelled += 1
//   - resolve_dispute      -> defendant.disputes_lost += 1  (worker loses)
//                          -> defendant.disputes_won  += 1  (worker prevails)
// and asserts the counter moved by exactly one, that the AgentStats account was created
// lazily on first write (it does not exist before the handler runs), and that the right
// agent's record is keyed.
//
// REVERT-SENSITIVE INTENT — each positive assertion pins exactly one increment added in
// programs/agenc-coordination/src/instructions/{reject_task_result,cancel_task,
// resolve_dispute}.rs via the shared agent_stats_helpers::apply_track_record:
//   - delete the `apply_track_record(... TasksRejected ...)` call in reject_task_result
//     -> the reject test's `tasks_rejected == 1` assertion goes red (stays 0 / no account).
//   - delete the `apply_track_record(... TotalCancelled ...)` call in cancel_task
//     -> the cancel test's `total_cancelled == 1` assertion goes red.
//   - delete the dispute-outcome `apply_track_record(...)` call in resolve_dispute
//     -> both dispute tests go red.
//   - swap `worker_lost` to always-`DisputesWon` -> the loss test (disputes_lost == 1)
//     goes red; swap to always-`DisputesLost` -> the win test goes red. (The two tests
//     are mutually exclusive on the `worker_lost` branch, so a constant choice fails one.)
// The "lazy init" assertions (account absent before, present after) additionally guard
// the init-on-first-write requirement: an implementation that forgot to create the PDA
// would leave it closed and the decode would fail.
//
// NOTE: requires the rebuilt .so + regenerated IDL (the integrator runs anchor build +
// artifacts:refresh before this test). It references the to-be-generated `agentStats`
// account key on each instruction's `.accounts({...})` and the `AgentStats` account
// decoder by their Codama naming-convention names.
//
// Run:  cd agenc-protocol && node --test tests-integration/agent-track-record.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  enc, arr, pda, id32,
  makeProgram, send, expectOk, decode, isClosed,
  freshWorld, hireIx,
  BN, Keypair, PublicKey, SystemProgram,
} from "./harness.mjs";

// Derive the AgentStats PDA for an agent ["agent_stats", agent].
function agentStatsPda(agent) {
  return pda([enc("agent_stats"), agent.toBuffer()])[0];
}

// Read AgentStats counters (or all-zero when the account does not exist yet).
function readStats(svm, statsPda) {
  if (isClosed(svm, statsPda)) {
    return { exists: false, tasks_rejected: 0n, disputes_won: 0n, disputes_lost: 0n, claims_expired: 0n, total_cancelled: 0n };
  }
  const s = decode(svm, "AgentStats", statsPda);
  return {
    exists: true,
    agent: s.agent,
    tasks_rejected: BigInt(s.tasks_rejected.toString()),
    disputes_won: BigInt(s.disputes_won.toString()),
    disputes_lost: BigInt(s.disputes_lost.toString()),
    claims_expired: BigInt(s.claims_expired.toString()),
    total_cancelled: BigInt(s.total_cancelled.toString()),
  };
}

// ---------------------------------------------------------------------------
// Helper: a non-hired CreatorReview task driven to a pending submission (ready
// for reject_task_result). Mirrors marketplace.test.mjs's setupSubmittedManual.
// ---------------------------------------------------------------------------
async function setupSubmittedManual(w) {
  const modProg = makeProgram(w.modAuth);
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const [validation] = pda([enc("task_validation"), task.toBuffer()]);
  const [attestor] = pda([enc("task_attestor"), task.toBuffer()]);
  const [hireRecord] = pda([enc("hire"), task.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64); desc.set(crypto.randomBytes(32), 0);

  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(2_000_000), 1, new BN(now + 3600), 0, null, 0, null, null, 0)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "trk:create_task");
  expectOk(send(w.svm, await w.buyerProg.methods
    .configureTaskValidation(1, new BN(3600), 0, null) // CreatorReview
    .accounts({ task, taskValidationConfig: validation, taskAttestorConfig: attestor, protocolConfig: w.protocolPda, hireRecord, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "trk:configure");

  const jobHash = id32();
  const [taskMod] = pda([enc("task_moderation"), task.toBuffer(), Buffer.from(jobHash)]);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "trk:task-mod");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/trk")
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "trk:publish");

  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "trk:claim");
  const [submission] = pda([enc("task_submission"), claim.toBuffer()]);
  const sdesc = Buffer.alloc(64); sdesc.set(crypto.randomBytes(32), 0);
  expectOk(send(w.svm, await w.providerProg.methods
    .submitTaskResult(arr(id32()), arr(sdesc))
    .accounts({ task, claim, taskValidationConfig: validation, taskSubmission: submission, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "trk:submit");

  return { task, escrow, validation, submission, claim };
}

// ---------------------------------------------------------------------------
// reject_task_result -> worker.tasks_rejected += 1 (lazy-created AgentStats).
// ---------------------------------------------------------------------------
test("track-record: reject_task_result bumps the worker's tasks_rejected (AgentStats lazily created)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const m = await setupSubmittedManual(w);

  const workerStats = agentStatsPda(w.providerAgent);
  assert.equal(isClosed(w.svm, workerStats), true, "AgentStats does not exist before the first negative outcome");

  expectOk(send(w.svm, await w.buyerProg.methods
    .rejectTaskResult(arr(id32()))
    .accounts({
      task: m.task, claim: m.claim, taskValidationConfig: m.validation, taskSubmission: m.submission,
      worker: w.providerAgent, protocolConfig: w.protocolPda, creator: w.buyer.publicKey,
      workerAuthority: w.provider.publicKey,
      // P6.6 optional track-record accounts:
      agentStats: workerStats, systemProgram: SystemProgram.programId,
    })
    .instruction(), [w.buyer]), "reject_task_result with agent_stats");

  const after = readStats(w.svm, workerStats);
  assert.equal(after.exists, true, "AgentStats created lazily on first write");
  assert.equal(after.agent.toBase58(), w.providerAgent.toBase58(), "AgentStats keyed to the worker agent");
  assert.equal(after.tasks_rejected, 1n, "worker.tasks_rejected == 1 after one reject");
  // Other counters untouched.
  assert.equal(after.disputes_lost, 0n, "disputes_lost untouched by a reject");
  assert.equal(after.total_cancelled, 0n, "total_cancelled untouched by a reject");
});

// ---------------------------------------------------------------------------
// cancel_task -> creator_agent.total_cancelled += 1 (lazy-created AgentStats).
// Cancels an Open task; the buyer is both the creator wallet AND a registered agent.
// ---------------------------------------------------------------------------
test("track-record: cancel_task bumps the creator agent's total_cancelled (AgentStats lazily created)", async () => {
  const w = await freshWorld({});
  // Create a plain Open task owned by the buyer (no worker, immediately cancellable).
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64); desc.set(crypto.randomBytes(32), 0);
  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(1_000_000), 1, new BN(now + 3600), 0, null, 0, null, null, 0)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "cancel-trk:create_task");

  const creatorStats = agentStatsPda(w.buyerAgent);
  assert.equal(isClosed(w.svm, creatorStats), true, "AgentStats absent before cancel");

  expectOk(send(w.svm, await w.buyerProg.methods
    .cancelTask()
    .accounts({
      task, escrow, authority: w.buyer.publicKey, protocolConfig: w.protocolPda, systemProgram: SystemProgram.programId,
      tokenEscrowAta: null, creatorTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: null, workerCompletionBond: null, workerBondAuthority: null,
      // P6.6 optional track-record accounts:
      creatorAgent: w.buyerAgent, agentStats: creatorStats,
    })
    .instruction(), [w.buyer]), "cancel_task with agent_stats");

  assert.ok(decode(w.svm, "Task", task).status.Cancelled !== undefined, "task Cancelled");
  const after = readStats(w.svm, creatorStats);
  assert.equal(after.exists, true, "AgentStats created lazily on cancel");
  assert.equal(after.agent.toBase58(), w.buyerAgent.toBase58(), "AgentStats keyed to the creator agent");
  assert.equal(after.total_cancelled, 1n, "creator.total_cancelled == 1 after one cancel");
  assert.equal(after.tasks_rejected, 0n, "tasks_rejected untouched by a cancel");
});

// ---------------------------------------------------------------------------
// Shared: drive a hired task to an Active dispute with a chosen resolution_type,
// then resolve it. Returns the handles + the defendant (worker) agent.
// resolution_type 0 (Refund) + approve=true  -> worker LOSES (disputes_lost).
// resolution_type 1 (Complete) + approve=true -> worker WINS  (disputes_won).
// ---------------------------------------------------------------------------
async function hireClaimDispute(w, { resolutionType }) {
  const modProg = makeProgram(w.modAuth);
  const [listingMod] = pda([enc("listing_moderation"), w.listing.toBuffer(), Buffer.from(w.specHash)]);
  if (isClosed(w.svm, listingMod)) {
    expectOk(send(w.svm, await modProg.methods
      .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
      .accounts({ moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
      .instruction(), [w.modAuth]), "disp-trk:listing-mod");
  }
  const taskId = id32();
  const { ix: hix, task, escrow, hireRecord } = await hireIx(w, { taskId, listingModeration: listingMod });
  expectOk(send(w.svm, hix, [w.buyer]), "disp-trk:hire");

  const jobHash = id32();
  const [taskMod] = pda([enc("task_moderation"), task.toBuffer(), Buffer.from(jobHash)]);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "disp-trk:task-mod");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/disp")
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "disp-trk:publish");
  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "disp-trk:claim");

  // worker (provider) opens a dispute requesting `resolutionType`.
  const tid = decode(w.svm, "Task", task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [initRate] = pda([enc("authority_rate_limit"), w.provider.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .initiateDispute(arr(disputeId), arr(tid), arr(Buffer.alloc(32, 1)), resolutionType, "evidence")
    .accounts({ dispute, task, agent: w.providerAgent, authorityRateLimit: initRate, protocolConfig: w.protocolPda, initiatorClaim: claim, workerAgent: null, workerClaim: null, taskSubmission: null, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "disp-trk:initiate");

  assert.ok(decode(w.svm, "Dispute", dispute).status.Active !== undefined, "dispute Active");
  return { task, escrow, hireRecord, claim, dispute };
}

// Resolve the dispute (protocol authority resolves directly) and attach the optional
// AgentStats account so the defendant's outcome counter is bumped.
async function resolveWithStats(w, r, approve) {
  const defendantStats = agentStatsPda(w.providerAgent);
  const creatorBond = pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0];
  const workerBond = pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()])[0];
  expectOk(send(w.svm, await makeProgram(w.admin).methods
    // P6.4: a reasoned ruling (rationale_hash + rationale_uri) is required on resolve.
    .resolveDispute(approve, arr(Buffer.alloc(32, 5)), "agenc://ruling/sha256/track-record")
    .accounts({
      dispute: r.dispute, task: r.task, escrow: r.escrow, protocolConfig: w.protocolPda,
      authority: w.admin.publicKey, resolverAssignment: null, creator: w.buyer.publicKey,
      workerClaim: r.claim, worker: w.providerAgent, workerWallet: w.provider.publicKey,
      hireRecord: r.hireRecord, disputeOperator: null, systemProgram: SystemProgram.programId,
      tokenEscrowAta: null, creatorTokenAccount: null, workerTokenAccountAta: null,
      treasuryTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: creatorBond, workerCompletionBond: workerBond, bondTreasury: w.admin.publicKey,
      // P6.6 optional track-record account:
      agentStats: defendantStats,
    })
    .instruction(), [w.admin]), "resolve_dispute with agent_stats");
  return defendantStats;
}

// resolution_type Refund (0) + approve -> worker LOSES -> disputes_lost += 1.
test("track-record: resolve_dispute (worker loses) bumps the defendant's disputes_lost", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 3_000_000 });
  const r = await hireClaimDispute(w, { resolutionType: 0 }); // Refund -> worker loses on approve

  const defendantStats = agentStatsPda(w.providerAgent);
  assert.equal(isClosed(w.svm, defendantStats), true, "AgentStats absent before dispute resolution");

  await resolveWithStats(w, r, true);

  assert.ok(decode(w.svm, "Dispute", r.dispute).status.Resolved !== undefined, "dispute Resolved");
  const after = readStats(w.svm, defendantStats);
  assert.equal(after.exists, true, "AgentStats created lazily on dispute resolution");
  assert.equal(after.agent.toBase58(), w.providerAgent.toBase58(), "AgentStats keyed to the defendant");
  assert.equal(after.disputes_lost, 1n, "defendant.disputes_lost == 1 (worker lost)");
  assert.equal(after.disputes_won, 0n, "disputes_won not bumped on a loss");
});

// resolution_type Complete (1) + approve -> worker WINS -> disputes_won += 1.
test("track-record: resolve_dispute (worker prevails) bumps the defendant's disputes_won", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 3_000_000 });
  const r = await hireClaimDispute(w, { resolutionType: 1 }); // Complete -> worker wins on approve

  const defendantStats = agentStatsPda(w.providerAgent);
  await resolveWithStats(w, r, true);

  const after = readStats(w.svm, defendantStats);
  assert.equal(after.exists, true, "AgentStats created lazily on dispute resolution");
  assert.equal(after.disputes_won, 1n, "defendant.disputes_won == 1 (worker prevailed)");
  assert.equal(after.disputes_lost, 0n, "disputes_lost not bumped on a win");
});

// ---------------------------------------------------------------------------
// Back-compat: omitting the optional accounts keeps the existing flow working and
// creates NO AgentStats (the counters are telemetry, not a settlement precondition).
// ---------------------------------------------------------------------------
test("track-record: cancel_task WITHOUT the optional accounts still works and writes no AgentStats", async () => {
  const w = await freshWorld({});
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64); desc.set(crypto.randomBytes(32), 0);
  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(1_000_000), 1, new BN(now + 3600), 0, null, 0, null, null, 0)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "nostats:create_task");

  expectOk(send(w.svm, await w.buyerProg.methods
    .cancelTask()
    .accounts({
      task, escrow, authority: w.buyer.publicKey, protocolConfig: w.protocolPda, systemProgram: SystemProgram.programId,
      tokenEscrowAta: null, creatorTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: null, workerCompletionBond: null, workerBondAuthority: null,
      // Optional track-record accounts omitted:
      creatorAgent: null, agentStats: null,
    })
    .instruction(), [w.buyer]), "cancel_task without agent_stats");

  assert.ok(decode(w.svm, "Task", task).status.Cancelled !== undefined, "task Cancelled without track-record accounts");
  assert.equal(isClosed(w.svm, agentStatsPda(w.buyerAgent)), true, "no AgentStats written when the optional accounts are omitted");
});
