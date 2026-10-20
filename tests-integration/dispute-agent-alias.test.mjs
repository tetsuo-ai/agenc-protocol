// Regression: a duplicate writable AgentRegistration must not erase dispute or
// settlement bookkeeping.
//
// THE BUG: initiate_dispute's `agent` + optional `worker_agent`, and
// validate_task_result's `worker` + optional `validator_agent`, are pairs of
// `#[account(mut)]` AgentRegistration slots. Anchor accepts the same key in both
// and writes each deserialized copy back on exit in field order, so the later,
// unmodified copy overwrites the earlier one:
//   - a worker-initiated dispute that also passed its own agent as `worker_agent`
//     lost both its initiator-outcome unit and its defendant unit, leaving a
//     provenance-tagged dispute whose permissionless finalizer fails closed;
//   - an ExternalAttestation approval that passed the worker as `validator_agent`
//     discarded the worker's completion bookkeeping.
//
// THE FIX: each optional slot carries `constraint = <slot>.key() != <primary>.key()`.
//
// Revert-sensitive: on the unfixed binary both aliased transactions SUCCEED, so
// the two rejection tests go red; the two non-aliased controls pass on both.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode, isClosed,
  freshWorld, injectAgentStake,
  taskModV2Pda, moderationBlockPda,
  BN, Keypair, SystemProgram,
} from "./harness.mjs";
import { Buffer } from "node:buffer";

const MODE_CREATOR_REVIEW = 1;
const MODE_EXTERNAL_ATTESTATION = 3;
const INITIATOR_OUTCOME_COUNTER_MARKER = 0xff;

const statusName = (status) => Object.keys(status)[0];
const num = (v) => (typeof v === "number" ? v : Number(v.toString()));

function expectAliasRejected(res, codeName, accountName, label) {
  expectFail(res, codeName, label);
  const logs = res.meta().logs().join("\n");
  assert.ok(logs.includes(accountName), `${label} should be rejected on ${accountName}; logs were:\n${logs}`);
}

// Task pinned to `mode` (CreatorReview or ExternalAttestation), moderated and
// published, then claimed and submitted by the provider worker.
async function setupSubmittedTask(w, { mode, attestor = null }) {
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
  const reviewWindow = mode === MODE_CREATOR_REVIEW ? 3600 : 0;
  expectOk(send(w.svm, await w.buyerProg.methods
    .configureTaskValidation(mode, new BN(reviewWindow), 0, attestor)
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
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/agent-alias", w.modAuth.publicKey)
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
  return { task, escrow, validation, attestorCfg, claim, submission };
}

async function workerInitiatesDispute(w, r, { workerAgent, workerClaim }) {
  const tid = decode(w.svm, "Task", r.task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [initRate] = pda([enc("authority_rate_limit"), w.provider.publicKey.toBuffer()]);
  const res = send(w.svm, await w.providerProg.methods
    .initiateDispute(arr(disputeId), arr(tid), arr(Buffer.alloc(32, 1)), 0, "evidence")
    .accounts({ dispute, task: r.task, agent: w.providerAgent, authorityRateLimit: initRate, protocolConfig: w.protocolPda, initiatorClaim: r.claim, workerAgent, workerClaim, taskSubmission: r.submission, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]);
  return { res, dispute };
}

async function attestorValidates(w, r, attestor, { validatorAgent }) {
  const [vote] = pda([enc("task_validation_vote"), r.submission.toBuffer(), attestor.publicKey.toBuffer()]);
  return send(w.svm, await makeProgram(attestor).methods
    .validateTaskResult(true)
    .accounts({
      task: r.task, claim: r.claim, escrow: r.escrow,
      taskValidationConfig: r.validation, taskAttestorConfig: r.attestorCfg,
      taskSubmission: r.submission, taskValidationVote: vote,
      worker: w.providerAgent, protocolConfig: w.protocolPda, validatorAgent,
      treasury: w.admin.publicKey, creator: w.buyer.publicKey,
      workerAuthority: w.provider.publicKey, reviewer: attestor.publicKey,
      tokenEscrowAta: null, workerTokenAccount: null, treasuryTokenAccount: null,
      rewardMint: null, tokenProgram: null, systemProgram: SystemProgram.programId,
      creatorCompletionBond: pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0],
      workerCompletionBond: pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()])[0],
    })
    .instruction(), [attestor]);
}

test("initiate_dispute rejects a worker_agent that aliases the initiating agent", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await setupSubmittedTask(w, { mode: MODE_CREATOR_REVIEW });
  await injectAgentStake(w.svm, w.providerAgent, 2_000_000);
  const before = decode(w.svm, "AgentRegistration", w.providerAgent);

  const { res, dispute } = await workerInitiatesDispute(w, r, { workerAgent: w.providerAgent, workerClaim: r.claim });
  expectAliasRejected(res, "InvalidInput", "worker_agent", "aliased worker_agent");

  assert.ok(isClosed(w.svm, dispute), "no dispute is created");
  assert.equal(statusName(decode(w.svm, "Task", r.task).status), "PendingValidation", "task is not marked Disputed");
  const after = decode(w.svm, "AgentRegistration", w.providerAgent);
  assert.equal(after.active_dispute_votes, before.active_dispute_votes, "initiator counter untouched");
  assert.equal(after.disputes_as_defendant, before.disputes_as_defendant, "defendant counter untouched");
});

test("control: a worker-initiated dispute without worker_agent records one unit of each counter", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await setupSubmittedTask(w, { mode: MODE_CREATOR_REVIEW });
  await injectAgentStake(w.svm, w.providerAgent, 2_000_000);
  const before = decode(w.svm, "AgentRegistration", w.providerAgent);

  const { res, dispute } = await workerInitiatesDispute(w, r, { workerAgent: null, workerClaim: null });
  expectOk(res, "worker initiates dispute");

  const d = decode(w.svm, "Dispute", dispute);
  assert.equal(d.total_voters, INITIATOR_OUTCOME_COUNTER_MARKER, "dispute owns a tracked initiator unit");
  assert.ok(d.defendant.equals(w.providerAgent), "worker is the bound defendant");
  const after = decode(w.svm, "AgentRegistration", w.providerAgent);
  assert.equal(after.active_dispute_votes, before.active_dispute_votes + 1, "initiator unit recorded");
  assert.equal(after.disputes_as_defendant, before.disputes_as_defendant + 1, "defendant unit recorded");
});

test("validate_task_result rejects a validator_agent that aliases the worker (ExternalAttestation)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const attestor = Keypair.generate();
  w.svm.airdrop(attestor.publicKey, BigInt(10e9));
  const r = await setupSubmittedTask(w, { mode: MODE_EXTERNAL_ATTESTATION, attestor: attestor.publicKey });
  const before = decode(w.svm, "AgentRegistration", w.providerAgent);

  const res = await attestorValidates(w, r, attestor, { validatorAgent: w.providerAgent });
  expectAliasRejected(res, "UnauthorizedTaskValidator", "validator_agent", "aliased validator_agent");

  assert.equal(statusName(decode(w.svm, "Task", r.task).status), "PendingValidation", "task is not settled");
  const after = decode(w.svm, "AgentRegistration", w.providerAgent);
  assert.equal(num(after.tasks_completed), num(before.tasks_completed), "worker completions untouched");
  assert.equal(num(after.active_tasks), num(before.active_tasks), "worker active tasks untouched");
});

test("control: an ExternalAttestation approval without validator_agent settles and updates the worker", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const attestor = Keypair.generate();
  w.svm.airdrop(attestor.publicKey, BigInt(10e9));
  const r = await setupSubmittedTask(w, { mode: MODE_EXTERNAL_ATTESTATION, attestor: attestor.publicKey });
  const before = decode(w.svm, "AgentRegistration", w.providerAgent);

  expectOk(await attestorValidates(w, r, attestor, { validatorAgent: null }), "attestor approves");

  assert.equal(statusName(decode(w.svm, "Task", r.task).status), "Completed", "task completed");
  const after = decode(w.svm, "AgentRegistration", w.providerAgent);
  assert.equal(num(after.tasks_completed), num(before.tasks_completed) + 1, "completion recorded on the worker");
  assert.equal(num(after.active_tasks), num(before.active_tasks) - 1, "claim slot released on the worker");
});
