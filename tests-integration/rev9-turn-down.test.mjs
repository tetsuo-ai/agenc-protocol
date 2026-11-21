// Revision 9 (A, B): no free refund of delivered work on a single-worker review
// task. Design: REV9-DESIGN.md sections 1, 2 and 11.1.
//
// A single-worker review task (Exclusive, one worker, CreatorReview) can only be
// refused by freezing it. The freeze opens a fixed 72-hour dispute window; the
// worker may dispute it once with a bond of max(10% of the price, 0.01 SOL); the
// 2-of-3 multisig then has 72 hours to rule. No dispute: the buyer is refunded
// after the window. Not ruled: the buyer is refunded and the bond comes back.
//
// Executes the COMPILED program. Existing instructions are built from the loaded
// IDL (on fed99ab, today's wire, which ignores the new account names). The two
// instructions revision 9 adds or re-discriminates (`dispute_rejection`,
// `resolve_reject_frozen` v2) are built from the committed revision 9 IDL, so
// fed99ab rejects them as unknown instructions.
//
// Run: node --test tests-integration/rev9-turn-down.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  REPO, PID, enc, arr, pda, id32, coder,
  makeProgram, send, expectOk, expectFail, decode, isClosed,
  freshWorld, setMultisig, setProtocolPaused, configureTestMultisig, approvalSigners,
  taskModV2Pda, listingModV2Pda, moderationBlockPda,
  agentStatsPda, creatorStatsPda, readCreatorStats, disputeBondPda, injectRevision8Freeze,
  Program, AnchorProvider, Wallet, Connection, BN, Keypair, SystemProgram,
} from "./harness.mjs";

const REV9_IDL = JSON.parse(fs.readFileSync(path.join(REPO, "artifacts/anchor/idl/agenc_coordination.json"), "utf8"));
if (!REV9_IDL.instructions.some((ix) => ix.name === "dispute_rejection")) {
  throw new Error("artifacts/anchor/idl/agenc_coordination.json is not the revision 9 IDL; run npm run artifacts:refresh");
}
const rev9 = (payer) => new Program(REV9_IDL, new AnchorProvider(
  new Connection("http://127.0.0.1:9999"), new Wallet(payer), { commitment: "processed" }));

const TX_FEE = 5_000n;
const DISPUTE_WINDOW = 259_200;
const RULING_WINDOW = 259_200;
const RESUBMIT_FLOOR = 86_400;
const BOND_FLOOR = 10_000_000n;
const BOND_SIZE = 186;
const rent = (w, size) => BigInt(w.svm.minimumBalanceForRentExemption(BigInt(size)));
const bal = (w, key) => BigInt(w.svm.getBalance(key) ?? 0n);
const completionBond = (task, wallet) => pda([enc("completion_bond"), task.toBuffer(), wallet.toBuffer()])[0];
const now = (w) => Number(w.svm.getClock().unixTimestamp);
const status = (w, task) => Object.keys(decode(w.svm, "Task", task).status)[0];

function warpTo(w, unixTimestamp) {
  const c = w.svm.getClock();
  c.unixTimestamp = BigInt(unixTimestamp);
  w.svm.setClock(c);
  w.svm.expireBlockhash();
}

function systemAccount(w, address, lamports) {
  w.svm.setAccount(address, { lamports: Number(lamports), data: Buffer.alloc(0), owner: SystemProgram.programId, executable: false, rentEpoch: 0 });
}

async function publish(w, t, jobHash = id32()) {
  const [taskMod] = taskModV2Pda(t.task, jobHash, w.modAuth.publicKey);
  t.jobHash = jobHash;
  t.jobSpec = pda([enc("task_job_spec"), t.task.toBuffer()])[0];
  expectOk(send(w.svm, await makeProgram(w.modAuth).methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task: t.task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId, rentPayer: w.modAuth.publicKey })
    .instruction(), [w.modAuth]), "td:task-mod");
  expectOk(send(w.svm, await t.creatorProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/rev9-turn-down", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task: t.task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null,
      moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: t.jobSpec, creator: t.creator.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [t.creator]), "td:publish");
}

function submitIx(w, t) {
  return w.providerProg.methods
    .submitTaskResult(arr(id32()), arr(Buffer.concat([Buffer.alloc(63), Buffer.from([7])])))
    .accounts({ task: t.task, claim: t.claim, taskValidationConfig: t.validation, taskSubmission: t.submission, protocolConfig: w.protocolPda,
      worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction();
}

async function claimAndSubmit(w, t) {
  t.claim = pda([enc("claim"), t.task.toBuffer(), w.providerAgent.toBuffer()])[0];
  t.submission = pda([enc("task_submission"), t.claim.toBuffer()])[0];
  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task: t.task, taskJobSpec: t.jobSpec, hireRecord: t.hireRecord, legacyListing: null,
      moderationBlock: moderationBlockPda(t.jobHash)[0], claim: t.claim, protocolConfig: w.protocolPda,
      worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId,
      workerStats: agentStatsPda(w.providerAgent) })
    .instruction(), [w.provider]), "td:claim");
  expectOk(send(w.svm, await submitIx(w, t), [w.provider]), "td:submit");
  return t;
}

function taskAddresses(task) {
  return {
    task,
    escrow: pda([enc("escrow"), task.toBuffer()])[0],
    validation: pda([enc("task_validation"), task.toBuffer()])[0],
    hireRecord: pda([enc("hire"), task.toBuffer()])[0],
  };
}

// A single-worker review task made with create_task (Exclusive, one worker,
// CreatorReview), published, claimed and submitted.
async function reviewTask(w, { reward = 100_000_000, reviewWindow = 3600, deadlineSecs = 7 * 86_400 } = {}) {
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const t = { ...taskAddresses(task), creator: w.buyer, creatorProg: w.buyerProg, reward, operator: null, referrer: null };
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(reward), 1, new BN(now(w) + deadlineSecs), 0, null, 0, null, null, 0)
    .accounts({ task, escrow: t.escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent,
      authorityRateLimit: pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()])[0],
      authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId,
      rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "td:create_task");
  expectOk(send(w.svm, await w.buyerProg.methods
    .configureTaskValidation(1, new BN(reviewWindow), 0, null)
    .accounts({ task, taskValidationConfig: t.validation, taskAttestorConfig: pda([enc("task_attestor"), task.toBuffer()])[0],
      protocolConfig: w.protocolPda, hireRecord: t.hireRecord, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "td:configure CreatorReview");
  await publish(w, t);
  return claimAndSubmit(w, t);
}

// A bare-wallet hire (hire_from_listing_humanless): a fresh wallet with no
// agent hires the listing, which pins CreatorReview; published, claimed and
// submitted. The listing's operator terms and an optional referrer ride along.
async function hiredReviewTask(w, { referrer = null, referrerFeeBps = 0 } = {}) {
  const human = Keypair.generate();
  w.svm.airdrop(human.publicKey, 100_000_000_000n);
  const humanProg = makeProgram(human);
  const [listingMod] = listingModV2Pda(w.listing, w.specHash, w.modAuth.publicKey);
  if (isClosed(w.svm, listingMod)) {
    expectOk(send(w.svm, await makeProgram(w.modAuth).methods
      .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
      .accounts({ moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod, moderator: w.modAuth.publicKey,
        moderationAttestor: null, systemProgram: SystemProgram.programId })
      .instruction(), [w.modAuth]), "td:listing-mod");
  }
  const taskId = id32();
  const jobHash = id32();
  const [task] = pda([enc("task"), human.publicKey.toBuffer(), Buffer.from(taskId)]);
  const t = { ...taskAddresses(task), creator: human, creatorProg: humanProg, reward: w.price, operator: w.operator ?? null, referrer };
  expectOk(send(w.svm, await humanProg.methods
    .hireFromListingHumanless(arr(taskId), new BN(w.price), new BN(1), new BN(3600), referrer, referrerFeeBps, w.modAuth.publicKey, arr(jobHash))
    .accounts({ task, escrow: t.escrow, hireRecord: t.hireRecord, taskValidationConfig: t.validation, listing: w.listing,
      providerAgent: w.providerAgent, protocolConfig: w.protocolPda, moderationConfig: w.modCfg, listingModeration: listingMod,
      moderationAttestor: null, moderationBlock: moderationBlockPda(w.specHash)[0],
      authorityRateLimit: pda([enc("authority_rate_limit"), human.publicKey.toBuffer()])[0],
      creator: human.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [human]), "td:bare-wallet hire");
  await publish(w, t, jobHash);
  return claimAndSubmit(w, t);
}

function freezeIx(w, t) {
  return t.creatorProg.methods
    .rejectAndFreeze(arr(Buffer.alloc(32, 7)))
    .accounts({ task: t.task, claim: t.claim, taskValidationConfig: t.validation, taskSubmission: t.submission,
      protocolConfig: w.protocolPda, creator: t.creator.publicKey, agentStats: agentStatsPda(w.providerAgent),
      systemProgram: SystemProgram.programId, creatorStats: creatorStatsPda(t.creator.publicKey) })
    .instruction();
}

async function freeze(w, t) {
  expectOk(send(w.svm, await freezeIx(w, t), [t.creator]), "td:freeze");
  t.freezeAt = now(w);
  t.disputeDeadline = Number(decode(w.svm, "TaskSubmission", t.submission).review_deadline_at.toString());
  return t;
}

const frozenTask = async (w, opts) => freeze(w, await reviewTask(w, opts));

function disputeIx(w, t, { uri = "agenc://evidence/rev9" } = {}) {
  return rev9(w.provider).methods
    .disputeRejection(arr(Buffer.alloc(32, 3)), uri)
    .accounts({ task: t.task, claim: t.claim, taskSubmission: t.submission, worker: w.providerAgent,
      disputeBond: disputeBondPda(t.task), creatorStats: creatorStatsPda(t.creator.publicKey),
      protocolConfig: w.protocolPda, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction();
}

function cancelIx(w, t) {
  return t.creatorProg.methods
    .cancelTask()
    .accounts({ task: t.task, escrow: t.escrow, authority: t.creator.publicKey, protocolConfig: w.protocolPda, systemProgram: SystemProgram.programId,
      tokenEscrowAta: null, creatorTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: completionBond(t.task, t.creator.publicKey), workerCompletionBond: completionBond(t.task, w.provider.publicKey),
      workerBondAuthority: w.provider.publicKey, creatorAgent: null, agentStats: null, treasury: null,
      creatorStats: creatorStatsPda(t.creator.publicKey) })
    .instruction();
}

function exitAccounts(w, t, authority) {
  return { task: t.task, claim: t.claim, escrow: t.escrow, taskSubmission: t.submission, worker: w.providerAgent,
    protocolConfig: w.protocolPda, treasury: w.admin.publicKey, creator: t.creator.publicKey,
    workerAuthority: w.provider.publicKey, hireRecord: t.hireRecord, operator: t.operator, referrer: t.referrer,
    authority, creatorCompletionBond: completionBond(t.task, t.creator.publicKey),
    workerCompletionBond: completionBond(t.task, w.provider.publicKey), systemProgram: SystemProgram.programId,
    disputeBond: disputeBondPda(t.task), workerStats: agentStatsPda(w.providerAgent),
    creatorStats: creatorStatsPda(t.creator.publicKey) };
}

function expireIx(w, t, cranker) {
  return makeProgram(cranker).methods.expireRejectFrozen().accounts(exitAccounts(w, t, cranker.publicKey)).instruction();
}

// The multisig ruling (v2 wire). `w.admin` proposes and pays; `signers` are the
// owners listed as approvals.
function resolveIx(w, t, approve, signers) {
  return rev9(w.admin).methods
    .resolveRejectFrozen(approve, arr(Buffer.alloc(32, 5)), "agenc://ruling/rev9")
    .accounts(exitAccounts(w, t, w.admin.publicKey))
    .remainingAccounts(signers.map((k) => ({ pubkey: k.publicKey, isSigner: true, isWritable: false })))
    .instruction();
}

function txSigners(...keys) {
  const seen = new Set();
  return keys.filter((k) => !seen.has(k.publicKey.toBase58()) && seen.add(k.publicKey.toBase58()));
}

// Owners [admin, owner2, owner3], threshold 2. None is a party to the tasks.
async function multisig(w) {
  const owner2 = Keypair.generate();
  const owner3 = Keypair.generate();
  await setMultisig(w.svm, [w.admin.publicKey, owner2.publicKey, owner3.publicKey], 2);
  return { owner2, owner3 };
}

function crankerFor(w) {
  const k = Keypair.generate();
  w.svm.airdrop(k.publicKey, 1_000_000_000n);
  return k;
}

function snapshot(w, t) {
  return {
    escrow: bal(w, t.escrow),
    claimRent: bal(w, t.claim),
    submissionRent: bal(w, t.submission),
    bond: bal(w, disputeBondPda(t.task)),
    buyer: bal(w, t.creator.publicKey),
    worker: bal(w, w.provider.publicKey),
    treasury: bal(w, w.admin.publicKey),
  };
}

function deltas(w, t, before) {
  return {
    buyer: bal(w, t.creator.publicKey) - before.buyer,
    worker: bal(w, w.provider.publicKey) - before.worker,
    treasury: bal(w, w.admin.publicKey) - before.treasury,
  };
}

// ---------------------------------------------------------------------------
// 11.1 item 1. fed99ab: reject_task_result reopens the hire for a free refund.
// ---------------------------------------------------------------------------
test("rev9 turn-down: reject_task_result on a bare-wallet hire fails with SingleWorkerRejectMustFreeze (fed99ab: succeeds)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const t = await hiredReviewTask(w);
  assert.ok(decode(w.svm, "TaskValidationConfig", t.validation).mode.CreatorReview !== undefined, "the hire pinned CreatorReview");
  expectFail(send(w.svm, await t.creatorProg.methods
    .rejectTaskResult(arr(id32()))
    .accounts({ task: t.task, claim: t.claim, taskValidationConfig: t.validation, taskSubmission: t.submission, worker: w.providerAgent,
      protocolConfig: w.protocolPda, creator: t.creator.publicKey, workerAuthority: w.provider.publicKey,
      agentStats: agentStatsPda(w.providerAgent), systemProgram: SystemProgram.programId,
      workerCompletionBond: completionBond(t.task, w.provider.publicKey), creatorStats: creatorStatsPda(t.creator.publicKey) })
    .instruction(), [t.creator]), "SingleWorkerRejectMustFreeze", "rev9: a single-worker review task is refused by freezing it");
  assert.equal(status(w, t.task), "PendingValidation", "the delivery is still under review");
  assert.ok(!isClosed(w.svm, t.claim), "the worker's claim is kept");
  // The freeze is the way to refuse it.
  await freeze(w, t);
  assert.equal(status(w, t.task), "RejectFrozen", "frozen");
});

// ---------------------------------------------------------------------------
// 11.1 item 2. Guard (holds on fed99ab too): a frozen task is not cancellable.
// ---------------------------------------------------------------------------
test("rev9 turn-down: cancel_task cannot touch a frozen task (guard, holds on fed99ab)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const t = await frozenTask(w);
  warpTo(w, t.freezeAt + 8 * 86_400); // past the task deadline as well
  expectFail(send(w.svm, await cancelIx(w, t), [t.creator]), "TaskCannotBeCancelled", "frozen task is not cancellable");
});

test("rev9 turn-down: cancel_task cannot touch a disputed task (fed99ab: no dispute instruction)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const t = await frozenTask(w);
  expectOk(send(w.svm, await disputeIx(w, t), [w.provider]), "worker disputes");
  warpTo(w, t.freezeAt + 8 * 86_400);
  expectFail(send(w.svm, await cancelIx(w, t), [t.creator]), "TaskCannotBeCancelled", "disputed task is not cancellable");
});

// ---------------------------------------------------------------------------
// 11.1 item 3 + refund window edges. fed99ab: the freeze deadline is the 1-hour
// review window and the timeout pays the worker.
// ---------------------------------------------------------------------------
test("rev9 turn-down: no dispute, the buyer gets exactly the price and escrow rent after 72 hours, the worker nothing (fed99ab: worker paid)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const t = await frozenTask(w);
  assert.equal(t.disputeDeadline - t.freezeAt, DISPUTE_WINDOW, "the freeze opens the 72-hour dispute window");
  assert.equal(decode(w.svm, "TaskSubmission", t.submission)._reserved[2], 1, "freeze_kind = 1");
  const cranker = crankerFor(w);

  for (const at of [t.freezeAt + 3601, t.disputeDeadline - 1, t.disputeDeadline]) {
    warpTo(w, at);
    expectFail(send(w.svm, await expireIx(w, t, cranker), [cranker]), "RejectionWindowStillOpen", `refund refused at deadline ${at - t.disputeDeadline}`);
  }
  warpTo(w, t.disputeDeadline + 1);
  const before = snapshot(w, t);
  expectOk(send(w.svm, await expireIx(w, t, cranker), [cranker]), "undisputed refund one second after the window");
  const d = deltas(w, t, before);

  assert.equal(status(w, t.task), "Cancelled", "task Cancelled (buyer refunded)");
  assert.equal(before.escrow, BigInt(t.reward) + rent(w, 58), "the escrow held the price plus its rent");
  assert.equal(d.buyer, before.escrow, "buyer gets the price plus the escrow rent, exactly");
  assert.equal(d.worker, before.claimRent + before.submissionRent, "worker gets only its claim and submission rent");
  assert.equal(d.treasury, 0n, "no protocol fee on a refund");
  assert.ok(isClosed(w.svm, t.claim) && isClosed(w.svm, t.submission) && isClosed(w.svm, t.escrow), "claim, submission and escrow closed");
  assert.equal(Number(decode(w.svm, "AgentRegistration", w.providerAgent).active_tasks), 0, "worker's claim slot released");
  assert.equal(Number(decode(w.svm, "Task", t.task).current_workers), 0, "task slot released");
});

// ---------------------------------------------------------------------------
// 11.1 item 4 + filing edges. fed99ab: dispute_rejection does not exist.
// ---------------------------------------------------------------------------
test("rev9 turn-down: dispute_rejection inside the window posts max(10%, 0.01 SOL) once; one second late fails (fed99ab: unknown instruction)", async () => {
  for (const { reward, bond, at } of [
    { reward: 100_000_000, bond: BOND_FLOOR, at: -1 },
    { reward: 1_000_000_000, bond: 100_000_000n, at: 0 },
    { reward: 5_000_000, bond: BOND_FLOOR, at: 0 },
  ]) {
    const w = await freshWorld({ moderationEnabled: true });
    const t = await frozenTask(w, { reward });
    warpTo(w, t.disputeDeadline + at);
    const workerBefore = bal(w, w.provider.publicKey);
    expectOk(send(w.svm, await disputeIx(w, t), [w.provider]), `dispute at deadline ${at}, price ${reward}`);
    const bondPda = disputeBondPda(t.task);
    const b = decode(w.svm, "DisputeBond", bondPda);
    assert.equal(BigInt(b.amount.toString()), bond, `bond for price ${reward}`);
    assert.equal(bal(w, bondPda), rent(w, BOND_SIZE) + bond, "the bond account holds its rent plus the principal");
    assert.equal(workerBefore - bal(w, w.provider.publicKey), bond + rent(w, BOND_SIZE) + TX_FEE, "the worker paid the bond, its rent and the fee");
    assert.equal(b.subject.toBase58(), t.task.toBase58(), "subject is the task");
    assert.equal(b.filer.toBase58(), w.provider.publicKey.toBase58(), "filer is the worker wallet");
    assert.equal(b.respondent.toBase58(), t.creator.publicKey.toBase58(), "respondent is the buyer");
    assert.equal(b.kind, 0, "kind 0: dispute of a rejection");
    assert.equal(Number(b.ruling_deadline.toString()) - now(w), RULING_WINDOW, "the ruling window starts at the filing");
    assert.equal(readCreatorStats(w.svm, creatorStatsPda(t.creator.publicKey)).rejectionsContested, 1n, "the buyer's record counts a contested rejection");
    assert.equal(status(w, t.task), "RejectFrozen", "still frozen while disputed");

    expectFail(send(w.svm, await disputeIx(w, t, { uri: "agenc://evidence/again" }), [w.provider]), "already in use", "a second dispute fails at init");
  }
  const w = await freshWorld({ moderationEnabled: true });
  const t = await frozenTask(w);
  warpTo(w, t.disputeDeadline + 1);
  expectFail(send(w.svm, await disputeIx(w, t), [w.provider]), "RejectionDisputeWindowClosed", "dispute one second after the window");
  assert.ok(isClosed(w.svm, disputeBondPda(t.task)), "no bond was created");
});

// ---------------------------------------------------------------------------
// 11.1 item 5 + ruling edges + exact deltas. fed99ab: no v2 entry point.
// ---------------------------------------------------------------------------
test("rev9 turn-down: a ruling for the worker pays it as on accept and returns its bond; for the buyer the buyer gets the bond (fed99ab: unknown v2)", async () => {
  for (const { approve, at } of [{ approve: true, at: -1 }, { approve: false, at: 0 }]) {
    const w = await freshWorld({ moderationEnabled: true });
    const { owner2 } = await multisig(w);
    const t = await frozenTask(w);
    expectOk(send(w.svm, await disputeIx(w, t), [w.provider]), "dispute");
    const bondPda = disputeBondPda(t.task);
    const rulingDeadline = Number(decode(w.svm, "DisputeBond", bondPda).ruling_deadline.toString());
    warpTo(w, rulingDeadline + at);
    const before = snapshot(w, t);
    const bondRent = rent(w, BOND_SIZE);
    const bondPrincipal = before.bond - bondRent;
    assert.equal(bondPrincipal, BOND_FLOOR, "bond principal");

    expectOk(send(w.svm, await resolveIx(w, t, approve, [w.admin, owner2]), [w.admin, owner2]), `ruling approve=${approve} at ruling deadline ${at}`);
    const d = deltas(w, t, before);
    assert.ok(isClosed(w.svm, bondPda) && isClosed(w.svm, t.escrow) && isClosed(w.svm, t.claim) && isClosed(w.svm, t.submission), "bond, escrow, claim and submission closed");
    const fees = 2n * TX_FEE; // the admin pays both signatures
    if (approve) {
      // Accept path: the price is split between the worker and the treasury
      // (the protocol fee); the escrow rent goes back to the buyer.
      const protocolFee = d.treasury + fees;
      assert.ok(protocolFee > 0n && protocolFee <= BigInt(t.reward) / 100n, "a protocol fee of at most 1% was charged");
      assert.equal(d.worker, BigInt(t.reward) - protocolFee + before.claimRent + before.submissionRent + before.bond, "worker: price less fee, its rents and its whole bond");
      assert.equal(d.buyer, before.escrow - BigInt(t.reward), "buyer gets only the escrow rent back");
      assert.equal(status(w, t.task), "Completed", "task Completed");
    } else {
      assert.equal(d.buyer, before.escrow + bondPrincipal, "buyer: price, escrow rent and the worker's bond principal");
      assert.equal(d.worker, before.claimRent + before.submissionRent + bondRent, "worker: its rents and the bond's rent only");
      assert.equal(d.treasury, -fees, "no protocol fee on a refund");
      assert.equal(status(w, t.task), "Cancelled", "task Cancelled");
    }
  }

  // One second after the ruling window the multisig can no longer rule.
  const w = await freshWorld({ moderationEnabled: true });
  const { owner2 } = await multisig(w);
  const t = await frozenTask(w);
  expectOk(send(w.svm, await disputeIx(w, t), [w.provider]), "dispute");
  const rulingDeadline = Number(decode(w.svm, "DisputeBond", disputeBondPda(t.task)).ruling_deadline.toString());
  warpTo(w, rulingDeadline + 1);
  expectFail(send(w.svm, await resolveIx(w, t, true, [w.admin, owner2]), [w.admin, owner2]), "RulingWindowClosed", "ruling one second late");
});

test("rev9 turn-down: a revision 9 freeze cannot be ruled without a dispute, even over a pre-funded bond address (fed99ab: unknown v2)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const { owner2 } = await multisig(w);
  const t = await frozenTask(w);
  expectFail(send(w.svm, await resolveIx(w, t, false, [w.admin, owner2]), [w.admin, owner2]), "RejectionDisputeRequired", "no dispute, no ruling");
  // Lamports sent to the bond address do not make a dispute.
  systemAccount(w, disputeBondPda(t.task), 50_000_000);
  w.svm.expireBlockhash();
  expectFail(send(w.svm, await resolveIx(w, t, false, [w.admin, owner2]), [w.admin, owner2]), "RejectionDisputeRequired", "pre-funding is not a dispute");
  assert.equal(status(w, t.task), "RejectFrozen", "still frozen");
});

// ---------------------------------------------------------------------------
// 11.1 item 6 + unruled edges. fed99ab: no dispute exists to leave unruled.
// ---------------------------------------------------------------------------
test("rev9 turn-down: a last-second dispute left unruled refunds the buyer and returns the whole bond after its ruling window (fed99ab: unknown instruction)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const t = await frozenTask(w);
  warpTo(w, t.disputeDeadline); // the last second of the dispute window
  expectOk(send(w.svm, await disputeIx(w, t), [w.provider]), "last-second dispute");
  const bondPda = disputeBondPda(t.task);
  const rulingDeadline = Number(decode(w.svm, "DisputeBond", bondPda).ruling_deadline.toString());
  assert.equal(rulingDeadline - t.disputeDeadline, RULING_WINDOW, "a last-second dispute gets the full ruling window");
  const cranker = crankerFor(w);
  for (const at of [t.disputeDeadline + 1, rulingDeadline - 1, rulingDeadline]) {
    warpTo(w, at);
    expectFail(send(w.svm, await expireIx(w, t, cranker), [cranker]), "RejectionWindowStillOpen", `refund refused at ruling deadline ${at - rulingDeadline}`);
  }
  warpTo(w, rulingDeadline + 1);
  const before = snapshot(w, t);
  expectOk(send(w.svm, await expireIx(w, t, cranker), [cranker]), "unruled refund");
  const d = deltas(w, t, before);
  assert.equal(d.buyer, before.escrow, "buyer refunded the price and escrow rent");
  assert.equal(d.worker, before.bond + before.claimRent + before.submissionRent, "worker gets its whole bond (principal and rent) and its rents back");
  assert.equal(before.bond, rent(w, BOND_SIZE) + BOND_FLOOR, "the bond account held rent plus principal");
  assert.equal(d.treasury, 0n, "no fee");
  assert.ok(isClosed(w.svm, bondPda), "bond settled");
  assert.equal(status(w, t.task), "Cancelled", "task Cancelled");
});

// ---------------------------------------------------------------------------
// 11.1 item 7 + lead check 3. fed99ab: the frozen ruling had no conflict check.
// ---------------------------------------------------------------------------
test("rev9 turn-down: owners who are the creator or the worker wallet do not count toward the threshold; one owner listed twice counts once (fed99ab: unknown v2)", async () => {
  for (const conflicted of ["creator", "worker"]) {
    const w = await freshWorld({ moderationEnabled: true });
    const owner2 = Keypair.generate();
    const party = conflicted === "creator" ? w.buyer : w.provider;
    await setMultisig(w.svm, [party.publicKey, w.admin.publicKey, owner2.publicKey], 2);
    const t = await frozenTask(w);
    expectOk(send(w.svm, await disputeIx(w, t), [w.provider]), "dispute");
    // The ruling that would favour the conflicted party.
    expectFail(send(w.svm, await resolveIx(w, t, conflicted === "worker", [party, w.admin]), txSigners(w.admin, party)),
      "MultisigNotEnoughSigners", `the ${conflicted} cannot carry its own ruling`);
    expectFail(send(w.svm, await resolveIx(w, t, true, [w.admin, w.admin]), [w.admin]),
      "MultisigNotEnoughSigners", "one owner listed twice counts once");
    expectOk(send(w.svm, await resolveIx(w, t, true, [w.admin, owner2]), [w.admin, owner2]), "two unconflicted owners rule");
    assert.equal(status(w, t.task), "Completed", "ruled");
  }
});

// Review R2-1: only the task creator and the worker wallet are conflicted. A
// buyer or a provider could otherwise name an owner as a fee payee and make every
// ruling impossible (the unruled default then favours the party that chose it).
test("rev9 turn-down: owners who are operator or referrer payees count toward the threshold; the ruling for the worker pays their legs (review R2-1; 89ca18a: not counted)", async () => {
  const operatorKp = Keypair.generate();
  const referrerKp = Keypair.generate();
  const w = await freshWorld({ moderationEnabled: true, operator: operatorKp.publicKey, operatorFeeBps: 1000 });
  w.svm.airdrop(referrerKp.publicKey, 1_000_000_000n);
  const owner2 = Keypair.generate();
  await setMultisig(w.svm, [operatorKp.publicKey, referrerKp.publicKey, w.admin.publicKey, owner2.publicKey], 2);
  const t = await freeze(w, await hiredReviewTask(w, { referrer: referrerKp.publicKey, referrerFeeBps: 500 }));
  const task = decode(w.svm, "Task", t.task);
  assert.equal(task.operator.toBase58(), operatorKp.publicKey.toBase58(), "operator terms stamped");
  assert.equal(task.referrer.toBase58(), referrerKp.publicKey.toBase58(), "referrer terms stamped");
  expectOk(send(w.svm, await disputeIx(w, t), [w.provider]), "dispute");

  const before = { operator: bal(w, operatorKp.publicKey), referrer: bal(w, referrerKp.publicKey) };
  expectOk(send(w.svm, await resolveIx(w, t, true, [operatorKp, referrerKp]), txSigners(w.admin, operatorKp, referrerKp)),
    "two payee owners are two approvals");
  assert.equal(status(w, t.task), "Completed", "paid as on accept");
  assert.equal(bal(w, operatorKp.publicKey) - before.operator, BigInt(w.price) * 1000n / 10_000n, "operator leg paid");
  assert.equal(bal(w, referrerKp.publicKey) - before.referrer, BigInt(w.price) * 500n / 10_000n, "referrer leg paid");
});

test("rev9 turn-down: a buyer that names an owner as a 1 bps referrer cannot make its turn-down unrulable (review R2-1; 89ca18a: MultisigNotEnoughSigners)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const ownerB = Keypair.generate();
  const ownerC = Keypair.generate();
  w.svm.airdrop(ownerB.publicKey, 1_000_000_000n);
  await setMultisig(w.svm, [w.admin.publicKey, ownerB.publicKey, ownerC.publicKey], 2);
  const t = await freeze(w, await hiredReviewTask(w, { referrer: ownerB.publicKey, referrerFeeBps: 1 }));
  expectOk(send(w.svm, await disputeIx(w, t), [w.provider]), "the provider disputes the turn-down");
  expectOk(send(w.svm, await resolveIx(w, t, true, [w.admin, ownerB]), [w.admin, ownerB]),
    "the admin and owner B rule for the worker");
  assert.equal(status(w, t.task), "Completed", "ruled and paid");
});

// ---------------------------------------------------------------------------
// 11.1 item 8. fed99ab: a 1-second review window gave the worker 1 second.
// ---------------------------------------------------------------------------
test("rev9 turn-down: a 1-second review window still gives 24 hours to resubmit and 72 hours to dispute (fed99ab: no extension, 1 second)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const t = await reviewTask(w, { reviewWindow: 1, deadlineSecs: 600 });
  expectOk(send(w.svm, await t.creatorProg.methods
    .requestChanges(arr(Buffer.alloc(32, 4)))
    .accounts({ task: t.task, claim: t.claim, taskValidationConfig: t.validation, taskSubmission: t.submission,
      protocolConfig: w.protocolPda, creator: t.creator.publicKey })
    .instruction(), [t.creator]), "request changes");
  const changedAt = now(w);
  assert.equal(Number(decode(w.svm, "TaskClaim", t.claim).expires_at.toString()), changedAt + RESUBMIT_FLOOR, "the claim lives 24 hours");
  assert.equal(Number(decode(w.svm, "Task", t.task).deadline.toString()), changedAt + RESUBMIT_FLOOR, "the task deadline is 24 hours out");

  warpTo(w, changedAt + RESUBMIT_FLOOR - 1);
  expectOk(send(w.svm, await submitIx(w, t), [w.provider]), "resubmit near the end of the 24 hours");
  await freeze(w, t);
  assert.equal(t.disputeDeadline - t.freezeAt, DISPUTE_WINDOW, "72 hours to dispute despite a 1-second review window");
});

// ---------------------------------------------------------------------------
// 11.1 item 9 + lead check 5 (compatibility): a freeze made before the upgrade
// (an injected freeze_kind = 0) keeps revision 8 rules in both exits.
// ---------------------------------------------------------------------------
test("rev9 turn-down: an injected revision 8 freeze keeps the revision 8 timeout: it pays the worker after the review window (compatibility, holds on fed99ab)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const t = await frozenTask(w);
  await injectRevision8Freeze(w, t.submission, 3600);
  const cranker = crankerFor(w);
  warpTo(w, t.freezeAt + 3600);
  expectFail(send(w.svm, await expireIx(w, t, cranker), [cranker]), "RejectFrozenTimeoutNotElapsed", "revision 8 timeout not elapsed at the deadline");
  warpTo(w, t.freezeAt + 3601);
  const before = snapshot(w, t);
  expectOk(send(w.svm, await expireIx(w, t, cranker), [cranker]), "revision 8 timeout");
  const d = deltas(w, t, before);
  assert.equal(status(w, t.task), "Completed", "the revision 8 timeout completes the task");
  assert.ok(d.treasury > 0n, "protocol fee charged");
  assert.equal(d.worker + d.treasury, BigInt(t.reward) + before.claimRent + before.submissionRent, "the worker gets the price less the fee, plus its rents");
  assert.equal(d.buyer, before.escrow - BigInt(t.reward), "the buyer gets the escrow rent only");
});

test("rev9 turn-down: an injected revision 8 freeze is not disputable and the multisig rules on it without a dispute (fed99ab: unknown instructions)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const { owner2 } = await multisig(w);
  const t = await frozenTask(w);
  await injectRevision8Freeze(w, t.submission, 3600);
  expectFail(send(w.svm, await disputeIx(w, t), [w.provider]), "RejectionNotDisputable", "a revision 8 freeze is not disputable");
  const before = snapshot(w, t);
  expectOk(send(w.svm, await resolveIx(w, t, false, [w.admin, owner2]), [w.admin, owner2]), "revision 8 freeze ruled without a dispute");
  assert.equal(status(w, t.task), "Cancelled", "rejection upheld");
  assert.equal(deltas(w, t, before).buyer, before.escrow, "buyer refunded the price and escrow rent");
});

// ---------------------------------------------------------------------------
// Lead check 1: "no bond" is ownership, never balance. Pre-funding the bond
// address must block neither the undisputed refund nor a later dispute.
// ---------------------------------------------------------------------------
test("rev9 turn-down: a pre-funded empty bond address blocks neither the refund nor a dispute (fed99ab: worker paid, no dispute)", async () => {
  {
    const prefund = 3_000_000n;
    const w = await freshWorld({ moderationEnabled: true });
    const t = await frozenTask(w);
    const bondPda = disputeBondPda(t.task);
    systemAccount(w, bondPda, prefund);
    warpTo(w, t.disputeDeadline + 1);
    const cranker = crankerFor(w);
    const before = snapshot(w, t);
    expectOk(send(w.svm, await expireIx(w, t, cranker), [cranker]), "refund over a pre-funded bond address");
    const d = deltas(w, t, before);
    assert.equal(status(w, t.task), "Cancelled", "refunded, not paid out");
    assert.equal(d.buyer, before.escrow, "buyer refunded exactly");
    assert.equal(d.worker, before.claimRent + before.submissionRent, "worker gets its rents only");
    assert.equal(bal(w, bondPda), prefund, "the sender's lamports stay where they were sent");
  }
  {
    const prefund = 1_000_000n; // below the bond account's rent
    const w = await freshWorld({ moderationEnabled: true });
    const t = await frozenTask(w);
    const bondPda = disputeBondPda(t.task);
    systemAccount(w, bondPda, prefund);
    const bondRent = rent(w, BOND_SIZE);
    const workerBefore = bal(w, w.provider.publicKey);
    expectOk(send(w.svm, await disputeIx(w, t), [w.provider]), "dispute over a pre-funded address");
    // init tops up only the rent shortfall; the worker posts the full bond.
    assert.equal(workerBefore - bal(w, w.provider.publicKey), BOND_FLOOR + bondRent - prefund + TX_FEE, "the worker pays the rent shortfall, the bond and the fee");
    assert.equal(bal(w, bondPda), bondRent + BOND_FLOOR, "bond account: rent plus principal");
    const rulingDeadline = Number(decode(w.svm, "DisputeBond", bondPda).ruling_deadline.toString());
    warpTo(w, rulingDeadline + 1);
    const cranker = crankerFor(w);
    const before = snapshot(w, t);
    expectOk(send(w.svm, await expireIx(w, t, cranker), [cranker]), "unruled refund");
    assert.equal(deltas(w, t, before).worker, before.bond + before.claimRent + before.submissionRent, "the worker gets the whole bond account back");
  }
});

// ---------------------------------------------------------------------------
// Exit gate: a pause cannot make the worker miss its window or lock the refund.
// A suspended worker cannot dispute; the default refund then applies. Busy and
// Inactive are availability flags the worker sets itself, not sanctions, so they
// keep the dispute (review R2-2).
// ---------------------------------------------------------------------------
test("rev9 turn-down: a pause stops neither the dispute nor the unruled refund (fed99ab: unknown instruction)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const t = await frozenTask(w);
  await setProtocolPaused(w.svm, true);
  w.svm.expireBlockhash();
  expectOk(send(w.svm, await disputeIx(w, t), [w.provider]), "dispute while paused");
  const rulingDeadline = Number(decode(w.svm, "DisputeBond", disputeBondPda(t.task)).ruling_deadline.toString());
  warpTo(w, rulingDeadline + 1);
  const cranker = crankerFor(w);
  expectOk(send(w.svm, await expireIx(w, t, cranker), [cranker]), "unruled refund while paused");
  assert.equal(status(w, t.task), "Cancelled", "refunded");
});

test("rev9 turn-down: a suspended worker cannot dispute, AgentSuspended (fed99ab: unknown instruction; review R2-2, 639a4c0: AgentNotActive)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const t = await frozenTask(w);
  const acct = w.svm.getAccount(w.providerAgent);
  const agent = decode(w.svm, "AgentRegistration", w.providerAgent);
  agent.status = { Suspended: {} };
  const data = Buffer.from(acct.data);
  (await coder.accounts.encode("AgentRegistration", agent)).copy(data, 0);
  w.svm.setAccount(w.providerAgent, { ...acct, data });
  expectFail(send(w.svm, await disputeIx(w, t), [w.provider]), "AgentSuspended", "a suspended worker cannot dispute");
  assert.ok(isClosed(w.svm, disputeBondPda(t.task)), "no bond");
});

function setStatusIx(w, statusCode) {
  return w.providerProg.methods.updateAgent(null, null, null, statusCode)
    .accounts({ agent: w.providerAgent, authority: w.provider.publicKey }).instruction();
}

const agentStatus = (w) => Object.keys(decode(w.svm, "AgentRegistration", w.providerAgent).status)[0];

function suspensionIx(w, method, approvals) {
  return makeProgram(w.admin).methods[method]()
    .accounts({ agent: w.providerAgent, protocolConfig: w.protocolPda, authority: w.admin.publicKey })
    .remainingAccounts(approvals.remainingAccounts)
    .instruction();
}

// Review R2-2. The frozen claim keeps `active_tasks` at 1 until a frozen exit
// runs, so a worker that is Busy or Inactive cannot make itself Active again.
test("rev9 turn-down: a Busy or an Inactive worker still disputes; it cannot become Active while the frozen claim is held (review R2-2; 639a4c0: AgentNotActive)", async () => {
  for (const [label, code] of [["Busy", 2], ["Inactive", 0]]) {
    const w = await freshWorld({ moderationEnabled: true });
    const t = await frozenTask(w);
    expectOk(send(w.svm, await setStatusIx(w, code), [w.provider]), `the worker sets itself ${label}`);
    assert.equal(agentStatus(w), label, label);
    warpTo(w, now(w) + 61); // past update_agent's cooldown
    expectFail(send(w.svm, await setStatusIx(w, 1), [w.provider]), "AgentBusyWithTasks",
      `a ${label} worker cannot become Active while the frozen claim is held`);
    const workerBefore = bal(w, w.provider.publicKey);
    expectOk(send(w.svm, await disputeIx(w, t), [w.provider]), `a ${label} worker disputes the freeze`);
    const bond = decode(w.svm, "DisputeBond", disputeBondPda(t.task));
    assert.equal(bond.filer.toBase58(), w.provider.publicKey.toBase58(), "the worker filed");
    assert.equal(workerBefore - bal(w, w.provider.publicKey), BOND_FLOOR + rent(w, BOND_SIZE) + TX_FEE, "the worker posted the bond");
    assert.equal(status(w, t.task), "RejectFrozen", "the task stays frozen for the ruling");
  }
});

test("rev9 turn-down: a worker suspended inside the window cannot dispute until it is unsuspended, then it can (review R2-2; 639a4c0: AgentNotActive)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const t = await frozenTask(w);
  const approvals = await configureTestMultisig(w);
  expectOk(send(w.svm, await suspensionIx(w, "suspendAgent", approvals), approvalSigners(approvals, w.admin)), "2 of 3 suspend");
  expectFail(send(w.svm, await disputeIx(w, t), [w.provider]), "AgentSuspended", "a suspended worker cannot dispute");
  assert.ok(isClosed(w.svm, disputeBondPda(t.task)), "no bond");
  w.svm.expireBlockhash();
  expectOk(send(w.svm, await suspensionIx(w, "unsuspendAgent", approvals), approvalSigners(approvals, w.admin)), "2 of 3 unsuspend");
  assert.equal(agentStatus(w), "Inactive", "unsuspend leaves the worker Inactive");
  warpTo(w, now(w) + 61);
  expectFail(send(w.svm, await setStatusIx(w, 1), [w.provider]), "AgentBusyWithTasks", "it cannot become Active while the frozen claim is held");
  w.svm.expireBlockhash();
  expectOk(send(w.svm, await disputeIx(w, t), [w.provider]), "the unsuspended worker disputes inside the window");
  assert.ok(now(w) < t.disputeDeadline, "still inside the dispute window");
  assert.equal(decode(w.svm, "DisputeBond", disputeBondPda(t.task)).filer.toBase58(), w.provider.publicKey.toBase58());
});

// ---------------------------------------------------------------------------
// Review R1-7. The exits read the freeze's rules from the submission they are
// given, so they accept only the frozen one (status Rejected). Unreachable on
// live state (a new Exclusive task has one worker, and the older multi-worker
// ones are past their deadline), so a second worker's live claim and a
// Submitted, revision 8 shaped submission are injected on a frozen task.
// ---------------------------------------------------------------------------
async function injectOtherSubmission(w, t) {
  const kp = Keypair.generate();
  w.svm.airdrop(kp.publicKey, 10_000_000_000n);
  const agentId = id32();
  const [agent] = pda([enc("agent"), agentId]);
  expectOk(send(w.svm, await makeProgram(kp).methods
    .registerAgent(arr(agentId), new BN(1), "http://other-worker.test", null, new BN(0))
    .accounts({ agent, protocolConfig: w.protocolPda, authority: kp.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [kp]), "register a second worker");
  const [claim, claimBump] = pda([enc("claim"), t.task.toBuffer(), agent.toBuffer()]);
  const c = decode(w.svm, "TaskClaim", t.claim);
  c.worker = agent;
  c.bump = claimBump;
  const claimData = await coder.accounts.encode("TaskClaim", c);
  w.svm.setAccount(claim, { lamports: Number(rent(w, claimData.length)), data: claimData, owner: PID, executable: false, rentEpoch: 0 });
  const [submission, submissionBump] = pda([enc("task_submission"), claim.toBuffer()]);
  const sub = decode(w.svm, "TaskSubmission", t.submission);
  sub.claim = claim;
  sub.worker = agent;
  sub.status = { Submitted: {} };
  sub.bump = submissionBump;
  sub._reserved[2] = 0; // a revision 8 shape: the expiry would pay its worker
  sub.review_deadline_at = new BN(now(w) - 1);
  const subData = await coder.accounts.encode("TaskSubmission", sub);
  w.svm.setAccount(submission, { lamports: Number(rent(w, subData.length)), data: subData, owner: PID, executable: false, rentEpoch: 0 });
  // Counters as a real second claim leaves them: one more worker on the task,
  // one active task on the second agent.
  for (const [address, name, edit] of [
    [t.task, "Task", (v) => { v.current_workers += 1; }],
    [agent, "AgentRegistration", (v) => { v.active_tasks += 1; }],
  ]) {
    const acct = w.svm.getAccount(address);
    const value = decode(w.svm, name, address);
    edit(value);
    const data = Buffer.from(acct.data);
    (await coder.accounts.encode(name, value)).copy(data, 0);
    w.svm.setAccount(address, { ...acct, data });
  }
  return { kp, agent, claim, submission };
}

function otherExitAccounts(w, t, o, authority) {
  return { ...exitAccounts(w, t, authority), claim: o.claim, taskSubmission: o.submission, worker: o.agent,
    workerAuthority: o.kp.publicKey, workerCompletionBond: completionBond(t.task, o.kp.publicKey),
    workerStats: agentStatsPda(o.agent) };
}

test("rev9 turn-down: expire_reject_frozen refuses a submission that is not the frozen one (review R1-7; e03a1f1: pays the other worker under revision 8 rules)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const t = await frozenTask(w);
  const other = await injectOtherSubmission(w, t);
  const cranker = crankerFor(w);
  const otherBefore = bal(w, other.kp.publicKey);
  expectFail(send(w.svm, await makeProgram(cranker).methods.expireRejectFrozen()
    .accounts(otherExitAccounts(w, t, other, cranker.publicKey)).instruction(), [cranker]),
    "TaskSubmissionRequired", "another worker's Submitted submission");
  assert.equal(bal(w, other.kp.publicKey), otherBefore, "the other worker is paid nothing");
  assert.equal(status(w, t.task), "RejectFrozen", "still frozen");
  // The frozen submission still settles: no dispute, the buyer is refunded after the window.
  warpTo(w, t.disputeDeadline + 1);
  expectOk(send(w.svm, await expireIx(w, t, cranker), [cranker]), "the frozen submission's refund");
  assert.equal(status(w, t.task), "Cancelled", "refunded");
});

test("rev9 turn-down: resolve_reject_frozen refuses a submission that is not the frozen one (review R1-7; e03a1f1: rules for the other worker without a dispute)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const t = await frozenTask(w);
  const other = await injectOtherSubmission(w, t);
  const { owner2 } = await multisig(w);
  const otherBefore = bal(w, other.kp.publicKey);
  expectFail(send(w.svm, await rev9(w.admin).methods
    .resolveRejectFrozen(true, arr(Buffer.alloc(32, 5)), "agenc://ruling/rev9")
    .accounts(otherExitAccounts(w, t, other, w.admin.publicKey))
    .remainingAccounts([w.admin, owner2].map((k) => ({ pubkey: k.publicKey, isSigner: true, isWritable: false })))
    .instruction(), [w.admin, owner2]),
    "TaskSubmissionRequired", "a ruling over another worker's Submitted submission");
  assert.equal(bal(w, other.kp.publicKey), otherBefore, "the other worker is paid nothing");
  assert.equal(status(w, t.task), "RejectFrozen", "still frozen");
});
