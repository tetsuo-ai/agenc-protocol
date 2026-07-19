// Audit F-1: cancel_task's no-show worker-bond forfeit must be bound to a LIVE
// no-show claimant of the task.
//
// Pre-fix exploit: an honest worker W claims, posts a 25% bond, and submits; the
// creator rejects (claim closed, task reopens, W's bond is hostage because
// reclaim_completion_bond needs a terminal task). The creator's sybil V then
// claims and never delivers; past the deadline the creator calls cancel_task
// (InProgress, completions == 0 -> is_no_show_cancel) passing W's bond PDA + W's
// wallet, and the forfeit fires against W — stealing the bond of a worker who
// delivered. The fix requires the forfeited bond's wallet to be one of the live
// claim triples' rent-recipient wallets (each constrained == worker.authority).
//
// Revert-sensitive: dropping the membership require turns the first test green
// for the attacker (the cancel succeeds and W's bond moves to the creator).

import test from "node:test";
import assert from "node:assert/strict";
import {
  freshWorld, makeProgram, send, expectOk, expectFail, decode, isClosed,
  pda, enc, arr, id32, BN, SystemProgram,
  taskModV2Pda, moderationBlockPda,
} from "./harness.mjs";
import { Keypair } from "@solana/web3.js";
import { Buffer } from "node:buffer";
import crypto from "node:crypto";

async function registerAgent(w, kp, { capabilities = 1, endpoint = "http://v.test" } = {}) {
  const prog = makeProgram(kp);
  const agentId = id32();
  const [agent] = pda([enc("agent"), agentId]);
  expectOk(send(w.svm, await prog.methods
    .registerAgent(arr(agentId), new BN(capabilities), endpoint, null, new BN(0))
    .accounts({ agent, protocolConfig: w.protocolPda, authority: kp.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [kp]), "register sybil agent");
  return { agentId, agent };
}

// CreatorReview task -> moderate + publish -> W claims + posts bond + submits ->
// creator rejects (task reopens to Open, W's claim closes, and W's bond is
// refunded atomically so it can never become a later cancel/close hostage).
async function rejectedWorkerWithBond(w) {
  const modProg = makeProgram(w.modAuth);
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
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(4_000_000), 1, new BN(now + 3600), 0, null, 0, null, null, 0)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "create task");
  expectOk(send(w.svm, await w.buyerProg.methods
    .configureTaskValidation(1, new BN(3600), 0, null)
    .accounts({ task, taskValidationConfig: validation, taskAttestorConfig: attestor, protocolConfig: w.protocolPda, hireRecord, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "configure CreatorReview");

  const jobHash = id32();
  const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "task moderation");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/f1", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "publish job spec");

  // W claims, posts the 25% worker bond (1_000_000), and submits for review.
  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec,
      hireRecord: pda([enc("hire"), task.toBuffer()])[0], legacyListing: null,
      moderationBlock: moderationBlockPda(jobHash)[0], claim,
      protocolConfig: w.protocolPda, worker: w.providerAgent,
      authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "W claims");
  const [workerBond] = pda([enc("completion_bond"), task.toBuffer(), w.provider.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .postCompletionBond(1)
    .accounts({ task, protocolConfig: w.protocolPda, completionBond: workerBond,
      worker: w.providerAgent, workerClaim: claim, authority: w.provider.publicKey,
      systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "W posts bond");
  const [submission] = pda([enc("task_submission"), claim.toBuffer()]);
  const desc2 = Buffer.alloc(64);
  desc2.set(crypto.randomBytes(32), 0);
  expectOk(send(w.svm, await w.providerProg.methods
    .submitTaskResult(arr(id32()), arr(desc2))
    .accounts({ task, claim, taskValidationConfig: validation, taskSubmission: submission, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "W submits");

  // Creator rejects -> task reopens to Open; claim and worker bond close together.
  expectOk(send(w.svm, await w.buyerProg.methods
    .rejectTaskResult(arr(id32()))
    .accounts({ task, claim, taskValidationConfig: validation, taskSubmission: submission, worker: w.providerAgent, protocolConfig: w.protocolPda, creator: w.buyer.publicKey, workerAuthority: w.provider.publicKey, agentStats: null, workerCompletionBond: workerBond })
    .instruction(), [w.buyer]), "creator rejects");
  assert.ok(decode(w.svm, "Task", task).status.Open !== undefined, "task reopened to Open after reject");
  assert.ok(isClosed(w.svm, workerBond), "W's bond refunded atomically on rejection");

  return { task, escrow, validation, jobSpec, jobHash, workerBond, deadline: now + 3600 };
}

async function claimAsSybil(w, r) {
  const v = Keypair.generate();
  w.svm.airdrop(v.publicKey, BigInt(100e9));
  const vProg = makeProgram(v);
  const { agent: vAgent } = await registerAgent(w, v);
  const [vClaim] = pda([enc("claim"), r.task.toBuffer(), vAgent.toBuffer()]);
  expectOk(send(w.svm, await vProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task: r.task, taskJobSpec: r.jobSpec,
      hireRecord: pda([enc("hire"), r.task.toBuffer()])[0], legacyListing: null,
      moderationBlock: moderationBlockPda(r.jobHash)[0], claim: vClaim,
      protocolConfig: w.protocolPda, worker: vAgent,
      authority: v.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [v]), "V claims the reopened task");
  assert.ok(decode(w.svm, "Task", r.task).status.InProgress !== undefined, "task InProgress after V's claim");
  return { v, vProg, vAgent, vClaim };
}

function warpPast(w, deadline) {
  const c = w.svm.getClock();
  c.unixTimestamp = BigInt(deadline) + 100n;
  w.svm.setClock(c);
}

test("F-1: cancel_task CANNOT forfeit an honest rejected worker's bond via a sybil no-show", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000 });
  const r = await rejectedWorkerWithBond(w);
  const { v, vAgent, vClaim } = await claimAsSybil(w, r);
  warpPast(w, r.deadline);

  // The exploit: cancel with V's live no-show claim triple, but W's bond + W's wallet.
  expectFail(send(w.svm, await w.buyerProg.methods
    .cancelTask()
    .accounts({
      task: r.task, escrow: r.escrow, authority: w.buyer.publicKey, protocolConfig: w.protocolPda,
      systemProgram: SystemProgram.programId,
      tokenEscrowAta: null, creatorTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0], workerCompletionBond: r.workerBond,
      workerBondAuthority: w.provider.publicKey,
      creatorAgent: null, agentStats: null,
      treasury: null,
    })
    .remainingAccounts([
      { pubkey: vClaim, isSigner: false, isWritable: true },
      { pubkey: vAgent, isSigner: false, isWritable: true },
      { pubkey: v.publicKey, isSigner: false, isWritable: true },
    ])
    .instruction(), [w.buyer]),
    "BondNotTiedToNoShowWorker",
    "forfeit of an out-of-set worker's bond is rejected (F-1)");

  // The already-refunded W bond stays closed and the task is still InProgress.
  assert.ok(isClosed(w.svm, r.workerBond), "W's refunded bond cannot be stolen later");
  assert.ok(decode(w.svm, "Task", r.task).status.InProgress !== undefined, "task not cancelled by the rejected exploit");
});

test("F-1: the legit no-show forfeit still works (bond of the LIVE no-show worker)", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000 });
  const r = await rejectedWorkerWithBond(w);
  const { v, vProg, vAgent, vClaim } = await claimAsSybil(w, r);

  // V (the sybil) posts their own 25% bond — the genuinely forfeitable one.
  const [vBond] = pda([enc("completion_bond"), r.task.toBuffer(), v.publicKey.toBuffer()]);
  expectOk(send(w.svm, await vProg.methods
    .postCompletionBond(1)
    .accounts({ task: r.task, protocolConfig: w.protocolPda, completionBond: vBond,
      worker: vAgent, workerClaim: vClaim, authority: v.publicKey,
      systemProgram: SystemProgram.programId })
    .instruction(), [v]), "V posts bond");
  warpPast(w, r.deadline);

  const buyerBefore = Number(w.svm.getBalance(w.buyer.publicKey));
  const escrowBefore = Number(w.svm.getBalance(r.escrow)); // refund (4M) + rent, drained to the creator on cancel
  expectOk(send(w.svm, await w.buyerProg.methods
    .cancelTask()
    .accounts({
      task: r.task, escrow: r.escrow, authority: w.buyer.publicKey, protocolConfig: w.protocolPda,
      systemProgram: SystemProgram.programId,
      tokenEscrowAta: null, creatorTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0], workerCompletionBond: vBond, workerBondAuthority: v.publicKey,
      creatorAgent: null, agentStats: null,
      treasury: null,
    })
    .remainingAccounts([
      { pubkey: vClaim, isSigner: false, isWritable: true },
      { pubkey: vAgent, isSigner: false, isWritable: true },
      { pubkey: v.publicKey, isSigner: false, isWritable: true },
    ])
    .instruction(), [w.buyer]), "cancel with the LIVE no-show worker's bond");

  // The creator's delta is the escrow drain (refund + rent) PLUS the 1,000,000 forfeit
  // MINUS the 5,000-lamport tx fee (the buyer is fee payer); V's bond PDA is settled;
  // W's bond was already refunded at rejection.
  const buyerDelta = Number(w.svm.getBalance(w.buyer.publicKey)) - buyerBefore;
  assert.equal(buyerDelta, escrowBefore + 1_000_000 - 5_000, `creator received escrow (${escrowBefore}) + the live no-show worker's bond, less the tx fee (got ${buyerDelta})`);
  assert.ok(isClosed(w.svm, vBond), "V's bond PDA settled");
  assert.ok(isClosed(w.svm, r.workerBond), "W's bond remains safely refunded");
});
