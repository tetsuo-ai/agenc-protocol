// Revision 9 (B): every task dispute costs the filer a bond of max(10% of the
// disputed amount, 0.01 SOL), held in a DisputeBond at ["dispute_bond", dispute].
// The loser's principal goes to the winner; the rent always goes back to the
// filer. Single-worker review tasks refuse task disputes from both sides.
// Design: REV9-DESIGN.md sections 2 and 11.2.
//
// Executes the COMPILED program. Instructions are built with today's account
// names plus the new ones (today's IDL ignores unknown names), so on fed99ab the
// same calls run without a bond and each test fails for the reason in its title.
//
// Run: node --test tests-integration/rev9-dispute-bond.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode, isClosed,
  freshWorld, seatTestAuthorityResolver, mutateTask,
  taskModV2Pda, moderationBlockPda,
  agentStatsPda, creatorStatsPda, readCreatorStats, creatorStatsCreationCost,
  disputeBondPda, disputeRespondent, findEvents, coder, sendMany,
  BN, Keypair, SystemProgram,
} from "./harness.mjs";

const TX_FEE = 5_000n;
const BOND_FLOOR = 10_000_000n;
const BOND_SIZE = 186;
const rent = (w, size) => BigInt(w.svm.minimumBalanceForRentExemption(BigInt(size)));
const bal = (w, key) => BigInt(w.svm.getBalance(key) ?? 0n);
const completionBond = (task, wallet) => pda([enc("completion_bond"), task.toBuffer(), wallet.toBuffer()])[0];
// Lamports a payer spends right now to create a record (0 when it exists).
const recordCost = (w, address, size) => {
  const acct = w.svm.getAccount(address);
  return acct && acct.data.length > 0 ? 0n : rent(w, size) - BigInt(acct?.lamports ?? 0);
};
const status = (w, address, name) => Object.keys(decode(w.svm, name, address).status)[0];

function warpTo(w, unixTimestamp) {
  const c = w.svm.getClock();
  c.unixTimestamp = BigInt(unixTimestamp);
  w.svm.setClock(c);
  w.svm.expireBlockhash();
}

function systemAccount(w, address, lamports) {
  w.svm.setAccount(address, { lamports: Number(lamports), data: Buffer.alloc(0), owner: SystemProgram.programId, executable: false, rentEpoch: 0 });
}

function readAgentStats(w) {
  const s = decode(w.svm, "AgentStats", agentStatsPda(w.providerAgent));
  return { won: BigInt(s.disputes_won.toString()), lost: BigInt(s.disputes_lost.toString()) };
}

async function publish(w, task, jobHash = id32()) {
  const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  expectOk(send(w.svm, await makeProgram(w.modAuth).methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId, rentPayer: w.modAuth.publicKey })
    .instruction(), [w.modAuth]), "db:task-mod");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/rev9-dispute-bond", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "db:publish");
  return { jobHash, jobSpec };
}

async function claim(w, t) {
  t.claim = pda([enc("claim"), t.task.toBuffer(), w.providerAgent.toBuffer()])[0];
  t.submission = pda([enc("task_submission"), t.claim.toBuffer()])[0];
  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task: t.task, taskJobSpec: t.jobSpec, hireRecord: t.hireRecord, legacyListing: null,
      moderationBlock: moderationBlockPda(t.jobHash)[0], claim: t.claim, protocolConfig: w.protocolPda,
      worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId,
      workerStats: agentStatsPda(w.providerAgent) })
    .instruction(), [w.provider]), "db:claim");
}

async function submit(w, t) {
  expectOk(send(w.svm, await w.providerProg.methods
    .submitTaskResult(arr(id32()), arr(Buffer.concat([Buffer.alloc(63), Buffer.from([7])])))
    .accounts({ task: t.task, claim: t.claim, taskValidationConfig: t.validation, taskSubmission: t.submission, protocolConfig: w.protocolPda,
      worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "db:submit");
}

// Creator-filed target: an Auto-mode task (Exclusive, one worker, no validation
// config) made with create_task, published and claimed, no delivery. Task disputes
// stay allowed on Auto-mode tasks. (Since PR 6 an agent-door hire is a CreatorReview
// task, so a hire no longer serves here.)
async function hiredClaimed(w, { reward = w.price } = {}) {
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const t = {
    task,
    escrow: pda([enc("escrow"), task.toBuffer()])[0],
    hireRecord: pda([enc("hire"), task.toBuffer()])[0],
    validation: null,
    reward: BigInt(reward),
  };
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  const now = Number(w.svm.getClock().unixTimestamp);
  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(reward), 1, new BN(now + 3600), 0, null, 0, null, null, 0)
    .accounts({ task, escrow: t.escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent,
      authorityRateLimit: pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()])[0],
      authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId,
      rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "db:create Auto task");
  Object.assign(t, await publish(w, task));
  await claim(w, t);
  return t;
}

// Review target made with create_task + CreatorReview, claimed and submitted.
// `taskType` 0 is a single-worker review task (task disputes refused); 1 is a
// Collaborative task (task disputes allowed).
async function reviewSubmitted(w, { taskType, reward = 200_000_000, maxWorkers = 1 } = {}) {
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const t = {
    task,
    escrow: pda([enc("escrow"), task.toBuffer()])[0],
    validation: pda([enc("task_validation"), task.toBuffer()])[0],
    hireRecord: pda([enc("hire"), task.toBuffer()])[0],
    reward: BigInt(reward),
  };
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  const now = Number(w.svm.getClock().unixTimestamp);
  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(reward), maxWorkers, new BN(now + 7 * 86_400), taskType, null, 0, null, null, 0)
    .accounts({ task, escrow: t.escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent,
      authorityRateLimit: pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()])[0],
      authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId,
      rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "db:create_task");
  expectOk(send(w.svm, await w.buyerProg.methods
    .configureTaskValidation(1, new BN(3600), 0, null)
    .accounts({ task, taskValidationConfig: t.validation, taskAttestorConfig: pda([enc("task_attestor"), task.toBuffer()])[0],
      protocolConfig: w.protocolPda, hireRecord: t.hireRecord, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "db:configure CreatorReview");
  Object.assign(t, await publish(w, task));
  await claim(w, t);
  await submit(w, t);
  return t;
}

function newDispute() {
  const disputeId = id32();
  return { disputeId, dispute: pda([enc("dispute"), Buffer.from(disputeId)])[0] };
}

async function creatorFilesIx(w, t, resolutionType, { disputeId, dispute } = newDispute()) {
  const tid = decode(w.svm, "Task", t.task).task_id;
  const ix = await w.buyerProg.methods
    .initiateDispute(arr(disputeId), arr(tid), arr(Buffer.alloc(32, 1)), resolutionType, "creator evidence")
    .accounts({ dispute, task: t.task, agent: w.buyerAgent,
      authorityRateLimit: pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()])[0],
      protocolConfig: w.protocolPda, initiatorClaim: null, workerAgent: w.providerAgent, workerClaim: t.claim,
      taskSubmission: isClosed(w.svm, t.submission) ? null : t.submission,
      authority: w.buyer.publicKey, systemProgram: SystemProgram.programId, disputeBond: disputeBondPda(dispute) })
    .instruction();
  return { ix, dispute };
}

async function workerFilesIx(w, t, resolutionType, { disputeId, dispute } = newDispute()) {
  const tid = decode(w.svm, "Task", t.task).task_id;
  const ix = await w.providerProg.methods
    .initiateDispute(arr(disputeId), arr(tid), arr(Buffer.alloc(32, 2)), resolutionType, "worker evidence")
    .accounts({ dispute, task: t.task, agent: w.providerAgent,
      authorityRateLimit: pda([enc("authority_rate_limit"), w.provider.publicKey.toBuffer()])[0],
      protocolConfig: w.protocolPda, initiatorClaim: t.claim, workerAgent: null, workerClaim: null,
      taskSubmission: t.submission, authority: w.provider.publicKey, systemProgram: SystemProgram.programId,
      disputeBond: disputeBondPda(dispute) })
    .instruction();
  return { ix, dispute };
}

async function resolveIx(w, t, dispute, approve) {
  const entry = await seatTestAuthorityResolver(w);
  return makeProgram(w.admin).methods
    .resolveDispute(approve, arr(Buffer.alloc(32, 9)), "agenc://ruling/rev9-dispute-bond")
    .accounts({ dispute, task: t.task, escrow: t.escrow, protocolConfig: w.protocolPda,
      authority: w.admin.publicKey, resolverAssignment: entry, creator: w.buyer.publicKey,
      workerClaim: t.claim, worker: w.providerAgent, workerWallet: w.provider.publicKey,
      agentStats: agentStatsPda(w.providerAgent), hireRecord: t.hireRecord, disputeOperator: null, disputeReferrer: null,
      systemProgram: SystemProgram.programId, tokenEscrowAta: null, creatorTokenAccount: null, workerTokenAccountAta: null,
      treasuryTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: completionBond(t.task, w.buyer.publicKey), workerCompletionBond: completionBond(t.task, w.provider.publicKey),
      bondTreasury: w.admin.publicKey, taskSubmission: t.submission, taskValidationConfig: t.validation,
      disputeBond: disputeBondPda(dispute), creatorStats: creatorStatsPda(w.buyer.publicKey) })
    .instruction();
}

function expireIx(w, t, dispute, crank) {
  return makeProgram(crank).methods
    .expireDispute()
    .accounts({ dispute, task: t.task, escrow: t.escrow, protocolConfig: w.protocolPda, creator: w.buyer.publicKey,
      authority: crank.publicKey, workerClaim: t.claim, worker: w.providerAgent, workerWallet: w.provider.publicKey,
      hireRecord: t.hireRecord, disputeOperator: null, disputeReferrer: null, tokenEscrowAta: null, creatorTokenAccount: null,
      workerTokenAccountAta: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: completionBond(t.task, w.buyer.publicKey), workerCompletionBond: completionBond(t.task, w.provider.publicKey),
      taskSubmission: t.submission, taskValidationConfig: t.validation,
      disputeBond: disputeBondPda(dispute), workerStats: agentStatsPda(w.providerAgent),
      creatorStats: creatorStatsPda(w.buyer.publicKey), systemProgram: SystemProgram.programId })
    .instruction();
}

function cancelIx(w, t, dispute, filer, { respondent = disputeRespondent(w.svm, dispute) } = {}) {
  return makeProgram(filer).methods
    .cancelDispute()
    .accounts({ protocolConfig: w.protocolPda, dispute, task: t.task, authority: filer.publicKey,
      disputeBond: disputeBondPda(dispute), respondent,
      workerStats: agentStatsPda(w.providerAgent), creatorStats: creatorStatsPda(w.buyer.publicKey),
      systemProgram: SystemProgram.programId })
    .remainingAccounts([
      { pubkey: w.providerAgent, isSigner: false, isWritable: true },
      ...(t.validation ? [{ pubkey: t.validation, isSigner: false, isWritable: true }] : []),
    ])
    .instruction();
}

function crankerFor(w) {
  const k = Keypair.generate();
  w.svm.airdrop(k.publicKey, 1_000_000_000n);
  return k;
}

function lastRulingSecond(w, dispute) {
  const d = decode(w.svm, "Dispute", dispute);
  return Math.min(Number(d.expires_at.toString()), Number(d.voting_deadline.toString()) + 120 - 1);
}

// ---------------------------------------------------------------------------
// 11.2 item 1. fed99ab: no bond account, the filing succeeds.
// ---------------------------------------------------------------------------
test("rev9 dispute bond: initiate_dispute without the bond account fails (fed99ab: succeeds)", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 200_000_000 });
  const t = await hiredClaimed(w);
  const { ix, dispute } = await creatorFilesIx(w, t, 0);
  const bond = disputeBondPda(dispute);
  ix.keys = ix.keys.filter((meta) => !meta.pubkey.equals(bond));
  expectFail(send(w.svm, ix, [w.buyer]), "AccountNotEnoughKeys", "rev9: the bond account is required");
  assert.ok(isClosed(w.svm, dispute), "no dispute was filed");
  assert.equal(status(w, t.task, "Task"), "InProgress", "the task is untouched");
});

// ---------------------------------------------------------------------------
// 11.2 item 2. fed99ab: filing costs only the Dispute rent.
// ---------------------------------------------------------------------------
test("rev9 dispute bond: filing moves exactly max(10%, 0.01 SOL) above the bond rent, from either side (fed99ab: no bond)", async () => {
  // Creator files on a 0.2 SOL hire: 10% = 0.02 SOL.
  {
    const w = await freshWorld({ moderationEnabled: true, price: 200_000_000 });
    const t = await hiredClaimed(w);
    const before = bal(w, w.buyer.publicKey);
    const { ix, dispute } = await creatorFilesIx(w, t, 0);
    const res = expectOk(send(w.svm, ix, [w.buyer]), "creator files");
    const bondAddress = disputeBondPda(dispute);
    assert.ok(!isClosed(w.svm, bondAddress), "the bond account exists");
    const b = decode(w.svm, "DisputeBond", bondAddress);
    const disputeRent = rent(w, w.svm.getAccount(dispute).data.length);
    assert.equal(BigInt(b.amount.toString()), 20_000_000n, "10% of the price");
    assert.equal(bal(w, bondAddress), rent(w, BOND_SIZE) + 20_000_000n, "bond account: its rent plus the principal");
    assert.equal(before - bal(w, w.buyer.publicKey), 20_000_000n + rent(w, BOND_SIZE) + disputeRent + TX_FEE, "creator paid bond, bond rent, dispute rent and the fee");
    assert.equal(b.kind, 1, "kind 1: task dispute");
    assert.equal(b.subject.toBase58(), dispute.toBase58(), "subject is the Dispute account");
    assert.equal(b.task.toBase58(), t.task.toBase58(), "task");
    assert.equal(b.filer.toBase58(), w.buyer.publicKey.toBase58(), "filer: the creator wallet");
    assert.equal(b.respondent.toBase58(), w.provider.publicKey.toBase58(), "respondent: the defendant worker's wallet");
    assert.equal(Number(b.ruling_deadline.toString()), lastRulingSecond(w, dispute), "ruling deadline: the dispute's last ruling second");
    const posted = findEvents(res, "DisputeBondPosted");
    assert.equal(posted.length, 1, "DisputeBondPosted emitted");
    assert.equal(posted[0].amount.toString(), "20000000", "event amount");
  }
  // Worker files on a 0.4 SOL Collaborative task with two slots: 10% of its
  // 0.2 SOL share = 0.02 SOL.
  {
    const w = await freshWorld({ moderationEnabled: true });
    const t = await reviewSubmitted(w, { taskType: 1, reward: 400_000_000, maxWorkers: 2 });
    const before = bal(w, w.provider.publicKey);
    const { ix, dispute } = await workerFilesIx(w, t, 1);
    expectOk(send(w.svm, ix, [w.provider]), "worker files");
    const b = decode(w.svm, "DisputeBond", disputeBondPda(dispute));
    assert.equal(BigInt(b.amount.toString()), 20_000_000n, "10% of the defendant's share, not of the whole reward");
    assert.equal(b.filer.toBase58(), w.provider.publicKey.toBase58(), "filer: the worker wallet");
    assert.equal(b.respondent.toBase58(), w.buyer.publicKey.toBase58(), "respondent: the creator");
    const disputeRent = rent(w, w.svm.getAccount(dispute).data.length);
    const rateLimitRent = rent(w, w.svm.getAccount(pda([enc("authority_rate_limit"), w.provider.publicKey.toBuffer()])[0]).data.length);
    assert.equal(before - bal(w, w.provider.publicKey), 20_000_000n + rent(w, BOND_SIZE) + disputeRent + rateLimitRent + TX_FEE, "worker paid bond, bond rent, dispute and rate-limit rent and the fee");
  }
  // A small job pays the floor.
  {
    const w = await freshWorld({ moderationEnabled: true, price: 5_000_000 });
    const t = await hiredClaimed(w);
    const { ix, dispute } = await creatorFilesIx(w, t, 0);
    expectOk(send(w.svm, ix, [w.buyer]), "creator files on a small job");
    assert.equal(BigInt(decode(w.svm, "DisputeBond", disputeBondPda(dispute)).amount.toString()), BOND_FLOOR, "0.01 SOL floor");
  }
});

// ---------------------------------------------------------------------------
// 11.2 item 3 + item 5. Every ending, both filers, exact deltas.
// fed99ab: no bond moves.
// ---------------------------------------------------------------------------
const endings = [
  // Creator files Refund on an Auto-mode hire.
  { filer: "creator", ending: "approve", principalTo: "filer" },
  { filer: "creator", ending: "reject", principalTo: "respondent" },
  { filer: "creator", ending: "expire", principalTo: "filer" },
  { filer: "creator", ending: "cancel", principalTo: "respondent" },
  // Worker files Complete on a one-worker Collaborative review task.
  { filer: "worker", ending: "approve", principalTo: "filer" },
  { filer: "worker", ending: "reject", principalTo: "respondent" },
  { filer: "worker", ending: "expire", principalTo: "filer" },
  { filer: "worker", ending: "cancel", principalTo: "respondent" },
];

for (const { filer, ending, principalTo } of endings) {
  test(`rev9 dispute bond: ${filer}-filed, ${ending}: the bond principal goes to the ${principalTo}, the rent to the filer (fed99ab: no bond)`, async () => {
    const w = await freshWorld({ moderationEnabled: true, price: 200_000_000 });
    const byCreator = filer === "creator";
    const t = byCreator ? await hiredClaimed(w) : await reviewSubmitted(w, { taskType: 1, reward: 200_000_000 });
    const { ix, dispute } = byCreator ? await creatorFilesIx(w, t, 0) : await workerFilesIx(w, t, 1);
    expectOk(send(w.svm, ix, [byCreator ? w.buyer : w.provider]), "file");
    const bondAddress = disputeBondPda(dispute);
    assert.ok(!isClosed(w.svm, bondAddress), "the bond exists");
    const B = bal(w, bondAddress);
    const P = BigInt(decode(w.svm, "DisputeBond", bondAddress).amount.toString());
    assert.equal(P, 20_000_000n, "10% of 0.2 SOL");
    if (ending !== "cancel") await seatTestAuthorityResolver(w);
    const before = {
      creator: bal(w, w.buyer.publicKey), worker: bal(w, w.provider.publicKey),
      escrow: bal(w, t.escrow), claim: bal(w, t.claim), submission: bal(w, t.submission),
      claimRent: rent(w, w.svm.getAccount(t.claim).data.length),
    };
    const creatorRecordCost = creatorStatsCreationCost(w.svm, w.buyer.publicKey);
    let res;
    if (ending === "approve" || ending === "reject") {
      res = expectOk(send(w.svm, await resolveIx(w, t, dispute, ending === "approve"), [w.admin]), ending);
    } else if (ending === "expire") {
      warpTo(w, lastRulingSecond(w, dispute) + 1);
      const crank = crankerFor(w);
      res = expectOk(send(w.svm, await expireIx(w, t, dispute, crank), [crank]), "expire");
    } else {
      res = expectOk(send(w.svm, await cancelIx(w, t, dispute, byCreator ? w.buyer : w.provider), [byCreator ? w.buyer : w.provider]), "cancel");
    }
    const d = { creator: bal(w, w.buyer.publicKey) - before.creator, worker: bal(w, w.provider.publicKey) - before.worker };
    assert.ok(isClosed(w.svm, bondAddress), "the bond is settled");
    const settled = findEvents(res, "DisputeBondSettled");
    assert.equal(settled.length, 1, "DisputeBondSettled emitted once");
    const filerKey = byCreator ? w.buyer.publicKey : w.provider.publicKey;
    const respondentKey = byCreator ? w.provider.publicKey : w.buyer.publicKey;
    assert.equal(settled[0].recipient.toBase58(), (principalTo === "filer" ? filerKey : respondentKey).toBase58(), "principal recipient");

    // What the bond adds to each side.
    const toFiler = principalTo === "filer" ? B : B - P;
    const toRespondent = principalTo === "filer" ? 0n : P;
    const bondCreator = byCreator ? toFiler : toRespondent;
    const bondWorker = byCreator ? toRespondent : toFiler;
    const claimBack = isClosed(w.svm, t.claim) ? before.claim : 0n;
    const submissionBack = !byCreator && isClosed(w.svm, t.submission) ? before.submission : 0n;

    if (byCreator) {
      if (ending === "cancel") {
        assert.equal(d.creator, bondCreator - TX_FEE - creatorRecordCost, "creator: bond rent only, less its fee");
        assert.equal(d.worker, bondWorker, "worker: the bond principal");
        assert.equal(status(w, t.task, "Task"), "InProgress", "task restored");
      } else if (ending === "expire") {
        // The unruled expiry refunds the whole escrow. The dispute was filed while
        // the claim was live, so it never makes the deposit forfeitable (review
        // R1-1): the claim closes to the worker with its deposit.
        const claimDeposit = before.claim - before.claimRent;
        assert.equal(claimDeposit, 20_000_000n, "the claim held a deposit of 10% of 0.2 SOL");
        assert.equal(d.creator, before.escrow + bondCreator, "creator: whole escrow and its bond share");
        assert.equal(d.worker, before.claim + bondWorker, "worker: claim rent and deposit plus its bond share");
      } else {
        // A Refund ruling (approved or rejected) refunds the whole escrow to the
        // creator, as today.
        assert.equal(d.creator, before.escrow + bondCreator, "creator: whole escrow plus its bond share");
        assert.equal(d.worker, claimBack + bondWorker, "worker: claim rent (unless a slash defers it) plus its bond share");
      }
    } else if (ending === "approve") {
      // Complete approved: the worker is paid the price without a fee (task
      // disputes keep today's no-fee rule); the creator gets the escrow rent.
      assert.equal(d.worker, t.reward + before.claim + before.submission + bondWorker, "worker: price, its rents and its whole bond");
      assert.equal(d.creator, before.escrow - t.reward, "creator: the escrow rent");
    } else if (ending === "cancel") {
      // The cancelling filer pays for any missing record (here the creator's).
      assert.equal(d.worker, bondWorker - TX_FEE - creatorRecordCost, "worker: bond rent only, less its fee and the missing creator record");
      assert.equal(d.creator, bondCreator, "creator: the bond principal");
      assert.equal(status(w, t.task, "Task"), "PendingValidation", "back under review");
    } else {
      assert.equal(d.creator, before.escrow + bondCreator, "creator: whole escrow plus its bond share");
      assert.equal(d.worker, claimBack + submissionBack + bondWorker, "worker: its rents plus its bond share");
    }

    // 11.2 item 5: the worker's own rejected dispute is its loss.
    if (!byCreator && ending === "reject") {
      assert.deepEqual(readAgentStats(w), { won: 0n, lost: 1n }, "worker disputes_lost, not disputes_won");
      assert.equal(readCreatorStats(w.svm, creatorStatsPda(w.buyer.publicKey)).disputesWon, 1n, "creator disputes_won");
    }
  });
}

// ---------------------------------------------------------------------------
// 11.2 item 4. fed99ab: both filings succeed on a single-worker review task.
// ---------------------------------------------------------------------------
test("rev9 dispute bond: no task dispute on a single-worker review task, from either side (fed99ab: both succeed)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const t = await reviewSubmitted(w, { taskType: 0 });
  const creator = await creatorFilesIx(w, t, 0);
  expectFail(send(w.svm, creator.ix, [w.buyer]), "DisputeRefusedOnReviewTask", "the buyer freezes instead");
  const worker = await workerFilesIx(w, t, 1);
  expectFail(send(w.svm, worker.ix, [w.provider]), "DisputeRefusedOnReviewTask", "the worker disputes a freeze instead");
  assert.equal(status(w, t.task, "Task"), "PendingValidation", "still under review");
  assert.ok(isClosed(w.svm, creator.dispute) && isClosed(w.svm, worker.dispute), "no dispute filed");
});

// ---------------------------------------------------------------------------
// Ruling window edges: the bond's ruling deadline is the last second a ruling
// can land; expiry opens one second later. fed99ab: no bond.
// ---------------------------------------------------------------------------
test("rev9 dispute bond: a ruling lands at the bond's ruling deadline, not one second later; expiry opens then (fed99ab: no bond)", async () => {
  {
    const w = await freshWorld({ moderationEnabled: true, price: 200_000_000 });
    const t = await hiredClaimed(w);
    const { ix, dispute } = await creatorFilesIx(w, t, 0);
    expectOk(send(w.svm, ix, [w.buyer]), "file");
    assert.ok(!isClosed(w.svm, disputeBondPda(dispute)), "the bond exists");
    const deadline = Number(decode(w.svm, "DisputeBond", disputeBondPda(dispute)).ruling_deadline.toString());
    const crank = crankerFor(w);
    warpTo(w, deadline);
    expectFail(send(w.svm, await expireIx(w, t, dispute, crank), [crank]), "DisputeNotExpired", "no expiry at the ruling deadline");
    expectOk(send(w.svm, await resolveIx(w, t, dispute, false), [w.admin]), "ruling at the deadline");
    assert.ok(isClosed(w.svm, disputeBondPda(dispute)), "bond settled by the ruling");
  }
  {
    const w = await freshWorld({ moderationEnabled: true, price: 200_000_000 });
    const t = await hiredClaimed(w);
    const { ix, dispute } = await creatorFilesIx(w, t, 0);
    expectOk(send(w.svm, ix, [w.buyer]), "file");
    const deadline = Number(decode(w.svm, "DisputeBond", disputeBondPda(dispute)).ruling_deadline.toString());
    await seatTestAuthorityResolver(w);
    warpTo(w, deadline + 1);
    expectFail(send(w.svm, await resolveIx(w, t, dispute, true), [w.admin]), "DisputeResolutionWindowExpired", "no ruling one second late");
    const crank = crankerFor(w);
    expectOk(send(w.svm, await expireIx(w, t, dispute, crank), [crank]), "expiry one second after the deadline");
    assert.ok(isClosed(w.svm, disputeBondPda(dispute)), "bond returned by the expiry");
  }
});

// ---------------------------------------------------------------------------
// Lead check 1: "no bond" is ownership, never balance. A dispute filed before
// the upgrade has an empty bond address; lamports sent there neither block the
// exits nor get moved. Filing over a pre-funded address works.
// ---------------------------------------------------------------------------
test("rev9 dispute bond: a pre-upgrade dispute (empty, pre-funded bond address) settles every exit without moving those lamports (fed99ab: no bond)", async () => {
  const STRANGER = 3_000_000n;
  for (const ending of ["reject", "expire", "cancel"]) {
    const w = await freshWorld({ moderationEnabled: true, price: 200_000_000 });
    const t = await hiredClaimed(w);
    const { ix, dispute } = await creatorFilesIx(w, t, 0);
    expectOk(send(w.svm, ix, [w.buyer]), "file");
    // The state a dispute filed by revision 8 leaves: no bond, plus a stranger's lamports.
    const bondAddress = disputeBondPda(dispute);
    systemAccount(w, bondAddress, STRANGER);
    let res;
    if (ending === "reject") {
      res = expectOk(send(w.svm, await resolveIx(w, t, dispute, false), [w.admin]), "ruling with no bond");
    } else if (ending === "expire") {
      warpTo(w, lastRulingSecond(w, dispute) + 1);
      const crank = crankerFor(w);
      res = expectOk(send(w.svm, await expireIx(w, t, dispute, crank), [crank]), "expiry with no bond");
    } else {
      res = expectOk(send(w.svm, await cancelIx(w, t, dispute, w.buyer, { respondent: Keypair.generate().publicKey }), [w.buyer]), "cancel with no bond");
    }
    assert.equal(bal(w, bondAddress), STRANGER, `${ending}: the stranger's lamports stay where they were sent`);
    assert.equal(findEvents(res, "DisputeBondSettled").length, 0, `${ending}: no bond settled`);
  }
  // Filing over a pre-funded address: init tops up only the rent shortfall.
  const w = await freshWorld({ moderationEnabled: true, price: 200_000_000 });
  const t = await hiredClaimed(w);
  const ids = newDispute();
  const bondAddress = disputeBondPda(ids.dispute);
  const prefund = 1_000_000n;
  systemAccount(w, bondAddress, prefund);
  const before = bal(w, w.buyer.publicKey);
  const { ix, dispute } = await creatorFilesIx(w, t, 0, ids);
  expectOk(send(w.svm, ix, [w.buyer]), "file over a pre-funded bond address");
  const disputeRent = rent(w, w.svm.getAccount(dispute).data.length);
  assert.equal(bal(w, bondAddress), rent(w, BOND_SIZE) + 20_000_000n, "bond account: rent plus principal");
  assert.equal(before - bal(w, w.buyer.publicKey), 20_000_000n + rent(w, BOND_SIZE) - prefund + disputeRent + TX_FEE, "the filer pays only the rent shortfall plus the full bond");
});

// ---------------------------------------------------------------------------
// A bond that does not match the dispute cannot be settled: a ruling over a
// tampered respondent or a forged bond fails with InvalidDisputeBond (6424), and
// cancel_dispute needs the stored respondent.
// ---------------------------------------------------------------------------
test("rev9 dispute bond: a mismatched bond or respondent fails with InvalidDisputeBond (fed99ab: no bond)", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 200_000_000 });
  const t = await hiredClaimed(w);
  const { ix, dispute } = await creatorFilesIx(w, t, 0);
  expectOk(send(w.svm, ix, [w.buyer]), "file");
  const bondAddress = disputeBondPda(dispute);

  // cancel_dispute with a respondent that is not the stored one.
  expectFail(send(w.svm, await cancelIx(w, t, dispute, w.buyer, { respondent: Keypair.generate().publicKey }), [w.buyer]),
    "InvalidDisputeBond", "the respondent must be the stored one");

  // A tampered stored respondent no longer matches the worker wallet the ruling pays.
  const acct = w.svm.getAccount(bondAddress);
  const b = coder.accounts.decode("DisputeBond", Buffer.from(acct.data));
  b.respondent = Keypair.generate().publicKey;
  const data = Buffer.from(acct.data);
  (await coder.accounts.encode("DisputeBond", b)).copy(data, 0);
  w.svm.setAccount(bondAddress, { ...acct, data });
  expectFail(send(w.svm, await resolveIx(w, t, dispute, false), [w.admin]), "InvalidDisputeBond", "a mismatched bond cannot be settled");
  assert.equal(status(w, dispute, "Dispute"), "Active", "the dispute is still open");
});

// ---------------------------------------------------------------------------
// The single-worker refusal reads the Task alone: Auto-mode single-worker tasks
// keep task disputes (no manual-validation sentinel), and a manual single-worker
// task refuses them whatever its legacy mode. fed99ab: no refusal.
// ---------------------------------------------------------------------------
test("rev9 dispute bond: the refusal follows the manual sentinel, not the mode name (fed99ab: no refusal)", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 200_000_000 });
  const t = await hiredClaimed(w);
  const sentinel = Buffer.from("agenc-manual-validation-v2-seed!");
  await mutateTask(w, t.task, (task) => { task.constraint_hash = Array.from(sentinel); });
  const { ix } = await creatorFilesIx(w, t, 0);
  expectFail(send(w.svm, ix, [w.buyer]), "DisputeRefusedOnReviewTask", "a manual single-worker task refuses task disputes");
});

// ---------------------------------------------------------------------------
// Review R1-1: a dispute must never make a deposit forfeitable. While a task is
// Disputed no worker can deliver or leave, so the creator could file against one
// claim before the deadline, then cancel its own dispute and the task in one
// transaction after it and collect every drained deposit. Any filing now marks
// the task, and the drain returns each deposit to its worker.
// ---------------------------------------------------------------------------
async function registerWorker(w) {
  const kp = Keypair.generate();
  w.svm.airdrop(kp.publicKey, 100_000_000_000n);
  const prog = makeProgram(kp);
  const agentId = id32();
  const [agent] = pda([enc("agent"), agentId]);
  expectOk(send(w.svm, await prog.methods
    .registerAgent(arr(agentId), new BN(1), "http://second-worker.test", null, new BN(0))
    .accounts({ agent, protocolConfig: w.protocolPda, authority: kp.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [kp]), "db:register a second worker");
  return { kp, prog, agent };
}

test("rev9 dispute bond: a creator's dispute then [cancel_dispute, cancel_task] returns every drained deposit to its worker (review R1-1; f8c8782: the creator takes both)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const t = { task, escrow: pda([enc("escrow"), task.toBuffer()])[0], hireRecord: pda([enc("hire"), task.toBuffer()])[0], validation: null };
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  const deadline = Number(w.svm.getClock().unixTimestamp) + 4 * 3600;
  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(1_000_000_000), 2, new BN(deadline), 1, null, 0, null, null, 0)
    .accounts({ task, escrow: t.escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent,
      authorityRateLimit: pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()])[0],
      authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId,
      rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "db:create a Collaborative Auto task");
  Object.assign(t, await publish(w, task));
  await claim(w, t); // worker A (the provider)
  const b = await registerWorker(w);
  const claimB = pda([enc("claim"), task.toBuffer(), b.agent.toBuffer()])[0];
  expectOk(send(w.svm, await b.prog.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: t.jobSpec, hireRecord: t.hireRecord, legacyListing: null,
      moderationBlock: moderationBlockPda(t.jobHash)[0], claim: claimB, protocolConfig: w.protocolPda,
      worker: b.agent, authority: b.kp.publicKey, systemProgram: SystemProgram.programId,
      workerStats: agentStatsPda(b.agent) })
    .instruction(), [b.kp]), "db:worker B claims");
  const claimRent = (claim) => BigInt(w.svm.minimumBalanceForRentExemption(BigInt(w.svm.getAccount(claim).data.length)));
  const depositA = bal(w, t.claim) - claimRent(t.claim);
  const depositB = bal(w, claimB) - claimRent(claimB);
  assert.equal(depositA, 50_000_000n, "10% of a 0.5 SOL share");
  assert.equal(depositB, 50_000_000n);

  // The creator files against A half an hour before the deadline.
  warpTo(w, deadline - 1_800);
  const { ix: fileIx, dispute } = await creatorFilesIx(w, t, 0);
  expectOk(send(w.svm, fileIx, [w.buyer]), "db:creator files against A");
  const bondPrincipal = BigInt(decode(w.svm, "DisputeBond", disputeBondPda(dispute)).amount.toString());
  const bondRent = rent(w, BOND_SIZE);

  // One transaction after the deadline: cancel its own dispute, then the task.
  warpTo(w, deadline + 1);
  const cancelDispute = await cancelIx(w, t, dispute, w.buyer);
  const cancelTask = await w.buyerProg.methods
    .cancelTask()
    .accounts({ task, escrow: t.escrow, authority: w.buyer.publicKey, protocolConfig: w.protocolPda, systemProgram: SystemProgram.programId,
      tokenEscrowAta: null, creatorTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: completionBond(task, w.buyer.publicKey), workerCompletionBond: completionBond(task, w.provider.publicKey),
      workerBondAuthority: w.provider.publicKey, creatorAgent: null, agentStats: null, treasury: null,
      creatorStats: creatorStatsPda(w.buyer.publicKey) })
    .remainingAccounts([
      { pubkey: t.claim, isSigner: false, isWritable: true },
      { pubkey: w.providerAgent, isSigner: false, isWritable: true },
      { pubkey: w.provider.publicKey, isSigner: false, isWritable: true },
      { pubkey: claimB, isSigner: false, isWritable: true },
      { pubkey: b.agent, isSigner: false, isWritable: true },
      { pubkey: b.kp.publicKey, isSigner: false, isWritable: true },
    ])
    .instruction();
  const rentA = claimRent(t.claim);
  const rentB = claimRent(claimB);
  const escrowBefore = bal(w, t.escrow);
  const records = recordCost(w, creatorStatsPda(w.buyer.publicKey), 129) + recordCost(w, agentStatsPda(w.providerAgent), 121);
  const before = { creator: bal(w, w.buyer.publicKey), a: bal(w, w.provider.publicKey), b: bal(w, b.kp.publicKey) };
  const res = expectOk(sendMany(w.svm, [cancelDispute, cancelTask], [w.buyer]), "db:cancel the dispute and the task together");

  assert.equal(bal(w, b.kp.publicKey) - before.b, rentB + depositB, "B: its claim rent and its deposit");
  assert.equal(bal(w, w.provider.publicKey) - before.a, rentA + depositA + bondPrincipal, "A: its claim rent, its deposit and the bond principal");
  assert.equal(bal(w, w.buyer.publicKey) - before.creator, escrowBefore + bondRent - TX_FEE - records,
    "the creator: the escrow refund and the bond rent, no deposit");
  for (const settled of findEvents(res, "ClaimDepositSettled")) {
    assert.equal(settled.forfeited, false, "every deposit went back");
  }
});
