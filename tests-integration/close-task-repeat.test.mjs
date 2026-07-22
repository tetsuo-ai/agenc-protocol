// Revert-sensitive coverage for repeatable close_task cleanup.
//
// A terminal Task remains as the durable parent while callers reclaim auxiliary
// children in packet-sized batches. Later cleanup passes must accept already-
// swept fixed accounts, reclaim newly supplied children, and avoid decrementing
// a hired listing's capacity more than once.

import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  BN,
  SystemProgram,
  arr,
  decode,
  enc,
  expectOk,
  freshWorld,
  hireIx,
  id32,
  isClosed,
  listingModV2Pda,
  makeProgram,
  moderationBlockPda,
  pda,
  send,
  taskModV2Pda,
} from "./harness.mjs";

test("close_task reclaims omitted children on a later pass without double-decrementing listing capacity", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 2_000_000 });
  const modProg = makeProgram(w.modAuth);

  const [listingModeration] = listingModV2Pda(
    w.listing,
    w.specHash,
    w.modAuth.publicKey,
  );
  expectOk(
    send(
      w.svm,
      await modProg.methods
        .recordListingModeration(
          arr(w.specHash),
          0,
          0,
          new BN(0),
          arr(Buffer.alloc(32, 7)),
          arr(Buffer.alloc(32, 9)),
          new BN(0),
        )
        .accounts({
          moderationConfig: w.modCfg,
          listing: w.listing,
          listingModeration,
          moderator: w.modAuth.publicKey,
          moderationAttestor: null,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [w.modAuth],
    ),
    "record listing moderation",
  );

  const { ix, task, escrow, hireRecord, taskJobSpecHash } = await hireIx(w, {
    listingModeration,
  });
  expectOk(send(w.svm, ix, [w.buyer]), "hire");

  const [taskModeration] = taskModV2Pda(
    task,
    taskJobSpecHash,
    w.modAuth.publicKey,
  );
  const [taskJobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  expectOk(
    send(
      w.svm,
      await modProg.methods
        .recordTaskModeration(
          arr(taskJobSpecHash),
          0,
          0,
          new BN(0),
          arr(Buffer.alloc(32, 1)),
          arr(Buffer.alloc(32, 2)),
          new BN(0),
        )
        .accounts({
          moderationConfig: w.modCfg,
          task,
          taskModeration,
          moderator: w.modAuth.publicKey,
          moderationAttestor: null,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [w.modAuth],
    ),
    "record task moderation",
  );
  expectOk(
    send(
      w.svm,
      await w.buyerProg.methods
        .setTaskJobSpec(
          arr(taskJobSpecHash),
          "agenc://job-spec/sha256/repeat-close",
          w.modAuth.publicKey,
        )
        .accounts({
          protocolConfig: w.protocolPda,
          task,
          moderationConfig: w.modCfg,
          taskModeration,
          moderationAttestor: null,
          moderationBlock: moderationBlockPda(taskJobSpecHash)[0],
          taskJobSpec,
          creator: w.buyer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [w.buyer],
    ),
    "publish task job spec",
  );

  const creatorCompletionBond = pda([
    enc("completion_bond"),
    task.toBuffer(),
    w.buyer.publicKey.toBuffer(),
  ])[0];
  const workerCompletionBond = pda([
    enc("completion_bond"),
    task.toBuffer(),
    w.provider.publicKey.toBuffer(),
  ])[0];
  expectOk(
    send(
      w.svm,
      await w.buyerProg.methods
        .cancelTask()
        .accounts({
          task,
          escrow,
          authority: w.buyer.publicKey,
          protocolConfig: w.protocolPda,
          systemProgram: SystemProgram.programId,
          tokenEscrowAta: null,
          creatorTokenAccount: null,
          rewardMint: null,
          tokenProgram: null,
          creatorCompletionBond,
          workerCompletionBond,
          workerBondAuthority: w.provider.publicKey,
          creatorAgent: null,
          agentStats: null,
          treasury: null,
        })
        .instruction(),
      [w.buyer],
    ),
    "cancel hired task",
  );

  assert.equal(decode(w.svm, "ServiceListing", w.listing).open_jobs, 1);
  assert.ok(!isClosed(w.svm, taskJobSpec), "job spec exists before cleanup");
  assert.ok(
    !isClosed(w.svm, taskModeration),
    "moderation exists before cleanup",
  );

  const firstClose = await w.buyerProg.methods
    .closeTask()
    .accounts({
      task,
      taskJobSpec,
      escrow: null,
      hireRecord,
      listing: w.listing,
      creatorCompletionBond,
      workerCompletionBond: null,
      authority: w.buyer.publicKey,
    })
    .instruction();
  expectOk(send(w.svm, firstClose, [w.buyer]), "close_task batch one");

  assert.ok(!isClosed(w.svm, task), "terminal Task remains live");
  assert.ok(isClosed(w.svm, taskJobSpec), "first pass reclaims the job spec");
  assert.ok(
    !isClosed(w.svm, taskModeration),
    "child omitted from the first pass remains reachable",
  );
  assert.equal(
    decode(w.svm, "ServiceListing", w.listing).open_jobs,
    0,
    "first pass frees listing capacity",
  );

  const secondClose = await w.buyerProg.methods
    .closeTask()
    .accounts({
      task,
      taskJobSpec: null,
      escrow: null,
      hireRecord,
      listing: null,
      creatorCompletionBond,
      workerCompletionBond: null,
      authority: w.buyer.publicKey,
    })
    .remainingAccounts([
      { pubkey: taskModeration, isSigner: false, isWritable: true },
      { pubkey: w.modAuth.publicKey, isSigner: false, isWritable: true },
    ])
    .instruction();
  expectOk(send(w.svm, secondClose, [w.buyer]), "close_task batch two");

  assert.ok(isClosed(w.svm, taskModeration), "second pass reclaims the child");
  assert.ok(!isClosed(w.svm, task), "repeat cleanup retains the Task anchor");
  assert.equal(
    decode(w.svm, "ServiceListing", w.listing).open_jobs,
    0,
    "repeat cleanup does not double-decrement listing capacity",
  );
});
