// Revision 9 (E): required records (this file's first half) and claim deposits
// (added with the deposit change). Design: REV9-DESIGN.md sections 5 and 11.5.
//
// Executes the COMPILED program. Every test here fails on fed99ab (the revision 8
// program) for the reason in its title: the instructions are built with today's
// account names plus the new ones (which today's IDL ignores), and "without the
// record" cases send today's exact wire by removing or blanking the new meta.
//
// Run: node --test tests-integration/rev9-records-deposit.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  REPO, PID, enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode, isClosed,
  freshWorld, seatTestAuthorityResolver, configureTestMultisig, hireIx,
  taskModV2Pda, listingModV2Pda, moderationBlockPda,
  agentStatsPda, creatorStatsPda, readCreatorStats,
  BN, Keypair, SystemProgram, injectRevision8Freeze, disputeBondPda,
  disputeRespondent, findEvents,
  Program, AnchorProvider, Wallet, Connection,
} from "./harness.mjs";

// `release_claim` is new in revision 9: built from the committed revision 9 IDL
// (run-on-fed99ab swaps only target/idl), so fed99ab rejects it as unknown.
const REV9_IDL = JSON.parse(fs.readFileSync(path.join(REPO, "artifacts/anchor/idl/agenc_coordination.json"), "utf8"));
const rev9 = (payer) => new Program(REV9_IDL, new AnchorProvider(
  new Connection("http://127.0.0.1:9999"), new Wallet(payer), { commitment: "processed" }));

const TX_FEE = 5_000n;
const DEPOSIT_FLOOR = 5_000_000n;
const rent = (w, size) => BigInt(w.svm.minimumBalanceForRentExemption(BigInt(size)));
const bal = (w, key) => BigInt(w.svm.getBalance(key) ?? 0n);
const completionBond = (task, wallet) =>
  pda([enc("completion_bond"), task.toBuffer(), wallet.toBuffer()])[0];

function readAgentStats(w, agent) {
  const address = agentStatsPda(agent);
  if (isClosed(w.svm, address)) return null;
  const s = decode(w.svm, "AgentStats", address);
  return {
    agent: s.agent,
    tasksRejected: BigInt(s.tasks_rejected.toString()),
    disputesWon: BigInt(s.disputes_won.toString()),
    disputesLost: BigInt(s.disputes_lost.toString()),
    claimsExpired: BigInt(s.claims_expired.toString()),
  };
}

function warpTo(w, unixTimestamp) {
  const c = w.svm.getClock();
  c.unixTimestamp = BigInt(unixTimestamp);
  w.svm.setClock(c);
  w.svm.expireBlockhash();
}

// A published task (optionally CreatorReview) ready to be claimed.
async function publishedTask(w, { taskType = 0, maxWorkers = 1, reward = 4_000_000, review = true, deadlineSecs = 7 * 86_400 } = {}) {
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const [validation] = pda([enc("task_validation"), task.toBuffer()]);
  const [attestor] = pda([enc("task_attestor"), task.toBuffer()]);
  const [hireRecord] = pda([enc("hire"), task.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(reward), maxWorkers, new BN(now + deadlineSecs), taskType, null, 0, null, null, 0)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "rec:create_task");
  if (review) {
    expectOk(send(w.svm, await w.buyerProg.methods
      .configureTaskValidation(1, new BN(3600), 0, null)
      .accounts({ task, taskValidationConfig: validation, taskAttestorConfig: attestor, protocolConfig: w.protocolPda, hireRecord, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
      .instruction(), [w.buyer]), "rec:configure CreatorReview");
  }
  const jobHash = id32();
  const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  expectOk(send(w.svm, await makeProgram(w.modAuth).methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId, rentPayer: w.modAuth.publicKey })
    .instruction(), [w.modAuth]), "rec:task-mod");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/rev9-records", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "rec:publish");
  return { task, escrow, validation, hireRecord, jobSpec, jobHash, reward };
}

async function claimIx(w, t) {
  const [claim] = pda([enc("claim"), t.task.toBuffer(), w.providerAgent.toBuffer()]);
  const ix = await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task: t.task, taskJobSpec: t.jobSpec, hireRecord: t.hireRecord, legacyListing: null,
      moderationBlock: moderationBlockPda(t.jobHash)[0], claim, protocolConfig: w.protocolPda,
      worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId,
      workerStats: agentStatsPda(w.providerAgent) })
    .instruction();
  return { ix, claim };
}

async function claimAndSubmit(w, t) {
  const { ix, claim } = await claimIx(w, t);
  expectOk(send(w.svm, ix, [w.provider]), "rec:claim");
  const [submission] = pda([enc("task_submission"), claim.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .submitTaskResult(arr(id32()), arr(Buffer.concat([Buffer.alloc(63), Buffer.from([7])])))
    .accounts({ task: t.task, claim, taskValidationConfig: t.validation, taskSubmission: submission, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "rec:submit");
  return { claim, submission };
}

async function cancelIx(w, t) {
  return w.buyerProg.methods
    .cancelTask()
    .accounts({ task: t.task, escrow: t.escrow, authority: w.buyer.publicKey, protocolConfig: w.protocolPda, systemProgram: SystemProgram.programId,
      tokenEscrowAta: null, creatorTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: completionBond(t.task, w.buyer.publicKey), workerCompletionBond: completionBond(t.task, w.provider.publicKey),
      workerBondAuthority: w.provider.publicKey, creatorAgent: null, agentStats: null, treasury: null,
      creatorStats: creatorStatsPda(w.buyer.publicKey) })
    .instruction();
}

// ---------------------------------------------------------------------------
// 11.5 item 1. fed99ab: cancel_task has no creator record and succeeds.
// ---------------------------------------------------------------------------
test("rev9 records: cancel_task without the creator record account fails (fed99ab: succeeds)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const t = await publishedTask(w, { review: false });
  const record = creatorStatsPda(w.buyer.publicKey);

  // Today's wire: the same accounts without the appended creator_stats.
  const ix = await cancelIx(w, t);
  ix.keys = ix.keys.filter((meta) => !meta.pubkey.equals(record));
  expectFail(send(w.svm, ix, [w.buyer]), "AccountNotEnoughKeys", "rev9: the creator record is required");
  assert.equal(decode(w.svm, "Task", t.task).status.Open !== undefined, true, "the refused cancel moved nothing");

  // With the record the cancel works and is counted on the creator's wallet record.
  expectOk(send(w.svm, await cancelIx(w, t), [w.buyer]), "cancel with the creator record");
  const c = readCreatorStats(w.svm, record);
  assert.equal(c.wallet.toBase58(), w.buyer.publicKey.toBase58(), "record keyed to the creator wallet");
  assert.equal(c.cancels, 1n, "cancels == 1");
});

// ---------------------------------------------------------------------------
// 11.5 item 2. fed99ab: agent_stats is optional on reject_and_freeze.
// ---------------------------------------------------------------------------
test("rev9 records: reject_and_freeze without the worker record fails (fed99ab: succeeds)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const t = await publishedTask(w);
  const { claim, submission } = await claimAndSubmit(w, t);
  const workerRecord = agentStatsPda(w.providerAgent);
  const freeze = async () => w.buyerProg.methods
    .rejectAndFreeze(arr(Buffer.alloc(32, 7)))
    .accounts({ task: t.task, claim, taskValidationConfig: t.validation, taskSubmission: submission,
      protocolConfig: w.protocolPda, creator: w.buyer.publicKey, agentStats: workerRecord,
      systemProgram: SystemProgram.programId, creatorStats: creatorStatsPda(w.buyer.publicKey) })
    .instruction();

  // "Omitted" the way today's client omits an optional account: the program id.
  const ix = await freeze();
  ix.keys = ix.keys.map((meta) => (meta.pubkey.equals(workerRecord) ? { pubkey: PID, isSigner: false, isWritable: false } : meta));
  expectFail(send(w.svm, ix, [w.buyer]), "ConstraintSeeds", "rev9: the worker record is required");

  expectOk(send(w.svm, await freeze(), [w.buyer]), "freeze with both records");
  assert.equal(readAgentStats(w, w.providerAgent).tasksRejected, 1n, "worker tasks_rejected == 1");
  assert.equal(readCreatorStats(w.svm, creatorStatsPda(w.buyer.publicKey)).rejections, 1n, "creator rejections == 1");
});

// ---------------------------------------------------------------------------
// 5.2.3. fed99ab: claim creates no record (a later reject/ruling/expiry pays).
// ---------------------------------------------------------------------------
test("rev9 records: the first claim creates the worker record, paid by the worker (fed99ab: none)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const t = await publishedTask(w);
  assert.equal(readAgentStats(w, w.providerAgent), null, "no record before the first claim");
  const before = bal(w, w.provider.publicKey);
  const { ix } = await claimIx(w, t);
  expectOk(send(w.svm, ix, [w.provider]), "first claim");

  const s = readAgentStats(w, w.providerAgent);
  assert.ok(s, "record created at claim");
  assert.equal(s.agent.toBase58(), w.providerAgent.toBase58(), "record keyed to the worker agent");
  assert.equal(s.tasksRejected + s.disputesWon + s.disputesLost + s.claimsExpired, 0n, "no counter moves at claim");
  // Exact: the worker pays the fee, the claim rent, the record rent and (PR 5)
  // the claim deposit floor.
  assert.equal(before - bal(w, w.provider.publicKey), TX_FEE + rent(w, 203) + rent(w, 121) + DEPOSIT_FLOOR, "worker paid claim rent + record rent + deposit + fee");

  // A second claim on another task creates nothing new.
  const t2 = await publishedTask(w);
  const before2 = bal(w, w.provider.publicKey);
  const second = await claimIx(w, t2);
  expectOk(send(w.svm, second.ix, [w.provider]), "second claim");
  assert.equal(before2 - bal(w, w.provider.publicKey), TX_FEE + rent(w, 203) + DEPOSIT_FLOOR, "existing record costs nothing");
});

// ---------------------------------------------------------------------------
// 11.2 item 5 / 5.2.6. fed99ab: worker_track_record_outcome counts a worker's own
// rejected dispute as disputes_won. Collaborative review task: workers may still
// dispute there (single-worker review tasks refuse task disputes in revision 9).
// ---------------------------------------------------------------------------
test("rev9 records: a worker's own rejected dispute is a loss, the creator's a win (fed99ab: worker disputes_won)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const t = await publishedTask(w, { taskType: 1, maxWorkers: 2 });
  const { claim, submission } = await claimAndSubmit(w, t);

  const tid = decode(w.svm, "Task", t.task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [initRate] = pda([enc("authority_rate_limit"), w.provider.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .initiateDispute(arr(disputeId), arr(tid), arr(Buffer.alloc(32, 1)), 1, "evidence")
    .accounts({ dispute, task: t.task, agent: w.providerAgent, authorityRateLimit: initRate, protocolConfig: w.protocolPda,
      initiatorClaim: claim, workerAgent: null, workerClaim: null, taskSubmission: submission,
      authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "worker files a Complete dispute");

  const resolver = await seatTestAuthorityResolver(w);
  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .resolveDispute(false, arr(Buffer.alloc(32, 5)), "agenc://ruling/rev9-reject")
    .accounts({ dispute, task: t.task, escrow: t.escrow, protocolConfig: w.protocolPda, authority: w.admin.publicKey,
      resolverAssignment: resolver, creator: w.buyer.publicKey, workerClaim: claim, worker: w.providerAgent,
      workerWallet: w.provider.publicKey, agentStats: agentStatsPda(w.providerAgent), hireRecord: t.hireRecord,
      disputeOperator: null, disputeReferrer: null, systemProgram: SystemProgram.programId,
      tokenEscrowAta: null, creatorTokenAccount: null, workerTokenAccountAta: null, treasuryTokenAccount: null,
      rewardMint: null, tokenProgram: null, creatorCompletionBond: completionBond(t.task, w.buyer.publicKey),
      workerCompletionBond: completionBond(t.task, w.provider.publicKey), bondTreasury: w.admin.publicKey,
      taskSubmission: submission, taskValidationConfig: t.validation, creatorStats: creatorStatsPda(w.buyer.publicKey) })
    .instruction(), [w.admin]), "resolver rejects the worker's dispute");

  const s = readAgentStats(w, w.providerAgent);
  assert.equal(s.disputesLost, 1n, "worker disputes_lost == 1: its own dispute was rejected");
  assert.equal(s.disputesWon, 0n, "worker disputes_won stays 0");
  const c = readCreatorStats(w.svm, creatorStatsPda(w.buyer.publicKey));
  assert.equal(c.disputesWon, 1n, "creator disputes_won == 1");
  assert.equal(c.disputesLost, 0n, "creator disputes_lost stays 0");
});

// ---------------------------------------------------------------------------
// Ownership, not balance, decides whether a record exists. A stranger who sends
// lamports to the record address before it exists cannot block the instruction.
// fed99ab: no creator record exists at all.
// ---------------------------------------------------------------------------
test("rev9 records: a pre-funded record address is topped up and created, never blocking (fed99ab: no record)", async () => {
  for (const prefund of [1_000_000n, 2_000_000n]) {
    const w = await freshWorld({ moderationEnabled: true });
    const t = await publishedTask(w, { review: false });
    const record = creatorStatsPda(w.buyer.publicKey);
    w.svm.setAccount(record, { lamports: Number(prefund), data: Buffer.alloc(0), owner: SystemProgram.programId, executable: false, rentEpoch: 0 });
    const recordRent = rent(w, 129);
    const shortfall = recordRent > prefund ? recordRent - prefund : 0n;
    const escrowBefore = bal(w, t.escrow);
    const buyerBefore = bal(w, w.buyer.publicKey);

    expectOk(send(w.svm, await cancelIx(w, t), [w.buyer]), `cancel over a record pre-funded with ${prefund}`);
    const c = readCreatorStats(w.svm, record);
    assert.ok(c, "the creator record was created over the pre-funded address");
    assert.equal(c.cancels, 1n, "record created and counted");
    assert.equal(c.lamports, prefund > recordRent ? prefund : recordRent, "record holds max(rent, pre-funded lamports)");
    assert.equal(bal(w, w.buyer.publicKey) - buyerBefore, escrowBefore - TX_FEE - shortfall,
      "creator gets the escrow back and pays only the record's shortfall");
  }
});

// ---------------------------------------------------------------------------
// expire_claim on a revision 9 claim: the record exists from the claim, so the
// permissionless cranker pays nothing for it. fed99ab: the cranker who passes
// the record creates it (1,264,920 lamports).
// ---------------------------------------------------------------------------
test("rev9 records: a no-show expiry counts claims_expired and the cranker pays nothing for the record (fed99ab: cranker pays its rent)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const t = await publishedTask(w, { review: false, deadlineSecs: 600 });
  const { ix, claim } = await claimIx(w, t);
  expectOk(send(w.svm, ix, [w.provider]), "claim");
  const expiresAt = Number(decode(w.svm, "TaskClaim", claim).expires_at.toString());
  warpTo(w, expiresAt + 61); // past expiry and the 60-second worker-only grace

  const cranker = Keypair.generate();
  w.svm.airdrop(cranker.publicKey, 1_000_000_000n);
  const before = bal(w, cranker.publicKey);
  expectOk(send(w.svm, await makeProgram(cranker).methods
    .expireClaim()
    .accounts({ creatorStats: null, authority: cranker.publicKey, task: t.task, escrow: t.escrow, claim, worker: w.providerAgent,
      protocolConfig: w.protocolPda, taskValidationConfig: null, taskSubmission: pda([enc("task_submission"), claim.toBuffer()])[0],
      rentRecipient: w.provider.publicKey, workerCompletionBond: completionBond(t.task, w.provider.publicKey),
      bondCreator: w.buyer.publicKey, agentStats: agentStatsPda(w.providerAgent), treasury: null,
      systemProgram: SystemProgram.programId })
    .instruction(), [cranker]), "permissionless no-show expiry");

  assert.equal(readAgentStats(w, w.providerAgent).claimsExpired, 1n, "claims_expired == 1");
  assert.equal(bal(w, cranker.publicKey) - before, 1_000n - TX_FEE, "cranker gets the cleanup reward, pays only the fee");
});

// ---------------------------------------------------------------------------
// cancel_dispute charges only the filer's record. fed99ab: no records.
// ---------------------------------------------------------------------------
test("rev9 records: cancelling one's own dispute charges the filer's disputes_lost only (fed99ab: no record)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  // An Auto-mode task: the creator may file a task dispute there.
  const pt = await publishedTask(w, { reward: 3_000_000, review: false });
  const { task } = pt;
  const { ix: cix, claim } = await claimIx(w, pt);
  expectOk(send(w.svm, cix, [w.provider]), "claim");

  const tid = decode(w.svm, "Task", task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [initRate] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.buyerProg.methods
    .initiateDispute(arr(disputeId), arr(tid), arr(Buffer.alloc(32, 1)), 0, "evidence")
    .accounts({ dispute, task, agent: w.buyerAgent, authorityRateLimit: initRate, protocolConfig: w.protocolPda,
      initiatorClaim: null, workerAgent: w.providerAgent, workerClaim: claim, taskSubmission: null,
      authority: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "creator files a Refund dispute");

  expectOk(send(w.svm, await w.buyerProg.methods
    .cancelDispute()
    .accounts({ respondent: disputeRespondent(w.svm, dispute), protocolConfig: w.protocolPda, dispute, task, authority: w.buyer.publicKey,
      workerStats: agentStatsPda(w.providerAgent), creatorStats: creatorStatsPda(w.buyer.publicKey),
      systemProgram: SystemProgram.programId })
    .remainingAccounts([{ pubkey: w.providerAgent, isSigner: false, isWritable: true }])
    .instruction(), [w.buyer]), "creator cancels its dispute");

  const c = readCreatorStats(w.svm, creatorStatsPda(w.buyer.publicKey));
  assert.ok(c, "the creator record exists");
  assert.equal(c.disputesLost, 1n, "creator (the filer) disputes_lost == 1");
  assert.equal(c.disputesWon, 0n, "creator disputes_won untouched");
  const s = readAgentStats(w, w.providerAgent);
  assert.equal(s.disputesWon, 0n, "the respondent worker gets no win for a cancel");
  assert.equal(s.disputesLost, 0n, "and no loss");
});

// ---------------------------------------------------------------------------
// The frozen exits record the multisig ruling on both sides. fed99ab: the frozen
// exits take no record accounts at all.
// ---------------------------------------------------------------------------
test("rev9 records: a multisig ruling on a freeze counts won and lost on both records (fed99ab: no records)", async () => {
  for (const approve of [true, false]) {
    const w = await freshWorld({ moderationEnabled: true });
    const ms = await configureTestMultisig(w);
    const t = await publishedTask(w);
    const { claim, submission } = await claimAndSubmit(w, t);
    expectOk(send(w.svm, await w.buyerProg.methods
      .rejectAndFreeze(arr(Buffer.alloc(32, 7)))
      .accounts({ task: t.task, claim, taskValidationConfig: t.validation, taskSubmission: submission,
        protocolConfig: w.protocolPda, creator: w.buyer.publicKey, agentStats: agentStatsPda(w.providerAgent),
        systemProgram: SystemProgram.programId, creatorStats: creatorStatsPda(w.buyer.publicKey) })
      .instruction(), [w.buyer]), "freeze");
    // A revision 8 freeze (freeze_kind 0) may be ruled without a dispute, on both
    // binaries; fed99ab ignores the v2 arguments and the record accounts.
    await injectRevision8Freeze(w, submission, 3600);

    expectOk(send(w.svm, await makeProgram(w.admin).methods
      .resolveRejectFrozen(approve, arr(Buffer.alloc(32, 5)), "agenc://ruling/rev9-records")
      .accounts({ task: t.task, claim, escrow: t.escrow, taskSubmission: submission, worker: w.providerAgent,
        protocolConfig: w.protocolPda, treasury: w.admin.publicKey, creator: w.buyer.publicKey,
        workerAuthority: w.provider.publicKey, hireRecord: t.hireRecord, operator: null, referrer: null,
        authority: w.admin.publicKey, creatorCompletionBond: completionBond(t.task, w.buyer.publicKey),
        workerCompletionBond: completionBond(t.task, w.provider.publicKey), systemProgram: SystemProgram.programId,
        disputeBond: disputeBondPda(t.task), workerStats: agentStatsPda(w.providerAgent),
        creatorStats: creatorStatsPda(w.buyer.publicKey) })
      .remainingAccounts(ms.remainingAccounts)
      .instruction(), ms.approvers), `multisig ruling approve=${approve}`);

    const s = readAgentStats(w, w.providerAgent);
    const c = readCreatorStats(w.svm, creatorStatsPda(w.buyer.publicKey));
    assert.equal(s.disputesWon, approve ? 1n : 0n, "worker won iff the completion was approved");
    assert.equal(s.disputesLost, approve ? 0n : 1n, "worker lost iff the rejection was upheld");
    assert.equal(c.disputesWon, approve ? 0n : 1n, "creator mirror: won iff upheld");
    assert.equal(c.disputesLost, approve ? 1n : 0n, "creator mirror: lost iff approved");
  }
});

// ===========================================================================
// Claim deposits (design 5.2.4, 5.3 "Deposit plumbing", 11.5 items 3 to 9).
// ===========================================================================

const GRACE = 3_600; // CLAIM_RELEASE_GRACE_SECS
const CONTEST_DEPOSIT = 10_000_000n;
const claimRentOf = (w, claim) => rent(w, w.svm.getAccount(claim).data.length);
const surplusOf = (w, claim) => bal(w, claim) - claimRentOf(w, claim);

async function registerWorker(w) {
  const kp = Keypair.generate();
  w.svm.airdrop(kp.publicKey, 100_000_000_000n);
  const prog = makeProgram(kp);
  const agentId = id32();
  const [agent] = pda([enc("agent"), agentId]);
  expectOk(send(w.svm, await prog.methods
    .registerAgent(arr(agentId), new BN(1), "http://second-worker.test", null, new BN(0))
    .accounts({ agent, protocolConfig: w.protocolPda, authority: kp.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [kp]), "register a second worker");
  return { kp, prog, agent };
}

async function claimAs(w, t, worker) {
  const [claim] = pda([enc("claim"), t.task.toBuffer(), worker.agent.toBuffer()]);
  return { claim, res: expectOk(send(w.svm, await worker.prog.methods
    .claimTaskWithJobSpec()
    .accounts({ task: t.task, taskJobSpec: t.jobSpec, hireRecord: t.hireRecord, legacyListing: null,
      moderationBlock: moderationBlockPda(t.jobHash)[0], claim, protocolConfig: w.protocolPda,
      worker: worker.agent, authority: worker.kp.publicKey, systemProgram: SystemProgram.programId,
      workerStats: agentStatsPda(worker.agent) })
    .instruction(), [worker.kp]), "claim as a second worker") };
}

function expireClaimIx(w, t, claim, caller, { bondCreator = w.buyer.publicKey, creatorStats = null, workerBond = completionBond(t.task, w.provider.publicKey) } = {}) {
  return makeProgram(caller).methods
    .expireClaim()
    .accounts({ authority: caller.publicKey, task: t.task, escrow: t.escrow, claim, worker: w.providerAgent,
      protocolConfig: w.protocolPda, taskValidationConfig: t.review === false ? null : t.validation,
      taskSubmission: pda([enc("task_submission"), claim.toBuffer()])[0], rentRecipient: w.provider.publicKey,
      workerCompletionBond: workerBond, bondCreator, agentStats: agentStatsPda(w.providerAgent),
      treasury: w.admin.publicKey, systemProgram: SystemProgram.programId, creatorStats })
    .instruction();
}

function releaseIx(w, t, claim, { worker = { kp: w.provider, agent: w.providerAgent } } = {}) {
  return rev9(worker.kp).methods
    .releaseClaim()
    .accounts({ task: t.task, claim, worker: worker.agent,
      taskSubmission: pda([enc("task_submission"), claim.toBuffer()])[0],
      taskValidationConfig: t.review === false ? null : t.validation,
      workerCompletionBond: completionBond(t.task, worker.kp.publicKey), creator: w.buyer.publicKey,
      workerStats: agentStatsPda(worker.agent), protocolConfig: w.protocolPda,
      authority: worker.kp.publicKey, systemProgram: SystemProgram.programId })
    .instruction();
}

function crank(w) {
  const k = Keypair.generate();
  w.svm.airdrop(k.publicKey, 1_000_000_000n);
  return k;
}

// Make the creator's wallet record exist (a first cancel creates it).
async function createCreatorRecord(w) {
  const throwaway = await publishedTask(w, { review: false });
  expectOk(send(w.svm, await cancelIx(w, throwaway), [w.buyer]), "a first cancel creates the creator record");
}

// ---------------------------------------------------------------------------
// 11.5 item 3. fed99ab: a claim holds only its rent.
// ---------------------------------------------------------------------------
test("rev9 deposit: a claim holds its rent plus max(10% of the share, 0.005 SOL), paid by the worker (fed99ab: rent only)", async () => {
  for (const { reward, taskType, maxWorkers, deposit } of [
    { reward: 200_000_000, taskType: 0, maxWorkers: 1, deposit: 20_000_000n },
    { reward: 4_000_000, taskType: 0, maxWorkers: 1, deposit: DEPOSIT_FLOOR },
    { reward: 400_000_000, taskType: 1, maxWorkers: 2, deposit: 20_000_000n }, // 10% of the 0.2 SOL share
  ]) {
    const w = await freshWorld({ moderationEnabled: true });
    const t = await publishedTask(w, { reward, taskType, maxWorkers, review: false });
    // A first claim elsewhere creates the worker record, so the delta below is the claim alone.
    const throwaway = await publishedTask(w, { reward, taskType, maxWorkers, review: false });
    expectOk(send(w.svm, (await claimIx(w, throwaway)).ix, [w.provider]), "first claim creates the worker record");
    const before = bal(w, w.provider.publicKey);
    const { ix, claim } = await claimIx(w, t);
    const res = expectOk(send(w.svm, ix, [w.provider]), `claim (reward ${reward}, type ${taskType})`);
    assert.equal(surplusOf(w, claim), deposit, "claim lamports = rent + deposit");
    assert.equal(before - bal(w, w.provider.publicKey), claimRentOf(w, claim) + deposit + TX_FEE, "the worker paid rent, deposit and fee");
    const posted = findEvents(res, "ClaimDepositPosted");
    assert.equal(posted.length, 1, "ClaimDepositPosted emitted");
    assert.equal(BigInt(posted[0].amount.toString()), deposit, "event amount");
  }
});

// ---------------------------------------------------------------------------
// 11.5 item 4. fed99ab: there is no deposit to return.
// ---------------------------------------------------------------------------
test("rev9 deposit: the first delivery returns the whole deposit to the worker; a resubmission finds none (fed99ab: no deposit)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const t = await publishedTask(w, { reward: 200_000_000 });
  const { ix, claim } = await claimIx(w, t);
  expectOk(send(w.svm, ix, [w.provider]), "claim");
  assert.equal(surplusOf(w, claim), 20_000_000n, "the claim holds the deposit");
  const [submission] = pda([enc("task_submission"), claim.toBuffer()]);
  const submitIx = async () => w.providerProg.methods
    .submitTaskResult(arr(id32()), arr(Buffer.concat([Buffer.alloc(63), Buffer.from([7])])))
    .accounts({ task: t.task, claim, taskValidationConfig: t.validation, taskSubmission: submission, protocolConfig: w.protocolPda,
      worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction();
  const before = bal(w, w.provider.publicKey);
  const res = expectOk(send(w.svm, await submitIx(), [w.provider]), "first delivery");
  assert.equal(surplusOf(w, claim), 0n, "the claim is back to its rent");
  assert.equal(bal(w, w.provider.publicKey) - before, 20_000_000n - rent(w, w.svm.getAccount(submission).data.length) - TX_FEE,
    "worker: +deposit, less the submission rent and the fee");
  const settled = findEvents(res, "ClaimDepositSettled");
  assert.equal(settled.length, 1, "ClaimDepositSettled emitted");
  assert.equal(settled[0].forfeited, false, "returned, not forfeited");
  assert.equal(settled[0].recipient.toBase58(), w.provider.publicKey.toBase58(), "to the worker wallet");

  // A change request then a resubmission: nothing left to return.
  expectOk(send(w.svm, await w.buyerProg.methods
    .requestChanges(arr(Buffer.alloc(32, 4)))
    .accounts({ task: t.task, claim, taskValidationConfig: t.validation, taskSubmission: submission, protocolConfig: w.protocolPda, creator: w.buyer.publicKey })
    .instruction(), [w.buyer]), "request changes");
  const res2 = expectOk(send(w.svm, await submitIx(), [w.provider]), "resubmission");
  assert.equal(findEvents(res2, "ClaimDepositSettled").length, 0, "no second refund");
});

// ---------------------------------------------------------------------------
// 11.5 item 5. fed99ab: the no-show's claim closes whole to the worker.
// ---------------------------------------------------------------------------
test("rev9 deposit: a no-show expire_claim pays the deposit to the creator, exactly; the creator account is required (fed99ab: worker keeps it)", async () => {
  // Collaborative: no completion-bond block, so the deposit rule alone decides.
  {
    const w = await freshWorld({ moderationEnabled: true });
    const t = await publishedTask(w, { taskType: 1, maxWorkers: 1, review: false, deadlineSecs: 600 });
    t.review = false;
    const { ix, claim } = await claimIx(w, t);
    expectOk(send(w.svm, ix, [w.provider]), "claim");
    warpTo(w, Number(decode(w.svm, "TaskClaim", claim).expires_at.toString()) + 61);
    const caller = crank(w);
    expectFail(send(w.svm, await expireClaimIx(w, t, claim, caller, { bondCreator: null, workerBond: null }), [caller]),
      "ClaimDepositRecipientRequired", "the deposit needs its recipient");
    const deposit = surplusOf(w, claim);
    const rentBack = claimRentOf(w, claim);
    const before = { creator: bal(w, w.buyer.publicKey), worker: bal(w, w.provider.publicKey) };
    w.svm.expireBlockhash();
    const res = expectOk(send(w.svm, await expireClaimIx(w, t, claim, caller, { workerBond: null, creatorStats: creatorStatsPda(w.buyer.publicKey) }), [caller]), "no-show expiry");
    assert.equal(deposit, DEPOSIT_FLOOR, "the claim held the deposit floor");
    assert.equal(bal(w, w.buyer.publicKey) - before.creator, deposit, "creator: exactly the deposit");
    assert.equal(bal(w, w.provider.publicKey) - before.worker, rentBack, "worker: only the claim rent");
    assert.equal(findEvents(res, "ClaimDepositSettled")[0].forfeited, true, "forfeited");
    assert.ok(isClosed(w.svm, creatorStatsPda(w.buyer.publicKey)), "an absent creator record is not created by a crank");
  }
  // Exclusive, creator record present: the forfeit counts deposits_received.
  {
    const w = await freshWorld({ moderationEnabled: true });
    await createCreatorRecord(w);
    const t = await publishedTask(w, { review: false, deadlineSecs: 600 });
    t.review = false;
    const { ix, claim } = await claimIx(w, t);
    expectOk(send(w.svm, ix, [w.provider]), "claim");
    warpTo(w, Number(decode(w.svm, "TaskClaim", claim).expires_at.toString()) + 61);
    const caller = crank(w);
    const before = bal(w, w.buyer.publicKey);
    const deposit = surplusOf(w, claim);
    expectOk(send(w.svm, await expireClaimIx(w, t, claim, caller, { creatorStats: creatorStatsPda(w.buyer.publicKey) }), [caller]), "no-show expiry");
    assert.equal(bal(w, w.buyer.publicKey) - before, deposit, "creator: exactly the deposit");
    assert.equal(readCreatorStats(w.svm, creatorStatsPda(w.buyer.publicKey)).depositsReceived, 1n, "deposits_received == 1");
  }
});

// ---------------------------------------------------------------------------
// 11.5 item 6. fed99ab: the drain closes the no-show claim whole to the worker.
// ---------------------------------------------------------------------------
test("rev9 deposit: the cancel_task no-show drain pays the deposit to the creator (fed99ab: worker keeps it)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const t = await publishedTask(w, { reward: 200_000_000, review: false, deadlineSecs: 600 });
  const { ix, claim } = await claimIx(w, t);
  expectOk(send(w.svm, ix, [w.provider]), "claim");
  warpTo(w, Number(decode(w.svm, "Task", t.task).deadline.toString()) + 1);
  const deposit = surplusOf(w, claim);
  const rentBack = claimRentOf(w, claim);
  const escrowBefore = bal(w, t.escrow);
  const recordCost = rent(w, 129); // the creator's first record, created by this cancel
  const before = { creator: bal(w, w.buyer.publicKey), worker: bal(w, w.provider.publicKey) };
  const cancel = await cancelIx(w, t);
  cancel.keys.push(
    { pubkey: claim, isSigner: false, isWritable: true },
    { pubkey: w.providerAgent, isSigner: false, isWritable: true },
    { pubkey: w.provider.publicKey, isSigner: false, isWritable: true },
  );
  const res = expectOk(send(w.svm, cancel, [w.buyer]), "no-show cancel drain");
  assert.equal(deposit, 20_000_000n, "10% of 0.2 SOL");
  assert.equal(bal(w, w.buyer.publicKey) - before.creator, escrowBefore + deposit - TX_FEE - recordCost, "creator: escrow and the deposit, less fee and its first record");
  assert.equal(bal(w, w.provider.publicKey) - before.worker, rentBack, "worker: claim rent only");
  assert.equal(findEvents(res, "ClaimDepositSettled")[0].forfeited, true, "forfeited to the creator");
});

// ---------------------------------------------------------------------------
// 11.5 item 7 + edges. fed99ab: release_claim does not exist.
// ---------------------------------------------------------------------------
test("rev9 deposit: release_claim within the hour refunds the deposit (3,599 s and 3,600 s), after it forfeits (3,601 s) (fed99ab: unknown instruction)", async () => {
  for (const { after, refunded } of [{ after: GRACE - 1, refunded: true }, { after: GRACE, refunded: true }, { after: GRACE + 1, refunded: false }]) {
    const w = await freshWorld({ moderationEnabled: true });
    const t = await publishedTask(w, { reward: 200_000_000, review: false });
    t.review = false;
    const { ix, claim } = await claimIx(w, t);
    expectOk(send(w.svm, ix, [w.provider]), "claim");
    const claimedAt = Number(decode(w.svm, "TaskClaim", claim).claimed_at.toString());
    warpTo(w, claimedAt + after);
    const claimLamports = bal(w, claim);
    const deposit = surplusOf(w, claim);
    const before = { creator: bal(w, w.buyer.publicKey), worker: bal(w, w.provider.publicKey) };
    const res = expectOk(send(w.svm, await releaseIx(w, t, claim), [w.provider]), `release at +${after}s`);
    const d = { creator: bal(w, w.buyer.publicKey) - before.creator, worker: bal(w, w.provider.publicKey) - before.worker };
    assert.ok(isClosed(w.svm, claim), "claim closed");
    if (refunded) {
      assert.equal(d.worker, claimLamports - TX_FEE, "worker: rent and deposit back, less the fee");
      assert.equal(d.creator, 0n, "creator: nothing");
      assert.equal(readAgentStats(w, w.providerAgent).claimsExpired, 0n, "no expired claim on the record");
    } else {
      assert.equal(d.worker, claimLamports - deposit - TX_FEE, "worker: rent back only");
      assert.equal(d.creator, deposit, "creator: the deposit");
      assert.equal(readAgentStats(w, w.providerAgent).claimsExpired, 1n, "a late release counts as an expired claim");
    }
    const released = findEvents(res, "ClaimReleased");
    assert.equal(released.length, 1, "ClaimReleased emitted");
    assert.equal(released[0].deposit_refunded, refunded, "event says where the deposit went");
    const task = decode(w.svm, "Task", t.task);
    assert.equal(Number(task.current_workers), 0, "slot freed");
    assert.ok(task.status.Open !== undefined, "an Auto task with no worker reopens");
    assert.equal(Number(decode(w.svm, "AgentRegistration", w.providerAgent).active_tasks), 0, "worker slot freed");
  }
});

test("rev9 deposit: release_claim refuses delivered work, an expired claim, a live completion bond and a contest (fed99ab: unknown instruction)", async () => {
  // Delivered work under review.
  {
    const w = await freshWorld({ moderationEnabled: true });
    const t = await publishedTask(w);
    const { claim } = await claimAndSubmit(w, t);
    expectFail(send(w.svm, await releaseIx(w, t, claim), [w.provider]), "ClaimNotReleasable", "a Submitted delivery cannot be released");
  }
  // A claim past its expiry belongs to expire_claim.
  {
    const w = await freshWorld({ moderationEnabled: true });
    const t = await publishedTask(w, { review: false, deadlineSecs: 600 });
    t.review = false;
    const { ix, claim } = await claimIx(w, t);
    expectOk(send(w.svm, ix, [w.provider]), "claim");
    warpTo(w, Number(decode(w.svm, "TaskClaim", claim).expires_at.toString()) + 1);
    expectFail(send(w.svm, await releaseIx(w, t, claim), [w.provider]), "ClaimNotReleasable", "an expired claim cannot be released");
  }
  // A live completion bond settles through its own paths.
  {
    const w = await freshWorld({ moderationEnabled: true });
    const t = await publishedTask(w, { review: false });
    t.review = false;
    const { ix, claim } = await claimIx(w, t);
    expectOk(send(w.svm, ix, [w.provider]), "claim");
    expectOk(send(w.svm, await w.providerProg.methods
      .postCompletionBond(1)
      .accounts({ task: t.task, protocolConfig: w.protocolPda, completionBond: completionBond(t.task, w.provider.publicKey),
        worker: w.providerAgent, workerClaim: claim, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
      .instruction(), [w.provider]), "worker posts a completion bond");
    expectFail(send(w.svm, await releaseIx(w, t, claim), [w.provider]), "ClaimNotReleasable", "a bonded claim cannot be released");
  }
  // A contest entry keeps the contest rules.
  {
    const w = await freshWorld({ moderationEnabled: true });
    const t = await publishedTask(w, { taskType: 2, maxWorkers: 3 });
    const { ix, claim } = await claimIx(w, t);
    expectOk(send(w.svm, ix, [w.provider]), "contest entry");
    expectFail(send(w.svm, await releaseIx(w, t, claim), [w.provider]), "ClaimNotReleasable", "a contest entry cannot be released");
  }
});

// ---------------------------------------------------------------------------
// 11.5 item 8. A contest claim carries only its 0.01 SOL entry deposit, which a
// no-show still forfeits to the treasury. fed99ab: same contest rule (guard).
// ---------------------------------------------------------------------------
test("rev9 deposit: a contest claim carries only the 0.01 SOL entry deposit, forfeited to the treasury on a no-show (guard, holds on fed99ab)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const t = await publishedTask(w, { taskType: 2, maxWorkers: 3, deadlineSecs: 600 });
  const { ix, claim } = await claimIx(w, t);
  expectOk(send(w.svm, ix, [w.provider]), "contest entry");
  assert.equal(surplusOf(w, claim), CONTEST_DEPOSIT, "only the contest entry deposit, no second deposit");
  warpTo(w, Number(decode(w.svm, "TaskClaim", claim).expires_at.toString()) + 61);
  const caller = crank(w);
  const before = { creator: bal(w, w.buyer.publicKey), treasury: bal(w, w.admin.publicKey) };
  expectOk(send(w.svm, await expireClaimIx(w, t, claim, caller, { bondCreator: w.buyer.publicKey, workerBond: null }), [caller]), "contest no-show expiry");
  assert.equal(bal(w, w.admin.publicKey) - before.treasury, CONTEST_DEPOSIT, "treasury: the contest deposit");
  assert.equal(bal(w, w.buyer.publicKey), before.creator, "creator: nothing");
});

// ---------------------------------------------------------------------------
// 11.5 item 9. A claim stranded on a terminal task: its deposit goes to the
// creator after the claim's expiry, back to the worker before it. fed99ab: any
// surplus on an empty claim went to the treasury.
// ---------------------------------------------------------------------------
test("rev9 deposit: reclaim_terminal_claim gives a stranded claim's deposit to the creator after its expiry, to the worker before (fed99ab: treasury)", async () => {
  for (const pastExpiry of [false, true]) {
    const w = await freshWorld({ moderationEnabled: true });
    // Auto-mode Competitive (not a contest): the first completion wins and leaves
    // the other claim stranded on the Completed task.
    const t = await publishedTask(w, { reward: 200_000_000, taskType: 2, maxWorkers: 2, review: false, deadlineSecs: 600 });
    const second = await registerWorker(w);
    const { claim: strandedClaim } = await claimAs(w, t, second);
    const { ix, claim } = await claimIx(w, t);
    expectOk(send(w.svm, ix, [w.provider]), "winner claims");
    expectOk(send(w.svm, await w.providerProg.methods
      .completeTask(arr(id32()), null)
      .accounts({ task: t.task, claim, escrow: t.escrow, creator: w.buyer.publicKey, worker: w.providerAgent, protocolConfig: w.protocolPda,
        treasury: w.admin.publicKey, authority: w.provider.publicKey, systemProgram: SystemProgram.programId, tokenEscrowAta: null,
        workerTokenAccount: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, hireRecord: t.hireRecord,
        operator: null, referrer: null, creatorCompletionBond: null, workerCompletionBond: null })
      .instruction(), [w.provider]), "winner completes");
    assert.ok(decode(w.svm, "Task", t.task).status.Completed !== undefined, "task Completed");
    assert.equal(surplusOf(w, strandedClaim), 20_000_000n, "the stranded claim still holds its deposit");
    if (pastExpiry) warpTo(w, Number(decode(w.svm, "TaskClaim", strandedClaim).expires_at.toString()) + 1);

    const caller = crank(w);
    const deposit = surplusOf(w, strandedClaim);
    const rentBack = claimRentOf(w, strandedClaim);
    const before = { creator: bal(w, w.buyer.publicKey), worker: bal(w, second.kp.publicKey), treasury: bal(w, w.admin.publicKey) };
    expectOk(send(w.svm, await makeProgram(caller).methods
      .reclaimTerminalClaim()
      .accounts({ authority: caller.publicKey, task: t.task, claim: strandedClaim,
        taskSubmission: pda([enc("task_submission"), strandedClaim.toBuffer()])[0], taskValidationConfig: null,
        worker: second.agent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey,
        rentRecipient: second.kp.publicKey, creator: w.buyer.publicKey })
      .instruction(), [caller]), `reclaim ${pastExpiry ? "after" : "before"} the claim's expiry`);
    const d = { creator: bal(w, w.buyer.publicKey) - before.creator, worker: bal(w, second.kp.publicKey) - before.worker, treasury: bal(w, w.admin.publicKey) - before.treasury };
    assert.equal(d.treasury, 0n, "nothing to the treasury: this is not a contest");
    if (pastExpiry) {
      assert.equal(d.creator, deposit, "creator: the deposit");
      assert.equal(d.worker, rentBack, "worker: claim rent only");
    } else {
      assert.equal(d.creator, 0n, "creator: nothing before the claim's expiry");
      assert.equal(d.worker, rentBack + deposit, "worker: rent and deposit");
    }
  }
});

// ---------------------------------------------------------------------------
// expire_dispute with no-show evidence (design 5.3): the deposit goes to the
// creator and its record counts it. fed99ab: the worker keeps it.
// ---------------------------------------------------------------------------
// Review R1-1: the no-show penalty on an unruled dispute needs a claim that had
// already lapsed when the dispute was filed. A dispute filed against a live
// claim stops the worker from delivering, so it can never make the deposit
// forfeitable; the D16 case (filed after the claim lapsed) still forfeits.
async function disputeAndExpire(w, { fileAfterLapse }) {
  const pt = await publishedTask(w, { reward: 200_000_000, review: false, deadlineSecs: 30 * 86_400 });
  const { task, escrow, hireRecord } = pt;
  const { ix: cix, claim } = await claimIx(w, pt);
  expectOk(send(w.svm, cix, [w.provider]), "claim");
  const claimExpiresAt = Number(decode(w.svm, "TaskClaim", claim).expires_at.toString());
  if (fileAfterLapse) warpTo(w, claimExpiresAt + 1);
  const tid = decode(w.svm, "Task", task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  expectOk(send(w.svm, await w.buyerProg.methods
    .initiateDispute(arr(disputeId), arr(tid), arr(Buffer.alloc(32, 1)), 0, "no-show")
    .accounts({ dispute, task, agent: w.buyerAgent, authorityRateLimit: pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()])[0],
      protocolConfig: w.protocolPda, initiatorClaim: null, workerAgent: w.providerAgent, workerClaim: claim, taskSubmission: null,
      authority: w.buyer.publicKey, systemProgram: SystemProgram.programId, disputeBond: disputeBondPda(dispute) })
    .instruction(), [w.buyer]), "creator disputes the claim");
  const d = decode(w.svm, "Dispute", dispute);
  warpTo(w, Math.max(Number(d.voting_deadline.toString()) + 120, Number(d.expires_at.toString()), claimExpiresAt) + 1);
  const deposit = surplusOf(w, claim);
  const rentBack = claimRentOf(w, claim);
  const caller = crank(w);
  const before = { worker: bal(w, w.provider.publicKey) };
  const res = expectOk(send(w.svm, await makeProgram(caller).methods
    .expireDispute()
    .accounts({ dispute, task, escrow, protocolConfig: w.protocolPda, creator: w.buyer.publicKey, authority: caller.publicKey,
      workerClaim: claim, worker: w.providerAgent, workerWallet: w.provider.publicKey, hireRecord, disputeOperator: null,
      disputeReferrer: null, tokenEscrowAta: null, creatorTokenAccount: null, workerTokenAccountAta: null, rewardMint: null,
      tokenProgram: null, creatorCompletionBond: completionBond(task, w.buyer.publicKey), workerCompletionBond: completionBond(task, w.provider.publicKey),
      taskSubmission: pda([enc("task_submission"), claim.toBuffer()])[0], taskValidationConfig: null,
      disputeBond: disputeBondPda(dispute), workerStats: agentStatsPda(w.providerAgent), creatorStats: creatorStatsPda(w.buyer.publicKey),
      systemProgram: SystemProgram.programId })
    .instruction(), [caller]), "expire the unruled dispute");
  assert.equal(deposit, 20_000_000n, "the claim's deposit");
  return { res, deposit, rentBack, workerGain: bal(w, w.provider.publicKey) - before.worker };
}

test("rev9 deposit: an unruled dispute filed against a live claim returns the deposit to the worker (review R1-1; f8c8782: to the creator)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const { deposit, rentBack, workerGain } = await disputeAndExpire(w, { fileAfterLapse: false });
  assert.equal(workerGain, rentBack + deposit, "worker: claim rent and its deposit");
  const record = readCreatorStats(w.svm, creatorStatsPda(w.buyer.publicKey));
  assert.equal(record?.depositsReceived ?? 0n, 0n, "no deposit received");
});

test("rev9 deposit: an unruled dispute filed after the claim lapsed still forfeits the deposit to the creator (review R1-1, D16; holds before and after)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const { workerGain, rentBack } = await disputeAndExpire(w, { fileAfterLapse: true });
  assert.equal(workerGain, rentBack, "worker: claim rent only");
  assert.equal(readCreatorStats(w.svm, creatorStatsPda(w.buyer.publicKey)).depositsReceived, 1n, "deposits_received == 1");
});

// ---------------------------------------------------------------------------
// A claim made before the upgrade has no deposit: every exit finds no surplus
// and moves only rent. Injected by trimming a claim to its rent.
// ---------------------------------------------------------------------------
test("rev9 deposit: a pre-upgrade claim (no deposit) still expires and releases moving only rent (compatibility)", async () => {
  for (const exit of ["expire", "release"]) {
    const w = await freshWorld({ moderationEnabled: true });
    const t = await publishedTask(w, { taskType: 1, maxWorkers: 1, review: false, deadlineSecs: 600 });
    t.review = false;
    const { ix, claim } = await claimIx(w, t);
    expectOk(send(w.svm, ix, [w.provider]), "claim");
    const acct = w.svm.getAccount(claim);
    w.svm.setAccount(claim, { ...acct, lamports: Number(claimRentOf(w, claim)) });
    const before = { creator: bal(w, w.buyer.publicKey), worker: bal(w, w.provider.publicKey) };
    if (exit === "expire") {
      warpTo(w, Number(decode(w.svm, "TaskClaim", claim).expires_at.toString()) + 61);
      const caller = crank(w);
      // No deposit, so no creator account is needed.
      expectOk(send(w.svm, await expireClaimIx(w, t, claim, caller, { bondCreator: null, workerBond: null }), [caller]), "legacy no-show expiry");
      assert.equal(bal(w, w.provider.publicKey) - before.worker, rent(w, acct.data.length), "worker: claim rent");
    } else {
      expectOk(send(w.svm, await releaseIx(w, t, claim), [w.provider]), "legacy release");
      assert.equal(bal(w, w.provider.publicKey) - before.worker, rent(w, acct.data.length) - TX_FEE, "worker: claim rent, less the fee");
    }
    assert.equal(bal(w, w.buyer.publicKey), before.creator, "creator: nothing");
  }
});
