// Audit (2026-07 swarm) — the dispute exits are designated un-brickers, so their
// defendant-counter decrements must SATURATE, not checked_sub: a legacy agent
// whose active_tasks drifted below its true open-claim count used to turn
// expire_dispute / resolve_dispute into permanent ArithmeticOverflow reverts,
// wedging the very instructions meant to recover the task. (The multi-worker
// loop helper already saturated — this was the inconsistent defendant path.)
//
// Revert-sensitive: with checked_sub restored, the expire below fails with
// ArithmeticOverflow instead of settling.

import test from "node:test";
import assert from "node:assert/strict";
import {
  PID, coder, enc, arr, pda, id32,
  makeProgram, send, expectOk, decode, isClosed,
  freshWorld, hireIx,
  listingModV2Pda, taskModV2Pda, moderationBlockPda,
  BN, Keypair, SystemProgram,
} from "./harness.mjs";
import { Buffer } from "node:buffer";

// Same shape as expire-refund-default.test.mjs: hired task -> worker claims ->
// creator disputes the no-show. Returns the PDAs expire_dispute needs.
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
  const { ix: hix, task, escrow, hireRecord, taskJobSpecHash: jobHash } = await hireIx(w, { taskId, listingModeration: listingMod });
  expectOk(send(w.svm, hix, [w.buyer]), "hire");

  const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "task-mod");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/drift", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "publish");
  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, hireRecord, legacyListing: null,
      moderationBlock: moderationBlockPda(jobHash)[0], claim,
      protocolConfig: w.protocolPda, worker: w.providerAgent,
      authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "claim");

  const tid = decode(w.svm, "Task", task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [initRate] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.buyerProg.methods
    .initiateDispute(arr(disputeId), arr(tid), arr(Buffer.alloc(32, 1)), 0, "evidence")
    .accounts({ dispute, task, agent: w.buyerAgent, authorityRateLimit: initRate, protocolConfig: w.protocolPda, initiatorClaim: null, workerAgent: w.providerAgent, workerClaim: claim, taskSubmission: null, authority: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "creator disputes no-show");

  const [submission] = pda([enc("task_submission"), claim.toBuffer()]);
  return { task, escrow, hireRecord, claim, dispute, submission };
}

// Directly mutate an AgentRegistration field in place (decode -> mutate ->
// re-encode) — the only way to reproduce LEGACY counter drift in a test world.
async function injectAgentField(w, agentPda, mutate) {
  const acct = w.svm.getAccount(agentPda);
  const agent = coder.accounts.decode("AgentRegistration", Buffer.from(acct.data));
  mutate(agent);
  const data = await coder.accounts.encode("AgentRegistration", agent);
  w.svm.setAccount(agentPda, {
    lamports: Number(acct.lamports),
    data,
    owner: PID,
    executable: false,
    rentEpoch: 0,
  });
}

test("expire_dispute: a drifted active_tasks == 0 cannot brick the unwind (saturating decrement)", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000 });
  const r = await setupCreatorNoShowDispute(w);

  // Simulate legacy counter drift: the claim is open (task.current_workers == 1)
  // but the worker's active_tasks reads 0. checked_sub(1) reverts here.
  await injectAgentField(w, w.providerAgent, (a) => { a.active_tasks = 0; });

  // Warp past both the resolver window and the claim deadline.
  const votingDeadline = Number(decode(w.svm, "Dispute", r.dispute).voting_deadline);
  const claimExpiresAt = Number(decode(w.svm, "TaskClaim", r.claim).expires_at);
  const c = w.svm.getClock();
  c.unixTimestamp = BigInt(Math.max(votingDeadline + 120, claimExpiresAt)) + 1n;
  w.svm.setClock(c);

  const crank = Keypair.generate();
  w.svm.airdrop(crank.publicKey, BigInt(10e9));
  const creatorBond = pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0];
  const workerBond = pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()])[0];

  expectOk(send(w.svm, await makeProgram(crank).methods
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
    .instruction(), [crank]), "expire_dispute over a drifted counter");

  // The unwind completed and the counter saturated at 0 (no underflow revert).
  assert.ok(decode(w.svm, "Task", r.task).status.Cancelled !== undefined, "task Cancelled");
  assert.ok(isClosed(w.svm, r.claim), "claim closed");
  const agent = decode(w.svm, "AgentRegistration", w.providerAgent);
  assert.equal(agent.active_tasks, 0, "active_tasks saturated at 0");
  assert.equal(agent.disputes_as_defendant, 0, "defendant counter cleared");
});
