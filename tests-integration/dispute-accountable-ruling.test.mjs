// In-process litesvm integration tests for P6.4 accountable dispute rulings.
//
// Executes the COMPILED program (target/deploy/agenc_coordination.so) end-to-end and
// drives a full hired-task dispute to resolution through an ASSIGNED dispute resolver,
// asserting the two P6.4 surfaces:
//   (1) resolve_dispute now REQUIRES a reasoned ruling — `rationale_hash: [u8;32]` +
//       a bounded `rationale_uri` — and persists `rationale_hash`, `rationale_uri`,
//       and the deciding `resolved_by` pubkey on the (newly-appended) Dispute fields.
//   (2) the deciding resolver's case counters on the DisputeResolver roster PDA
//       (`resolved_count`, `last_resolved_at`) — carved from its former reserved bytes
//       — are bumped by exactly one resolution.
// and the negative guard:
//   (3) an over-length `rationale_uri` (> 256 bytes) reverts with RationaleUriTooLong
//       and leaves the dispute Active (no settlement, no counter bump).
//
// REVERT-SENSITIVE INTENT — each assertion pins a specific line added in
// programs/agenc-coordination/src/instructions/resolve_dispute.rs and src/state.rs:
//   - delete `dispute.rationale_hash = rationale_hash;` (or `.rationale_uri` /
//     `.resolved_by`) -> the corresponding decoded-field assertion goes red (stays
//     zero / empty / default pubkey).
//   - delete the `bump_resolver_case_counters(...)` call site (or its `checked_add`)
//     -> `resolved_count == 1` / `last_resolved_at == clock` goes red.
//   - delete the `validate_rationale_uri(&rationale_uri)?` guard -> the over-length
//     case stops reverting and (3)'s expectFail(RationaleUriTooLong) goes red, and the
//     follow-on "dispute still Active / counter still 0" assertions also go red.
//   - emit without `resolved_by` / `rationale_hash` -> not asserted here (events are
//     not decoded in this harness); the on-account fields above are the durable proof.
//
// NOTE: requires the rebuilt .so + regenerated IDL (the integrator runs anchor build +
// artifacts:refresh before this test). It references the to-be-regenerated Dispute /
// DisputeResolver account decoders and the resolve_dispute `rationaleHash`/`rationaleUri`
// positional args + `resolverAssignment` account by their Codama/anchor naming.
//
// Run:  cd agenc-protocol && node --test tests-integration/dispute-accountable-ruling.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Buffer } from "node:buffer";

import {
  enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode, isClosed,
  freshWorld, hireIx,
  BN, Keypair, PublicKey, SystemProgram,
} from "./harness.mjs";

// Roster PDA for a dispute resolver wallet ["dispute_resolver", resolver].
const resolverPda = (resolver) =>
  pda([enc("dispute_resolver"), resolver.toBuffer()]);

// Assign `resolver` to the dispute-resolver roster, signed by the protocol authority.
async function assignResolver(w, resolver) {
  const [entry] = resolverPda(resolver.publicKey);
  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .assignDisputeResolver(resolver.publicKey)
    .accounts({
      protocolConfig: w.protocolPda,
      disputeResolver: entry,
      authority: w.admin.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .instruction(), [w.admin]), "p64:assign_dispute_resolver");
  return entry;
}

// Read the DisputeResolver case counters (assumes the entry exists).
function readResolver(svm, entry) {
  const r = decode(svm, "DisputeResolver", entry);
  return {
    resolver: r.resolver,
    resolved_count: BigInt(r.resolved_count.toString()),
    overturned_count: BigInt(r.overturned_count.toString()),
    last_resolved_at: BigInt(r.last_resolved_at.toString()),
  };
}

// Drive a hired task to an Active dispute requesting `resolutionType`. The worker
// (provider) opens the dispute. Returns the handles needed to resolve it.
async function hireClaimDispute(w, { resolutionType }) {
  const modProg = makeProgram(w.modAuth);
  const [listingMod] = pda([enc("listing_moderation"), w.listing.toBuffer(), Buffer.from(w.specHash)]);
  if (isClosed(w.svm, listingMod)) {
    expectOk(send(w.svm, await modProg.methods
      .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
      .accounts({ moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
      .instruction(), [w.modAuth]), "p64:listing-mod");
  }
  const taskId = id32();
  const { ix: hix, task, escrow, hireRecord } = await hireIx(w, { taskId, listingModeration: listingMod });
  expectOk(send(w.svm, hix, [w.buyer]), "p64:hire");

  const jobHash = id32();
  const [taskMod] = pda([enc("task_moderation"), task.toBuffer(), Buffer.from(jobHash)]);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "p64:task-mod");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/p64")
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "p64:publish");
  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "p64:claim");

  const tid = decode(w.svm, "Task", task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [initRate] = pda([enc("authority_rate_limit"), w.provider.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .initiateDispute(arr(disputeId), arr(tid), arr(Buffer.alloc(32, 1)), resolutionType, "evidence")
    .accounts({ dispute, task, agent: w.providerAgent, authorityRateLimit: initRate, protocolConfig: w.protocolPda, initiatorClaim: claim, workerAgent: null, workerClaim: null, taskSubmission: null, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "p64:initiate");

  assert.ok(decode(w.svm, "Dispute", dispute).status.Active !== undefined, "dispute Active");
  return { task, escrow, hireRecord, claim, dispute };
}

// Build (but do not send) a resolve_dispute ix from `resolver` carrying the ruling args.
async function resolveIx(w, r, { resolver, resolverEntry, approve, rationaleHash, rationaleUri }) {
  const creatorBond = pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0];
  const workerBond = pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()])[0];
  return makeProgram(resolver).methods
    .resolveDispute(approve, arr(rationaleHash), rationaleUri)
    .accounts({
      dispute: r.dispute, task: r.task, escrow: r.escrow, protocolConfig: w.protocolPda,
      authority: resolver.publicKey, resolverAssignment: resolverEntry, creator: w.buyer.publicKey,
      workerClaim: r.claim, worker: w.providerAgent, workerWallet: w.provider.publicKey,
      agentStats: null,
      hireRecord: r.hireRecord, disputeOperator: null, systemProgram: SystemProgram.programId,
      tokenEscrowAta: null, creatorTokenAccount: null, workerTokenAccountAta: null,
      treasuryTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: creatorBond, workerCompletionBond: workerBond, bondTreasury: w.admin.publicKey,
    })
    .instruction();
}

// ---------------------------------------------------------------------------
// (1)+(2): an assigned resolver resolves with a rationale -> dispute records the
// rationale + resolver, and the resolver's case counters are bumped by one.
// ---------------------------------------------------------------------------
test("accountable ruling: resolve_dispute persists rationale + resolver and bumps the resolver's resolved_count", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 3_000_000 });

  // The protocol authority deputizes a dedicated resolver wallet.
  const resolver = Keypair.generate();
  w.svm.airdrop(resolver.publicKey, BigInt(100e9));
  const resolverEntry = await assignResolver(w, resolver);

  // Fresh roster counters before any ruling.
  const before = readResolver(w.svm, resolverEntry);
  assert.equal(before.resolver.toBase58(), resolver.publicKey.toBase58(), "roster keyed to the resolver");
  assert.equal(before.resolved_count, 0n, "resolved_count starts at 0");
  assert.equal(before.last_resolved_at, 0n, "last_resolved_at starts at 0");

  const r = await hireClaimDispute(w, { resolutionType: 0 }); // Refund

  const rationaleHash = crypto.randomBytes(32);
  const rationaleUri = "agenc://ruling/sha256/refund-justified";
  const clockNow = BigInt(w.svm.getClock().unixTimestamp.toString());

  expectOk(send(w.svm,
    await resolveIx(w, r, { resolver, resolverEntry, approve: true, rationaleHash, rationaleUri }),
    [resolver]), "p64:resolve with rationale by assigned resolver");

  // (1) The dispute records the reasoned ruling + the deciding resolver.
  const d = decode(w.svm, "Dispute", r.dispute);
  assert.ok(d.status.Resolved !== undefined, "dispute Resolved");
  assert.deepEqual(Buffer.from(d.rationale_hash), rationaleHash, "rationale_hash persisted on the dispute");
  assert.equal(d.rationale_uri, rationaleUri, "rationale_uri persisted on the dispute");
  assert.equal(d.resolved_by.toBase58(), resolver.publicKey.toBase58(), "resolved_by == the deciding resolver");

  // (2) The resolver's case counters moved by exactly one.
  const after = readResolver(w.svm, resolverEntry);
  assert.equal(after.resolved_count, 1n, "resolved_count == 1 after one ruling");
  assert.equal(after.overturned_count, 0n, "overturned_count untouched (challenge-window only)");
  assert.equal(after.last_resolved_at, clockNow, "last_resolved_at stamped to the resolution clock");
});

// ---------------------------------------------------------------------------
// (3): an over-length rationale_uri (> 256 bytes) reverts with RationaleUriTooLong;
// the dispute stays Active and the resolver counter is NOT bumped.
// ---------------------------------------------------------------------------
test("accountable ruling: an over-length rationale_uri reverts and leaves the dispute unresolved", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 3_000_000 });
  const resolver = Keypair.generate();
  w.svm.airdrop(resolver.publicKey, BigInt(100e9));
  const resolverEntry = await assignResolver(w, resolver);

  const r = await hireClaimDispute(w, { resolutionType: 0 });

  const rationaleHash = crypto.randomBytes(32);
  const tooLong = "a".repeat(257); // MAX_RATIONALE_URI_LEN is 256

  expectFail(send(w.svm,
    await resolveIx(w, r, { resolver, resolverEntry, approve: true, rationaleHash, rationaleUri: tooLong }),
    [resolver]), "RationaleUriTooLong", "p64:resolve with over-length URI must revert");

  // The whole tx reverted: no settlement, no counter bump.
  assert.ok(decode(w.svm, "Dispute", r.dispute).status.Active !== undefined, "dispute still Active after the rejected ruling");
  const after = readResolver(w.svm, resolverEntry);
  assert.equal(after.resolved_count, 0n, "resolved_count still 0 after the rejected ruling");
  assert.equal(after.last_resolved_at, 0n, "last_resolved_at unchanged after the rejected ruling");
});

// ---------------------------------------------------------------------------
// Back-compat: the protocol authority can still resolve directly (resolverAssignment
// = null), supplying the now-required rationale. No per-resolver counter exists to bump.
// ---------------------------------------------------------------------------
test("accountable ruling: protocol authority resolves directly with a rationale (no roster counter)", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 3_000_000 });
  const r = await hireClaimDispute(w, { resolutionType: 1 }); // Complete -> worker wins

  const rationaleHash = crypto.randomBytes(32);
  const rationaleUri = ""; // empty URI is allowed; the hash carries the rationale

  // admin == protocol authority; resolverAssignment null.
  const creatorBond = pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0];
  const workerBond = pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()])[0];
  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .resolveDispute(true, arr(rationaleHash), rationaleUri)
    .accounts({
      dispute: r.dispute, task: r.task, escrow: r.escrow, protocolConfig: w.protocolPda,
      authority: w.admin.publicKey, resolverAssignment: null, creator: w.buyer.publicKey,
      workerClaim: r.claim, worker: w.providerAgent, workerWallet: w.provider.publicKey,
      agentStats: null,
      hireRecord: r.hireRecord, disputeOperator: null, systemProgram: SystemProgram.programId,
      tokenEscrowAta: null, creatorTokenAccount: null, workerTokenAccountAta: null,
      treasuryTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: creatorBond, workerCompletionBond: workerBond, bondTreasury: w.admin.publicKey,
    })
    .instruction(), [w.admin]), "p64:resolve direct by protocol authority");

  const d = decode(w.svm, "Dispute", r.dispute);
  assert.ok(d.status.Resolved !== undefined, "dispute Resolved by the protocol authority");
  assert.deepEqual(Buffer.from(d.rationale_hash), rationaleHash, "rationale_hash persisted on the direct-authority path");
  assert.equal(d.rationale_uri, "", "empty rationale_uri persisted");
  assert.equal(d.resolved_by.toBase58(), w.admin.publicKey.toBase58(), "resolved_by == the protocol authority");
});
