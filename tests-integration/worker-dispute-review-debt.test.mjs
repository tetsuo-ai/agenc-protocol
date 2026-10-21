// AGNC-03 regression: a worker cannot collect the reward for unreviewed work by
// self-disputing to freeze creator review while the review deadline runs, then
// canceling and auto-accepting in one transaction. cancel_dispute now
// accumulates the disputed duration as task-level review-clock debt
// (TaskValidationConfig reserved bytes) and auto_accept_task_result waits for
// deadline + debt, so the creator regains the frozen review time. Derived from
// the reporter's PoC (control preserved).
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  PID, coder, enc, arr, pda, id32,
  makeProgram, send, sendMany, expectOk, expectFail, decode, isClosed,
  freshWorld,
  taskModV2Pda, moderationBlockPda,
  BN, Keypair, SystemProgram,
} from "./harness.mjs";
import { Buffer } from "node:buffer";

const REWARD = 4_000_000;
const WORKER_STAKE = 2_000_000;
const SLASH_PERCENTAGE = 25;

async function setSlashPercentage(w, pct) {
  const acct = w.svm.getAccount(w.protocolPda);
  const cfg = coder.accounts.decode("ProtocolConfig", Buffer.from(acct.data));
  cfg.slash_percentage = pct;
  const data = await coder.accounts.encode("ProtocolConfig", cfg);
  w.svm.setAccount(w.protocolPda, { lamports: Number(acct.lamports), data, owner: PID, executable: false, rentEpoch: 0 });
}

async function fundStake(w, agentPda, amount) {
  const acct = w.svm.getAccount(agentPda);
  const data = Buffer.from(acct.data);
  const agent = coder.accounts.decode("AgentRegistration", data);
  agent.stake = new BN(amount);
  const encoded = await coder.accounts.encode("AgentRegistration", agent);
  encoded.copy(data, 0);
  w.svm.setAccount(agentPda, { ...acct, data, lamports: Number(acct.lamports) + amount });
}

async function setupClaimed(w, reviewWindow) {
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
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(REWARD), 1, new BN(now + 7 * 86_400), 0, null, 0, null, null, 0)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "create task");
  expectOk(send(w.svm, await w.buyerProg.methods
    .configureTaskValidation(1, new BN(reviewWindow), 0, null)
    .accounts({ task, taskValidationConfig: validation, taskAttestorConfig: attestor, protocolConfig: w.protocolPda, hireRecord, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "configure CreatorReview");

  const modProg = makeProgram(w.modAuth);
  const jobHash = id32();
  const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "task-mod");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/review", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "publish");

  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, hireRecord, legacyListing: null, moderationBlock: moderationBlockPda(jobHash)[0], claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "claim");
  const [submission] = pda([enc("task_submission"), claim.toBuffer()]);
  const submitIx = await w.providerProg.methods
    .submitTaskResult(arr(id32()), arr(Buffer.concat([Buffer.alloc(63), Buffer.from([9])])))
    .accounts({ task, claim, taskValidationConfig: validation, taskSubmission: submission, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction();
  return { task, escrow, validation, claim, submission, hireRecord, submitIx };
}

async function disputeIx(w, r) {
  const tid = decode(w.svm, "Task", r.task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [initRate] = pda([enc("authority_rate_limit"), w.provider.publicKey.toBuffer()]);
  const ix = await w.providerProg.methods
    .initiateDispute(arr(disputeId), arr(tid), arr(Buffer.alloc(32, 1)), 1, "evidence")
    .accounts({ dispute, task: r.task, agent: w.providerAgent, authorityRateLimit: initRate, protocolConfig: w.protocolPda, initiatorClaim: r.claim, workerAgent: null, workerClaim: null, taskSubmission: r.submission, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction();
  return { ix, dispute };
}

function rejectIx(w, r) {
  return w.buyerProg.methods
    .rejectTaskResult(arr(id32()))
    .accounts({ task: r.task, claim: r.claim, taskValidationConfig: r.validation, taskSubmission: r.submission, worker: w.providerAgent, protocolConfig: w.protocolPda, creator: w.buyer.publicKey, workerAuthority: w.provider.publicKey, agentStats: null, workerCompletionBond: null })
    .instruction();
}

function autoAcceptIx(w, r, signer) {
  return makeProgram(signer).methods
    .autoAcceptTaskResult()
    .accounts({
      task: r.task, claim: r.claim, escrow: r.escrow, taskValidationConfig: r.validation,
      taskSubmission: r.submission, worker: w.providerAgent, protocolConfig: w.protocolPda,
      treasury: w.admin.publicKey, creator: w.buyer.publicKey, workerAuthority: w.provider.publicKey,
      operator: null, referrer: null, hireRecord: r.hireRecord,
      creatorCompletionBond: null, workerCompletionBond: null, authority: signer.publicKey,
      tokenEscrowAta: null, workerTokenAccount: null, treasuryTokenAccount: null,
      rewardMint: null, tokenProgram: null, systemProgram: SystemProgram.programId,
    })
    .instruction();
}

function cancelDisputeIx(w, r, dispute) {
  return w.providerProg.methods
    .cancelDispute()
    .accounts({ protocolConfig: w.protocolPda, dispute, task: r.task, authority: w.provider.publicKey })
    .remainingAccounts([
      { pubkey: w.providerAgent, isSigner: false, isWritable: true },
      { pubkey: r.validation, isSigner: false, isWritable: true },
    ])
    .instruction();
}

function warp(w, secs) {
  const c = w.svm.getClock();
  c.unixTimestamp = c.unixTimestamp + BigInt(secs);
  w.svm.setClock(c);
  w.svm.expireBlockhash();
}

test("control: without a dispute the creator rejects worthless output inside the review window", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await setupClaimed(w, 3_600);
  expectOk(send(w.svm, r.submitIx, [w.provider]), "submit");
  warp(w, 3_600 - 60);
  expectOk(send(w.svm, await rejectIx(w, r), [w.buyer]), "creator rejects in time");
  assert.ok(decode(w.svm, "Task", r.task).status.Open !== undefined, "task reopened");
  assert.ok(!isClosed(w.svm, r.escrow), "escrow retained for the creator");
});

test("AGNC-03: self-dispute cannot freeze the creator out of review — cancel+auto-accept fails, creator rejects", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  await setSlashPercentage(w, SLASH_PERCENTAGE);
  await fundStake(w, w.providerAgent, WORKER_STAKE);
  const WINDOW = 3_600;
  const r = await setupClaimed(w, WINDOW);
  const d = await disputeIx(w, r);
  expectOk(sendMany(w.svm, [r.submitIx, d.ix], [w.provider]), "submit + dispute in one transaction");
  assert.ok(decode(w.svm, "Task", r.task).status.Disputed !== undefined, "task Disputed");

  warp(w, WINDOW + 200); // review deadline lapses while the dispute freezes review

  // The attack: cancel + auto-accept in one transaction. The cancel succeeds
  // and accumulates the disputed duration as review debt; the same-slot
  // auto-accept now fails because the effective deadline is deadline + debt.
  expectFail(sendMany(w.svm, [await cancelDisputeIx(w, r, d.dispute), await autoAcceptIx(w, r, w.provider)], [w.provider]),
    "ReviewWindowNotElapsed", "cancel + auto-accept in one transaction refused");

  expectOk(send(w.svm, await cancelDisputeIx(w, r, d.dispute), [w.provider]), "cancel alone succeeds");
  const cfg = decode(w.svm, "TaskValidationConfig", r.validation);
  const debt = Number(
    (cfg._reserved && Buffer.from(cfg._reserved).readUInt32LE(3)) ?? 0,
  );
  console.log("review debt after cancel:", debt, "secs (disputed duration ~", WINDOW + 200, ")");
  assert.ok(debt >= WINDOW, "disputed duration accumulated as review debt");

  // The creator regains the frozen review time and rejects the junk work.
  expectOk(send(w.svm, await rejectIx(w, r), [w.buyer]), "creator rejects after the freeze");
  assert.ok(decode(w.svm, "Task", r.task).status.Open !== undefined, "task reopened");
  assert.ok(!isClosed(w.svm, r.escrow), "escrow retained for the creator");

  // The rejected submission is no longer auto-acceptable at all, so the attack
  // surface is closed both by the debt and by the rejection itself.
});

test("AGNC-03: normal auto-accept timing is unchanged when no dispute ever happens", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const WINDOW = 3_600;
  const r = await setupClaimed(w, WINDOW);
  expectOk(send(w.svm, r.submitIx, [w.provider]), "submit");
  warp(w, WINDOW + 5);
  expectOk(send(w.svm, await autoAcceptIx(w, r, w.provider), [w.provider]), "auto-accept after the plain window");
  assert.ok(decode(w.svm, "Task", r.task).status.Completed !== undefined, "task Completed");
});

test("review debt cannot be bypassed by omitting or downgrading the config account", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  await fundStake(w, w.providerAgent, WORKER_STAKE);
  const r = await setupClaimed(w, 3_600);
  expectOk(send(w.svm, r.submitIx, [w.provider]), "submit");
  const d = await disputeIx(w, r);
  expectOk(send(w.svm, d.ix, [w.provider]), "dispute");
  warp(w, 100);
  const missing = await cancelDisputeIx(w, r, d.dispute);
  missing.keys.pop();
  expectFail(send(w.svm, missing, [w.provider]), "TaskValidationConfigRequired", "missing config refused");
  const readonly = await cancelDisputeIx(w, r, d.dispute);
  readonly.keys.at(-1).isWritable = false;
  expectFail(send(w.svm, readonly, [w.provider]), "TaskValidationConfigRequired", "readonly config refused");
  assert.ok(decode(w.svm, "Task", r.task).status.Disputed !== undefined, "failed cancels roll back");
  expectOk(send(w.svm, await cancelDisputeIx(w, r, d.dispute), [w.provider]), "writable cancellation");
  const cfg = decode(w.svm, "TaskValidationConfig", r.validation);
  assert.equal(Buffer.from(cfg._reserved).readUInt32LE(3), 100);
  // Exactly the paused duration is restored; acceptance becomes possible at
  // the effective deadline, rather than locking the worker out indefinitely.
  warp(w, 3_599);
  expectFail(send(w.svm, await autoAcceptIx(w, r, w.provider), [w.provider]), "ReviewWindowNotElapsed", "one second before effective deadline");
  warp(w, 1);
  expectOk(send(w.svm, await autoAcceptIx(w, r, w.provider), [w.provider]), "accept at effective deadline");
});
