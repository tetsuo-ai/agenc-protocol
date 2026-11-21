// Revision 9 (C): cheaper kept cost per job. Design: REV9-DESIGN.md sections 3 and 11.3.
//
// close_task compacts a terminal Task in place into a 56-byte TaskMarker and gives
// the creator everything above the marker's rent. The marker keeps the task id
// taken, refuses new children, and stays the parent of every child an exit still
// needs: later close_task passes, reclaim_completion_bond, reclaim_orphan_task_child
// and the dependency checks of child tasks (review R1-6) all accept it. A
// moderation record returns its rent to whoever paid it.
//
// Executes the COMPILED program at mainnet's rent rate (5,080 lamports per byte, so
// a 466-byte Task holds 3,017,520 and a marker 934,720). Instructions are built from
// the IDL in target/idl, so the fed99ab comparison builds today's wire for the same
// calls; there close_task keeps the 466-byte Task and each test fails for the reason
// its title gives. The marker is read by its fixed layout and, once, through the
// coder generated from the committed revision 9 IDL.
//
// Run: node --test tests-integration/rev9-close-marker.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Rent } from "litesvm";
import {
  REPO, enc, arr, pda, id32, coder,
  makeProgram, send, expectOk, expectFail, decode, isClosed, findEvents,
  freshWorld, hireIx, mutateTask, listingModV2Pda, taskModV2Pda, moderationBlockPda,
  agentStatsPda, creatorStatsPda, disputeBondPda,
  readTaskMarker, TASK_MARKER_DISCRIMINATOR, MARKER_COMPLETED, MARKER_CANCELLED,
  MARKER_FLAG_ENDED_LIVE_HIRE, MARKER_FLAG_FEE_QUALIFIED,
  BorshCoder, BN, Keypair, PublicKey, SystemProgram,
} from "./harness.mjs";

const TX_FEE = 5_000n;
const MARKER_RENT = 934_720n; // (128 + 56) x 5,080
const TASK_RENT = 3_017_520n; // (128 + 466) x 5,080
const OLD_RATE_TASK = 4_134_240n; // (128 + 466) x 6,960, the rate 389 live tasks were funded at
const bal = (w, key) => BigInt(w.svm.getBalance(key) ?? 0n);
const completionBond = (task, wallet) => pda([enc("completion_bond"), task.toBuffer(), wallet.toBuffer()])[0];
const status = (w, task) => Object.keys(decode(w.svm, "Task", task).status)[0];

function warpTo(w, unixTimestamp) {
  const c = w.svm.getClock();
  c.unixTimestamp = BigInt(unixTimestamp);
  w.svm.setClock(c);
  w.svm.expireBlockhash();
}
const now = (w) => Number(w.svm.getClock().unixTimestamp);

async function world(opts = {}) {
  const w = await freshWorld({ moderationEnabled: true, ...opts });
  // Mainnet's rate: every account made from here on holds (128 + size) x 5,080.
  w.svm.setRent(new Rent(2_540n, 2.0, 50));
  assert.equal(BigInt(w.svm.minimumBalanceForRentExemption(56n)), MARKER_RENT, "mainnet marker rent");
  assert.equal(BigInt(w.svm.minimumBalanceForRentExemption(466n)), TASK_RENT, "mainnet Task rent");
  return w;
}

// ---------------------------------------------------------------------------
// Fixtures: an Auto-mode task made with create_task (or create_dependent_task),
// moderated, published, claimed and completed by the provider.
// ---------------------------------------------------------------------------
async function createAuto(w, { reward = 1_000_000, deadlineSecs = 3600, parent = null, dependencyType = 3 } = {}) {
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const t = {
    taskId, task,
    escrow: pda([enc("escrow"), task.toBuffer()])[0],
    hireRecord: pda([enc("hire"), task.toBuffer()])[0],
    validation: null,
    parent,
  };
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  const common = {
    task, escrow: t.escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent,
    authorityRateLimit: pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()])[0],
    authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId,
    rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null,
  };
  const ix = parent
    ? await w.buyerProg.methods
      .createDependentTask(arr(taskId), new BN(1), arr(desc), new BN(reward), 1, new BN(now(w) + deadlineSecs), 0, null, dependencyType, 0, null)
      .accounts({ ...common, parentTask: parent })
      .instruction()
    : await w.buyerProg.methods
      .createTask(arr(taskId), new BN(1), arr(desc), new BN(reward), 1, new BN(now(w) + deadlineSecs), 0, null, 0, null, null, 0)
      .accounts(common)
      .instruction();
  t.createResult = send(w.svm, ix, [w.buyer]);
  return t;
}

// Record a CLEAN moderation for `task`. The moderator signs and pays the fee; the
// rent comes from `rentPayer` (revision 9's appended account).
async function moderate(w, task, jobHash, { rentPayer = w.modAuth } = {}) {
  const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  const signers = rentPayer.publicKey.equals(w.modAuth.publicKey) ? [w.modAuth] : [w.modAuth, rentPayer];
  const res = send(w.svm, await makeProgram(w.modAuth).methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey,
      moderationAttestor: null, systemProgram: SystemProgram.programId, rentPayer: rentPayer.publicKey })
    .instruction(), signers);
  return { res, taskMod };
}

async function publish(w, t, { rentPayer, jobHash = id32() } = {}) {
  t.jobHash = jobHash;
  const { res, taskMod } = await moderate(w, t.task, t.jobHash, { rentPayer });
  expectOk(res, "cm:moderate");
  t.taskMod = taskMod;
  t.jobSpec = pda([enc("task_job_spec"), t.task.toBuffer()])[0];
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(t.jobHash), "agenc://job-spec/sha256/rev9-close-marker", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task: t.task, moderationConfig: w.modCfg, taskModeration: taskMod,
      moderationAttestor: null, moderationBlock: moderationBlockPda(t.jobHash)[0], taskJobSpec: t.jobSpec,
      creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "cm:publish");
}

const parentMeta = (t) => (t.parent ? [{ pubkey: t.parent, isSigner: false, isWritable: false }] : []);

async function claimIx(w, t) {
  t.claim = pda([enc("claim"), t.task.toBuffer(), w.providerAgent.toBuffer()])[0];
  t.submission = pda([enc("task_submission"), t.claim.toBuffer()])[0];
  return w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task: t.task, taskJobSpec: t.jobSpec, hireRecord: t.hireRecord, legacyListing: null,
      moderationBlock: moderationBlockPda(t.jobHash)[0], claim: t.claim, protocolConfig: w.protocolPda,
      worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId,
      workerStats: agentStatsPda(w.providerAgent) })
    .remainingAccounts(parentMeta(t))
    .instruction();
}

async function completeIx(w, t) {
  return w.providerProg.methods
    .completeTask(arr(id32()), null)
    .accounts({ task: t.task, claim: t.claim, escrow: t.escrow, creator: w.buyer.publicKey, worker: w.providerAgent,
      protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.provider.publicKey,
      systemProgram: SystemProgram.programId, tokenEscrowAta: null, workerTokenAccount: null,
      treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, hireRecord: t.hireRecord,
      operator: null, referrer: null, creatorCompletionBond: null, workerCompletionBond: null })
    .remainingAccounts(parentMeta(t))
    .instruction();
}

async function completedAuto(w, opts = {}) {
  const t = await createAuto(w, opts);
  expectOk(t.createResult, "cm:create");
  await publish(w, t, opts);
  expectOk(send(w.svm, await claimIx(w, t), [w.provider]), "cm:claim");
  expectOk(send(w.svm, await completeIx(w, t), [w.provider]), "cm:complete");
  assert.equal(status(w, t.task), "Completed");
  return t;
}

async function cancelledAuto(w, opts = {}) {
  const t = await createAuto(w, opts);
  expectOk(t.createResult, "cm:create");
  expectOk(send(w.svm, await w.buyerProg.methods
    .cancelTask()
    .accounts({ task: t.task, escrow: t.escrow, authority: w.buyer.publicKey, protocolConfig: w.protocolPda,
      systemProgram: SystemProgram.programId, tokenEscrowAta: null, creatorTokenAccount: null, rewardMint: null,
      tokenProgram: null, creatorCompletionBond: completionBond(t.task, w.buyer.publicKey),
      workerCompletionBond: completionBond(t.task, w.provider.publicKey), workerBondAuthority: w.provider.publicKey,
      creatorAgent: null, agentStats: null, treasury: null, creatorStats: creatorStatsPda(w.buyer.publicKey) })
    .instruction(), [w.buyer]), "cm:cancel");
  assert.equal(status(w, t.task), "Cancelled");
  return t;
}

async function closeIx(w, t, { signer = w.buyer, taskJobSpec = null, escrow = null, listing = null, remaining = [], workerBond = null, task = t.task } = {}) {
  return makeProgram(signer).methods
    .closeTask()
    .accounts({ task, taskJobSpec, escrow, hireRecord: pda([enc("hire"), task.toBuffer()])[0], listing,
      creatorCompletionBond: completionBond(task, signer.publicKey), workerCompletionBond: workerBond,
      authority: signer.publicKey, protocolConfig: null })
    .remainingAccounts(remaining)
    .instruction();
}

function assertMarker(w, task, { creator, statusByte, flags }) {
  const account = w.svm.getAccount(task);
  assert.ok(account, "an account stays at the task address");
  assert.equal(account.data.length, 56, "the Task was compacted to 56 bytes");
  assert.ok(Buffer.from(account.data).subarray(0, 8).equals(TASK_MARKER_DISCRIMINATOR), "TaskMarker discriminator");
  const marker = readTaskMarker(w.svm, task);
  assert.equal(marker.owner.toBase58(), new PublicKey(account.owner).toBase58());
  assert.equal(marker.lamports, MARKER_RENT, "the marker holds exactly its rent minimum");
  assert.equal(marker.creator.toBase58(), creator.toBase58());
  assert.equal(marker.status, statusByte);
  if (flags !== undefined) assert.equal(marker.flags, flags, "marker flags");
  assert.deepEqual([...marker.reserved], [0, 0, 0, 0, 0, 0]);
  return marker;
}

// ---------------------------------------------------------------------------
// 11.3 item 1. fed99ab: the 466-byte Task stays and only its surplus comes back.
// ---------------------------------------------------------------------------
test("rev9 close marker: close_task leaves a 56-byte TaskMarker and refunds the creator everything above its rent (fed99ab: the Task stays 466 bytes)", async () => {
  const w = await world();
  const t = await completedAuto(w);
  const taskLamports = bal(w, t.task);
  assert.equal(taskLamports, TASK_RENT, "a Task funded at today's rate");
  const feeQualified = decode(w.svm, "Task", t.task)._reserved[12] === 1;
  const before = bal(w, w.buyer.publicKey);

  const res = send(w.svm, await closeIx(w, t), [w.buyer]);
  expectOk(res, "close_task compacts");
  assert.equal(before - bal(w, w.buyer.publicKey), TX_FEE - (TASK_RENT - MARKER_RENT),
    "the creator got back 2,082,800 lamports (the Task minus the marker rent), less the fee");
  assertMarker(w, t.task, {
    creator: w.buyer.publicKey,
    statusByte: MARKER_COMPLETED,
    flags: feeQualified ? MARKER_FLAG_FEE_QUALIFIED : 0,
  });
  const [compacted] = findEvents(res, "TaskCompacted");
  assert.ok(compacted, "TaskCompacted emitted");
  assert.equal(compacted.task.toBase58(), t.task.toBase58());
  assert.equal(compacted.creator.toBase58(), w.buyer.publicKey.toBase58());
  assert.equal(compacted.status, MARKER_COMPLETED);
  assert.equal(BigInt(compacted.refunded_lamports.toString()), TASK_RENT - MARKER_RENT);
  assert.equal(BigInt(compacted.marker_lamports.toString()), MARKER_RENT);

  // The generated client coders decode the marker (committed revision 9 IDL).
  const committed = JSON.parse(fs.readFileSync(path.join(REPO, "artifacts/anchor/idl/agenc_coordination.json"), "utf8"));
  const decoded = new BorshCoder(committed).accounts.decode("TaskMarker", Buffer.from(w.svm.getAccount(t.task).data));
  assert.equal(decoded.creator.toBase58(), w.buyer.publicKey.toBase58());
  assert.equal(decoded.status, MARKER_COMPLETED);
});

test("rev9 close marker: a cancelled task compacts to a Cancelled marker with no flags (fed99ab: the Task stays)", async () => {
  const w = await world();
  const t = await cancelledAuto(w);
  expectOk(send(w.svm, await closeIx(w, t), [w.buyer]), "close cancelled");
  assertMarker(w, t.task, { creator: w.buyer.publicKey, statusByte: MARKER_CANCELLED, flags: 0 });
});

test("rev9 close marker: a completed hire sets both marker flags and frees the listing slot (fed99ab: no v3 hire, and its hires keep the 466-byte Task)", async () => {
  const w = await world({ price: 100_000_000 });
  const [listingModeration] = listingModV2Pda(w.listing, w.specHash, w.modAuth.publicKey);
  expectOk(send(w.svm, await makeProgram(w.modAuth).methods
    .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, listing: w.listing, listingModeration, moderator: w.modAuth.publicKey,
      moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "listing moderation");
  const h = await hireIx(w, { listingModeration });
  expectOk(send(w.svm, h.ix, [w.buyer]), "hire");
  const t = { task: h.task, escrow: h.escrow, hireRecord: h.hireRecord, validation: pda([enc("task_validation"), h.task.toBuffer()])[0] };
  await publish(w, t, { jobHash: h.taskJobSpecHash });
  expectOk(send(w.svm, await claimIx(w, t), [w.provider]), "claim");
  expectOk(send(w.svm, await w.providerProg.methods
    .submitTaskResult(arr(id32()), arr(Buffer.concat([Buffer.alloc(63), Buffer.from([7])])))
    .accounts({ task: t.task, claim: t.claim, taskValidationConfig: t.validation, taskSubmission: t.submission,
      protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "submit");
  expectOk(send(w.svm, await w.buyerProg.methods.acceptTaskResult()
    .accounts({ task: t.task, claim: t.claim, escrow: t.escrow, taskValidationConfig: t.validation, taskSubmission: t.submission,
      worker: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, creator: w.buyer.publicKey,
      workerAuthority: w.provider.publicKey, hireRecord: t.hireRecord, operator: null, referrer: null,
      creatorCompletionBond: completionBond(t.task, w.buyer.publicKey), workerCompletionBond: completionBond(t.task, w.provider.publicKey),
      tokenEscrowAta: null, workerTokenAccount: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null,
      systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "accept");
  assert.equal(decode(w.svm, "Task", t.task)._reserved[12], 1, "fee-qualified completion");
  assert.equal(decode(w.svm, "ServiceListing", w.listing).open_jobs, 1);

  const hireRent = bal(w, t.hireRecord);
  const before = bal(w, w.buyer.publicKey);
  const res = send(w.svm, await closeIx(w, t, { listing: w.listing }), [w.buyer]);
  expectOk(res, "close the hire");
  assertMarker(w, t.task, {
    creator: w.buyer.publicKey,
    statusByte: MARKER_COMPLETED,
    flags: MARKER_FLAG_ENDED_LIVE_HIRE | MARKER_FLAG_FEE_QUALIFIED,
  });
  assert.equal(bal(w, w.buyer.publicKey) - before, TASK_RENT - MARKER_RENT + hireRent - TX_FEE,
    "the creator got the Task surplus and the hire record's rent, less the fee");
  assert.ok(isClosed(w.svm, t.hireRecord), "the hire link closed");
  assert.equal(decode(w.svm, "ServiceListing", w.listing).open_jobs, 0, "the listing slot is free");
  const [closed] = findEvents(res, "TaskClosed");
  assert.equal(closed.hire_record_closed, true);

  // A rating after the tidy is refused, exactly as today (the hire record is gone),
  // now at the marker itself.
  expectFail(send(w.svm, await w.buyerProg.methods
    .rateHire(5, null, "")
    .accounts({ task: t.task, hireRecord: t.hireRecord, listing: w.listing,
      hireRating: pda([enc("hire_rating"), t.task.toBuffer()])[0], protocolConfig: w.protocolPda,
      buyer: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "AccountDiscriminatorMismatch", "rate_hire against the marker");
});

// ---------------------------------------------------------------------------
// 11.3 items 2 and 3. fed99ab: the full Task stays, so these still find a Task.
// ---------------------------------------------------------------------------
test("rev9 close marker: the task id stays taken and no new child can attach to the marker (fed99ab: the Task stays)", async () => {
  const w = await world();
  const t = await completedAuto(w);
  expectOk(send(w.svm, await closeIx(w, t), [w.buyer]), "compact");
  assertMarker(w, t.task, { creator: w.buyer.publicKey, statusByte: MARKER_COMPLETED });

  // create_task with the same id fails: the marker holds the address.
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  w.svm.expireBlockhash();
  expectFail(send(w.svm, await w.buyerProg.methods
    .createTask(arr(t.taskId), new BN(1), arr(desc), new BN(1_000_000), 1, new BN(now(w) + 3600), 0, null, 0, null, null, 0)
    .accounts({ task: t.task, escrow: t.escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent,
      authorityRateLimit: pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()])[0],
      authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId,
      rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "already in use", "create_task with the same id");

  // Every loader of Account<Task> rejects the marker's discriminator.
  const jobHash = id32();
  const { res: moderation } = await moderate(w, t.task, jobHash);
  expectFail(moderation, "AccountDiscriminatorMismatch", "record_task_moderation against the marker");
  expectFail(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/after-close", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task: t.task, moderationConfig: w.modCfg,
      taskModeration: taskModV2Pda(t.task, jobHash, w.modAuth.publicKey)[0], moderationAttestor: null,
      moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: t.jobSpec, creator: w.buyer.publicKey,
      systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "AccountDiscriminatorMismatch", "set_task_job_spec against the marker");
  const disputeId = id32();
  const dispute = pda([enc("dispute"), Buffer.from(disputeId)])[0];
  expectFail(send(w.svm, await w.buyerProg.methods
    .initiateDispute(arr(disputeId), arr(t.taskId), arr(Buffer.alloc(32, 1)), 0, "after close")
    .accounts({ dispute, task: t.task, agent: w.buyerAgent,
      authorityRateLimit: pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()])[0],
      protocolConfig: w.protocolPda, initiatorClaim: null, workerAgent: w.providerAgent, workerClaim: t.claim,
      taskSubmission: null, authority: w.buyer.publicKey, systemProgram: SystemProgram.programId,
      disputeBond: disputeBondPda(dispute) })
    .instruction(), [w.buyer]), "AccountDiscriminatorMismatch", "initiate_dispute against the marker");
  expectFail(send(w.svm, await w.buyerProg.methods
    .postCompletionBond(0)
    .accounts({ task: t.task, protocolConfig: w.protocolPda, completionBond: completionBond(t.task, w.buyer.publicKey),
      worker: null, workerClaim: null, authority: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "AccountDiscriminatorMismatch", "post_completion_bond against the marker");
});

// ---------------------------------------------------------------------------
// 11.3 item 4 and the payer flag. fed99ab: no rent_payer; rent goes to the moderator.
// ---------------------------------------------------------------------------
test("rev9 close marker: a creator-paid moderation record omitted at compaction is swept to the creator on a second pass (fed99ab: no rent_payer, so only the moderator pays and gets the rent)", async () => {
  const w = await world();
  const t = await createAuto(w);
  expectOk(t.createResult, "create");
  const recordRent = BigInt(w.svm.minimumBalanceForRentExemption(234n));
  const buyerBefore = bal(w, w.buyer.publicKey);
  const modBefore = bal(w, w.modAuth.publicKey);
  await publish(w, t, { rentPayer: w.buyer });
  assert.equal(decode(w.svm, "TaskModeration", t.taskMod)._reserved[0], 1, "payer role: the creator");
  // The buyer paid the record's rent (and the publish fee and job-spec rent); the
  // moderator paid only the two-signature moderation fee.
  assert.equal(modBefore - bal(w, w.modAuth.publicKey), 2n * TX_FEE, "the moderator paid only its fee");
  const jobSpecRent = bal(w, t.jobSpec);
  assert.equal(buyerBefore - bal(w, w.buyer.publicKey), recordRent + jobSpecRent + TX_FEE, "the buyer paid the record rent");

  // A re-review by the moderator never rewrites who paid.
  const { res: again } = await moderate(w, t.task, t.jobHash, { rentPayer: w.modAuth });
  expectOk(again, "re-review");
  assert.equal(decode(w.svm, "TaskModeration", t.taskMod)._reserved[0], 1, "still the creator");

  expectOk(send(w.svm, await claimIx(w, t), [w.provider]), "claim");
  expectOk(send(w.svm, await completeIx(w, t), [w.provider]), "complete");
  expectOk(send(w.svm, await closeIx(w, t, { taskJobSpec: t.jobSpec }), [w.buyer]), "compact, omitting the record");
  assertMarker(w, t.task, { creator: w.buyer.publicKey, statusByte: MARKER_COMPLETED });
  assert.ok(!isClosed(w.svm, t.taskMod), "the omitted record survives compaction");

  // The moderator is no longer the recipient of a creator-paid record.
  w.svm.expireBlockhash();
  expectFail(send(w.svm, await closeIx(w, t, { remaining: [
    { pubkey: t.taskMod, isSigner: false, isWritable: true },
    { pubkey: w.modAuth.publicKey, isSigner: false, isWritable: true },
  ] }), [w.buyer]), "TaskChildRentRecipientRequired", "the moderator is not the payer");
  const before = bal(w, w.buyer.publicKey);
  const res = send(w.svm, await closeIx(w, t, { remaining: [
    { pubkey: t.taskMod, isSigner: false, isWritable: true },
    { pubkey: w.buyer.publicKey, isSigner: false, isWritable: true },
  ] }), [w.buyer]);
  expectOk(res, "second pass on the marker");
  assert.ok(isClosed(w.svm, t.taskMod), "the record is swept");
  assert.equal(bal(w, w.buyer.publicKey) - before, recordRent - TX_FEE, "its rent went back to the creator");
  assert.equal(findEvents(res, "TaskCompacted").length, 0, "the marker path sweeps only");
  assertMarker(w, t.task, { creator: w.buyer.publicKey, statusByte: MARKER_COMPLETED });
});

test("rev9 close marker: a moderator-paid record still returns to the moderator, and nobody else can pay (fed99ab: no rent_payer account)", async () => {
  const w = await world();
  const t = await createAuto(w);
  expectOk(t.createResult, "create");
  const stranger = Keypair.generate();
  w.svm.airdrop(stranger.publicKey, 1_000_000_000n);
  const { res: refused } = await moderate(w, t.task, id32(), { rentPayer: stranger });
  expectFail(refused, "InvalidModerationRentPayer", "a stranger cannot pay the record");

  await publish(w, t);
  assert.equal(decode(w.svm, "TaskModeration", t.taskMod)._reserved[0], 0, "payer role: the moderator");
  expectOk(send(w.svm, await claimIx(w, t), [w.provider]), "claim");
  expectOk(send(w.svm, await completeIx(w, t), [w.provider]), "complete");
  const recordRent = bal(w, t.taskMod);
  const modBefore = bal(w, w.modAuth.publicKey);
  expectOk(send(w.svm, await closeIx(w, t, { taskJobSpec: t.jobSpec, remaining: [
    { pubkey: t.taskMod, isSigner: false, isWritable: true },
    { pubkey: w.modAuth.publicKey, isSigner: false, isWritable: true },
  ] }), [w.buyer]), "compact and sweep in one call");
  assert.equal(bal(w, w.modAuth.publicKey) - modBefore, recordRent, "the moderator got its rent back");
  assertMarker(w, t.task, { creator: w.buyer.publicKey, statusByte: MARKER_COMPLETED });

  // Only the creator may sweep the marker.
  w.svm.expireBlockhash();
  expectFail(send(w.svm, await closeIx(w, t, { signer: w.provider }), [w.provider]),
    "UnauthorizedTaskAction", "a non-creator on the marker path");
});

// ---------------------------------------------------------------------------
// 11.3 item 5. fed99ab: any program-owned parent is live (OrphanTaskParentStillLive).
// ---------------------------------------------------------------------------
test("rev9 close marker: reclaim_orphan_task_child accepts a marker parent and pays the stored payer (fed99ab: no rent_payer, and the Task stays a live parent)", async () => {
  const w = await world();
  const t = await createAuto(w);
  expectOk(t.createResult, "create");
  await publish(w, t, { rentPayer: w.buyer });
  expectOk(send(w.svm, await claimIx(w, t), [w.provider]), "claim");
  expectOk(send(w.svm, await completeIx(w, t), [w.provider]), "complete");
  expectOk(send(w.svm, await closeIx(w, t), [w.buyer]), "compact, omitting the job spec and the record");
  assertMarker(w, t.task, { creator: w.buyer.publicKey, statusByte: MARKER_COMPLETED });

  const cranker = Keypair.generate();
  w.svm.airdrop(cranker.publicKey, 1_000_000_000n);
  const reclaim = (child, recipient) => makeProgram(cranker).methods
    .reclaimOrphanTaskChild()
    .accounts({ child, parentTask: t.task, workerAgent: SystemProgram.programId, rentRecipient: recipient, authority: cranker.publicKey })
    .instruction();

  // The moderation record goes to the creator, who paid it; the cranker cannot
  // send it to the moderator.
  expectFail(send(w.svm, await reclaim(t.taskMod, w.modAuth.publicKey), [cranker]),
    "TaskChildRentRecipientRequired", "the moderator did not pay");
  const recordRent = bal(w, t.taskMod);
  const before = bal(w, w.buyer.publicKey);
  expectOk(send(w.svm, await reclaim(t.taskMod, w.buyer.publicKey), [cranker]), "reclaim the record");
  assert.equal(bal(w, w.buyer.publicKey) - before, recordRent, "the creator got the record rent");
  // The job spec goes to its stored creator too.
  const specRent = bal(w, t.jobSpec);
  expectOk(send(w.svm, await reclaim(t.jobSpec, w.buyer.publicKey), [cranker]), "reclaim the job spec");
  assert.equal(bal(w, w.buyer.publicKey) - before, recordRent + specRent);
  assert.ok(isClosed(w.svm, t.taskMod) && isClosed(w.svm, t.jobSpec));

  // A live Task is still a live parent.
  const live = await createAuto(w);
  expectOk(live.createResult, "create a live task");
  await publish(w, live);
  expectFail(send(w.svm, await makeProgram(cranker).methods
    .reclaimOrphanTaskChild()
    .accounts({ child: live.jobSpec, parentTask: live.task, workerAgent: SystemProgram.programId,
      rentRecipient: w.buyer.publicKey, authority: cranker.publicKey })
    .instruction(), [cranker]), "OrphanTaskParentStillLive", "a live Task is not a gone parent");
});

// ---------------------------------------------------------------------------
// 11.3 item 6. fed99ab: the Task stays, so there is no marker parent to accept.
// ---------------------------------------------------------------------------
test("rev9 close marker: reclaim_completion_bond refunds a worker bond against a marker parent (fed99ab: the Task stays)", async () => {
  const w = await world();
  const t = await completedAuto(w);
  expectOk(send(w.svm, await closeIx(w, t), [w.buyer]), "compact");
  assertMarker(w, t.task, { creator: w.buyer.publicKey, statusByte: MARKER_COMPLETED });

  // A worker bond close_task could not derive (the Task does not store the
  // worker wallet), left live at its canonical PDA.
  const [bondPda, bump] = pda([enc("completion_bond"), t.task.toBuffer(), w.provider.publicKey.toBuffer()]);
  const amount = 250_000n;
  const data = await coder.accounts.encode("CompletionBond", {
    task: t.task, party: w.provider.publicKey, role: 1, amount: new BN(amount.toString()), bond_mint: null,
    posted_at: new BN(now(w)), bump, _reserved: Array(16).fill(0),
  });
  const bondRent = BigInt(w.svm.minimumBalanceForRentExemption(BigInt(data.length)));
  w.svm.setAccount(bondPda, { lamports: Number(bondRent + amount), data, owner: w.svm.getAccount(t.task).owner, executable: false, rentEpoch: 0 });

  const before = bal(w, w.provider.publicKey);
  const cranker = Keypair.generate();
  w.svm.airdrop(cranker.publicKey, 1_000_000_000n);
  expectOk(send(w.svm, await makeProgram(cranker).methods
    .reclaimCompletionBond(1)
    .accounts({ task: t.task, completionBond: bondPda, party: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [cranker]), "reclaim the bond against the marker");
  assert.equal(bal(w, w.provider.publicKey) - before, bondRent + amount, "the poster got the principal and the rent");

  // An account that is neither a Task nor a marker is refused.
  expectFail(send(w.svm, await makeProgram(cranker).methods
    .reclaimCompletionBond(1)
    .accounts({ task: w.buyerAgent, completionBond: completionBond(w.buyerAgent, w.provider.publicKey),
      party: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [cranker]), "InvalidTaskMarker", "an AgentRegistration as the task");
});

// ---------------------------------------------------------------------------
// 11.3 item 7. fed99ab: only the surplus above the 466-byte minimum comes back.
// ---------------------------------------------------------------------------
test("rev9 close marker: an old-rate 466-byte tombstone compacts and refunds 3,199,520 lamports (fed99ab: 1,116,720)", async () => {
  const w = await world();
  const t = await completedAuto(w);
  // The state of a task funded at the old rate (4,134,240 lamports).
  const account = w.svm.getAccount(t.task);
  w.svm.setAccount(t.task, { ...account, lamports: Number(OLD_RATE_TASK) });
  const before = bal(w, w.buyer.publicKey);
  const res = send(w.svm, await closeIx(w, t), [w.buyer]);
  expectOk(res, "compact the old-rate tombstone");
  assert.equal(bal(w, w.buyer.publicKey) - before, 3_199_520n - TX_FEE, "everything above the marker's minimum");
  assertMarker(w, t.task, { creator: w.buyer.publicKey, statusByte: MARKER_COMPLETED });
  assert.equal(BigInt(findEvents(res, "TaskCompacted")[0].refunded_lamports.toString()), 3_199_520n);
});

// ---------------------------------------------------------------------------
// Compaction preconditions (TaskNotCompactable, 6430) and account checks.
// ---------------------------------------------------------------------------
test("rev9 close marker: peer settlement still pending refuses compaction with TaskNotCompactable (fed99ab: closes)", async () => {
  const w = await world();
  const t = await completedAuto(w);
  await mutateTask(w, t.task, (task) => { task._reserved[11] = 1; });
  expectFail(send(w.svm, await closeIx(w, t), [w.buyer]), "TaskNotCompactable", "peers still settling");
  assert.equal(w.svm.getAccount(t.task).data.length, 466, "the Task stays whole");
});

test("rev9 close marker: a token task must pass its escrow address; a retained closed escrow closes in the same call (fed99ab: no such rule)", async () => {
  const w = await world();
  const t = await completedAuto(w);
  const mint = Keypair.generate().publicKey;
  await mutateTask(w, t.task, (task) => { task.reward_mint = mint; });
  expectFail(send(w.svm, await closeIx(w, t), [w.buyer]), "TaskNotCompactable", "a token task without its escrow");

  // resolve_dispute keeps a token task's drained escrow open with is_closed = true.
  const [, escrowBump] = pda([enc("escrow"), t.task.toBuffer()]);
  const escrowState = (isClosedFlag) => coder.accounts.encode("TaskEscrow", {
    task: t.task, amount: new BN(1_000_000), distributed: new BN(1_000_000), is_closed: isClosedFlag, bump: escrowBump,
  });
  const owner = w.svm.getAccount(t.task).owner;
  const pending = await escrowState(false);
  const escrowRent = BigInt(w.svm.minimumBalanceForRentExemption(BigInt(pending.length)));
  w.svm.setAccount(t.escrow, { lamports: Number(escrowRent), data: pending, owner, executable: false, rentEpoch: 0 });
  w.svm.expireBlockhash();
  expectFail(send(w.svm, await closeIx(w, t, { escrow: t.escrow }), [w.buyer]), "InvalidInput", "an unsettled reserve is refused");
  assert.equal(w.svm.getAccount(t.task).data.length, 466);

  w.svm.setAccount(t.escrow, { lamports: Number(escrowRent), data: await escrowState(true), owner, executable: false, rentEpoch: 0 });
  w.svm.expireBlockhash();
  const before = bal(w, w.buyer.publicKey);
  const res = send(w.svm, await closeIx(w, t, { escrow: t.escrow }), [w.buyer]);
  expectOk(res, "close the retained escrow and compact");
  assert.ok(isClosed(w.svm, t.escrow), "the escrow closed");
  assert.equal(bal(w, w.buyer.publicKey) - before, TASK_RENT - MARKER_RENT + escrowRent - TX_FEE);
  assert.equal(findEvents(res, "TaskClosed")[0].escrow_closed, true);
  assertMarker(w, t.task, { creator: w.buyer.publicKey, statusByte: MARKER_COMPLETED });
});

test("rev9 close marker: a token task whose escrow is already gone compacts when the empty escrow address is passed (fed99ab: AccountNotInitialized)", async () => {
  const w = await world();
  const t = await completedAuto(w);
  await mutateTask(w, t.task, (task) => { task.reward_mint = Keypair.generate().publicKey; });
  assert.ok(isClosed(w.svm, t.escrow), "complete_task closed the escrow");
  const res = send(w.svm, await closeIx(w, t, { escrow: t.escrow }), [w.buyer]);
  expectOk(res, "the empty address proves the escrow is gone");
  assert.equal(findEvents(res, "TaskClosed")[0].escrow_closed, false);
  assertMarker(w, t.task, { creator: w.buyer.publicKey, statusByte: MARKER_COMPLETED });
});

test("rev9 close marker: close_task refuses an account that is neither a Task nor a TaskMarker (fed99ab: AccountDiscriminatorMismatch)", async () => {
  const w = await world();
  expectFail(send(w.svm, await closeIx(w, { task: w.buyerAgent }, { task: w.buyerAgent }), [w.buyer]),
    "InvalidTaskMarker", "an AgentRegistration as the task");
});

// Review R1-8: a settled bond is tombstoned and stays program-owned until the
// transaction ends, so a later instruction in the same transaction can fund it
// back. Compaction must never require a bond address to be empty.
test("rev9 close marker: revived settled bond tombstones never block compaction (review R1-8; fed99ab: the Task stays)", async () => {
  const w = await world();
  const t = await completedAuto(w);
  const owner = w.svm.getAccount(t.task).owner;
  const tombstone = (size) => {
    const data = Buffer.alloc(size);
    data.fill(0xff, 0, 8);
    return data;
  };
  const creatorBond = completionBond(t.task, w.buyer.publicKey);
  const workerBond = completionBond(t.task, w.provider.publicKey);
  for (const [address, size] of [[creatorBond, 139], [workerBond, 139], [disputeBondPda(t.task), 186]]) {
    w.svm.setAccount(address, { lamports: 1_595_120, data: tombstone(size), owner, executable: false, rentEpoch: 0 });
  }
  expectOk(send(w.svm, await closeIx(w, t, { workerBond }), [w.buyer]), "compaction with revived tombstones");
  assertMarker(w, t.task, { creator: w.buyer.publicKey, statusByte: MARKER_COMPLETED });

  // A live creator bond still refuses it.
  const live = await completedAuto(w);
  const [livePda, bump] = pda([enc("completion_bond"), live.task.toBuffer(), w.buyer.publicKey.toBuffer()]);
  const data = await coder.accounts.encode("CompletionBond", {
    task: live.task, party: w.buyer.publicKey, role: 0, amount: new BN(1_000), bond_mint: null,
    posted_at: new BN(now(w)), bump, _reserved: Array(16).fill(0),
  });
  w.svm.setAccount(livePda, { lamports: 2_000_000, data, owner, executable: false, rentEpoch: 0 });
  expectFail(send(w.svm, await closeIx(w, live), [w.buyer]), "TaskHasLiveCompletionBond", "a live creator bond");
});

// ---------------------------------------------------------------------------
// Review R1-6 (part 1): a child task whose parent was compacted keeps working.
// A Completed marker is a completed parent; a Cancelled marker is a parent that
// is not completed, exactly as the full Task was. The children below exist before
// their parent is tidied, as on mainnet; without the rule the 56-byte parent
// would brick their claim, completion, expire_claim and expire_dispute.
// ---------------------------------------------------------------------------
async function compact(w, parent, statusByte = MARKER_COMPLETED) {
  expectOk(send(w.svm, await closeIx(w, parent), [w.buyer]), "compact the parent");
  assertMarker(w, parent.task, { creator: w.buyer.publicKey, statusByte });
}

async function publishedChild(w, parent, opts = {}) {
  const child = await createAuto(w, { parent: parent.task, ...opts });
  expectOk(child.createResult, "create a child");
  await publish(w, child);
  return child;
}

test("rev9 close marker: a child claims and completes after its Completed parent is compacted (review R1-6; fed99ab: the parent stays a Task)", async () => {
  const w = await world();
  const parent = await completedAuto(w);
  const child = await publishedChild(w, parent);
  await compact(w, parent);
  expectOk(send(w.svm, await claimIx(w, child), [w.provider]), "claim with the marker as parent evidence");
  expectOk(send(w.svm, await completeIx(w, child), [w.provider]), "complete with the marker as parent evidence");
  assert.equal(status(w, child.task), "Completed");
  // A new child of the compacted Completed parent can still be created.
  const later = await createAuto(w, { parent: parent.task });
  expectOk(later.createResult, "create a child of the marker");
});

test("rev9 close marker: a no-show on a child still expires after its parent is compacted (review R1-6; fed99ab: the parent stays a Task)", async () => {
  const w = await world();
  const parent = await completedAuto(w);
  const child = await publishedChild(w, parent, { deadlineSecs: 30 * 86_400 });
  expectOk(send(w.svm, await claimIx(w, child), [w.provider]), "claim the child");
  await compact(w, parent);
  const claim = decode(w.svm, "TaskClaim", child.claim);
  // Past the claim's expiry and the 60-second worker-only grace.
  warpTo(w, Number(claim.expires_at.toString()) + 61);
  const cranker = Keypair.generate();
  w.svm.airdrop(cranker.publicKey, 1_000_000_000n);
  expectOk(send(w.svm, await makeProgram(cranker).methods
    .expireClaim()
    .accounts({ authority: cranker.publicKey, task: child.task, escrow: child.escrow, claim: child.claim, worker: w.providerAgent,
      protocolConfig: w.protocolPda, taskValidationConfig: null, taskSubmission: child.submission,
      rentRecipient: w.provider.publicKey, workerCompletionBond: completionBond(child.task, w.provider.publicKey),
      bondCreator: w.buyer.publicKey, agentStats: agentStatsPda(w.providerAgent), treasury: null,
      systemProgram: SystemProgram.programId, creatorStats: null })
    .remainingAccounts(parentMeta(child))
    .instruction(), [cranker]), "expire_claim with the marker as parent evidence");
  assert.ok(isClosed(w.svm, child.claim), "the claim closed");
  assert.equal(status(w, child.task), "Open", "the child reopened");
});

test("rev9 close marker: a dispute on a child still expires after its parent is compacted (review R1-6; fed99ab: the parent stays a Task)", async () => {
  const w = await world();
  const parent = await completedAuto(w);
  const child = await publishedChild(w, parent, { deadlineSecs: 30 * 86_400 });
  expectOk(send(w.svm, await claimIx(w, child), [w.provider]), "claim the child");
  const disputeId = id32();
  const dispute = pda([enc("dispute"), Buffer.from(disputeId)])[0];
  expectOk(send(w.svm, await w.buyerProg.methods
    .initiateDispute(arr(disputeId), arr(child.taskId), arr(Buffer.alloc(32, 1)), 0, "creator evidence")
    .accounts({ dispute, task: child.task, agent: w.buyerAgent,
      authorityRateLimit: pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()])[0],
      protocolConfig: w.protocolPda, initiatorClaim: null, workerAgent: w.providerAgent, workerClaim: child.claim,
      taskSubmission: null, authority: w.buyer.publicKey, systemProgram: SystemProgram.programId,
      disputeBond: disputeBondPda(dispute) })
    .instruction(), [w.buyer]), "the creator files a dispute on the child");
  await compact(w, parent);
  warpTo(w, Number(decode(w.svm, "Dispute", dispute).expires_at.toString()) + 1);
  const cranker = Keypair.generate();
  w.svm.airdrop(cranker.publicKey, 1_000_000_000n);
  expectOk(send(w.svm, await makeProgram(cranker).methods
    .expireDispute()
    .accounts({ dispute, task: child.task, escrow: child.escrow, protocolConfig: w.protocolPda, creator: w.buyer.publicKey,
      authority: cranker.publicKey, workerClaim: child.claim, worker: w.providerAgent, workerWallet: w.provider.publicKey,
      hireRecord: child.hireRecord, disputeOperator: null, disputeReferrer: null, tokenEscrowAta: null, creatorTokenAccount: null,
      workerTokenAccountAta: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: completionBond(child.task, w.buyer.publicKey), workerCompletionBond: completionBond(child.task, w.provider.publicKey),
      taskSubmission: child.submission, taskValidationConfig: null, disputeBond: disputeBondPda(dispute),
      workerStats: agentStatsPda(w.providerAgent), creatorStats: creatorStatsPda(w.buyer.publicKey),
      systemProgram: SystemProgram.programId })
    .remainingAccounts(parentMeta(child))
    .instruction(), [cranker]), "expire_dispute with the marker as parent evidence");
  assert.equal(Object.keys(decode(w.svm, "Dispute", dispute).status)[0], "Expired");
});

test("rev9 close marker: a compacted Cancelled parent is not a completed parent (review R1-6; fed99ab: the parent stays a Task)", async () => {
  const w = await world();
  // A child made while the parent was still Open, then the parent is cancelled
  // and compacted.
  const parent = await createAuto(w);
  expectOk(parent.createResult, "create the parent");
  const child = await createAuto(w, { parent: parent.task });
  expectOk(child.createResult, "create the child");
  await publish(w, child);
  expectOk(send(w.svm, await w.buyerProg.methods
    .cancelTask()
    .accounts({ task: parent.task, escrow: parent.escrow, authority: w.buyer.publicKey, protocolConfig: w.protocolPda,
      systemProgram: SystemProgram.programId, tokenEscrowAta: null, creatorTokenAccount: null, rewardMint: null,
      tokenProgram: null, creatorCompletionBond: completionBond(parent.task, w.buyer.publicKey),
      workerCompletionBond: completionBond(parent.task, w.provider.publicKey), workerBondAuthority: w.provider.publicKey,
      creatorAgent: null, agentStats: null, treasury: null, creatorStats: creatorStatsPda(w.buyer.publicKey) })
    .instruction(), [w.buyer]), "cancel the parent");
  expectOk(send(w.svm, await closeIx(w, parent), [w.buyer]), "compact the cancelled parent");
  assertMarker(w, parent.task, { creator: w.buyer.publicKey, statusByte: MARKER_CANCELLED });

  expectFail(send(w.svm, await claimIx(w, child), [w.provider]), "ParentTaskNotCompleted", "no assignment under a cancelled parent");
  const late = await createAuto(w, { parent: parent.task });
  expectFail(late.createResult, "ParentTaskCancelled", "no new child of a cancelled parent");
});

// ---------------------------------------------------------------------------
// Review R3-1: a SOL task may be compacted without its escrow (the SDK and the
// wallet leave it out, and SOL exits normally close it). Two live Completed
// SOL tasks still keep a settled 58-byte TaskEscrow. Compacting one of them
// without the escrow must not strand it: close_task on the marker closes a
// passed settled escrow to the creator.
// ---------------------------------------------------------------------------
test("rev9 close marker: a settled SOL escrow left out at compaction is recovered on the marker (review R3-1; da22158: it moves nothing)", async () => {
  const w = await world();
  const t = await completedAuto(w);
  const [, escrowBump] = pda([enc("escrow"), t.task.toBuffer()]);
  const data = await coder.accounts.encode("TaskEscrow", {
    task: t.task, amount: new BN(1_000_000), distributed: new BN(1_000_000), is_closed: true, bump: escrowBump,
  });
  assert.equal(data.length, 58, "a 58-byte TaskEscrow");
  const owner = w.svm.getAccount(t.task).owner;
  const LIVE_ESCROW_LAMPORTS = 1_294_560n; // (128 + 58) x 6,960, as on mainnet
  w.svm.setAccount(t.escrow, { lamports: Number(LIVE_ESCROW_LAMPORTS), data, owner, executable: false, rentEpoch: 0 });

  // Compacted without the escrow, as the usual clients do for a SOL task.
  expectOk(send(w.svm, await closeIx(w, t), [w.buyer]), "compact without the escrow");
  assertMarker(w, t.task, { creator: w.buyer.publicKey, statusByte: MARKER_COMPLETED });
  assert.equal(bal(w, t.escrow), LIVE_ESCROW_LAMPORTS, "the escrow is still there");

  w.svm.expireBlockhash();
  const before = bal(w, w.buyer.publicKey);
  expectOk(send(w.svm, await closeIx(w, t, { escrow: t.escrow }), [w.buyer]), "close_task on the marker with the escrow");
  assert.equal(bal(w, w.buyer.publicKey) - before, LIVE_ESCROW_LAMPORTS - TX_FEE, "the creator gets the escrow's 1,294,560 lamports");
  assert.ok(isClosed(w.svm, t.escrow), "the escrow address is empty");

  // An unsettled escrow is still refused on the marker, and an absent one is fine.
  const other = await completedAuto(w);
  const [, otherBump] = pda([enc("escrow"), other.task.toBuffer()]);
  const open = await coder.accounts.encode("TaskEscrow", {
    task: other.task, amount: new BN(1_000_000), distributed: new BN(0), is_closed: false, bump: otherBump,
  });
  expectOk(send(w.svm, await closeIx(w, other), [w.buyer]), "compact the other task");
  w.svm.setAccount(other.escrow, { lamports: Number(LIVE_ESCROW_LAMPORTS), data: open, owner, executable: false, rentEpoch: 0 });
  w.svm.expireBlockhash();
  expectFail(send(w.svm, await closeIx(w, other, { escrow: other.escrow }), [w.buyer]), "InvalidInput", "an unsettled escrow");
  w.svm.setAccount(other.escrow, { lamports: 0, data: Buffer.alloc(0), owner: SystemProgram.programId, executable: false, rentEpoch: 0 });
  w.svm.expireBlockhash();
  expectOk(send(w.svm, await closeIx(w, other, { escrow: other.escrow }), [w.buyer]), "an empty escrow address on the marker");
});
