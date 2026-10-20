// In-process litesvm integration tests: marketplace payees below the rent floor
// (AGNC-02 follow-up).
//
// The runtime fails a transaction that leaves a credited account below
// Rent::minimum_balance(data_len) (InsufficientFundsForRent). An operator or
// referrer fee smaller than that floor, owed to an unfunded payee, therefore
// reverted every payout path until someone funded the payee: the worker had to
// pay rent to an address the creator (referrer) or provider (operator) chose.
// Settlement now forfeits such a leg to the worker and emits
// MarketplaceFeeForfeited, on complete/accept, dispute and ghost-share paths.
//
// REVERT-SENSITIVE INTENT: litesvm does not enforce the rent floor on 0-byte
// accounts, so the unfixed program "pays" these unfunded payees. Every
// forfeiture assertion below (payee balance unchanged, worker keeps the leg,
// forfeit event) fails against it.
//
// Run:  cd agenc-protocol && node --test tests-integration/payee-rent-floor.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  enc, arr, pda, id32, coder,
  makeProgram, send, sendMany, expectOk, expectFail, decode, isClosed,
  freshWorld, hireIx, seatTestAuthorityResolver,
  taskModV2Pda, listingModV2Pda, moderationBlockPda,
  BN, Keypair, SystemProgram,
} from "./harness.mjs";

const PROTOCOL_FEE_BPS = 100; // harness injectProtocolConfig
const TX_FEE = 5_000; // one signature
const OPERATOR = 0; // events.rs marketplace_fee_role
const REFERRER = 1;

const lamports = (w, key) => Number(w.svm.getBalance(key) ?? 0n);
const rentFloor = (w, dataLen = 0) => Number(w.svm.minimumBalanceForRentExemption(BigInt(dataLen)));
const bps = (amount, feeBps) => Math.floor((amount * feeBps) / 10_000);

function setLamports(w, key, amount) {
  w.svm.setAccount(key, { lamports: amount, data: new Uint8Array(0), owner: SystemProgram.programId, executable: false, rentEpoch: 0 });
}

function events(res, name) {
  return res.logs()
    .filter((line) => line.startsWith("Program data: "))
    .map((line) => coder.events.decode(line.slice("Program data: ".length)))
    .filter((event) => event?.name === name);
}

function forfeits(res) {
  return events(res, "MarketplaceFeeForfeited").map(({ data }) => ({
    role: data.role,
    payee: data.payee.toBase58(),
    amount: Number(data.amount),
    feeBps: data.fee_bps,
  }));
}

// ---------------------------------------------------------------------------
// Hire flow: listing hire (optional referrer) -> moderation -> publish -> claim.
// ---------------------------------------------------------------------------
async function hireAndClaim(w, { referrer = null, referrerFeeBps = 0 } = {}) {
  const modProg = makeProgram(w.modAuth);
  const [listingMod] = listingModV2Pda(w.listing, w.specHash, w.modAuth.publicKey);
  expectOk(send(w.svm, await modProg.methods
    .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "listing-mod");

  const { ix, task, escrow, hireRecord, taskJobSpecHash: jobHash } = await hireIx(w, { taskId: id32(), listingModeration: listingMod, referrer, referrerFeeBps });
  expectOk(send(w.svm, ix, [w.buyer]), "hire");

  const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "task-mod");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/rent-floor", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "publish");
  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, hireRecord, legacyListing: null,
      moderationBlock: moderationBlockPda(jobHash)[0], claim,
      protocolConfig: w.protocolPda, worker: w.providerAgent,
      authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "claim");
  return { task, escrow, hireRecord, claim };
}

function completeIx(w, r, referrer) {
  return w.providerProg.methods
    .completeTask(arr(id32()), null)
    .accounts({ task: r.task, claim: r.claim, escrow: r.escrow, creator: w.buyer.publicKey, worker: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.provider.publicKey, systemProgram: SystemProgram.programId, tokenEscrowAta: null, workerTokenAccount: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, hireRecord: r.hireRecord, operator: w.operator, referrer, creatorCompletionBond: null, workerCompletionBond: null })
    .instruction();
}

/// complete_task as the worker; returns the result and the worker's net payout
/// (wallet delta minus the returned claim rent, plus its own tx fee).
async function complete(w, r, referrer, { prepend = [] } = {}) {
  const claimRent = lamports(w, r.claim);
  const before = lamports(w, w.provider.publicKey);
  const ixs = [...prepend, await completeIx(w, r, referrer)];
  const res = expectOk(sendMany(w.svm, ixs, [w.provider]), "complete_task");
  const payout = lamports(w, w.provider.publicKey) - before - claimRent + TX_FEE;
  return { res, payout };
}

test("complete_task: an unfunded referrer's sub-floor fee stays with the worker", async () => {
  const reward = 4_000_000;
  const referrer = Keypair.generate().publicKey; // never funded
  const w = await freshWorld({ moderationEnabled: true, price: reward });
  const r = await hireAndClaim(w, { referrer, referrerFeeBps: 500 });
  const referrerFee = bps(reward, 500); // 200_000
  assert.ok(referrerFee < rentFloor(w), "the fee alone cannot make a 0-byte payee rent-exempt");

  // The payee account is still mandatory and bound to the snapshot: omitting or
  // swapping it fails instead of forfeiting the leg.
  expectFail(send(w.svm, await completeIx(w, r, null), [w.provider]), "MissingReferrerAccount", "complete with the referrer omitted");
  expectFail(send(w.svm, await completeIx(w, r, Keypair.generate().publicKey), [w.provider]), "InvalidReferrerAccount", "complete with another referrer");

  const treasuryBefore = lamports(w, w.admin.publicKey);
  const { res, payout } = await complete(w, r, referrer);

  const protocolFee = bps(reward, PROTOCOL_FEE_BPS);
  assert.equal(lamports(w, referrer), 0, "the unfunded referrer is not credited");
  assert.equal(payout, reward - protocolFee, "the worker keeps the referrer leg");
  assert.equal(lamports(w, w.admin.publicKey) - treasuryBefore, protocolFee, "protocol fee unchanged");
  assert.deepEqual(forfeits(res), [{ role: REFERRER, payee: referrer.toBase58(), amount: referrerFee, feeBps: 500 }]);
  assert.equal(events(res, "ReferrerFeePaid").length, 0, "no ReferrerFeePaid for a forfeited leg");
  assert.equal(Number(events(res, "RewardDistributed")[0].data.amount), reward - protocolFee);
  assert.ok(isClosed(w.svm, r.escrow), "escrow closed; the creator recovers only its rent");
});

test("complete_task: each leg is judged on its own payee; funded payees are still paid", async () => {
  const reward = 4_000_000;
  const protocolFee = bps(reward, PROTOCOL_FEE_BPS);
  const operatorFee = bps(reward, 1000); // 400_000
  const referrerFee = bps(reward, 500); // 200_000
  for (const { label, fundOperator, fundReferrer } of [
    { label: "funded operator, unfunded referrer", fundOperator: true, fundReferrer: false },
    { label: "unfunded operator, funded referrer", fundOperator: false, fundReferrer: true },
    { label: "both unfunded", fundOperator: false, fundReferrer: false },
  ]) {
    const operator = Keypair.generate().publicKey;
    const referrer = Keypair.generate().publicKey;
    const w = await freshWorld({ moderationEnabled: true, price: reward, operator, operatorFeeBps: 1000 });
    if (!fundOperator) setLamports(w, operator, 0); // freshWorld pre-funds the operator
    if (fundReferrer) w.svm.airdrop(referrer, BigInt(1e9));
    const r = await hireAndClaim(w, { referrer, referrerFeeBps: 500 });
    const operatorBefore = lamports(w, operator);
    const referrerBefore = lamports(w, referrer);

    const { res, payout } = await complete(w, r, referrer);

    const paidOperator = fundOperator ? operatorFee : 0;
    const paidReferrer = fundReferrer ? referrerFee : 0;
    assert.equal(lamports(w, operator) - operatorBefore, paidOperator, `${label}: operator delta`);
    assert.equal(lamports(w, referrer) - referrerBefore, paidReferrer, `${label}: referrer delta`);
    assert.equal(payout, reward - protocolFee - paidOperator - paidReferrer, `${label}: worker payout`);
    const expected = [];
    if (!fundOperator) expected.push({ role: OPERATOR, payee: operator.toBase58(), amount: operatorFee, feeBps: 1000 });
    if (!fundReferrer) expected.push({ role: REFERRER, payee: referrer.toBase58(), amount: referrerFee, feeBps: 500 });
    assert.deepEqual(forfeits(res), expected, `${label}: forfeit events`);
    assert.equal(events(res, "OperatorFeePaid").length, fundOperator ? 1 : 0, `${label}: OperatorFeePaid`);
    assert.equal(events(res, "ReferrerFeePaid").length, fundReferrer ? 1 : 0, `${label}: ReferrerFeePaid`);
  }
});

test("complete_task: a payee holding both legs is judged on their sum", async () => {
  // Operator 1500 bps + referrer 1000 bps to one unfunded payee. At 4_000_000
  // the legs sum to 1_000_000 (above the 0-byte floor) and are both paid; at
  // 2_000_000 they sum to 500_000 and are both forfeited.
  for (const [reward, paid] of [[4_000_000, true], [2_000_000, false]]) {
    const payee = Keypair.generate().publicKey;
    const w = await freshWorld({ moderationEnabled: true, price: reward, operator: payee, operatorFeeBps: 1500 });
    setLamports(w, payee, 0);
    const r = await hireAndClaim(w, { referrer: payee, referrerFeeBps: 1000 });
    const operatorFee = bps(reward, 1500);
    const referrerFee = bps(reward, 1000);
    assert.ok(operatorFee < rentFloor(w) && referrerFee < rentFloor(w), "neither leg reaches the floor alone");
    assert.equal(operatorFee + referrerFee >= rentFloor(w), paid);

    const { res, payout } = await complete(w, r, payee);

    const legs = operatorFee + referrerFee;
    assert.equal(lamports(w, payee), paid ? legs : 0, `reward ${reward}: shared payee balance`);
    assert.equal(payout, reward - bps(reward, PROTOCOL_FEE_BPS) - (paid ? legs : 0), `reward ${reward}: worker payout`);
    assert.equal(forfeits(res).length, paid ? 0 : 2, `reward ${reward}: forfeit events`);
  }
});

test("complete_task: a rent-paying payee is paid only when its fee lifts it to the floor", async () => {
  const reward = 4_000_000;
  for (const [referrerFeeBps, paid] of [[500, true], [125, false]]) {
    const referrer = Keypair.generate().publicKey;
    const w = await freshWorld({ moderationEnabled: true, price: reward });
    const start = rentFloor(w) - 100_000; // legacy rent-paying balance
    setLamports(w, referrer, start);
    const r = await hireAndClaim(w, { referrer, referrerFeeBps });
    const referrerFee = bps(reward, referrerFeeBps); // 200_000 or 50_000

    const { res, payout } = await complete(w, r, referrer);

    assert.equal(lamports(w, referrer), paid ? start + referrerFee : start, `${referrerFeeBps} bps: referrer balance`);
    assert.equal(payout, reward - bps(reward, PROTOCOL_FEE_BPS) - (paid ? referrerFee : 0), `${referrerFeeBps} bps: worker payout`);
    assert.equal(forfeits(res).length, paid ? 0 : 1, `${referrerFeeBps} bps: forfeit events`);
  }
});

test("complete_task: a payee funded earlier in the settlement transaction is paid", async () => {
  // Anyone who wants the leg paid can fund the payee first; the check reads the
  // payee's balance when settlement runs.
  const reward = 4_000_000;
  const referrer = Keypair.generate().publicKey;
  const w = await freshWorld({ moderationEnabled: true, price: reward });
  const r = await hireAndClaim(w, { referrer, referrerFeeBps: 500 });
  const floor = rentFloor(w);
  const referrerFee = bps(reward, 500);

  const { res, payout } = await complete(w, r, referrer, {
    prepend: [SystemProgram.transfer({ fromPubkey: w.provider.publicKey, toPubkey: referrer, lamports: floor })],
  });

  assert.equal(lamports(w, referrer), floor + referrerFee, "the topped-up referrer receives its fee");
  assert.equal(payout, reward - bps(reward, PROTOCOL_FEE_BPS) - referrerFee - floor, "the worker funded the top-up");
  assert.deepEqual(forfeits(res), []);
  assert.equal(events(res, "ReferrerFeePaid").length, 1);
});

// ---------------------------------------------------------------------------
// Dispute exits: pay_dispute_marketplace_legs (Complete and Split).
// ---------------------------------------------------------------------------
test("resolve_dispute: an unfunded referrer's leg stays with the worker on Complete and Split", async () => {
  const reward = 3_000_000;
  for (const [resolutionType, label] of [[1, "Complete"], [2, "Split"]]) {
    const operator = Keypair.generate().publicKey; // funded by freshWorld
    const referrer = Keypair.generate().publicKey; // never funded
    const w = await freshWorld({ moderationEnabled: true, price: reward, operator, operatorFeeBps: 1000 });
    const resolver = await seatTestAuthorityResolver(w);
    const r = await hireAndClaim(w, { referrer, referrerFeeBps: 500 });

    const disputeId = id32();
    const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
    expectOk(send(w.svm, await w.buyerProg.methods
      .initiateDispute(arr(disputeId), arr(decode(w.svm, "Task", r.task).task_id), arr(Buffer.alloc(32, 1)), resolutionType, "evidence")
      .accounts({ dispute, task: r.task, agent: w.buyerAgent, authorityRateLimit: pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()])[0], protocolConfig: w.protocolPda, initiatorClaim: null, workerAgent: w.providerAgent, workerClaim: r.claim, taskSubmission: null, authority: w.buyer.publicKey, systemProgram: SystemProgram.programId })
      .instruction(), [w.buyer]), `${label}: initiate`);

    const workerBefore = lamports(w, w.provider.publicKey);
    const operatorBefore = lamports(w, operator);
    const claimRent = lamports(w, r.claim);
    const res = expectOk(send(w.svm, await makeProgram(w.admin).methods
      .resolveDispute(true, arr(Buffer.alloc(32, 5)), "agenc://ruling/rent-floor")
      .accounts({
        dispute, task: r.task, escrow: r.escrow, protocolConfig: w.protocolPda, authority: w.admin.publicKey,
        resolverAssignment: resolver, creator: w.buyer.publicKey, workerClaim: r.claim,
        worker: w.providerAgent, workerWallet: w.provider.publicKey, agentStats: null,
        hireRecord: r.hireRecord, disputeOperator: operator, disputeReferrer: referrer,
        systemProgram: SystemProgram.programId,
        tokenEscrowAta: null, creatorTokenAccount: null, workerTokenAccountAta: null,
        treasuryTokenAccount: null, rewardMint: null, tokenProgram: null,
        creatorCompletionBond: pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0],
        workerCompletionBond: pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()])[0],
        bondTreasury: w.admin.publicKey,
        taskSubmission: pda([enc("task_submission"), r.claim.toBuffer()])[0],
        taskValidationConfig: null,
      })
      .instruction(), [w.admin]), `${label}: resolve`);

    // Disputes take no protocol fee; the legs are carved from the worker's gross
    // (the whole reward on Complete, half of it on Split).
    const gross = resolutionType === 1 ? reward : reward / 2;
    const operatorFee = bps(gross, 1000);
    const referrerFee = bps(gross, 500);
    assert.equal(lamports(w, referrer), 0, `${label}: unfunded referrer not credited`);
    assert.equal(lamports(w, operator) - operatorBefore, operatorFee, `${label}: funded operator paid`);
    assert.equal(lamports(w, w.provider.publicKey) - workerBefore, gross - operatorFee + claimRent, `${label}: worker keeps the referrer leg`);
    assert.deepEqual(forfeits(res), [{ role: REFERRER, payee: referrer.toBase58(), amount: referrerFee, feeBps: 500 }], `${label}: forfeit event`);
    assert.equal(events(res, "OperatorFeePaid").length, 1, `${label}: OperatorFeePaid`);
    assert.equal(events(res, "ReferrerFeePaid").length, 0, `${label}: no ReferrerFeePaid`);
  }
});

// ---------------------------------------------------------------------------
// Contest ghost-split: distribute_ghost_share.
// ---------------------------------------------------------------------------
const SELECTION_WINDOW_SECS = 172_800; // constants.rs::SELECTION_WINDOW_SECS

async function registerAgent(w) {
  const kp = Keypair.generate();
  w.svm.airdrop(kp.publicKey, BigInt(10e9));
  const prog = makeProgram(kp);
  const agentId = id32();
  const [agentPda] = pda([enc("agent"), agentId]);
  expectOk(send(w.svm, await prog.methods
    .registerAgent(arr(agentId), new BN(1), "http://contest.test", null, new BN(0))
    .accounts({ agent: agentPda, protocolConfig: w.protocolPda, authority: kp.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [kp]), "register agent");
  return { kp, prog, agentPda };
}

test("distribute_ghost_share: an unfunded referrer's slice fees stay with each submitter", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const reward = 2_000_000;
  const referrer = Keypair.generate().publicKey; // never funded

  // Competitive + CreatorReview contest with a referrer leg (create_task).
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [validation] = pda([enc("task_validation"), task.toBuffer()]);
  const deadline = Number(w.svm.getClock().unixTimestamp) + 3600;
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(reward), 2, new BN(deadline), 2, null, 0, null, referrer, 500)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()])[0], authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "contest create_task");
  expectOk(send(w.svm, await w.buyerProg.methods
    .configureTaskValidation(1, new BN(3600), 0, null)
    .accounts({ task, taskValidationConfig: validation, taskAttestorConfig: pda([enc("task_attestor"), task.toBuffer()])[0], protocolConfig: w.protocolPda, hireRecord: pda([enc("hire"), task.toBuffer()])[0], creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "configure CreatorReview");

  const jobHash = id32();
  const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  expectOk(send(w.svm, await makeProgram(w.modAuth).methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "contest task-mod");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/rent-floor-contest", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "contest publish");

  const entrants = [];
  for (let i = 0; i < 2; i++) {
    const agent = await registerAgent(w);
    const [claim] = pda([enc("claim"), task.toBuffer(), agent.agentPda.toBuffer()]);
    const [submission] = pda([enc("task_submission"), claim.toBuffer()]);
    expectOk(send(w.svm, await agent.prog.methods
      .claimTaskWithJobSpec()
      .accounts({ task, taskJobSpec: jobSpec, hireRecord: pda([enc("hire"), task.toBuffer()])[0], legacyListing: null, moderationBlock: moderationBlockPda(jobHash)[0], claim, protocolConfig: w.protocolPda, worker: agent.agentPda, authority: agent.kp.publicKey, systemProgram: SystemProgram.programId })
      .instruction(), [agent.kp]), "contest claim");
    const result = Buffer.alloc(64);
    result.set(crypto.randomBytes(32), 0);
    expectOk(send(w.svm, await agent.prog.methods
      .submitTaskResult(arr(id32()), arr(result))
      .accounts({ task, claim, taskValidationConfig: validation, taskSubmission: submission, protocolConfig: w.protocolPda, worker: agent.agentPda, authority: agent.kp.publicKey, systemProgram: SystemProgram.programId })
      .instruction(), [agent.kp]), "contest submit");
    entrants.push({ agent, claim, submission });
  }

  const clock = w.svm.getClock();
  clock.unixTimestamp = BigInt(deadline + SELECTION_WINDOW_SECS + 5);
  w.svm.setClock(clock);
  w.svm.expireBlockhash();

  const cranker = Keypair.generate();
  w.svm.airdrop(cranker.publicKey, BigInt(1e9));
  const treasuryBefore = lamports(w, w.admin.publicKey);
  let payoutTotal = 0;
  let forfeitedTotal = 0;
  for (const { agent, claim, submission } of entrants) {
    const rents = lamports(w, claim) + lamports(w, submission);
    const before = lamports(w, agent.kp.publicKey);
    const res = expectOk(send(w.svm, await makeProgram(cranker).methods
      .distributeGhostShare()
      .accounts({ task, claim, escrow, taskValidationConfig: validation, taskSubmission: submission, worker: agent.agentPda, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, creator: w.buyer.publicKey, workerAuthority: agent.kp.publicKey, operator: null, referrer, cranker: cranker.publicKey, systemProgram: SystemProgram.programId })
      .instruction(), [cranker]), "ghost crank");
    payoutTotal += lamports(w, agent.kp.publicKey) - before - rents;
    const slice = forfeits(res);
    assert.equal(slice.length, 1, "each slice forfeits its referrer fee");
    assert.equal(slice[0].role, REFERRER);
    assert.equal(slice[0].payee, referrer.toBase58());
    assert.equal(slice[0].amount, bps(reward / 2, 500), "500 bps of the 1_000_000 slice");
    forfeitedTotal += slice[0].amount;
  }

  assert.equal(lamports(w, referrer), 0, "the unfunded referrer is never credited");
  assert.equal(forfeitedTotal, bps(reward, 500));
  assert.equal(payoutTotal + (lamports(w, w.admin.publicKey) - treasuryBefore), reward, "workers + treasury receive the whole pool");
  assert.ok(isClosed(w.svm, escrow), "escrow closed after the final slice");
});
