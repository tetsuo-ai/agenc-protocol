// Regression: cancel_task safely closes worker TaskClaim PDAs on cancel.
//
// Locks in the verified-correct behavior in
//   programs/agenc-coordination/src/instructions/cancel_task.rs:353-419,456
// When an InProgress task with active worker claims is cancelled (only allowed
// past the deadline with completions == 0), cancel_task closes each worker's
// TaskClaim PDA by draining its lamports AND *tombstoning* it: data.fill(0)
// then the closed-account discriminator [255u8; 8] over the first 8 bytes. It
// also resets task.current_workers = 0. This prevents claim-PDA resurrection /
// re-init via init_if_needed after cancellation.
//
// To reach a cancellable InProgress task with a live claim we drive the shared
// runHireSettlement helper up to (and stopping at) the worker's claim, then warp
// the clock past the task deadline (hire sets deadline = now + listing
// default_deadline_secs = 3600s; freshWorld starts the clock at 1_700_000_000).

import test from "node:test";
import assert from "node:assert/strict";
import {
  freshWorld, makeProgram, send, expectOk, decode, isClosed,
  pda, enc, arr, id32, BN, SystemProgram,
  taskModV2Pda, listingModV2Pda, moderationBlockPda,
} from "./harness.mjs";
import { Buffer } from "node:buffer";

// runHireSettlement lives in marketplace.test.mjs, not the harness. Re-implement
// the minimal slice we need (hire -> moderate -> publish job spec -> claim) so a
// real TaskClaim PDA exists and task.current_workers == 1.
async function hireAndClaim(w) {
  const modProg = makeProgram(w.modAuth);

  const [listingMod] = listingModV2Pda(w.listing, w.specHash, w.modAuth.publicKey);
  if (isClosed(w.svm, listingMod)) {
    expectOk(send(w.svm, await modProg.methods
      .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
      .accounts({ moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
      .instruction(), [w.modAuth]), "record-listing-mod");
  }

  // buyer hires -> Open task + escrow + HireRecord (deadline = now + 3600).
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [hireRecord] = pda([enc("hire"), task.toBuffer()]);
  const [authorityRateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.buyerProg.methods
    .hireFromListing(arr(taskId), new BN(w.price), new BN(1), null, 0, w.modAuth.publicKey)
    .accounts({
      task, escrow, hireRecord, listing: w.listing, protocolConfig: w.protocolPda,
      moderationConfig: w.modCfg, listingModeration: listingMod, moderationAttestor: null,
      moderationBlock: moderationBlockPda(w.specHash)[0],
      creatorAgent: w.buyerAgent, authorityRateLimit, authority: w.buyer.publicKey,
      creator: w.buyer.publicKey, systemProgram: SystemProgram.programId,
    })
    .instruction(), [w.buyer]), "hire");

  // task moderation -> publish job spec -> worker claims.
  const jobHash = id32();
  const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);

  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "task-mod");

  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/x", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "publish job spec");

  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "claim");

  return { task, escrow, claim };
}

test("cancel_task tombstones a worker claim PDA and resets current_workers on an expired InProgress task", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000 });
  const { task, escrow, claim } = await hireAndClaim(w);

  // Precondition: a live claim PDA exists, task is InProgress with one worker.
  assert.ok(!isClosed(w.svm, claim), "claim PDA exists before cancel");
  const before = decode(w.svm, "Task", task);
  assert.ok(before.status.InProgress !== undefined, "task is InProgress before cancel");
  assert.equal(before.current_workers, 1, "current_workers == 1 before cancel");
  assert.ok(Number(before.deadline) > 0, "task has a deadline");

  // Warp the clock past the task deadline so an InProgress task with no
  // completions becomes cancellable (validate_cancel_prereqs).
  const c = w.svm.getClock();
  c.unixTimestamp = BigInt(before.deadline) + 100n;
  w.svm.setClock(c);

  // cancel_task: the worker triple is passed in remaining_accounts as
  //   (claim_account, worker_agent_account, worker_authority_rent_recipient)
  // per cancel_task.rs:333-334,364-366. claim + worker_agent + rent_recipient
  // are all writable; the rent recipient must equal worker.authority (== provider).
  expectOk(send(w.svm, await w.buyerProg.methods
    .cancelTask()
    .accounts({
      task, escrow, authority: w.buyer.publicKey, protocolConfig: w.protocolPda,
      systemProgram: SystemProgram.programId,
      tokenEscrowAta: null, creatorTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: pda([enc("completion_bond"), task.toBuffer(), w.buyer.publicKey.toBuffer()])[0], workerCompletionBond: pda([enc("completion_bond"), task.toBuffer(), w.provider.publicKey.toBuffer()])[0], workerBondAuthority: w.provider.publicKey,
      // P6.6 optional track-record accounts; omitted here (no creator-agent attribution).
      creatorAgent: null, agentStats: null,
      treasury: null,
    })
    .remainingAccounts([
      { pubkey: claim, isSigner: false, isWritable: true },              // claim_account
      { pubkey: w.providerAgent, isSigner: false, isWritable: true },    // worker_agent_account
      { pubkey: w.provider.publicKey, isSigner: false, isWritable: true }, // worker_authority (rent recipient)
    ])
    .instruction(), [w.buyer]), "cancel InProgress task with worker triple");

  // ASSERT 1: the claim account is closed (lamports drained / empty per harness isClosed).
  assert.ok(isClosed(w.svm, claim), "claim PDA closed after cancel");

  // ASSERT 2: the raw claim account's first 8 bytes are the tombstone [255,255,...].
  // Read raw bytes directly — decode() would error on a tombstoned account.
  const rawClaim = w.svm.getAccount(claim);
  assert.ok(rawClaim, "claim account still present (tombstoned, lamports drained)");
  const disc = Buffer.from(rawClaim.data.slice(0, 8));
  assert.deepEqual(arr(disc), arr(Buffer.alloc(8, 255)), "claim first 8 bytes are the closed-account discriminator [255u8; 8]");

  // ASSERT 3: current_workers reset to 0.
  const after = decode(w.svm, "Task", task);
  assert.equal(after.current_workers, 0, "current_workers reset to 0 after cancel");

  // ASSERT 4: task status is Cancelled.
  assert.ok(after.status.Cancelled !== undefined, `task status Cancelled (got ${JSON.stringify(after.status)})`);
});
