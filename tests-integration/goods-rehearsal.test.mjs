// Batch-4 GOODS deploy+stamp REHEARSAL (litesvm, runs the compiled .so).
//
// Rehearses the exact mainnet choreography on the real program:
//   1. the program is deployed (the compiled .so is loaded);
//   2. the goods surface is DARK until stamped (surface_revision stays < 4);
//   3. the REAL update_launch_controls stamps surface_revision = 4 via the
//      2-of-N config-update multisig — RE-PASSING the live protocol_paused +
//      disabled_task_type_mask (the ceremony hazard: the instruction rewrites
//      ALL THREE fields, so forgetting to re-pass them silently resets them);
//   4. a real create_goods_listing -> purchase_good settles, paying the split;
//   5. the GoodPurchased event decodes off the tx logs (the interface the game
//      follow-on / any indexer consumes — see scripts/goods-purchase-watcher.mjs).
//
// Run:  cd .. && node --test tests-integration/goods-rehearsal.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  PID, coder, enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode, getSurfaceRevision,
  freshWorld, setMultisig, setProtocolFeeBps, moderationBlockPda,
  BN, Keypair, PublicKey, SystemProgram,
} from "./harness.mjs";
import { decodeGoodPurchased } from "../scripts/goods-purchase-watcher.mjs";

const MIN_GOOD_PRICE = 1_000;
const REV_BATCH4 = 4;
const LIVE_MASK = 0b0000_0100; // a nonzero launch-control mask to preserve

function readConfig(w) {
  const [protocolPda] = pda([enc("protocol")]);
  return coder.accounts.decode("ProtocolConfig", Buffer.from(w.svm.getAccount(protocolPda).data));
}

test("REHEARSAL: dark -> stamp 4 (preserving paused+mask) -> real sale -> event decodes", async () => {
  const w = await freshWorld({ price: 1_000_000, moderationEnabled: false });
  const [protocolPda] = pda([enc("protocol")]);
  await setProtocolFeeBps(w.svm, 500); // the live mainnet protocol fee (5%)

  // Arm the 2-of-2 config-update multisig (the mainnet upgrade authority is a
  // 2-of-3 Squads vault; same require_multisig_threshold path).
  const owner2 = Keypair.generate();
  w.svm.airdrop(owner2.publicKey, BigInt(10e9));
  await setMultisig(w.svm, [w.admin.publicKey, owner2.publicKey], 2);
  const signerMetas = [
    { pubkey: w.admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: owner2.publicKey, isSigner: true, isWritable: false },
  ];
  const stamp = async (paused, mask, rev) =>
    send(w.svm, await makeProgram(w.admin).methods
      .updateLaunchControls(paused, mask, rev)
      .accounts({ protocolConfig: protocolPda, authority: w.admin.publicKey })
      .remainingAccounts(signerMetas)
      .instruction(), [w.admin, owner2]);

  // Establish the pre-stamp live launch-control state (paused=false, a nonzero
  // task-type mask), still below the goods revision.
  w.svm.expireBlockhash();
  expectOk(await stamp(false, LIVE_MASK, 1), "set live launch controls (rev 1, mask set)");
  assert.equal(getSurfaceRevision(w.svm), 1, "goods surface still DARK (rev 1)");
  assert.equal(readConfig(w).disabled_task_type_mask, LIVE_MASK, "mask set");

  // The goods market is fail-closed while dark: a create must reject.
  const provider = { agent: w.providerAgent, wallet: w.provider, prog: w.providerProg };
  const goodId = id32();
  const [good] = pda([enc("good"), provider.agent.toBuffer(), Buffer.from(goodId)]);
  const metaHash = Buffer.alloc(32, 9);
  const createIx = async () => makeProgram(provider.wallet).methods
    .createGoodsListing(arr(goodId), arr(Buffer.alloc(32, 7)), arr(metaHash), "https://mmo.agenc.ag/g.json",
      new BN(1_000_000), null, arr(Buffer.alloc(64, 3)), new BN(3), PublicKey.default, 0)
    .accounts({ good, seller: provider.agent, protocolConfig: protocolPda, moderationBlock: moderationBlockPda(metaHash)[0], authority: provider.wallet.publicKey, systemProgram: SystemProgram.programId })
    .instruction();
  w.svm.expireBlockhash();
  expectFail(send(w.svm, await createIx(), [provider.wallet]), "GoodsSurfaceNotEnabled", "goods dark before stamp");

  // THE CEREMONY: stamp revision 4, RE-PASSING the live paused + mask.
  w.svm.expireBlockhash();
  expectOk(await stamp(false, LIVE_MASK, REV_BATCH4), "stamp surface_revision = 4");
  assert.equal(getSurfaceRevision(w.svm), REV_BATCH4, "goods surface LIVE (rev 4)");
  const cfg = readConfig(w);
  assert.equal(cfg.disabled_task_type_mask, LIVE_MASK, "CEREMONY: mask survived the stamp byte-identical");
  assert.equal(cfg.protocol_paused, false, "CEREMONY: paused survived the stamp");

  // Now create + purchase for real.
  w.svm.expireBlockhash();
  expectOk(send(w.svm, await createIx(), [provider.wallet]), "create goods listing (surface live)");

  const buyer = Keypair.generate();
  w.svm.airdrop(buyer.publicKey, BigInt(100e9));
  const price = 1_000_000;
  const [receipt] = pda([enc("goods_sale"), good.toBuffer(), new BN(0).toArrayLike(Buffer, "le", 8)]);
  const buyRes = send(w.svm, await makeProgram(buyer).methods
    .purchaseGood(new BN(0), new BN(price), arr(metaHash))
    .accounts({ good, saleReceipt: receipt, sellerAgent: provider.agent, sellerWallet: provider.wallet.publicKey,
      protocolConfig: protocolPda, treasury: w.admin.publicKey, moderationBlock: moderationBlockPda(metaHash)[0],
      authority: buyer.publicKey, systemProgram: SystemProgram.programId, operatorWallet: null,
      priceMint: null, buyerTokenAccount: null, sellerTokenAccount: null, treasuryTokenAccount: null, operatorTokenAccount: null, tokenProgram: null })
    .instruction(), [buyer]);
  expectOk(buyRes, "real purchase_good settles");

  // THE WATCHER INTERFACE: decode the GoodPurchased event off the tx logs — this
  // is exactly what the game follow-on / any indexer consumes to deliver the
  // off-chain good and attribute the sale + protocol cut.
  const logs = buyRes.logs();
  const event = decodeGoodPurchased(logs, coder);
  assert.ok(event, "GoodPurchased event decoded from the tx logs");
  assert.equal(event.listing.toBase58(), good.toBase58(), "event.listing");
  assert.equal(event.buyer.toBase58(), buyer.publicKey.toBase58(), "event.buyer");
  assert.equal(Number(event.serial), 0, "event.serial");
  assert.equal(Number(event.price_paid), price, "event.price_paid");
  assert.equal(Number(event.protocol_fee), 50_000, "event.protocol_fee (5%)");
  assert.equal(Number(event.remaining_supply), 2, "event.remaining_supply after the sale");
  assert.deepEqual(arr(Buffer.from(event.metadata_hash)), arr(metaHash), "event carries the off-chain good pointer");
});

test("REHEARSAL (hazard): a stamp that forgets to re-pass the mask RESETS it", async () => {
  // Documents the ceremony trap: update_launch_controls rewrites all three
  // fields, so passing mask=0 while stamping the revision silently clears a live
  // launch-control mask. The mainnet runbook step MUST re-pass the live values.
  const w = await freshWorld({ price: 1_000_000, moderationEnabled: false });
  const [protocolPda] = pda([enc("protocol")]);
  const owner2 = Keypair.generate();
  w.svm.airdrop(owner2.publicKey, BigInt(10e9));
  await setMultisig(w.svm, [w.admin.publicKey, owner2.publicKey], 2);
  const signerMetas = [
    { pubkey: w.admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: owner2.publicKey, isSigner: true, isWritable: false },
  ];
  const stamp = async (paused, mask, rev) =>
    send(w.svm, await makeProgram(w.admin).methods.updateLaunchControls(paused, mask, rev)
      .accounts({ protocolConfig: protocolPda, authority: w.admin.publicKey })
      .remainingAccounts(signerMetas).instruction(), [w.admin, owner2]);

  w.svm.expireBlockhash();
  expectOk(await stamp(false, LIVE_MASK, 1), "mask set");
  assert.equal(readConfig(w).disabled_task_type_mask, LIVE_MASK);
  // Forget to re-pass the mask while stamping -> it is CLEARED.
  w.svm.expireBlockhash();
  expectOk(await stamp(false, 0, REV_BATCH4), "stamp but drop the mask");
  assert.equal(readConfig(w).disabled_task_type_mask, 0, "the mask was silently reset — re-pass it in the ceremony");
});

test("F-18: KEEP sentinels preserve the mask + revision instead of silently resetting them", async () => {
  const w = await freshWorld({ price: 1_000_000 });
  const [protocolPda] = pda([enc("protocol")]);
  const owner2 = Keypair.generate();
  w.svm.airdrop(owner2.publicKey, BigInt(10e9));
  await setMultisig(w.svm, [w.admin.publicKey, owner2.publicKey], 2);
  const signerMetas = [
    { pubkey: w.admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: owner2.publicKey, isSigner: true, isWritable: false },
  ];
  const stamp = async (paused, mask, rev) =>
    send(w.svm, await makeProgram(w.admin).methods.updateLaunchControls(paused, mask, rev)
      .accounts({ protocolConfig: protocolPda, authority: w.admin.publicKey })
      .remainingAccounts(signerMetas).instruction(), [w.admin, owner2]);

  const KEEP_MASK = 0xff; // KEEP_DISABLED_TASK_TYPE_MASK (outside the valid 0b1111 range)
  const KEEP_REV = 65535; // KEEP_SURFACE_REVISION (u16::MAX)

  expectOk(await stamp(false, LIVE_MASK, 1), "set live launch controls (rev 1, mask set)");
  // Stamp a new revision while keeping the mask — the stale-read hazard is closed.
  w.svm.expireBlockhash();
  expectOk(await stamp(false, KEEP_MASK, REV_BATCH4), "stamp rev 4 with KEEP mask");
  assert.equal(getSurfaceRevision(w.svm), REV_BATCH4, "revision stamped");
  assert.equal(readConfig(w).disabled_task_type_mask, LIVE_MASK, "mask PRESERVED by the KEEP sentinel (F-18)");

  // And keep the revision while clearing the mask explicitly.
  w.svm.expireBlockhash();
  expectOk(await stamp(false, 0, KEEP_REV), "clear mask with KEEP revision");
  assert.equal(readConfig(w).disabled_task_type_mask, 0, "mask explicitly cleared");
  assert.equal(getSurfaceRevision(w.svm), REV_BATCH4, "revision PRESERVED by the KEEP sentinel (F-18)");
});
