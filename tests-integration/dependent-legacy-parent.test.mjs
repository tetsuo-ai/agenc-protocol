// Audit (2026-07 swarm) — create_dependent_task must accept LEGACY parents.
//
// The parent_task account was a typed Box<Account<Task>>: Anchor's typed load
// Borsh-deserializes the full Task (466B), which hard-fails on the live
// pre-migration parents (382B — Borsh tolerates trailing bytes but not missing
// ones), bricking create_dependent_task against every un-migrated parent.
// The account is now an UncheckedAccount, owner-checked and zero-pad
// deserialized in the handler (same pattern as validate_task_dependency), with
// the status/creator checks moved into the handler.
//
// Revert-sensitive: with the typed load restored, every test below fails —
// the happy path with AccountDeserialize, the negative paths with the wrong error.
//
// Legacy simulation mirrors marketplace.test.mjs: truncate a live 466B Task to
// the 382B legacy size (the first 374 field-bytes are the unchanged prefix).

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  PID, enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode,
  freshWorld,
  BN, SystemProgram,
} from "./harness.mjs";

const LEGACY_TASK_SIZE = 382;

function truncateToLegacy(w, task) {
  const full = w.svm.getAccount(task);
  const legacy = Buffer.from(full.data).subarray(0, LEGACY_TASK_SIZE);
  w.svm.setAccount(task, {
    lamports: Number(full.lamports),
    data: legacy,
    owner: PID,
    executable: false,
    rentEpoch: 0,
  });
  assert.equal(w.svm.getAccount(task).data.length, LEGACY_TASK_SIZE, "parent truncated to legacy size");
}

async function createParentTask(w, { reward = 1_000_000 } = {}) {
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(reward), 1, new BN(now + 3600), 0, null, 0, null, null, 0)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "parent:create_task");
  return { task, escrow };
}

function dependentIx(w, prog, authority, creatorAgent, parentTask) {
  const taskId = id32();
  const [task] = pda([enc("task"), authority.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), authority.publicKey.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  return prog.methods
    .createDependentTask(arr(taskId), new BN(1), arr(desc), new BN(1_000_000), 1, new BN(now + 3600), 0, null, 2, 0, null)
    .accounts({
      task, escrow, parentTask, protocolConfig: w.protocolPda, creatorAgent,
      authorityRateLimit: rateLimit, authority: authority.publicKey, creator: authority.publicKey,
      systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null,
      tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null,
    })
    .instruction()
    .then((ix) => ({ ix, task }));
}

test("create_dependent_task: a legacy 382B parent loads (zero-pad deserialize) and the dependent is created", async () => {
  const w = await freshWorld();
  const parent = await createParentTask(w);
  truncateToLegacy(w, parent.task);

  const { ix, task } = await dependentIx(w, w.buyerProg, w.buyer, w.buyerAgent, parent.task);
  expectOk(send(w.svm, ix, [w.buyer]), "dependent against a legacy parent");

  const dep = decode(w.svm, "Task", task);
  assert.equal(dep.depends_on.toBase58(), parent.task.toBase58(), "depends_on wired to the legacy parent");
  assert.ok(dep.dependency_type?.Ordering !== undefined, "dependency_type == Ordering (2)");
});

test("create_dependent_task: a Cancelled legacy parent is still rejected (ParentTaskCancelled)", async () => {
  const w = await freshWorld();
  const parent = await createParentTask(w);

  // Cancel the Open parent (creator, no claims — always legal), then truncate.
  expectOk(send(w.svm, await w.buyerProg.methods
    .cancelTask()
    .accounts({
      task: parent.task, escrow: parent.escrow, authority: w.buyer.publicKey, protocolConfig: w.protocolPda,
      systemProgram: SystemProgram.programId,
      tokenEscrowAta: null, creatorTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: pda([enc("completion_bond"), parent.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0],
      workerCompletionBond: pda([enc("completion_bond"), parent.task.toBuffer(), w.provider.publicKey.toBuffer()])[0],
      workerBondAuthority: w.provider.publicKey,
      creatorAgent: null, agentStats: null,
      treasury: null,
    })
    .instruction(), [w.buyer]), "cancel parent");
  assert.ok(decode(w.svm, "Task", parent.task).status.Cancelled !== undefined, "parent is Cancelled");
  truncateToLegacy(w, parent.task);

  // The status check moved from an account constraint into the handler — it must
  // still fire on the legacy-loaded parent (pre-fix this is the WRONG error:
  // the typed load fails with AccountDeserialize before the constraint runs).
  const { ix } = await dependentIx(w, w.buyerProg, w.buyer, w.buyerAgent, parent.task);
  expectFail(send(w.svm, ix, [w.buyer]), "ParentTaskCancelled", "cancelled legacy parent rejected");
});

test("create_dependent_task: another wallet's legacy parent is still rejected (UnauthorizedCreator)", async () => {
  const w = await freshWorld();
  const parent = await createParentTask(w); // buyer's task
  truncateToLegacy(w, parent.task);

  // The provider (a different, funded agent) tries to hang a dependent on the
  // buyer's parent — the #520 same-creator check must survive the handler move.
  const { ix } = await dependentIx(w, w.providerProg, w.provider, w.providerAgent, parent.task);
  expectFail(send(w.svm, ix, [w.provider]), "UnauthorizedCreator", "foreign legacy parent rejected");
});
