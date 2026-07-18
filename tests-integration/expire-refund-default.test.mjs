// Audit (2026-07 swarm): expire_dispute's post-P6.3 no-votes distribution was the
// arbiter-era 50/50 fairness split — but arbiter voting is retired, so EVERY
// expired dispute is an UNRESOLVED one, and a no-show worker could self-dispute,
// wait out the resolver window, and steal 50% of any claimable escrow (plus a
// full bid-bond slash even when they submitted). Expiry now refunds the funder
// in full and refunds (never slashes) the accepted bid bond.
//
// Revert-sensitive: restoring the 50/50 arm makes the "worker gets nothing but
// their claim rent" assertions fail.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode, isClosed,
  freshWorld, hireIx, injectAgentStake,
  listingModV2Pda, taskModV2Pda, moderationBlockPda,
  BN, Keypair, SystemProgram,
} from "./harness.mjs";
import { Buffer } from "node:buffer";

async function setupWorkerSelfDispute(w) {
  const modProg = makeProgram(w.modAuth);
  const [listingMod] = listingModV2Pda(w.listing, w.specHash, w.modAuth.publicKey);
  if (isClosed(w.svm, listingMod)) {
    expectOk(send(w.svm, await modProg.methods
      .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
      .accounts({ moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
      .instruction(), [w.modAuth]), "listing-mod");
  }
  const taskId = id32();
  const { ix: hix, task, escrow, hireRecord } = await hireIx(w, { taskId, listingModeration: listingMod });
  expectOk(send(w.svm, hix, [w.buyer]), "hire");

  const jobHash = id32();
  const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "task-mod");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/exp", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "publish");
  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "claim");

  // The no-show worker self-initiates a dispute (initiator == defendant == self).
  await injectAgentStake(w.svm, w.providerAgent, 2_000_000);
  const tid = decode(w.svm, "Task", task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [initRate] = pda([enc("authority_rate_limit"), w.provider.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .initiateDispute(arr(disputeId), arr(tid), arr(Buffer.alloc(32, 1)), 0, "evidence")
    .accounts({ dispute, task, agent: w.providerAgent, authorityRateLimit: initRate, protocolConfig: w.protocolPda, initiatorClaim: claim, workerAgent: null, workerClaim: null, taskSubmission: null, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "worker self-dispute");

  return { task, escrow, hireRecord, claim, dispute };
}

async function expireIx(w, r, crank) {
  const creatorBond = pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0];
  const workerBond = pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()])[0];
  return makeProgram(crank).methods
    .expireDispute()
    .accounts({
      dispute: r.dispute, task: r.task, escrow: r.escrow, protocolConfig: w.protocolPda,
      creator: w.buyer.publicKey, authority: crank.publicKey,
      workerClaim: r.claim, worker: w.providerAgent, workerWallet: w.provider.publicKey,
      hireRecord: r.hireRecord, disputeOperator: null, disputeReferrer: null,
      tokenEscrowAta: null, creatorTokenAccount: null, workerTokenAccountAta: null,
      rewardMint: null, tokenProgram: null,
      creatorCompletionBond: creatorBond, workerCompletionBond: workerBond,
      taskSubmission: null, taskValidationConfig: null,
    })
    .instruction();
}

test("expire_dispute (post-P6.3): an expired dispute refunds the CREATOR in full — a self-disputing no-show gets nothing", async () => {
  const REWARD = 4_000_000;
  const w = await freshWorld({ moderationEnabled: true, price: REWARD });
  const r = await setupWorkerSelfDispute(w);

  // Warp past the resolver window: voting_deadline (= created_at + voting_period) + 120s grace.
  const votingDeadline = Number(decode(w.svm, "Dispute", r.dispute).voting_deadline);
  const c = w.svm.getClock();
  c.unixTimestamp = BigInt(votingDeadline) + 121n;
  w.svm.setClock(c);

  const cleaner = Keypair.generate();
  w.svm.airdrop(cleaner.publicKey, BigInt(10e9));
  const buyerBefore = Number(w.svm.getBalance(w.buyer.publicKey));
  const workerBefore = Number(w.svm.getBalance(w.provider.publicKey));
  const claimRent = Number(w.svm.getBalance(r.claim));

  expectOk(send(w.svm, await expireIx(w, r, cleaner), [cleaner]), "expire_dispute after the resolver window");

  // The CREATOR is refunded the full remaining escrow (pre-fix: only half).
  const buyerDelta = Number(w.svm.getBalance(w.buyer.publicKey)) - buyerBefore;
  assert.ok(
    buyerDelta >= REWARD,
    `creator refunded the full escrow (got ${buyerDelta} >= ${REWARD}; pre-fix it was ${REWARD / 2})`,
  );

  // The no-show worker gets NOTHING from the escrow — exactly their own claim
  // rent back and not one lamport more (pre-fix: claim rent + 50% of escrow).
  const workerDelta = Number(w.svm.getBalance(w.provider.publicKey)) - workerBefore;
  assert.equal(
    workerDelta,
    claimRent,
    `no-show worker recovered ONLY their claim rent (${workerDelta} == ${claimRent}; pre-fix: + ${REWARD / 2} of escrow)`,
  );

  // State unwind is intact: terminal task, claim closed, counters cleared.
  assert.ok(decode(w.svm, "Task", r.task).status.Cancelled !== undefined, "task Cancelled");
  assert.ok(isClosed(w.svm, r.claim), "claim closed with rent returned");
  assert.equal(decode(w.svm, "AgentRegistration", w.providerAgent).disputes_as_defendant, 0, "defendant counter cleared");

  // And an expired dispute is never initiator-slashable — but the initiator lost
  // nothing either (they got no payout; the deterrent is the creator's full refund).
  const d = decode(w.svm, "Dispute", r.dispute);
  assert.ok(d.status.Expired !== undefined, "dispute Expired");
  expectFail(
    send(w.svm, await makeProgram(w.admin).methods
      .applyInitiatorSlash()
      .accounts({
        dispute: r.dispute, initiatorAgent: w.providerAgent,
        protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.admin.publicKey,
      })
      .instruction(), [w.admin]),
    "DisputeNotResolved",
    "expired disputes are not initiator-slashable",
  );
});
