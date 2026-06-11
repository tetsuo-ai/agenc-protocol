// Regression: ExternalAttestation self-attestation money-safety guard.
//
// THE BUG (now fixed): in ValidationMode::ExternalAttestation, validate_task_result
// only checked that the signing reviewer == the configured attestor. It did NOT
// require the attestor be DISTINCT from task.creator and worker.authority — so a
// creator or worker could be configured as their own attestor, self-approve their
// own submission, and drain the escrow.
//
// THE FIX: validate_task_result's ExternalAttestation branch now requires
//   attestor != task.creator && attestor != worker.authority  -> InvalidAttestor.
// configure_task_validation already rejects creator-as-attestor at configure time,
// but worker.authority is unknown pre-claim, so the worker-as-attestor case is only
// catchable at settlement — that is the load-bearing case exercised below.
//
// Runs the real compiled .so via the shared litesvm harness.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  freshWorld,
  makeProgram,
  send,
  expectOk,
  expectFail,
  decode,
  pda,
  enc,
  arr,
  id32,
  isClosed,
  BN,
  Keypair,
  PublicKey,
  SystemProgram,
} from "./harness.mjs";

const MODE_EXTERNAL_ATTESTATION = 3;

/// Create a plain (non-hired) task, pin it to ExternalAttestation with the given
/// `attestor`, moderate + publish a job spec, then have the provider worker claim
/// and submit a result. Stops with a pending submission ready for validate_task_result.
/// `attestor` must be a PublicKey (ExternalAttestation requires a non-null attestor).
async function setupAttestedTask(w, { attestor, reward = 2_000_000 } = {}) {
  const modProg = makeProgram(w.modAuth);
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
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(reward), 1, new BN(now + 3600), 0, null, 0, null, null, 0)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "attested:create_task");

  // ExternalAttestation (mode 3) with the supplied attestor. Returns the configure
  // result so the caller can assert on configure-time rejection if it expects one.
  // ExternalAttestation requires review_window_secs == 0 and validator_quorum == 0.
  const configureRes = send(w.svm, await w.buyerProg.methods
    .configureTaskValidation(MODE_EXTERNAL_ATTESTATION, new BN(0), 0, attestor)
    .accounts({ task, taskValidationConfig: validation, taskAttestorConfig: attestorCfg, protocolConfig: w.protocolPda, hireRecord, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]);

  return { task, escrow, validation, attestorCfg, hireRecord, reward, configureRes,
    // continue the claim+submit flow once configure has been asserted OK
    async claimAndSubmit() {
      expectOk(configureRes, "attested:configure");
      const jobHash = id32();
      const [taskMod] = pda([enc("task_moderation"), task.toBuffer(), Buffer.from(jobHash)]);
      const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
      expectOk(send(w.svm, await modProg.methods
        .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
        .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
        .instruction(), [w.modAuth]), "attested:task-mod");
      expectOk(send(w.svm, await w.buyerProg.methods
        .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/attest")
        .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
        .instruction(), [w.buyer]), "attested:publish");

      const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
      expectOk(send(w.svm, await w.providerProg.methods
        .claimTaskWithJobSpec()
        .accounts({ task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
        .instruction(), [w.provider]), "attested:claim");

      const [submission] = pda([enc("task_submission"), claim.toBuffer()]);
      const rdesc = Buffer.alloc(64);
      rdesc.set(crypto.randomBytes(32), 0);
      expectOk(send(w.svm, await w.providerProg.methods
        .submitTaskResult(arr(id32()), arr(rdesc))
        .accounts({ task, claim, taskValidationConfig: validation, taskSubmission: submission, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
        .instruction(), [w.provider]), "attested:submit");

      return { claim, submission, jobSpec };
    },
  };
}

/// Build + send validate_task_result signed by `reviewer` (the attestor wallet).
function validate(w, { task, escrow, validation, attestorCfg, claim, submission }, reviewer, approved) {
  const [vote] = pda([enc("task_validation_vote"), submission.toBuffer(), reviewer.publicKey.toBuffer()]);
  return makeProgram(reviewer).methods
    .validateTaskResult(approved)
    .accounts({
      task,
      claim,
      escrow,
      taskValidationConfig: validation,
      taskAttestorConfig: attestorCfg,
      taskSubmission: submission,
      taskValidationVote: vote,
      worker: w.providerAgent,
      protocolConfig: w.protocolPda,
      validatorAgent: null,
      treasury: w.admin.publicKey,
      creator: w.buyer.publicKey,
      workerAuthority: w.provider.publicKey,
      reviewer: reviewer.publicKey,
      tokenEscrowAta: null,
      workerTokenAccount: null,
      treasuryTokenAccount: null,
      rewardMint: null,
      tokenProgram: null,
      systemProgram: SystemProgram.programId,
    })
    .instruction()
    .then((ix) => send(w.svm, ix, [reviewer]));
}

test("ExternalAttestation self-attestation guard: worker-authority attestor cannot self-approve (InvalidAttestor)", async () => {
  // The load-bearing case: configure-time only rejects creator-as-attestor (no worker
  // is bound pre-claim), so a worker configured as its own attestor passes configure
  // and is ONLY caught at settlement. Without the fix this self-approval drains escrow.
  const w = await freshWorld({ moderationEnabled: true });
  // attestor = the worker's wallet authority (w.provider) — accepted at configure time.
  const s = await setupAttestedTask(w, { attestor: w.provider.publicKey });
  const cs = await s.claimAndSubmit();

  const res = await validate(w, { ...s, ...cs }, w.provider, true);
  expectFail(res, "InvalidAttestor", "worker-authority self-attestation must be rejected");

  // Money-safety: escrow must still hold the reward, task not Completed.
  assert.ok(!isClosed(w.svm, s.escrow), "escrow untouched after rejected self-attestation");
  const t = decode(w.svm, "Task", s.task);
  assert.ok(t.status.Completed === undefined, `task NOT Completed (got ${JSON.stringify(t.status)})`);
});

test("ExternalAttestation self-attestation guard: creator-as-attestor is rejected at configure time (InvalidAttestor)", async () => {
  // Defense-in-depth: the creator path is caught earlier, at configure_task_validation,
  // so the bad attestor config never even persists.
  const w = await freshWorld({ moderationEnabled: true });
  const s = await setupAttestedTask(w, { attestor: w.buyer.publicKey }); // buyer == task.creator
  expectFail(s.configureRes, "InvalidAttestor", "creator-as-attestor must be rejected at configure");
});

test("ExternalAttestation positive: an INDEPENDENT third-party attestor can approve and the worker is paid", async () => {
  // No over-restriction: a distinct attestor (!= creator, != worker.authority) approves
  // and settlement completes — proving the guard rejects only the self-deal, not all
  // external attestation.
  const w = await freshWorld({ moderationEnabled: true });
  const attestorKp = Keypair.generate();
  w.svm.airdrop(attestorKp.publicKey, BigInt(100e9)); // reviewer pays the vote rent + fees
  assert.notEqual(attestorKp.publicKey.toBase58(), w.buyer.publicKey.toBase58(), "attestor != creator");
  assert.notEqual(attestorKp.publicKey.toBase58(), w.provider.publicKey.toBase58(), "attestor != worker authority");

  const s = await setupAttestedTask(w, { attestor: attestorKp.publicKey });
  const cs = await s.claimAndSubmit();

  const workerBalBefore = Number(w.svm.getBalance(w.provider.publicKey));
  const res = await validate(w, { ...s, ...cs }, attestorKp, true);
  expectOk(res, "independent attestor approves");

  const t = decode(w.svm, "Task", s.task);
  assert.ok(t.status.Completed !== undefined, `task Completed after attestation (got ${JSON.stringify(t.status)})`);
  assert.ok(Number(w.svm.getBalance(w.provider.publicKey)) > workerBalBefore, "worker paid on independent attestation");
  assert.ok(isClosed(w.svm, s.escrow), "escrow closed after settlement");
});
