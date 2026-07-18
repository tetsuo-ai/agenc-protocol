// Audit (2026-07 swarm): deregister_agent's initiator-slash guard read
// `agent.last_dispute_initiated` — a field that was NEVER WRITTEN, so the guard
// was dead code. A creator could initiate a frivolous dispute and immediately
// deregister (recovering their registration stake), permanently bricking
// apply_initiator_slash and evading the only initiator-side deterrent.
// initiate_dispute now stamps the field, so deregistration is held for
// max(dispute_duration, voting_period) + SLASH_WINDOW after initiation.
//
// Disclosed residual (same class as D7): the guard is timestamp-based, so a
// dispute that sits Active past the full window (~14 days) can still be
// evaded if the resolver rules only after it — resolver liveness within the
// dispute lifecycle is required, as designed.

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

const GUARD_WINDOW = 604_800 + 604_800; // max_dispute_duration(7d) + SLASH_WINDOW(7d)

async function setupCreatorDispute(w) {
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
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/c2", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "publish");
  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "claim");

  // Creator-initiated disputes need 2x min_stake_for_dispute on the creator's agent.
  await injectAgentStake(w.svm, w.buyerAgent, 300_000_000);
  const tid = decode(w.svm, "Task", task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [initRate] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.buyerProg.methods
    .initiateDispute(arr(disputeId), arr(tid), arr(Buffer.alloc(32, 1)), 0, "evidence")
    .accounts({ dispute, task, agent: w.buyerAgent, authorityRateLimit: initRate, protocolConfig: w.protocolPda, initiatorClaim: null, workerAgent: w.providerAgent, workerClaim: claim, taskSubmission: null, authority: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "creator initiates dispute");
  assert.ok(decode(w.svm, "Dispute", dispute).status.Active !== undefined, "dispute Active");

  return { task, escrow, hireRecord, claim, dispute };
}

async function deregisterIx(w, kp, agentPda) {
  return makeProgram(kp).methods
    .deregisterAgent()
    .accounts({
      agent: agentPda, protocolConfig: w.protocolPda,
      reputationStake: pda([enc("reputation_stake"), agentPda.toBuffer()])[0],
      authority: kp.publicKey,
    })
    .instruction();
}

test("initiator-slash guard: the frivolous-dispute deregistration evasion is blocked for the full window", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000 });
  const r = await setupCreatorDispute(w);

  // The timestamp is stamped at initiation.
  assert.ok(
    Number(decode(w.svm, "AgentRegistration", w.buyerAgent).last_dispute_initiated) > 0,
    "last_dispute_initiated stamped at initiation (was never written before)",
  );

  // The exploit step: deregister immediately after initiating -> BLOCKED.
  expectFail(
    send(w.svm, await deregisterIx(w, w.buyer, w.buyerAgent), [w.buyer]),
    "CooldownNotElapsed",
    "immediate deregistration after initiating is blocked (the evasion)",
  );
  assert.ok(!isClosed(w.svm, w.buyerAgent), "initiator agent still live");

  // Past the full dispute-lifecycle + slash window, deregistration is legal again
  // (the documented residual: the resolver must rule within the lifecycle, as designed).
  const c = w.svm.getClock();
  c.unixTimestamp = c.unixTimestamp + BigInt(GUARD_WINDOW + 60);
  w.svm.setClock(c);
  w.svm.expireBlockhash(); // the blocked attempt above is the byte-identical tx
  expectOk(send(w.svm, await deregisterIx(w, w.buyer, w.buyerAgent), [w.buyer]), "deregister after the guard window");
  assert.ok(isClosed(w.svm, w.buyerAgent), "initiator agent deregistered after the window");
});
