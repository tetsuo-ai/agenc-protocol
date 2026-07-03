// In-process litesvm integration tests for the P6.8 moderation-attestor REGISTRY.
//   - assign_moderation_attestor   (assignModerationAttestor)
//   - revoke_moderation_attestor   (revokeModerationAttestor)
//   - record_task_moderation       (recordTaskModeration) via a registered attestor
//   - record_listing_moderation    (recordListingModeration) via a registered attestor
//
// Executes the COMPILED program (target/deploy/agenc_coordination.so) end-to-end and
// drives the registry mirror of the dispute-resolver roster. Mirrors the style of
// listing-mod-dispute.test.mjs.
//
// In the test world, ModerationConfig is injected with:
//   authority            = admin   (owns the roster: assign/revoke signer)
//   moderation_authority = modAuth (the single global recorder)
//
// REVERT-SENSITIVE INTENT — each negative isolates exactly one new guard:
//   - "stranger cannot record (no attestor entry)"  -> handler require_moderation_authorized
//        (UnauthorizedModerationAttestor). Before P6.8, the account-level constraint on
//        `moderator` enforced this; now the handler does. Removing the handler check (or
//        wrongly defaulting attestor_supplied to true) flips this to a pass.
//   - "a REVOKED attestor cannot record"            -> the revoke closes the
//        ["moderation_attestor", attestor] PDA, so passing it fails account resolution and
//        the recorder is no longer authorized. If revoke did NOT close (or the handler
//        accepted a stale/closed entry), this would wrongly pass.
//   - "non-roster-authority cannot assign"          -> the assign authority constraint
//        (UnauthorizedTaskModerator). modAuth (the recorder) is NOT the roster authority.
//   - "default (zero) attestor is rejected"         -> the InvalidModerationAttestor guard.
//   - "re-assigning an existing attestor fails"     -> the init-once roster PDA.
// The positives prove a registered attestor (who is NOT the global moderation authority)
// can record both task and listing moderation — i.e. the OR-branch actually authorizes.
//
// NOTE: requires the rebuilt .so + regenerated IDL (the integrator runs anchor build +
// artifacts:refresh first). It references the to-be-generated `assignModerationAttestor` /
// `revokeModerationAttestor` builders and the `ModerationAttestor` account decoder by
// their naming-convention names.
//
// Run:  cd agenc-protocol && node --test tests-integration/moderation-attestor.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import { Buffer } from "node:buffer";
import {
  enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode, isClosed,
  freshWorld, hireIx,
  taskModV2Pda, listingModV2Pda,
  BN, Keypair, PublicKey, SystemProgram,
} from "./harness.mjs";

// Derive the roster PDA for an attestor wallet.
const attestorPda = (attestor) =>
  pda([enc("moderation_attestor"), attestor.toBuffer()]);

// Assign `attestor` to the roster, signed by the roster authority (admin).
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

// Revoke `attestor` from the roster, signed by the roster authority (admin).
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

// Build a record_task_moderation ix from `recorder`, optionally passing the attestor PDA.
// P1.2: the record PDA is the v2 moderator-keyed one, derived from the recording signer.
async function recordTaskModeration(w, { task, recorder, jobHash, attestorEntry = null }) {
  const [taskMod] = taskModV2Pda(task, jobHash, recorder.publicKey);
  return {
    taskMod,
    ix: await makeProgram(recorder).methods
      .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
      .accounts({
        moderationConfig: w.modCfg,
        task,
        taskModeration: taskMod,
        moderator: recorder.publicKey,
        moderationAttestor: attestorEntry,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
  };
}

// ---------------------------------------------------------------------------
// assign / revoke roster lifecycle
// ---------------------------------------------------------------------------

test("assign_moderation_attestor: roster authority assigns a new attestor PDA", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const attestor = Keypair.generate();
  const [entry] = attestorPda(attestor.publicKey);

  assert.ok(isClosed(w.svm, entry), "attestor entry does not exist yet");
  expectOk(await assign(w, attestor.publicKey), "assign attestor");

  const acct = decode(w.svm, "ModerationAttestor", entry);
  assert.equal(acct.attestor.toBase58(), attestor.publicKey.toBase58(), "attestor recorded");
  assert.equal(acct.assigned_by.toBase58(), w.admin.publicKey.toBase58(), "assigned_by = roster authority");
});

test("assign_moderation_attestor: a non-roster-authority cannot assign", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const attestor = Keypair.generate();
  // modAuth is the global RECORDER but NOT the roster authority (that's admin).
  expectFail(
    await assign(w, attestor.publicKey, w.modAuth),
    "UnauthorizedTaskModerator",
    "non-authority assign",
  );
  assert.ok(isClosed(w.svm, attestorPda(attestor.publicKey)[0]), "no entry created on rejected assign");
});

test("assign_moderation_attestor: a default (zero) attestor is rejected", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const [entry] = attestorPda(PublicKey.default);
  expectFail(
    send(
      w.svm,
      await makeProgram(w.admin).methods
        .assignModerationAttestor(PublicKey.default)
        .accounts({
          moderationConfig: w.modCfg,
          moderationAttestor: entry,
          authority: w.admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [w.admin],
    ),
    "InvalidModerationAttestor",
    "zero attestor",
  );
});

test("assign_moderation_attestor: re-assigning an already-rostered attestor fails (init-once)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const attestor = Keypair.generate();
  expectOk(await assign(w, attestor.publicKey), "first assign");
  w.svm.expireBlockhash();
  // The roster PDA already exists -> init fails.
  expectFail(await assign(w, attestor.publicKey), "already in use", "double assign");
});

test("revoke_moderation_attestor: roster authority revokes -> PDA closed", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const attestor = Keypair.generate();
  const [entry] = attestorPda(attestor.publicKey);
  expectOk(await assign(w, attestor.publicKey), "assign");
  assert.ok(!isClosed(w.svm, entry), "entry exists after assign");

  expectOk(await revoke(w, attestor.publicKey), "revoke");
  assert.ok(isClosed(w.svm, entry), "entry closed after revoke");
});

// ---------------------------------------------------------------------------
// Attestor authorization on record_task_moderation
// ---------------------------------------------------------------------------

test("record_task_moderation: a registered attestor (not the global authority) can record", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const attestor = Keypair.generate();
  w.svm.airdrop(attestor.publicKey, BigInt(10e9));
  const [entry] = attestorPda(attestor.publicKey);
  expectOk(await assign(w, attestor.publicKey), "assign attestor");

  // Mint a task to moderate: buyer hires the listing (needs a CLEAN ListingModeration first).
  const [listingMod] = listingModV2Pda(w.listing, w.specHash, w.modAuth.publicKey);
  expectOk(
    send(
      w.svm,
      (await makeProgram(w.modAuth).methods
        .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
        .accounts({
          moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod,
          moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId,
        })
        .instruction()),
      [w.modAuth],
    ),
    "global authority records listing mod",
  );
  const taskId = id32();
  const hire = await hireIx(w, { taskId, listingModeration: listingMod });
  expectOk(send(w.svm, hire.ix, [w.buyer]), "hire");

  const jobHash = id32();
  const { ix } = await recordTaskModeration(w, { task: hire.task, recorder: attestor, jobHash, attestorEntry: entry });
  expectOk(send(w.svm, ix, [attestor]), "registered attestor records task moderation");

  const [taskMod] = taskModV2Pda(hire.task, jobHash, attestor.publicKey);
  const decoded = decode(w.svm, "TaskModeration", taskMod);
  assert.equal(decoded.moderator.toBase58(), attestor.publicKey.toBase58(), "recorded by the attestor");
});

test("record_task_moderation: a stranger with NO roster entry cannot record", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const stranger = Keypair.generate();
  w.svm.airdrop(stranger.publicKey, BigInt(10e9));

  // Hire to create a task (clean listing-mod first, recorded by the global authority).
  const [listingMod] = listingModV2Pda(w.listing, w.specHash, w.modAuth.publicKey);
  expectOk(
    send(
      w.svm,
      await makeProgram(w.modAuth).methods
        .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
        .accounts({
          moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod,
          moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [w.modAuth],
    ),
    "listing mod by authority",
  );
  const taskId = id32();
  const hire = await hireIx(w, { taskId, listingModeration: listingMod });
  expectOk(send(w.svm, hire.ix, [w.buyer]), "hire");

  // Stranger tries to record without passing any attestor entry -> handler rejects.
  const jobHash = id32();
  const { ix } = await recordTaskModeration(w, { task: hire.task, recorder: stranger, jobHash, attestorEntry: null });
  expectFail(send(w.svm, ix, [stranger]), "UnauthorizedModerationAttestor", "stranger record");
});

test("record_task_moderation: a REVOKED attestor cannot record", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const attestor = Keypair.generate();
  w.svm.airdrop(attestor.publicKey, BigInt(10e9));
  const [entry] = attestorPda(attestor.publicKey);

  expectOk(await assign(w, attestor.publicKey), "assign");
  w.svm.expireBlockhash();
  expectOk(await revoke(w, attestor.publicKey), "revoke");
  assert.ok(isClosed(w.svm, entry), "attestor entry closed after revoke");

  // Hire to create a task.
  const [listingMod] = listingModV2Pda(w.listing, w.specHash, w.modAuth.publicKey);
  expectOk(
    send(
      w.svm,
      await makeProgram(w.modAuth).methods
        .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
        .accounts({
          moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod,
          moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [w.modAuth],
    ),
    "listing mod by authority",
  );
  const taskId = id32();
  const hire = await hireIx(w, { taskId, listingModeration: listingMod });
  expectOk(send(w.svm, hire.ix, [w.buyer]), "hire");

  // Passing the now-closed entry fails account resolution; the revoked attestor is no
  // longer authorized.
  const jobHash = id32();
  const { ix } = await recordTaskModeration(w, { task: hire.task, recorder: attestor, jobHash, attestorEntry: entry });
  const res = send(w.svm, ix, [attestor]);
  assert.ok(
    res && res.err !== undefined,
    "a revoked attestor must NOT be able to record (closed roster PDA fails to load)",
  );
});

// ---------------------------------------------------------------------------
// Attestor authorization on record_listing_moderation
// ---------------------------------------------------------------------------

test("record_listing_moderation: a registered attestor (not the global authority) can record", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const attestor = Keypair.generate();
  w.svm.airdrop(attestor.publicKey, BigInt(10e9));
  const [entry] = attestorPda(attestor.publicKey);
  expectOk(await assign(w, attestor.publicKey), "assign attestor");

  const [listingMod] = listingModV2Pda(w.listing, w.specHash, attestor.publicKey);
  expectOk(
    send(
      w.svm,
      await makeProgram(attestor).methods
        .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
        .accounts({
          moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod,
          moderator: attestor.publicKey, moderationAttestor: entry, systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [attestor],
    ),
    "registered attestor records listing moderation",
  );
  const decoded = decode(w.svm, "ListingModeration", listingMod);
  assert.equal(decoded.moderator.toBase58(), attestor.publicKey.toBase58(), "recorded by the attestor");
});

test("record_listing_moderation: a stranger with NO roster entry cannot record", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const stranger = Keypair.generate();
  w.svm.airdrop(stranger.publicKey, BigInt(10e9));
  const [listingMod] = listingModV2Pda(w.listing, w.specHash, stranger.publicKey);
  expectFail(
    send(
      w.svm,
      await makeProgram(stranger).methods
        .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
        .accounts({
          moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod,
          moderator: stranger.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [stranger],
    ),
    "UnauthorizedModerationAttestor",
    "stranger record listing",
  );
});

test("record_*_moderation: the global moderation authority still records (back-compat)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const [listingMod] = listingModV2Pda(w.listing, w.specHash, w.modAuth.publicKey);
  // Global authority records with moderationAttestor=null — the unchanged path.
  expectOk(
    send(
      w.svm,
      await makeProgram(w.modAuth).methods
        .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
        .accounts({
          moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod,
          moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [w.modAuth],
    ),
    "global authority still records",
  );
  assert.equal(
    decode(w.svm, "ListingModeration", listingMod).moderator.toBase58(),
    w.modAuth.publicKey.toBase58(),
    "recorded by the global moderation authority",
  );
});
