// Audit F-2: close_task must not brick the slash finalizers.
//
// Pre-fix: immediately after resolve_dispute the task met every close_task
// precondition (terminal, current_workers == 0, bonds settled). Destroying the
// Task PDA permanently bricked apply_dispute_slash AND apply_initiator_slash
// (both hard-required it): a creator could grief the defendant's stake-clearing
// (disputes_as_defendant never clears -> withdraw/deregister lock forever) or
// evade their own initiator slash by racing the permissionless crank.
//
// The fix (four parts): apply_initiator_slash no longer loads the Task at all;
// resolve_dispute keeps current_workers == 1 while a worker slash is pending
// (the deferred claim IS still open); apply_dispute_slash decrements it when it
// closes the claim; reclaim_terminal_claim refuses a slash-pending deferred
// claim when the bound dispute is supplied.
//
// Revert-sensitive: pre-fix, close_task succeeds right after a slash-pending
// resolve (the brick), and apply_initiator_slash fails once the Task is gone.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode, isClosed,
  freshWorld, hireIx, injectAgentStake,
  listingModV2Pda, taskModV2Pda, moderationBlockPda,
  BN, Keypair, SystemProgram,
} from "./harness.mjs";
import { Buffer } from "node:buffer";

async function assignResolver(w, resolver) {
  const [entry] = pda([enc("dispute_resolver"), resolver.publicKey.toBuffer()]);
  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .assignDisputeResolver(resolver.publicKey)
    .accounts({ protocolConfig: w.protocolPda, disputeResolver: entry, authority: w.admin.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.admin]), "assign_dispute_resolver");
  return entry;
}

// Hired task -> moderate/publish -> worker claims -> WORKER initiates a dispute
// (initiator == defendant == worker), with a slashable stake injected first.
async function setupWorkerDispute(w, { resolutionType, stake = 2_000_000 }) {
  const modProg = makeProgram(w.modAuth);
  const [listingMod] = listingModV2Pda(w.listing, w.specHash, w.modAuth.publicKey);
  if (isClosed(w.svm, listingMod)) {
    expectOk(send(w.svm, await modProg.methods
      .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
      .accounts({ moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
      .instruction(), [w.modAuth]), "listing-mod");
  }
  const taskId = id32();
  const { ix: hix, task, escrow, hireRecord } = await hireIx(w, { taskId, listingModeration: listingMod });
  expectOk(send(w.svm, hix, [w.buyer]), "hire");

  const jobHash = id32();
  const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "task-mod");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/f2", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "publish");
  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "claim");

  await injectAgentStake(w.svm, w.providerAgent, stake);

  const tid = decode(w.svm, "Task", task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [initRate] = pda([enc("authority_rate_limit"), w.provider.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .initiateDispute(arr(disputeId), arr(tid), arr(Buffer.alloc(32, 1)), resolutionType, "evidence")
    .accounts({ dispute, task, agent: w.providerAgent, authorityRateLimit: initRate, protocolConfig: w.protocolPda, initiatorClaim: claim, workerAgent: null, workerClaim: null, taskSubmission: null, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "worker initiates dispute");

  return { task, escrow, hireRecord, claim, dispute, jobSpec };
}

async function resolveIx(w, r, { resolver, resolverEntry, approve }) {
  const creatorBond = pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0];
  const workerBond = pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()])[0];
  return makeProgram(resolver).methods
    .resolveDispute(approve, arr(crypto.randomBytes(32)), "agenc://ruling/f2")
    .accounts({
      dispute: r.dispute, task: r.task, escrow: r.escrow, protocolConfig: w.protocolPda,
      authority: resolver.publicKey, resolverAssignment: resolverEntry, creator: w.buyer.publicKey,
      workerClaim: r.claim, worker: w.providerAgent, workerWallet: w.provider.publicKey,
      agentStats: null,
      hireRecord: r.hireRecord, disputeOperator: null, disputeReferrer: null, systemProgram: SystemProgram.programId,
      tokenEscrowAta: null, creatorTokenAccount: null, workerTokenAccountAta: null,
      treasuryTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: creatorBond, workerCompletionBond: workerBond, bondTreasury: w.admin.publicKey,
      // audit F-9 optional sweep accounts: omitted here (close_task fallback)
      taskSubmission: null, taskValidationConfig: null,
    })
    .instruction();
}

async function closeTaskIx(w, task, jobSpec, hireRecord) {
  const creatorBond = pda([enc("completion_bond"), task.toBuffer(), w.buyer.publicKey.toBuffer()])[0];
  return w.buyerProg.methods
    .closeTask()
    .accounts({ task, taskJobSpec: jobSpec ?? null, escrow: null, hireRecord, listing: w.listing, creatorCompletionBond: creatorBond, workerCompletionBond: null, authority: w.buyer.publicKey })
    .instruction();
}

test("F-2: close_task is blocked while a worker slash is pending, unblocked after the finalizer runs", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000 });
  const resolver = Keypair.generate();
  w.svm.airdrop(resolver.publicKey, BigInt(100e9));
  const resolverEntry = await assignResolver(w, resolver);

  // Worker-initiated Refund dispute, APPROVED -> the defendant worker LOSES:
  // worker_slash_pending -> claim close + counter decrement deferred at resolve.
  const r = await setupWorkerDispute(w, { resolutionType: 0 });
  expectOk(send(w.svm, await resolveIx(w, r, { resolver, resolverEntry, approve: true }), [resolver]), "resolve Refund (approve)");

  const t = decode(w.svm, "Task", r.task);
  assert.ok(t.status.Cancelled !== undefined, "task terminal (Cancelled) after Refund ruling");
  assert.equal(t.current_workers, 1, "current_workers stays 1 while the slash is pending (F-2)");
  assert.equal(decode(w.svm, "AgentRegistration", w.providerAgent).active_tasks, 1, "active_tasks stays 1 too — counters consistent on the deferred claim");
  assert.ok(!isClosed(w.svm, r.claim), "defendant claim kept open (deferred)");
  assert.equal(decode(w.svm, "AgentRegistration", w.providerAgent).disputes_as_defendant, 1, "defendant counter still pending");

  // (iv) reclaim_terminal_claim with the bound dispute supplied -> ClaimSlashPending.
  const [submission] = pda([enc("task_submission"), r.claim.toBuffer()]);
  expectFail(
    send(w.svm, await makeProgram(w.provider).methods
      .reclaimTerminalClaim()
      .accounts({
        authority: w.provider.publicKey, task: r.task, claim: r.claim, taskSubmission: submission,
        worker: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey,
        rentRecipient: w.provider.publicKey,
      })
      .remainingAccounts([{ pubkey: r.dispute, isSigner: false, isWritable: false }])
      .instruction(), [w.provider]),
    "ClaimSlashPending",
    "reclaim of a slash-pending deferred claim is refused",
  );

  // (i) close_task must FAIL while the finalizer is pending (the pre-fix brick).
  expectFail(
    send(w.svm, await closeTaskIx(w, r.task, r.jobSpec, r.hireRecord), [w.buyer]),
    "TaskNotClosable",
    "close_task blocked while a worker slash is pending",
  );
  assert.ok(!isClosed(w.svm, r.task), "Task PDA survives — finalizer not bricked");

  // The finalizer runs: stake slashed, counter cleared, current_workers freed.
  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .applyDisputeSlash()
    .accounts({
      dispute: r.dispute, task: r.task, workerClaim: r.claim, workerAgent: w.providerAgent,
      workerAuthority: w.provider.publicKey, protocolConfig: w.protocolPda, treasury: w.admin.publicKey,
      authority: w.admin.publicKey,
      escrow: null, tokenEscrowAta: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null,
      creator: null, // SOL task — the token-settlement rent recipient is unused
    })
    .instruction(), [w.admin]), "apply_dispute_slash finalizes");
  assert.equal(decode(w.svm, "AgentRegistration", w.providerAgent).disputes_as_defendant, 0, "defendant counter cleared");
  assert.ok(isClosed(w.svm, r.claim), "deferred claim closed by the finalizer");
  assert.equal(decode(w.svm, "Task", r.task).current_workers, 0, "current_workers freed by the finalizer");
  assert.equal(decode(w.svm, "AgentRegistration", w.providerAgent).active_tasks, 0, "active_tasks freed by the finalizer");

  // close_task now succeeds (expireBlockhash: the blocked attempt above was the
  // byte-identical tx — without a fresh blockhash its signature would be deduped).
  w.svm.expireBlockhash();
  expectOk(send(w.svm, await closeTaskIx(w, r.task, r.jobSpec, r.hireRecord), [w.buyer]), "close_task after finalization");
  assert.ok(isClosed(w.svm, r.task), "task PDA closed after finalization");
});

test("F-2: initiator-slash evasion is dead — apply_initiator_slash works after the Task PDA is destroyed", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000 });
  const resolver = Keypair.generate();
  w.svm.airdrop(resolver.publicKey, BigInt(100e9));
  const resolverEntry = await assignResolver(w, resolver);

  // Worker-initiated dispute, REJECTED -> the INITIATOR (worker) loses; the
  // defendant worker does NOT lose -> no worker-slash deferral at resolve.
  const r = await setupWorkerDispute(w, { resolutionType: 0 });
  expectOk(send(w.svm, await resolveIx(w, r, { resolver, resolverEntry, approve: false }), [resolver]), "resolve (reject) — initiator loses");
  assert.equal(decode(w.svm, "Task", r.task).current_workers, 0, "no worker-slash deferral -> current_workers == 0");
  assert.ok(isClosed(w.svm, r.claim), "claim closed at resolve (no deferral)");

  // The evasion play: close the Task BEFORE the permissionless initiator-slash crank.
  expectOk(send(w.svm, await closeTaskIx(w, r.task, r.jobSpec, r.hireRecord), [w.buyer]), "close_task before the crank (was the evasion)");
  assert.ok(isClosed(w.svm, r.task), "Task PDA destroyed");

  // The finalizer no longer loads the Task — it still slashes the lost initiator.
  const stakeBefore = Number(decode(w.svm, "AgentRegistration", w.providerAgent).stake);
  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .applyInitiatorSlash()
    .accounts({
      dispute: r.dispute, initiatorAgent: w.providerAgent,
      protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.admin.publicKey,
    })
    .instruction(), [w.admin]), "apply_initiator_slash with the Task gone");
  const stakeAfter = Number(decode(w.svm, "AgentRegistration", w.providerAgent).stake);
  assert.ok(stakeAfter < stakeBefore, `initiator slashed even after close_task (${stakeBefore} -> ${stakeAfter})`);
  assert.equal(decode(w.svm, "Dispute", r.dispute).initiator_slash_applied, true, "initiator slash recorded");
});
