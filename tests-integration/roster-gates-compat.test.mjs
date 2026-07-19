// WP-A1 — deployed-client COMPATIBILITY CONTRACT for the roster-gate upgrade.
//
// Adding the optional `moderation_attestor` account to set_task_job_spec / hire_from_listing /
// hire_from_listing_humanless is a BREAKING interface change for already-deployed clients:
// Anchor 0.32.1 requires every optional account to be present in the account list (the real
// account, or the program id as the `None` placeholder), REGARDLESS of position. A pre-WP-A1
// client that has no knowledge of the account sends too few keys and the program rejects it
// with `AccountNotEnoughKeys` (empirically confirmed 2026-07-02; mid-list placement instead
// surfaces `AccountNotInitialized` / `AccountDiscriminatorMismatch`). There is NO account
// ordering that makes an unaware old client keep working — the deploy runbook must roll out
// regenerated clients in lockstep with the bytecode upgrade.
//
// The load-bearing SAFETY property this file guards: that break is **fail-closed**. An old
// client's truncated call must ABORT (no state written) — it must never silently mint a task
// or publish a job spec on a mis-mapped account list. And once a client regenerates against
// the new IDL (passing the `None` placeholder for the global-authority path), it works again.
//
// This is a compatibility/contract guard, not a bug-fix regression test; it is intentionally
// position-agnostic (asserts "old truncated call fails, nothing created" rather than a
// specific Anchor error code) so it stays valid if the optional account is ever repositioned.
//
// P1.2 (hardened open roster) update: the program now writes ONLY v2 moderator-keyed
// records (["task_moderation_v2"/"listing_moderation_v2", ..., moderator]), so a legacy
// 3-seed record can no longer be fabricated through record_*_moderation. To preserve the
// original compat intent — a PRE-UPGRADE legacy record authored by the global authority
// still unlocks the gate when passed at the legacy PDA with moderator = the global
// authority — this file INJECTS the legacy-seed accounts directly with svm.setAccount
// (the same byte-layout trick harness.mjs uses for ProtocolConfig/ModerationConfig).
//
// Run:  cd agenc-protocol && node --test tests-integration/roster-gates-compat.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { FailedTransactionMetadata } from "litesvm";
import {
  enc, arr, pda, id32, makeProgram, send, decode, isClosed,
  freshWorld, hireIx, moderationBlockPda, coder,
  BN, SystemProgram, PID,
} from "./harness.mjs";

const isFail = (res) => res instanceof FailedTransactionMetadata;

// Strip the moderation_attestor slot from a NEW-client instruction to model a pre-WP-A1
// caller that never knew the account existed. On the global-authority path moderation_attestor
// is null, so the sole program-id placeholder in these instructions IS moderation_attestor.
function truncateOldClient(ix) {
  ix.keys = ix.keys.filter((k) => !k.pubkey.equals(PID));
  return ix;
}

async function createPlainTask(w) {
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64); desc.set(crypto.randomBytes(32), 0);
  const r = send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(1_000_000), 1, new BN(now + 3600), 0, null, 0, null, null, 0)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent,
      authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey,
      systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null,
      tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null }).instruction(),
    [w.buyer]);
  assert.ok(!isFail(r), "create plain task");
  return { task };
}

// Inject a PRE-UPGRADE legacy-seed TaskModeration (["task_moderation", task, hash]) authored
// by the global authority. The post-P1.2 program only WRITES v2 moderator-keyed records, so
// this models a record that already existed on chain before the upgrade.
async function injectLegacyTaskMod(w, task, jobHash) {
  const [taskMod, bump] = pda([enc("task_moderation"), task.toBuffer(), Buffer.from(jobHash)]);
  const record = {
    task,
    creator: w.buyer.publicKey,
    job_spec_hash: arr(jobHash),
    status: 0, // CLEAN
    risk_score: 0,
    category_mask: new BN(0),
    policy_hash: arr(Buffer.alloc(32, 1)),
    scanner_hash: arr(Buffer.alloc(32, 2)),
    recorded_at: new BN(Number(w.svm.getClock().unixTimestamp)),
    expires_at: new BN(0),
    moderator: w.modAuth.publicKey,
    bump,
    _reserved: Array(7).fill(0),
  };
  const data = await coder.accounts.encode("TaskModeration", record);
  w.svm.setAccount(taskMod, {
    lamports: Number(w.svm.minimumBalanceForRentExemption(BigInt(data.length))),
    data, owner: PID, executable: false, rentEpoch: 0,
  });
  return taskMod;
}

// Inject a PRE-UPGRADE legacy-seed ListingModeration (["listing_moderation", listing, hash])
// authored by the global authority (same rationale as injectLegacyTaskMod).
async function injectLegacyListingMod(w) {
  const [listingMod, bump] = pda([enc("listing_moderation"), w.listing.toBuffer(), Buffer.from(w.specHash)]);
  const record = {
    listing: w.listing,
    provider_agent: w.providerAgent,
    job_spec_hash: arr(w.specHash),
    status: 0, // CLEAN
    risk_score: 0,
    category_mask: new BN(0),
    policy_hash: arr(Buffer.alloc(32, 7)),
    scanner_hash: arr(Buffer.alloc(32, 9)),
    recorded_at: new BN(Number(w.svm.getClock().unixTimestamp)),
    expires_at: new BN(0),
    moderator: w.modAuth.publicKey,
    bump,
    _reserved: Array(7).fill(0),
  };
  const data = await coder.accounts.encode("ListingModeration", record);
  w.svm.setAccount(listingMod, {
    lamports: Number(w.svm.minimumBalanceForRentExemption(BigInt(data.length))),
    data, owner: PID, executable: false, rentEpoch: 0,
  });
  return listingMod;
}

async function buildSetJobSpecIx(w, task, jobHash, taskMod) {
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  const ix = await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/compat", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod,
      moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0],
      taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction();
  return { ix, jobSpec };
}

async function buildHumanlessHireIx(w, human, listingMod) {
  const taskId = id32();
  const [task] = pda([enc("task"), human.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [hireRecord] = pda([enc("hire"), task.toBuffer()]);
  const [validation] = pda([enc("task_validation"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), human.publicKey.toBuffer()]);
  const ix = await makeProgram(human).methods
    .hireFromListingHumanless(arr(taskId), new BN(w.price), new BN(1), new BN(3600), null, 0, w.modAuth.publicKey)
    .accounts({ task, escrow, hireRecord, taskValidationConfig: validation, listing: w.listing,
      providerAgent: w.providerAgent,
      protocolConfig: w.protocolPda, moderationConfig: w.modCfg, listingModeration: listingMod,
      moderationAttestor: null, moderationBlock: moderationBlockPda(w.specHash)[0],
      authorityRateLimit: rateLimit, creator: human.publicKey,
      systemProgram: SystemProgram.programId })
    .instruction();
  return { ix, task };
}

// GATE 1 — set_task_job_spec
test("compat: pre-WP-A1 client that OMITS moderation_attestor fails CLOSED at set_task_job_spec; legacy record + regenerated client works", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const { task } = await createPlainTask(w);
  const jobHash = id32();
  // A PRE-UPGRADE legacy-seed record authored by the global authority (injected — the
  // post-P1.2 program only writes v2 records).
  const taskMod = await injectLegacyTaskMod(w, task, jobHash);

  // Old client: truncated account list (no moderation_attestor slot) → must abort, nothing written.
  const old = await buildSetJobSpecIx(w, task, jobHash, taskMod);
  const oldRes = send(w.svm, truncateOldClient(old.ix), [w.buyer]);
  assert.ok(isFail(oldRes), "old truncated client MUST fail (interface change is breaking)");
  assert.ok(isClosed(w.svm, old.jobSpec), "fail-closed: no job spec published by the old client");

  // Regenerated client: same call WITH the account present (null placeholder for global
  // authority) and moderator = the global authority → the frozen legacy record still
  // unlocks the gate at the legacy PDA. This is the required client action after the upgrade.
  w.svm.expireBlockhash();
  const fresh = await buildSetJobSpecIx(w, task, jobHash, taskMod);
  assert.ok(!isFail(send(w.svm, fresh.ix, [w.buyer])), "regenerated client publishes on the global-authority path");
  assert.equal(decode(w.svm, "TaskJobSpec", fresh.jobSpec).task.toBase58(), task.toBase58(), "job spec written");
});

// GATE 2 — hire_from_listing
test("compat: pre-WP-A1 client that OMITS moderation_attestor fails CLOSED at hire_from_listing; legacy record + regenerated client works", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const listingMod = await injectLegacyListingMod(w);

  const oldHire = await hireIx(w, { taskId: id32(), listingModeration: listingMod, moderationAttestor: null });
  const oldRes = send(w.svm, truncateOldClient(oldHire.ix), [w.buyer]);
  assert.ok(isFail(oldRes), "old truncated client MUST fail at hire");
  assert.ok(isClosed(w.svm, oldHire.task), "fail-closed: no task minted by the old client");

  w.svm.expireBlockhash();
  const freshHire = await hireIx(w, { taskId: id32(), listingModeration: listingMod, moderationAttestor: null });
  assert.ok(!isFail(send(w.svm, freshHire.ix, [w.buyer])), "regenerated client hires on the global-authority path");
  assert.equal(decode(w.svm, "Task", freshHire.task).creator.toBase58(), w.buyer.publicKey.toBase58(), "task minted");
});

// GATE 3 — hire_from_listing_humanless
test("compat: pre-WP-A1 client that OMITS moderation_attestor fails CLOSED at hire_from_listing_humanless; legacy record + regenerated client works", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const human = (await import("@solana/web3.js")).Keypair.generate();
  w.svm.airdrop(human.publicKey, BigInt(100e9));
  const listingMod = await injectLegacyListingMod(w);

  const old = await buildHumanlessHireIx(w, human, listingMod);
  const oldRes = send(w.svm, truncateOldClient(old.ix), [human]);
  assert.ok(isFail(oldRes), "old truncated client MUST fail at humanless hire");
  assert.ok(isClosed(w.svm, old.task), "fail-closed: no task minted by the old client");

  w.svm.expireBlockhash();
  const fresh = await buildHumanlessHireIx(w, human, listingMod);
  assert.ok(!isFail(send(w.svm, fresh.ix, [human])), "regenerated client hires on the global-authority path");
  assert.equal(decode(w.svm, "Task", fresh.task).creator.toBase58(), human.publicKey.toBase58(), "task minted for the human");
});
