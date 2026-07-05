// In-process litesvm integration tests for the embeddable-marketplace instructions.
// Executes the COMPILED program (target/deploy/agenc_coordination.so) end-to-end:
// hire_from_listing -> cancel_task -> close_task, plus capacity + negative cases.
//
// Setup uses the real register_agent + create_service_listing instructions; only
// ProtocolConfig is injected directly (its real initializer requires an upgradeable
// ProgramData account that litesvm doesn't model).
//
// Run:  cd tests-integration && node --test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import anchorPkg from "@coral-xyz/anchor";
const { Program, AnchorProvider, BN, Wallet, BorshCoder } = anchorPkg;
import { Connection, Keypair, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";


// Shared harness (constants + helpers) — see harness.mjs.
import {
  PID, coder, enc, arr, pda, id32,
  makeProgram, send, sendMany, tokenAmount, expectOk, expectFail, decode, isClosed,
  injectProtocolConfig, setProtocolPaused, injectAgentStake,
  setMultisig, injectModerationConfig, injectBidMarketplace, freshWorld, hireIx,
  taskModV2Pda, listingModV2Pda, moderationBlockPda,
} from "./harness.mjs";
test("hire_from_listing: mints task + escrow + hire record, increments capacity", async () => {
  const w = await freshWorld({ price: 2_000_000 });
  const { ix, task, escrow, hireRecord } = await hireIx(w, {});
  expectOk(send(w.svm, ix, [w.buyer]), "hire");

  const t = decode(w.svm, "Task", task);
  assert.equal(t.creator.toBase58(), w.buyer.publicKey.toBase58(), "task.creator == buyer");
  assert.equal(t.reward_amount.toString(), "2000000", "reward snapshotted from listing price");
  assert.equal(t.max_workers, 1, "one-shot exclusive");
  assert.ok(t.status.Open !== undefined, "task starts Open");
  assert.equal(t.escrow.toBase58(), escrow.toBase58(), "task.escrow wired");

  const e = decode(w.svm, "TaskEscrow", escrow);
  assert.equal(e.amount.toString(), "2000000", "escrow.amount == price");
  assert.equal(e.is_closed, false);
  assert.ok(w.svm.getBalance(escrow) >= 2_000_000n, "escrow funded with >= price lamports");

  const h = decode(w.svm, "HireRecord", hireRecord);
  assert.equal(h.task.toBase58(), task.toBase58());
  assert.equal(h.listing.toBase58(), w.listing.toBase58());

  const l = decode(w.svm, "ServiceListing", w.listing);
  assert.equal(l.open_jobs, 1, "open_jobs incremented");
  assert.equal(l.total_hires.toString(), "1", "total_hires incremented");
});

test("hire -> cancel -> close: frees capacity, closes task + hire record", async () => {
  const w = await freshWorld({ price: 1_500_000 });
  const { ix, task, escrow, hireRecord } = await hireIx(w, {});
  expectOk(send(w.svm, ix, [w.buyer]), "hire");
  assert.equal(decode(w.svm, "ServiceListing", w.listing).open_jobs, 1);

  // Cancel the Open task (allowed immediately for Open).
  const cancelIx = await w.buyerProg.methods
    .cancelTask()
    .accounts({
      task, escrow, authority: w.buyer.publicKey, protocolConfig: w.protocolPda,
      systemProgram: SystemProgram.programId,
      // optional SPL-token accounts (default build has spl-token-rewards) — None for SOL
      tokenEscrowAta: null, creatorTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: null, workerCompletionBond: null, workerBondAuthority: null,
      // P6.6 optional track-record accounts; omitted (no creator-agent attribution).
      creatorAgent: null, agentStats: null,
    })
    .instruction();
  expectOk(send(w.svm, cancelIx, [w.buyer]), "cancel");
  assert.ok(decode(w.svm, "Task", task).status.Cancelled !== undefined, "task is Cancelled");
  assert.ok(isClosed(w.svm, escrow), "escrow closed by cancel_task");

  // Close the terminal task: reclaim rent + free the listing slot.
  const closeIx = await w.buyerProg.methods
    .closeTask()
    .accounts({ task, taskJobSpec: null, escrow: null, hireRecord, listing: w.listing, creatorCompletionBond: pda([enc("completion_bond"), task.toBuffer(), w.buyer.publicKey.toBuffer()])[0], workerCompletionBond: null, authority: w.buyer.publicKey })
    .instruction();
  expectOk(send(w.svm, closeIx, [w.buyer]), "close");

  assert.ok(isClosed(w.svm, task), "task PDA closed");
  assert.ok(isClosed(w.svm, hireRecord), "hire record closed");
  assert.equal(decode(w.svm, "ServiceListing", w.listing).open_jobs, 0, "open_jobs decremented back to 0");
});

test("capacity: hire is rejected when max_open_jobs is reached", async () => {
  const w = await freshWorld({ maxOpenJobs: 1 });
  const first = await hireIx(w, {});
  expectOk(send(w.svm, first.ix, [w.buyer]), "first hire");
  assert.equal(decode(w.svm, "ServiceListing", w.listing).open_jobs, 1);

  const second = await hireIx(w, {}); // different task id
  expectFail(send(w.svm, second.ix, [w.buyer]), "ListingCapacityReached", "second hire over capacity");
});

test("negative: self-hire, price mismatch, and version mismatch are rejected", async () => {
  const w = await freshWorld({ price: 1_000_000 });

  // self-hire: provider hires its own listing (buyer authority == provider authority)
  const self = await hireIx(w, { asProvider: true });
  expectFail(send(w.svm, self.ix, [w.provider]), "SelfTaskNotAllowed", "self-hire");

  // price mismatch (compare-and-swap)
  const badPrice = await hireIx(w, { expectedPrice: 999_999 });
  expectFail(send(w.svm, badPrice.ix, [w.buyer]), "ListingPriceMismatch", "price mismatch");

  // version mismatch (compare-and-swap)
  const badVer = await hireIx(w, { expectedVersion: 2 });
  expectFail(send(w.svm, badVer.ix, [w.buyer]), "ListingVersionMismatch", "version mismatch");
});

test("record_listing_moderation: authority records CLEAN; non-authority rejected", async () => {
  const w = await freshWorld({});
  const modAuth = Keypair.generate();
  w.svm.airdrop(modAuth.publicKey, BigInt(10e9));

  // Inject an enabled ModerationConfig whose authority is modAuth.
  const [modCfg, modBump] = pda([enc("moderation_config")]);
  const cfg = {
    authority: w.admin.publicKey,
    moderation_authority: modAuth.publicKey,
    enabled: true,
    created_at: new BN(0),
    updated_at: new BN(0),
    bump: modBump,
    _reserved: Array(6).fill(0),
  };
  const data = await coder.accounts.encode("ModerationConfig", cfg);
  w.svm.setAccount(modCfg, {
    lamports: Number(w.svm.minimumBalanceForRentExemption(BigInt(data.length))),
    data,
    owner: PID,
    executable: false,
    rentEpoch: 0,
  });

  // P1.2: v2 records are moderator-keyed — derive the PDA from the recording signer.
  const recordArgs = (prog, who) =>
    prog.methods
      .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
      .accounts({ moderationConfig: modCfg, listing: w.listing, listingModeration: listingModV2Pda(w.listing, w.specHash, who)[0], moderator: who, moderationAttestor: null, systemProgram: SystemProgram.programId })
      .instruction();

  // Authority records a CLEAN attestation.
  const modProg = makeProgram(modAuth);
  expectOk(send(w.svm, await recordArgs(modProg, modAuth.publicKey), [modAuth]), "record listing moderation");

  const lm = decode(w.svm, "ListingModeration", listingModV2Pda(w.listing, w.specHash, modAuth.publicKey)[0]);
  assert.equal(lm.listing.toBase58(), w.listing.toBase58());
  assert.equal(lm.status, 0, "status CLEAN");
  assert.equal(
    Buffer.from(lm.job_spec_hash).toString("hex"),
    Buffer.from(w.specHash).toString("hex"),
    "job_spec_hash matches the listing's pinned spec",
  );
  assert.equal(lm.moderator.toBase58(), modAuth.publicKey.toBase58());

  // A non-authority (the buyer) cannot record. P6.8 widened the authorization check to
  // the global authority OR a registered attestor, so the rejection is now
  // UnauthorizedModerationAttestor ("neither the moderation authority nor a registered
  // attestor") rather than the old UnauthorizedTaskModerator.
  expectFail(
    send(w.svm, await recordArgs(w.buyerProg, w.buyer.publicKey), [w.buyer]),
    "UnauthorizedModerationAttestor",
    "non-authority record",
  );
});

test("hire moderation gate: enabled requires a publishable listing attestation", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const [listingMod] = listingModV2Pda(w.listing, w.specHash, w.modAuth.publicKey);
  const record = async (status, risk, expiresAt) => {
    const modProg = makeProgram(w.modAuth);
    return send(
      w.svm,
      await modProg.methods
        .recordListingModeration(arr(w.specHash), status, risk, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(expiresAt))
        .accounts({ moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
        .instruction(),
      [w.modAuth],
    );
  };

  // enabled + no attestation supplied → fail-closed
  expectFail(send(w.svm, (await hireIx(w, {})).ix, [w.buyer]), "TaskModerationRequired", "hire with no attestation");

  // record a CLEAN attestation → hire succeeds and occupies a slot
  expectOk(await record(0, 0, 0), "record CLEAN");
  expectOk(send(w.svm, (await hireIx(w, { listingModeration: listingMod })).ix, [w.buyer]), "hire with CLEAN attestation");
  assert.equal(decode(w.svm, "ServiceListing", w.listing).open_jobs, 1);
});

test("hire moderation gate: a BLOCKED attestation is rejected", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const [listingMod] = listingModV2Pda(w.listing, w.specHash, w.modAuth.publicKey);
  const modProg = makeProgram(w.modAuth);
  expectOk(
    send(
      w.svm,
      await modProg.methods
        .recordListingModeration(arr(w.specHash), 2 /* BLOCKED */, 80, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
        .accounts({ moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
        .instruction(),
      [w.modAuth],
    ),
    "record BLOCKED",
  );
  expectFail(send(w.svm, (await hireIx(w, { listingModeration: listingMod })).ix, [w.buyer]), "TaskModerationRejected", "hire with BLOCKED attestation");
});

// Record a listing-moderation attestation with explicit fields, returning the result.
async function recordListingMod(w, { status = 0, risk = 0, expiresAt = 0 } = {}) {
  const [listingMod] = listingModV2Pda(w.listing, w.specHash, w.modAuth.publicKey);
  const res = send(w.svm, await makeProgram(w.modAuth).methods
    .recordListingModeration(arr(w.specHash), status, risk, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(expiresAt))
    .accounts({ moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]);
  return { res, listingMod };
}

test("moderation edges (hire): publishable set is exactly CLEAN + HUMAN_APPROVED", async () => {
  // status -> whether a hire against that attestation is allowed.
  const cases = [
    { status: 1, name: "SUSPICIOUS", ok: false },
    { status: 3, name: "SCANNER_UNAVAILABLE", ok: false },
    { status: 5, name: "HUMAN_REJECTED", ok: false },
    { status: 4, name: "HUMAN_APPROVED", ok: true },
  ];
  for (const c of cases) {
    const w = await freshWorld({ moderationEnabled: true });
    const { res, listingMod } = await recordListingMod(w, { status: c.status });
    expectOk(res, `record ${c.name}`);
    const hire = send(w.svm, (await hireIx(w, { listingModeration: listingMod })).ix, [w.buyer]);
    if (c.ok) expectOk(hire, `hire with ${c.name} (publishable)`);
    else expectFail(hire, "TaskModerationRejected", `hire with ${c.name} (not publishable)`);
  }
});

test("moderation edges (hire): risk-score cap is enforced at the boundary", async () => {
  // risk_score 100 is the max allowed (CLEAN); 101 is rejected at record time.
  const wOk = await freshWorld({ moderationEnabled: true });
  const ok = await recordListingMod(wOk, { status: 0, risk: 100 });
  expectOk(ok.res, "record CLEAN risk=100");
  expectOk(send(wOk.svm, (await hireIx(wOk, { listingModeration: ok.listingMod })).ix, [wOk.buyer]), "hire with risk=100");

  const wBad = await freshWorld({ moderationEnabled: true });
  expectFail((await recordListingMod(wBad, { status: 0, risk: 101 })).res, "InvalidTaskModerationRiskScore", "record risk=101");
});

test("moderation edges (record): disabled config, invalid status, and past expiry are rejected", async () => {
  // moderation disabled -> recording is rejected (fail-closed semantics).
  const wOff = await freshWorld({ moderationEnabled: false });
  expectFail((await recordListingMod(wOff, { status: 0 })).res, "TaskModerationRequired", "record while moderation disabled");

  // invalid status code (not 0..5) -> rejected.
  const wStatus = await freshWorld({ moderationEnabled: true });
  expectFail((await recordListingMod(wStatus, { status: 6 })).res, "InvalidTaskModerationStatus", "record invalid status=6");

  // already-expired attestation (expires_at in the past) -> rejected at record time.
  const wExp = await freshWorld({ moderationEnabled: true });
  const past = Number(wExp.svm.getClock().unixTimestamp) - 100;
  expectFail((await recordListingMod(wExp, { status: 0, expiresAt: past })).res, "TaskModerationExpired", "record past-expiry attestation");
});

test("moderation edges (set_task_job_spec): a non-publishable task moderation cannot be published", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const m = await setupManualTask(w, { mode: 1 }); // a plain Open task to publish against
  const jobHash = id32();
  const [taskMod] = taskModV2Pda(m.task, jobHash, w.modAuth.publicKey);
  const [jobSpec] = pda([enc("task_job_spec"), m.task.toBuffer()]);
  // record a BLOCKED task moderation, then try to publish the job spec.
  expectOk(send(w.svm, await makeProgram(w.modAuth).methods
    .recordTaskModeration(arr(jobHash), 2 /* BLOCKED */, 90, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task: m.task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "record BLOCKED task moderation");
  expectFail(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/blocked", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task: m.task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "TaskModerationRejected", "publish against BLOCKED moderation");
  assert.ok(isClosed(w.svm, jobSpec), "no TaskJobSpec created when the gate fails");
});

/// Drive a task through the Auto settlement path (worker completes + is paid via
/// execute_completion_rewards — where bonds + the 3-way split live). Requires a
/// moderation-enabled world (set_task_job_spec is moderation-gated). The freshWorld
/// buyer (agent) is the creator; the provider agent is the worker. Returns handles.
async function runAutoSettlement(w, { pauseBeforeComplete = false } = {}) {
  const taskId = id32();
  const jobHash = id32();
  const reward = 5_000_000;
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  const modProg = makeProgram(w.modAuth);

  // 1) create_task (buyer + buyerAgent), Auto mode (constraint_hash = None)
  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(reward), 1, new BN(now + 3600), 0, null, 0, null, null, 0)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "settle:create_task");

  // 2) moderator records CLEAN for (task, jobHash)
  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "settle:moderate");

  // 3) creator publishes the job spec (moderation-gated)
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/x", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "settle:publish");

  // 4) worker (provider agent) claims the published task
  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "settle:claim");

  // Optionally pause the protocol AFTER the claim. Entry paths are now blocked,
  // but settlement must still succeed (exit allow-list, spec §7) so the worker
  // is paid for completed work rather than losing it to a later expiry.
  if (pauseBeforeComplete) await setProtocolPaused(w.svm, true);

  // 5) worker completes -> payout via execute_completion_rewards. hire_record is a
  //    REQUIRED account; an Auto (non-hired) task passes the empty ["hire", task] PDA.
  const [autoHire] = pda([enc("hire"), task.toBuffer()]);
  const workerBalBefore = Number(w.svm.getBalance(w.provider.publicKey));
  const treasuryBalBefore = Number(w.svm.getBalance(w.admin.publicKey));
  expectOk(send(w.svm, await w.providerProg.methods
    .completeTask(arr(id32()), null)
    .accounts({ task, claim, escrow, creator: w.buyer.publicKey, worker: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.provider.publicKey, systemProgram: SystemProgram.programId, tokenEscrowAta: null, workerTokenAccount: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, hireRecord: autoHire, operator: null, referrer: null, creatorCompletionBond: null, workerCompletionBond: null })
    .instruction(), [w.provider]), "settle:complete");

  return { task, escrow, claim, jobSpec, taskMod, workerAuthority: w.provider.publicKey, workerBalBefore, treasuryBalBefore, reward };
}

test("FULL SETTLEMENT (Auto): create -> moderate -> publish -> claim -> complete pays the worker", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await runAutoSettlement(w);

  const t = decode(w.svm, "Task", r.task);
  assert.ok(t.status.Completed !== undefined, `task should be Completed (got ${JSON.stringify(t.status)})`);

  const workerAfter = Number(w.svm.getBalance(r.workerAuthority));
  const treasuryAfter = Number(w.svm.getBalance(w.admin.publicKey));
  assert.ok(workerAfter > r.workerBalBefore, "worker received the reward");
  assert.ok(treasuryAfter >= r.treasuryBalBefore, "treasury received the protocol fee");
  assert.ok(isClosed(w.svm, r.escrow), "escrow closed on completion");
});

/// Drive a HIRED task through full settlement so the HireRecord (operator payee +
/// fee) exists at complete_task time — exercising the §4 3-way split. Mirrors
/// runAutoSettlement but mints the task via hire_from_listing instead of create_task.
/// Requires a moderation-enabled world. Returns balance snapshots + reward.
async function runHireSettlement(w, { pauseBeforeComplete = false, stopBeforeComplete = false } = {}) {
  const modProg = makeProgram(w.modAuth);

  // 0) record a CLEAN ListingModeration so the hire passes the moderation gate.
  // Idempotent: the listing/spec-keyed PDA is shared, so a second call in the same
  // world reuses the existing attestation rather than re-initializing it.
  const [listingMod] = listingModV2Pda(w.listing, w.specHash, w.modAuth.publicKey);
  if (isClosed(w.svm, listingMod)) {
    expectOk(send(w.svm, await modProg.methods
      .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
      .accounts({ moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
      .instruction(), [w.modAuth]), "hire-settle:record-listing-mod");
  }

  // 1) buyer hires the provider's listing -> Open task + escrow + HireRecord.
  const taskId = id32();
  const { ix: hix, task, escrow, hireRecord } = await hireIx(w, { taskId, listingModeration: listingMod });
  expectOk(send(w.svm, hix, [w.buyer]), "hire-settle:hire");

  // 2) task moderation -> publish job spec -> worker claims.
  const jobHash = id32();
  const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);

  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "hire-settle:task-mod");

  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/x", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "hire-settle:publish");

  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "hire-settle:claim");

  // Stop here so callers can drive complete_task themselves (e.g. negative operator tests).
  if (stopBeforeComplete) return { task, escrow, claim, hireRecord, taskMod, jobSpec, reward: w.price };

  if (pauseBeforeComplete) await setProtocolPaused(w.svm, true);

  const workerBalBefore = Number(w.svm.getBalance(w.provider.publicKey));
  const treasuryBalBefore = Number(w.svm.getBalance(w.admin.publicKey));
  const operatorBalBefore = w.operator ? Number(w.svm.getBalance(w.operator)) : 0;

  // 3) worker completes — passes the HireRecord + operator payee so the 3-way
  //    split fires. operator may be null when the listing has no operator fee.
  expectOk(send(w.svm, await w.providerProg.methods
    .completeTask(arr(id32()), null)
    .accounts({ task, claim, escrow, creator: w.buyer.publicKey, worker: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.provider.publicKey, systemProgram: SystemProgram.programId, tokenEscrowAta: null, workerTokenAccount: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, hireRecord, operator: w.operator, referrer: null, creatorCompletionBond: null, workerCompletionBond: null })
    .instruction(), [w.provider]), "hire-settle:complete");

  return { task, escrow, claim, hireRecord, taskMod, jobSpec, workerBalBefore, treasuryBalBefore, operatorBalBefore, reward: w.price };
}

test("operator-fee protection: a hired task cannot be completed without paying the operator", async () => {
  // Regression for the audit finding: hire_record is now a REQUIRED account, and a
  // worker cannot omit/forge the operator to pocket the operator's cut.
  const operatorKp = Keypair.generate();
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000, operator: operatorKp.publicKey, operatorFeeBps: 1000 });
  const r = await runHireSettlement(w, { stopBeforeComplete: true });

  const completeAccounts = (operator) => ({
    task: r.task, claim: r.claim, escrow: r.escrow, creator: w.buyer.publicKey, worker: w.providerAgent,
    protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.provider.publicKey,
    systemProgram: SystemProgram.programId, tokenEscrowAta: null, workerTokenAccount: null,
    treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, hireRecord: r.hireRecord, operator,
    referrer: null, creatorCompletionBond: null, workerCompletionBond: null,
  });

  // (a) omit the operator account on a hired task with a fee -> MissingOperatorAccount
  expectFail(
    send(w.svm, await w.providerProg.methods.completeTask(arr(id32()), null).accounts(completeAccounts(null)).instruction(), [w.provider]),
    "MissingOperatorAccount", "complete hired task with operator omitted",
  );
  // (b) pass a WRONG operator -> InvalidOperatorAccount
  expectFail(
    send(w.svm, await w.providerProg.methods.completeTask(arr(id32()), null).accounts(completeAccounts(Keypair.generate().publicKey)).instruction(), [w.provider]),
    "InvalidOperatorAccount", "complete hired task with mismatched operator",
  );
  // Both reverted: the task is still InProgress and the operator was never bypassed.
  assert.ok(decode(w.svm, "Task", r.task).status.InProgress !== undefined, "task remains InProgress after rejected completes");

  // (c) the correct operator settles successfully and is paid its exact cut.
  expectOk(
    send(w.svm, await w.providerProg.methods.completeTask(arr(id32()), null).accounts(completeAccounts(operatorKp.publicKey)).instruction(), [w.provider]),
    "complete with correct operator",
  );
  assert.equal(Number(w.svm.getBalance(operatorKp.publicKey)) - 1e9, Math.floor((r.reward * 1000) / 10000), "operator paid its exact cut once the correct account is passed");
});

test("operator-fee guard: a listing whose operator is the hiring creator is rejected (no self-deal)", async () => {
  // Batch 2 §4: the operator (embedding site) must not be the task creator, or a
  // creator could pay themselves the operator leg. The listing operator == buyer,
  // and the buyer hires -> creator == operator -> OperatorIsCreator.
  const w = await freshWorld({ price: 2_000_000, operator: "__buyer__", operatorFeeBps: 1000 });
  const { ix } = await hireIx(w, {});
  expectFail(send(w.svm, ix, [w.buyer]), "OperatorIsCreator", "hire rejected when operator == creator");
});

test("migrate_task: reallocs a legacy 382B Task to 466B (multisig-gated, dry-run-safe, idempotent, rent topped up)", async () => {
  const w = await freshWorld({ price: 2_000_000 });
  // A new hire inits the Task at the current P6.2 size (466B): the Batch-2 operator
  // tail (50B) plus the P6.2 referrer tail (34B) over the 382B pre-Batch-2 prefix.
  const { ix, task } = await hireIx(w, {});
  expectOk(send(w.svm, ix, [w.buyer]), "hire");
  const full = w.svm.getAccount(task);
  assert.equal(full.data.length, 466, "new tasks are created at the P6.2 size");

  // Simulate a deep pre-Batch-2 legacy account: drop the trailing 84 zero bytes
  // (operator/fee/_reserved + referrer/referrer_fee_bps — all zero for a plain task)
  // back to 382B, and fund it at only the 382-byte rent so the migration must top up.
  const legacy = Buffer.from(full.data).subarray(0, 382);
  const rent382 = Number(w.svm.minimumBalanceForRentExemption(382n));
  const rent466 = Number(w.svm.minimumBalanceForRentExemption(466n));
  w.svm.setAccount(task, { lamports: rent382, data: legacy, owner: PID, executable: false, rentEpoch: 0 });

  // 2-of-2 multisig gate.
  const owner2 = Keypair.generate();
  w.svm.airdrop(owner2.publicKey, BigInt(10e9));
  await setMultisig(w.svm, [w.admin.publicKey, owner2.publicKey], 2);
  const signerMetas = [
    { pubkey: w.admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: owner2.publicKey, isSigner: true, isWritable: false },
  ];
  const buildMigrate = async (dryRun) =>
    makeProgram(w.admin).methods
      .migrateTask(dryRun)
      .accounts({ protocolConfig: w.protocolPda, task, payer: w.admin.publicKey, authority: w.admin.publicKey, systemProgram: SystemProgram.programId })
      .remainingAccounts(signerMetas)
      .instruction();

  // a single signer cannot pass the 2-of-2 gate.
  expectFail(send(w.svm, await makeProgram(w.admin).methods
    .migrateTask(false)
    .accounts({ protocolConfig: w.protocolPda, task, payer: w.admin.publicKey, authority: w.admin.publicKey, systemProgram: SystemProgram.programId })
    .remainingAccounts([{ pubkey: w.admin.publicKey, isSigner: true, isWritable: false }])
    .instruction(), [w.admin]), "MultisigNotEnoughSigners", "single signer rejected");

  // dry-run validates but does NOT mutate.
  expectOk(send(w.svm, await buildMigrate(true), [w.admin, owner2]), "migrate dry-run");
  assert.equal(w.svm.getAccount(task).data.length, 382, "dry-run left the account at the legacy size");

  // real migration: 382 -> 466, rent topped up, decodes with zero-filled operator AND
  // referrer tails.
  expectOk(send(w.svm, await buildMigrate(false), [w.admin, owner2]), "migrate real");
  const migrated = w.svm.getAccount(task);
  assert.equal(migrated.data.length, 466, "task reallocated to the P6.2 size");
  assert.ok(Number(migrated.lamports) >= rent466, `rent topped up to >= ${rent466} (got ${migrated.lamports})`);
  const t = decode(w.svm, "Task", task);
  assert.equal(t.operator.toBase58(), PublicKey.default.toBase58(), "operator zero-filled by migration");
  assert.equal(t.operator_fee_bps, 0, "operator_fee_bps zero-filled by migration");
  assert.equal(t.referrer.toBase58(), PublicKey.default.toBase58(), "referrer zero-filled by migration");
  assert.equal(t.referrer_fee_bps, 0, "referrer_fee_bps zero-filled by migration");
  assert.equal(t.status.Open !== undefined, true, "pre-migration status preserved (Open)");

  // idempotent: a second run on the now-466B account is a no-op Ok. Expire the
  // blockhash first so this isn't a byte-identical (deduped) repeat of the real run.
  w.svm.expireBlockhash();
  expectOk(send(w.svm, await buildMigrate(false), [w.admin, owner2]), "migrate idempotent re-run");
  assert.equal(w.svm.getAccount(task).data.length, 466, "still 466 after idempotent re-run");
});

test("migrate_task: succeeds against a PRE-migration 349B ProtocolConfig (order-independent vs migrate_protocol)", async () => {
  // Finding 1 regression: migrate_task must NOT be hard-coupled to migrate_protocol
  // having already grown the ProtocolConfig (349B -> 351B). The natural sweep order is
  // "migrate the 149 tasks, THEN the config"; that must work. With the OLD typed
  // `Account<ProtocolConfig>` on MigrateTask, account resolution borsh-deserializes the
  // 349B live config into the now-351B struct and fails with AccountDidNotDeserialize —
  // so EVERY migrate_task bricked until the config was grown first. The fix hand-decodes
  // a RAW (UncheckedAccount) config size-tolerantly, so the two migrations are
  // order-independent.
  const w = await freshWorld({ price: 2_000_000 });
  const [protocolPda] = pda([enc("protocol")]);

  // A new hire inits the Task at the P6.2 size (466B); truncate it to the 382B legacy
  // pre-Batch-2 layout so migrate_task has real work to do.
  const { ix, task } = await hireIx(w, {});
  expectOk(send(w.svm, ix, [w.buyer]), "hire");
  assert.equal(w.svm.getAccount(task).data.length, 466, "new task at P6.2 size");
  const legacyTask = Buffer.from(w.svm.getAccount(task).data).subarray(0, 382);
  const rentTask382 = Number(w.svm.minimumBalanceForRentExemption(382n));
  const rentTask466 = Number(w.svm.minimumBalanceForRentExemption(466n));
  w.svm.setAccount(task, { lamports: rentTask382, data: legacyTask, owner: PID, executable: false, rentEpoch: 0 });

  // Arm the 2-of-2 multisig on the FULL-size (351B) config FIRST (setMultisig
  // decodes/re-encodes via the BorshCoder, which needs the surface_revision tail), THEN
  // truncate the config down to the pre-migration 349B layout (drop the 2-byte
  // surface_revision) and fund it at only the 349-byte rent.
  const owner2 = Keypair.generate();
  w.svm.airdrop(owner2.publicKey, BigInt(10e9));
  await setMultisig(w.svm, [w.admin.publicKey, owner2.publicKey], 2);
  assert.equal(w.svm.getAccount(protocolPda).data.length, 351, "config is the migrated 351B layout before truncation");
  const legacyConfig = Buffer.from(w.svm.getAccount(protocolPda).data).subarray(0, 349);
  const rentCfg349 = Number(w.svm.minimumBalanceForRentExemption(349n));
  w.svm.setAccount(protocolPda, { lamports: rentCfg349, data: legacyConfig, owner: PID, executable: false, rentEpoch: 0 });
  assert.equal(w.svm.getAccount(protocolPda).data.length, 349, "config truncated to the PRE-migration 349B layout");

  const signerMetas = [
    { pubkey: w.admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: owner2.publicKey, isSigner: true, isWritable: false },
  ];
  const migrateIx = await makeProgram(w.admin).methods
    .migrateTask(false)
    .accounts({ protocolConfig: protocolPda, task, payer: w.admin.publicKey, authority: w.admin.publicKey, systemProgram: SystemProgram.programId })
    .remainingAccounts(signerMetas)
    .instruction();

  // The migrate_task against the 349B (pre-migrate_protocol) config must SUCCEED and
  // realloc the task to 466B. Against the OLD typed-Account code this fails at account
  // resolution with AccountDidNotDeserialize ("Unexpected length of input").
  expectOk(send(w.svm, migrateIx, [w.admin, owner2]), "migrate_task vs 349B config");
  const migrated = w.svm.getAccount(task);
  assert.equal(migrated.data.length, 466, "task reallocated to the P6.2 size against the OLD config");
  assert.ok(Number(migrated.lamports) >= rentTask466, `task rent topped up (got ${migrated.lamports})`);
  // The config itself is untouched by migrate_task — it stays at the pre-migration size.
  assert.equal(w.svm.getAccount(protocolPda).data.length, 349, "config left at 349B (migrate_task does not grow the config)");
  const t = decode(w.svm, "Task", task);
  assert.equal(t.referrer.toBase58(), PublicKey.default.toBase58(), "referrer zero-filled by migration");
  assert.equal(t.referrer_fee_bps, 0, "referrer_fee_bps zero-filled by migration");
});

test("completion bond: creator + worker each post a 25% bond into distinct PDAs (dup + self-deal rejected)", async () => {
  const w = await freshWorld({ price: 2_000_000 });
  const { ix, task } = await hireIx(w, {});
  expectOk(send(w.svm, ix, [w.buyer]), "hire"); // Open Exclusive task, creator == buyer

  const bondPda = (party) => pda([enc("completion_bond"), task.toBuffer(), party.toBuffer()])[0];
  const post = async (signer, role) =>
    send(w.svm, await makeProgram(signer).methods
      .postCompletionBond(role)
      .accounts({ task, completionBond: bondPda(signer.publicKey), authority: signer.publicKey, systemProgram: SystemProgram.programId })
      .instruction(), [signer]);

  // creator bond (role 0) posted by the buyer (== task.creator)
  expectOk(await post(w.buyer, 0), "creator posts 25% bond");
  const cb = decode(w.svm, "CompletionBond", bondPda(w.buyer.publicKey));
  assert.equal(cb.role, 0, "creator bond role");
  assert.equal(cb.party.toBase58(), w.buyer.publicKey.toBase58(), "creator bond party == buyer");
  assert.equal(Number(cb.amount), 500_000, "bond is 25% of the 2,000,000 reward");
  assert.equal(cb.bond_mint, null, "SOL bond (no mint) in v1");

  // worker bond (role 1) posted by the provider (a non-creator wallet)
  expectOk(await post(w.provider, 1), "worker posts 25% bond");
  assert.equal(decode(w.svm, "CompletionBond", bondPda(w.provider.publicKey)).role, 1, "worker bond role");

  // dup: posting again on the same (task, party) PDA fails at init (account already
  // exists — a tx-level create_account error, so assert failure without a log match).
  assert.ok(
    (await post(w.buyer, 0)) instanceof FailedTransactionMetadata,
    "duplicate creator bond rejected by init",
  );

  // self-deal: a non-creator posting the CREATOR role is rejected.
  const stranger = Keypair.generate();
  w.svm.airdrop(stranger.publicKey, BigInt(10e9));
  expectFail(await post(stranger, 0), "BondPartyMismatch", "non-creator cannot post the creator bond");
});

test("completion bond: a no-show worker forfeits their bond to the creator on expire_claim", async () => {
  // The load-bearing case: the claim closes to the worker (auto-refunding claim rent),
  // but the bond lives in its own PDA, so a no-show worker does NOT get the bond back —
  // it is forfeited to the creator. Revert-sensitive: drop the forfeit and the creator
  // delta below goes to 0.
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000 });
  const r = await runHireSettlement(w, { stopBeforeComplete: true }); // claimed, InProgress

  // worker posts a 25% completion bond (1,000,000).
  const [workerBond] = pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .postCompletionBond(1)
    .accounts({ task: r.task, completionBond: workerBond, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "worker posts bond");
  assert.equal(Number(decode(w.svm, "CompletionBond", workerBond).amount), 1_000_000, "bond is 25% of reward");

  // warp well past claim expiry + grace so a third party can expire it.
  const clk = w.svm.getClock();
  clk.unixTimestamp = clk.unixTimestamp + 700_000n;
  w.svm.setClock(clk);

  // a neutral caller expires the claim (so the creator's delta is purely the forfeit).
  const cleaner = Keypair.generate();
  w.svm.airdrop(cleaner.publicKey, BigInt(10e9));
  const buyerBefore = Number(w.svm.getBalance(w.buyer.publicKey));

  expectOk(send(w.svm, await makeProgram(cleaner).methods
    .expireClaim()
    .accounts({
      authority: cleaner.publicKey, task: r.task, escrow: r.escrow, claim: r.claim,
      worker: w.providerAgent, protocolConfig: w.protocolPda, taskValidationConfig: null,
      taskSubmission: null, rentRecipient: w.provider.publicKey,
      workerCompletionBond: workerBond, bondCreator: w.buyer.publicKey,
      systemProgram: SystemProgram.programId, agentStats: null,
    })
    .instruction(), [cleaner]), "expire_claim with no-show bond forfeit");

  assert.ok(isClosed(w.svm, workerBond), "worker bond PDA closed after forfeit");
  const buyerDelta = Number(w.svm.getBalance(w.buyer.publicKey)) - buyerBefore;
  assert.equal(buyerDelta, 1_000_000, `creator received the forfeited bond principal (got ${buyerDelta})`);
});

test("completion bond (#70): cancelling a task REOPENED after a reject refunds the worker bond (not forfeit to creator)", async () => {
  // #70 theft: a worker posts a bond, claims, submits, and the creator rejects — which
  // reopens the task to Open WITHOUT settling the worker's bond. Pre-fix, cancel_task
  // forfeited any supplied worker bond to the creator regardless of status, so the creator
  // could then cancel the (Open) task and SEIZE an honest worker's bond. The fix forfeits
  // only on a genuine no-show (InProgress past deadline); an Open cancel refunds the worker.
  // Revert-sensitive: drop the is_no_show_cancel gate in cancel_task and the worker delta
  // below goes to 0 (the bond is forfeited to the creator instead).
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000 });
  const m = await runManualSettlement(w, { decision: "reject", postBonds: true });

  assert.ok(decode(w.svm, "Task", m.task).status.Open !== undefined, "task reopened to Open after reject");
  assert.ok(!isClosed(w.svm, m.workerBond), "worker bond still live after reject");

  const workerBefore = Number(w.svm.getBalance(w.provider.publicKey));
  // Full live balance of the worker bond PDA (principal + rent). A Refund returns ALL of
  // it to the worker; a Forfeit would send the 1,000,000 principal to the creator and only
  // the rent back to the worker — so the worker delta cleanly distinguishes the two.
  const workerBondBal = Number(w.svm.getBalance(m.workerBond));
  assert.ok(workerBondBal > 1_000_000, "worker bond holds principal + rent before cancel");
  expectOk(send(w.svm, await w.buyerProg.methods.cancelTask()
    .accounts({ task: m.task, escrow: m.escrow, authority: w.buyer.publicKey, protocolConfig: w.protocolPda, systemProgram: SystemProgram.programId,
      tokenEscrowAta: null, creatorTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: m.creatorBond, workerCompletionBond: m.workerBond, workerBondAuthority: w.provider.publicKey,
      creatorAgent: null, agentStats: null })
    .instruction(), [w.buyer]), "cancel reopened task with worker bond present");

  assert.ok(isClosed(w.svm, m.workerBond), "worker bond settled on cancel");
  const workerDelta = Number(w.svm.getBalance(w.provider.publicKey)) - workerBefore;
  // Revert-sensitive: the honest worker is REFUNDED the full bond (principal + rent). Drop
  // the is_no_show_cancel gate and the principal is forfeited to the creator, so the worker
  // delta drops by 1,000,000 and this fails.
  assert.equal(workerDelta, workerBondBal, `honest worker fully refunded their bond, not forfeited (got ${workerDelta} of ${workerBondBal})`);
});

test("completion bond (#71): a no-show worker CANNOT skip the forfeit by omitting the bond accounts on self-expire", async () => {
  // Exploit chain #71: within the 60s grace window the worker is an allowed expire caller.
  // Pre-fix, the forfeit only fired `if let (Some(bond), Some(creator))`, so the worker
  // could self-expire OMITTING both accounts — the task reopened to Open, the bond PDA
  // (keyed to [task, wallet], NOT the claim) survived intact, and the worker re-claimed +
  // completed + reclaimed the bond, dodging the no-show penalty. The fix makes the bond
  // account REQUIRED + canonical-PDA-pinned on the pure-no-show path. Revert-sensitive:
  // restore the old `if let (Some, Some)` gate and the omitting-expire below succeeds.
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000 });
  const r = await runHireSettlement(w, { stopBeforeComplete: true }); // claimed, InProgress

  const [workerBond] = pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .postCompletionBond(1)
    .accounts({ task: r.task, completionBond: workerBond, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "worker posts bond");

  // warp PAST claim expiry but WITHIN the 60s grace window: only the worker authority may
  // expire here, which is exactly the window the dodge exploited.
  const clk = w.svm.getClock();
  clk.unixTimestamp = clk.unixTimestamp + 700_000n; // past expires_at
  w.svm.setClock(clk);

  // The worker self-expires OMITTING the bond accounts (the #71 dodge). MUST be rejected.
  expectFail(send(w.svm, await w.providerProg.methods
    .expireClaim()
    .accounts({
      authority: w.provider.publicKey, task: r.task, escrow: r.escrow, claim: r.claim,
      worker: w.providerAgent, protocolConfig: w.protocolPda, taskValidationConfig: null,
      taskSubmission: null, rentRecipient: w.provider.publicKey,
      workerCompletionBond: null, bondCreator: null,
      systemProgram: SystemProgram.programId, agentStats: null,
    })
    .instruction(), [w.provider]),
    "MissingCompletionBondAccount", "self-expire omitting the worker bond is rejected (#71)");

  // The bond is still live and the task is still InProgress (the dodge did not go through).
  assert.ok(!isClosed(w.svm, workerBond), "worker bond still live after the rejected dodge");
  assert.ok(decode(w.svm, "Task", r.task).status.InProgress !== undefined, "task did NOT reopen via the dodge");

  // Passing a junk (wrong-key) bond account is also rejected — it cannot stand in for the
  // canonical PDA to make settle no-op while leaving the real bond intact for reclaim.
  const junkBond = pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0];
  expectFail(send(w.svm, await w.providerProg.methods
    .expireClaim()
    .accounts({
      authority: w.provider.publicKey, task: r.task, escrow: r.escrow, claim: r.claim,
      worker: w.providerAgent, protocolConfig: w.protocolPda, taskValidationConfig: null,
      taskSubmission: null, rentRecipient: w.provider.publicKey,
      workerCompletionBond: junkBond, bondCreator: w.buyer.publicKey,
      systemProgram: SystemProgram.programId, agentStats: null,
    })
    .instruction(), [w.provider]),
    "MissingCompletionBondAccount", "self-expire with a non-canonical bond PDA is rejected (#71)");

  // The honest expire (correct canonical PDA + creator) still forfeits, proving the fix
  // does not freeze the legitimate no-show path.
  const buyerBefore = Number(w.svm.getBalance(w.buyer.publicKey));
  expectOk(send(w.svm, await w.providerProg.methods
    .expireClaim()
    .accounts({
      authority: w.provider.publicKey, task: r.task, escrow: r.escrow, claim: r.claim,
      worker: w.providerAgent, protocolConfig: w.protocolPda, taskValidationConfig: null,
      taskSubmission: null, rentRecipient: w.provider.publicKey,
      workerCompletionBond: workerBond, bondCreator: w.buyer.publicKey,
      systemProgram: SystemProgram.programId, agentStats: null,
    })
    .instruction(), [w.provider]), "honest self-expire forfeits the bond");
  assert.ok(isClosed(w.svm, workerBond), "worker bond forfeited + closed on honest expire");
  assert.equal(Number(w.svm.getBalance(w.buyer.publicKey)) - buyerBefore, 1_000_000,
    "creator received the forfeited principal even on a worker-initiated expire");
});

test("completion bond (#71): an UN-BONDED no-show still expires cleanly (fix must not freeze it)", async () => {
  // The required-account fix must NOT brick a legitimate no-show on a task with no worker
  // bond. The caller passes the canonical (empty, system-owned) PDA; settle_completion_bond
  // no-ops, the task reopens, the claim closes. Revert-sensitive in spirit: a fix that
  // required a *live* bond would make this fail.
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000 });
  const r = await runHireSettlement(w, { stopBeforeComplete: true }); // claimed, InProgress, NO bond

  // canonical worker bond PDA for [task, worker_authority] — exists only as an address.
  const [workerBondPda] = pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()]);
  assert.ok(isClosed(w.svm, workerBondPda), "no worker bond posted (PDA is empty)");

  const clk = w.svm.getClock();
  clk.unixTimestamp = clk.unixTimestamp + 700_000n;
  w.svm.setClock(clk);

  const cleaner = Keypair.generate();
  w.svm.airdrop(cleaner.publicKey, BigInt(10e9));
  expectOk(send(w.svm, await makeProgram(cleaner).methods
    .expireClaim()
    .accounts({
      authority: cleaner.publicKey, task: r.task, escrow: r.escrow, claim: r.claim,
      worker: w.providerAgent, protocolConfig: w.protocolPda, taskValidationConfig: null,
      taskSubmission: null, rentRecipient: w.provider.publicKey,
      workerCompletionBond: workerBondPda, bondCreator: w.buyer.publicKey,
      systemProgram: SystemProgram.programId, agentStats: null,
    })
    .instruction(), [cleaner]), "un-bonded no-show expires cleanly with the canonical empty PDA");

  assert.ok(isClosed(w.svm, r.claim), "claim closed");
  assert.ok(decode(w.svm, "Task", r.task).status.Open !== undefined, "un-bonded no-show task reopened to Open");
});

// Competitive (task_type=2) is omitted here because Task Validation V2 (CreatorReview)
// rejects it (ValidationModeUnsupportedTaskType), so the manual setup can't build one.
// Collaborative is a sufficient revert-sensitive guard: the `== Exclusive` fix treats every
// non-Exclusive type identically (the bond block is skipped), so type 1 proves the class.
for (const { type, name } of [{ type: 1, name: "Collaborative" }]) {
  test(`completion bond (#71 freeze-guard): a ${name} no-show expires cleanly with null bond accounts`, async () => {
    // Completion bonds are EXCLUSIVE-ONLY (post_completion_bond requires task_type==Exclusive),
    // so the #71 required-forfeit must be gated on `== Exclusive`, NOT `!= BidExclusive`: a
    // non-Exclusive no-show can never have a worker bond, and a hard require!(bond present)
    // for it would MissingCompletionBondAccount-FREEZE the expire, permanently stranding the
    // slot. Revert-sensitive: against the `!= BidExclusive` guard this expire fails
    // MissingCompletionBondAccount; with `== Exclusive` it expires cleanly.
    const w = await freshWorld({ moderationEnabled: true });
    const modProg = makeProgram(w.modAuth);
    const m = await setupManualTask(w, { mode: 1, taskType: type, maxWorkers: 2 });
    const { task, escrow, validation } = m;

    const jobHash = id32();
    const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
    const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
    expectOk(send(w.svm, await modProg.methods
      .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
      .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
      .instruction(), [w.modAuth]), `${name}:task-mod`);
    expectOk(send(w.svm, await w.buyerProg.methods
      .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/noshow", w.modAuth.publicKey)
      .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
      .instruction(), [w.buyer]), `${name}:publish`);

    const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
    expectOk(send(w.svm, await w.providerProg.methods.claimTaskWithJobSpec()
      .accounts({ task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
      .instruction(), [w.provider]), `${name}:claim`);
    assert.ok(decode(w.svm, "Task", task).status.InProgress !== undefined, `${name} task InProgress after claim`);

    const clk = w.svm.getClock();
    clk.unixTimestamp = clk.unixTimestamp + 700_000n;
    w.svm.setClock(clk);

    const cleaner = Keypair.generate();
    w.svm.airdrop(cleaner.publicKey, BigInt(10e9));
    // null bond accounts MUST be accepted on a no-show for a non-Exclusive task (no bond can exist).
    expectOk(send(w.svm, await makeProgram(cleaner).methods
      .expireClaim()
      .accounts({
        authority: cleaner.publicKey, task, escrow, claim,
        worker: w.providerAgent, protocolConfig: w.protocolPda, taskValidationConfig: validation,
        taskSubmission: null, rentRecipient: w.provider.publicKey,
        workerCompletionBond: null, bondCreator: null,
        systemProgram: SystemProgram.programId, agentStats: null,
      })
      .instruction(), [cleaner]), `${name} no-show expires with null bond accounts (no freeze)`);
    assert.ok(isClosed(w.svm, claim), `${name} no-show claim closed`);
  });
}

test("completion bond: a clean completion refunds BOTH bonds to their posters", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000 });
  const r = await runHireSettlement(w, { stopBeforeComplete: true }); // claimed, InProgress

  const creatorBond = pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0];
  const workerBond = pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()])[0];
  expectOk(send(w.svm, await w.buyerProg.methods.postCompletionBond(0)
    .accounts({ task: r.task, completionBond: creatorBond, authority: w.buyer.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.buyer]), "creator bond");
  expectOk(send(w.svm, await w.providerProg.methods.postCompletionBond(1)
    .accounts({ task: r.task, completionBond: workerBond, authority: w.provider.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.provider]), "worker bond");

  const creatorBondLamports = Number(w.svm.getBalance(creatorBond));
  const buyerBefore = Number(w.svm.getBalance(w.buyer.publicKey));

  expectOk(send(w.svm, await w.providerProg.methods
    .completeTask(arr(id32()), null)
    .accounts({
      task: r.task, claim: r.claim, escrow: r.escrow, creator: w.buyer.publicKey, worker: w.providerAgent,
      protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.provider.publicKey,
      systemProgram: SystemProgram.programId, tokenEscrowAta: null, workerTokenAccount: null,
      treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, hireRecord: r.hireRecord, operator: null, referrer: null,
      creatorCompletionBond: creatorBond, workerCompletionBond: workerBond,
    })
    .instruction(), [w.provider]), "complete with bond refunds");

  assert.ok(decode(w.svm, "Task", r.task).status.Completed !== undefined, "task Completed");
  assert.ok(isClosed(w.svm, creatorBond), "creator bond refunded + closed");
  assert.ok(isClosed(w.svm, workerBond), "worker bond refunded + closed");
  // buyer (not a signer here) gets back the full creator bond (rent + principal), plus escrow rent.
  assert.ok(Number(w.svm.getBalance(w.buyer.publicKey)) - buyerBefore >= creatorBondLamports,
    "creator received their refunded bond");
});

test("completion bond: rejected on a ZK-private task (audit — would strand on complete_task_private)", async () => {
  // A private task (real constraint_hash) settles via complete_task_private, which
  // does NOT settle bonds, so a bond there would be permanently stranded. post must
  // reject it. Revert-sensitive: drop the constraint_hash guard and this posts OK.
  const w = await freshWorld({});
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64); desc.set(crypto.randomBytes(32), 0);
  const constraintHash = crypto.randomBytes(32); // real ZK constraint -> private task
  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(2_000_000), 1, new BN(now + 3600), 0, arr(constraintHash), 0, null, null, 0)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "create private task");
  const bond = pda([enc("completion_bond"), task.toBuffer(), w.buyer.publicKey.toBuffer()])[0];
  expectFail(send(w.svm, await w.buyerProg.methods.postCompletionBond(0)
    .accounts({ task, completionBond: bond, authority: w.buyer.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.buyer]),
    "BondUnsupportedTaskType", "bond rejected on a ZK-private task");
});

test("completion bond (F12): complete_task FORCE-settles the worker bond even when the caller passes null — strand is structurally impossible", async () => {
  // Audit F12 (HARD-verified): the bond accounts on accept/auto_accept/complete are now
  // REQUIRED + canonical-PDA-pinned. A caller can no longer omit the worker bond to leave
  // it live on a Completed task (which close_task would then strand forever). Here the
  // worker posts a bond and the caller passes `workerCompletionBond: null`; the anchor
  // client auto-derives the now-required seeds-pinned PDA, so complete_task settles
  // (refunds) it. Revert-sensitive: restore the Optional+`if let Some` settlement and the
  // bond is left live (strandable), flipping the "closed" + "refunded" assertions red.
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000 });
  const r = await runHireSettlement(w, { stopBeforeComplete: true });
  const workerBond = pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()])[0];
  expectOk(send(w.svm, await w.providerProg.methods.postCompletionBond(1)
    .accounts({ task: r.task, completionBond: workerBond, authority: w.provider.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.provider]), "worker bond");
  const bondLamports = Number(w.svm.getBalance(workerBond));
  const providerBefore = Number(w.svm.getBalance(w.provider.publicKey));

  // complete_task passing workerCompletionBond:null — the required seeds-pinned account is
  // auto-derived to the real bond PDA and force-settled (cannot be omitted/stranded).
  expectOk(send(w.svm, await w.providerProg.methods.completeTask(arr(id32()), null)
    .accounts({ task: r.task, claim: r.claim, escrow: r.escrow, creator: w.buyer.publicKey, worker: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.provider.publicKey, systemProgram: SystemProgram.programId, tokenEscrowAta: null, workerTokenAccount: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, hireRecord: r.hireRecord, operator: null, referrer: null, creatorCompletionBond: null, workerCompletionBond: null })
    .instruction(), [w.provider]), "complete (worker bond auto-settled despite null)");
  assert.ok(decode(w.svm, "Task", r.task).status.Completed !== undefined, "task Completed");
  assert.ok(isClosed(w.svm, workerBond), "worker bond was force-refunded + closed at completion (NOT stranded)");
  // The worker got the full bond (principal + rent) back; only the tx fee is lost.
  const providerDelta = Number(w.svm.getBalance(w.provider.publicKey)) - providerBefore;
  assert.ok(providerDelta > bondLamports - 50_000, `worker refunded the bond at completion (delta ${providerDelta}, bond ${bondLamports})`);

  // And close_task succeeds because no live bond remains.
  expectOk(send(w.svm, await w.buyerProg.methods.closeTask()
    .accounts({ task: r.task, taskJobSpec: r.jobSpec, escrow: null, hireRecord: r.hireRecord, listing: w.listing, creatorCompletionBond: pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0], workerCompletionBond: null, authority: w.buyer.publicKey })
    .instruction(), [w.buyer]), "close_task after bonds settled");
  assert.ok(isClosed(w.svm, r.task), "task closed");
});

test("completion bond (F12): close_task REFUSES to close while a live creator bond exists; reclaim-on-Cancelled recovers it", async () => {
  // Audit F12: close_task must not destroy the Task PDA while a completion bond is live,
  // because reclaim_completion_bond needs a live Task. Here the creator bonds an Open task,
  // then cancels OMITTING the bond (so it stays live on the Cancelled task). close_task is
  // refused (TaskHasLiveCompletionBond), and reclaim — now valid on Cancelled — recovers it.
  const w = await freshWorld({ price: 2_000_000 });
  const { ix, task, escrow, hireRecord } = await hireIx(w, {});
  expectOk(send(w.svm, ix, [w.buyer]), "hire"); // Open task, creator == buyer
  const creatorBond = pda([enc("completion_bond"), task.toBuffer(), w.buyer.publicKey.toBuffer()])[0];
  expectOk(send(w.svm, await w.buyerProg.methods.postCompletionBond(0)
    .accounts({ task, completionBond: creatorBond, authority: w.buyer.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.buyer]), "creator bond");

  // cancel OMITTING the bond -> it stays live on the Cancelled task.
  expectOk(send(w.svm, await w.buyerProg.methods.cancelTask()
    .accounts({ task, escrow, authority: w.buyer.publicKey, protocolConfig: w.protocolPda, systemProgram: SystemProgram.programId,
      tokenEscrowAta: null, creatorTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: null, workerCompletionBond: null, workerBondAuthority: null, creatorAgent: null, agentStats: null })
    .instruction(), [w.buyer]), "cancel omitting the creator bond");
  assert.ok(decode(w.svm, "Task", task).status.Cancelled !== undefined, "task Cancelled");
  assert.ok(!isClosed(w.svm, creatorBond), "creator bond still live after omitted-account cancel");

  // close_task is REFUSED while the bond is live (revert-sensitive: drop the guard and this passes).
  expectFail(send(w.svm, await w.buyerProg.methods.closeTask()
    .accounts({ task, taskJobSpec: null, escrow: null, hireRecord, listing: w.listing, creatorCompletionBond: creatorBond, workerCompletionBond: null, authority: w.buyer.publicKey })
    .instruction(), [w.buyer]), "TaskHasLiveCompletionBond", "close_task refused while bond live");
  assert.ok(!isClosed(w.svm, task), "task NOT closed (still recoverable)");

  // reclaim on the Cancelled task (NEW: was Completed-only) recovers the bond to its poster
  // while the Task PDA is still alive — the universal safety net for the cancel path.
  const buyerBefore = Number(w.svm.getBalance(w.buyer.publicKey));
  const bondLamports = Number(w.svm.getBalance(creatorBond));
  expectOk(send(w.svm, await makeProgram(w.buyer).methods.reclaimCompletionBond(0)
    .accounts({ task, completionBond: creatorBond, party: w.buyer.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.buyer]), "reclaim on Cancelled");
  assert.ok(isClosed(w.svm, creatorBond), "creator bond recovered via reclaim-on-Cancelled");
  const buyerDelta = Number(w.svm.getBalance(w.buyer.publicKey)) - buyerBefore;
  assert.ok(buyerDelta > bondLamports - 50_000, `creator recovered the bond (delta ${buyerDelta}, bond ${bondLamports})`);
});

test("completion bond: cancel refunds the creator bond on an Open task", async () => {
  const w = await freshWorld({ price: 2_000_000 });
  const { ix, task, escrow } = await hireIx(w, {});
  expectOk(send(w.svm, ix, [w.buyer]), "hire"); // Open task, creator == buyer
  const creatorBond = pda([enc("completion_bond"), task.toBuffer(), w.buyer.publicKey.toBuffer()])[0];
  expectOk(send(w.svm, await w.buyerProg.methods.postCompletionBond(0)
    .accounts({ task, completionBond: creatorBond, authority: w.buyer.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.buyer]), "creator bond");

  expectOk(send(w.svm, await w.buyerProg.methods.cancelTask()
    .accounts({ task, escrow, authority: w.buyer.publicKey, protocolConfig: w.protocolPda, systemProgram: SystemProgram.programId,
      tokenEscrowAta: null, creatorTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: creatorBond, workerCompletionBond: null, workerBondAuthority: null,
      creatorAgent: null, agentStats: null })
    .instruction(), [w.buyer]), "cancel with creator bond refund");

  assert.ok(decode(w.svm, "Task", task).status.Cancelled !== undefined, "task Cancelled");
  assert.ok(isClosed(w.svm, creatorBond), "creator bond refunded + closed on cancel");
});

test("3-way split: hire -> settle pays worker (>=60%) + AgenC (treasury) + operator (exact cut)", async () => {
  const operatorKp = Keypair.generate();
  const w = await freshWorld({ moderationEnabled: true, price: 5_000_000, operator: operatorKp.publicKey, operatorFeeBps: 1000 });
  const r = await runHireSettlement(w);

  const t = decode(w.svm, "Task", r.task);
  assert.ok(t.status.Completed !== undefined, `task Completed (got ${JSON.stringify(t.status)})`);
  // Batch 2: operator terms are stamped onto the Task itself (Task-first settlement).
  assert.equal(t.operator.toBase58(), operatorKp.publicKey.toBase58(), "Task.operator stamped at hire");
  assert.equal(t.operator_fee_bps, 1000, "Task.operator_fee_bps stamped at hire");

  // operator leg is exact: base(=reward, exclusive) * operatorFeeBps / 10000.
  const operatorAfter = Number(w.svm.getBalance(operatorKp.publicKey));
  const expectedOperatorFee = Math.floor((r.reward * 1000) / 10000); // 500_000
  assert.equal(operatorAfter - r.operatorBalBefore, expectedOperatorFee, "operator received its exact fee leg");

  // treasury (AgenC) received a non-zero protocol cut.
  const treasuryAfter = Number(w.svm.getBalance(w.admin.publicKey));
  const treasuryDelta = treasuryAfter - r.treasuryBalBefore;
  assert.ok(treasuryDelta > 0, "treasury received the AgenC protocol fee");

  // worker (provider authority, also fee payer) keeps >= 60% of the reward.
  const workerAfter = Number(w.svm.getBalance(w.provider.publicKey));
  const workerDelta = workerAfter - r.workerBalBefore; // worker_reward minus tx fee
  assert.ok(workerDelta >= Math.floor(r.reward * 0.6), `worker keeps >=60% (got ${workerDelta} of ${r.reward})`);

  // conservation: the three legs (+ worker's tx fee) drain exactly the reward.
  assert.ok(expectedOperatorFee + treasuryDelta < r.reward, "operator + AgenC stay below the full reward");
  assert.ok(isClosed(w.svm, r.escrow), "escrow closed on completion");
});

test("3-way split: a listing with no operator fee settles 2-way (operator leg skipped)", async () => {
  // operator=null, operatorFeeBps=0 -> HireRecord.operator=default, fee=0 -> no leg.
  const w = await freshWorld({ moderationEnabled: true, price: 3_000_000 });
  const r = await runHireSettlement(w); // w.operator is null -> complete passes operator: null

  const t = decode(w.svm, "Task", r.task);
  assert.ok(t.status.Completed !== undefined, "task Completed via hire path with no operator leg");
  const workerAfter = Number(w.svm.getBalance(w.provider.publicKey));
  assert.ok(workerAfter > r.workerBalBefore, "worker paid on the 2-way fallback");
  assert.ok(isClosed(w.svm, r.escrow), "escrow closed");
});

test("3-way split: settlement still works while the protocol is paused (exit-safe + operator leg)", async () => {
  const operatorKp = Keypair.generate();
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000, operator: operatorKp.publicKey, operatorFeeBps: 500 });
  const r = await runHireSettlement(w, { pauseBeforeComplete: true });

  const operatorAfter = Number(w.svm.getBalance(operatorKp.publicKey));
  assert.equal(operatorAfter - r.operatorBalBefore, Math.floor((r.reward * 500) / 10000), "operator paid its leg even while paused");
  assert.ok(isClosed(w.svm, r.escrow), "escrow closed while paused");
});

test("exit allow-list (settlement): a worker still completes + is paid while the protocol is paused", async () => {
  // Regression for the iter-5 review finding: forward-settlement (complete_task)
  // must not be frozen by a pause, or a worker who did the work loses it when the
  // claim later expires. Pause is injected AFTER the claim, before completion.
  const w = await freshWorld({ moderationEnabled: true });
  const r = await runAutoSettlement(w, { pauseBeforeComplete: true });

  const t = decode(w.svm, "Task", r.task);
  assert.ok(t.status.Completed !== undefined, `task Completed despite paused protocol (got ${JSON.stringify(t.status)})`);
  assert.ok(Number(w.svm.getBalance(r.workerAuthority)) > r.workerBalBefore, "worker paid while paused");
  assert.ok(isClosed(w.svm, r.escrow), "escrow closed on completion while paused");
});

/// Build a BidExclusive task with an injected bid marketplace, an open bid book,
/// and one active bid from the provider agent — in a moderation-enabled world.
/// When publishJobSpec is true, also record+publish a moderated TaskJobSpec (which
/// accept_bid now requires). Returns handles for accept_bid.
async function setupBidTask(w, { publishJobSpec = true } = {}) {
  const modProg = makeProgram(w.modAuth);
  const taskId = id32();
  const reward = 4_000_000;
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);

  // 1) create a BidExclusive task (task_type = 3).
  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(reward), 1, new BN(now + 3600), 3, null, 0, null, null, 0) // task_type=3 (BidExclusive)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "bid:create_task");

  // 2) optionally publish a moderated job spec (required by accept_bid, §6).
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  if (publishJobSpec) {
    const jobHash = id32();
    const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
    expectOk(send(w.svm, await modProg.methods
      .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
      .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
      .instruction(), [w.modAuth]), "bid:task-mod");
    expectOk(send(w.svm, await w.buyerProg.methods
      .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/bid", w.modAuth.publicKey)
      .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
      .instruction(), [w.buyer]), "bid:publish");
  }

  // 3) inject the bid marketplace, then init the bid book (creator) + a bid (provider).
  const bidMarket = await injectBidMarketplace(w.svm, w.admin, {});
  const [bidBook] = pda([enc("bid_book"), task.toBuffer()]);
  expectOk(send(w.svm, await w.buyerProg.methods
    .initializeBidBook(0, 0, 0, 0, 0) // policy 0 = BestPrice (no weight-sum rule)
    .accounts({ task, bidBook, protocolConfig: w.protocolPda, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "bid:init-book");

  const [bid] = pda([enc("bid"), task.toBuffer(), w.providerAgent.toBuffer()]);
  const [bidderMarket] = pda([enc("bidder_market"), w.providerAgent.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .createBid(new BN(reward), 3600, 5000, arr(Buffer.alloc(32, 4)), arr(Buffer.alloc(32, 5)), new BN(now + 1800))
    .accounts({ protocolConfig: w.protocolPda, bidMarketplace: bidMarket, task, bidBook, bid, bidderMarketState: bidderMarket, bidder: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "bid:create_bid");

  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  return { task, escrow, jobSpec, bidBook, bid, bidderMarket, claim, reward };
}

test("accept_bid moderation gate: succeeds only with a published (moderated) job spec", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const b = await setupBidTask(w, { publishJobSpec: true });

  expectOk(send(w.svm, await w.buyerProg.methods
    .acceptBid()
    .accounts({ task: b.task, claim: b.claim, protocolConfig: w.protocolPda, bidBook: b.bidBook, bid: b.bid, bidderMarketState: b.bidderMarket, bidder: w.providerAgent, taskJobSpec: b.jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "accept_bid with job spec");

  const t = decode(w.svm, "Task", b.task);
  assert.ok(t.status.InProgress !== undefined, `task InProgress after accept_bid (got ${JSON.stringify(t.status)})`);
  const claim = decode(w.svm, "TaskClaim", b.claim);
  assert.equal(claim.worker.toBase58(), w.providerAgent.toBase58(), "claim assigned to the bidder");
});

test("accept_bid moderation gate: rejected when no job spec was published (§6 entry gate)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const b = await setupBidTask(w, { publishJobSpec: false }); // no TaskJobSpec published

  // The required task_job_spec PDA does not exist -> accept_bid cannot assign work.
  const res = send(w.svm, await w.buyerProg.methods
    .acceptBid()
    .accounts({ task: b.task, claim: b.claim, protocolConfig: w.protocolPda, bidBook: b.bidBook, bid: b.bid, bidderMarketState: b.bidderMarket, bidder: w.providerAgent, taskJobSpec: b.jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]);
  expectFail(res, "AccountNotInitialized", "accept_bid without a published job spec");

  // The task must remain Open (no worker assigned) since the gate blocked it.
  const t = decode(w.svm, "Task", b.task);
  assert.ok(t.status.Open !== undefined, `task stays Open when the gate blocks accept_bid (got ${JSON.stringify(t.status)})`);
});

/// Create a plain (non-hired) Auto task and pin it to manual validation (default
/// CreatorReview = 1). Passes the empty ["hire", task] PDA (non-hired), so the
/// hired-task guard lets it through. Returns handles for the manual settlement flow.
async function setupManualTask(w, { mode = 1, reviewWindow = 3600, reward = 2_000_000, capabilities = 1, taskType = 0, maxWorkers = 1 } = {}) {
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const [validation] = pda([enc("task_validation"), task.toBuffer()]);
  const [attestor] = pda([enc("task_attestor"), task.toBuffer()]);
  const [hireRecord] = pda([enc("hire"), task.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(capabilities), arr(desc), new BN(reward), maxWorkers, new BN(now + 3600), taskType, null, 0, null, null, 0)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "manual:create_task");
  expectOk(send(w.svm, await w.buyerProg.methods
    .configureTaskValidation(mode, new BN(reviewWindow), 0, null)
    .accounts({ task, taskValidationConfig: validation, taskAttestorConfig: attestor, protocolConfig: w.protocolPda, hireRecord, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "manual:configure");
  return { task, escrow, validation, attestor, reward };
}

test("operator-fee protection: a hired task cannot be re-routed to manual validation", async () => {
  // Regression for the audit finding: configure_task_validation must reject a task
  // that has a live HireRecord (re-routing it to manual settlement would drop the
  // operator's fee, which the manual path is not yet hire-aware about).
  const operatorKp = Keypair.generate();
  const w = await freshWorld({ moderationEnabled: true, price: 3_000_000, operator: operatorKp.publicKey, operatorFeeBps: 1000 });
  const [listingMod] = listingModV2Pda(w.listing, w.specHash, w.modAuth.publicKey);
  expectOk(send(w.svm, await makeProgram(w.modAuth).methods
    .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "record listing mod");
  const { ix: hix, task, hireRecord } = await hireIx(w, { listingModeration: listingMod });
  expectOk(send(w.svm, hix, [w.buyer]), "hire");

  const [validation] = pda([enc("task_validation"), task.toBuffer()]);
  const [attestor] = pda([enc("task_attestor"), task.toBuffer()]);
  const cfgIx = await w.buyerProg.methods
    .configureTaskValidation(1, new BN(3600), 0, null) // CreatorReview
    .accounts({ task, taskValidationConfig: validation, taskAttestorConfig: attestor, protocolConfig: w.protocolPda, hireRecord, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction();
  expectFail(send(w.svm, cfgIx, [w.buyer]), "HiredTaskValidationUnsupported", "configure validation on a hired task");
});

test("configure_task_validation: a non-hired task can still be pinned to manual validation", async () => {
  const w = await freshWorld({});
  const m = await setupManualTask(w, { mode: 1 }); // passes the empty hire PDA, guard lets it through
  const vc = decode(w.svm, "TaskValidationConfig", m.validation);
  assert.ok(
    vc.mode?.CreatorReview !== undefined || vc.mode?.creatorReview !== undefined,
    `non-hired task pinned to CreatorReview (got ${JSON.stringify(vc.mode)})`,
  );
});

/// Drive a manual-validation (V2) task through settlement: create+configure (CreatorReview)
/// -> moderate -> publish -> claim -> submit_task_result -> accept|reject_task_result.
/// Requires a moderation-enabled world. Returns handles + the worker balance snapshot.
async function runManualSettlement(w, { decision = "accept", pauseBeforeSettle = false, postBonds = false } = {}) {
  const modProg = makeProgram(w.modAuth);
  const m = await setupManualTask(w, { mode: 1 }); // CreatorReview, non-hired
  const { task, escrow, validation, reward } = m;

  // moderate + publish a job spec (required to claim)
  const jobHash = id32();
  const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "manual:task-mod");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/manual", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "manual:publish");

  // worker claims, then submits a result for review
  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "manual:claim");
  const [submission] = pda([enc("task_submission"), claim.toBuffer()]);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  expectOk(send(w.svm, await w.providerProg.methods
    .submitTaskResult(arr(id32()), arr(desc))
    .accounts({ task, claim, taskValidationConfig: validation, taskSubmission: submission, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "manual:submit");

  // Optional: post creator + worker completion bonds so accept can exercise the refund.
  let creatorBond = null, workerBond = null;
  if (postBonds) {
    creatorBond = pda([enc("completion_bond"), task.toBuffer(), w.buyer.publicKey.toBuffer()])[0];
    workerBond = pda([enc("completion_bond"), task.toBuffer(), w.provider.publicKey.toBuffer()])[0];
    expectOk(send(w.svm, await w.buyerProg.methods.postCompletionBond(0)
      .accounts({ task, completionBond: creatorBond, authority: w.buyer.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.buyer]), "manual:creator-bond");
    expectOk(send(w.svm, await w.providerProg.methods.postCompletionBond(1)
      .accounts({ task, completionBond: workerBond, authority: w.provider.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.provider]), "manual:worker-bond");
  }

  if (pauseBeforeSettle) await setProtocolPaused(w.svm, true);

  // worker_authority (provider) is NOT the signer of accept/reject (creator signs),
  // so its balance delta reflects payout exactly.
  const workerBalBefore = Number(w.svm.getBalance(w.provider.publicKey));
  if (decision === "accept") {
    expectOk(send(w.svm, await w.buyerProg.methods
      .acceptTaskResult()
      .accounts({ task, claim, escrow, taskValidationConfig: validation, taskSubmission: submission, worker: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, creator: w.buyer.publicKey, workerAuthority: w.provider.publicKey, operator: null, referrer: null, hireRecord: null, creatorCompletionBond: creatorBond, workerCompletionBond: workerBond, tokenEscrowAta: null, workerTokenAccount: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, systemProgram: SystemProgram.programId })
      .instruction(), [w.buyer]), "manual:accept");
  } else if (decision === "reject") {
    expectOk(send(w.svm, await w.buyerProg.methods
      .rejectTaskResult(arr(id32()))
      .accounts({ task, claim, taskValidationConfig: validation, taskSubmission: submission, worker: w.providerAgent, protocolConfig: w.protocolPda, creator: w.buyer.publicKey, workerAuthority: w.provider.publicKey, agentStats: null })
      .instruction(), [w.buyer]), "manual:reject");
  }
  return { task, escrow, claim, validation, submission, jobSpec, workerBalBefore, reward, creatorBond, workerBond };
}

test("manual validation (CreatorReview): submit -> accept pays the worker", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await runManualSettlement(w, { decision: "accept" });
  const t = decode(w.svm, "Task", r.task);
  assert.ok(t.status.Completed !== undefined, `task Completed after accept (got ${JSON.stringify(t.status)})`);
  assert.ok(Number(w.svm.getBalance(w.provider.publicKey)) > r.workerBalBefore, "worker paid on accept");
  assert.ok(isClosed(w.svm, r.escrow), "escrow closed on accept");
});

test("completion bond: accept_task_result refunds BOTH bonds", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await runManualSettlement(w, { decision: "accept", postBonds: true });
  assert.ok(decode(w.svm, "Task", r.task).status.Completed !== undefined, "task Completed after accept");
  assert.ok(isClosed(w.svm, r.creatorBond), "creator bond refunded + closed on accept");
  assert.ok(isClosed(w.svm, r.workerBond), "worker bond refunded + closed on accept");
});

test("manual validation (CreatorReview): reject does NOT pay the worker or settle", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await runManualSettlement(w, { decision: "reject" });
  const t = decode(w.svm, "Task", r.task);
  assert.ok(t.status.Completed === undefined, `task NOT Completed after reject (got ${JSON.stringify(t.status)})`);
  assert.ok(!isClosed(w.svm, r.escrow), "escrow still holds the reward after reject");
});

test("manual validation: accept still settles while the protocol is paused (exit-safe)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await runManualSettlement(w, { decision: "accept", pauseBeforeSettle: true });
  assert.ok(decode(w.svm, "Task", r.task).status.Completed !== undefined, "task Completed despite pause");
  assert.ok(Number(w.svm.getBalance(w.provider.publicKey)) > r.workerBalBefore, "worker paid while paused");
  assert.ok(isClosed(w.svm, r.escrow), "escrow closed while paused");
});

/// Manual (CreatorReview) task driven through moderate -> publish -> claim -> submit,
/// stopping with a pending submission ready for accept / request_changes / reject.
async function setupSubmittedManual(w, opts = {}) {
  const modProg = makeProgram(w.modAuth);
  const m = await setupManualTask(w, { mode: 1, ...opts });
  const { task, escrow, validation, reward } = m;
  const jobHash = id32();
  const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  expectOk(send(w.svm, await modProg.methods.recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId }).instruction(), [w.modAuth]), "rc:mod");
  expectOk(send(w.svm, await w.buyerProg.methods.setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/rc", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.buyer]), "rc:publish");
  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods.claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.provider]), "rc:claim");
  const [submission] = pda([enc("task_submission"), claim.toBuffer()]);
  const desc = Buffer.alloc(64); desc.set(crypto.randomBytes(32), 0);
  const submit = async () => send(w.svm, await w.providerProg.methods.submitTaskResult(arr(id32()), arr(desc))
    .accounts({ task, claim, taskValidationConfig: validation, taskSubmission: submission, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.provider]);
  expectOk(await submit(), "rc:submit");
  return { task, escrow, validation, submission, jobSpec, claim, reward, submit };
}

test("request_changes: non-terminal revision keeps the claim, worker resubmits in place -> accept pays", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await setupSubmittedManual(w);
  expectOk(send(w.svm, await w.buyerProg.methods.requestChanges(arr(Buffer.alloc(32, 9)))
    .accounts({ task: r.task, claim: r.claim, taskValidationConfig: r.validation, taskSubmission: r.submission, protocolConfig: w.protocolPda, creator: w.buyer.publicKey }).instruction(), [w.buyer]), "request_changes");
  assert.ok(decode(w.svm, "Task", r.task).status.InProgress !== undefined, "task back to InProgress after request_changes");
  assert.ok(!isClosed(w.svm, r.claim), "claim retained (worker resubmits in place)");

  w.svm.expireBlockhash();
  expectOk(await r.submit(), "resubmit after changes");
  assert.ok(decode(w.svm, "Task", r.task).status.PendingValidation !== undefined, "resubmit -> PendingValidation");

  expectOk(send(w.svm, await w.buyerProg.methods.acceptTaskResult()
    .accounts({ task: r.task, claim: r.claim, escrow: r.escrow, taskValidationConfig: r.validation, taskSubmission: r.submission, worker: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, creator: w.buyer.publicKey, workerAuthority: w.provider.publicKey, operator: null, referrer: null, hireRecord: null, creatorCompletionBond: null, workerCompletionBond: null, tokenEscrowAta: null, workerTokenAccount: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, systemProgram: SystemProgram.programId }).instruction(), [w.buyer]), "accept after revision");
  assert.ok(decode(w.svm, "Task", r.task).status.Completed !== undefined, "task Completed after revision + accept");
});

test("request_changes near the deadline extends the resubmit window (no honest-worker bond forfeit, #70)", async () => {
  // A creator must not be able to request changes near the deadline, strand the
  // worker (submit blocks past task.deadline / claim.expires_at), then cancel the
  // task as a "no-show" and forfeit the worker's completion bond. request_changes
  // now pushes the deadline + claim expiry out by the review window so a worker who
  // delivered can always resubmit. Revert-sensitive: pre-fix the resubmit below
  // fails DeadlinePassed and the deadline is unchanged.
  const w = await freshWorld({ moderationEnabled: true });
  const r = await setupSubmittedManual(w); // PendingValidation, Submitted, claim open
  const d0 = Number(decode(w.svm, "Task", r.task).deadline);
  assert.ok(d0 > 0, "task has a deadline");

  // jump to just before the deadline, then request changes.
  let clk = w.svm.getClock();
  clk.unixTimestamp = BigInt(d0 - 10);
  w.svm.setClock(clk);
  expectOk(send(w.svm, await w.buyerProg.methods.requestChanges(arr(Buffer.alloc(32, 9)))
    .accounts({ task: r.task, claim: r.claim, taskValidationConfig: r.validation, taskSubmission: r.submission, protocolConfig: w.protocolPda, creator: w.buyer.publicKey }).instruction(), [w.buyer]), "request_changes near deadline");

  const d1 = Number(decode(w.svm, "Task", r.task).deadline);
  assert.ok(d1 > d0, `deadline extended past the original (d0=${d0}, d1=${d1})`);

  // advance past the ORIGINAL deadline; the worker can still resubmit (not stranded).
  w.svm.expireBlockhash();
  clk = w.svm.getClock();
  clk.unixTimestamp = BigInt(d0 + 1);
  w.svm.setClock(clk);
  expectOk(await r.submit(), "worker resubmits after a near-deadline change request");
  assert.ok(decode(w.svm, "Task", r.task).status.PendingValidation !== undefined, "resubmit -> PendingValidation (worker not stranded, bond safe)");
});

test("expire_claim: a PendingValidation claim with live submitted work cannot be expired (escrow-lock guard)", async () => {
  // Revert-sensitive guard for the critical escrow-lock: a PendingValidation task
  // has a live ["task_submission", claim] PDA (Submitted). Pre-fix, omitting that
  // optional account (taskSubmission: null) made the guard read "no pending
  // submission" and CLOSE the claim — discarding the work and permanently locking
  // escrow (no settlement path survives a closed claim). After the fix, a
  // PendingValidation expiry MUST supply the submission, and a Submitted one is
  // rejected either way. Drop the fix and the `taskSubmission: null` call succeeds.
  const w = await freshWorld({ moderationEnabled: true });
  const r = await setupSubmittedManual(w); // task PendingValidation, submission Submitted, claim open
  assert.ok(decode(w.svm, "Task", r.task).status.PendingValidation !== undefined, "precondition: PendingValidation");

  // warp past claim expiry + grace so an expire would otherwise be permissionless.
  const clk = w.svm.getClock();
  clk.unixTimestamp = clk.unixTimestamp + 700_000n;
  w.svm.setClock(clk);

  const cleaner = Keypair.generate();
  w.svm.airdrop(cleaner.publicKey, BigInt(10e9));
  const expireWith = async (taskSubmission) => send(w.svm, await makeProgram(cleaner).methods
    .expireClaim()
    .accounts({
      authority: cleaner.publicKey, task: r.task, escrow: r.escrow, claim: r.claim,
      worker: w.providerAgent, protocolConfig: w.protocolPda, taskValidationConfig: r.validation,
      taskSubmission, rentRecipient: w.provider.publicKey,
      workerCompletionBond: null, bondCreator: null,
      systemProgram: SystemProgram.programId, agentStats: null,
    })
    .instruction(), [cleaner]);

  // (a) omitting the submission no longer bypasses the guard.
  expectFail(await expireWith(null), "TaskSubmissionRequired", "PendingValidation expiry must supply the submission");
  // (b) supplying the real (Submitted) submission is rejected too — live work is never expirable.
  w.svm.expireBlockhash();
  expectFail(await expireWith(r.submission), "TaskNotInProgress", "a Submitted claim cannot be expired");

  // escrow and claim survive intact; the work and funds are not lost.
  assert.ok(!isClosed(w.svm, r.claim), "claim retained (not closed by a bypassed expire)");
  assert.ok(!isClosed(w.svm, r.escrow), "escrow retained (not locked)");
});

test("reject_and_freeze: terminal reject freezes the task and retains the claim (no payout)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await setupSubmittedManual(w);
  const workerBefore = Number(w.svm.getBalance(w.provider.publicKey));
  expectOk(send(w.svm, await w.buyerProg.methods.rejectAndFreeze(arr(Buffer.alloc(32, 7)))
    .accounts({ task: r.task, claim: r.claim, taskValidationConfig: r.validation, taskSubmission: r.submission, protocolConfig: w.protocolPda, creator: w.buyer.publicKey, agentStats: null }).instruction(), [w.buyer]), "reject_and_freeze");
  assert.ok(decode(w.svm, "Task", r.task).status.RejectFrozen !== undefined, "task RejectFrozen");
  assert.ok(!isClosed(w.svm, r.claim), "claim retained for the frozen exit");
  assert.ok(!isClosed(w.svm, r.escrow), "escrow retained (no payout on freeze)");
  assert.equal(Number(w.svm.getBalance(w.provider.publicKey)), workerBefore, "no worker payout on freeze");
});

test("reject_and_freeze: rejected on a Collaborative task (audit — would strand the multi-worker escrow)", async () => {
  // A Collaborative task escrows the full reward but the frozen exits pay one worker's
  // reward/required_completions share, stranding the rest. Freezing is Exclusive-only.
  // Revert-sensitive: drop the guard and this freezes (and would strand).
  const w = await freshWorld({ moderationEnabled: true });
  const r = await setupSubmittedManual(w, { taskType: 1, maxWorkers: 2 }); // Collaborative
  expectFail(send(w.svm, await w.buyerProg.methods.rejectAndFreeze(arr(Buffer.alloc(32, 7)))
    .accounts({ task: r.task, claim: r.claim, taskValidationConfig: r.validation, taskSubmission: r.submission, protocolConfig: w.protocolPda, creator: w.buyer.publicKey, agentStats: null }).instruction(), [w.buyer]),
    "RejectFrozenSingleWorkerOnly", "freeze refused on a Collaborative task");
});

/// Drive a manual task all the way to RejectFrozen (optionally with both bonds posted).
async function setupFrozen(w, { postBonds = false } = {}) {
  const r = await setupSubmittedManual(w);
  let creatorBond = null, workerBond = null;
  if (postBonds) {
    creatorBond = pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0];
    workerBond = pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()])[0];
    expectOk(send(w.svm, await w.buyerProg.methods.postCompletionBond(0).accounts({ task: r.task, completionBond: creatorBond, authority: w.buyer.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.buyer]), "frozen:creator-bond");
    expectOk(send(w.svm, await w.providerProg.methods.postCompletionBond(1).accounts({ task: r.task, completionBond: workerBond, authority: w.provider.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.provider]), "frozen:worker-bond");
  }
  expectOk(send(w.svm, await w.buyerProg.methods.rejectAndFreeze(arr(Buffer.alloc(32, 7)))
    .accounts({ task: r.task, claim: r.claim, taskValidationConfig: r.validation, taskSubmission: r.submission, protocolConfig: w.protocolPda, creator: w.buyer.publicKey, agentStats: null }).instruction(), [w.buyer]), "frozen:freeze");
  assert.ok(decode(w.svm, "Task", r.task).status.RejectFrozen !== undefined, "task is RejectFrozen");
  return { ...r, creatorBond, workerBond };
}

test("negative: a RejectFrozen task is refused by cancel / accept / request_changes / reject_and_freeze", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const f = await setupFrozen(w);

  // cancel_task: a frozen task is not cancellable (creator can't dodge the review).
  expectFail(send(w.svm, await w.buyerProg.methods.cancelTask()
    .accounts({ task: f.task, escrow: f.escrow, authority: w.buyer.publicKey, protocolConfig: w.protocolPda, systemProgram: SystemProgram.programId,
      tokenEscrowAta: null, creatorTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: null, workerCompletionBond: null, workerBondAuthority: null,
      creatorAgent: null, agentStats: null })
    .instruction(), [w.buyer]), "TaskCannotBeCancelled", "cancel refused on a frozen task");

  // accept_task_result: requires PendingValidation; a frozen task is not.
  expectFail(send(w.svm, await w.buyerProg.methods.acceptTaskResult()
    .accounts({ task: f.task, claim: f.claim, escrow: f.escrow, taskValidationConfig: f.validation, taskSubmission: f.submission, worker: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, creator: w.buyer.publicKey, workerAuthority: w.provider.publicKey, operator: null, referrer: null, hireRecord: null, creatorCompletionBond: null, workerCompletionBond: null, tokenEscrowAta: null, workerTokenAccount: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "TaskNotPendingValidation", "accept refused on a frozen task");

  // request_changes + reject_and_freeze: both require PendingValidation.
  expectFail(send(w.svm, await w.buyerProg.methods.requestChanges(arr(Buffer.alloc(32, 9)))
    .accounts({ task: f.task, claim: f.claim, taskValidationConfig: f.validation, taskSubmission: f.submission, protocolConfig: w.protocolPda, creator: w.buyer.publicKey })
    .instruction(), [w.buyer]), "TaskNotPendingValidation", "request_changes refused on a frozen task");
  expectFail(send(w.svm, await w.buyerProg.methods.rejectAndFreeze(arr(Buffer.alloc(32, 9)))
    .accounts({ task: f.task, claim: f.claim, taskValidationConfig: f.validation, taskSubmission: f.submission, protocolConfig: w.protocolPda, creator: w.buyer.publicKey, agentStats: null })
    .instruction(), [w.buyer]), "TaskNotPendingValidation", "double-freeze refused");
});

test("dispute mutual-exclusion: a RejectFrozen task cannot be disputed", async () => {
  // The durable-submission path in initiate_dispute bypasses can_transition_to(Disputed),
  // so the freeze is guarded explicitly. Revert-sensitive: drop the guard and this
  // initiate_dispute no longer fails with TaskFrozenCannotDispute.
  const w = await freshWorld({ moderationEnabled: true });
  const f = await setupFrozen(w);
  const taskId = decode(w.svm, "Task", f.task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.provider.publicKey.toBuffer()]);
  expectFail(send(w.svm, await w.providerProg.methods
    .initiateDispute(arr(disputeId), arr(taskId), arr(Buffer.alloc(32, 1)), 0, "evidence")
    .accounts({ dispute, task: f.task, agent: w.providerAgent, authorityRateLimit: rateLimit, protocolConfig: w.protocolPda, initiatorClaim: f.claim, workerAgent: null, workerClaim: null, taskSubmission: null, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]),
    "TaskFrozenCannotDispute", "a frozen task is refused a dispute");
});

test("resolve_reject_frozen (approve): pays the worker, refunds worker bond, forfeits creator bond (2-of-2 multisig)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const owner2 = Keypair.generate(); w.svm.airdrop(owner2.publicKey, BigInt(10e9));
  await setMultisig(w.svm, [w.admin.publicKey, owner2.publicKey], 2);
  const f = await setupFrozen(w, { postBonds: true });
  const signerMetas = [{ pubkey: w.admin.publicKey, isSigner: true, isWritable: false }, { pubkey: owner2.publicKey, isSigner: true, isWritable: false }];
  const accts = { task: f.task, claim: f.claim, escrow: f.escrow, taskSubmission: f.submission, worker: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, creator: w.buyer.publicKey, workerAuthority: w.provider.publicKey, authority: w.admin.publicKey, creatorCompletionBond: f.creatorBond, workerCompletionBond: f.workerBond, bondTreasury: w.admin.publicKey, systemProgram: SystemProgram.programId };

  // a single signer cannot pass the 2-of-2 gate.
  expectFail(send(w.svm, await makeProgram(w.admin).methods.resolveRejectFrozen(true).accounts(accts).remainingAccounts([signerMetas[0]]).instruction(), [w.admin]), "MultisigNotEnoughSigners", "single signer rejected");

  const workerBefore = Number(w.svm.getBalance(w.provider.publicKey));
  expectOk(send(w.svm, await makeProgram(w.admin).methods.resolveRejectFrozen(true).accounts(accts).remainingAccounts(signerMetas).instruction(), [w.admin, owner2]), "resolve approve");
  assert.ok(decode(w.svm, "Task", f.task).status.Completed !== undefined, "task Completed (worker vindicated)");
  assert.ok(Number(w.svm.getBalance(w.provider.publicKey)) > workerBefore, "worker paid");
  assert.ok(isClosed(w.svm, f.workerBond), "worker bond refunded + closed");
  assert.ok(isClosed(w.svm, f.creatorBond), "creator bond forfeited + closed");
  assert.ok(isClosed(w.svm, f.escrow), "escrow settled");
});

test("resolve_reject_frozen (reject): refunds the creator, forfeits worker bond, refunds creator bond (multisig)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const owner2 = Keypair.generate(); w.svm.airdrop(owner2.publicKey, BigInt(10e9));
  await setMultisig(w.svm, [w.admin.publicKey, owner2.publicKey], 2);
  const f = await setupFrozen(w, { postBonds: true });
  const signerMetas = [{ pubkey: w.admin.publicKey, isSigner: true, isWritable: false }, { pubkey: owner2.publicKey, isSigner: true, isWritable: false }];
  const buyerBefore = Number(w.svm.getBalance(w.buyer.publicKey));
  // Worker holds a live claim slot going into the uphold path.
  assert.equal(Number(decode(w.svm, "AgentRegistration", w.providerAgent).active_tasks), 1, "worker active_tasks == 1 before resolve");
  assert.equal(Number(decode(w.svm, "Task", f.task).current_workers), 1, "task current_workers == 1 before resolve");
  expectOk(send(w.svm, await makeProgram(w.admin).methods.resolveRejectFrozen(false)
    .accounts({ task: f.task, claim: f.claim, escrow: f.escrow, taskSubmission: f.submission, worker: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, creator: w.buyer.publicKey, workerAuthority: w.provider.publicKey, authority: w.admin.publicKey, creatorCompletionBond: f.creatorBond, workerCompletionBond: f.workerBond, bondTreasury: w.admin.publicKey, systemProgram: SystemProgram.programId })
    .remainingAccounts(signerMetas).instruction(), [w.admin, owner2]), "resolve reject");
  assert.ok(decode(w.svm, "Task", f.task).status.Cancelled !== undefined, "task Cancelled (rejection upheld)");
  assert.ok(isClosed(w.svm, f.escrow), "escrow refunded + closed");
  assert.ok(Number(w.svm.getBalance(w.buyer.publicKey)) - buyerBefore >= f.reward, "creator refunded the reward");
  assert.ok(isClosed(w.svm, f.workerBond), "worker bond forfeited + closed");
  assert.ok(isClosed(w.svm, f.creatorBond), "creator bond refunded + closed");
  // Revert-sensitive (audit: uphold branch never released the claim slot): drop the
  // release_claim_slot call in resolve_handler's else branch and these two go red,
  // leaving the worker permanently unable to claim again or deregister, and the task
  // permanently unclosable.
  assert.equal(Number(decode(w.svm, "AgentRegistration", w.providerAgent).active_tasks), 0, "worker claim slot released (active_tasks decremented)");
  assert.equal(Number(decode(w.svm, "Task", f.task).current_workers), 0, "task current_workers zeroed (close_task now possible)");
});

test("expire_reject_frozen: after the review window defaults to the worker + refunds both bonds (permissionless, exit-safe)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const f = await setupFrozen(w, { postBonds: true });
  const cleaner = Keypair.generate(); w.svm.airdrop(cleaner.publicKey, BigInt(10e9));
  const expireIx = async () => makeProgram(cleaner).methods.expireRejectFrozen()
    .accounts({ task: f.task, claim: f.claim, escrow: f.escrow, taskSubmission: f.submission, worker: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, creator: w.buyer.publicKey, workerAuthority: w.provider.publicKey, authority: cleaner.publicKey, creatorCompletionBond: f.creatorBond, workerCompletionBond: f.workerBond, systemProgram: SystemProgram.programId }).instruction();

  // before the review window lapses -> rejected.
  expectFail(send(w.svm, await expireIx(), [cleaner]), "RejectFrozenTimeoutNotElapsed", "expire too early");

  // warp past the review window (3600s) + pause to prove exit-safety.
  const clk = w.svm.getClock(); clk.unixTimestamp = clk.unixTimestamp + 4000n; w.svm.setClock(clk);
  await setProtocolPaused(w.svm, true);
  const workerBefore = Number(w.svm.getBalance(w.provider.publicKey));
  w.svm.expireBlockhash();
  expectOk(send(w.svm, await expireIx(), [cleaner]), "expire after window while paused");
  assert.ok(decode(w.svm, "Task", f.task).status.Completed !== undefined, "task defaults to worker (Completed)");
  assert.ok(Number(w.svm.getBalance(w.provider.publicKey)) > workerBefore, "worker paid on timeout");
  assert.ok(isClosed(w.svm, f.workerBond) && isClosed(w.svm, f.creatorBond), "both bonds refunded on no-fault timeout");
});

test("3-way split: max operator fee (20%) settles with the worker still above the 60% floor", async () => {
  const operatorKp = Keypair.generate();
  const w = await freshWorld({ moderationEnabled: true, price: 5_000_000, operator: operatorKp.publicKey, operatorFeeBps: 2000 });
  const r = await runHireSettlement(w);
  const operatorDelta = Number(w.svm.getBalance(operatorKp.publicKey)) - r.operatorBalBefore;
  assert.equal(operatorDelta, Math.floor((r.reward * 2000) / 10000), "operator gets exactly 20% at the cap"); // 1_000_000
  const workerDelta = Number(w.svm.getBalance(w.provider.publicKey)) - r.workerBalBefore;
  assert.ok(workerDelta >= Math.floor(r.reward * 0.6), `worker keeps >=60% at the cap (got ${workerDelta} of ${r.reward})`);
  assert.ok(isClosed(w.svm, r.escrow), "escrow closed");
});

test("close_task children: a program-owned non-child remaining account is rejected", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 2_000_000 });
  const r = await runHireSettlement(w); // Completed -> task closable; jobSpec + live hireRecord remain
  // Pass the ServiceListing (program-owned, but NOT one of the three task-child types)
  // as a remaining account: it must be rejected, not closed.
  const closeIx = await w.buyerProg.methods
    .closeTask()
    .accounts({ task: r.task, taskJobSpec: r.jobSpec, escrow: null, hireRecord: r.hireRecord, listing: w.listing, creatorCompletionBond: pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0], workerCompletionBond: null, authority: w.buyer.publicKey })
    .remainingAccounts([{ pubkey: w.listing, isSigner: false, isWritable: true }])
    .instruction();
  expectFail(send(w.svm, closeIx, [w.buyer]), "InvalidInput", "close_task rejects a non-child remaining account");
  assert.ok(!isClosed(w.svm, r.task), "task NOT closed (tx reverted)");
});

test("dispute: initiate -> expire settles the escrow while the protocol is paused (exit-safe)", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 3_000_000 });
  const r = await runHireSettlement(w, { stopBeforeComplete: true }); // claimed task, InProgress

  // worker initiates a dispute on their claimed task
  const taskId = decode(w.svm, "Task", r.task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.provider.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .initiateDispute(arr(disputeId), arr(taskId), arr(Buffer.alloc(32, 1)), 0, "evidence")
    .accounts({ dispute, task: r.task, agent: w.providerAgent, authorityRateLimit: rateLimit, protocolConfig: w.protocolPda, initiatorClaim: r.claim, workerAgent: null, workerClaim: null, taskSubmission: null, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "initiate_dispute");
  assert.ok(decode(w.svm, "Task", r.task).status.Disputed !== undefined, "task is Disputed");
  assert.ok(decode(w.svm, "Dispute", dispute).status.Active !== undefined, "dispute is Active");

  // warp past max_dispute_duration, pause, then expire (permissionless last-resort exit).
  const clk = w.svm.getClock();
  clk.unixTimestamp = clk.unixTimestamp + 604800n + 100n;
  w.svm.setClock(clk);
  await setProtocolPaused(w.svm, true);

  expectOk(send(w.svm, await w.providerProg.methods
    .expireDispute()
    .accounts({ dispute, task: r.task, escrow: r.escrow, protocolConfig: w.protocolPda, creator: w.buyer.publicKey, authority: w.provider.publicKey, workerClaim: r.claim, worker: w.providerAgent, workerWallet: w.provider.publicKey, hireRecord: r.hireRecord, disputeOperator: null, disputeReferrer: null, tokenEscrowAta: null, creatorTokenAccount: null, workerTokenAccountAta: null, rewardMint: null, tokenProgram: null, creatorCompletionBond: pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0], workerCompletionBond: pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()])[0] })
    .instruction(), [w.provider]), "expire_dispute while paused");

  // exit-safe: the escrow is settled (closed) and the dispute is no longer Active,
  // despite the protocol being paused (money never locks).
  assert.ok(isClosed(w.svm, r.escrow), "escrow settled by expire_dispute while paused");
  assert.ok(decode(w.svm, "Dispute", dispute).status.Active === undefined, "dispute no longer Active");
});

/// Drive an SPL-token task through Auto settlement: mint a token, fund the buyer,
/// create_task(reward_mint) (which CPI-creates + funds the token escrow ATA), moderate
/// -> publish -> claim -> complete_task with token accounts. Returns the token ATAs.
async function runTokenSettlement(w, { reward = 5_000_000 } = {}) {
  const modProg = makeProgram(w.modAuth);

  // 1) create + init the mint (admin is the mint authority, 0 decimals).
  const mint = Keypair.generate();
  const rent = Number(w.svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE)));
  expectOk(sendMany(w.svm, [
    SystemProgram.createAccount({ fromPubkey: w.admin.publicKey, newAccountPubkey: mint.publicKey, lamports: rent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeMintInstruction(mint.publicKey, 0, w.admin.publicKey, null),
  ], [w.admin, mint]), "token:mint");

  // 2) buyer (creator) ATA funded with the reward; treasury + worker ATAs (must pre-exist).
  const buyerAta = getAssociatedTokenAddressSync(mint.publicKey, w.buyer.publicKey);
  const treasuryAta = getAssociatedTokenAddressSync(mint.publicKey, w.admin.publicKey);
  const workerAta = getAssociatedTokenAddressSync(mint.publicKey, w.provider.publicKey);
  expectOk(sendMany(w.svm, [
    createAssociatedTokenAccountInstruction(w.admin.publicKey, buyerAta, w.buyer.publicKey, mint.publicKey),
    createAssociatedTokenAccountInstruction(w.admin.publicKey, treasuryAta, w.admin.publicKey, mint.publicKey),
    createAssociatedTokenAccountInstruction(w.admin.publicKey, workerAta, w.provider.publicKey, mint.publicKey),
    createMintToInstruction(mint.publicKey, buyerAta, w.admin.publicKey, reward),
  ], [w.admin]), "token:atas+fund");

  // 3) create_task with reward_mint (create_task CPI-creates + funds the escrow ATA).
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const escrowAta = getAssociatedTokenAddressSync(mint.publicKey, escrow, true);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(reward), 1, new BN(now + 3600), 0, null, 0, mint.publicKey, null, 0)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: mint.publicKey, creatorTokenAccount: buyerAta, tokenEscrowAta: escrowAta, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID })
    .instruction(), [w.buyer]), "token:create_task");

  // 4) moderate -> publish -> claim
  const jobHash = id32();
  const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "token:task-mod");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/token", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "token:publish");
  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "token:claim");

  // 5) complete_task with token accounts (operator leg is SOL-only -> none here).
  const [hireRecord] = pda([enc("hire"), task.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .completeTask(arr(id32()), null)
    .accounts({ task, claim, escrow, creator: w.buyer.publicKey, worker: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.provider.publicKey, systemProgram: SystemProgram.programId, tokenEscrowAta: escrowAta, workerTokenAccount: workerAta, treasuryTokenAccount: treasuryAta, rewardMint: mint.publicKey, tokenProgram: TOKEN_PROGRAM_ID, hireRecord, operator: null, referrer: null, creatorCompletionBond: null, workerCompletionBond: null })
    .instruction(), [w.provider]), "token:complete");

  return { task, escrow, mint: mint.publicKey, buyerAta, treasuryAta, workerAta, escrowAta, reward };
}

test("SPL-token settlement: complete pays worker + treasury in tokens (conservation), closes token escrow", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await runTokenSettlement(w, { reward: 5_000_000 });

  const t = decode(w.svm, "Task", r.task);
  assert.ok(t.status.Completed !== undefined, `task Completed (got ${JSON.stringify(t.status)})`);
  const workerTok = tokenAmount(w.svm, r.workerAta);
  const treasuryTok = tokenAmount(w.svm, r.treasuryAta);
  assert.ok(workerTok > 0n, "worker received reward tokens");
  assert.ok(treasuryTok > 0n, "treasury received the protocol fee in tokens");
  assert.equal(workerTok + treasuryTok, BigInt(r.reward), "worker + treasury == reward (token conservation)");
  assert.ok(isClosed(w.svm, r.escrowAta), "token escrow ATA closed on completion");
  assert.ok(isClosed(w.svm, r.escrow), "escrow PDA closed on completion");
});

test("dispute: resolve via assigned resolver settles while the protocol is paused (exit-safe, no votes)", async () => {
  // P6.3: the arbiter vote/quorum model is retired. The protocol authority resolves
  // directly (resolverAssignment = null) with the required P6.4 rationale, no arbiters,
  // no vote PDAs, and NO (vote, arbiter) remaining accounts.
  const w = await freshWorld({ moderationEnabled: true, price: 3_000_000 });
  const r = await runHireSettlement(w, { stopBeforeComplete: true }); // claimed task, InProgress

  // worker opens a dispute
  const taskId = decode(w.svm, "Task", r.task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [initRate] = pda([enc("authority_rate_limit"), w.provider.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .initiateDispute(arr(disputeId), arr(taskId), arr(Buffer.alloc(32, 1)), 0, "evidence")
    .accounts({ dispute, task: r.task, agent: w.providerAgent, authorityRateLimit: initRate, protocolConfig: w.protocolPda, initiatorClaim: r.claim, workerAgent: null, workerClaim: null, taskSubmission: null, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "resolve:initiate");

  // resolve while paused — exit-safe (money never locks). No voting-period wait is
  // needed anymore: an assigned resolver / the protocol authority decides directly.
  await setProtocolPaused(w.svm, true);
  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .resolveDispute(true, arr(Buffer.alloc(32, 5)), "agenc://ruling/refund")
    .accounts({ dispute, task: r.task, escrow: r.escrow, protocolConfig: w.protocolPda, authority: w.admin.publicKey, resolverAssignment: null, creator: w.buyer.publicKey, workerClaim: r.claim, worker: w.providerAgent, workerWallet: w.provider.publicKey, agentStats: null, hireRecord: r.hireRecord, disputeOperator: null, disputeReferrer: null, systemProgram: SystemProgram.programId, tokenEscrowAta: null, creatorTokenAccount: null, workerTokenAccountAta: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, creatorCompletionBond: pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0], workerCompletionBond: pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()])[0], bondTreasury: w.admin.publicKey })
    .instruction(), [w.admin]), "resolve_dispute while paused");

  assert.ok(decode(w.svm, "Dispute", dispute).status.Active === undefined, "dispute resolved (no longer Active) while paused");
  assert.ok(decode(w.svm, "Task", r.task).status.Disputed === undefined, "task left Disputed after resolve");
});

test("operator-fee protection: resolve_dispute Complete pays the operator its cut (dispute can't bypass the §4 split)", async () => {
  // Audit regression: resolve_dispute / expire_dispute paid the worker directly,
  // bypassing the operator leg that complete_task enforces. A hired task settled via
  // a Complete dispute must still carve the operator fee. Revert-sensitive: drop the
  // operator carve in resolve_dispute and the two equalities below go red.
  const operatorKp = Keypair.generate();
  const w = await freshWorld({ moderationEnabled: true, price: 3_000_000, operator: operatorKp.publicKey, operatorFeeBps: 1000 });
  const r = await runHireSettlement(w, { stopBeforeComplete: true }); // claimed, InProgress, live hire w/ 10% operator fee

  // worker opens a Complete dispute (resolution_type 1 = Complete -> worker is paid).
  const taskId = decode(w.svm, "Task", r.task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [initRate] = pda([enc("authority_rate_limit"), w.provider.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .initiateDispute(arr(disputeId), arr(taskId), arr(Buffer.alloc(32, 1)), 1, "evidence")
    .accounts({ dispute, task: r.task, agent: w.providerAgent, authorityRateLimit: initRate, protocolConfig: w.protocolPda, initiatorClaim: r.claim, workerAgent: null, workerClaim: null, taskSubmission: null, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "op-resolve:initiate Complete");

  // P6.3: the protocol authority resolves the Complete ruling directly — no arbiters,
  // no votes, no voting-period wait.
  const workerBalBefore = Number(w.svm.getBalance(w.provider.publicKey));
  const operatorBalBefore = Number(w.svm.getBalance(operatorKp.publicKey));
  // resolve_dispute also closes the worker_claim and refunds its rent to the worker
  // wallet, so the worker delta = worker_net + claim rent. Capture the rent for an exact check.
  const claimRentBefore = Number(w.svm.getBalance(r.claim));

  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .resolveDispute(true, arr(Buffer.alloc(32, 5)), "agenc://ruling/complete")
    .accounts({ dispute, task: r.task, escrow: r.escrow, protocolConfig: w.protocolPda, authority: w.admin.publicKey, resolverAssignment: null, creator: w.buyer.publicKey, workerClaim: r.claim, worker: w.providerAgent, workerWallet: w.provider.publicKey, agentStats: null, hireRecord: r.hireRecord, disputeOperator: operatorKp.publicKey, disputeReferrer: null, systemProgram: SystemProgram.programId, tokenEscrowAta: null, creatorTokenAccount: null, workerTokenAccountAta: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, creatorCompletionBond: pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0], workerCompletionBond: pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()])[0], bondTreasury: w.admin.publicKey })
    .instruction(), [w.admin]), "op-resolve:resolve Complete");

  assert.ok(decode(w.svm, "Task", r.task).status.Completed !== undefined, "task Completed via dispute");

  // §4 split: operator fee = reward * 1000bps = 10%; worker gets the rest. Neither
  // the worker wallet nor the operator signed this tx, so the deltas are exact.
  const expectedOpFee = Math.floor(r.reward / 10);          // 3_000_000 * 1000 / 10000
  const expectedWorkerNet = r.reward - expectedOpFee;       // 2_700_000
  const operatorDelta = Number(w.svm.getBalance(operatorKp.publicKey)) - operatorBalBefore;
  const workerDelta = Number(w.svm.getBalance(w.provider.publicKey)) - workerBalBefore;
  assert.equal(operatorDelta, expectedOpFee, `operator paid its cut on dispute Complete (got ${operatorDelta})`);
  assert.equal(workerDelta, expectedWorkerNet + claimRentBefore, `worker paid reward minus operator fee plus claim rent (got ${workerDelta})`);
});

test("completion bond: resolve_dispute Complete refunds the worker bond + forfeits the creator bond to treasury", async () => {
  // Worker wins (Complete) -> worker bond refunded, creator (loser) bond forfeited to
  // treasury. Revert-sensitive: without the disposition both bonds stay open.
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000 });
  const r = await runHireSettlement(w, { stopBeforeComplete: true });

  const creatorBond = pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0];
  const workerBond = pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()])[0];
  expectOk(send(w.svm, await w.buyerProg.methods.postCompletionBond(0)
    .accounts({ task: r.task, completionBond: creatorBond, authority: w.buyer.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.buyer]), "creator bond");
  expectOk(send(w.svm, await w.providerProg.methods.postCompletionBond(1)
    .accounts({ task: r.task, completionBond: workerBond, authority: w.provider.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.provider]), "worker bond");
  const bondPrincipal = Math.floor(r.reward / 4); // 25% = 1,000,000

  // worker opens a Complete dispute; P6.3: the protocol authority rules directly (no
  // arbiters, no votes).
  const taskId = decode(w.svm, "Task", r.task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [initRate] = pda([enc("authority_rate_limit"), w.provider.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .initiateDispute(arr(disputeId), arr(taskId), arr(Buffer.alloc(32, 1)), 1, "evidence")
    .accounts({ dispute, task: r.task, agent: w.providerAgent, authorityRateLimit: initRate, protocolConfig: w.protocolPda, initiatorClaim: r.claim, workerAgent: null, workerClaim: null, taskSubmission: null, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "bond-resolve:initiate");

  const treasuryBefore = Number(w.svm.getBalance(w.admin.publicKey));
  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .resolveDispute(true, arr(Buffer.alloc(32, 5)), "agenc://ruling/complete")
    .accounts({ dispute, task: r.task, escrow: r.escrow, protocolConfig: w.protocolPda, authority: w.admin.publicKey, resolverAssignment: null, creator: w.buyer.publicKey, workerClaim: r.claim, worker: w.providerAgent, workerWallet: w.provider.publicKey, agentStats: null, hireRecord: r.hireRecord, disputeOperator: null, disputeReferrer: null, systemProgram: SystemProgram.programId, tokenEscrowAta: null, creatorTokenAccount: null, workerTokenAccountAta: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, creatorCompletionBond: creatorBond, workerCompletionBond: workerBond, bondTreasury: w.admin.publicKey })
    .instruction(), [w.admin]), "bond-resolve:resolve Complete");

  assert.ok(decode(w.svm, "Task", r.task).status.Completed !== undefined, "task Completed");
  assert.ok(isClosed(w.svm, creatorBond), "creator (loser) bond closed");
  assert.ok(isClosed(w.svm, workerBond), "worker (winner) bond closed");
  // treasury (admin) is also the resolver/fee-payer, so its delta is the forfeited
  // creator-bond principal minus the tx fee — well within 50k of the principal.
  const treasuryDelta = Number(w.svm.getBalance(w.admin.publicKey)) - treasuryBefore;
  assert.ok(treasuryDelta > bondPrincipal - 50_000 && treasuryDelta <= bondPrincipal,
    `creator bond forfeited to treasury (delta ${treasuryDelta}, principal ${bondPrincipal})`);
});

test("completion bond: resolve_dispute rejects a non-canonical (junk) forfeit-due bond account", async () => {
  // Revert-sensitive guard for the canonical-PDA pin. A resolver must not be able to
  // pass a junk (system-owned) account for the forfeit-due creator bond: settle no-ops
  // on any non-program-owned account, so without the pin the forfeit would silently be
  // SKIPPED, leaving the real bond at its canonical PDA for reclaim_completion_bond to
  // refund to the loser on the now-Completed task — inverting the forfeit. With the pin,
  // the tx fails atomically (MissingCompletionBondAccount) and nothing settles.
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000 });
  const r = await runHireSettlement(w, { stopBeforeComplete: true });

  const creatorBond = pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0];
  const workerBond = pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()])[0];
  expectOk(send(w.svm, await w.buyerProg.methods.postCompletionBond(0)
    .accounts({ task: r.task, completionBond: creatorBond, authority: w.buyer.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.buyer]), "junk-bond:creator bond");
  expectOk(send(w.svm, await w.providerProg.methods.postCompletionBond(1)
    .accounts({ task: r.task, completionBond: workerBond, authority: w.provider.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.provider]), "junk-bond:worker bond");

  // worker opens a Complete dispute (worker wins -> creator bond is forfeit-due); P6.3:
  // the protocol authority rules directly (no arbiters, no votes).
  const taskId = decode(w.svm, "Task", r.task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [initRate] = pda([enc("authority_rate_limit"), w.provider.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .initiateDispute(arr(disputeId), arr(taskId), arr(Buffer.alloc(32, 1)), 1, "evidence")
    .accounts({ dispute, task: r.task, agent: w.providerAgent, authorityRateLimit: initRate, protocolConfig: w.protocolPda, initiatorClaim: r.claim, workerAgent: null, workerClaim: null, taskSubmission: null, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "junk-bond:initiate");

  // Substitute a junk pubkey for the forfeit-due creator bond. Pre-pin this would no-op
  // (forfeit skipped); post-pin it must be rejected.
  const junkBond = Keypair.generate().publicKey;
  expectFail(send(w.svm, await makeProgram(w.admin).methods
    .resolveDispute(true, arr(Buffer.alloc(32, 5)), "agenc://ruling/complete")
    .accounts({ dispute, task: r.task, escrow: r.escrow, protocolConfig: w.protocolPda, authority: w.admin.publicKey, resolverAssignment: null, creator: w.buyer.publicKey, workerClaim: r.claim, worker: w.providerAgent, workerWallet: w.provider.publicKey, agentStats: null, hireRecord: r.hireRecord, disputeOperator: null, disputeReferrer: null, systemProgram: SystemProgram.programId, tokenEscrowAta: null, creatorTokenAccount: null, workerTokenAccountAta: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, creatorCompletionBond: junkBond, workerCompletionBond: workerBond, bondTreasury: w.admin.publicKey })
    .instruction(), [w.admin]), "MissingCompletionBondAccount", "junk-bond:resolve must reject non-canonical creator bond");

  // Nothing settled: the dispute is still Active and the real creator bond is still open.
  assert.ok(decode(w.svm, "Dispute", dispute).status.Active !== undefined, "dispute still Active after rejected resolve");
  assert.ok(!isClosed(w.svm, creatorBond), "real creator bond untouched (forfeit not skipped)");
});

test("dispute: apply_dispute_slash slashes the losing worker while the protocol is paused (exit-safe, roster ruling)", async () => {
  // P6.3: no arbiters, no votes — the protocol authority rules a Refund (worker loses)
  // directly. The slash decision is recovered from the resolver's ruling bit, not a tally.
  const w = await freshWorld({ moderationEnabled: true, price: 3_000_000 });
  const r = await runHireSettlement(w, { stopBeforeComplete: true }); // claimed task, InProgress
  await injectAgentStake(w.svm, w.providerAgent, 2_000_000); // worker has a slashable stake

  // CREATOR opens a Refund dispute against the worker (resolution_type 0 = Refund).
  const taskId = decode(w.svm, "Task", r.task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [buyerRate] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.buyerProg.methods
    .initiateDispute(arr(disputeId), arr(taskId), arr(Buffer.alloc(32, 1)), 0, "bad work")
    .accounts({ dispute, task: r.task, agent: w.buyerAgent, authorityRateLimit: buyerRate, protocolConfig: w.protocolPda, initiatorClaim: null, workerAgent: w.providerAgent, workerClaim: r.claim, taskSubmission: null, authority: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "slash:initiate");

  // Resolve (approve the Refund -> worker loses, slash deferred). No arbiters, no votes,
  // no remaining accounts.
  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .resolveDispute(true, arr(Buffer.alloc(32, 5)), "agenc://ruling/refund")
    .accounts({ dispute, task: r.task, escrow: r.escrow, protocolConfig: w.protocolPda, authority: w.admin.publicKey, resolverAssignment: null, creator: w.buyer.publicKey, workerClaim: r.claim, worker: w.providerAgent, workerWallet: w.provider.publicKey, agentStats: null, hireRecord: r.hireRecord, disputeOperator: null, disputeReferrer: null, systemProgram: SystemProgram.programId, tokenEscrowAta: null, creatorTokenAccount: null, workerTokenAccountAta: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, creatorCompletionBond: pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0], workerCompletionBond: pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()])[0], bondTreasury: w.admin.publicKey })
    .instruction(), [w.admin]), "slash:resolve");
  assert.ok(decode(w.svm, "Dispute", dispute).status.Resolved !== undefined, "dispute Resolved (worker lost)");
  const stakeBefore = Number(decode(w.svm, "AgentRegistration", w.providerAgent).stake);

  // apply the stake slash WHILE PAUSED — the finalizer that has no alternative unwind.
  await setProtocolPaused(w.svm, true);
  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .applyDisputeSlash()
    .accounts({ dispute, task: r.task, workerClaim: r.claim, workerAgent: w.providerAgent, workerAuthority: w.provider.publicKey, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.admin.publicKey, escrow: null, tokenEscrowAta: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null })
    .instruction(), [w.admin]), "slash:apply_dispute_slash while paused");

  const stakeAfter = Number(decode(w.svm, "AgentRegistration", w.providerAgent).stake);
  assert.ok(stakeAfter < stakeBefore, `worker stake slashed while paused (${stakeBefore} -> ${stakeAfter})`);
});

// --- Assignable dispute-resolver roster: a single assigned person decides, no votes/quorum ---
async function openCompleteDispute(w, r) {
  const taskId = decode(w.svm, "Task", r.task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [initRate] = pda([enc("authority_rate_limit"), w.provider.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .initiateDispute(arr(disputeId), arr(taskId), arr(Buffer.alloc(32, 1)), 1, "evidence") // 1 = Complete
    .accounts({ dispute, task: r.task, agent: w.providerAgent, authorityRateLimit: initRate, protocolConfig: w.protocolPda, initiatorClaim: r.claim, workerAgent: null, workerClaim: null, taskSubmission: null, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "roster:initiate");
  return dispute;
}

async function resolveAsDispute(w, r, dispute, prog, signerPubkey, resolverAssignment, approve) {
  // P6.4 rationale args are required; P6.3: no votes/arbiters/remaining accounts.
  return prog.methods
    .resolveDispute(approve, arr(Buffer.alloc(32, 5)), "agenc://ruling/roster")
    .accounts({ dispute, task: r.task, escrow: r.escrow, protocolConfig: w.protocolPda, authority: signerPubkey, resolverAssignment, creator: w.buyer.publicKey, workerClaim: r.claim, worker: w.providerAgent, workerWallet: w.provider.publicKey, agentStats: null, hireRecord: r.hireRecord, disputeOperator: null, disputeReferrer: null, systemProgram: SystemProgram.programId, tokenEscrowAta: null, creatorTokenAccount: null, workerTokenAccountAta: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, creatorCompletionBond: pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0], workerCompletionBond: pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()])[0], bondTreasury: w.admin.publicKey })
    .instruction();
}

test("dispute roster: an ASSIGNED resolver (not the protocol authority) resolves directly — no votes, no quorum, no voting-period wait", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 3_000_000 });
  const r = await runHireSettlement(w, { stopBeforeComplete: true });
  const dispute = await openCompleteDispute(w, r);

  // An unassigned wallet cannot resolve (gating).
  const stranger = Keypair.generate();
  w.svm.airdrop(stranger.publicKey, BigInt(10e9));
  expectFail(send(w.svm, await resolveAsDispute(w, r, dispute, makeProgram(stranger), stranger.publicKey, null, true), [stranger]),
    "UnauthorizedResolver", "roster:unassigned wallet rejected");

  // The protocol authority assigns a specific resolver.
  const resolver = Keypair.generate();
  w.svm.airdrop(resolver.publicKey, BigInt(10e9));
  const [assignment] = pda([enc("dispute_resolver"), resolver.publicKey.toBuffer()]);
  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .assignDisputeResolver(resolver.publicKey)
    .accounts({ protocolConfig: w.protocolPda, disputeResolver: assignment, authority: w.admin.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.admin]), "roster:assign");
  const a = decode(w.svm, "DisputeResolver", assignment);
  assert.equal(a.resolver.toBase58(), resolver.publicKey.toBase58(), "assignment records the resolver");

  // The assigned resolver — NOT the protocol authority — resolves the dispute directly.
  // No arbiters voted, no quorum, and we never warped past voting_deadline: this single
  // success guards ALL THREE removed gates (authority-only, quorum>=3, voting-period wait).
  expectOk(send(w.svm, await resolveAsDispute(w, r, dispute, makeProgram(resolver), resolver.publicKey, assignment, true), [resolver]),
    "roster:assigned resolver resolves");
  assert.ok(decode(w.svm, "Task", r.task).status.Completed !== undefined, "task Completed by the assigned resolver");
  assert.ok(decode(w.svm, "Dispute", dispute).status.Active === undefined, "dispute no longer Active");
});

test("dispute roster: revoke removes the resolver's authority", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 3_000_000 });
  const r = await runHireSettlement(w, { stopBeforeComplete: true });
  const dispute = await openCompleteDispute(w, r);

  const resolver = Keypair.generate();
  w.svm.airdrop(resolver.publicKey, BigInt(10e9));
  const [assignment] = pda([enc("dispute_resolver"), resolver.publicKey.toBuffer()]);
  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .assignDisputeResolver(resolver.publicKey)
    .accounts({ protocolConfig: w.protocolPda, disputeResolver: assignment, authority: w.admin.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.admin]), "roster:assign");

  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .revokeDisputeResolver()
    .accounts({ protocolConfig: w.protocolPda, disputeResolver: assignment, authority: w.admin.publicKey })
    .instruction(), [w.admin]), "roster:revoke");
  assert.ok(isClosed(w.svm, assignment), "assignment PDA closed on revoke");

  // With the assignment gone, the (formerly assigned) resolver is just a stranger again.
  expectFail(send(w.svm, await resolveAsDispute(w, r, dispute, makeProgram(resolver), resolver.publicKey, null, true), [resolver]),
    "UnauthorizedResolver", "roster:revoked resolver rejected");
});

test("create_task_humanless: a wallet with no agent posts a task pinned to CreatorReview", async () => {
  const w = await freshWorld({});
  const human = Keypair.generate(); // NO AgentRegistration
  w.svm.airdrop(human.publicKey, BigInt(100e9));
  const humanProg = makeProgram(human);

  const taskId = id32();
  const [task] = pda([enc("task"), human.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [validation] = pda([enc("task_validation"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), human.publicKey.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0); // hash-shaped commitment (32 + zero tail)

  const ix = await humanProg.methods
    .createTaskHumanless(arr(taskId), new BN(1), arr(desc), new BN(2_000_000), new BN(now + 3600), 0, new BN(3600), null, 0)
    .accounts({ task, escrow, taskValidationConfig: validation, protocolConfig: w.protocolPda, authorityRateLimit: rateLimit, creator: human.publicKey, systemProgram: SystemProgram.programId })
    .instruction();
  expectOk(send(w.svm, ix, [human]), "humanless create");

  const t = decode(w.svm, "Task", task);
  assert.equal(t.creator.toBase58(), human.publicKey.toBase58(), "human wallet is the creator");
  assert.ok(t.status.Open !== undefined, "task starts Open");
  assert.equal(t.reward_amount.toString(), "2000000");
  assert.equal(decode(w.svm, "TaskEscrow", escrow).amount.toString(), "2000000", "escrow funded");

  const vc = decode(w.svm, "TaskValidationConfig", validation);
  assert.ok(vc.CreatorReview !== undefined || vc.mode?.creatorReview !== undefined || vc.mode?.CreatorReview !== undefined, `validation mode is CreatorReview (got ${JSON.stringify(vc.mode)})`);
});

test("exit allow-list: a paused protocol blocks new hires but still lets a hired task be cancelled", async () => {
  const w = await freshWorld({ price: 1_500_000 });
  const { ix, task, escrow } = await hireIx(w, {});
  expectOk(send(w.svm, ix, [w.buyer]), "hire (before pause)");

  // Pause the protocol AFTER the task is escrowed.
  await setProtocolPaused(w.svm, true);

  // Sanity: the pause is real — a NEW hire (entry path) is rejected. This proves
  // the cancel-succeeds assertion below isn't passing vacuously.
  const blocked = await hireIx(w, {}); // fresh task id
  expectFail(send(w.svm, blocked.ix, [w.buyer]), "ProtocolPaused", "entry blocked while paused");

  // Exit path: cancelling the escrowed task must still succeed while paused —
  // money never locks (spec §7, exit allow-list). Without the exit variant this
  // would fail with ProtocolPaused.
  const cancelIx = await w.buyerProg.methods
    .cancelTask()
    .accounts({
      task, escrow, authority: w.buyer.publicKey, protocolConfig: w.protocolPda,
      systemProgram: SystemProgram.programId,
      tokenEscrowAta: null, creatorTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: null, workerCompletionBond: null, workerBondAuthority: null,
      creatorAgent: null, agentStats: null,
    })
    .instruction();
  expectOk(send(w.svm, cancelIx, [w.buyer]), "cancel under paused protocol");
  assert.ok(decode(w.svm, "Task", task).status.Cancelled !== undefined, "task is Cancelled even while paused");
  assert.ok(isClosed(w.svm, escrow), "escrow refunded/closed while paused");
});

test("close_task children: reclaims rent from a task_moderation child via remaining_accounts", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 2_000_000 });
  const r = await runHireSettlement(w); // Completed; leaves task, job spec, task_moderation, live hire_record
  assert.ok(!isClosed(w.svm, r.taskMod), "task_moderation present before close");
  assert.ok(!isClosed(w.svm, r.jobSpec), "task_job_spec present before close");

  const closeIx = await w.buyerProg.methods
    .closeTask()
    .accounts({ task: r.task, taskJobSpec: r.jobSpec, escrow: null, hireRecord: r.hireRecord, listing: w.listing, creatorCompletionBond: pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0], workerCompletionBond: null, authority: w.buyer.publicKey })
    .remainingAccounts([{ pubkey: r.taskMod, isSigner: false, isWritable: true }])
    .instruction();
  expectOk(send(w.svm, closeIx, [w.buyer]), "close_task with moderation child");

  assert.ok(isClosed(w.svm, r.task), "task closed");
  assert.ok(isClosed(w.svm, r.jobSpec), "task_job_spec rent reclaimed");
  assert.ok(isClosed(w.svm, r.taskMod), "task_moderation rent reclaimed");
  assert.equal(decode(w.svm, "ServiceListing", w.listing).open_jobs, 0, "listing capacity freed");
});

test("close_task children: rejects a child PDA bound to a different task (anti-griefing)", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 2_000_000 });
  const a = await runHireSettlement(w); // task A + its task_moderation
  const b = await runHireSettlement(w); // task B + its task_moderation (same world)

  // Try to close task A while passing task B's moderation as a remaining account.
  const closeIx = await w.buyerProg.methods
    .closeTask()
    .accounts({ task: a.task, taskJobSpec: a.jobSpec, escrow: null, hireRecord: a.hireRecord, listing: w.listing, creatorCompletionBond: pda([enc("completion_bond"), a.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0], workerCompletionBond: null, authority: w.buyer.publicKey })
    .remainingAccounts([{ pubkey: b.taskMod, isSigner: false, isWritable: true }])
    .instruction();
  expectFail(send(w.svm, closeIx, [w.buyer]), "InvalidInput", "close_task rejects another task's moderation child");

  // The whole tx reverted: task A is untouched and task B's moderation survives.
  assert.ok(!isClosed(w.svm, a.task), "task A NOT closed (tx reverted)");
  assert.ok(!isClosed(w.svm, b.taskMod), "task B moderation untouched");
});

test("negative: close_task rejects a non-terminal (Open) task", async () => {
  const w = await freshWorld({});
  const { ix, task, hireRecord } = await hireIx(w, {});
  expectOk(send(w.svm, ix, [w.buyer]), "hire");

  const closeIx = await w.buyerProg.methods
    .closeTask()
    .accounts({ task, taskJobSpec: null, escrow: null, hireRecord, listing: w.listing, creatorCompletionBond: pda([enc("completion_bond"), task.toBuffer(), w.buyer.publicKey.toBuffer()])[0], workerCompletionBond: null, authority: w.buyer.publicKey })
    .instruction();
  expectFail(send(w.svm, closeIx, [w.buyer]), "TaskNotClosable", "close Open task");
});
