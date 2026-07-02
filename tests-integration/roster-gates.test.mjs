// WP-A1 — roster-honored moderation CONSUMPTION gates (in-process litesvm, real .so).
//
// P6.8 shipped the ModerationAttestor roster for RECORDING (record_task_moderation /
// record_listing_moderation accept a registered non-revoked attestor). WP-A1 widens the
// three CONSUMPTION gates so a roster attestor's attestation actually unlocks go-live:
//   (1) set_task_job_spec           — task publish gate
//   (2) hire_from_listing           — hire gate (agent buyer)
//   (3) hire_from_listing_humanless — hire gate (human buyer, no agent)
//
// REVERT-SENSITIVE INTENT — each "roster attestor unlocks ..." positive FAILS against the
// pre-fix program, whose gate required `moderator == moderation_authority`. With the fix the
// gate accepts `moderator == authority || (registered, non-revoked attestor supplied)`.
// Proven red on 2026-07-02 by reverting the two `|| attestor_supplied` predicates and
// rebuilding the .so (see the WP-A1 evidence).
//
// Each gate site is exercised with all four scenarios the WP requires:
//   - a registered roster attestor end-to-end satisfies the gate            (NEW behavior)
//   - a REVOKED attestor is rejected (closed roster PDA fails to load)
//   - the global moderation authority still works (byte-unchanged path)
//   - an unregistered / no-entry path is rejected (fail-closed, no fail-open)
// Plus a security case: a FOREIGN still-valid attestor cannot be substituted for the
// attestation's real (revoked) moderator.
//
// Run:  cd agenc-protocol && node --test tests-integration/roster-gates.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import {
  enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode, isClosed,
  freshWorld, hireIx,
  BN, Keypair, SystemProgram,
} from "./harness.mjs";

// ---------------------------------------------------------------------------
// Roster + moderation helpers (shared shape with moderation-attestor.test.mjs)
// ---------------------------------------------------------------------------
const attestorPda = (attestor) => pda([enc("moderation_attestor"), attestor.toBuffer()]);

async function assign(w, attestor, signer = w.admin) {
  const [entry] = attestorPda(attestor);
  return send(
    w.svm,
    await makeProgram(signer).methods
      .assignModerationAttestor(attestor)
      .accounts({
        moderationConfig: w.modCfg,
        moderationAttestor: entry,
        authority: signer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
    [signer],
  );
}

async function revoke(w, attestor, signer = w.admin) {
  const [entry] = attestorPda(attestor);
  return send(
    w.svm,
    await makeProgram(signer).methods
      .revokeModerationAttestor()
      .accounts({
        moderationConfig: w.modCfg,
        moderationAttestor: entry,
        authority: signer.publicKey,
      })
      .instruction(),
    [signer],
  );
}

// Record a task-moderation for (task, jobHash), signed by `recorder`. Passing a roster
// `attestorEntry` authorizes a non-global-authority recorder.
async function recordTaskMod(w, { task, jobHash, recorder, attestorEntry = null }) {
  const [taskMod] = pda([enc("task_moderation"), task.toBuffer(), Buffer.from(jobHash)]);
  expectOk(
    send(
      w.svm,
      await makeProgram(recorder).methods
        .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
        .accounts({
          moderationConfig: w.modCfg, task, taskModeration: taskMod,
          moderator: recorder.publicKey, moderationAttestor: attestorEntry,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [recorder],
    ),
    "record task moderation",
  );
  return taskMod;
}

// Record a CLEAN listing-moderation for the world's listing spec, signed by `recorder`.
async function recordListingMod(w, { recorder, attestorEntry = null }) {
  const [listingMod] = pda([enc("listing_moderation"), w.listing.toBuffer(), Buffer.from(w.specHash)]);
  expectOk(
    send(
      w.svm,
      await makeProgram(recorder).methods
        .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
        .accounts({
          moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod,
          moderator: recorder.publicKey, moderationAttestor: attestorEntry,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [recorder],
    ),
    "record listing moderation",
  );
  return listingMod;
}

// Mint a plain Exclusive SOL task from the buyer (no listing coupling).
async function createPlainTask(w, { taskId = id32() } = {}) {
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  expectOk(
    send(
      w.svm,
      await w.buyerProg.methods
        .createTask(arr(taskId), new BN(1), arr(desc), new BN(1_000_000), 1, new BN(now + 3600), 0, null, 0, null, null, 0)
        .accounts({
          task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent,
          authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey,
          systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null,
          tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null,
        })
        .instruction(),
      [w.buyer],
    ),
    "create plain task",
  );
  return { task, escrow };
}

// Build a set_task_job_spec ix (not sent) for `task` + `jobHash`, optionally supplying the
// roster attestor entry.
async function publishIx(w, { task, jobHash, taskMod, attestorEntry = null }) {
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  const ix = await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/roster")
    .accounts({
      protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod,
      moderationAttestor: attestorEntry, taskJobSpec: jobSpec, creator: w.buyer.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return { ix, jobSpec };
}

// ===========================================================================
// GATE 1 — set_task_job_spec (task publish)
// ===========================================================================

test("publish gate: a registered roster attestor unlocks set_task_job_spec (NEW)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const attestor = Keypair.generate();
  w.svm.airdrop(attestor.publicKey, BigInt(10e9));
  const [entry] = attestorPda(attestor.publicKey);
  expectOk(await assign(w, attestor.publicKey), "assign attestor");

  const { task } = await createPlainTask(w);
  const jobHash = id32();
  // The roster attestor (NOT the global authority) authors the task moderation...
  const taskMod = await recordTaskMod(w, { task, jobHash, recorder: attestor, attestorEntry: entry });
  assert.equal(
    decode(w.svm, "TaskModeration", taskMod).moderator.toBase58(),
    attestor.publicKey.toBase58(),
    "task moderation authored by the roster attestor",
  );
  // ...and the creator publishes by presenting the attestor entry. Pre-fix this reverts
  // (UnauthorizedTaskModerator); with WP-A1 it succeeds.
  const { ix, jobSpec } = await publishIx(w, { task, jobHash, taskMod, attestorEntry: entry });
  expectOk(send(w.svm, ix, [w.buyer]), "roster attestor publishes");
  assert.equal(
    decode(w.svm, "TaskJobSpec", jobSpec).task.toBase58(), task.toBase58(),
    "job spec pointer written",
  );
});

test("publish gate: roster-authored moderation without the attestor entry is rejected (fail-closed)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const attestor = Keypair.generate();
  w.svm.airdrop(attestor.publicKey, BigInt(10e9));
  const [entry] = attestorPda(attestor.publicKey);
  expectOk(await assign(w, attestor.publicKey), "assign attestor");

  const { task } = await createPlainTask(w);
  const jobHash = id32();
  const taskMod = await recordTaskMod(w, { task, jobHash, recorder: attestor, attestorEntry: entry });
  // Omitting the attestor entry ⇒ attestor_supplied=false ⇒ moderator != authority ⇒ reject.
  const { ix } = await publishIx(w, { task, jobHash, taskMod, attestorEntry: null });
  expectFail(send(w.svm, ix, [w.buyer]), "UnauthorizedTaskModerator", "publish without attestor entry");
});

test("publish gate: a REVOKED attestor cannot publish (closed roster PDA)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const attestor = Keypair.generate();
  w.svm.airdrop(attestor.publicKey, BigInt(10e9));
  const [entry] = attestorPda(attestor.publicKey);
  expectOk(await assign(w, attestor.publicKey), "assign attestor");

  const { task } = await createPlainTask(w);
  const jobHash = id32();
  const taskMod = await recordTaskMod(w, { task, jobHash, recorder: attestor, attestorEntry: entry });

  // Revoke AFTER the moderation was recorded — the task moderation still says moderator=attestor.
  w.svm.expireBlockhash();
  expectOk(await revoke(w, attestor.publicKey), "revoke attestor");
  assert.ok(isClosed(w.svm, entry), "roster PDA closed after revoke");

  // Presenting the now-closed entry fails account resolution.
  const { ix } = await publishIx(w, { task, jobHash, taskMod, attestorEntry: entry });
  const res = send(w.svm, ix, [w.buyer]);
  assert.ok(res && res.err !== undefined, "revoked attestor must not publish (closed PDA fails to load)");

  // And falling back to null is rejected by the gate itself.
  const { ix: ixNull } = await publishIx(w, { task, jobHash, taskMod, attestorEntry: null });
  expectFail(send(w.svm, ixNull, [w.buyer]), "UnauthorizedTaskModerator", "revoked attestor null fallback");
});

test("publish gate: the global moderation authority still publishes (byte-unchanged path)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const { task } = await createPlainTask(w);
  const jobHash = id32();
  // Global authority records + creator publishes with moderationAttestor=null.
  const taskMod = await recordTaskMod(w, { task, jobHash, recorder: w.modAuth, attestorEntry: null });
  const { ix, jobSpec } = await publishIx(w, { task, jobHash, taskMod, attestorEntry: null });
  expectOk(send(w.svm, ix, [w.buyer]), "global authority publishes");
  assert.equal(decode(w.svm, "TaskJobSpec", jobSpec).task.toBase58(), task.toBase58(), "job spec written");
});

test("publish gate: an unregistered stranger can never seed a publishable moderation", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const stranger = Keypair.generate();
  w.svm.airdrop(stranger.publicKey, BigInt(10e9));
  const { task } = await createPlainTask(w);
  const jobHash = id32();
  const [taskMod] = pda([enc("task_moderation"), task.toBuffer(), Buffer.from(jobHash)]);
  // The stranger cannot even RECORD a task moderation ⇒ the publish gate is unreachable.
  expectFail(
    send(
      w.svm,
      await makeProgram(stranger).methods
        .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
        .accounts({
          moderationConfig: w.modCfg, task, taskModeration: taskMod,
          moderator: stranger.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [stranger],
    ),
    "UnauthorizedModerationAttestor",
    "stranger cannot record",
  );
  assert.ok(isClosed(w.svm, taskMod), "no task moderation created for the stranger");
});

// ===========================================================================
// GATE 2 — hire_from_listing (agent buyer)
// ===========================================================================

test("hire gate: a registered roster attestor unlocks hire_from_listing (NEW)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const attestor = Keypair.generate();
  w.svm.airdrop(attestor.publicKey, BigInt(10e9));
  const [entry] = attestorPda(attestor.publicKey);
  expectOk(await assign(w, attestor.publicKey), "assign attestor");

  // The roster attestor (NOT the global authority) attests the listing spec...
  const listingMod = await recordListingMod(w, { recorder: attestor, attestorEntry: entry });
  assert.equal(
    decode(w.svm, "ListingModeration", listingMod).moderator.toBase58(),
    attestor.publicKey.toBase58(), "listing moderation authored by the roster attestor",
  );
  // ...and the buyer hires by presenting the attestor entry. Pre-fix reverts.
  const taskId = id32();
  const hire = await hireIx(w, { taskId, listingModeration: listingMod, moderationAttestor: entry });
  expectOk(send(w.svm, hire.ix, [w.buyer]), "roster attestor unlocks hire");
  assert.equal(decode(w.svm, "Task", hire.task).creator.toBase58(), w.buyer.publicKey.toBase58(), "task minted");
});

test("hire gate: roster-authored listing moderation without the attestor entry is rejected", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const attestor = Keypair.generate();
  w.svm.airdrop(attestor.publicKey, BigInt(10e9));
  const [entry] = attestorPda(attestor.publicKey);
  expectOk(await assign(w, attestor.publicKey), "assign attestor");
  const listingMod = await recordListingMod(w, { recorder: attestor, attestorEntry: entry });

  const taskId = id32();
  const hire = await hireIx(w, { taskId, listingModeration: listingMod, moderationAttestor: null });
  expectFail(send(w.svm, hire.ix, [w.buyer]), "UnauthorizedTaskModerator", "hire without attestor entry");
});

test("hire gate: a REVOKED attestor cannot hire; a FOREIGN attestor cannot be substituted", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const attestor = Keypair.generate();
  const other = Keypair.generate();
  for (const kp of [attestor, other]) w.svm.airdrop(kp.publicKey, BigInt(10e9));
  const [entry] = attestorPda(attestor.publicKey);
  const [otherEntry] = attestorPda(other.publicKey);
  expectOk(await assign(w, attestor.publicKey), "assign attestor");
  const listingMod = await recordListingMod(w, { recorder: attestor, attestorEntry: entry });

  // A DIFFERENT still-valid attestor is on the roster...
  w.svm.expireBlockhash();
  expectOk(await assign(w, other.publicKey), "assign other attestor");
  // ...but cannot be substituted for the listing's real moderator (attestor).
  const hireForeign = await hireIx(w, { taskId: id32(), listingModeration: listingMod, moderationAttestor: otherEntry });
  expectFail(send(w.svm, hireForeign.ix, [w.buyer]), "ModerationAttestorMismatch", "foreign attestor substitution");

  // Now revoke the real attestor: presenting the closed entry fails; null is gate-rejected.
  w.svm.expireBlockhash();
  expectOk(await revoke(w, attestor.publicKey), "revoke real attestor");
  assert.ok(isClosed(w.svm, entry), "real roster PDA closed");
  const hireRevoked = await hireIx(w, { taskId: id32(), listingModeration: listingMod, moderationAttestor: entry });
  const res = send(w.svm, hireRevoked.ix, [w.buyer]);
  assert.ok(res && res.err !== undefined, "revoked attestor must not hire (closed PDA fails to load)");
  const hireNull = await hireIx(w, { taskId: id32(), listingModeration: listingMod, moderationAttestor: null });
  expectFail(send(w.svm, hireNull.ix, [w.buyer]), "UnauthorizedTaskModerator", "revoked attestor null fallback");
});

test("hire gate: the global moderation authority still hires (byte-unchanged path)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const listingMod = await recordListingMod(w, { recorder: w.modAuth, attestorEntry: null });
  const taskId = id32();
  const hire = await hireIx(w, { taskId, listingModeration: listingMod, moderationAttestor: null });
  expectOk(send(w.svm, hire.ix, [w.buyer]), "global authority hires");
  assert.equal(decode(w.svm, "Task", hire.task).creator.toBase58(), w.buyer.publicKey.toBase58(), "task minted");
});

// ===========================================================================
// GATE 3 — hire_from_listing_humanless (human buyer, no agent)
// ===========================================================================

// Build a hire_from_listing_humanless ix for a human wallet (no AgentRegistration).
async function humanlessHireIx(w, { human, taskId, listingMod, moderationAttestor = null }) {
  const [task] = pda([enc("task"), human.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [hireRecord] = pda([enc("hire"), task.toBuffer()]);
  const [validation] = pda([enc("task_validation"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), human.publicKey.toBuffer()]);
  const ix = await makeProgram(human).methods
    .hireFromListingHumanless(arr(taskId), new BN(w.price), new BN(1), new BN(3600), null, 0)
    .accounts({
      task, escrow, hireRecord, taskValidationConfig: validation, listing: w.listing,
      protocolConfig: w.protocolPda, moderationConfig: w.modCfg, listingModeration: listingMod,
      moderationAttestor, authorityRateLimit: rateLimit, creator: human.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return { ix, task };
}

test("humanless hire gate: a registered roster attestor unlocks hire_from_listing_humanless (NEW)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const attestor = Keypair.generate();
  const human = Keypair.generate();
  for (const kp of [attestor, human]) w.svm.airdrop(kp.publicKey, BigInt(100e9));
  const [entry] = attestorPda(attestor.publicKey);
  expectOk(await assign(w, attestor.publicKey), "assign attestor");
  const listingMod = await recordListingMod(w, { recorder: attestor, attestorEntry: entry });

  const { ix, task } = await humanlessHireIx(w, { human, taskId: id32(), listingMod, moderationAttestor: entry });
  expectOk(send(w.svm, ix, [human]), "roster attestor unlocks humanless hire");
  assert.equal(decode(w.svm, "Task", task).creator.toBase58(), human.publicKey.toBase58(), "task minted for the human");
});

test("humanless hire gate: a REVOKED attestor is rejected; global authority still hires", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const attestor = Keypair.generate();
  const human = Keypair.generate();
  for (const kp of [attestor, human]) w.svm.airdrop(kp.publicKey, BigInt(100e9));
  const [entry] = attestorPda(attestor.publicKey);
  expectOk(await assign(w, attestor.publicKey), "assign attestor");
  const listingMod = await recordListingMod(w, { recorder: attestor, attestorEntry: entry });

  w.svm.expireBlockhash();
  expectOk(await revoke(w, attestor.publicKey), "revoke attestor");
  const revoked = await humanlessHireIx(w, { human, taskId: id32(), listingMod, moderationAttestor: entry });
  const res = send(w.svm, revoked.ix, [human]);
  assert.ok(res && res.err !== undefined, "revoked attestor must not hire (closed PDA)");
  const nullFallback = await humanlessHireIx(w, { human, taskId: id32(), listingMod, moderationAttestor: null });
  expectFail(send(w.svm, nullFallback.ix, [human]), "UnauthorizedTaskModerator", "revoked null fallback");
});

test("humanless hire gate: the global moderation authority still hires (byte-unchanged path)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const human = Keypair.generate();
  w.svm.airdrop(human.publicKey, BigInt(100e9));
  const listingMod = await recordListingMod(w, { recorder: w.modAuth, attestorEntry: null });
  const { ix, task } = await humanlessHireIx(w, { human, taskId: id32(), listingMod, moderationAttestor: null });
  expectOk(send(w.svm, ix, [human]), "global authority humanless hire");
  assert.equal(decode(w.svm, "Task", task).creator.toBase58(), human.publicKey.toBase58(), "task minted for the human");
});
