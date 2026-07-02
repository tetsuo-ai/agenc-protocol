// In-process litesvm integration tests for the P6.2 demand-side referral fee.
//
// Proves the §4 4-way settlement split (protocol / operator / referrer / worker) to
// the LAMPORT on the SOL path, that a default-referrer hire settles EXACTLY like the
// pre-referrer split (the leg is skipped), that the combined cap (sum > 4000 bps) is
// rejected, and that migrate_task extends a 432B Batch-2 task (and a 382B legacy
// task) to the new 466B P6.2 size with the appended referrer fields zero-init.
//
// Run:  cd tests-integration && node --test referral-fee.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { SystemProgram } from "@solana/web3.js";
import {
  MINT_SIZE, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  createInitializeMintInstruction, createAssociatedTokenAccountInstruction,
  createMintToInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PID, enc, arr, pda, id32,
  makeProgram, send, sendMany, expectOk, expectFail, decode, BN, Keypair, PublicKey,
  setMultisig, freshWorld, hireIx,
} from "./harness.mjs";

// ---------------------------------------------------------------------------
// Shared flow: hire a listing (optionally with operator + referrer legs), drive it
// through moderation/publish/claim, then complete it — returning balance snapshots.
// Mirrors marketplace.test.mjs runHireSettlement but threads the referrer leg.
// ---------------------------------------------------------------------------
async function recordListingClean(w) {
  const modProg = makeProgram(w.modAuth);
  const [listingMod] = pda([enc("listing_moderation"), w.listing.toBuffer(), Buffer.from(w.specHash)]);
  expectOk(send(w.svm, await modProg.methods
    .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "record-listing-mod");
  return listingMod;
}

async function hireDriveComplete(w, { referrer = null, referrerFeeBps = 0 } = {}) {
  const modProg = makeProgram(w.modAuth);
  const listingMod = await recordListingClean(w);

  const taskId = id32();
  const { ix: hix, task, escrow, hireRecord } = await hireIx(w, { taskId, listingModeration: listingMod, referrer, referrerFeeBps });
  expectOk(send(w.svm, hix, [w.buyer]), "hire");

  const jobHash = id32();
  const [taskMod] = pda([enc("task_moderation"), task.toBuffer(), Buffer.from(jobHash)]);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);

  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "task-mod");

  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/x")
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "publish");

  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "claim");

  // Resolve the snapshotted referrer to decide whether the leg account is required.
  const t = decode(w.svm, "Task", task);
  const refPayee = t.referrer_fee_bps > 0 && t.referrer.toBase58() !== PublicKey.default.toBase58() ? t.referrer : null;

  const workerBalBefore = Number(w.svm.getBalance(w.provider.publicKey));
  const treasuryBalBefore = Number(w.svm.getBalance(w.admin.publicKey));
  const operatorBalBefore = w.operator ? Number(w.svm.getBalance(w.operator)) : 0;
  const referrerBalBefore = refPayee ? Number(w.svm.getBalance(refPayee)) : 0;
  // complete_task closes the CLAIM account to `authority` (the worker authority), so the
  // worker authority's delta = worker_reward + claim_rent - the worker's own tx fee
  // (it is the sole signer / fee-payer here). The escrow closes to the CREATOR, not the
  // worker. Snapshot the claim rent so the worker assertion can stay lamport-exact
  // INCLUDING the legitimate rent refund (rather than degrading to an inequality).
  const claimRentBefore = Number(w.svm.getBalance(claim));

  expectOk(send(w.svm, await w.providerProg.methods
    .completeTask(arr(id32()), null)
    .accounts({ task, claim, escrow, creator: w.buyer.publicKey, worker: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.provider.publicKey, systemProgram: SystemProgram.programId, tokenEscrowAta: null, workerTokenAccount: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, hireRecord, operator: w.operator, referrer: refPayee, creatorCompletionBond: null, workerCompletionBond: null })
    .instruction(), [w.provider]), "complete");

  return { task, escrow, claim, hireRecord, refPayee, workerBalBefore, treasuryBalBefore, operatorBalBefore, referrerBalBefore, claimRentBefore, reward: w.price };
}

// The worker authority is the sole signer / fee-payer of complete_task, so a single
// signature fee (5000 lamports) is deducted from its balance over the completion tx.
const COMPLETE_TX_FEE = 5_000;

/**
 * Lamport-exact expected worker-authority delta on a clean completion: it RECEIVES the
 * worker reward PLUS the claim account's rent (claim closes to the worker authority) and
 * PAYS its own single-signature tx fee. (The escrow rent closes to the creator, not the
 * worker.) Keeping this exact preserves the money invariant without weakening it.
 */
function expectedWorkerDelta(workerReward, claimRentBefore) {
  return workerReward + claimRentBefore - COMPLETE_TX_FEE;
}

test("4-WAY SPLIT (SOL): protocol + operator + referrer + worker paid to the lamport", async () => {
  // reward 10_000_000; protocol 100 bps (1%), operator 1000 bps (10%), referrer 500 bps (5%).
  // base = reward (single-worker exclusive). protocol = 100_000, operator = 1_000_000,
  // referrer = 500_000, worker = reward - all three = 8_400_000.
  const operatorKp = Keypair.generate();
  const referrerKp = Keypair.generate();
  const w = await freshWorld({ moderationEnabled: true, price: 10_000_000, operator: operatorKp.publicKey, operatorFeeBps: 1000 });
  w.svm.airdrop(referrerKp.publicKey, BigInt(1e9)); // rent-exempt before receiving its leg

  const r = await hireDriveComplete(w, { referrer: referrerKp.publicKey, referrerFeeBps: 500 });

  const reward = 10_000_000;
  const protocolFee = Math.floor((reward * 100) / 10000); // 100_000
  const operatorFee = Math.floor((reward * 1000) / 10000); // 1_000_000
  const referrerFee = Math.floor((reward * 500) / 10000); // 500_000
  const workerReward = reward - protocolFee - operatorFee - referrerFee; // 8_400_000

  // Lamport-exact on every leg.
  assert.equal(Number(w.svm.getBalance(w.admin.publicKey)) - r.treasuryBalBefore, protocolFee, "protocol leg exact");
  assert.equal(Number(w.svm.getBalance(operatorKp.publicKey)) - r.operatorBalBefore, operatorFee, "operator leg exact");
  assert.equal(Number(w.svm.getBalance(referrerKp.publicKey)) - r.referrerBalBefore, referrerFee, "referrer leg exact");
  // Worker authority: worker_reward (minus ALL three legs) + claim rent refund - tx fee.
  assert.equal(
    Number(w.svm.getBalance(w.provider.publicKey)) - r.workerBalBefore,
    expectedWorkerDelta(workerReward, r.claimRentBefore),
    "worker keeps reward minus ALL three legs (+ claim rent - tx fee)",
  );

  // Conservation: the three fee legs + worker reward == the full reward, to the lamport.
  assert.equal(protocolFee + operatorFee + referrerFee + workerReward, reward, "4-way split conserves the reward exactly");

  const t = decode(w.svm, "Task", r.task);
  assert.equal(t.referrer.toBase58(), referrerKp.publicKey.toBase58(), "referrer snapshotted on Task");
  assert.equal(t.referrer_fee_bps, 500, "referrer_fee_bps snapshotted on Task");
});

test("REFERRER-ONLY (SOL): a referral with no operator pays protocol + referrer + worker exactly", async () => {
  // No operator on the listing. reward 8_000_000; protocol 100 bps, referrer 2000 bps (20%).
  const referrerKp = Keypair.generate();
  const w = await freshWorld({ moderationEnabled: true, price: 8_000_000 });
  w.svm.airdrop(referrerKp.publicKey, BigInt(1e9));

  const r = await hireDriveComplete(w, { referrer: referrerKp.publicKey, referrerFeeBps: 2000 });

  const reward = 8_000_000;
  const protocolFee = Math.floor((reward * 100) / 10000); // 80_000
  const referrerFee = Math.floor((reward * 2000) / 10000); // 1_600_000
  const workerReward = reward - protocolFee - referrerFee; // 6_320_000

  assert.equal(Number(w.svm.getBalance(w.admin.publicKey)) - r.treasuryBalBefore, protocolFee, "protocol leg exact");
  assert.equal(Number(w.svm.getBalance(referrerKp.publicKey)) - r.referrerBalBefore, referrerFee, "referrer leg exact");
  assert.equal(
    Number(w.svm.getBalance(w.provider.publicKey)) - r.workerBalBefore,
    expectedWorkerDelta(workerReward, r.claimRentBefore),
    "worker exact (reward - protocol - referrer + claim rent - tx fee)",
  );
  assert.equal(protocolFee + referrerFee + workerReward, reward, "3-way (protocol+referrer+worker) conserves exactly");
});

test("DEFAULT REFERRER (revert-sensitive): no referrer leg matches the pre-referrer split exactly", async () => {
  // Same world/price as the referrer-only test but NO referrer: the worker must keep
  // reward - protocol_fee, byte-for-byte the pre-P6.2 2-way split (the leg is skipped).
  const w = await freshWorld({ moderationEnabled: true, price: 8_000_000 });
  const r = await hireDriveComplete(w, { referrer: null, referrerFeeBps: 0 });

  const reward = 8_000_000;
  const protocolFee = Math.floor((reward * 100) / 10000); // 80_000
  const workerReward = reward - protocolFee; // 7_920_000 — referrer leg skipped

  assert.equal(r.refPayee, null, "no referrer leg account was required");
  assert.equal(Number(w.svm.getBalance(w.admin.publicKey)) - r.treasuryBalBefore, protocolFee, "protocol leg unchanged");
  assert.equal(
    Number(w.svm.getBalance(w.provider.publicKey)) - r.workerBalBefore,
    expectedWorkerDelta(workerReward, r.claimRentBefore),
    "worker keeps reward - protocol fee (no referrer carve) + claim rent - tx fee",
  );

  const t = decode(w.svm, "Task", r.task);
  assert.equal(t.referrer.toBase58(), PublicKey.default.toBase58(), "referrer is default on Task");
  assert.equal(t.referrer_fee_bps, 0, "referrer_fee_bps is 0 on Task");
});

test("COMBINED CAP: a hire whose protocol + operator + referrer exceeds 4000 bps is rejected", async () => {
  // protocol 100 + operator 2000 + referrer 1901 = 4001 > 4000 -> CombinedFeeAboveCap at hire.
  const operatorKp = Keypair.generate();
  const referrerKp = Keypair.generate();
  const w = await freshWorld({ moderationEnabled: true, price: 5_000_000, operator: operatorKp.publicKey, operatorFeeBps: 2000 });
  const listingMod = await recordListingClean(w);
  const { ix } = await hireIx(w, { listingModeration: listingMod, referrer: referrerKp.publicKey, referrerFeeBps: 1901 });
  expectFail(send(w.svm, ix, [w.buyer]), "CombinedFeeAboveCap", "hire rejected when combined fees exceed the cap");

  // Boundary: protocol 100 + operator 2000 + referrer 1900 = 4000 -> accepted.
  const w2 = await freshWorld({ moderationEnabled: true, price: 5_000_000, operator: operatorKp.publicKey, operatorFeeBps: 2000 });
  const listingMod2 = await recordListingClean(w2);
  const { ix: ix2 } = await hireIx(w2, { listingModeration: listingMod2, referrer: referrerKp.publicKey, referrerFeeBps: 1900 });
  expectOk(send(w2.svm, ix2, [w2.buyer]), "hire accepted exactly at the 4000-bps boundary");
});

test("REFERRER OVER PER-LEG CAP: referrer_fee_bps > 2000 is rejected at hire", async () => {
  const referrerKp = Keypair.generate();
  const w = await freshWorld({ moderationEnabled: true, price: 5_000_000 });
  const listingMod = await recordListingClean(w);
  const { ix } = await hireIx(w, { listingModeration: listingMod, referrer: referrerKp.publicKey, referrerFeeBps: 2001 });
  expectFail(send(w.svm, ix, [w.buyer]), "ReferrerFeeTooHigh", "referrer fee above MAX_REFERRER_FEE_BPS rejected");
});

test("REFERRER SELF-DEAL: the buyer cannot set themselves as the referrer", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 5_000_000 });
  const listingMod = await recordListingClean(w);
  const { ix } = await hireIx(w, { listingModeration: listingMod, referrer: w.buyer.publicKey, referrerFeeBps: 500 });
  expectFail(send(w.svm, ix, [w.buyer]), "ReferrerIsCreator", "self-referral rejected");
});

test("REFERRER PROTECTION: a referred task cannot be completed without paying the referrer", async () => {
  // A worker cannot omit/forge the referrer to pocket its cut — the snapshot is on the
  // (program-owned) Task, and the leg becomes a REQUIRED account once it carries a fee.
  const referrerKp = Keypair.generate();
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000 });
  w.svm.airdrop(referrerKp.publicKey, BigInt(1e9));
  const listingMod = await recordListingClean(w);

  // Drive a referred hire up to (but not through) completion.
  const taskId = id32();
  const { ix: hix, task, escrow, hireRecord } = await hireIx(w, { taskId, listingModeration: listingMod, referrer: referrerKp.publicKey, referrerFeeBps: 500 });
  expectOk(send(w.svm, hix, [w.buyer]), "hire");

  const modProg = makeProgram(w.modAuth);
  const jobHash = id32();
  const [taskMod] = pda([enc("task_moderation"), task.toBuffer(), Buffer.from(jobHash)]);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "task-mod");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/x")
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "publish");
  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "claim");

  const completeAccounts = (referrer) => ({
    task, claim, escrow, creator: w.buyer.publicKey, worker: w.providerAgent,
    protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.provider.publicKey,
    systemProgram: SystemProgram.programId, tokenEscrowAta: null, workerTokenAccount: null,
    treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, hireRecord, operator: null,
    referrer, creatorCompletionBond: null, workerCompletionBond: null,
  });

  // (a) omit the referrer account -> MissingReferrerAccount
  expectFail(
    send(w.svm, await w.providerProg.methods.completeTask(arr(id32()), null).accounts(completeAccounts(null)).instruction(), [w.provider]),
    "MissingReferrerAccount", "complete referred task with referrer omitted",
  );
  // (b) wrong referrer -> InvalidReferrerAccount
  expectFail(
    send(w.svm, await w.providerProg.methods.completeTask(arr(id32()), null).accounts(completeAccounts(Keypair.generate().publicKey)).instruction(), [w.provider]),
    "InvalidReferrerAccount", "complete referred task with mismatched referrer",
  );
  assert.ok(decode(w.svm, "Task", task).status.InProgress !== undefined, "task remains InProgress after rejected completes");

  // (c) correct referrer settles and is paid its exact cut.
  const referrerBefore = Number(w.svm.getBalance(referrerKp.publicKey));
  expectOk(
    send(w.svm, await w.providerProg.methods.completeTask(arr(id32()), null).accounts(completeAccounts(referrerKp.publicKey)).instruction(), [w.provider]),
    "complete with correct referrer",
  );
  assert.equal(Number(w.svm.getBalance(referrerKp.publicKey)) - referrerBefore, Math.floor((4_000_000 * 500) / 10000), "referrer paid its exact 5% cut");
});

test("migrate_task: reallocs a 432B Batch-2 Task to 466B with referrer fields zero-init (and a 382B legacy task too)", async () => {
  const w = await freshWorld({ price: 2_000_000 });
  const { ix, task } = await hireIx(w, {});
  expectOk(send(w.svm, ix, [w.buyer]), "hire");
  const full = w.svm.getAccount(task);
  assert.equal(full.data.length, 466, "new tasks are created at the P6.2 size (466B)");

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

  // ---- Case 1: a 432B Batch-2 task (operator tail present, referrer tail absent). ----
  // Truncate the live 466B account to 432B (drops referrer+referrer_fee_bps = 34B) and
  // fund it at only the 432-byte rent so the migration must top up.
  const batch2 = Buffer.from(full.data).subarray(0, 432);
  const rent432 = Number(w.svm.minimumBalanceForRentExemption(432n));
  const rent466 = Number(w.svm.minimumBalanceForRentExemption(466n));
  w.svm.setAccount(task, { lamports: rent432, data: batch2, owner: PID, executable: false, rentEpoch: 0 });

  // dry-run validates but does NOT mutate.
  expectOk(send(w.svm, await buildMigrate(true), [w.admin, owner2]), "migrate dry-run (432)");
  assert.equal(w.svm.getAccount(task).data.length, 432, "dry-run left the account at the Batch-2 size");

  // real migration: 432 -> 466, rent topped up, referrer tail zero-init.
  expectOk(send(w.svm, await buildMigrate(false), [w.admin, owner2]), "migrate real (432 -> 466)");
  const migrated = w.svm.getAccount(task);
  assert.equal(migrated.data.length, 466, "task reallocated to the P6.2 size");
  assert.ok(Number(migrated.lamports) >= rent466, `rent topped up to >= ${rent466} (got ${migrated.lamports})`);
  const t = decode(w.svm, "Task", task);
  assert.equal(t.referrer.toBase58(), PublicKey.default.toBase58(), "referrer zero-filled by migration");
  assert.equal(t.referrer_fee_bps, 0, "referrer_fee_bps zero-filled by migration");
  assert.equal(t.status.Open !== undefined, true, "pre-migration status preserved (Open)");

  // idempotent re-run on the 466B account is a no-op Ok.
  w.svm.expireBlockhash();
  expectOk(send(w.svm, await buildMigrate(false), [w.admin, owner2]), "migrate idempotent re-run");
  assert.equal(w.svm.getAccount(task).data.length, 466, "still 466 after idempotent re-run");

  // ---- Case 2: a 382B pre-Batch-2 legacy task migrates straight to 466B. ----
  const legacy = Buffer.from(full.data).subarray(0, 382);
  const rent382 = Number(w.svm.minimumBalanceForRentExemption(382n));
  w.svm.setAccount(task, { lamports: rent382, data: legacy, owner: PID, executable: false, rentEpoch: 0 });
  w.svm.expireBlockhash();
  expectOk(send(w.svm, await buildMigrate(false), [w.admin, owner2]), "migrate real (382 -> 466)");
  const migrated2 = w.svm.getAccount(task);
  assert.equal(migrated2.data.length, 466, "legacy 382B task reallocated straight to the P6.2 size");
  const t2 = decode(w.svm, "Task", task);
  assert.equal(t2.operator.toBase58(), PublicKey.default.toBase58(), "operator zero-filled");
  assert.equal(t2.referrer.toBase58(), PublicKey.default.toBase58(), "referrer zero-filled");
  assert.equal(t2.referrer_fee_bps, 0, "referrer_fee_bps zero-filled");
});

test("SPL path: a token-denominated create_task with a referrer fee is rejected (referrer leg is SOL-only)", async () => {
  // The referrer leg pays in lamports (like the operator leg), so it is SOL-only. A
  // token-denominated create_task carrying a referrer fee is rejected at creation
  // (InvalidTokenMint) rather than bricking the task at settlement — and the 2-way
  // SPL settlement path itself is unaffected (covered by marketplace.test.mjs).
  const referrerKp = Keypair.generate();
  const w = await freshWorld({ price: 1_000_000 });
  const reward = 5_000_000;

  const mint = Keypair.generate();
  const rent = Number(w.svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE)));
  expectOk(sendMany(w.svm, [
    SystemProgram.createAccount({ fromPubkey: w.admin.publicKey, newAccountPubkey: mint.publicKey, lamports: rent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeMintInstruction(mint.publicKey, 0, w.admin.publicKey, null),
  ], [w.admin, mint]), "spl:mint");

  const buyerAta = getAssociatedTokenAddressSync(mint.publicKey, w.buyer.publicKey);
  expectOk(sendMany(w.svm, [
    createAssociatedTokenAccountInstruction(w.admin.publicKey, buyerAta, w.buyer.publicKey, mint.publicKey),
    createMintToInstruction(mint.publicKey, buyerAta, w.admin.publicKey, reward),
  ], [w.admin]), "spl:ata+fund");

  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const escrowAta = getAssociatedTokenAddressSync(mint.publicKey, escrow, true);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);

  // reward_mint = mint (token task) + referrer fee 500 bps -> InvalidTokenMint.
  expectFail(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(reward), 1, new BN(now + 3600), 0, null, 0, mint.publicKey, referrerKp.publicKey, 500)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: mint.publicKey, creatorTokenAccount: buyerAta, tokenEscrowAta: escrowAta, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID })
    .instruction(), [w.buyer]), "InvalidTokenMint", "token create_task with referrer fee rejected");
});
