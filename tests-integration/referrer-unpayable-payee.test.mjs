// AGNC-02 regression: an unpayable referrer payee (program id / system program /
// sysvar) must be rejected at hire time, so a task whose worker payout could
// never settle cannot be created. Derived from the reporter's PoC; the control
// (funded wallet referrer) still settles.
import test from "node:test";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { SystemProgram, SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  PID, enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode,
  freshWorld, hireIx,
  listingModV2Pda,
  BN, Keypair,
} from "./harness.mjs";

async function recordListingMod(w) {
  const modProg = makeProgram(w.modAuth);
  const [listingMod] = listingModV2Pda(w.listing, w.specHash, w.modAuth.publicKey);
  expectOk(send(w.svm, await modProg.methods
    .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "listing-mod");
  return listingMod;
}

test("control: a funded wallet referrer settles and the worker is paid", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000 });
  const ref = Keypair.generate();
  w.svm.airdrop(ref.publicKey, BigInt(1e9));
  const listingMod = await recordListingMod(w);
  const { ix } = await hireIx(w, { taskId: id32(), listingModeration: listingMod, referrer: ref.publicKey, referrerFeeBps: 500 });
  expectOk(send(w.svm, ix, [w.buyer]), "hire with wallet referrer");
});

test("AGNC-02: program-id, system-program, and sysvar referrers are rejected at hire", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000 });
  const listingMod = await recordListingMod(w);
  for (const [label, payee, code] of [
    // The program id is Anchor's optional-account sentinel: reachable as Some()
    // and now rejected by the unpayable-payee guard.
    ["program id", PID, "InvalidReferrerPayee"],
    // The system program id IS the zero pubkey, so it already failed the
    // no-leg/zero-payee check before this fix — assert that stays true.
    ["system program (zero pubkey)", SystemProgram.programId, "MissingReferrerAccount"],
    ["clock sysvar", SYSVAR_CLOCK_PUBKEY, "InvalidReferrerPayee"],
    ["rent sysvar", SYSVAR_RENT_PUBKEY, "InvalidReferrerPayee"],
  ]) {
    const { ix } = await hireIx(w, { taskId: id32(), listingModeration: listingMod, referrer: payee, referrerFeeBps: 500 });
    expectFail(send(w.svm, ix, [w.buyer]), code, `hire with ${label} referrer refused`);
    w.svm.expireBlockhash();
  }
  // A zero fee on an unpayable payee is a no-leg snapshot and must keep working.
  const { ix: zeroFee } = await hireIx(w, { taskId: id32(), listingModeration: listingMod, referrer: PID, referrerFeeBps: 0 });
  expectOk(send(w.svm, zeroFee, [w.buyer]), "hire with zero-fee program-id referrer is a no-leg");
});

test("AGNC-02: create_task rejects the same unpayable referrer payees", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const make = async (referrer) => {
    const taskId = id32();
    const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
    const [escrow] = pda([enc("escrow"), task.toBuffer()]);
    const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
    const now = Number(w.svm.getClock().unixTimestamp);
    return send(w.svm, await w.buyerProg.methods
      .createTask(arr(taskId), new BN(1), arr(Buffer.concat([crypto.randomBytes(32), Buffer.alloc(32)])), new BN(1_000_000), 1, new BN(now + 86_400), 0, null, 0, null, referrer, 500)
      .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
      .instruction(), [w.buyer]);
  };
  for (const [label, payee] of [["program id", PID], ["clock sysvar", SYSVAR_CLOCK_PUBKEY]]) {
    expectFail(await make(payee), "InvalidReferrerPayee", `create_task with ${label} referrer refused`);
    w.svm.expireBlockhash();
  }
});
