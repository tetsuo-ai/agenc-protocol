// Initiator-side lifecycle regression: a timestamp-only deregistration guard
// eventually aged out while an Active dispute could remain stale forever. The
// initiator could then cancel late (resetting resolved_at), deregister/refund in
// the same transaction, and brick the permissionless slash against zero stake.
//
// The historical `active_dispute_votes` byte is now an ABI-preserving count of
// initiated disputes whose initiator outcome has not been finalized. It never
// ages out; apply_initiator_slash is the single permissionless finalizer and
// releases the counter for losing, winning, and expired outcomes.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  PID, coder, enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode, isClosed,
  freshWorld, hireIx, injectAgentStake, deregisterRemaining,
  listingModV2Pda, taskModV2Pda, moderationBlockPda,
  BN, Keypair, SystemProgram,
} from "./harness.mjs";
import { Buffer } from "node:buffer";

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
    .accounts({ task, taskJobSpec: jobSpec, hireRecord, legacyListing: null,
      moderationBlock: moderationBlockPda(jobHash)[0], claim,
      protocolConfig: w.protocolPda, worker: w.providerAgent,
      authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "claim");

  // Creator-initiated disputes need 2x min_stake_for_dispute on the creator's agent.
  await injectAgentStake(w.svm, w.buyerAgent, 300_000_000);
  const fundedInitiator = w.svm.getAccount(w.buyerAgent);
  w.svm.setAccount(w.buyerAgent, {
    ...fundedInitiator,
    lamports: Number(fundedInitiator.lamports) + 300_000_000,
  });
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
    .remainingAccounts(deregisterRemaining(agentPda))
    .instruction();
}

async function injectAgentFields(w, agentPda, mutate) {
  const account = w.svm.getAccount(agentPda);
  const agent = coder.accounts.decode(
    "AgentRegistration",
    Buffer.from(account.data),
  );
  mutate(agent);
  const data = await coder.accounts.encode("AgentRegistration", agent);
  w.svm.setAccount(agentPda, {
    lamports: Number(account.lamports),
    data,
    owner: PID,
    executable: false,
    rentEpoch: 0,
  });
}

test("initiator outcome counter blocks stale cancel+deregister until the loss is finalized", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000 });
  const r = await setupCreatorDispute(w);

  // The timestamp is stamped at initiation.
  assert.ok(
    Number(decode(w.svm, "AgentRegistration", w.buyerAgent).last_dispute_initiated) > 0,
    "last_dispute_initiated stamped at initiation",
  );
  assert.equal(
    decode(w.svm, "AgentRegistration", w.buyerAgent).active_dispute_votes,
    1,
    "one initiator outcome is pending",
  );

  // The exploit step: deregister immediately after initiating -> BLOCKED.
  expectFail(
    send(w.svm, await deregisterIx(w, w.buyer, w.buyerAgent), [w.buyer]),
    "ActiveDisputeVotes",
    "immediate deregistration after initiating is blocked (the evasion)",
  );
  assert.ok(!isClosed(w.svm, w.buyerAgent), "initiator agent still live");

  // Cancellation is a losing outcome, but does not release the counter. This
  // closes the exact cancel+deregister race without a finite cooldown.
  w.svm.expireBlockhash();
  expectOk(send(w.svm, await w.buyerProg.methods
    .cancelDispute()
    .accounts({
      protocolConfig: w.protocolPda, dispute: r.dispute,
      task: r.task, authority: w.buyer.publicKey,
    })
    .remainingAccounts([{ pubkey: w.providerAgent, isSigner: false, isWritable: true }])
    .instruction(), [w.buyer]), "cancel active dispute");
  assert.equal(
    decode(w.svm, "AgentRegistration", w.buyerAgent).active_dispute_votes,
    1,
    "cancelled loss remains pending until the finalizer",
  );
  w.svm.expireBlockhash();
  expectFail(
    send(w.svm, await deregisterIx(w, w.buyer, w.buyerAgent), [w.buyer]),
    "ActiveDisputeVotes",
    "cancel alone cannot release the registration stake",
  );

  // Tagged disputes do not age out: the exact counter keeps the principal
  // locked, so the permissionless loss finalizer remains effective after the
  // historical seven-day deadline.
  const cancelledAt = Number(
    decode(w.svm, "Dispute", r.dispute).resolved_at,
  );
  const afterLegacyWindow = w.svm.getClock();
  afterLegacyWindow.unixTimestamp = BigInt(cancelledAt + 604_801);
  w.svm.setClock(afterLegacyWindow);

  const stakeBefore = Number(decode(w.svm, "AgentRegistration", w.buyerAgent).stake);
  w.svm.expireBlockhash();
  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .applyInitiatorSlash()
    .accounts({
      dispute: r.dispute, initiatorAgent: w.buyerAgent,
      protocolConfig: w.protocolPda, treasury: w.admin.publicKey,
      authority: w.admin.publicKey,
    })
    .instruction(), [w.admin]), "permissionless initiator loss finalizer");
  const finalized = decode(w.svm, "AgentRegistration", w.buyerAgent);
  assert.equal(finalized.active_dispute_votes, 0, "finalizer releases exactly one pending outcome");
  assert.ok(Number(finalized.stake) < stakeBefore, "cancelled initiator is slashed before release");

  // Once the exact tracked outcome is finalized, retirement succeeds
  // immediately; winners/no-fault outcomes are not held by a redundant 14-day
  // timer. The durable identity tombstone remains.
  w.svm.expireBlockhash();
  expectOk(send(w.svm, await deregisterIx(w, w.buyer, w.buyerAgent), [w.buyer]), "deregister after finalization");
  const retired = decode(w.svm, "AgentRegistration", w.buyerAgent);
  assert.ok(retired.status.Inactive !== undefined, "initiator identity retired after finalization");
  assert.deepEqual(Buffer.from(retired._reserved), Buffer.from("RETD"), "identity tombstone retained");
});

test("legacy zero-marker cancellation cannot revive an expired penalty or consume a tagged counter", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000 });
  const r = await setupCreatorDispute(w);

  expectOk(send(w.svm, await w.buyerProg.methods
    .cancelDispute()
    .accounts({
      protocolConfig: w.protocolPda, dispute: r.dispute,
      task: r.task, authority: w.buyer.publicKey,
    })
    .remainingAccounts([{ pubkey: w.providerAgent, isSigner: false, isWritable: true }])
    .instruction(), [w.buyer]), "cancel before simulating legacy provenance");

  // Reinterpret only the retired provenance byte as a pre-upgrade zero-marker
  // record while deliberately leaving the new agent counter at one. This proves
  // both grandfathering and cross-counter isolation in the real handler.
  const disputeAccount = w.svm.getAccount(r.dispute);
  const dispute = coder.accounts.decode(
    "Dispute",
    Buffer.from(disputeAccount.data),
  );
  dispute.total_voters = 0;
  const disputeData = await coder.accounts.encode("Dispute", dispute);
  w.svm.setAccount(r.dispute, {
    lamports: Number(disputeAccount.lamports),
    data: disputeData,
    owner: PID,
    executable: false,
    rentEpoch: 0,
  });

  const cancelledAt = Number(dispute.resolved_at);
  const clock = w.svm.getClock();
  clock.unixTimestamp = BigInt(cancelledAt + 604_801);
  w.svm.setClock(clock);

  const agentBefore = decode(w.svm, "AgentRegistration", w.buyerAgent);
  const disputeBefore = decode(w.svm, "Dispute", r.dispute);
  expectFail(send(w.svm, await makeProgram(w.admin).methods
    .applyInitiatorSlash()
    .accounts({
      dispute: r.dispute, initiatorAgent: w.buyerAgent,
      protocolConfig: w.protocolPda, treasury: w.admin.publicKey,
      authority: w.admin.publicKey,
    })
    .instruction(), [w.admin]), "SlashWindowExpired", "expired legacy penalty stays expired");

  const agentAfter = decode(w.svm, "AgentRegistration", w.buyerAgent);
  const disputeAfter = decode(w.svm, "Dispute", r.dispute);
  assert.equal(agentAfter.stake.toString(), agentBefore.stake.toString(), "legacy stake unchanged");
  assert.equal(agentAfter.reputation, agentBefore.reputation, "legacy reputation unchanged");
  assert.equal(agentAfter.active_dispute_votes, 1, "legacy record cannot consume the tagged counter unit");
  assert.equal(disputeAfter.initiator_slash_applied, disputeBefore.initiator_slash_applied, "legacy finalizer flag unchanged");
});

test("defendant dispute liability never ages out against an unrelated activity timestamp", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000 });
  await setupCreatorDispute(w);

  // Model a legacy/drifted active-task counter plus an old activity timestamp.
  // The previous `last_active + 7d` bypass would release this defendant's
  // registration stake even though the newly initiated dispute still owns one
  // disputes_as_defendant unit.
  const now = Number(w.svm.getClock().unixTimestamp);
  await injectAgentFields(w, w.providerAgent, (agent) => {
    agent.active_tasks = 0;
    agent.last_active = new BN(now - 604_801);
  });
  assert.equal(
    decode(w.svm, "AgentRegistration", w.providerAgent).disputes_as_defendant,
    1,
    "new dispute tracks one defendant liability",
  );

  expectFail(
    send(
      w.svm,
      await deregisterIx(w, w.provider, w.providerAgent),
      [w.provider],
    ),
    "ActiveDisputesExist",
    "old last_active cannot release a live defendant liability",
  );
  assert.ok(!isClosed(w.svm, w.providerAgent), "defendant registration remains slashable");
});
