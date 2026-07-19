// Audit F-9: dispute exits sweep the defendant's TaskSubmission when supplied —
// decrementing the review counters and returning the worker's submission rent,
// instead of leaving both stranded on the terminal task (close_task was the only
// recovery, and it is creator-gated).
//
// Covers: resolve_dispute with the optional (task_submission,
// task_validation_config) trailing accounts on a manual task whose submission is
// still live at resolve time. The counter decrements fire ONLY because the
// submission is still Submitted (a bounced/accepted submission carries no debt).

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode, isClosed,
  freshWorld, injectAgentStake, configureTestMultisig,
  taskModV2Pda, moderationBlockPda,
  BN, Keypair, SystemProgram,
} from "./harness.mjs";
import { Buffer } from "node:buffer";

async function assignResolver(w, resolver) {
  const approvals = await configureTestMultisig(w);
  const [entry] = pda([enc("dispute_resolver"), resolver.publicKey.toBuffer()]);
  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .assignDisputeResolver(resolver.publicKey)
    .accounts({ protocolConfig: w.protocolPda, disputeResolver: entry, authority: w.admin.publicKey, systemProgram: SystemProgram.programId })
    .remainingAccounts(approvals.remainingAccounts)
    .instruction(), approvals.approvers), "assign_dispute_resolver");
  return entry;
}

// CreatorReview task -> moderate/publish -> worker claims + submits -> worker
// initiates a dispute on the PendingValidation task (initiator == defendant).
async function setupDisputedReview(w) {
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
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(4_000_000), 1, new BN(now + 3600), 0, null, 0, null, null, 0)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "create task");
  expectOk(send(w.svm, await w.buyerProg.methods
    .configureTaskValidation(1, new BN(3600), 0, null)
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
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/f9", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "publish");

  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, hireRecord, legacyListing: null,
      moderationBlock: moderationBlockPda(jobHash)[0], claim,
      protocolConfig: w.protocolPda, worker: w.providerAgent,
      authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "claim");
  const [submission] = pda([enc("task_submission"), claim.toBuffer()]);
  const desc2 = Buffer.alloc(64);
  desc2.set(crypto.randomBytes(32), 0);
  expectOk(send(w.svm, await w.providerProg.methods
    .submitTaskResult(arr(id32()), arr(desc2))
    .accounts({ task, claim, taskValidationConfig: validation, taskSubmission: submission, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "submit");

  // Preconditions: the submission is live, both counters read 1.
  assert.equal(decode(w.svm, "Task", task)._reserved[1], 1, "live_submissions == 1 after submit");
  assert.equal(decode(w.svm, "TaskValidationConfig", validation)._reserved[1], 1, "pending_submission_count == 1 after submit");

  await injectAgentStake(w.svm, w.providerAgent, 2_000_000);
  const tid = decode(w.svm, "Task", task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [initRate] = pda([enc("authority_rate_limit"), w.provider.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .initiateDispute(arr(disputeId), arr(tid), arr(Buffer.alloc(32, 1)), 0, "evidence")
    .accounts({ dispute, task, agent: w.providerAgent, authorityRateLimit: initRate, protocolConfig: w.protocolPda, initiatorClaim: claim, workerAgent: null, workerClaim: null, taskSubmission: submission, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "worker initiates dispute");

  return { task, escrow, validation, claim, submission, hireRecord, dispute };
}

test("F-9: resolve_dispute sweeps the defendant's live submission (counters + rent)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const resolver = Keypair.generate();
  w.svm.airdrop(resolver.publicKey, BigInt(100e9));
  const resolverEntry = await assignResolver(w, resolver);
  const r = await setupDisputedReview(w);

  const submissionRentBefore = Number(w.svm.getBalance(r.submission));
  const workerBefore = Number(w.svm.getBalance(w.provider.publicKey));
  const creatorBond = pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0];
  const workerBond = pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()])[0];

  // Approve the Refund (the defendant worker loses) WITH the sweep accounts.
  expectOk(send(w.svm, await makeProgram(resolver).methods
    .resolveDispute(true, arr(crypto.randomBytes(32)), "agenc://ruling/f9")
    .accounts({
      dispute: r.dispute, task: r.task, escrow: r.escrow, protocolConfig: w.protocolPda,
      authority: resolver.publicKey, resolverAssignment: resolverEntry, creator: w.buyer.publicKey,
      workerClaim: r.claim, worker: w.providerAgent, workerWallet: w.provider.publicKey,
      agentStats: null,
      hireRecord: r.hireRecord, disputeOperator: null, disputeReferrer: null, systemProgram: SystemProgram.programId,
      tokenEscrowAta: null, creatorTokenAccount: null, workerTokenAccountAta: null,
      treasuryTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: creatorBond, workerCompletionBond: workerBond, bondTreasury: w.admin.publicKey,
      taskSubmission: r.submission, taskValidationConfig: r.validation,
    })
    .instruction(), [resolver]), "resolve with the F-9 sweep accounts");

  // The submission is closed and its rent went to the WORKER (not the crank/creator).
  assert.ok(isClosed(w.svm, r.submission), "submission swept on resolve");
  const workerDelta = Number(w.svm.getBalance(w.provider.publicKey)) - workerBefore;
  assert.ok(workerDelta >= submissionRentBefore, `worker recovered the submission rent (${workerDelta} >= ${submissionRentBefore})`);

  // Both review counters are back to zero on the terminal task.
  assert.equal(decode(w.svm, "Task", r.task)._reserved[1], 0, "live_submissions swept to 0");
  assert.equal(decode(w.svm, "TaskValidationConfig", r.validation)._reserved[1], 0, "pending_submission_count swept to 0");
  assert.ok(decode(w.svm, "Task", r.task).status.Cancelled !== undefined, "task terminal (Cancelled)");
});

test("F-9: resolve_dispute refuses omitted mandatory submission evidence", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const resolver = Keypair.generate();
  w.svm.airdrop(resolver.publicKey, BigInt(100e9));
  const resolverEntry = await assignResolver(w, resolver);
  const r = await setupDisputedReview(w);

  const creatorBond = pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0];
  const workerBond = pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()])[0];
  expectFail(send(w.svm, await makeProgram(resolver).methods
    .resolveDispute(true, arr(crypto.randomBytes(32)), "agenc://ruling/f9b")
    .accounts({
      dispute: r.dispute, task: r.task, escrow: r.escrow, protocolConfig: w.protocolPda,
      authority: resolver.publicKey, resolverAssignment: resolverEntry, creator: w.buyer.publicKey,
      workerClaim: r.claim, worker: w.providerAgent, workerWallet: w.provider.publicKey,
      agentStats: null,
      hireRecord: r.hireRecord, disputeOperator: null, disputeReferrer: null, systemProgram: SystemProgram.programId,
      tokenEscrowAta: null, creatorTokenAccount: null, workerTokenAccountAta: null,
      treasuryTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: creatorBond, workerCompletionBond: workerBond, bondTreasury: w.admin.publicKey,
      taskSubmission: null, taskValidationConfig: null,
    })
    .instruction(), [resolver]), "TaskSubmissionRequired", "resolve without submission evidence fails closed");

  assert.ok(!isClosed(w.svm, r.submission), "submission remains live after rejected resolve");
  assert.ok(decode(w.svm, "Dispute", r.dispute).status.Active !== undefined, "dispute remains Active");
  assert.ok(decode(w.svm, "Task", r.task).status.Disputed !== undefined, "task remains Disputed");
});
