// E2E: the human-visitor single-agent storefront loop, end to end on the real program.
// A plain human wallet (NO registered agent) hires a specific service listing in SOL via
// hire_from_listing_humanless, the agent does the work, the human REVIEWS and accepts, and
// settlement pays the 3-way split — including the operator (embedder) cut on the
// CreatorReview path (the previously-deferred "9b": accept_task_result is now hire-aware).
import test from "node:test";
import assert from "node:assert/strict";
import {
  enc, arr, pda, id32, makeProgram, send, expectOk, decode, isClosed,
  freshWorld, BN, Keypair, SystemProgram,
} from "./harness.mjs";

test("storefront: a human with NO agent hires a listing in SOL; review-accept pays worker + AgenC + operator", async () => {
  const operatorKp = Keypair.generate();
  const operatorFeeBps = 1000; // 10% embedder cut
  const price = 5_000_000;
  const w = await freshWorld({
    moderationEnabled: true,
    price,
    operator: operatorKp.publicKey,
    operatorFeeBps,
  });

  // A fresh HUMAN visitor wallet — no AgentRegistration.
  const human = Keypair.generate();
  w.svm.airdrop(human.publicKey, BigInt(100e9));
  const humanProg = makeProgram(human);
  const modProg = makeProgram(w.modAuth);

  // 1) moderation: record a CLEAN listing attestation for the listing's pinned spec.
  const [listingMod] = pda([enc("listing_moderation"), w.listing.toBuffer(), Buffer.from(w.specHash)]);
  expectOk(send(w.svm, await modProg.methods
    .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "store:listing-mod");

  // 2) the human (no agent) hires the listing directly — SOL escrow, CreatorReview pinned.
  const taskId = id32();
  const [task] = pda([enc("task"), human.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [hireRecord] = pda([enc("hire"), task.toBuffer()]);
  const [validation] = pda([enc("task_validation"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), human.publicKey.toBuffer()]);

  expectOk(send(w.svm, await humanProg.methods
    .hireFromListingHumanless(arr(taskId), new BN(price), new BN(1), new BN(3600), null, 0)
    .accounts({
      task, escrow, hireRecord, taskValidationConfig: validation, listing: w.listing,
      protocolConfig: w.protocolPda, moderationConfig: w.modCfg, listingModeration: listingMod,
      authorityRateLimit: rateLimit, creator: human.publicKey, systemProgram: SystemProgram.programId,
    })
    .instruction(), [human]), "store:hire-humanless");

  // Operator terms stamped onto the Task; CreatorReview pinned; escrow funded.
  const t0 = decode(w.svm, "Task", task);
  assert.equal(t0.operator.toBase58(), operatorKp.publicKey.toBase58(), "Task.operator stamped from the listing");
  assert.equal(t0.operator_fee_bps, operatorFeeBps, "operator_fee_bps stamped");
  assert.ok(decode(w.svm, "TaskValidationConfig", validation).mode.CreatorReview !== undefined, "pinned CreatorReview");
  assert.equal(Number(decode(w.svm, "TaskEscrow", escrow).amount), price, "escrow funded with the price");

  // 3) task moderation -> publish job spec (the HUMAN creator signs) -> worker claims.
  const jobHash = id32();
  const [taskMod] = pda([enc("task_moderation"), task.toBuffer(), Buffer.from(jobHash)]);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  const [submission] = pda([enc("task_submission"), claim.toBuffer()]);

  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "store:task-mod");

  expectOk(send(w.svm, await humanProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/x")
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, taskJobSpec: jobSpec, creator: human.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [human]), "store:publish (human creator, no agent)");

  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "store:claim");

  // 4) worker submits the result.
  const desc = Buffer.alloc(64); desc.set(id32(), 0);
  expectOk(send(w.svm, await w.providerProg.methods
    .submitTaskResult(arr(id32()), arr(desc))
    .accounts({ task, claim, taskValidationConfig: validation, taskSubmission: submission, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "store:submit");

  // 5) the HUMAN reviews and accepts -> 3-way settlement incl. the operator leg.
  const operatorBefore = Number(w.svm.getBalance(operatorKp.publicKey));
  const workerBefore = Number(w.svm.getBalance(w.provider.publicKey));
  const treasuryBefore = Number(w.svm.getBalance(w.admin.publicKey));

  expectOk(send(w.svm, await humanProg.methods
    .acceptTaskResult()
    .accounts({
      task, claim, escrow, taskValidationConfig: validation, taskSubmission: submission,
      worker: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey,
      creator: human.publicKey, workerAuthority: w.provider.publicKey,
      operator: operatorKp.publicKey, referrer: null, hireRecord,
      creatorCompletionBond: null, workerCompletionBond: null,
      tokenEscrowAta: null, workerTokenAccount: null, treasuryTokenAccount: null,
      rewardMint: null, tokenProgram: null, systemProgram: SystemProgram.programId,
    })
    .instruction(), [human]), "store:human-accept");

  // Settlement assertions: task done, escrow closed, and all three legs paid.
  assert.ok(decode(w.svm, "Task", task).status.Completed !== undefined, "task Completed after human review");
  assert.ok(isClosed(w.svm, escrow), "escrow closed on settlement");

  const expectedOperatorFee = Math.floor((price * operatorFeeBps) / 10000); // 500_000
  assert.equal(
    Number(w.svm.getBalance(operatorKp.publicKey)) - operatorBefore, expectedOperatorFee,
    "operator (embedder) received its exact cut on the CreatorReview path",
  );
  assert.ok(Number(w.svm.getBalance(w.provider.publicKey)) > workerBefore, "worker paid");
  assert.ok(Number(w.svm.getBalance(w.admin.publicKey)) > treasuryBefore, "AgenC treasury paid its protocol cut");
});
