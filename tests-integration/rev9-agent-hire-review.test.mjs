// Revision 9 (D): review for agent buyers. Design: REV9-DESIGN.md sections 4 and 11.4.
//
// A hire through `hire_from_listing` (the door for a buyer that owns an agent) gets
// creator review exactly like the bare-wallet door: the v3 wire takes the buyer's
// review window and creates a CreatorReview config, the provider submits, and the
// buying agent's wallet accepts, asks for changes, freezes or lets auto-accept run.
// `complete_task` no longer pays these hires.
//
// Executes the COMPILED program. The v3 hire is built from the committed revision 9
// IDL (run-on-fed99ab swaps only target/idl), so fed99ab rejects it as unknown: its
// only agent-door hire is the v2 wire, which creates no config and pays on
// complete_task.
//
// Run: node --test tests-integration/rev9-agent-hire-review.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  REPO, enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode, isClosed,
  freshWorld, listingModV2Pda, taskModV2Pda, moderationBlockPda,
  agentStatsPda, creatorStatsPda, disputeBondPda,
  Program, AnchorProvider, Wallet, Connection, BN, Keypair, SystemProgram,
} from "./harness.mjs";

const REV9_IDL = JSON.parse(fs.readFileSync(path.join(REPO, "artifacts/anchor/idl/agenc_coordination.json"), "utf8"));
if (!REV9_IDL.instructions.find((ix) => ix.name === "hire_from_listing")?.args.some((a) => a.name === "review_window_secs")) {
  throw new Error("artifacts/anchor/idl/agenc_coordination.json is not the revision 9 IDL; run npm run artifacts:refresh");
}
const rev9 = (payer) => new Program(REV9_IDL, new AnchorProvider(
  new Connection("http://127.0.0.1:9999"), new Wallet(payer), { commitment: "processed" }));

const TX_FEE = 5_000n;
const bal = (w, key) => BigInt(w.svm.getBalance(key) ?? 0n);
const rentOf = (w, key) => BigInt(w.svm.minimumBalanceForRentExemption(BigInt(w.svm.getAccount(key).data.length)));
const completionBond = (task, wallet) => pda([enc("completion_bond"), task.toBuffer(), wallet.toBuffer()])[0];
const status = (w, task) => Object.keys(decode(w.svm, "Task", task).status)[0];

function warpTo(w, unixTimestamp) {
  const c = w.svm.getClock();
  c.unixTimestamp = BigInt(unixTimestamp);
  w.svm.setClock(c);
  w.svm.expireBlockhash();
}

async function attestListing(w) {
  const [listingMod] = listingModV2Pda(w.listing, w.specHash, w.modAuth.publicKey);
  if (isClosed(w.svm, listingMod)) {
    expectOk(send(w.svm, await makeProgram(w.modAuth).methods
      .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
      .accounts({ moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
      .instruction(), [w.modAuth]), "ah:listing-mod");
  }
  return listingMod;
}

// The v3 agent-door hire (built from the revision 9 IDL).
async function hireV3Ix(w, { reviewWindowSecs = 3600, referrer = null, referrerFeeBps = 0 } = {}) {
  const listingMod = await attestListing(w);
  const taskId = id32();
  const jobHash = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const t = {
    task, jobHash,
    escrow: pda([enc("escrow"), task.toBuffer()])[0],
    hireRecord: pda([enc("hire"), task.toBuffer()])[0],
    validation: pda([enc("task_validation"), task.toBuffer()])[0],
  };
  t.ix = await rev9(w.buyer).methods
    .hireFromListing(arr(taskId), new BN(w.price), new BN(1), new BN(reviewWindowSecs), referrer, referrerFeeBps, w.modAuth.publicKey, arr(jobHash))
    .accounts({ task, escrow: t.escrow, hireRecord: t.hireRecord, taskValidationConfig: t.validation,
      listing: w.listing, providerAgent: w.providerAgent, protocolConfig: w.protocolPda,
      moderationConfig: w.modCfg, listingModeration: listingMod, moderationAttestor: null,
      moderationBlock: moderationBlockPda(w.specHash)[0], creatorAgent: w.buyerAgent,
      authorityRateLimit: pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()])[0],
      authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction();
  return t;
}

// Hire, publish the job spec, and have the provider claim (and optionally submit).
async function hiredClaimed(w, opts = {}) {
  const t = await hireV3Ix(w, opts);
  expectOk(send(w.svm, t.ix, [w.buyer]), "ah:v3 hire");
  const [taskMod] = taskModV2Pda(t.task, t.jobHash, w.modAuth.publicKey);
  t.jobSpec = pda([enc("task_job_spec"), t.task.toBuffer()])[0];
  expectOk(send(w.svm, await makeProgram(w.modAuth).methods
    .recordTaskModeration(arr(t.jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task: t.task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "ah:task-mod");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(t.jobHash), "agenc://job-spec/sha256/rev9-agent-hire", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task: t.task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null,
      moderationBlock: moderationBlockPda(t.jobHash)[0], taskJobSpec: t.jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "ah:publish");
  t.claim = pda([enc("claim"), t.task.toBuffer(), w.providerAgent.toBuffer()])[0];
  t.submission = pda([enc("task_submission"), t.claim.toBuffer()])[0];
  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task: t.task, taskJobSpec: t.jobSpec, hireRecord: t.hireRecord, legacyListing: null,
      moderationBlock: moderationBlockPda(t.jobHash)[0], claim: t.claim, protocolConfig: w.protocolPda,
      worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId,
      workerStats: agentStatsPda(w.providerAgent) })
    .instruction(), [w.provider]), "ah:claim");
  return t;
}

function submitIx(w, t) {
  return w.providerProg.methods
    .submitTaskResult(arr(id32()), arr(Buffer.concat([Buffer.alloc(63), Buffer.from([7])])))
    .accounts({ task: t.task, claim: t.claim, taskValidationConfig: t.validation, taskSubmission: t.submission,
      protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction();
}

function settleAccounts(w, t, { operator = w.operator ?? null, referrer = null } = {}) {
  return { task: t.task, claim: t.claim, escrow: t.escrow, taskValidationConfig: t.validation, taskSubmission: t.submission,
    worker: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, creator: w.buyer.publicKey,
    workerAuthority: w.provider.publicKey, hireRecord: t.hireRecord, operator, referrer,
    creatorCompletionBond: completionBond(t.task, w.buyer.publicKey), workerCompletionBond: completionBond(t.task, w.provider.publicKey),
    tokenEscrowAta: null, workerTokenAccount: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null,
    systemProgram: SystemProgram.programId };
}

// ---------------------------------------------------------------------------
// 11.4 item 1. fed99ab: the agent-door hire creates no config (Auto mode).
// ---------------------------------------------------------------------------
test("rev9 agent hire: the v3 hire creates a CreatorReview config with the buyer's window and marks the task manual (fed99ab: unknown v3)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const t = await hireV3Ix(w, { reviewWindowSecs: 7_200 });
  const before = bal(w, w.buyer.publicKey);
  expectOk(send(w.svm, t.ix, [w.buyer]), "v3 hire");
  const vc = decode(w.svm, "TaskValidationConfig", t.validation);
  assert.ok(vc, "the hire created the validation config");
  assert.ok(vc.mode.CreatorReview !== undefined, "mode CreatorReview");
  assert.equal(Number(vc.review_window_secs.toString()), 7_200, "the buyer's review window");
  assert.equal(vc.creator.toBase58(), w.buyer.publicKey.toBase58(), "config creator is the buyer wallet");
  assert.equal(vc.task.toBase58(), t.task.toBase58(), "bound to the task");
  assert.deepEqual(Buffer.from(decode(w.svm, "Task", t.task).constraint_hash), Buffer.from("agenc-manual-validation-v2-seed!"),
    "the manual-validation sentinel is set");
  // The buyer paid the price plus every new account's rent, including the config
  // (and its first rate-limit record).
  const rateLimit = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()])[0];
  const rents = [t.task, t.escrow, t.hireRecord, t.validation, rateLimit].reduce((sum, key) => sum + bal(w, key), 0n) - BigInt(w.price);
  assert.equal(before - bal(w, w.buyer.publicKey), BigInt(w.price) + rents + TX_FEE, "price, the rents (config included) and the fee");
  // The hire's config cannot be reconfigured.
  expectFail(send(w.svm, await w.buyerProg.methods
    .configureTaskValidation(1, new BN(60), 0, null)
    .accounts({ task: t.task, taskValidationConfig: t.validation, taskAttestorConfig: pda([enc("task_attestor"), t.task.toBuffer()])[0],
      protocolConfig: w.protocolPda, hireRecord: t.hireRecord, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "HiredTaskValidationUnsupported", "a hire keeps its own config");
});

test("rev9 agent hire: the review window must be 1 second to 7 days (fed99ab: unknown v3)", async () => {
  for (const { window, ok } of [{ window: 0, ok: false }, { window: 1, ok: true }, { window: 604_800, ok: true }, { window: 604_801, ok: false }]) {
    const w = await freshWorld({ moderationEnabled: true });
    const t = await hireV3Ix(w, { reviewWindowSecs: window });
    const res = send(w.svm, t.ix, [w.buyer]);
    if (ok) expectOk(res, `window ${window}`);
    else expectFail(res, "InvalidReviewWindow", `window ${window} refused`);
  }
});

// ---------------------------------------------------------------------------
// 11.4 item 2. fed99ab: complete_task pays the hire at once.
// ---------------------------------------------------------------------------
test("rev9 agent hire: complete_task refuses the hire with ManualValidationRequiresReviewFlow (fed99ab: unknown v3, v2 hires pay on complete)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const t = await hiredClaimed(w);
  expectFail(send(w.svm, await w.providerProg.methods
    .completeTask(arr(id32()), null)
    .accounts({ task: t.task, claim: t.claim, escrow: t.escrow, creator: w.buyer.publicKey, worker: w.providerAgent,
      protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.provider.publicKey, systemProgram: SystemProgram.programId,
      tokenEscrowAta: null, workerTokenAccount: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null,
      hireRecord: t.hireRecord, operator: null, referrer: null, creatorCompletionBond: null, workerCompletionBond: null })
    .instruction(), [w.provider]), "ManualValidationRequiresReviewFlow", "the provider cannot pay itself");
  assert.equal(status(w, t.task), "InProgress", "nothing paid");
});

// ---------------------------------------------------------------------------
// 11.4 item 3. fed99ab: no review path for agent buyers.
// ---------------------------------------------------------------------------
test("rev9 agent hire: submit then accept pays the worker, the protocol fee, the operator and the referrer legs exactly (fed99ab: unknown v3)", async () => {
  const operator = Keypair.generate();
  const referrer = Keypair.generate();
  const w = await freshWorld({ moderationEnabled: true, price: 100_000_000, operator: operator.publicKey, operatorFeeBps: 1000 });
  w.svm.airdrop(referrer.publicKey, 1_000_000_000n);
  const t = await hiredClaimed(w, { referrer: referrer.publicKey, referrerFeeBps: 500 });
  expectOk(send(w.svm, await submitIx(w, t), [w.provider]), "submit");
  // Accept with an operator leg missing is refused: the review path keeps the legs.
  expectFail(send(w.svm, await w.buyerProg.methods.acceptTaskResult()
    .accounts(settleAccounts(w, t, { operator: null, referrer: referrer.publicKey })).instruction(), [w.buyer]),
    "MissingOperatorAccount", "accept cannot skip the operator");
  w.svm.expireBlockhash();

  const before = {
    worker: bal(w, w.provider.publicKey), buyer: bal(w, w.buyer.publicKey), treasury: bal(w, w.admin.publicKey),
    operator: bal(w, operator.publicKey), referrer: bal(w, referrer.publicKey),
    escrow: bal(w, t.escrow), claim: bal(w, t.claim), submission: bal(w, t.submission),
  };
  expectOk(send(w.svm, await w.buyerProg.methods.acceptTaskResult()
    .accounts(settleAccounts(w, t, { operator: operator.publicKey, referrer: referrer.publicKey })).instruction(), [w.buyer]), "accept");
  const price = BigInt(w.price);
  const d = {
    worker: bal(w, w.provider.publicKey) - before.worker, buyer: bal(w, w.buyer.publicKey) - before.buyer,
    treasury: bal(w, w.admin.publicKey) - before.treasury, operator: bal(w, operator.publicKey) - before.operator,
    referrer: bal(w, referrer.publicKey) - before.referrer,
  };
  assert.equal(status(w, t.task), "Completed", "paid through accept");
  assert.equal(d.operator, price * 1000n / 10_000n, "operator: its exact 10% leg");
  assert.equal(d.referrer, price * 500n / 10_000n, "referrer: its exact 5% leg");
  assert.ok(d.treasury > 0n && d.treasury <= price / 100n, "treasury: the protocol fee (at most 1% here)");
  assert.equal(d.worker, price - d.operator - d.referrer - d.treasury + before.claim + before.submission,
    "worker: the price less every leg, plus its claim and submission rent");
  assert.equal(d.buyer, before.escrow - price - TX_FEE, "buyer: the escrow rent back, less its fee");
});

// ---------------------------------------------------------------------------
// 11.4 item 4. fed99ab: no change request, freeze or dispute for agent buyers.
// ---------------------------------------------------------------------------
test("rev9 agent hire: the buying agent asks for changes, then freezes, and the provider disputes the freeze (fed99ab: unknown v3)", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 100_000_000 });
  const t = await hiredClaimed(w);
  expectOk(send(w.svm, await submitIx(w, t), [w.provider]), "submit");
  expectOk(send(w.svm, await w.buyerProg.methods
    .requestChanges(arr(Buffer.alloc(32, 4)))
    .accounts({ task: t.task, claim: t.claim, taskValidationConfig: t.validation, taskSubmission: t.submission,
      protocolConfig: w.protocolPda, creator: w.buyer.publicKey })
    .instruction(), [w.buyer]), "request changes");
  expectOk(send(w.svm, await submitIx(w, t), [w.provider]), "resubmit");
  expectOk(send(w.svm, await w.buyerProg.methods
    .rejectAndFreeze(arr(Buffer.alloc(32, 7)))
    .accounts({ task: t.task, claim: t.claim, taskValidationConfig: t.validation, taskSubmission: t.submission,
      protocolConfig: w.protocolPda, creator: w.buyer.publicKey, agentStats: agentStatsPda(w.providerAgent),
      systemProgram: SystemProgram.programId, creatorStats: creatorStatsPda(w.buyer.publicKey) })
    .instruction(), [w.buyer]), "freeze");
  assert.equal(status(w, t.task), "RejectFrozen", "frozen");
  // A single-worker review task: refusing it by plain reject or by a task dispute is closed.
  expectOk(send(w.svm, await rev9(w.provider).methods
    .disputeRejection(arr(Buffer.alloc(32, 3)), "agenc://evidence/agent-hire")
    .accounts({ task: t.task, claim: t.claim, taskSubmission: t.submission, worker: w.providerAgent,
      disputeBond: disputeBondPda(t.task), creatorStats: creatorStatsPda(w.buyer.publicKey),
      protocolConfig: w.protocolPda, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "the provider disputes the freeze");
  assert.equal(BigInt(decode(w.svm, "DisputeBond", disputeBondPda(t.task)).amount.toString()), 10_000_000n, "bond: 10% of 0.1 SOL");
});

// ---------------------------------------------------------------------------
// 11.4 item 5. fed99ab: no review window, so nothing to auto-accept.
// ---------------------------------------------------------------------------
test("rev9 agent hire: auto-accept pays the provider once the review window ends, not before (1-second window) (fed99ab: unknown v3)", async () => {
  const operator = Keypair.generate();
  const w = await freshWorld({ moderationEnabled: true, price: 100_000_000, operator: operator.publicKey, operatorFeeBps: 1000 });
  const t = await hiredClaimed(w, { reviewWindowSecs: 1 });
  expectOk(send(w.svm, await submitIx(w, t), [w.provider]), "submit");
  const deadline = Number(decode(w.svm, "TaskSubmission", t.submission).review_deadline_at.toString());
  const cranker = Keypair.generate();
  w.svm.airdrop(cranker.publicKey, 1_000_000_000n);
  const autoAcceptIx = async () => makeProgram(cranker).methods.autoAcceptTaskResult()
    .accounts({ ...settleAccounts(w, t, { operator: operator.publicKey }), authority: cranker.publicKey }).instruction();
  warpTo(w, deadline - 1);
  expectFail(send(w.svm, await autoAcceptIx(), [cranker]), "ReviewWindowNotElapsed", "no auto-accept inside the window");
  warpTo(w, deadline); // auto-accept opens at the review deadline itself
  const before = { worker: bal(w, w.provider.publicKey), operator: bal(w, operator.publicKey) };
  expectOk(send(w.svm, await autoAcceptIx(), [cranker]), "auto-accept after the window");
  assert.equal(status(w, t.task), "Completed", "paid by auto-accept");
  assert.equal(bal(w, operator.publicKey) - before.operator, BigInt(w.price) * 1000n / 10_000n, "operator leg paid");
  assert.ok(bal(w, w.provider.publicKey) - before.worker > BigInt(w.price) / 2n, "provider paid");
  assert.ok(isClosed(w.svm, t.escrow), "escrow closed");
});
