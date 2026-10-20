// AGNC-02 regression: a marketplace payee (referrer / operator) that can never
// receive a lamport fee — the program id or an Agave reserved account key — is
// now rejected at the snapshot chokepoint, so the unpayable task is never
// created. Before the fix, `hire_from_listing` / `create_task` ACCEPTED such a
// payee; every worker-payout path then reverted forever, and the creator could
// forfeit the worker's completion bond via `expire_claim` and recover escrow via
// `cancel_task`. These tests run against the compiled program and go red against
// the pre-fix build (the hire/create succeeds there).
//
// Run:  cd tests-integration && node --test agnc02-referrer-guard.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { SystemProgram } from "@solana/web3.js";
import {
  PID, enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode, isClosed, BN, Keypair, PublicKey,
  freshWorld, hireIx, listingModV2Pda, taskModV2Pda, moderationBlockPda,
} from "./harness.mjs";

const REWARD = 4_000_000;
const UNPAYABLE = "MarketplacePayeeUnpayable";

// A representative Agave reserved account key (the Clock sysvar): the runtime
// demotes it to read-only when writable, so a fee credit would revert.
const CLOCK_SYSVAR = new PublicKey("SysvarC1ock11111111111111111111111111111111");
// A sibling native program (SPL Token) — reserved only by its loader, NOT in the
// reserved-account-keys set, so it stays accepted (the guard is precise).
const SPL_TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

async function recordListingClean(w) {
  const [listingMod] = listingModV2Pda(w.listing, w.specHash, w.modAuth.publicKey);
  expectOk(send(w.svm, await makeProgram(w.modAuth).methods
    .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "listing-mod");
  return listingMod;
}

// --- hire_from_listing: referrer leg -----------------------------------------
test("hire_from_listing rejects a program-id referrer at creation (AGNC-02)", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: REWARD });
  const listingMod = await recordListingClean(w);
  const { ix, task, escrow } = await hireIx(w, { listingModeration: listingMod, referrer: PID, referrerFeeBps: 500 });
  expectFail(send(w.svm, ix, [w.buyer]), UNPAYABLE, "program-id referrer hire");
  // The task + escrow were never created, so there is nothing to brick.
  assert.ok(isClosed(w.svm, task), "task PDA never created");
  assert.ok(isClosed(w.svm, escrow), "escrow PDA never created");
});

test("hire_from_listing rejects a reserved-key (Clock sysvar) referrer at creation", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: REWARD });
  const listingMod = await recordListingClean(w);
  const { ix } = await hireIx(w, { listingModeration: listingMod, referrer: CLOCK_SYSVAR, referrerFeeBps: 500 });
  expectFail(send(w.svm, ix, [w.buyer]), UNPAYABLE, "reserved-key referrer hire");
});

// --- hire_from_listing: operator leg (stamped from the listing) ---------------
test("hire_from_listing rejects a program-id operator at creation", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: REWARD, operator: PID, operatorFeeBps: 1000 });
  const listingMod = await recordListingClean(w);
  const { ix } = await hireIx(w, { listingModeration: listingMod });
  expectFail(send(w.svm, ix, [w.buyer]), UNPAYABLE, "program-id operator hire");
});

// --- create_task: referrer leg (non-hire path) --------------------------------
test("create_task rejects a program-id referrer at creation", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: REWARD });
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  const createTaskIx = (referrer) => w.buyerProg.methods
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(REWARD), 1, new BN(now + 3600), 0, null, 0, null, referrer, 500)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction();
  expectFail(send(w.svm, await createTaskIx(PID), [w.buyer]), UNPAYABLE, "program-id referrer create_task");
  assert.ok(isClosed(w.svm, escrow), "escrow never created on the rejected create_task");
});

// --- controls: legitimate payees are unaffected -------------------------------
test("control: a funded wallet referrer still settles and is paid (no regression)", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: REWARD });
  const ref = Keypair.generate();
  w.svm.airdrop(ref.publicKey, BigInt(1e9));
  const listingMod = await recordListingClean(w);

  const { ix: hix, task, escrow, hireRecord, taskJobSpecHash: jobHash } = await hireIx(w, { listingModeration: listingMod, referrer: ref.publicKey, referrerFeeBps: 500 });
  expectOk(send(w.svm, hix, [w.buyer]), "hire with a funded wallet referrer");

  const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  expectOk(send(w.svm, await makeProgram(w.modAuth).methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "task-mod");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/agnc02", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "publish");
  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, hireRecord, legacyListing: null, moderationBlock: moderationBlockPda(jobHash)[0], claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "claim");

  const referrerBefore = Number(w.svm.getBalance(ref.publicKey));
  expectOk(send(w.svm, await w.providerProg.methods
    .completeTask(arr(id32()), null)
    .accounts({ task, claim, escrow, creator: w.buyer.publicKey, worker: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.provider.publicKey, systemProgram: SystemProgram.programId, tokenEscrowAta: null, workerTokenAccount: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, hireRecord, operator: null, referrer: ref.publicKey, creatorCompletionBond: pda([enc("completion_bond"), task.toBuffer(), w.buyer.publicKey.toBuffer()])[0], workerCompletionBond: pda([enc("completion_bond"), task.toBuffer(), w.provider.publicKey.toBuffer()])[0] })
    .instruction(), [w.provider]), "complete with the funded referrer");

  assert.equal(decode(w.svm, "Task", task).status.Completed !== undefined, true, "task Completed");
  assert.equal(Number(w.svm.getBalance(ref.publicKey)) - referrerBefore, Math.floor((REWARD * 500) / 10000), "referrer paid its exact 5% cut");
});

test("control: an SPL-Token-program referrer is still accepted (guard is precise, not all-programs)", async () => {
  // SPL Token is executable and payable; it is NOT an Agave reserved key, so the
  // guard must not reject it — only the program id and reserved keys are blocked.
  const w = await freshWorld({ moderationEnabled: true, price: REWARD });
  const listingMod = await recordListingClean(w);
  const { ix } = await hireIx(w, { listingModeration: listingMod, referrer: SPL_TOKEN, referrerFeeBps: 500 });
  expectOk(send(w.svm, ix, [w.buyer]), "SPL-Token referrer hire accepted");
});
