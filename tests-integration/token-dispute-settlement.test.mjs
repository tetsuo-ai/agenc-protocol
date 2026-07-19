// Compiled LiteSVM coverage for every SPL-token dispute settlement branch.
//
// These tests execute target/deploy/agenc_coordination.so. They deliberately use an
// odd reward so integer rounding is pinned on Refund/Split, and they pass a real
// treasury ATA to resolution so Complete's explicit no-protocol-fee policy cannot be
// hidden by an omitted destination.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Buffer } from "node:buffer";

import {
  PID, coder, enc, arr, pda, id32,
  makeProgram, send, sendMany, expectOk, decode, isClosed, tokenAmount,
  freshWorld, taskModV2Pda, moderationBlockPda,
  BN, Keypair, SystemProgram,
  MINT_SIZE, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  createInitializeMintInstruction, createAssociatedTokenAccountInstruction,
  createMintToInstruction, getAssociatedTokenAddressSync,
} from "./harness.mjs";

const REWARD = 5_000_001n;
const SLASH_PERCENTAGE = 50n; // freshWorld's ProtocolConfig fixture
const REFUND_SLASH_RESERVE = (REWARD * SLASH_PERCENTAGE) / 100n;

function amount(value) {
  return BigInt(value.toString());
}

async function mutateProgramAccount(w, address, accountName, mutate) {
  const account = w.svm.getAccount(address);
  assert.ok(account, `${accountName} account exists before mutation`);
  const value = coder.accounts.decode(accountName, Buffer.from(account.data));
  mutate(value);
  const data = await coder.accounts.encode(accountName, value);
  w.svm.setAccount(address, {
    lamports: Number(account.lamports),
    data,
    owner: PID,
    executable: false,
    rentEpoch: 0,
  });
}

function assertTokenConservation(w, r, expected, label) {
  const actual = {
    creator: tokenAmount(w.svm, r.creatorAta),
    worker: tokenAmount(w.svm, r.workerAta),
    treasury: tokenAmount(w.svm, r.treasuryAta),
    escrow: tokenAmount(w.svm, r.escrowAta),
  };
  assert.deepEqual(actual, expected, `${label}: exact token distribution`);
  assert.equal(
    actual.creator + actual.worker + actual.treasury + actual.escrow,
    REWARD,
    `${label}: every reward token is accounted for`,
  );
}

function assertDrainedTokenEscrow(w, r, label) {
  assert.ok(isClosed(w.svm, r.escrowAta), `${label}: token escrow ATA closed`);
  assert.equal(tokenAmount(w.svm, r.escrowAta), 0n, `${label}: no token remains in escrow`);

  // resolve_dispute intentionally retains a drained TaskEscrow PDA as the durable
  // signal apply_dispute_slash uses to distinguish "reserve pending" from "settled".
  // Its creator-reclaimable rent is handled by close_task; no reward principal remains.
  const escrow = decode(w.svm, "TaskEscrow", r.escrow);
  assert.ok(escrow, `${label}: drained TaskEscrow state remains readable`);
  assert.equal(escrow.is_closed, true, `${label}: TaskEscrow is marked settled`);
  assert.equal(amount(escrow.amount) - amount(escrow.distributed), 0n, `${label}: no undistributed principal`);
}

async function setupTokenDispute(w, resolutionType) {
  const mint = Keypair.generate();
  const mintRent = Number(w.svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE)));
  expectOk(sendMany(w.svm, [
    SystemProgram.createAccount({
      fromPubkey: w.admin.publicKey,
      newAccountPubkey: mint.publicKey,
      lamports: mintRent,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(mint.publicKey, 0, w.admin.publicKey, null),
  ], [w.admin, mint]), "token-dispute: create mint");

  const creatorAta = getAssociatedTokenAddressSync(mint.publicKey, w.buyer.publicKey);
  const workerAta = getAssociatedTokenAddressSync(mint.publicKey, w.provider.publicKey);
  const treasuryAta = getAssociatedTokenAddressSync(mint.publicKey, w.admin.publicKey);
  expectOk(sendMany(w.svm, [
    createAssociatedTokenAccountInstruction(w.admin.publicKey, creatorAta, w.buyer.publicKey, mint.publicKey),
    createAssociatedTokenAccountInstruction(w.admin.publicKey, workerAta, w.provider.publicKey, mint.publicKey),
    createAssociatedTokenAccountInstruction(w.admin.publicKey, treasuryAta, w.admin.publicKey, mint.publicKey),
    createMintToInstruction(mint.publicKey, creatorAta, w.admin.publicKey, Number(REWARD)),
  ], [w.admin]), "token-dispute: create and fund settlement ATAs");

  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const escrowAta = getAssociatedTokenAddressSync(mint.publicKey, escrow, true);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const [hireRecord] = pda([enc("hire"), task.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const description = Buffer.alloc(64);
  description.set(crypto.randomBytes(32), 0);

  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(
      arr(taskId), new BN(1), arr(description), new BN(REWARD.toString()),
      1, new BN(now + 3600), 0, null, 0, mint.publicKey, null, 0,
    )
    .accounts({
      task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent,
      authorityRateLimit: rateLimit, authority: w.buyer.publicKey,
      creator: w.buyer.publicKey, systemProgram: SystemProgram.programId,
      rewardMint: mint.publicKey, creatorTokenAccount: creatorAta,
      tokenEscrowAta: escrowAta, tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .instruction(), [w.buyer]), "token-dispute: create token task");

  const jobHash = id32();
  const [taskModeration] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  const [taskJobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  const modProg = makeProgram(w.modAuth);
  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(
      arr(jobHash), 0, 0, new BN(0),
      arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0),
    )
    .accounts({
      moderationConfig: w.modCfg, task, taskModeration,
      moderator: w.modAuth.publicKey, moderationAttestor: null,
      systemProgram: SystemProgram.programId,
    })
    .instruction(), [w.modAuth]), "token-dispute: moderate task");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/token-dispute", w.modAuth.publicKey)
    .accounts({
      protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg,
      taskModeration, moderationAttestor: null,
      moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec,
      creator: w.buyer.publicKey, systemProgram: SystemProgram.programId,
    })
    .instruction(), [w.buyer]), "token-dispute: publish task");

  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({
      task, taskJobSpec, hireRecord, legacyListing: null,
      moderationBlock: moderationBlockPda(jobHash)[0], claim,
      protocolConfig: w.protocolPda, worker: w.providerAgent,
      authority: w.provider.publicKey, systemProgram: SystemProgram.programId,
    })
    .instruction(), [w.provider]), "token-dispute: claim task");

  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [initiatorRateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.buyerProg.methods
    .initiateDispute(
      arr(disputeId), arr(decode(w.svm, "Task", task).task_id),
      arr(Buffer.alloc(32, 3)), resolutionType, "token settlement dispute",
    )
    .accounts({
      dispute, task, agent: w.buyerAgent, authorityRateLimit: initiatorRateLimit,
      protocolConfig: w.protocolPda, initiatorClaim: null,
      workerAgent: w.providerAgent, workerClaim: claim, taskSubmission: null,
      authority: w.buyer.publicKey, systemProgram: SystemProgram.programId,
    })
    .instruction(), [w.buyer]), "token-dispute: initiate dispute");

  const [submission] = pda([enc("task_submission"), claim.toBuffer()]);
  const [creatorBond] = pda([
    enc("completion_bond"), task.toBuffer(), w.buyer.publicKey.toBuffer(),
  ]);
  const [workerBond] = pda([
    enc("completion_bond"), task.toBuffer(), w.provider.publicKey.toBuffer(),
  ]);

  const result = {
    mint: mint.publicKey,
    creatorAta, workerAta, treasuryAta,
    task, escrow, escrowAta, claim, dispute, submission,
    hireRecord, taskJobSpec, creatorBond, workerBond,
  };
  assertTokenConservation(w, result, {
    creator: 0n, worker: 0n, treasury: 0n, escrow: REWARD,
  }, "setup");
  assert.ok(decode(w.svm, "Task", task).status.Disputed !== undefined, "setup: task Disputed");
  return result;
}

async function resolveTokenDispute(w, r, approve) {
  const ix = await makeProgram(w.admin).methods
    .resolveDispute(approve, arr(Buffer.alloc(32, 9)), "agenc://ruling/sha256/token-settlement")
    .accounts({
      dispute: r.dispute, task: r.task, escrow: r.escrow,
      protocolConfig: w.protocolPda, authority: w.admin.publicKey,
      resolverAssignment: null, creator: w.buyer.publicKey,
      workerClaim: r.claim, worker: w.providerAgent,
      agentStats: null, workerWallet: w.provider.publicKey,
      hireRecord: r.hireRecord, disputeOperator: null, disputeReferrer: null,
      systemProgram: SystemProgram.programId,
      tokenEscrowAta: r.escrowAta, creatorTokenAccount: r.creatorAta,
      workerTokenAccountAta: r.workerAta, treasuryTokenAccount: r.treasuryAta,
      rewardMint: r.mint, tokenProgram: TOKEN_PROGRAM_ID,
      creatorCompletionBond: r.creatorBond, workerCompletionBond: r.workerBond,
      bondTreasury: w.admin.publicKey,
      taskSubmission: r.submission, taskValidationConfig: null,
    })
    .instruction();
  expectOk(send(w.svm, ix, [w.admin]), `token-dispute: resolve (${approve ? "approve" : "reject"})`);
}

test("token dispute Refund: creator receives the non-slash half, then the deferred reserve reaches treasury and both escrows close", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await setupTokenDispute(w, 0); // Refund

  await resolveTokenDispute(w, r, true);

  const creatorRefund = REWARD - REFUND_SLASH_RESERVE;
  assertTokenConservation(w, r, {
    creator: creatorRefund, worker: 0n, treasury: 0n, escrow: REFUND_SLASH_RESERVE,
  }, "Refund after ruling");
  assert.ok(!isClosed(w.svm, r.escrowAta), "Refund: token ATA remains live only for the deferred slash reserve");
  const pendingEscrow = decode(w.svm, "TaskEscrow", r.escrow);
  assert.equal(pendingEscrow.is_closed, false, "Refund: TaskEscrow records pending reserve");
  assert.equal(amount(pendingEscrow.amount) - amount(pendingEscrow.distributed), REFUND_SLASH_RESERVE, "Refund: exact reserve recorded as undistributed");
  assert.ok(decode(w.svm, "Task", r.task).status.Cancelled !== undefined, "Refund: task Cancelled");
  assert.equal(decode(w.svm, "Task", r.task).current_workers, 1, "Refund: worker slot stays live until slash finalizer");
  assert.ok(!isClosed(w.svm, r.claim), "Refund: claim stays live until slash finalizer");

  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .applyDisputeSlash()
    .accounts({
      dispute: r.dispute, task: r.task, workerClaim: r.claim,
      workerAgent: w.providerAgent, workerAuthority: w.provider.publicKey,
      protocolConfig: w.protocolPda, treasury: w.admin.publicKey,
      authority: w.admin.publicKey, escrow: r.escrow,
      tokenEscrowAta: r.escrowAta, treasuryTokenAccount: r.treasuryAta,
      rewardMint: r.mint, tokenProgram: TOKEN_PROGRAM_ID,
      creator: w.buyer.publicKey,
    })
    .instruction(), [w.admin]), "token-dispute: apply deferred Refund slash");

  assertTokenConservation(w, r, {
    creator: creatorRefund, worker: 0n,
    treasury: REFUND_SLASH_RESERVE, escrow: 0n,
  }, "Refund finalized");
  assert.ok(isClosed(w.svm, r.escrowAta), "Refund: token escrow ATA closed by slash finalizer");
  assert.ok(isClosed(w.svm, r.escrow), "Refund: TaskEscrow PDA closed by slash finalizer");
  assert.ok(isClosed(w.svm, r.claim), "Refund: worker claim closed by slash finalizer");
  assert.equal(decode(w.svm, "Task", r.task).current_workers, 0, "Refund: worker slot released");
  assert.equal(decode(w.svm, "Dispute", r.dispute).slash_applied, true, "Refund: slash obligation finalized");
});

test("upgrade compatibility: deployed token Split finalizes its historical slash reserve and claim", async () => {
  const w = await freshWorld({ moderationEnabled: true });

  // Start from a real candidate deferred-reserve fixture, then rewrite only the
  // fields whose deployed 097ded1 representation/policy differed. Deployed Split
  // treated the worker as losing, retained this same reserve + claim, zeroed both
  // task/agent activity counters, and had no durable pending bit.
  const r = await setupTokenDispute(w, 0); // Refund produces the deferred fixture.
  await resolveTokenDispute(w, r, true);
  await mutateProgramAccount(w, r.task, "Task", (task) => {
    task.current_workers = 0;
    task._reserved[2] = 0;
  });
  await mutateProgramAccount(w, w.providerAgent, "AgentRegistration", (worker) => {
    worker.active_tasks = 0;
  });
  await mutateProgramAccount(w, r.dispute, "Dispute", (dispute) => {
    dispute.resolution_type = { Split: {} };
  });

  assert.equal(decode(w.svm, "Task", r.task).current_workers, 0);
  assert.equal(decode(w.svm, "Task", r.task)._reserved[2], 0);
  assert.ok(decode(w.svm, "Dispute", r.dispute).resolution_type.Split !== undefined);
  assert.ok(!isClosed(w.svm, r.claim), "deployed Split retained the losing claim");
  assert.ok(!isClosed(w.svm, r.escrowAta), "deployed Split retained its token slash reserve");
  assertTokenConservation(w, r, {
    creator: REWARD - REFUND_SLASH_RESERVE,
    worker: 0n,
    treasury: 0n,
    escrow: REFUND_SLASH_RESERVE,
  }, "deployed Split before finalizer");

  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .applyDisputeSlash()
    .accounts({
      dispute: r.dispute, task: r.task, workerClaim: r.claim,
      workerAgent: w.providerAgent, workerAuthority: w.provider.publicKey,
      protocolConfig: w.protocolPda, treasury: w.admin.publicKey,
      authority: w.admin.publicKey, escrow: r.escrow,
      tokenEscrowAta: r.escrowAta, treasuryTokenAccount: r.treasuryAta,
      rewardMint: r.mint, tokenProgram: TOKEN_PROGRAM_ID,
      creator: w.buyer.publicKey,
    })
    .instruction(), [w.admin]), "finalize deployed token Split");

  assertTokenConservation(w, r, {
    creator: REWARD - REFUND_SLASH_RESERVE,
    worker: 0n,
    treasury: REFUND_SLASH_RESERVE,
    escrow: 0n,
  }, "deployed Split finalized");
  assert.ok(isClosed(w.svm, r.escrowAta), "deployed Split token escrow closed");
  assert.ok(isClosed(w.svm, r.escrow), "deployed Split state escrow closed");
  assert.ok(isClosed(w.svm, r.claim), "deployed Split claim closed");
  const worker = decode(w.svm, "AgentRegistration", w.providerAgent);
  assert.equal(worker.disputes_as_defendant, 0, "deployed Split liability released");
  assert.equal(worker.active_tasks, 0, "deployed activity counter remains released");
  assert.equal(decode(w.svm, "Task", r.task).current_workers, 0);
  assert.equal(decode(w.svm, "Task", r.task)._reserved[2], 0);
});

test("token dispute Complete: worker receives the full reward and treasury receives no protocol fee", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await setupTokenDispute(w, 1); // Complete
  const workerBefore = decode(w.svm, "AgentRegistration", w.providerAgent);

  await resolveTokenDispute(w, r, true);

  assertTokenConservation(w, r, {
    creator: 0n, worker: REWARD, treasury: 0n, escrow: 0n,
  }, "Complete");
  assertDrainedTokenEscrow(w, r, "Complete");
  assert.ok(decode(w.svm, "Task", r.task).status.Completed !== undefined, "Complete: task Completed");
  assert.equal(decode(w.svm, "Task", r.task).current_workers, 0, "Complete: worker slot released");
  assert.ok(isClosed(w.svm, r.claim), "Complete: worker claim closed");
  assert.equal(tokenAmount(w.svm, r.treasuryAta), 0n, "Complete: explicit policy takes no protocol fee");
  const workerAfter = decode(w.svm, "AgentRegistration", w.providerAgent);
  assert.equal(
    amount(workerAfter.tasks_completed) - amount(workerBefore.tasks_completed),
    1n,
    "Complete: token settlement records one worker completion",
  );
  assert.equal(
    amount(workerAfter.total_earned),
    amount(workerBefore.total_earned),
    "Complete: token base units never enter SOL-denominated worker earnings",
  );
  assert.equal(
    workerAfter.reputation,
    workerBefore.reputation,
    "Complete: no-fee token dispute does not mint completion reputation",
  );
});

test("token dispute Split: odd reward rounds one token to creator, pays both parties, and creates no slash reserve", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await setupTokenDispute(w, 2); // Split

  await resolveTokenDispute(w, r, true);

  const workerShare = REWARD / 2n;
  const creatorShare = REWARD - workerShare;
  assertTokenConservation(w, r, {
    creator: creatorShare, worker: workerShare, treasury: 0n, escrow: 0n,
  }, "Split");
  assertDrainedTokenEscrow(w, r, "Split");
  assert.ok(decode(w.svm, "Task", r.task).status.Cancelled !== undefined, "Split: task Cancelled");
  assert.equal(decode(w.svm, "Task", r.task).current_workers, 0, "Split: worker slot released");
  assert.equal(decode(w.svm, "Task", r.task)._reserved[2], 0, "Split: no worker slash pending");
  assert.ok(isClosed(w.svm, r.claim), "Split: worker claim closed");
});

test("token dispute rejected: creator receives the full reward and no token or claim is stranded", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await setupTokenDispute(w, 1); // requested Complete, resolver rejects it

  await resolveTokenDispute(w, r, false);

  assertTokenConservation(w, r, {
    creator: REWARD, worker: 0n, treasury: 0n, escrow: 0n,
  }, "Rejected");
  assertDrainedTokenEscrow(w, r, "Rejected");
  assert.ok(decode(w.svm, "Task", r.task).status.Cancelled !== undefined, "Rejected: task Cancelled");
  assert.ok(decode(w.svm, "Dispute", r.dispute).status.Resolved !== undefined, "Rejected: dispute Resolved");
  assert.equal(decode(w.svm, "Task", r.task).current_workers, 0, "Rejected: worker slot released");
  assert.ok(isClosed(w.svm, r.claim), "Rejected: worker claim closed");
});

test("token dispute expiry: permissionless expiry returns all principal and closes both token and state escrows", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await setupTokenDispute(w, 0);

  const dispute = decode(w.svm, "Dispute", r.dispute);
  const claim = decode(w.svm, "TaskClaim", r.claim);
  const clock = w.svm.getClock();
  clock.unixTimestamp = BigInt(Math.max(
    Number(dispute.voting_deadline) + 120,
    Number(claim.expires_at),
  )) + 1n;
  w.svm.setClock(clock);

  const crank = Keypair.generate();
  w.svm.airdrop(crank.publicKey, BigInt(10e9));
  expectOk(send(w.svm, await makeProgram(crank).methods
    .expireDispute()
    .accounts({
      dispute: r.dispute, task: r.task, escrow: r.escrow,
      protocolConfig: w.protocolPda, creator: w.buyer.publicKey,
      authority: crank.publicKey, workerClaim: r.claim,
      worker: w.providerAgent, workerWallet: w.provider.publicKey,
      hireRecord: r.hireRecord, disputeOperator: null, disputeReferrer: null,
      tokenEscrowAta: r.escrowAta, creatorTokenAccount: r.creatorAta,
      workerTokenAccountAta: r.workerAta, rewardMint: r.mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      creatorCompletionBond: r.creatorBond, workerCompletionBond: r.workerBond,
      taskSubmission: r.submission, taskValidationConfig: null,
    })
    .instruction(), [crank]), "token-dispute: expire");

  assertTokenConservation(w, r, {
    creator: REWARD, worker: 0n, treasury: 0n, escrow: 0n,
  }, "Expiry");
  assert.ok(isClosed(w.svm, r.escrowAta), "Expiry: token escrow ATA closed");
  assert.ok(isClosed(w.svm, r.escrow), "Expiry: TaskEscrow PDA closed");
  assert.ok(isClosed(w.svm, r.claim), "Expiry: worker claim closed");
  assert.ok(decode(w.svm, "Task", r.task).status.Cancelled !== undefined, "Expiry: task Cancelled");
  assert.ok(decode(w.svm, "Dispute", r.dispute).status.Expired !== undefined, "Expiry: dispute Expired");
  assert.equal(decode(w.svm, "Task", r.task).current_workers, 0, "Expiry: worker slots released");
  assert.equal(decode(w.svm, "AgentRegistration", w.providerAgent).active_tasks, 0, "Expiry: worker activity released");
  assert.equal(decode(w.svm, "AgentRegistration", w.providerAgent).disputes_as_defendant, 0, "Expiry: defendant liability released");
});
