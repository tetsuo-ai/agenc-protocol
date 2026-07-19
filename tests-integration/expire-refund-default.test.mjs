// Audit (2026-07 swarm): expire_dispute's post-P6.3 no-votes distribution was the
// arbiter-era 50/50 fairness split — but arbiter voting is retired, so EVERY
// expired dispute is an UNRESOLVED one, and a no-show worker could self-dispute,
// wait out the resolver window, and steal 50% of any claimable escrow (plus a
// full bid-bond slash even when they submitted). Expiry now refunds the funder
// in full, while objective no-show evidence still carries the ordinary bond
// penalty. A bare worker self-dispute is no longer a valid entry path.
//
// Revert-sensitive: restoring the 50/50 arm makes the "worker gets nothing but
// their claim rent" assertions fail.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  enc, arr, pda, id32,
  makeProgram, send, expectOk, decode, isClosed,
  freshWorld, hireIx,
  listingModV2Pda, taskModV2Pda, moderationBlockPda,
  BN, Keypair, SystemProgram,
} from "./harness.mjs";
import { Buffer } from "node:buffer";

async function setupCreatorNoShowDispute(w) {
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
    .accounts({ task, taskJobSpec: jobSpec, hireRecord, legacyListing: null,
      moderationBlock: moderationBlockPda(jobHash)[0], claim,
      protocolConfig: w.protocolPda, worker: w.providerAgent,
      authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "claim");

  // Post the worker's completion bond before the creator disputes the no-show.
  // The expired claim + canonical empty submission PDA below are the objective
  // evidence that permits expiry to forfeit this principal to the creator.
  const [workerBond] = pda([enc("completion_bond"), task.toBuffer(), w.provider.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .postCompletionBond(1)
    .accounts({
      task, protocolConfig: w.protocolPda, completionBond: workerBond,
      worker: w.providerAgent, workerClaim: claim, authority: w.provider.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .instruction(), [w.provider]), "worker posts completion bond");

  // A worker may dispute only after submitting work. For a true no-show, the
  // creator opens the dispute and binds the defendant's live claim instead.
  const tid = decode(w.svm, "Task", task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [initRate] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.buyerProg.methods
    .initiateDispute(arr(disputeId), arr(tid), arr(Buffer.alloc(32, 1)), 0, "evidence")
    .accounts({ dispute, task, agent: w.buyerAgent, authorityRateLimit: initRate, protocolConfig: w.protocolPda, initiatorClaim: null, workerAgent: w.providerAgent, workerClaim: claim, taskSubmission: null, authority: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "creator disputes no-show");

  const [submission] = pda([enc("task_submission"), claim.toBuffer()]);
  return { task, escrow, hireRecord, claim, dispute, submission, workerBond };
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
      taskSubmission: r.submission, taskValidationConfig: null,
    })
    .instruction();
}

test("expire_dispute: unresolved principal returns to the creator while a proven no-show forfeits its bond", async () => {
  const REWARD = 4_000_000;
  const w = await freshWorld({ moderationEnabled: true, price: REWARD });
  const r = await setupCreatorNoShowDispute(w);

  // Both conditions matter: dispute expiry opens after the resolver window, but
  // the no-show penalty is allowed only strictly after the claim itself expires.
  const votingDeadline = Number(decode(w.svm, "Dispute", r.dispute).voting_deadline);
  const claimExpiresAt = Number(decode(w.svm, "TaskClaim", r.claim).expires_at);
  const c = w.svm.getClock();
  c.unixTimestamp = BigInt(Math.max(votingDeadline + 120, claimExpiresAt)) + 1n;
  w.svm.setClock(c);

  const cleaner = Keypair.generate();
  w.svm.airdrop(cleaner.publicKey, BigInt(10e9));
  const buyerBefore = Number(w.svm.getBalance(w.buyer.publicKey));
  const workerBefore = Number(w.svm.getBalance(w.provider.publicKey));
  const claimRent = Number(w.svm.getBalance(r.claim));
  const workerBondBalance = Number(w.svm.getBalance(r.workerBond));
  const workerBondPrincipal = Number(decode(w.svm, "CompletionBond", r.workerBond).amount);
  const workerBondRent = workerBondBalance - workerBondPrincipal;

  expectOk(send(w.svm, await expireIx(w, r, cleaner), [cleaner]), "expire_dispute after the resolver window");

  // The creator receives every reward lamport plus the objectively forfeited
  // completion-bond principal (and may also receive escrow-account rent).
  const buyerDelta = Number(w.svm.getBalance(w.buyer.publicKey)) - buyerBefore;
  assert.ok(
    buyerDelta >= REWARD + workerBondPrincipal,
    `creator received full escrow + no-show bond (got ${buyerDelta} >= ${REWARD + workerBondPrincipal})`,
  );

  // The no-show gets no task principal and no bond principal: only the rent from
  // the two worker-funded accounts that expiry closes.
  const workerDelta = Number(w.svm.getBalance(w.provider.publicKey)) - workerBefore;
  assert.equal(
    workerDelta,
    claimRent + workerBondRent,
    `no-show recovered only claim + bond rent (${workerDelta} == ${claimRent + workerBondRent})`,
  );
  assert.ok(isClosed(w.svm, r.workerBond), "no-show completion bond was settled and closed");

  // State unwind is intact: terminal task, claim closed, counters cleared.
  assert.ok(decode(w.svm, "Task", r.task).status.Cancelled !== undefined, "task Cancelled");
  assert.ok(isClosed(w.svm, r.claim), "claim closed with rent returned");
  assert.equal(decode(w.svm, "AgentRegistration", w.providerAgent).disputes_as_defendant, 0, "defendant counter cleared");

  // Expiry is a no-fault initiator outcome, but it must still pass through the
  // permissionless finalizer to release the ABI-preserving pending counter.
  const d = decode(w.svm, "Dispute", r.dispute);
  assert.ok(d.status.Expired !== undefined, "dispute Expired");
  const initiatorBefore = decode(w.svm, "AgentRegistration", w.buyerAgent);
  assert.equal(initiatorBefore.active_dispute_votes, 1, "expired outcome remains pending");
  expectOk(
    send(w.svm, await makeProgram(w.admin).methods
      .applyInitiatorSlash()
      .accounts({
        dispute: r.dispute, initiatorAgent: w.buyerAgent,
        protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.admin.publicKey,
      })
      .instruction(), [w.admin]),
    "expired dispute no-fault finalizer",
  );
  const initiatorAfter = decode(w.svm, "AgentRegistration", w.buyerAgent);
  assert.equal(initiatorAfter.active_dispute_votes, 0, "expired finalizer releases one outcome");
  assert.equal(initiatorAfter.stake.toString(), initiatorBefore.stake.toString(), "expiry does not slash stake");
  assert.equal(initiatorAfter.reputation, initiatorBefore.reputation, "expiry does not penalize reputation");
  assert.equal(decode(w.svm, "Dispute", r.dispute).initiator_slash_applied, true, "expiry marked finalized");
});
