// P1.2 — the HARDENED OPEN ROSTER (in-process litesvm, real .so).
//
// Spec: docs/P1_2_OPEN_ROSTER_SPEC.md. Covers the spec §6 revert-sensitive list:
//   - permissionless bonded registration (bond enforced, not assumed)
//   - two-step exit: exit_at != 0 guard (finding 5), monotonic request, cooldown,
//     full bond+rent refund (never confiscatable)
//   - exit window closes at REQUEST: record + consumption gates reject an exiting
//     attestor (Open Question 6, strict variant)
//   - v2 moderator-keyed records: overwrite ISOLATION (no cross-attestor clobber)
//   - legacy-branch unforgeability (a legacy record by a non-authority stranger
//     cannot unlock the gate)
//   - BLOCK-floor absoluteness: blocked-despite-CLEAN, address-substitution
//     rejected (handler-derived), re-mint-resistant (content-hash-keyed),
//     multisig-only writes, required rationale, clear restores publishing
//   - default trust list: multisig-only pointer with monotonic version
//   - non-confiscatory revoke: the authority cannot close a self-registered entry
//
// Run:  cd agenc-protocol && node --test tests-integration/open-roster.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import {
  enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode, isClosed,
  freshWorld, setMultisig, taskModV2Pda, moderationBlockPda,
  coder, PID,
  BN, Keypair, PublicKey, SystemProgram,
} from "./harness.mjs";

const BOND = 250_000_000n; // REGISTRATION_BOND_LAMPORTS (0.25 SOL, hardcoded)
const COOLDOWN = 604_800n; // ATTESTOR_EXIT_COOLDOWN (7 days)

const attestorPda = (attestor) => pda([enc("moderation_attestor"), attestor.toBuffer()]);

// --- roster lifecycle helpers -----------------------------------------------

async function register(w, attestor) {
  const [entry] = attestorPda(attestor.publicKey);
  return send(
    w.svm,
    await makeProgram(attestor).methods
      .registerModerationAttestor()
      .accounts({
        moderationAttestor: entry,
        attestor: attestor.publicKey,
        protocolConfig: w.config,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
    [attestor],
  );
}

async function assign(w, attestorPub, signer = w.admin) {
  const [entry] = attestorPda(attestorPub);
  return send(
    w.svm,
    await makeProgram(signer).methods
      .assignModerationAttestor(attestorPub)
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

async function requestExit(w, attestor) {
  const [entry] = attestorPda(attestor.publicKey);
  return send(
    w.svm,
    await makeProgram(attestor).methods
      .requestAttestorExit()
      .accounts({ moderationAttestor: entry, attestor: attestor.publicKey })
      .instruction(),
    [attestor],
  );
}

async function finalizeExit(w, attestor) {
  const [entry] = attestorPda(attestor.publicKey);
  return send(
    w.svm,
    await makeProgram(attestor).methods
      .finalizeAttestorExit()
      .accounts({ moderationAttestor: entry, attestor: attestor.publicKey })
      .instruction(),
    [attestor],
  );
}

function warp(w, seconds) {
  const clk = w.svm.getClock();
  clk.unixTimestamp = clk.unixTimestamp + BigInt(seconds);
  w.svm.setClock(clk);
}

// --- moderation-record + publish helpers (v2 semantics) ----------------------

// Record a task-moderation for (task, jobHash) at the RECORDER's v2 slot.
async function recordTaskModIx(w, { task, jobHash, recorder, attestorEntry = null, status = 0 }) {
  const [taskMod] = taskModV2Pda(task, jobHash, recorder.publicKey);
  const ix = await makeProgram(recorder).methods
    .recordTaskModeration(arr(jobHash), status, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({
      moderationConfig: w.modCfg, task, taskModeration: taskMod,
      moderator: recorder.publicKey, moderationAttestor: attestorEntry,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return { ix, taskMod };
}

async function recordTaskMod(w, opts) {
  const { ix, taskMod } = await recordTaskModIx(w, opts);
  expectOk(send(w.svm, ix, [opts.recorder]), "record task moderation");
  return taskMod;
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

// Build a set_task_job_spec ix: P1.2 shape — explicit `moderator` arg, v2 (or
// caller-chosen) record PDA, required BLOCK-floor account.
async function publishIx(w, { task, jobHash, taskMod, moderator, attestorEntry = null, blockOverride = null }) {
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  const [block] = moderationBlockPda(jobHash);
  const ix = await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/open-roster", moderator)
    .accounts({
      protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg,
      taskModeration: taskMod, moderationAttestor: attestorEntry,
      moderationBlock: blockOverride ?? block,
      taskJobSpec: jobSpec, creator: w.buyer.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return { ix, jobSpec };
}

async function publish(w, opts) {
  const { ix } = await publishIx(w, opts);
  return send(w.svm, ix, [w.buyer]);
}

// --- multisig helpers (mirrors admin-config.test.mjs) -------------------------

function twoOfTwoMultisig(w) {
  const owner2 = Keypair.generate();
  w.svm.airdrop(owner2.publicKey, BigInt(10e9));
  const signerMetas = [
    { pubkey: w.admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: owner2.publicKey, isSigner: true, isWritable: false },
  ];
  return { owner2, signerMetas, signers: [w.admin, owner2] };
}

async function setBlockIx(w, { contentHash, rationaleHash = Buffer.alloc(32, 5), rationaleUri = "agenc://takedown/sha256/test", metas }) {
  const [block] = moderationBlockPda(contentHash);
  return {
    block,
    ix: await makeProgram(w.admin).methods
      .setModerationBlock(arr(contentHash), arr(rationaleHash), rationaleUri)
      .accounts({
        protocolConfig: w.protocolPda, moderationBlock: block,
        authority: w.admin.publicKey, systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(metas)
      .instruction(),
  };
}

async function clearBlockIx(w, { contentHash, metas }) {
  const [block] = moderationBlockPda(contentHash);
  return await makeProgram(w.admin).methods
    .clearModerationBlock()
    .accounts({
      protocolConfig: w.protocolPda, moderationBlock: block,
      authority: w.admin.publicKey,
    })
    .remainingAccounts(metas)
    .instruction();
}

// ---------------------------------------------------------------------------
// Permissionless bonded registration (§4.1)
// ---------------------------------------------------------------------------

test("register_moderation_attestor: permissionless self-registration deposits the bond; assigned_by = self; double-register fails", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const outsider = Keypair.generate();
  w.svm.airdrop(outsider.publicKey, BigInt(1e9));

  expectOk(await register(w, outsider), "self-registration needs NO authority");

  const [entry] = attestorPda(outsider.publicKey);
  const decoded = decode(w.svm, "ModerationAttestor", entry);
  assert.equal(decoded.attestor.toBase58(), outsider.publicKey.toBase58());
  assert.equal(
    decoded.assigned_by.toBase58(), outsider.publicKey.toBase58(),
    "assigned_by = self marks the entry self-registered",
  );
  assert.equal(BigInt(decoded.bond_lamports.toString()), BOND, "bond bookkeeping recorded");
  assert.notEqual(Number(decoded.registered_at), 0, "registered_at stamped");
  assert.equal(Number(decoded.exit_at), 0, "fresh entry is not exiting");

  // The bond is ENFORCED on the PDA, not assumed (finding 5): a deputized entry
  // holds exactly rent, so the registered entry must hold rent + BOND.
  const deputy = Keypair.generate();
  expectOk(await assign(w, deputy.publicKey), "assign a deputized entry (rent-only baseline)");
  const [deputyEntry] = attestorPda(deputy.publicKey);
  const rentOnly = w.svm.getAccount(deputyEntry).lamports;
  const bonded = w.svm.getAccount(entry).lamports;
  assert.equal(BigInt(bonded) - BigInt(rentOnly), BOND, "PDA holds rent + the 0.25 SOL bond");

  // Registering an already-rostered wallet fails at init (the desired signal).
  w.svm.expireBlockhash();
  expectFail(await register(w, outsider), "already in use", "double-register rejected");
});

test("revoke_moderation_attestor is scoped (§4.7): the authority cannot close a self-registered entry (bond never confiscatable); its own deputized entries still revoke", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const outsider = Keypair.generate();
  w.svm.airdrop(outsider.publicKey, BigInt(1e9));
  expectOk(await register(w, outsider), "self-register");

  const [entry] = attestorPda(outsider.publicKey);
  const revokeIx = async () => makeProgram(w.admin).methods
    .revokeModerationAttestor()
    .accounts({ moderationConfig: w.modCfg, moderationAttestor: entry, authority: w.admin.publicKey })
    .instruction();

  expectFail(
    send(w.svm, await revokeIx(), [w.admin]),
    "UnauthorizedAttestorRevocation",
    "authority revoke of a SELF-REGISTERED entry rejected — confiscation lever removed",
  );

  // Its own deputized entry still revokes (assigned_by == authority).
  const deputy = Keypair.generate();
  expectOk(await assign(w, deputy.publicKey), "assign deputy");
  const [deputyEntry] = attestorPda(deputy.publicKey);
  expectOk(
    send(
      w.svm,
      await makeProgram(w.admin).methods
        .revokeModerationAttestor()
        .accounts({ moderationConfig: w.modCfg, moderationAttestor: deputyEntry, authority: w.admin.publicKey })
        .instruction(),
      [w.admin],
    ),
    "authority revoke of its own deputized entry still works",
  );
  assert.ok(isClosed(w.svm, deputyEntry), "deputized entry closed");
});

// ---------------------------------------------------------------------------
// Two-step exit (§4.2)
// ---------------------------------------------------------------------------

test("attestor exit: exit_at != 0 guard, monotonic request, cooldown enforced, full bond+rent refund", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const outsider = Keypair.generate();
  w.svm.airdrop(outsider.publicKey, BigInt(1e9));
  expectOk(await register(w, outsider), "self-register");
  const [entry] = attestorPda(outsider.publicKey);

  // REVERT-SENSITIVE (finding 5): finalize with exit_at == 0 must NOT satisfy
  // `0 + COOLDOWN <= now` — without the guard a fresh entry finalizes instantly.
  expectFail(await finalizeExit(w, outsider), "AttestorExitNotRequested", "finalize before request rejected");

  expectOk(await requestExit(w, outsider), "request exit");
  const exitAt = Number(decode(w.svm, "ModerationAttestor", entry).exit_at);
  assert.notEqual(exitAt, 0, "exit clock started");

  // Monotonic: the running clock cannot be reset. (expireBlockhash: litesvm dedups
  // byte-identical re-sends and would replay the cached success.)
  warp(w, 3600);
  w.svm.expireBlockhash();
  expectFail(await requestExit(w, outsider), "AttestorExitAlreadyRequested", "re-request rejected (monotonic)");
  assert.equal(
    Number(decode(w.svm, "ModerationAttestor", entry).exit_at), exitAt,
    "exit_at unchanged by the rejected re-request",
  );

  // Cooldown enforced.
  w.svm.expireBlockhash();
  expectFail(await finalizeExit(w, outsider), "AttestorExitCooldownActive", "finalize during cooldown rejected");

  // After the cooldown: full refund (bond + rent — never confiscatable).
  warp(w, Number(COOLDOWN) + 10);
  w.svm.expireBlockhash();
  const entryLamports = BigInt(w.svm.getAccount(entry).lamports);
  const before = BigInt(w.svm.getBalance(outsider.publicKey));
  expectOk(await finalizeExit(w, outsider), "finalize after cooldown");
  const after = BigInt(w.svm.getBalance(outsider.publicKey));
  assert.ok(isClosed(w.svm, entry), "roster entry closed");
  // after = before + closed-account lamports - tx fee (5000/signature default).
  assert.equal(after, before + entryLamports - 5000n, "bond + rent refunded in full");
});

// ADVERSARIAL-REVIEW FIX (revert-sensitive): the exit path is scoped to
// SELF-REGISTERED entries. Without the `assigned_by == attestor` constraint, a
// deputized entry (rent paid by the authority) could request exit, wait out the
// cooldown, and `close = attestor` would drain the AUTHORITY's rent to the deputy —
// a lamport-flow deviation from §4.7 (deputized entries are authority-managed via
// revoke, which returns the rent to the authority).
test("deputized (grandfathered, authority-funded) entries cannot use the exit path at all — request AND finalize are rejected", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const deputy = Keypair.generate();
  w.svm.airdrop(deputy.publicKey, BigInt(1e9));
  expectOk(await assign(w, deputy.publicKey), "deputize (legacy-shaped entry: all bookkeeping 0)");

  expectFail(
    await requestExit(w, deputy),
    "AttestorNotSelfRegistered",
    "deputy cannot start an exit (authority-managed entry)",
  );
  expectFail(
    await finalizeExit(w, deputy),
    "AttestorNotSelfRegistered",
    "deputy cannot finalize either — the authority's rent is not drainable through close = attestor",
  );
});

// ---------------------------------------------------------------------------
// The exit window closes at REQUEST (§4.2 / Open Question 6, strict variant)
// ---------------------------------------------------------------------------

test("an exiting attestor is rejected at the RECORD gate and its record no longer unlocks the CONSUMPTION gate", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const attestor = Keypair.generate();
  w.svm.airdrop(attestor.publicKey, BigInt(1e9));
  expectOk(await register(w, attestor), "self-register");
  const [entry] = attestorPda(attestor.publicKey);

  // Pre-exit: the attestor records a CLEAN verdict (works — sanity).
  const { task } = await createPlainTask(w);
  const jobHash = crypto.randomBytes(32);
  const taskMod = await recordTaskMod(w, { task, jobHash, recorder: attestor, attestorEntry: entry });

  expectOk(await requestExit(w, attestor), "request exit");

  // Record path rejects immediately.
  const jobHash2 = crypto.randomBytes(32);
  const { ix: recIx } = await recordTaskModIx(w, { task, jobHash: jobHash2, recorder: attestor, attestorEntry: entry });
  expectFail(send(w.svm, recIx, [attestor]), "AttestorExiting", "exiting attestor cannot record");

  // Consumption gate rejects the PRE-EXIT record too: no ≤7-day scam-then-exit window.
  expectFail(
    await publish(w, { task, jobHash, taskMod, moderator: attestor.publicKey, attestorEntry: entry }),
    "AttestorExiting",
    "exiting attestor's attestation no longer unlocks set_task_job_spec",
  );
});

// ---------------------------------------------------------------------------
// v2 moderator-keyed records: overwrite isolation (§4.3)
// ---------------------------------------------------------------------------

test("overwrite isolation: attestor B cannot clobber attestor A's verdict — exclusive v2 slots; A's BLOCKED verdict is un-erasable", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const a = Keypair.generate();
  const b = Keypair.generate();
  w.svm.airdrop(a.publicKey, BigInt(1e9));
  w.svm.airdrop(b.publicKey, BigInt(1e9));
  expectOk(await register(w, a), "register A");
  expectOk(await register(w, b), "register B");
  const [entryA] = attestorPda(a.publicKey);
  const [entryB] = attestorPda(b.publicKey);

  const { task } = await createPlainTask(w);
  const jobHash = crypto.randomBytes(32);

  // A records BLOCKED (status 2). B records CLEAN for the SAME (task, hash).
  const modA = await recordTaskMod(w, { task, jobHash, recorder: a, attestorEntry: entryA, status: 2 });
  const modB = await recordTaskMod(w, { task, jobHash, recorder: b, attestorEntry: entryB, status: 0 });

  assert.notEqual(modA.toBase58(), modB.toBase58(), "each attestor owns an exclusive v2 slot");
  assert.equal(decode(w.svm, "TaskModeration", modA).status, 2, "A's BLOCKED verdict untouched by B's write");
  assert.equal(decode(w.svm, "TaskModeration", modB).status, 0, "B's CLEAN verdict in its own slot");

  // B cannot write INTO A's slot: the v2 seed pins the moderator.
  const { ix: forged } = await recordTaskModIx(w, { task, jobHash, recorder: b, attestorEntry: entryB });
  const [slotA] = taskModV2Pda(task, jobHash, a.publicKey);
  // Rebuild the ix against A's PDA by name (the anchor builder derives from args,
  // so construct manually with taskModeration = A's slot).
  const forgedIx = await makeProgram(b).methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({
      moderationConfig: w.modCfg, task, taskModeration: slotA,
      moderator: b.publicKey, moderationAttestor: entryB,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  expectFail(send(w.svm, forgedIx, [b]), "ConstraintSeeds", "cross-slot write rejected by seeds");
  void forged;
});

// ---------------------------------------------------------------------------
// Legacy-branch unforgeability (§4.4)
// ---------------------------------------------------------------------------

test("a legacy-seed record whose stored moderator is a non-authority stranger (no roster entry) cannot unlock the gate", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const stranger = Keypair.generate();
  const { task } = await createPlainTask(w);
  const jobHash = crypto.randomBytes(32);

  // Inject a legacy-seed record directly (the program can no longer write legacy
  // seeds; pre-upgrade accounts are simulated via setAccount, the harness's own
  // config-injection technique). Stored moderator = the stranger.
  const [legacy] = pda([enc("task_moderation"), task.toBuffer(), Buffer.from(jobHash)]);
  const taskAcct = decode(w.svm, "Task", task);
  const record = {
    task,
    creator: new PublicKey(taskAcct.creator),
    job_spec_hash: Array.from(jobHash),
    status: 0, // CLEAN — the forgery attempt claims a clean verdict
    risk_score: 0,
    category_mask: new BN(0),
    policy_hash: Array.from(Buffer.alloc(32, 1)),
    scanner_hash: Array.from(Buffer.alloc(32, 2)),
    recorded_at: new BN(1),
    expires_at: new BN(0),
    moderator: stranger.publicKey,
    bump: 0,
    _reserved: Array(7).fill(0),
  };
  const data = await coder.accounts.encode("TaskModeration", record);
  w.svm.setAccount(legacy, { lamports: 10_000_000, data, owner: PID, executable: false, rentEpoch: 0 });

  // No roster entry exists for the stranger -> the gate must fail CLOSED.
  expectFail(
    await publish(w, { task, jobHash, taskMod: legacy, moderator: stranger.publicKey, attestorEntry: null }),
    "InvalidModerationRecord",
    "legacy record by a rosterless stranger rejected (unforgeable)",
  );
});

// ---------------------------------------------------------------------------
// The BLOCK floor (§5.2)
// ---------------------------------------------------------------------------

test("BLOCK floor: multisig-only writes, required rationale, blocked-despite-CLEAN, substitution rejected, re-mint-resistant, clear restores", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const { signerMetas, signers } = twoOfTwoMultisig(w);
  await setMultisig(w.svm, [signerMetas[0].pubkey, signerMetas[1].pubkey], 2);

  const { task } = await createPlainTask(w);
  const jobHash = crypto.randomBytes(32);
  // A perfectly valid CLEAN record from the GLOBAL AUTHORITY exists.
  const taskMod = await recordTaskMod(w, { task, jobHash, recorder: w.modAuth });

  // Single signer cannot block (never the single-key moderation-authority path).
  {
    const { ix } = await setBlockIx(w, { contentHash: jobHash, metas: [signerMetas[0]] });
    expectFail(send(w.svm, ix, [w.admin]), "MultisigNotEnoughSigners", "single-signer block rejected");
  }

  // Rationale is REQUIRED (finding 9).
  {
    const { ix } = await setBlockIx(w, { contentHash: jobHash, rationaleHash: Buffer.alloc(32, 0), metas: signerMetas });
    expectFail(send(w.svm, ix, signers), "InvalidModerationRationale", "zero rationale hash rejected");
  }

  // 2-of-2 multisig blocks the hash.
  const { ix: blockIx, block } = await setBlockIx(w, { contentHash: jobHash, metas: signerMetas });
  expectOk(send(w.svm, blockIx, signers), "multisig sets the block");
  assert.equal(decode(w.svm, "ModerationBlock", block).status, 1, "status = BLOCKED");

  // REVERT-SENSITIVE (absoluteness): the hash is rejected EVEN WITH a valid CLEAN
  // authority attestation presented.
  expectFail(
    await publish(w, { task, jobHash, taskMod, moderator: w.modAuth.publicKey }),
    "ContentBlocked",
    "blocked despite CLEAN attestation",
  );

  // Address substitution cannot skip the floor: the handler derives the PDA itself.
  expectFail(
    await publish(w, { task, jobHash, taskMod, moderator: w.modAuth.publicKey, blockOverride: w.protocolPda }),
    "InvalidModerationBlockAccount",
    "substituted block account rejected (handler-derived)",
  );

  // Re-mint resistance: the SAME content hash on a FRESH task is still blocked
  // (content-hash-keyed, not task-scoped).
  const { task: task2 } = await createPlainTask(w);
  const taskMod2 = await recordTaskMod(w, { task: task2, jobHash, recorder: w.modAuth });
  expectFail(
    await publish(w, { task: task2, jobHash, taskMod: taskMod2, moderator: w.modAuth.publicKey }),
    "ContentBlocked",
    "re-minted task with the same content hash still blocked",
  );

  // Single signer cannot clear either.
  expectFail(
    send(w.svm, await clearBlockIx(w, { contentHash: jobHash, metas: [signerMetas[0]] }), [w.admin]),
    "MultisigNotEnoughSigners",
    "single-signer clear rejected",
  );

  // Multisig clear restores publishing; the account stays open as the audit trail.
  expectOk(send(w.svm, await clearBlockIx(w, { contentHash: jobHash, metas: signerMetas }), signers), "multisig clears the block");
  assert.equal(decode(w.svm, "ModerationBlock", block).status, 0, "status = CLEARED, audit trail intact");
  w.svm.expireBlockhash();
  expectOk(
    await publish(w, { task, jobHash, taskMod, moderator: w.modAuth.publicKey }),
    "publish passes after clear",
  );
});

// ---------------------------------------------------------------------------
// Default trust list (§5.1)
// ---------------------------------------------------------------------------

test("default trust list: multisig-only pointer updates with a monotonic version + deadman timestamp", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const { signerMetas, signers } = twoOfTwoMultisig(w);
  await setMultisig(w.svm, [signerMetas[0].pubkey, signerMetas[1].pubkey], 2);

  const [list] = pda([enc("default_trust_list")]);
  const listIx = (hashByte, metas) => makeProgram(w.admin).methods
    .setDefaultTrustList(arr(Buffer.alloc(32, hashByte)), "agenc://trust-list/sha256/v1")
    .accounts({
      protocolConfig: w.protocolPda, defaultTrustList: list,
      authority: w.admin.publicKey, systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(metas)
    .instruction();

  expectFail(send(w.svm, await listIx(3, [signerMetas[0]]), [w.admin]), "MultisigNotEnoughSigners", "single-signer trust-list update rejected");

  expectOk(send(w.svm, await listIx(3, signerMetas), signers), "multisig sets the pointer");
  let decoded = decode(w.svm, "DefaultTrustList", list);
  assert.equal(Number(decoded.version), 1, "version starts at 1");
  assert.notEqual(Number(decoded.updated_at), 0, "deadman timestamp stamped");

  w.svm.expireBlockhash();
  expectOk(send(w.svm, await listIx(4, signerMetas), signers), "second update");
  decoded = decode(w.svm, "DefaultTrustList", list);
  assert.equal(Number(decoded.version), 2, "version is monotonic");
  assert.equal(Buffer.from(decoded.list_hash).readUInt8(0), 4, "pointer hash updated");
});

// ---------------------------------------------------------------------------
// Credible-exit walkthrough (§9): zero tetsuo keys on the happy path
// ---------------------------------------------------------------------------

test("credible exit: an outsider registers, attests its own supply, and publishes consuming its own record — no authority involved", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const outsider = Keypair.generate();
  w.svm.airdrop(outsider.publicKey, BigInt(1e9));
  expectOk(await register(w, outsider), "self-register (no authority)");
  const [entry] = attestorPda(outsider.publicKey);

  const { task } = await createPlainTask(w);
  const jobHash = crypto.randomBytes(32);
  const taskMod = await recordTaskMod(w, { task, jobHash, recorder: outsider, attestorEntry: entry });

  expectOk(
    await publish(w, { task, jobHash, taskMod, moderator: outsider.publicKey, attestorEntry: entry }),
    "publish consuming the outsider's own attestation — registration, attestation and consumption all authority-free",
  );
});
