// Batch-2 surface — in-process litesvm integration tests.
//
// Executes the COMPILED program (target/deploy/agenc_coordination.so) end-to-end for
// the four batch-2 additions:
//
//   (1) P5.2 store identity — register_store / update_store / close_store: one Store
//       per wallet, 0.05 SOL bond ENFORCED by an in-handler CPI (never confiscatable,
//       refunded in full at close), owner-only mutation, version CAS bump.
//   (2) P1.3 moderation liveness — moderation_heartbeat authorization + window rules,
//       AND the deadman e2e: a silent moderation authority past the liveness window
//       relaxes the ALLOW gate (hire passes without a listing attestation); one
//       heartbeat re-arms strict mode.
//   (3) P3.6 §3.3 dispute referrer leg — a referred hire settling via
//       resolve_dispute(Complete) pays the snapshotted referrer + operator legs and
//       the worker gets gross minus BOTH; omitting the referrer payee account fails
//       closed (MissingReferrerAccount).
//   (4) SCALE_COST_MODEL R1 — close_task's child whitelist now reclaims
//       TaskAttestorConfig rent (~0.00178 SOL per reviewed task, the dominant
//       per-task burn), still rejecting another task's account.
//
// REVERT-SENSITIVE INTENT:
//   - Remove the TaskAttestorConfig arm in close_task_child -> test (4)'s close send
//     fails (InvalidInput) and the "attestor config reclaimed" assertion goes red.
//   - Remove the referrer leg from pay_dispute_marketplace_legs -> test (3)'s
//     referrer-delta assertion goes red (referrer unpaid, worker over-paid).
//   - Force moderation_gate_relaxed() to false (delete the deadman) -> test (2e2e)'s
//     "hire passes with NO listing attestation" send fails; force it true -> the
//     post-heartbeat strict re-arm expectFail goes red.
//   - Drop the bond CPI in register_store -> the PDA-lamports assertion in (1) goes
//     red (rent-only balance).
//
// Run:  cd agenc-protocol && node --test tests-integration/batch2-surface.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import {
  enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode, isClosed, coder,
  freshWorld, hireIx,
  taskModV2Pda, listingModV2Pda, moderationBlockPda,
  BN, Keypair, PublicKey, SystemProgram, PID,
} from "./harness.mjs";

const STORE_BOND = 50_000_000; // STORE_REGISTRATION_BOND_LAMPORTS (0.05 SOL)
const DAY = 86_400;
const DEFAULT_LIVENESS_WINDOW = 7_776_000; // 90 days

const storePda = (owner) => pda([enc("store"), owner.toBuffer()]);

// Zero-padded [u8; 32] display handle.
function handleBytes(s) {
  const h = Buffer.alloc(32);
  h.write(s, "utf8");
  return arr(h);
}

function storeArgs({ handle = "my-store", uri = "https://example.com/.well-known/agenc-store.json", referrerFeeBps = 250, operator = PublicKey.default, operatorFeeBps = 0, domain = "" } = {}) {
  return [handleBytes(handle), arr(Buffer.alloc(32, 3)), uri, referrerFeeBps, operator, operatorFeeBps, domain];
}

// ---------------------------------------------------------------------------
// (1) P5.2 store identity lifecycle: register (bond enforced) -> duplicate
// rejected -> owner-only update (version bump) -> close refunds rent + bond ->
// re-register after close re-inits fresh.
// ---------------------------------------------------------------------------
test("store identity: register enforces the bond, update is owner-only + version-bumped, close refunds rent + bond in full", async () => {
  const w = await freshWorld();
  const owner = Keypair.generate();
  w.svm.airdrop(owner.publicKey, BigInt(10e9));
  const [store] = storePda(owner.publicKey);
  const prog = makeProgram(owner);

  const balBefore = Number(w.svm.getBalance(owner.publicKey));
  expectOk(send(w.svm, await prog.methods
    .registerStore(...storeArgs({ domain: "example.com" }))
    .accounts({ store, owner: owner.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [owner]), "b2:register_store");

  const s = decode(w.svm, "Store", store);
  assert.equal(s.owner.toBase58(), owner.publicKey.toBase58(), "owner stamped");
  assert.equal(Buffer.from(s.handle).toString("utf8").replace(/\0+$/, ""), "my-store", "handle stored");
  assert.equal(s.referrer_fee_bps, 250, "referrer bps stored");
  assert.equal(s.bond_lamports.toString(), String(STORE_BOND), "bond bookkeeping stored");
  assert.equal(s.version.toString(), "1", "fresh store starts at version 1");

  // The PDA actually HOLDS rent + bond (the in-handler CPI cannot be skipped).
  const storeLamports = Number(w.svm.getBalance(store));
  const rentOnly = Number(w.svm.minimumBalanceForRentExemption(BigInt(w.svm.getAccount(store).data.length)));
  assert.equal(storeLamports, rentOnly + STORE_BOND, `store PDA holds rent (${rentOnly}) + bond (${STORE_BOND})`);

  // One store per wallet: a second register fails at account creation (init).
  expectFail(send(w.svm, await prog.methods
    .registerStore(...storeArgs({ handle: "second-try" }))
    .accounts({ store, owner: owner.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [owner]), "already in use", "b2:duplicate register rejected");

  // Non-owner cannot update (has_one = owner).
  const stranger = Keypair.generate();
  w.svm.airdrop(stranger.publicKey, BigInt(1e9));
  expectFail(send(w.svm, await makeProgram(stranger).methods
    .updateStore(...storeArgs({ handle: "stolen-store" }))
    .accounts({ store, owner: stranger.publicKey })
    .instruction(), [stranger]), "AnchorError", "b2:non-owner update rejected");

  // Owner update: fields change, version bumps monotonically.
  expectOk(send(w.svm, await prog.methods
    .updateStore(...storeArgs({ handle: "renamed-store", referrerFeeBps: 500 }))
    .accounts({ store, owner: owner.publicKey })
    .instruction(), [owner]), "b2:update_store");
  const s2 = decode(w.svm, "Store", store);
  assert.equal(Buffer.from(s2.handle).toString("utf8").replace(/\0+$/, ""), "renamed-store", "handle updated");
  assert.equal(s2.referrer_fee_bps, 500, "referrer bps updated");
  assert.equal(s2.version.toString(), "2", "version bumped on update");

  // Invalid handle (uppercase) is rejected by validation.
  expectFail(send(w.svm, await prog.methods
    .updateStore(...storeArgs({ handle: "BadHandle" }))
    .accounts({ store, owner: owner.publicKey })
    .instruction(), [owner]), "InvalidStoreHandle", "b2:uppercase handle rejected");

  // Close refunds rent + bond in ONE step to the owner (never confiscatable).
  const balBeforeClose = Number(w.svm.getBalance(owner.publicKey));
  expectOk(send(w.svm, await prog.methods
    .closeStore()
    .accounts({ store, owner: owner.publicKey })
    .instruction(), [owner]), "b2:close_store");
  assert.ok(isClosed(w.svm, store), "store PDA closed");
  const refund = Number(w.svm.getBalance(owner.publicKey)) - balBeforeClose;
  assert.ok(refund >= rentOnly + STORE_BOND - 50_000,
    `close refunded rent + bond (delta ${refund}, expected ~${rentOnly + STORE_BOND})`);
  // Round-trip sanity: owner only lost tx fees across register -> close.
  assert.ok(balBefore - Number(w.svm.getBalance(owner.publicKey)) < 100_000,
    "register->close round trip costs only tx fees");

  // Re-register after close re-inits a FRESH entry (version resets).
  expectOk(send(w.svm, await prog.methods
    .registerStore(...storeArgs({ handle: "reborn" }))
    .accounts({ store, owner: owner.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [owner]), "b2:re-register after close");
  assert.equal(decode(w.svm, "Store", store).version.toString(), "1", "re-registered store starts fresh at version 1");
});

// ---------------------------------------------------------------------------
// (2) P1.3 moderation_heartbeat: authorization + window-change rules.
// ---------------------------------------------------------------------------
test("moderation_heartbeat: authority/mod-authority may heartbeat; window change is config-authority-only and floored at 1 day", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const hbAccounts = (signer) => ({ moderationConfig: w.modCfg, authority: signer.publicKey });

  // The moderation authority may heartbeat (no window change).
  expectOk(send(w.svm, await makeProgram(w.modAuth).methods
    .moderationHeartbeat(null)
    .accounts(hbAccounts(w.modAuth))
    .instruction(), [w.modAuth]), "b2:modAuth heartbeat");
  const afterHb = decode(w.svm, "ModerationConfig", w.modCfg);
  assert.ok(Number(afterHb.updated_at) > 0, "heartbeat stamped updated_at");

  // ...but may NOT retune the window (config authority only).
  expectFail(send(w.svm, await makeProgram(w.modAuth).methods
    .moderationHeartbeat(7 * DAY)
    .accounts(hbAccounts(w.modAuth))
    .instruction(), [w.modAuth]), "UnauthorizedModerationHeartbeat", "b2:modAuth window change rejected");

  // The config authority may — but not below the 1-day floor.
  expectFail(send(w.svm, await makeProgram(w.admin).methods
    .moderationHeartbeat(DAY - 1)
    .accounts(hbAccounts(w.admin))
    .instruction(), [w.admin]), "InvalidModerationLivenessWindow", "b2:sub-floor window rejected");
  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .moderationHeartbeat(7 * DAY)
    .accounts(hbAccounts(w.admin))
    .instruction(), [w.admin]), "b2:authority retunes window to 7d");
  const cfg = decode(w.svm, "ModerationConfig", w.modCfg);
  const carvedWindow = Buffer.from(cfg._reserved.slice(0, 4)).readUInt32LE(0);
  assert.equal(carvedWindow, 7 * DAY, "liveness window carved into _reserved[0..4]");

  // A random signer can do neither.
  const rando = Keypair.generate();
  w.svm.airdrop(rando.publicKey, BigInt(1e9));
  expectFail(send(w.svm, await makeProgram(rando).methods
    .moderationHeartbeat(null)
    .accounts(hbAccounts(rando))
    .instruction(), [rando]), "UnauthorizedModerationHeartbeat", "b2:random signer rejected");
});

// ---------------------------------------------------------------------------
// (2 e2e) The liveness deadman: a once-live moderation authority silent past the
// window relaxes the hire ALLOW gate to moderation-optional (no listing
// attestation required); one heartbeat instantly re-arms strict mode. The BLOCK
// floor is out of scope here (it is never relaxed and has its own tests).
// ---------------------------------------------------------------------------
test("moderation liveness deadman: silence past the window relaxes the hire gate; a heartbeat re-arms it", async () => {
  const w = await freshWorld({ moderationEnabled: true });

  // Make the config a once-live-then-silent authority: updated_at far enough in
  // the past that the default 90-day window has elapsed on the SVM clock.
  const now = Number(w.svm.getClock().unixTimestamp);
  const stale = {
    authority: w.admin.publicKey,
    moderation_authority: w.modAuth.publicKey,
    enabled: true,
    created_at: new BN(1),
    updated_at: new BN(now - DEFAULT_LIVENESS_WINDOW - 3600),
    bump: pda([enc("moderation_config")])[1],
    _reserved: Array(6).fill(0),
  };
  const data = await coder.accounts.encode("ModerationConfig", stale);
  w.svm.setAccount(w.modCfg, {
    lamports: Number(w.svm.minimumBalanceForRentExemption(BigInt(data.length))),
    data, owner: PID, executable: false, rentEpoch: 0,
  });

  // STRICT would reject this hire (moderation enabled, NO listing attestation).
  // The deadman relaxes it: the hire passes.
  const { ix: relaxedHire } = await hireIx(w, { taskId: id32() });
  expectOk(send(w.svm, relaxedHire, [w.buyer]),
    "b2:hire passes with NO listing attestation once the authority is silent past the window");

  // One heartbeat re-arms strict mode: the same shape of hire now fails again.
  expectOk(send(w.svm, await makeProgram(w.modAuth).methods
    .moderationHeartbeat(null)
    .accounts({ moderationConfig: w.modCfg, authority: w.modAuth.publicKey })
    .instruction(), [w.modAuth]), "b2:heartbeat re-arms");
  const { ix: strictHire } = await hireIx(w, { taskId: id32() });
  expectFail(send(w.svm, strictHire, [w.buyer]), "TaskModerationRequired",
    "b2:hire without attestation rejected again after the heartbeat");
});

// ---------------------------------------------------------------------------
// (3) P3.6 §3.3 — dispute exits honor the snapshotted referrer leg. A referred
// hire resolved Complete pays operator AND referrer from the worker's gross;
// omitting the referrer payee account fails closed.
// ---------------------------------------------------------------------------
test("dispute referrer leg: resolve_dispute(Complete) pays the snapshotted referrer + operator; omitting the referrer account fails closed", async () => {
  const REWARD = 3_000_000;
  const OP_BPS = 1000;   // 10%
  const REF_BPS = 500;   // 5%
  const operatorKp = Keypair.generate();
  const referrerKp = Keypair.generate();
  const w = await freshWorld({ moderationEnabled: true, price: REWARD, operator: operatorKp.publicKey, operatorFeeBps: OP_BPS });
  const modProg = makeProgram(w.modAuth);

  // Clean listing attestation so the hire passes the (strict) gate.
  const [listingMod] = listingModV2Pda(w.listing, w.specHash, w.modAuth.publicKey);
  expectOk(send(w.svm, await modProg.methods
    .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "b2ref:listing-mod");

  // REFERRED hire: the referrer terms are snapshotted at hire time.
  const taskId = id32();
  const { ix: hix, task, escrow, hireRecord } = await hireIx(w, { taskId, listingModeration: listingMod, referrer: referrerKp.publicKey, referrerFeeBps: REF_BPS });
  expectOk(send(w.svm, hix, [w.buyer]), "b2ref:referred hire");
  const h = decode(w.svm, "HireRecord", hireRecord);
  assert.equal(h.referrer.toBase58(), referrerKp.publicKey.toBase58(), "referrer snapshotted on the HireRecord");
  assert.equal(h.referrer_fee_bps, REF_BPS, "referrer bps snapshotted");

  // Publish job spec -> worker claims (the standard reviewed choreography).
  const jobHash = id32();
  const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "b2ref:task-mod");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/b2ref", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "b2ref:publish");
  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "b2ref:claim");

  // Worker opens a Complete dispute (resolution_type 1 -> worker is paid).
  const tid = decode(w.svm, "Task", task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [initRate] = pda([enc("authority_rate_limit"), w.provider.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .initiateDispute(arr(disputeId), arr(tid), arr(Buffer.alloc(32, 1)), 1, "evidence")
    .accounts({ dispute, task, agent: w.providerAgent, authorityRateLimit: initRate, protocolConfig: w.protocolPda, initiatorClaim: claim, workerAgent: null, workerClaim: null, taskSubmission: null, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "b2ref:initiate Complete");

  const resolveAccounts = (disputeReferrer) => ({
    dispute, task, escrow, protocolConfig: w.protocolPda, authority: w.admin.publicKey,
    resolverAssignment: null, creator: w.buyer.publicKey, workerClaim: claim,
    worker: w.providerAgent, workerWallet: w.provider.publicKey, agentStats: null,
    hireRecord, disputeOperator: operatorKp.publicKey, disputeReferrer,
    systemProgram: SystemProgram.programId,
    tokenEscrowAta: null, creatorTokenAccount: null, workerTokenAccountAta: null,
    treasuryTokenAccount: null, rewardMint: null, tokenProgram: null,
    creatorCompletionBond: pda([enc("completion_bond"), task.toBuffer(), w.buyer.publicKey.toBuffer()])[0],
    workerCompletionBond: pda([enc("completion_bond"), task.toBuffer(), w.provider.publicKey.toBuffer()])[0],
    bondTreasury: w.admin.publicKey,
  });

  // Fail-closed: a referred settlement with the referrer payee OMITTED must revert —
  // otherwise the referrer's cut would silently over-pay the worker (the pre-batch-2 bug).
  expectFail(send(w.svm, await makeProgram(w.admin).methods
    .resolveDispute(true, arr(Buffer.alloc(32, 5)), "agenc://ruling/complete")
    .accounts(resolveAccounts(null))
    .instruction(), [w.admin]), "MissingReferrerAccount", "b2ref:missing referrer payee fails closed");

  // Now settle properly: operator AND referrer legs carved from the worker's gross.
  const workerBalBefore = Number(w.svm.getBalance(w.provider.publicKey));
  const operatorBalBefore = Number(w.svm.getBalance(operatorKp.publicKey));
  const referrerBalBefore = Number(w.svm.getBalance(referrerKp.publicKey));
  const claimRent = Number(w.svm.getBalance(claim)); // resolve closes the claim -> rent to worker

  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .resolveDispute(true, arr(Buffer.alloc(32, 5)), "agenc://ruling/complete")
    .accounts(resolveAccounts(referrerKp.publicKey))
    .instruction(), [w.admin]), "b2ref:resolve Complete with both legs");

  assert.ok(decode(w.svm, "Task", task).status.Completed !== undefined, "task Completed via dispute");

  // Disputes take no protocol fee; both marketplace legs bind against the gross.
  const expectedOpFee = Math.floor(REWARD * OP_BPS / 10_000);   // 300_000
  const expectedRefFee = Math.floor(REWARD * REF_BPS / 10_000); // 150_000
  const operatorDelta = Number(w.svm.getBalance(operatorKp.publicKey)) - operatorBalBefore;
  const referrerDelta = Number(w.svm.getBalance(referrerKp.publicKey)) - referrerBalBefore;
  const workerDelta = Number(w.svm.getBalance(w.provider.publicKey)) - workerBalBefore;
  assert.equal(operatorDelta, expectedOpFee, `operator leg paid on dispute Complete (got ${operatorDelta})`);
  assert.equal(referrerDelta, expectedRefFee, `referrer leg paid on dispute Complete (got ${referrerDelta})`);
  assert.equal(workerDelta, REWARD - expectedOpFee - expectedRefFee + claimRent,
    `worker paid gross minus BOTH legs plus claim rent (got ${workerDelta})`);
});

// ---------------------------------------------------------------------------
// (4) SCALE_COST_MODEL R1 — close_task reclaims TaskAttestorConfig rent. Before
// batch-2 the child whitelist accepted only TaskModeration / TaskValidationConfig /
// TaskSubmission, stranding ~0.00178 SOL on every reviewed task forever.
// ---------------------------------------------------------------------------
test("close_task: reclaims TaskAttestorConfig rent via the child whitelist (and still rejects another task's account)", async () => {
  const w = await freshWorld({ price: 1_500_000 });

  // Two plain (non-hired) REVIEWED tasks, each with a validation + attestor config
  // (CreatorReview) — the flow that strands TaskAttestorConfig rent pre-batch-2.
  async function reviewedTaskWithAttestorConfig() {
    const taskId = id32();
    const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
    const [escrow] = pda([enc("escrow"), task.toBuffer()]);
    const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
    const [validation] = pda([enc("task_validation"), task.toBuffer()]);
    const [attestorCfg] = pda([enc("task_attestor"), task.toBuffer()]);
    const [hireRecord] = pda([enc("hire"), task.toBuffer()]); // empty: never hired
    const now = Number(w.svm.getClock().unixTimestamp);
    const desc = Buffer.alloc(64);
    desc.set(id32(), 0);
    expectOk(send(w.svm, await w.buyerProg.methods
      .createTask(arr(taskId), new BN(1), arr(desc), new BN(1_500_000), 1, new BN(now + 3600), 0, null, 0, null, null, 0)
      .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
      .instruction(), [w.buyer]), "b2close:create_task");
    expectOk(send(w.svm, await w.buyerProg.methods
      .configureTaskValidation(1, new BN(3600), 0, null) // CreatorReview
      .accounts({ task, taskValidationConfig: validation, taskAttestorConfig: attestorCfg, protocolConfig: w.protocolPda, hireRecord, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
      .instruction(), [w.buyer]), "b2close:configure validation");
    return { task, escrow, hireRecord, validation, attestorCfg };
  }
  const a = await reviewedTaskWithAttestorConfig();
  const b = await reviewedTaskWithAttestorConfig();

  // Cancel task A (Open -> Cancelled, escrow refunded + closed).
  expectOk(send(w.svm, await w.buyerProg.methods
    .cancelTask()
    .accounts({
      task: a.task, escrow: a.escrow, authority: w.buyer.publicKey, protocolConfig: w.protocolPda,
      systemProgram: SystemProgram.programId,
      tokenEscrowAta: null, creatorTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: pda([enc("completion_bond"), a.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0], workerCompletionBond: pda([enc("completion_bond"), a.task.toBuffer(), w.provider.publicKey.toBuffer()])[0], workerBondAuthority: w.provider.publicKey,
      creatorAgent: null, agentStats: null,
    })
    .instruction(), [w.buyer]), "b2close:cancel A");

  // Guard: closing task A while smuggling task B's attestor config is rejected —
  // the child must be bound to THIS task.
  const closeIx = (children) => w.buyerProg.methods
    .closeTask()
    .accounts({ task: a.task, taskJobSpec: null, escrow: null, hireRecord: a.hireRecord, listing: null, creatorCompletionBond: pda([enc("completion_bond"), a.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0], workerCompletionBond: null, authority: w.buyer.publicKey })
    .remainingAccounts(children.map((c) => ({ pubkey: c, isSigner: false, isWritable: true })))
    .instruction();
  expectFail(send(w.svm, await closeIx([b.attestorCfg]), [w.buyer]),
    "InvalidInput", "b2close:another task's attestor config rejected");

  // Close task A passing BOTH of its children: validation config + attestor config.
  const creatorBalBefore = Number(w.svm.getBalance(w.buyer.publicKey));
  const attestorRent = Number(w.svm.getBalance(a.attestorCfg));
  const validationRent = Number(w.svm.getBalance(a.validation));
  assert.ok(attestorRent > 0, "attestor config holds reclaimable rent");

  expectOk(send(w.svm, await closeIx([a.validation, a.attestorCfg]), [w.buyer]),
    "b2close:close with attestor-config child");

  assert.ok(isClosed(w.svm, a.task), "task closed");
  // Tombstoned: lamports drained to the creator, discriminator poisoned.
  assert.equal(Number(w.svm.getBalance(a.attestorCfg)), 0, "attestor config rent drained");
  const tomb = w.svm.getAccount(a.attestorCfg);
  assert.ok(tomb === null || Buffer.from(tomb.data.slice(0, 8)).every((x) => x === 255),
    "attestor config tombstoned (discriminator poisoned)");
  const creatorDelta = Number(w.svm.getBalance(w.buyer.publicKey)) - creatorBalBefore;
  assert.ok(creatorDelta >= attestorRent + validationRent - 50_000,
    `creator reclaimed both children's rent (delta ${creatorDelta}, children ${attestorRent + validationRent})`);

  // Task B's config is untouched.
  assert.equal(Number(w.svm.getBalance(b.attestorCfg)), attestorRent, "task B's attestor config untouched");
});
