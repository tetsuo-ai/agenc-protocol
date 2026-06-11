// In-process litesvm regression tests locking in the Proof-type task DEPENDENCY
// GATE in agenc-coordination.
//
// BEHAVIOR UNDER TEST (verified correct):
//   A dependent task created with `dependency_type = Proof` (value 3) and
//   `depends_on = <parentTask>` can only be COMPLETED once the parent task has
//   reached `TaskStatus::Completed`. The gate is `validate_task_dependency`
//   (src/instructions/completion_helpers.rs:377-436): for the Proof variant it
//   requires the parent passed in `remaining_accounts[0]` (matching `depends_on`,
//   program-owned) to be `status == Completed`, else `ParentTaskNotCompleted`.
//   The gate fires at COMPLETION (complete_task.rs:194) — NOT at claim/submit.
//
// Executes the COMPILED program (target/deploy/agenc_coordination.so) end-to-end.
//
// Run:  cd .. && node --test tests-integration/dependent-proof.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode,
  freshWorld,
  BN, SystemProgram,
} from "./harness.mjs";

const CAP_COMPUTE = 1;

// ---------------------------------------------------------------------------
// Local helpers (adapted from marketplace.test.mjs / task-extra.test.mjs).
// ---------------------------------------------------------------------------

/// Create a plain Auto-mode parent task (Open) by the buyer. Returns its PDAs.
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
  return { task, escrow };
}

/// Create a dependent task (Auto mode) with the given dependency_type on `parentTask`.
/// dependencyType 3 = Proof. Returns the dependent's PDAs.
async function createDependentTask(w, parentTask, { dependencyType = 3, reward = 2_000_000, capabilities = CAP_COMPUTE } = {}) {
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  expectOk(send(w.svm, await w.buyerProg.methods
    .createDependentTask(arr(taskId), new BN(capabilities), arr(desc), new BN(reward), 1, new BN(now + 3600), 0, null, dependencyType, 0, null)
    .accounts({
      task, escrow, parentTask, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent,
      authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey,
      systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null,
      tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null,
    })
    .instruction(), [w.buyer]), "dependent:create_task");
  return { task, escrow };
}

/// Moderate (CLEAN) + publish a job spec for `task`, then have the provider agent
/// claim it. Returns the claim PDA. Requires a moderation-enabled world. The task
/// is left InProgress (claimed, no submit) so an Auto-mode complete_task can settle.
async function moderatePublishClaim(w, task, tag) {
  const modProg = makeProgram(w.modAuth);
  const jobHash = id32();
  const [taskMod] = pda([enc("task_moderation"), task.toBuffer(), Buffer.from(jobHash)]);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), `${tag}:mod`);
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), `agenc://job-spec/sha256/${tag}`)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), `${tag}:job-spec`);
  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), `${tag}:claim`);
  return { claim, jobSpec };
}

/// Build a complete_task instruction for `task`, optionally passing the parent task
/// in remaining_accounts (the Proof-gate input). hire_record is the empty ["hire",task]
/// PDA for a non-hired Auto task; operator/token/bond accounts are all null.
async function completeIx(w, { task, claim, escrow }, { parentTask = null } = {}) {
  const [hireRecord] = pda([enc("hire"), task.toBuffer()]);
  let m = w.providerProg.methods
    .completeTask(arr(id32()), null)
    .accounts({
      task, claim, escrow, creator: w.buyer.publicKey, worker: w.providerAgent,
      protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.provider.publicKey,
      systemProgram: SystemProgram.programId, tokenEscrowAta: null, workerTokenAccount: null,
      treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, hireRecord,
      operator: null, referrer: null, creatorCompletionBond: null, workerCompletionBond: null,
    });
  if (parentTask) {
    m = m.remainingAccounts([{ pubkey: parentTask, isSigner: false, isWritable: false }]);
  }
  return m.instruction();
}

/// Drive an Auto-mode task all the way to Completed (moderate -> publish -> claim ->
/// complete). Used to make a Proof parent satisfy the gate.
async function settleToCompleted(w, t, tag) {
  const { claim } = await moderatePublishClaim(w, t.task, tag);
  expectOk(send(w.svm, await completeIx(w, { task: t.task, claim, escrow: t.escrow }), [w.provider]), `${tag}:complete`);
  const decoded = decode(w.svm, "Task", t.task);
  assert.ok(decoded.status.Completed !== undefined, `${tag} parent should be Completed (got ${JSON.stringify(decoded.status)})`);
}

// ===========================================================================
// 1) NEGATIVE — Proof gate blocks completion while the parent is NOT completed.
// ===========================================================================

test("Proof dependency: completing the dependent is rejected while the parent is not Completed (ParentTaskNotCompleted)", async () => {
  const w = await freshWorld({ moderationEnabled: true });

  // Parent left Open/InProgress (NOT completed).
  const parent = await createParentTask(w);

  // Dependent task with dependency_type = Proof (3) on that parent.
  const dep = await createDependentTask(w, parent.task, { dependencyType: 3 });
  const depTask = decode(w.svm, "Task", dep.task);
  assert.ok(depTask.dependency_type?.Proof !== undefined, `dependent dependency_type == Proof (got ${JSON.stringify(depTask.dependency_type)})`);
  assert.equal(depTask.depends_on.toBase58(), parent.task.toBase58(), "depends_on points at the parent");

  // The gate is checked at COMPLETION, not at claim: the claim itself succeeds.
  const { claim } = await moderatePublishClaim(w, dep.task, "dep-neg");
  assert.ok(!isClaimMissing(w, claim), "claim PDA exists (gate is NOT enforced at claim time)");

  // Attempt to complete the dependent, passing the (still-Open) parent in
  // remaining_accounts -> the Proof gate rejects with ParentTaskNotCompleted.
  expectFail(
    send(w.svm, await completeIx(w, { task: dep.task, claim, escrow: dep.escrow }, { parentTask: parent.task }), [w.provider]),
    "ParentTaskNotCompleted", "complete Proof-dependent while parent open",
  );

  // The dependent was NOT settled (still InProgress).
  assert.ok(decode(w.svm, "Task", dep.task).status.InProgress !== undefined, "dependent stays InProgress after the rejected complete");
});

// ===========================================================================
// 2) POSITIVE — once the parent is Completed, the dependent can complete.
// ===========================================================================

test("Proof dependency: once the parent is Completed the dependent completes successfully", async () => {
  const w = await freshWorld({ moderationEnabled: true });

  const parent = await createParentTask(w);
  const dep = await createDependentTask(w, parent.task, { dependencyType: 3 });

  // Claim the dependent BEFORE the parent is done (allowed — gate is completion-time).
  const { claim } = await moderatePublishClaim(w, dep.task, "dep-pos");

  // Drive the parent to TaskStatus::Completed via the normal claim->complete flow.
  await settleToCompleted(w, parent, "parent");

  // Now completing the dependent, passing the now-Completed parent, SUCCEEDS.
  const workerBalBefore = Number(w.svm.getBalance(w.provider.publicKey));
  expectOk(
    send(w.svm, await completeIx(w, { task: dep.task, claim, escrow: dep.escrow }, { parentTask: parent.task }), [w.provider]),
    "complete Proof-dependent with completed parent",
  );

  const t = decode(w.svm, "Task", dep.task);
  assert.ok(t.status.Completed !== undefined, `dependent should be Completed (got ${JSON.stringify(t.status)})`);
  assert.ok(Number(w.svm.getBalance(w.provider.publicKey)) > workerBalBefore, "worker paid the dependent's reward on completion");
});

// Small local guard: a claim PDA created via claim_task_with_job_spec is live.
function isClaimMissing(w, address) {
  const acct = w.svm.getAccount(address);
  return !acct || Number(acct.lamports) === 0 || acct.data.length === 0;
}
