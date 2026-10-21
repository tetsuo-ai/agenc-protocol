// Regression: repair_dispute_initiator_counter restores exactly the one
// initiator-outcome unit that a historical duplicate-account dispute lost, and
// nothing else.
//
// HISTORICAL STATE: before the alias guard, a worker could pass its own
// AgentRegistration as both `agent` and `worker_agent` in initiate_dispute. The
// unmodified `worker_agent` copy was written back last, so the counter-tracked
// dispute existed while both counter increments were lost. Mainnet has one
// such agent: two tracked disputes, one unit of each counter.
//
// The default fixture builds that state with two real worker-initiated
// disputes and then removes one unit from each counter, which is byte-equal to
// the lost increments. With AGENC_PRE_ALIAS_SO pointing at a build from before
// the alias guard (for example main a101923), the second dispute is instead
// created through the real aliased instruction on that binary, and the test
// switches back to the current binary before the remedy.
//
// Revert-sensitive: without the repair instruction the stranded outcome can
// never finalize (CorruptedData); every repair precondition below has a
// negative control.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import {
  enc, arr, pda, id32, coder, PID, SO,
  makeProgram, send, sendMany, expectOk, expectFail, decode, isClosed,
  freshWorld, injectAgentStake, configureTestMultisig,
  taskModV2Pda, moderationBlockPda,
  BN, Keypair, SystemProgram,
} from "./harness.mjs";
import { Buffer } from "node:buffer";

const MODE_CREATOR_REVIEW = 1;
const INITIATOR_OUTCOME_COUNTER_MARKER = 0xff;
const STAKE = 2_000_000;
const INCIDENT_SIGNATURE = crypto.randomBytes(64);

const statusName = (status) => Object.keys(status)[0];

// Task pinned to CreatorReview, moderated and published, then claimed and
// submitted by the provider worker (same shape as the mainnet disputes).
async function setupSubmittedTask(w) {
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const [validation] = pda([enc("task_validation"), task.toBuffer()]);
  const [attestorCfg] = pda([enc("task_attestor"), task.toBuffer()]);
  const [hireRecord] = pda([enc("hire"), task.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(2_000_000), 1, new BN(now + 3600), 0, null, 0, null, null, 0)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "create task");
  expectOk(send(w.svm, await w.buyerProg.methods
    .configureTaskValidation(MODE_CREATOR_REVIEW, new BN(3600), 0, null)
    .accounts({ task, taskValidationConfig: validation, taskAttestorConfig: attestorCfg, protocolConfig: w.protocolPda, hireRecord, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "configure validation");

  const modProg = makeProgram(w.modAuth);
  const jobHash = id32();
  const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "task-mod");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/counter-repair", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "publish");

  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, hireRecord, legacyListing: null,
      moderationBlock: moderationBlockPda(jobHash)[0], claim,
      protocolConfig: w.protocolPda, worker: w.providerAgent,
      authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "claim");
  const [submission] = pda([enc("task_submission"), claim.toBuffer()]);
  const result = Buffer.alloc(64);
  result.set(crypto.randomBytes(32), 0);
  expectOk(send(w.svm, await w.providerProg.methods
    .submitTaskResult(arr(id32()), arr(result))
    .accounts({ task, claim, taskValidationConfig: validation, taskSubmission: submission, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "submit");
  return { task, escrow, hireRecord, validation, claim, submission };
}

async function initiateIx(w, r, { workerAgent = null, workerClaim = null } = {}) {
  const tid = decode(w.svm, "Task", r.task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [initRate] = pda([enc("authority_rate_limit"), w.provider.publicKey.toBuffer()]);
  const ix = await w.providerProg.methods
    .initiateDispute(arr(disputeId), arr(tid), arr(Buffer.alloc(32, 1)), 0, "evidence")
    .accounts({ dispute, task: r.task, agent: w.providerAgent, authorityRateLimit: initRate, protocolConfig: w.protocolPda, initiatorClaim: r.claim, workerAgent, workerClaim, taskSubmission: r.submission, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction();
  return { ix, dispute };
}

async function setAgentCounters(w, { pending, defendant }) {
  const acct = w.svm.getAccount(w.providerAgent);
  const agent = coder.accounts.decode("AgentRegistration", Buffer.from(acct.data));
  agent.active_dispute_votes = pending;
  agent.disputes_as_defendant = defendant;
  const data = await coder.accounts.encode("AgentRegistration", agent);
  w.svm.setAccount(w.providerAgent, { lamports: Number(acct.lamports), data, owner: PID, executable: false, rentEpoch: 0 });
}

// The mainnet shape: a normal tracked dispute (Hyc) and a tracked dispute whose
// initiation lost both counter units (4Ei4). Agent counters end at 1/1.
async function historicalAliasWorld() {
  const w = await freshWorld({ moderationEnabled: true });
  await injectAgentStake(w.svm, w.providerAgent, STAKE);
  const normalTask = await setupSubmittedTask(w);
  const incidentTask = await setupSubmittedTask(w);

  const normal = await initiateIx(w, normalTask);
  expectOk(send(w.svm, normal.ix, [w.provider]), "normal worker dispute");

  let incident;
  const preAliasSo = process.env.AGENC_PRE_ALIAS_SO;
  if (preAliasSo) {
    assert.ok(fs.existsSync(preAliasSo), `AGENC_PRE_ALIAS_SO ${preAliasSo} must exist`);
    w.svm.addProgramFromFile(PID, preAliasSo);
    incident = await initiateIx(w, incidentTask, { workerAgent: w.providerAgent, workerClaim: incidentTask.claim });
    expectOk(send(w.svm, incident.ix, [w.provider]), "aliased dispute on the pre-guard binary");
    w.svm.addProgramFromFile(PID, SO);
  } else {
    incident = await initiateIx(w, incidentTask);
    expectOk(send(w.svm, incident.ix, [w.provider]), "incident dispute");
    // Byte-equal to the lost increments: the aliased write-back left both
    // counters where the normal dispute had put them.
    await setAgentCounters(w, { pending: 1, defendant: 1 });
  }
  w.svm.expireBlockhash();

  for (const d of [normal.dispute, incident.dispute]) {
    const dispute = decode(w.svm, "Dispute", d);
    assert.equal(dispute.total_voters, INITIATOR_OUTCOME_COUNTER_MARKER, "tracked dispute");
    assert.ok(dispute.initiator.equals(w.providerAgent) && dispute.defendant.equals(w.providerAgent));
    assert.equal(dispute.initiated_by_creator, false);
  }
  const agent = decode(w.svm, "AgentRegistration", w.providerAgent);
  assert.equal(agent.active_dispute_votes, 1, "historical initiator deficit");
  assert.equal(agent.disputes_as_defendant, 1, "historical defendant deficit");

  const approvals = await configureTestMultisig(w);
  const crank = Keypair.generate();
  w.svm.airdrop(crank.publicKey, BigInt(10e9));
  return {
    w, approvals, crank,
    normal: { ...normalTask, dispute: normal.dispute },
    incident: { ...incidentTask, dispute: incident.dispute },
  };
}

async function expireIx(w, r, crank) {
  return makeProgram(crank).methods
    .expireDispute()
    .accounts({
      dispute: r.dispute, task: r.task, escrow: r.escrow, protocolConfig: w.protocolPda,
      creator: w.buyer.publicKey, authority: crank.publicKey,
      workerClaim: r.claim, worker: w.providerAgent, workerWallet: w.provider.publicKey,
      hireRecord: r.hireRecord, disputeOperator: null, disputeReferrer: null,
      tokenEscrowAta: null, creatorTokenAccount: null, workerTokenAccountAta: null,
      rewardMint: null, tokenProgram: null,
      creatorCompletionBond: pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0],
      workerCompletionBond: pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()])[0],
      taskSubmission: r.submission, taskValidationConfig: r.validation,
    })
    .instruction();
}

async function finalizeIx(w, dispute, crank) {
  return makeProgram(crank).methods
    .applyInitiatorSlash()
    .accounts({
      dispute, initiatorAgent: w.providerAgent, protocolConfig: w.protocolPda,
      treasury: w.admin.publicKey, authority: crank.publicKey,
    })
    .instruction();
}

const receiptPda = (incident) => pda([enc("dispute_counter_repair"), incident.toBuffer()])[0];

async function repairIx(h, { incident, pending, agent, authority, approvals, signature = INCIDENT_SIGNATURE }) {
  const { w } = h;
  return makeProgram(authority ?? w.admin).methods
    .repairDisputeInitiatorCounter(arr(signature))
    .accounts({
      protocolConfig: w.protocolPda,
      incidentDispute: incident,
      pendingDispute: pending,
      initiatorAgent: agent ?? w.providerAgent,
      repairReceipt: receiptPda(incident),
      authority: (authority ?? w.admin).publicKey,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts((approvals ?? h.approvals).remainingAccounts)
    .instruction();
}

function signersFor(h, authority, approvals) {
  const all = [authority ?? h.w.admin, ...(approvals ?? h.approvals).approvers];
  const seen = new Set();
  return all.filter((kp) => {
    const key = kp.publicKey.toBase58();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sendRepair(h, ixs, { authority, approvals } = {}) {
  h.w.svm.expireBlockhash();
  return sendMany(h.w.svm, ixs, signersFor(h, authority, approvals));
}

async function expireBoth(h) {
  const { w, crank } = h;
  const deadline = Math.max(
    Number(decode(w.svm, "Dispute", h.normal.dispute).voting_deadline),
    Number(decode(w.svm, "Dispute", h.incident.dispute).voting_deadline),
  );
  const c = w.svm.getClock();
  c.unixTimestamp = BigInt(deadline + 121);
  w.svm.setClock(c);
  expectOk(send(w.svm, await expireIx(w, h.normal, crank), [crank]), "expire normal dispute");
  expectOk(send(w.svm, await expireIx(w, h.incident, crank), [crank]), "expire incident dispute");
  w.svm.expireBlockhash();
  const agent = decode(w.svm, "AgentRegistration", w.providerAgent);
  assert.equal(agent.disputes_as_defendant, 0, "saturating expiry absorbs the lost defendant unit");
  assert.equal(agent.active_dispute_votes, 1, "one initiator unit for two pending outcomes");
}

function counters(w) {
  const a = decode(w.svm, "AgentRegistration", w.providerAgent);
  return { pending: a.active_dispute_votes, defendant: a.disputes_as_defendant, stake: a.stake.toString(), reputation: a.reputation };
}

test("historical alias: the stranded outcome cannot finalize without the repair", async () => {
  const h = await historicalAliasWorld();
  const { w, crank } = h;
  await expireBoth(h);
  expectOk(send(w.svm, await finalizeIx(w, h.normal.dispute, crank), [crank]), "finalize normal dispute");
  w.svm.expireBlockhash();
  assert.equal(counters(w).pending, 0);
  expectFail(send(w.svm, await finalizeIx(w, h.incident.dispute, crank), [crank]), "CorruptedData", "second finalizer has no unit");
  assert.equal(decode(w.svm, "Dispute", h.incident.dispute).initiator_slash_applied, false);
});

test("repair restores one unit, the finalizer consumes it, counters end at 0/0", async () => {
  const h = await historicalAliasWorld();
  const { w, crank } = h;
  await expireBoth(h);

  // Nonzero counter: the remaining unit still belongs to a pending outcome.
  expectFail(sendRepair(h, [await repairIx(h, { incident: h.incident.dispute, pending: h.incident.dispute })]),
    "DisputeCounterNotDeficient", "repair while the counter still holds a unit");

  expectOk(send(w.svm, await finalizeIx(w, h.normal.dispute, crank), [crank]), "finalize normal dispute");
  w.svm.expireBlockhash();
  const before = counters(w);
  assert.deepEqual([before.pending, before.defendant], [0, 0]);
  const providerAgentBefore = Buffer.from(w.svm.getAccount(w.providerAgent).data);
  const buyerAgentBefore = Buffer.from(w.svm.getAccount(w.buyerAgent).data);
  const protocolBefore = Buffer.from(w.svm.getAccount(w.protocolPda).data);
  const normalBefore = Buffer.from(w.svm.getAccount(h.normal.dispute).data);
  const incidentBefore = Buffer.from(w.svm.getAccount(h.incident.dispute).data);

  // One transaction: restore the unit and finalize the stranded outcome.
  expectOk(sendRepair(h, [
    await repairIx(h, { incident: h.incident.dispute, pending: h.incident.dispute }),
    await finalizeIx(w, h.incident.dispute, w.admin),
  ]), "repair and finalize");

  const after = counters(w);
  assert.deepEqual([after.pending, after.defendant], [0, 0], "counters consistent");
  assert.equal(after.stake, before.stake, "expired outcome is no-fault: no slash");
  assert.equal(after.reputation, before.reputation, "no reputation change");
  const incident = decode(w.svm, "Dispute", h.incident.dispute);
  assert.equal(incident.initiator_slash_applied, true, "stranded outcome finalized");
  assert.equal(statusName(incident.status), "Expired");

  const receipt = decode(w.svm, "DisputeCounterRepair", receiptPda(h.incident.dispute));
  assert.ok(receipt.incident_dispute.equals(h.incident.dispute));
  assert.ok(receipt.pending_dispute.equals(h.incident.dispute));
  assert.ok(receipt.initiator_agent.equals(w.providerAgent));
  assert.deepEqual(Buffer.from(receipt.incident_signature), INCIDENT_SIGNATURE);
  assert.ok(receipt.repaired_by.equals(w.admin.publicKey));
  assert.equal(receipt.initiator_units_restored, 1);

  // Nothing else moved: the agent is byte-identical (the restored unit was
  // consumed in the same transaction), unrelated accounts and the normal
  // dispute are untouched, and the incident changed only its finalizer flag.
  assert.deepEqual(Buffer.from(w.svm.getAccount(w.providerAgent).data), providerAgentBefore);
  assert.deepEqual(Buffer.from(w.svm.getAccount(w.buyerAgent).data), buyerAgentBefore);
  assert.deepEqual(Buffer.from(w.svm.getAccount(w.protocolPda).data), protocolBefore);
  assert.deepEqual(Buffer.from(w.svm.getAccount(h.normal.dispute).data), normalBefore);
  const incidentAfter = Buffer.from(w.svm.getAccount(h.incident.dispute).data);
  const changed = [];
  for (let i = 0; i < incidentAfter.length; i += 1) if (incidentAfter[i] !== incidentBefore[i]) changed.push(i);
  assert.deepEqual(changed, [220], "only Dispute.initiator_slash_applied changed");

  // One-time: the receipt blocks any second repair for this incident.
  expectFail(sendRepair(h, [await repairIx(h, { incident: h.incident.dispute, pending: h.incident.dispute })]),
    "already in use", "second repair for the same incident");
  expectFail(sendRepair(h, [await repairIx(h, { incident: h.incident.dispute, pending: h.normal.dispute })]),
    "already in use", "second repair with another pending dispute");
});

test("griefer order: the incident finalizes first, the repair credits the sibling", async () => {
  const h = await historicalAliasWorld();
  const { w, crank } = h;
  await expireBoth(h);
  expectOk(send(w.svm, await finalizeIx(w, h.incident.dispute, crank), [crank]), "incident finalized first");
  w.svm.expireBlockhash();
  expectFail(send(w.svm, await finalizeIx(w, h.normal.dispute, crank), [crank]), "CorruptedData", "sibling stranded");

  // The incident itself is no longer pending, so it cannot be the pending dispute.
  expectFail(sendRepair(h, [await repairIx(h, { incident: h.incident.dispute, pending: h.incident.dispute })]),
    "DisputeCounterRepairNotApplicable", "finalized incident as pending");

  expectOk(sendRepair(h, [
    await repairIx(h, { incident: h.incident.dispute, pending: h.normal.dispute }),
    await finalizeIx(w, h.normal.dispute, w.admin),
  ]), "repair credits the sibling and finalizes it");
  const after = counters(w);
  assert.deepEqual([after.pending, after.defendant], [0, 0]);
  assert.equal(decode(w.svm, "Dispute", h.normal.dispute).initiator_slash_applied, true);
  const receipt = decode(w.svm, "DisputeCounterRepair", receiptPda(h.incident.dispute));
  assert.ok(receipt.pending_dispute.equals(h.normal.dispute));
});

test("negative controls: authority, threshold, signature, shape and status", async () => {
  const h = await historicalAliasWorld();
  const { w, crank } = h;

  // Active disputes are not finalizable outcomes yet.
  await setAgentCounters(w, { pending: 0, defendant: 1 });
  w.svm.expireBlockhash();
  expectFail(sendRepair(h, [await repairIx(h, { incident: h.incident.dispute, pending: h.incident.dispute })]),
    "DisputeNotResolved", "repair of an Active dispute");
  await setAgentCounters(w, { pending: 1, defendant: 1 });

  await expireBoth(h);
  expectOk(send(w.svm, await finalizeIx(w, h.normal.dispute, crank), [crank]), "finalize normal dispute");
  w.svm.expireBlockhash();

  // Governance: only the protocol authority proposes, M-of-N owners must sign.
  const outsider = Keypair.generate();
  w.svm.airdrop(outsider.publicKey, BigInt(10e9));
  expectFail(sendRepair(h, [await repairIx(h, { incident: h.incident.dispute, pending: h.incident.dispute, authority: outsider })], { authority: outsider }),
    "UnauthorizedAgent", "non-authority proposer");
  const single = {
    approvers: [h.approvals.approvers[1]],
    remainingAccounts: [h.approvals.remainingAccounts[1]],
  };
  expectFail(sendRepair(h, [await repairIx(h, { incident: h.incident.dispute, pending: h.incident.dispute, approvals: single })], { approvals: single }),
    "MultisigNotEnoughSigners", "one owner below the 2-of-3 threshold");
  expectFail(sendRepair(h, [await repairIx(h, { incident: h.incident.dispute, pending: h.incident.dispute, signature: Buffer.alloc(64) })]),
    "InvalidInput", "missing incident signature");

  // Shape: the finalized normal dispute cannot be the pending dispute, and a
  // distinct pending dispute requires the incident to be finalized.
  expectFail(sendRepair(h, [await repairIx(h, { incident: h.incident.dispute, pending: h.normal.dispute })]),
    "DisputeCounterRepairNotApplicable", "finalized pending dispute");

  // Another agent's registration cannot be credited for these disputes.
  expectFail(sendRepair(h, [await repairIx(h, { incident: h.incident.dispute, pending: h.incident.dispute, agent: w.buyerAgent })]),
    "DisputeCounterRepairNotApplicable", "wrong initiator agent");

  // Nothing above changed state: the counter is still the proven deficit.
  assert.deepEqual([counters(w).pending, counters(w).defendant], [0, 0]);
  assert.ok(isClosed(w.svm, receiptPda(h.incident.dispute)), "no receipt was created");
});

test("control: a consistent agent cannot be credited (no overshoot)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  await injectAgentStake(w.svm, w.providerAgent, STAKE);
  const r = await setupSubmittedTask(w);
  const d = await initiateIx(w, r);
  expectOk(send(w.svm, d.ix, [w.provider]), "normal dispute");
  const approvals = await configureTestMultisig(w);
  const h = { w, approvals, normal: { ...r, dispute: d.dispute } };
  const c = w.svm.getClock();
  c.unixTimestamp = BigInt(Number(decode(w.svm, "Dispute", d.dispute).voting_deadline) + 121);
  w.svm.setClock(c);
  expectOk(send(w.svm, await expireIx(w, h.normal, w.admin), [w.admin]), "expire");
  w.svm.expireBlockhash();
  assert.equal(counters(w).pending, 1, "the expired outcome owns its unit");
  expectFail(sendRepair(h, [await repairIx(h, { incident: d.dispute, pending: d.dispute })]),
    "DisputeCounterNotDeficient", "repair of a consistent agent");
  expectOk(send(w.svm, await finalizeIx(w, d.dispute, w.admin), [w.admin]), "ordinary finalizer");
  w.svm.expireBlockhash();
  assert.equal(counters(w).pending, 0);
  expectFail(sendRepair(h, [await repairIx(h, { incident: d.dispute, pending: d.dispute })]),
    "DisputeCounterRepairNotApplicable", "finalized outcome cannot be re-credited");
});

test("control: a new aliased dispute is still rejected at initiation", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  await injectAgentStake(w.svm, w.providerAgent, STAKE);
  const r = await setupSubmittedTask(w);
  const d = await initiateIx(w, r, { workerAgent: w.providerAgent, workerClaim: r.claim });
  expectFail(send(w.svm, d.ix, [w.provider]), "InvalidInput", "aliased worker_agent");
  assert.ok(isClosed(w.svm, d.dispute));
});

test("a cancelled stranded outcome keeps its loss policy after the repair", async () => {
  const h = await historicalAliasWorld();
  const { w, crank } = h;
  // The initiator cancels the incident dispute instead of letting it expire.
  expectOk(send(w.svm, await w.providerProg.methods
    .cancelDispute()
    .accounts({ protocolConfig: w.protocolPda, dispute: h.incident.dispute, task: h.incident.task, authority: w.provider.publicKey })
    .remainingAccounts([
      { pubkey: w.providerAgent, isSigner: false, isWritable: true },
      { pubkey: h.incident.validation, isSigner: false, isWritable: true },
    ])
    .instruction(), [w.provider]), "initiator cancels incident dispute");
  const c = w.svm.getClock();
  c.unixTimestamp = BigInt(Number(decode(w.svm, "Dispute", h.normal.dispute).voting_deadline) + 121);
  w.svm.setClock(c);
  expectOk(send(w.svm, await expireIx(w, h.normal, crank), [crank]), "expire normal dispute");
  expectOk(send(w.svm, await finalizeIx(w, h.normal.dispute, crank), [crank]), "finalize normal dispute");
  w.svm.expireBlockhash();
  assert.deepEqual([counters(w).pending, counters(w).defendant], [0, 0]);

  const stakeBefore = BigInt(counters(w).stake);
  expectOk(sendRepair(h, [
    await repairIx(h, { incident: h.incident.dispute, pending: h.incident.dispute }),
    await finalizeIx(w, h.incident.dispute, w.admin),
  ]), "repair and finalize the cancelled outcome");
  const after = counters(w);
  assert.equal(after.pending, 0);
  // Cancellation is an initiator loss: the ordinary finalizer slashes it.
  assert.ok(BigInt(after.stake) < stakeBefore, "cancelled outcome still slashes the initiator");
  assert.equal(decode(w.svm, "Dispute", h.incident.dispute).initiator_slash_applied, true);
});
