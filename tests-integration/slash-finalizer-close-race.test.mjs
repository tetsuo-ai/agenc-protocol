// Audit F-2: close_task must not brick the slash finalizers.
//
// Pre-fix: immediately after resolve_dispute the task met every close_task
// precondition (terminal, current_workers == 0, bonds settled). Destroying the
// Task PDA permanently bricked apply_dispute_slash AND apply_initiator_slash
// (both hard-required it): a creator could grief the defendant's stake-clearing
// (disputes_as_defendant never clears -> withdraw/deregister lock forever) or
// evade their own initiator slash by racing the permissionless crank.
//
// The fix is layered: close_task retains the Task as a durable liveness anchor;
// apply_initiator_slash no longer loads it; resolve_dispute keeps
// current_workers == 1 while a worker slash is pending (the deferred claim IS
// still open); apply_dispute_slash decrements it when it closes the claim; and
// reclaim_terminal_claim refuses a slash-pending deferred claim.
//
// Revert-sensitive: pre-fix, close_task succeeds right after a slash-pending
// resolve (the brick), and the finalizers could then lose their required state.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  PID, coder, enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode, isClosed,
  freshWorld, injectAgentStake,
  taskModV2Pda, moderationBlockPda,
  BN, Keypair, SystemProgram,
} from "./harness.mjs";
import { Buffer } from "node:buffer";

async function mutateProgramAccount(w, address, accountName, mutate) {
  const account = w.svm.getAccount(address);
  assert.ok(account, `${accountName} account exists before mutation`);
  const value = coder.accounts.decode(accountName, Buffer.from(account.data));
  mutate(value);
  const data = await coder.accounts.encode(accountName, value);
  w.svm.setAccount(address, {
    lamports: Number(account.lamports),
    data,
    owner: PID,
    executable: false,
    rentEpoch: 0,
  });
}

async function assignResolver(w, resolver) {
  const [entry] = pda([enc("dispute_resolver"), resolver.publicKey.toBuffer()]);
  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .assignDisputeResolver(resolver.publicKey)
    .accounts({ protocolConfig: w.protocolPda, disputeResolver: entry, authority: w.admin.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.admin]), "assign_dispute_resolver");
  return entry;
}

// Direct reviewed task -> moderate/publish -> worker submits -> WORKER initiates a dispute
// (initiator == defendant == worker), with a slashable stake injected first.
async function setupWorkerDispute(w, { resolutionType, stake = 2_000_000 }) {
  const modProg = makeProgram(w.modAuth);
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [createRate] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const [hireRecord] = pda([enc("hire"), task.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const taskDescription = Buffer.alloc(64);
  taskDescription.set(crypto.randomBytes(32), 0);
  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(1), arr(taskDescription), new BN(4_000_000), 1,
      new BN(now + 3600), 0, null, 0, null, null, 0)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent,
      authorityRateLimit: createRate, authority: w.buyer.publicKey,
      creator: w.buyer.publicKey, systemProgram: SystemProgram.programId,
      rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null,
      tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "create direct task");

  // A worker may only initiate from a live submitted delivery. Configure the
  // hired task for CreatorReview so the submission remains pending and disputable.
  const [validation] = pda([enc("task_validation"), task.toBuffer()]);
  const [attestor] = pda([enc("task_attestor"), task.toBuffer()]);
  expectOk(send(w.svm, await w.buyerProg.methods
    .configureTaskValidation(1, new BN(3600), 0, null)
    .accounts({ task, taskValidationConfig: validation, taskAttestorConfig: attestor,
      protocolConfig: w.protocolPda, hireRecord, creator: w.buyer.publicKey,
      systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "configure CreatorReview");

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
    .accounts({ task, taskJobSpec: jobSpec, hireRecord, legacyListing: null,
      moderationBlock: moderationBlockPda(jobHash)[0], claim,
      protocolConfig: w.protocolPda, worker: w.providerAgent,
      authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "claim");

  const [submission] = pda([enc("task_submission"), claim.toBuffer()]);
  const resultDescription = Buffer.alloc(64);
  resultDescription.set(crypto.randomBytes(32), 0);
  expectOk(send(w.svm, await w.providerProg.methods
    .submitTaskResult(arr(id32()), arr(resultDescription))
    .accounts({ task, claim, taskValidationConfig: validation, taskSubmission: submission,
      protocolConfig: w.protocolPda, worker: w.providerAgent,
      authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "submit disputable delivery");

  await injectAgentStake(w.svm, w.providerAgent, stake);

  const tid = decode(w.svm, "Task", task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [initRate] = pda([enc("authority_rate_limit"), w.provider.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .initiateDispute(arr(disputeId), arr(tid), arr(Buffer.alloc(32, 1)), resolutionType, "evidence")
    .accounts({ dispute, task, agent: w.providerAgent, authorityRateLimit: initRate, protocolConfig: w.protocolPda, initiatorClaim: claim, workerAgent: null, workerClaim: null, taskSubmission: submission, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "worker initiates dispute");

  return { task, escrow, hireRecord, claim, submission, validation, dispute, jobSpec };
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
      // Mandatory live evidence also supplies the validation counter it owes.
      taskSubmission: r.submission,
      taskValidationConfig: r.validation,
    })
    .instruction();
}

async function closeTaskIx(w, task, jobSpec, hireRecord) {
  const creatorBond = pda([enc("completion_bond"), task.toBuffer(), w.buyer.publicKey.toBuffer()])[0];
  return w.buyerProg.methods
    .closeTask()
    .accounts({ task, taskJobSpec: jobSpec ?? null, escrow: null, hireRecord, listing: null, creatorCompletionBond: creatorBond, workerCompletionBond: null, authority: w.buyer.publicKey })
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

  // Omission-proof guard: even with NO dispute remaining account, the required
  // Task's durable pending bit protects the deferred claim.
  const [submission] = pda([enc("task_submission"), r.claim.toBuffer()]);
  expectFail(
    send(w.svm, await makeProgram(w.provider).methods
      .reclaimTerminalClaim()
      .accounts({
        authority: w.provider.publicKey, task: r.task, claim: r.claim, taskSubmission: submission,
        taskValidationConfig: null,
        worker: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey,
        rentRecipient: w.provider.publicKey,
      })
      .instruction(), [w.provider]),
    "ClaimSlashPending",
    "omitting the dispute cannot reclaim a slash-pending claim",
  );

  // Supplying the bound dispute is rejected identically.
  w.svm.expireBlockhash();
  expectFail(
    send(w.svm, await makeProgram(w.provider).methods
      .reclaimTerminalClaim()
      .accounts({
        authority: w.provider.publicKey, task: r.task, claim: r.claim, taskSubmission: submission,
        taskValidationConfig: null,
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

  // close_task cleanup now succeeds (expireBlockhash: the blocked attempt above
  // was byte-identical — without a fresh blockhash its signature would be deduped).
  w.svm.expireBlockhash();
  expectOk(send(w.svm, await closeTaskIx(w, r.task, r.jobSpec, r.hireRecord), [w.buyer]), "close_task after finalization");
  assert.ok(!isClosed(w.svm, r.task), "terminal task retained as a durable liveness anchor");
});

test("upgrade compatibility: deployed Refund state rejects generic reclaim and remains slash-finalizable", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000 });
  const resolver = Keypair.generate();
  w.svm.airdrop(resolver.publicKey, BigInt(100e9));
  const resolverEntry = await assignResolver(w, resolver);
  const r = await setupWorkerDispute(w, { resolutionType: 0, stake: 2_000_000 });
  expectOk(
    send(
      w.svm,
      await resolveIx(w, r, { resolver, resolverEntry, approve: true }),
      [resolver],
    ),
    "resolve Refund before deployed-state mutation",
  );

  // Reproduce the exact state written by deployed revision 097ded1: it had no
  // durable pending bit, zeroed current_workers at resolution, and decremented
  // active_tasks even though the losing claim remained live.
  await mutateProgramAccount(w, r.task, "Task", (task) => {
    task.current_workers = 0;
    task._reserved[2] = 0;
  });
  await mutateProgramAccount(w, w.providerAgent, "AgentRegistration", (worker) => {
    worker.active_tasks = 0;
  });
  assert.ok(!isClosed(w.svm, r.claim), "deployed pending claim remains live");
  assert.equal(decode(w.svm, "Task", r.task).current_workers, 0);
  assert.equal(decode(w.svm, "Task", r.task)._reserved[2], 0);
  assert.equal(
    decode(w.svm, "AgentRegistration", w.providerAgent).disputes_as_defendant,
    1,
    "deployed state still owns one defendant liability",
  );

  // The omission-proof compatibility guard must reserve this zero-worker live
  // claim for apply_dispute_slash. Generic reclaim previously erased the only
  // canonical claim evidence and made the historical penalty impossible.
  w.svm.expireBlockhash();
  expectFail(
    send(
      w.svm,
      await makeProgram(w.admin).methods
        .reclaimTerminalClaim()
        .accounts({
          authority: w.admin.publicKey,
          task: r.task,
          claim: r.claim,
          taskSubmission: r.submission,
          taskValidationConfig: null,
          worker: w.providerAgent,
          protocolConfig: w.protocolPda,
          treasury: w.admin.publicKey,
          rentRecipient: w.provider.publicKey,
        })
        .instruction(),
      [w.admin],
    ),
    "ClaimSlashPending",
    "generic reclaim cannot consume a deployed pending-slash claim",
  );

  // close_task may clean auxiliary children in this legacy zero-counter shape,
  // but it deliberately retains the Task tombstone. It therefore cannot destroy
  // either account required by the historical slash finalizer.
  w.svm.expireBlockhash();
  expectOk(
    send(
      w.svm,
      await closeTaskIx(w, r.task, r.jobSpec, r.hireRecord),
      [w.buyer],
    ),
    "legacy close_task cleanup retains finalizer anchor",
  );
  assert.ok(!isClosed(w.svm, r.task), "close_task retains the legacy Task anchor");
  assert.ok(!isClosed(w.svm, r.claim), "close_task cannot consume the legacy claim");

  const before = decode(w.svm, "AgentRegistration", w.providerAgent);
  w.svm.expireBlockhash();
  expectOk(
    send(
      w.svm,
      await makeProgram(w.admin).methods
        .applyDisputeSlash()
        .accounts({
          dispute: r.dispute,
          task: r.task,
          workerClaim: r.claim,
          workerAgent: w.providerAgent,
          workerAuthority: w.provider.publicKey,
          protocolConfig: w.protocolPda,
          treasury: w.admin.publicKey,
          authority: w.admin.publicKey,
          escrow: null,
          tokenEscrowAta: null,
          treasuryTokenAccount: null,
          rewardMint: null,
          tokenProgram: null,
          creator: null,
        })
        .instruction(),
      [w.admin],
    ),
    "finalize deployed Refund",
  );

  const after = decode(w.svm, "AgentRegistration", w.providerAgent);
  assert.ok(Number(after.stake) < Number(before.stake), "deployed Refund still applies its stake slash");
  assert.equal(after.disputes_as_defendant, 0, "deployed defendant liability released");
  assert.equal(after.active_tasks, 0, "deployed already-released activity counter stays zero");
  assert.ok(isClosed(w.svm, r.claim), "deployed pending claim closed by its finalizer");
  assert.equal(decode(w.svm, "Task", r.task).current_workers, 0);
  assert.equal(decode(w.svm, "Task", r.task)._reserved[2], 0);
});

test("F-2: initiator-slash evasion is dead after close_task cleanup", async () => {
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

  // Run terminal cleanup BEFORE the permissionless initiator-slash crank. The
  // task now remains as a durable anchor, and the crank also does not load it.
  expectOk(send(w.svm, await closeTaskIx(w, r.task, r.jobSpec, r.hireRecord), [w.buyer]), "close_task before the crank (was the evasion)");
  assert.ok(!isClosed(w.svm, r.task), "Task PDA retained after cleanup");

  // The finalizer still slashes the lost initiator after cleanup.
  const stakeBefore = Number(decode(w.svm, "AgentRegistration", w.providerAgent).stake);
  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .applyInitiatorSlash()
    .accounts({
      dispute: r.dispute, initiatorAgent: w.providerAgent,
      protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.admin.publicKey,
    })
    .instruction(), [w.admin]), "apply_initiator_slash after close_task cleanup");
  const stakeAfter = Number(decode(w.svm, "AgentRegistration", w.providerAgent).stake);
  assert.ok(stakeAfter < stakeBefore, `initiator slashed after close_task cleanup (${stakeBefore} -> ${stakeAfter})`);
  assert.equal(decode(w.svm, "Dispute", r.dispute).initiator_slash_applied, true, "initiator slash recorded");
  assert.equal(decode(w.svm, "AgentRegistration", w.providerAgent).active_dispute_votes, 0, "losing finalizer releases the pending initiator outcome");
});

test("initiator outcome finalizer releases an approved winner without penalty and rejects duplicates", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000 });
  const resolver = Keypair.generate();
  w.svm.airdrop(resolver.publicKey, BigInt(100e9));
  const resolverEntry = await assignResolver(w, resolver);

  // Worker proposes Complete and the resolver approves: the initiator wins.
  const r = await setupWorkerDispute(w, { resolutionType: 1, stake: 2_000_000 });
  assert.equal(decode(w.svm, "AgentRegistration", w.providerAgent).active_dispute_votes, 1, "new dispute increments the pending outcome count");
  expectOk(send(w.svm, await resolveIx(w, r, { resolver, resolverEntry, approve: true }), [resolver]), "resolve Complete (approve) — initiator wins");

  const before = decode(w.svm, "AgentRegistration", w.providerAgent);
  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .applyInitiatorSlash()
    .accounts({
      dispute: r.dispute, initiatorAgent: w.providerAgent,
      protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.admin.publicKey,
    })
    .instruction(), [w.admin]), "finalize approved initiator outcome");

  const after = decode(w.svm, "AgentRegistration", w.providerAgent);
  assert.equal(after.active_dispute_votes, 0, "winner's pending outcome released");
  assert.equal(after.stake.toString(), before.stake.toString(), "winner stake unchanged");
  assert.equal(after.reputation, before.reputation, "winner reputation unchanged");
  assert.equal(decode(w.svm, "Dispute", r.dispute).initiator_slash_applied, true, "winner outcome marked finalized");

  w.svm.expireBlockhash();
  expectFail(send(w.svm, await makeProgram(w.admin).methods
    .applyInitiatorSlash()
    .accounts({
      dispute: r.dispute, initiatorAgent: w.providerAgent,
      protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.admin.publicKey,
    })
    .instruction(), [w.admin]), "SlashAlreadyApplied", "duplicate winner finalizer rejected");
});

test("losing initiator with zero remaining stake still receives reputation and bookkeeping finalization", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000 });
  const resolver = Keypair.generate();
  w.svm.airdrop(resolver.publicKey, BigInt(100e9));
  const resolverEntry = await assignResolver(w, resolver);

  const r = await setupWorkerDispute(w, { resolutionType: 0, stake: 2_000_000 });
  expectOk(send(w.svm, await resolveIx(w, r, { resolver, resolverEntry, approve: false }), [resolver]), "resolve reject — initiator loses");

  // Model another penalty having exhausted the current stake before this
  // permissionless finalizer runs. Zero principal must not become a permanent
  // identity lock or skip the reputation consequence.
  await injectAgentStake(w.svm, w.providerAgent, 0);
  const reputationBefore = decode(w.svm, "AgentRegistration", w.providerAgent).reputation;
  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .applyInitiatorSlash()
    .accounts({
      dispute: r.dispute, initiatorAgent: w.providerAgent,
      protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.admin.publicKey,
    })
    .instruction(), [w.admin]), "zero-stake losing finalizer");

  const after = decode(w.svm, "AgentRegistration", w.providerAgent);
  assert.equal(after.stake.toString(), "0", "zero stake remains zero");
  assert.ok(after.reputation < reputationBefore, "losing reputation penalty still applied");
  assert.equal(after.active_dispute_votes, 0, "zero-stake loss releases the pending outcome");
  assert.equal(decode(w.svm, "Dispute", r.dispute).initiator_slash_applied, true, "zero-stake loss marked finalized");
});
