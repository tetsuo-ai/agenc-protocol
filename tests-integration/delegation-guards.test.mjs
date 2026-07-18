// Audit (2026-07 swarm) — two delegation guards:
//
// 1. delegate_reputation is now closed to dispute defendants. A defendant's
//    reputation is the pot apply_dispute_slash penalizes; delegating mid-dispute
//    moved that pot out (deducted at delegate time) while the delegation itself
//    survived the slash and could be revoked back afterwards — making the
//    reputation half of every slash optional.
//
// 2. revoke_delegation now requires identity continuity: the revoking
//    registration must be the SAME registration that created the delegation
//    (registered_at <= delegation.created_at). The AgentRegistration PDA is
//    seeded by agent_id, so deregister -> re-register reproduces the same PDA
//    with a fresh registered_at, and the old binding (has_one = authority) was
//    satisfied again. That turned revoke into an unbounded inflation loop:
//    delegate 3000 -> wait 7d -> deregister -> re-register (fresh 3000) ->
//    revoke (+3000) = 6000, repeat towards MAX_REPUTATION with zero completions.
//
// Both guards are handler-only (no account-layout / IDL change).

import test from "node:test";
import assert from "node:assert/strict";
import {
  freshWorld,
  makeProgram,
  send,
  sendMany,
  expectOk,
  expectFail,
  decode,
  isClosed,
  pda,
  enc,
  arr,
  id32,
  deregisterRemaining,
  warpSeconds,
  hireIx,
  injectAgentStake,
  listingModV2Pda,
  taskModV2Pda,
  moderationBlockPda,
  BN,
  Keypair,
  SystemProgram,
} from "./harness.mjs";
import { Buffer } from "node:buffer";

const MIN_DELEGATION_DURATION = 604_800n;
const PROBATIONARY_REPUTATION = 3000;

const delegationPda = (delegator, delegatee) =>
  pda([enc("reputation_delegation"), delegator.toBuffer(), delegatee.toBuffer()])[0];

// Register a fresh agent; when agentId is omitted a random one is used. Returns
// { kp, prog, agentPda, agentId } so the SAME agentId can be re-registered after
// deregistration (reproducing the same PDA with a fresh registered_at).
async function registerAgent(w, { agentId } = {}) {
  const kp = Keypair.generate();
  w.svm.airdrop(kp.publicKey, BigInt(100e9));
  const prog = makeProgram(kp);
  const id = agentId ?? id32();
  const [agentPda] = pda([enc("agent"), id]);
  expectOk(
    send(
      w.svm,
      await prog.methods
        .registerAgent(arr(id), new BN(1), "http://agent.test", null, new BN(0))
        .accounts({
          agent: agentPda,
          protocolConfig: w.protocolPda,
          authority: kp.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [kp],
    ),
    "register agent",
  );
  return { kp, prog, agentPda, agentId: id };
}

// Creator-initiated dispute against the world's provider agent (same shape as
// initiator-slash-guard.test.mjs): leaves the provider with
// disputes_as_defendant == 1 and the dispute Active.
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
  const { ix: hix, task } = await hireIx(w, { taskId, listingModeration: listingMod });
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

  return { task, claim, dispute };
}

const delegateIx = (prog, authority, delegatorAgent, delegateeAgent) =>
  prog.methods
    .delegateReputation(1000, new BN(0))
    .accounts({
      authority: authority.publicKey,
      delegatorAgent,
      delegateeAgent,
      delegation: delegationPda(delegatorAgent, delegateeAgent),
      systemProgram: SystemProgram.programId,
    })
    .instruction();

// ---------------------------------------------------------------------------
// Guard 1: no delegation while a dispute defendant
// ---------------------------------------------------------------------------

test("delegate_reputation: an active dispute defendant cannot delegate (slash-evasion vault closed)", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000 });
  await setupCreatorDispute(w);
  warpSeconds(w.svm, 2); // registration-age gate (the world was built in one slot)

  // Precondition: the provider really is seated as defendant.
  assert.equal(
    decode(w.svm, "AgentRegistration", w.providerAgent).disputes_as_defendant,
    1,
    "provider disputes_as_defendant == 1 after initiation",
  );

  const delegatee = await registerAgent(w);

  // The exploit step: the defendant delegates its reputation out of the slash
  // pot -> BLOCKED. Revert-sensitive: drop the disputes_as_defendant require in
  // delegate_reputation and this succeeds again.
  expectFail(
    send(w.svm, await delegateIx(w.providerProg, w.provider, w.providerAgent, delegatee.agentPda), [w.provider]),
    "ReputationDelegationWhileDefendant",
    "defendant delegation is blocked",
  );
  assert.ok(
    isClosed(w.svm, delegationPda(w.providerAgent, delegatee.agentPda)),
    "no delegation account was created",
  );
  assert.equal(
    decode(w.svm, "AgentRegistration", w.providerAgent).reputation,
    PROBATIONARY_REPUTATION,
    "defendant reputation untouched",
  );

  // Positive control: the initiator (NOT a defendant) can still delegate — the
  // gate is defendant-specific, not a blanket dispute freeze.
  const buyerDelegatee = await registerAgent(w);
  expectOk(
    send(w.svm, await delegateIx(w.buyerProg, w.buyer, w.buyerAgent, buyerDelegatee.agentPda), [w.buyer]),
    "initiator (non-defendant) delegation still works",
  );
});

// ---------------------------------------------------------------------------
// Guard 2: revoke requires identity continuity
// ---------------------------------------------------------------------------

test("revoke_delegation: deregister -> re-register cannot revoke (reputation inflation loop closed)", async () => {
  const w = await freshWorld();
  const agentId = id32();
  const delegator = await registerAgent(w, { agentId });
  const delegatee = await registerAgent(w);
  const delPda = delegationPda(delegator.agentPda, delegatee.agentPda);
  warpSeconds(w.svm, 2); // registration-age gate (the world was built in one slot)

  // Delegate 1000 of the fresh 3000.
  expectOk(
    send(w.svm, await delegateIx(delegator.prog, delegator.kp, delegator.agentPda, delegatee.agentPda), [delegator.kp]),
    "delegate",
  );
  assert.equal(
    decode(w.svm, "AgentRegistration", delegator.agentPda).reputation,
    PROBATIONARY_REPUTATION - 1000,
    "delegation debited the delegator",
  );

  // Warp past the minimum delegation duration so ONLY the identity guard can fire.
  const clk = w.svm.getClock();
  clk.unixTimestamp = clk.unixTimestamp + MIN_DELEGATION_DURATION + 1n;
  w.svm.setClock(clk);

  // Deregister, then re-register the SAME agent_id: the PDA address and the
  // has_one = authority binding are reproduced, but registered_at is re-stamped
  // LATER than delegation.created_at.
  expectOk(
    send(
      w.svm,
      await delegator.prog.methods
        .deregisterAgent()
        .accounts({
          agent: delegator.agentPda,
          protocolConfig: w.protocolPda,
          reputationStake: pda([enc("reputation_stake"), delegator.agentPda.toBuffer()])[0],
          authority: delegator.kp.publicKey,
        })
        .remainingAccounts(deregisterRemaining(delegator.agentPda))
        .instruction(),
      [delegator.kp],
    ),
    "deregister",
  );
  assert.ok(isClosed(w.svm, delegator.agentPda), "old registration closed");

  w.svm.expireBlockhash(); // the re-register ix is byte-identical to the first one
  expectOk(
    send(
      w.svm,
      await delegator.prog.methods
        .registerAgent(arr(agentId), new BN(1), "http://agent.test", null, new BN(0))
        .accounts({
          agent: delegator.agentPda,
          protocolConfig: w.protocolPda,
          authority: delegator.kp.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [delegator.kp],
    ),
    "re-register same agent_id",
  );
  const reRegistered = decode(w.svm, "AgentRegistration", delegator.agentPda);
  assert.equal(reRegistered.reputation, PROBATIONARY_REPUTATION, "fresh registration gets probationary reputation");
  assert.ok(
    Number(reRegistered.registered_at) > Number(decode(w.svm, "ReputationDelegation", delPda).created_at),
    "re-registration is provably younger than the delegation",
  );

  // The exploit step: revoke against the re-registered PDA would restore +1000
  // on top of the fresh 3000 -> BLOCKED. Revert-sensitive: drop the
  // registered_at <= delegation.created_at require and this succeeds (4000).
  expectFail(
    send(
      w.svm,
      await delegator.prog.methods
        .revokeDelegation()
        .accounts({
          authority: delegator.kp.publicKey,
          delegatorAgent: delegator.agentPda,
          delegation: delPda,
        })
        .instruction(),
      [delegator.kp],
    ),
    "ReputationDelegationIdentityMismatch",
    "revoke by a re-registered agent is blocked",
  );
  assert.equal(
    decode(w.svm, "AgentRegistration", delegator.agentPda).reputation,
    PROBATIONARY_REPUTATION,
    "no reputation was restored onto the new registration",
  );
  assert.ok(!isClosed(w.svm, delPda), "delegation account survives (was not closed by the blocked revoke)");
});

// ---------------------------------------------------------------------------
// Guard 2b (re-opened): the single-slot bundle — delegate, deregister, and
// re-register in ONE transaction. The clone's registered_at then EQUALS the
// delegation's created_at, which is why the identity check is a STRICT `<`.
// With `<=` this test's revoke succeeds and mints +1000 per 7-day cycle.
// ---------------------------------------------------------------------------

test("revoke_delegation: the single-slot [delegate, deregister, register] clone cannot revoke", async () => {
  const w = await freshWorld();
  const agentId = id32();
  const delegator = await registerAgent(w, { agentId });
  const delegatee = await registerAgent(w);
  const delPda = delegationPda(delegator.agentPda, delegatee.agentPda);
  warpSeconds(w.svm, 2); // registration-age gate

  // ONE transaction — every instruction observes the SAME clock timestamp.
  const delegateIx = await delegator.prog.methods
    .delegateReputation(1000, new BN(0))
    .accounts({
      authority: delegator.kp.publicKey,
      delegatorAgent: delegator.agentPda,
      delegateeAgent: delegatee.agentPda,
      delegation: delPda,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  const deregisterIx = await delegator.prog.methods
    .deregisterAgent()
    .accounts({
      agent: delegator.agentPda,
      protocolConfig: w.protocolPda,
      reputationStake: pda([enc("reputation_stake"), delegator.agentPda.toBuffer()])[0],
      authority: delegator.kp.publicKey,
    })
    .remainingAccounts(deregisterRemaining(delegator.agentPda))
    .instruction();
  const reregisterIx = await delegator.prog.methods
    .registerAgent(arr(agentId), new BN(1), "http://agent.test", null, new BN(0))
    .accounts({
      agent: delegator.agentPda,
      protocolConfig: w.protocolPda,
      authority: delegator.kp.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  expectOk(
    sendMany(w.svm, [delegateIx, deregisterIx, reregisterIx], [delegator.kp]),
    "the single-slot bundle (delegate -> deregister -> re-register)",
  );

  // The clone is indistinguishable by address/binding, and the timestamps are EQUAL.
  const clone = decode(w.svm, "AgentRegistration", delegator.agentPda);
  assert.equal(clone.reputation, PROBATIONARY_REPUTATION, "fresh probationary reputation");
  assert.equal(
    Number(clone.registered_at),
    Number(decode(w.svm, "ReputationDelegation", delPda).created_at),
    "the equality case the strict check must reject (would PASS with <=)",
  );

  // Warp past the minimum delegation duration so ONLY the identity guard can fire.
  warpSeconds(w.svm, Number(MIN_DELEGATION_DURATION) + 2);

  // Revert-sensitive: with `<=` this revoke succeeds (3000 + 1000 = 4000).
  expectFail(
    send(
      w.svm,
      await delegator.prog.methods
        .revokeDelegation()
        .accounts({
          authority: delegator.kp.publicKey,
          delegatorAgent: delegator.agentPda,
          delegation: delPda,
        })
        .instruction(),
      [delegator.kp],
    ),
    "ReputationDelegationIdentityMismatch",
    "the same-slot clone cannot revoke",
  );
  assert.equal(
    decode(w.svm, "AgentRegistration", delegator.agentPda).reputation,
    PROBATIONARY_REPUTATION,
    "no inflation from the cloned registration",
  );
});

// ---------------------------------------------------------------------------
// Guard 3: a delegation must be created strictly AFTER the delegator's
// registration (the gate that makes the revoke-side strictness free).
// ---------------------------------------------------------------------------

test("delegate_reputation: same-second-as-registration rejected (ReputationDelegationTooSoon), allowed one slot later", async () => {
  const w = await freshWorld();
  const delegator = await registerAgent(w);
  const delegatee = await registerAgent(w);
  const delPda = delegationPda(delegator.agentPda, delegatee.agentPda);

  // No warp: the registration's registered_at == now. Revert-sensitive: remove
  // the gate and this succeeds, re-admitting the equality case on new delegations.
  expectFail(
    send(
      w.svm,
      await delegator.prog.methods
        .delegateReputation(1000, new BN(0))
        .accounts({
          authority: delegator.kp.publicKey,
          delegatorAgent: delegator.agentPda,
          delegateeAgent: delegatee.agentPda,
          delegation: delPda,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [delegator.kp],
    ),
    "ReputationDelegationTooSoon",
    "delegation in the same second as the registration",
  );

  // One slot later the honest flow works (and the delegation it creates has
  // registered_at < created_at by construction — the revoke-side invariant).
  warpSeconds(w.svm, 2);
  expectOk(
    send(
      w.svm,
      await delegator.prog.methods
        .delegateReputation(1000, new BN(0))
        .accounts({
          authority: delegator.kp.publicKey,
          delegatorAgent: delegator.agentPda,
          delegateeAgent: delegatee.agentPda,
          delegation: delPda,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [delegator.kp],
    ),
    "delegate one slot after registration",
  );
  const agent = decode(w.svm, "AgentRegistration", delegator.agentPda);
  const del = decode(w.svm, "ReputationDelegation", delPda);
  assert.ok(
    Number(agent.registered_at) < Number(del.created_at),
    "strict ordering holds by construction",
  );
});
