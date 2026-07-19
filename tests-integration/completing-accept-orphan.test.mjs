// Audit F-3: completing-accept orphan gaps.
//
// (a) validate_task_result's accept branch had NO completing-accept sole-submission
// guard: a quorum/attestation completing accept could flip a task to Completed while
// a peer submission was still live, stranding the peer's claim with no exit. The
// guard now mirrors the CreatorReview accept paths.
//
// (b) A claim bounced via request_changes (submission Rejected, claim open) was
// stranded forever after a peer's completing accept: reclaim_terminal_claim demanded
// a provably-ABSENT submission PDA. It now also accepts a REJECTED submission as
// no-live-submission evidence (counters were already decremented at bounce time;
// only the worker's submission rent is recovered).
//
// Revert-sensitive: (a) passes the completing accept pre-fix; (b) the reclaim fails
// with ClaimReclaimRequiresNoSubmission pre-fix.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  enc, arr, pda, id32, coder,
  makeProgram, send, expectOk, expectFail, decode, isClosed,
  freshWorld, injectAgentStake, taskModV2Pda, moderationBlockPda,
  BN, Keypair, SystemProgram,
} from "./harness.mjs";
import { Buffer } from "node:buffer";

const CAP_COMPUTE = 1;
const CAP_VALIDATOR = 1 << 8;

async function registerAgent(w, capabilities) {
  const kp = Keypair.generate();
  w.svm.airdrop(kp.publicKey, BigInt(10e9));
  const prog = makeProgram(kp);
  const agentId = id32();
  const [agentPda] = pda([enc("agent"), agentId]);
  expectOk(send(w.svm, await prog.methods
    .registerAgent(arr(agentId), new BN(capabilities), "http://extra.test", null, new BN(0))
    .accounts({ agent: agentPda, protocolConfig: w.protocolPda, authority: kp.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [kp]), "register agent");
  return { kp, prog, agentPda };
}

async function setupManualTask(w, {
  mode = 1, reviewWindow = 3600, validatorQuorum = 0,
  reward = 2_000_000, maxWorkers = 1,
  taskType = maxWorkers === 1 ? 0 : 2,
  legacyMaxWorkers = null,
} = {}) {
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
    .createTask(arr(taskId), new BN(CAP_COMPUTE), arr(desc), new BN(reward), maxWorkers, new BN(now + 3600), taskType, null, 0, null, null, 0)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "manual:create_task");
  // New ValidatorQuorum entry is disabled. Create a valid CreatorReview config,
  // then inject mode 2 only to exercise the grandfathered settlement exit.
  expectOk(send(w.svm, await w.buyerProg.methods
    .configureTaskValidation(1, new BN(reviewWindow), 0, null)
    .accounts({ task, taskValidationConfig: validation, taskAttestorConfig: attestor, protocolConfig: w.protocolPda, hireRecord, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "manual:configure");
  if (mode === 2) {
    const account = w.svm.getAccount(validation);
    const config = coder.accounts.decode("TaskValidationConfig", Buffer.from(account.data));
    config.mode = { ValidatorQuorum: {} };
    config.review_window_secs = new BN(0);
    config._reserved[0] = validatorQuorum;
    const data = await coder.accounts.encode("TaskValidationConfig", config);
    w.svm.setAccount(validation, { ...account, data });
  }
  if (legacyMaxWorkers !== null) {
    const account = w.svm.getAccount(task);
    const legacyTask = coder.accounts.decode("Task", Buffer.from(account.data));
    legacyTask.max_workers = legacyMaxWorkers;
    const data = await coder.accounts.encode("Task", legacyTask);
    w.svm.setAccount(task, { ...account, data });
  }
  return { task, escrow, validation, attestor, hireRecord, reward };
}

// Moderate + publish ONE job spec for the task (subsequent workers claim against it).
async function publishJobSpec(w, task) {
  const modProg = makeProgram(w.modAuth);
  const jobHash = id32();
  const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "publish:mod");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/f3", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "publish:job-spec");
  return { jobSpec, jobHash };
}

async function claimOnly(w, { task, jobSpec, jobHash }, { prog, agentPda, kp }) {
  const [claim] = pda([enc("claim"), task.toBuffer(), agentPda.toBuffer()]);
  expectOk(send(w.svm, await prog.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec,
      hireRecord: pda([enc("hire"), task.toBuffer()])[0], legacyListing: null,
      moderationBlock: moderationBlockPda(jobHash)[0], claim,
      protocolConfig: w.protocolPda, worker: agentPda,
      authority: kp.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [kp]), "claim");
  return claim;
}

async function submitOnly(w, { task, validation }, { prog, agentPda, kp }, claim) {
  const [submission] = pda([enc("task_submission"), claim.toBuffer()]);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  expectOk(send(w.svm, await prog.methods
    .submitTaskResult(arr(id32()), arr(desc))
    .accounts({ task, claim, taskValidationConfig: validation, taskSubmission: submission, protocolConfig: w.protocolPda, worker: agentPda, authority: kp.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [kp]), "submit");
  return submission;
}

async function claimSubmit(w, m, worker) {
  const claim = await claimOnly(w, m, worker);
  const submission = await submitOnly(w, m, worker, claim);
  return { claim, submission };
}

async function validateIx(w, m, s, { validatorKp, validatorAgent, workerAgent, workerKp, approved }) {
  const [vote] = pda([enc("task_validation_vote"), s.submission.toBuffer(), validatorKp.publicKey.toBuffer()]);
  return makeProgram(validatorKp).methods
    .validateTaskResult(approved)
    .accounts({
      task: m.task, claim: s.claim, escrow: m.escrow, taskValidationConfig: m.validation,
      taskAttestorConfig: null, taskSubmission: s.submission, taskValidationVote: vote,
      worker: workerAgent, protocolConfig: w.protocolPda, validatorAgent,
      treasury: w.admin.publicKey, creator: w.buyer.publicKey, workerAuthority: workerKp.publicKey,
      reviewer: validatorKp.publicKey, tokenEscrowAta: null, workerTokenAccount: null,
      treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, systemProgram: SystemProgram.programId,
      // 2026-07 swarm: bonds are required + seeds-pinned on validate_task_result
      creatorCompletionBond: pda([enc("completion_bond"), m.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0],
      workerCompletionBond: pda([enc("completion_bond"), m.task.toBuffer(), workerKp.publicKey.toBuffer()])[0],
    })
    .instruction();
}

test("F-3a: a completing quorum accept is blocked while a peer submission is live, then settles after the peer is rejected", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const m = await setupManualTask(w, { mode: 2, validatorQuorum: 1, maxWorkers: 2 });
  Object.assign(m, await publishJobSpec(w, m.task));

  const a = { prog: w.providerProg, agentPda: w.providerAgent, kp: w.provider };
  const b = await registerAgent(w, CAP_COMPUTE);
  // Both workers claim while InProgress (claim_task rejects PendingValidation),
  // then both submit.
  const claimA = await claimOnly(w, m, a);
  const claimB = await claimOnly(w, m, b);
  const subA = await submitOnly(w, m, a, claimA);
  const subB = await submitOnly(w, m, b, claimB);
  const sA = { claim: claimA, submission: subA };
  const sB = { claim: claimB, submission: subB };
  assert.equal(decode(w.svm, "Task", m.task).live_submissions ?? 2, 2, "two live submissions");

  const v = await registerAgent(w, CAP_VALIDATOR);
  // 2026-07 swarm: quorum votes require the anti-griefing stake floor.
  await injectAgentStake(w.svm, v.agentPda, 100_000_000);

  // Completing accept on A while B is still live -> blocked (F-3a).
  expectFail(
    send(w.svm, await validateIx(w, m, sA, { validatorKp: v.kp, validatorAgent: v.agentPda, workerAgent: a.agentPda, workerKp: a.kp, approved: true }), [v.kp]),
    "ContestAcceptRequiresSoleLiveSubmission",
    "completing quorum accept with a live peer is blocked",
  );
  assert.ok(decode(w.svm, "Task", m.task).status.Completed === undefined, "task NOT completed by the blocked accept");

  // The peer exit path: quorum-reject B (its claim is closed by the reject branch).
  // expireBlockhash first: the retry of the identical accept tx below would otherwise
  // collide with the guard-blocked attempt's signature (litesvm AlreadyProcessed).
  w.svm.expireBlockhash();
  expectOk(
    send(w.svm, await validateIx(w, m, sB, { validatorKp: v.kp, validatorAgent: v.agentPda, workerAgent: b.agentPda, workerKp: b.kp, approved: false }), [v.kp]),
    "quorum-reject the peer",
  );
  assert.ok(isClosed(w.svm, sB.claim), "rejected peer's claim closed by the reject branch");

  // Now sole-live: the completing accept on A succeeds and pays.
  const aBefore = Number(w.svm.getBalance(a.kp.publicKey));
  w.svm.expireBlockhash();
  expectOk(
    send(w.svm, await validateIx(w, m, sA, { validatorKp: v.kp, validatorAgent: v.agentPda, workerAgent: a.agentPda, workerKp: a.kp, approved: true }), [v.kp]),
    "completing quorum accept once sole-live",
  );
  assert.ok(decode(w.svm, "Task", m.task).status.Completed !== undefined, "task Completed once sole-live");
  assert.ok(Number(w.svm.getBalance(a.kp.publicKey)) > aBefore, "worker A paid on the completing accept");
});

test("F-3b: a bounced claim stranded by a peer's completing accept is reclaimed via Rejected-submission evidence", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  // Model the pre-hardening Exclusive width that could have two live claims.
  // New creation rejects this shape, but the exit must remain safe for history.
  const m = await setupManualTask(w, { mode: 1, maxWorkers: 1, legacyMaxWorkers: 2 });
  Object.assign(m, await publishJobSpec(w, m.task));

  // A claims + submits; the creator bounces A (request_changes) — claim stays open,
  // submission Rejected, live_submissions back to 0.
  const a = { prog: w.providerProg, agentPda: w.providerAgent, kp: w.provider };
  const sA = await claimSubmit(w, m, a);
  expectOk(send(w.svm, await w.buyerProg.methods
    .requestChanges(arr(Buffer.alloc(32, 9)))
    .accounts({ task: m.task, claim: sA.claim, taskValidationConfig: m.validation, taskSubmission: sA.submission, protocolConfig: w.protocolPda, creator: w.buyer.publicKey })
    .instruction(), [w.buyer]), "bounce A via request_changes");
  assert.equal(decode(w.svm, "TaskSubmission", sA.submission).status.Rejected !== undefined, true, "A's submission bounced to Rejected");

  // B claims + submits; the creator accepts B (completing, sole live) -> Completed.
  const b = await registerAgent(w, CAP_COMPUTE);
  const sB = await claimSubmit(w, m, b);
  expectOk(send(w.svm, await w.buyerProg.methods
    .acceptTaskResult()
    .accounts({ task: m.task, claim: sB.claim, escrow: m.escrow, taskValidationConfig: m.validation, taskSubmission: sB.submission, worker: b.agentPda, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, creator: w.buyer.publicKey, workerAuthority: b.kp.publicKey, operator: null, referrer: null, hireRecord: null, creatorCompletionBond: null, workerCompletionBond: null, tokenEscrowAta: null, workerTokenAccount: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "accept B (completing, sole-live)");
  assert.ok(decode(w.svm, "Task", m.task).status.Completed !== undefined, "task Completed by B's accept");
  assert.equal(decode(w.svm, "Task", m.task).current_workers, 1, "A's bounced claim still counted");

  // A reclaims via the Rejected-submission evidence (pre-fix: ClaimReclaimRequiresNoSubmission).
  const aBefore = Number(w.svm.getBalance(a.kp.publicKey));
  expectOk(send(w.svm, await makeProgram(a.kp).methods
    .reclaimTerminalClaim()
    .accounts({
      authority: a.kp.publicKey, task: m.task, claim: sA.claim, taskSubmission: sA.submission,
      taskValidationConfig: null,
      worker: a.agentPda, protocolConfig: w.protocolPda, treasury: w.admin.publicKey,
      rentRecipient: a.kp.publicKey,
    })
    .instruction(), [a.kp]), "A reclaims the bounced claim");
  const aAfter = Number(w.svm.getBalance(a.kp.publicKey));
  assert.ok(aAfter > aBefore, "A recovered claim rent + submission rent");
  assert.ok(isClosed(w.svm, sA.claim), "A's claim closed");
  assert.ok(isClosed(w.svm, sA.submission), "A's bounced submission closed (rent returned)");
  assert.equal(decode(w.svm, "Task", m.task).current_workers, 0, "worker count freed");

  // close_task now works (the stranded claim no longer bricks it).
  const [creatorBondPda] = pda([enc("completion_bond"), m.task.toBuffer(), w.buyer.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.buyerProg.methods
    .closeTask()
    .accounts({ task: m.task, taskJobSpec: m.jobSpec, escrow: null, hireRecord: m.hireRecord, listing: null, creatorCompletionBond: creatorBondPda, workerCompletionBond: null, authority: w.buyer.publicKey })
    .instruction(), [w.buyer]), "close_task after reclaim");
  assert.ok(!isClosed(w.svm, m.task), "durable terminal Task anchor remains");
});
