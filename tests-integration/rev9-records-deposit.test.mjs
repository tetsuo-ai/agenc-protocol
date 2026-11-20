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
import {
  PID, enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode, isClosed,
  freshWorld, seatTestAuthorityResolver, configureTestMultisig, hireIx,
  taskModV2Pda, listingModV2Pda, moderationBlockPda,
  agentStatsPda, creatorStatsPda, readCreatorStats,
  BN, Keypair, SystemProgram,
} from "./harness.mjs";

const TX_FEE = 5_000n;
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
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
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
  // Exact: the worker pays the fee, the claim rent and the record rent.
  assert.equal(before - bal(w, w.provider.publicKey), TX_FEE + rent(w, 203) + rent(w, 121), "worker paid claim rent + record rent + fee");

  // A second claim on another task creates nothing new.
  const t2 = await publishedTask(w);
  const before2 = bal(w, w.provider.publicKey);
  const second = await claimIx(w, t2);
  expectOk(send(w.svm, second.ix, [w.provider]), "second claim");
  assert.equal(before2 - bal(w, w.provider.publicKey), TX_FEE + rent(w, 203), "existing record costs nothing");
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
    .accounts({ authority: cranker.publicKey, task: t.task, escrow: t.escrow, claim, worker: w.providerAgent,
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
  const w = await freshWorld({ moderationEnabled: true, price: 3_000_000 });
  const [listingMod] = listingModV2Pda(w.listing, w.specHash, w.modAuth.publicKey);
  if (isClosed(w.svm, listingMod)) {
    expectOk(send(w.svm, await makeProgram(w.modAuth).methods
      .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
      .accounts({ moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
      .instruction(), [w.modAuth]), "listing-mod");
  }
  const { ix: hix, task, hireRecord, taskJobSpecHash: jobHash } = await hireIx(w, { listingModeration: listingMod });
  expectOk(send(w.svm, hix, [w.buyer]), "hire");
  const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  expectOk(send(w.svm, await makeProgram(w.modAuth).methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "task-mod");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/rev9-cancel-dispute", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "publish");
  const { ix: cix, claim } = await claimIx(w, { task, jobSpec, hireRecord, jobHash });
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
    .accounts({ protocolConfig: w.protocolPda, dispute, task, authority: w.buyer.publicKey,
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

    expectOk(send(w.svm, await makeProgram(w.admin).methods
      .resolveRejectFrozen(approve)
      .accounts({ task: t.task, claim, escrow: t.escrow, taskSubmission: submission, worker: w.providerAgent,
        protocolConfig: w.protocolPda, treasury: w.admin.publicKey, creator: w.buyer.publicKey,
        workerAuthority: w.provider.publicKey, hireRecord: t.hireRecord, operator: null, referrer: null,
        authority: w.admin.publicKey, creatorCompletionBond: completionBond(t.task, w.buyer.publicKey),
        workerCompletionBond: completionBond(t.task, w.provider.publicKey), systemProgram: SystemProgram.programId,
        workerStats: agentStatsPda(w.providerAgent), creatorStats: creatorStatsPda(w.buyer.publicKey) })
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
