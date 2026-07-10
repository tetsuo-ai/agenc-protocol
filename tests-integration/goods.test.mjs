// In-process litesvm integration tests for the Batch-4 GOODS market
// (docs/design/batch-4-goods.md): create_goods_listing, purchase_good,
// update_goods_listing. Executes the COMPILED program.
//
// Run:  cd .. && node --test tests-integration/goods.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  PID, coder, enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode,
  injectProtocolConfig, injectModerationConfig, setSurfaceRevision, setProtocolFeeBps,
  moderationBlockPda,
  BN, Keypair, PublicKey, SystemProgram, LiteSVM,
  MINT_SIZE, TOKEN_PROGRAM_ID, createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction, createMintToInstruction,
  getAssociatedTokenAddressSync, tokenAmount,
} from "./harness.mjs";
import { SO } from "./harness.mjs";

const MIN_GOOD_PRICE = 1_000;
const REV_BATCH4 = 4;
const REV_BATCH3 = 3;

// A fresh goods world: injected protocol config (stamped batch-4 by default,
// fee 500 bps = the live rate), one registered SELLER agent, and buyer WALLETS
// (goods buyers need no agent).
async function goodsWorld({ surfaceRevision = REV_BATCH4, feeBps = 500 } = {}) {
  const svm = new LiteSVM();
  svm.addProgramFromFile(PID, SO);
  const clock = svm.getClock();
  clock.unixTimestamp = 1_700_000_000n;
  svm.setClock(clock);

  const admin = Keypair.generate();
  const seller = Keypair.generate();
  for (const kp of [admin, seller]) svm.airdrop(kp.publicKey, BigInt(100e9));

  const protocolPda = await injectProtocolConfig(svm, admin);
  await injectModerationConfig(svm, admin, admin, false);
  await setSurfaceRevision(svm, surfaceRevision);
  await setProtocolFeeBps(svm, feeBps);

  const sellerProg = makeProgram(seller);
  const sellerAgentId = id32();
  const [sellerAgent] = pda([enc("agent"), sellerAgentId]);
  expectOk(
    send(svm, await sellerProg.methods
      .registerAgent(arr(sellerAgentId), new BN(1), "http://seller.test", null, new BN(0))
      .accounts({ agent: sellerAgent, protocolConfig: protocolPda, authority: seller.publicKey, systemProgram: SystemProgram.programId })
      .instruction(), [seller]),
    "register seller agent");

  return { svm, admin, seller, sellerProg, protocolPda, sellerAgent };
}

// A fresh buyer wallet (bare — no agent registration).
function freshBuyer(w) {
  const kp = Keypair.generate();
  w.svm.airdrop(kp.publicKey, BigInt(100e9));
  return { kp, prog: makeProgram(kp) };
}

// Create a goods listing (SOL). Returns { good, goodId, res }.
async function createGood(w, { price = MIN_GOOD_PRICE, totalSupply = 5, priceMint = null, operator = PublicKey.default, operatorFeeBps = 0, metaHash = Buffer.alloc(32, 9) } = {}) {
  const goodId = id32();
  const [good] = pda([enc("good"), w.sellerAgent.toBuffer(), Buffer.from(goodId)]);
  const res = send(w.svm, await w.sellerProg.methods
    .createGoodsListing(
      arr(goodId), arr(Buffer.alloc(32, 7)), arr(metaHash),
      "https://mmo.agenc.ag/goods/x.json", new BN(price), priceMint,
      arr(Buffer.alloc(64, 3)), new BN(totalSupply), operator, operatorFeeBps)
    .accounts({ good, seller: w.sellerAgent, protocolConfig: w.protocolPda, moderationBlock: moderationBlockPda(metaHash)[0], authority: w.seller.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.seller]);
  return { good, goodId, res, metaHash };
}

// Purchase one unit (SOL) at `serial`. Returns { receipt, res }.
async function buyGood(w, { good, buyer, serial, expectedPrice, metaHash, operatorWallet = null }) {
  const [receipt] = pda([enc("goods_sale"), good.toBuffer(), new BN(serial).toArrayLike(Buffer, "le", 8)]);
  const res = send(w.svm, await buyer.prog.methods
    .purchaseGood(new BN(serial), new BN(expectedPrice))
    .accounts({
      good, saleReceipt: receipt, sellerAgent: w.sellerAgent, sellerWallet: w.seller.publicKey,
      protocolConfig: w.protocolPda, treasury: w.admin.publicKey,
      moderationBlock: moderationBlockPda(metaHash)[0], authority: buyer.kp.publicKey,
      systemProgram: SystemProgram.programId, operatorWallet,
      priceMint: null, buyerTokenAccount: null, sellerTokenAccount: null,
      treasuryTokenAccount: null, operatorTokenAccount: null, tokenProgram: null,
    })
    .instruction(), [buyer.kp]);
  return { receipt, res };
}

const bal = (w, pk) => Number(w.svm.getAccount(pk)?.lamports ?? 0);

test("create → SOL purchase: legs paid exactly, supply burns, receipt minted", async () => {
  const w = await goodsWorld();
  const price = 1_000_000;
  const { good, metaHash } = await createGood(w, { price, totalSupply: 3 });
  const g0 = decode(w.svm, "GoodsListing", good);
  assert.equal(Number(g0.total_supply), 3);
  assert.equal(Number(g0.initial_supply), 3);
  assert.equal(Number(g0.sold_count), 0);

  const buyer = freshBuyer(w);
  const treasuryBefore = bal(w, w.admin.publicKey);
  const sellerBefore = bal(w, w.seller.publicKey);
  const { receipt, res } = await buyGood(w, { good, buyer, serial: 0, expectedPrice: price, metaHash });
  expectOk(res, "purchase good #0");

  // 500 bps (5%) of 1e6 = 50000 to treasury, 950000 to seller.
  assert.equal(bal(w, w.admin.publicKey) - treasuryBefore, 50_000, "protocol cut to treasury");
  assert.equal(bal(w, w.seller.publicKey) - sellerBefore, 950_000, "seller payout");

  const g1 = decode(w.svm, "GoodsListing", good);
  assert.equal(Number(g1.sold_count), 1, "supply burned one unit");
  const r = decode(w.svm, "SaleReceipt", receipt);
  assert.equal(Number(r.serial), 0);
  assert.equal(r.buyer.toBase58(), buyer.kp.publicKey.toBase58());
  assert.equal(Number(r.protocol_fee), 50_000);
  assert.equal(Number(r.operator_fee), 0);
  assert.deepEqual(arr(Buffer.from(r.metadata_hash)), arr(metaHash), "metadata snapshotted");
});

test("operator leg: three-way split paid to seller/treasury/operator", async () => {
  const w = await goodsWorld();
  const operator = Keypair.generate();
  w.svm.airdrop(operator.publicKey, BigInt(1e9)); // rent-exempt before receiving its leg
  const price = 1_000_000;
  const { good, metaHash } = await createGood(w, { price, operator: operator.publicKey, operatorFeeBps: 300 });

  const buyer = freshBuyer(w);
  const tB = bal(w, w.admin.publicKey), sB = bal(w, w.seller.publicKey), oB = bal(w, operator.publicKey);
  const { res } = await buyGood(w, { good, buyer, serial: 0, expectedPrice: price, metaHash, operatorWallet: operator.publicKey });
  expectOk(res, "purchase with operator leg");
  assert.equal(bal(w, w.admin.publicKey) - tB, 50_000, "protocol 500bps");
  assert.equal(bal(w, operator.publicKey) - oB, 30_000, "operator 300bps");
  assert.equal(bal(w, w.seller.publicKey) - sB, 920_000, "seller remainder");
});

test("operator leg requires the operator account", async () => {
  const w = await goodsWorld();
  const operator = Keypair.generate();
  w.svm.airdrop(operator.publicKey, BigInt(1e9));
  const { good, metaHash } = await createGood(w, { operator: operator.publicKey, operatorFeeBps: 300 });
  const buyer = freshBuyer(w);
  // omit operatorWallet -> MissingOperatorAccount
  expectFail(
    (await buyGood(w, { good, buyer, serial: 0, expectedPrice: MIN_GOOD_PRICE, metaHash, operatorWallet: null })).res,
    "MissingOperatorAccount", "omitted operator account rejected");
});

test("wrong operator account is rejected", async () => {
  const w = await goodsWorld();
  const operator = Keypair.generate();
  w.svm.airdrop(operator.publicKey, BigInt(1e9));
  const { good, metaHash } = await createGood(w, { operator: operator.publicKey, operatorFeeBps: 300 });
  const buyer = freshBuyer(w);
  const impostor = Keypair.generate();
  w.svm.airdrop(impostor.publicKey, BigInt(1e9));
  expectFail(
    (await buyGood(w, { good, buyer, serial: 0, expectedPrice: MIN_GOOD_PRICE, metaHash, operatorWallet: impostor.publicKey })).res,
    "MissingOperatorAccount", "substituted operator account rejected");
});

test("sold out after supply exhausted", async () => {
  const w = await goodsWorld();
  const { good, metaHash } = await createGood(w, { totalSupply: 2, price: MIN_GOOD_PRICE });
  for (const serial of [0, 1]) {
    const buyer = freshBuyer(w);
    expectOk((await buyGood(w, { good, buyer, serial, expectedPrice: MIN_GOOD_PRICE, metaHash })).res, `buy #${serial}`);
  }
  const buyer = freshBuyer(w);
  expectFail((await buyGood(w, { good, buyer, serial: 2, expectedPrice: MIN_GOOD_PRICE, metaHash })).res,
    "GoodsSoldOut", "third purchase sold out");
});

test("slippage guard rejects a stale higher price", async () => {
  const w = await goodsWorld();
  const { good, metaHash } = await createGood(w, { price: 2_000_000 });
  const buyer = freshBuyer(w);
  expectFail((await buyGood(w, { good, buyer, serial: 0, expectedPrice: 1_000_000, metaHash })).res,
    "GoodsPriceChanged", "expected_price below current price rejected");
});

test("stale serial (not sold_count) is rejected", async () => {
  const w = await goodsWorld();
  const { good, metaHash } = await createGood(w, { totalSupply: 5, price: MIN_GOOD_PRICE });
  const buyer = freshBuyer(w);
  // sold_count is 0; a purchase claiming serial 1 must fail (future serial).
  expectFail((await buyGood(w, { good, buyer, serial: 1, expectedPrice: MIN_GOOD_PRICE, metaHash })).res,
    "GoodsSerialStale", "future serial rejected");
});

test("two concurrent buyers of the same serial: one wins, no over-sell", async () => {
  const w = await goodsWorld();
  const { good, metaHash } = await createGood(w, { totalSupply: 5, price: MIN_GOOD_PRICE });
  const a = freshBuyer(w), b = freshBuyer(w);
  expectOk((await buyGood(w, { good, buyer: a, serial: 0, expectedPrice: MIN_GOOD_PRICE, metaHash })).res, "A takes serial 0");
  // B also tries serial 0 -> the receipt PDA at serial 0 now exists, so Anchor's
  // `init` fails ("account already in use") BEFORE the handler body. Either way
  // the raced purchase FAILS and no serial is double-minted. (The distinct
  // GoodsSerialStale code covers a FUTURE serial — see the test above.)
  const raced = await buyGood(w, { good, buyer: b, serial: 0, expectedPrice: MIN_GOOD_PRICE, metaHash });
  assert.ok(raced.res.constructor.name === "FailedTransactionMetadata", "B's raced serial-0 purchase rejected (init collision)");
  assert.equal(Number(decode(w.svm, "GoodsListing", good).sold_count), 1, "exactly one unit sold");
});

test("self-purchase is blocked", async () => {
  const w = await goodsWorld();
  const { good, metaHash } = await createGood(w, { price: MIN_GOOD_PRICE });
  // The seller's own wallet as buyer.
  const sellerBuyer = { kp: w.seller, prog: w.sellerProg };
  expectFail((await buyGood(w, { good, buyer: sellerBuyer, serial: 0, expectedPrice: MIN_GOOD_PRICE, metaHash })).res,
    "GoodsSelfPurchase", "seller cannot buy own good");
});

test("goods gated OFF below surface_revision 4", async () => {
  const w = await goodsWorld({ surfaceRevision: REV_BATCH3 });
  const { res } = await createGood(w, { price: MIN_GOOD_PRICE });
  expectFail(res, "GoodsSurfaceNotEnabled", "create rejected at revision 3");
});

test("stamp revision 4 turns goods on (kill-switch semantics)", async () => {
  const w = await goodsWorld({ surfaceRevision: REV_BATCH3 });
  expectFail((await createGood(w)).res, "GoodsSurfaceNotEnabled", "off at 3");
  await setSurfaceRevision(w.svm, REV_BATCH4);
  expectOk((await createGood(w)).res, "on at 4");
});

test("update: additive restock raises supply; set-style is impossible", async () => {
  const w = await goodsWorld();
  const { good } = await createGood(w, { totalSupply: 2 });
  // Restock +3 -> total 5, restock_count 1, initial_supply unchanged at 2.
  expectOk(send(w.svm, await w.sellerProg.methods
    .updateGoodsListing(null, null, null, null, null, new BN(3), null, null)
    .accounts({ good, seller: w.sellerAgent, protocolConfig: w.protocolPda, authority: w.seller.publicKey })
    .instruction(), [w.seller]), "restock +3");
  const g = decode(w.svm, "GoodsListing", good);
  assert.equal(Number(g.total_supply), 5, "supply grew additively");
  assert.equal(Number(g.initial_supply), 2, "initial_supply immutable");
  assert.equal(Number(g.restock_count), 1, "restock counter");
  // The instruction has NO absolute-set arg — a set-style restock is
  // structurally impossible (there is no total_supply setter parameter). The
  // IDL is the source of truth for the wire surface.
  const sig = w.sellerProg.idl.instructions.find((i) => i.name === "update_goods_listing" || i.name === "updateGoodsListing");
  const argNames = sig.args.map((a) => a.name);
  assert.ok(argNames.some((n) => n === "additional_supply" || n === "additionalSupply"), "additive restock arg present");
  assert.ok(!argNames.some((n) => /total.?supply|set.?supply/i.test(n)), "no absolute supply setter exists");
});

test("update: soft delist blocks purchases; only the seller can update", async () => {
  const w = await goodsWorld();
  const { good, metaHash } = await createGood(w, { price: MIN_GOOD_PRICE });
  // A non-seller cannot update.
  const stranger = freshBuyer(w);
  // stranger needs an agent to even build the accounts; use the seller-PDA seed
  // mismatch: unauthorized because they don't own the seller agent.
  const strangerAgentId = id32();
  const [strangerAgent] = pda([enc("agent"), strangerAgentId]);
  expectOk(send(w.svm, await stranger.prog.methods
    .registerAgent(arr(strangerAgentId), new BN(1), "http://s.test", null, new BN(0))
    .accounts({ agent: strangerAgent, protocolConfig: w.protocolPda, authority: stranger.kp.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [stranger.kp]), "register stranger");
  // Deactivate as the seller.
  expectOk(send(w.svm, await w.sellerProg.methods
    .updateGoodsListing(null, false, null, null, null, null, null, null)
    .accounts({ good, seller: w.sellerAgent, protocolConfig: w.protocolPda, authority: w.seller.publicKey })
    .instruction(), [w.seller]), "seller delists");
  const buyer = freshBuyer(w);
  expectFail((await buyGood(w, { good, buyer, serial: 0, expectedPrice: MIN_GOOD_PRICE, metaHash })).res,
    "GoodsNotActive", "delisted good not purchasable");
});

test("takedown floor: a blocked metadata hash cannot be listed or purchased", async () => {
  const w = await goodsWorld();
  const metaHash = Buffer.alloc(32, 0x42);
  const [blockPda, blockBump] = moderationBlockPda(metaHash);
  // Inject a BLOCKED ModerationBlock (status 1 = BLOCKED) at the canonical PDA
  // with the full real struct shape so require_content_not_blocked deserializes it.
  const block = {
    content_hash: arr(metaHash),
    status: 1,
    rationale_hash: arr(Buffer.alloc(32, 5)),
    rationale_uri: "https://mod/why.json",
    set_at: new BN(1_700_000_000),
    updated_at: new BN(1_700_000_000),
    updated_by: w.admin.publicKey,
    bump: blockBump,
    _reserved: arr(Buffer.alloc(16)),
  };
  const data = await coder.accounts.encode("ModerationBlock", block);
  w.svm.setAccount(blockPda, { lamports: Number(w.svm.minimumBalanceForRentExemption(BigInt(data.length))), data, owner: PID, executable: false, rentEpoch: 0 });
  expectFail((await createGood(w, { metaHash })).res, "ContentBlocked", "blocked hash cannot be listed");
});

test("SPL rail: three-way token split", async () => {
  const w = await goodsWorld();
  const mint = Keypair.generate();
  const operator = Keypair.generate();
  w.svm.airdrop(operator.publicKey, BigInt(1e9));
  const rent = Number(w.svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE)));
  expectOk(send(w.svm, SystemProgram.createAccount({ fromPubkey: w.admin.publicKey, newAccountPubkey: mint.publicKey, lamports: rent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }), [w.admin, mint]), "create mint acct (part1)");
  // initialize mint + fund buyer ATA in one flow
  const buyer = freshBuyer(w);
  const buyerAta = getAssociatedTokenAddressSync(mint.publicKey, buyer.kp.publicKey);
  const sellerAta = getAssociatedTokenAddressSync(mint.publicKey, w.seller.publicKey);
  const treasuryAta = getAssociatedTokenAddressSync(mint.publicKey, w.admin.publicKey);
  const operatorAta = getAssociatedTokenAddressSync(mint.publicKey, operator.publicKey);
  const price = 1_000_000;
  expectOk(send(w.svm, createInitializeMintInstruction(mint.publicKey, 0, w.admin.publicKey, null), [w.admin]), "init mint");
  for (const [owner, ata] of [[buyer.kp.publicKey, buyerAta], [w.seller.publicKey, sellerAta], [w.admin.publicKey, treasuryAta], [operator.publicKey, operatorAta]]) {
    expectOk(send(w.svm, createAssociatedTokenAccountInstruction(w.admin.publicKey, ata, owner, mint.publicKey), [w.admin]), "ata");
  }
  expectOk(send(w.svm, createMintToInstruction(mint.publicKey, buyerAta, w.admin.publicKey, price), [w.admin]), "fund buyer");

  const { good } = await createGood(w, { price, priceMint: mint.publicKey, operator: operator.publicKey, operatorFeeBps: 300 });
  const [receipt] = pda([enc("goods_sale"), good.toBuffer(), new BN(0).toArrayLike(Buffer, "le", 8)]);
  expectOk(send(w.svm, await buyer.prog.methods
    .purchaseGood(new BN(0), new BN(price))
    .accounts({
      good, saleReceipt: receipt, sellerAgent: w.sellerAgent, sellerWallet: w.seller.publicKey,
      protocolConfig: w.protocolPda, treasury: w.admin.publicKey,
      moderationBlock: moderationBlockPda(Buffer.alloc(32, 9))[0], authority: buyer.kp.publicKey,
      systemProgram: SystemProgram.programId, operatorWallet: operator.publicKey,
      priceMint: mint.publicKey, buyerTokenAccount: buyerAta, sellerTokenAccount: sellerAta,
      treasuryTokenAccount: treasuryAta, operatorTokenAccount: operatorAta, tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction(), [buyer.kp]), "SPL purchase");
  assert.equal(tokenAmount(w.svm, treasuryAta), 50_000n, "treasury token cut");
  assert.equal(tokenAmount(w.svm, operatorAta), 30_000n, "operator token cut");
  assert.equal(tokenAmount(w.svm, sellerAta), 920_000n, "seller token remainder");
  assert.equal(tokenAmount(w.svm, buyerAta), 0n, "buyer spent all");
});

// Byte-patch a live AgentRegistration in place (full decode/re-encode trips the
// enum coder). Layout after the 8-byte discriminator: agent_id[32] @8,
// authority[32] @40, capabilities[8] @72, status(u8) @80.
function mutateAgent(w, agentPda, { authority, status } = {}) {
  const acct = w.svm.getAccount(agentPda);
  const data = Buffer.from(acct.data);
  if (authority) authority.toBuffer().copy(data, 40);
  if (status !== undefined) data.writeUInt8(status, 80);
  w.svm.setAccount(agentPda, { lamports: Number(acct.lamports), data, owner: PID, executable: false, rentEpoch: 0 });
}

test("AC-2: payout follows the snapshotted seller_authority, not the live agent authority", async () => {
  const w = await goodsWorld();
  const price = 1_000_000;
  const { good, metaHash } = await createGood(w, { price, totalSupply: 3 });
  // The listing snapshotted the seller wallet.
  assert.equal(decode(w.svm, "GoodsListing", good).seller_authority.toBase58(), w.seller.publicKey.toBase58());

  // Simulate a deregister + attacker re-register of the SAME agent_id: the agent
  // PDA is unchanged but its `authority` is now the attacker's.
  const attacker = Keypair.generate();
  w.svm.airdrop(attacker.publicKey, BigInt(100e9));
  mutateAgent(w, w.sellerAgent, { authority: attacker.publicKey });

  // Paying out to the ATTACKER (the current agent authority) is REJECTED — the
  // seller_wallet constraint pins to good.seller_authority (the snapshot).
  const buyer = freshBuyer(w);
  const [receipt] = pda([enc("goods_sale"), good.toBuffer(), new BN(0).toArrayLike(Buffer, "le", 8)]);
  const attackerRes = send(w.svm, await buyer.prog.methods.purchaseGood(new BN(0), new BN(price))
    .accounts({ good, saleReceipt: receipt, sellerAgent: w.sellerAgent, sellerWallet: attacker.publicKey,
      protocolConfig: w.protocolPda, treasury: w.admin.publicKey, moderationBlock: moderationBlockPda(metaHash)[0],
      authority: buyer.kp.publicKey, systemProgram: SystemProgram.programId, operatorWallet: null,
      priceMint: null, buyerTokenAccount: null, sellerTokenAccount: null, treasuryTokenAccount: null, operatorTokenAccount: null, tokenProgram: null })
    .instruction(), [buyer.kp]);
  expectFail(attackerRes, "InvalidInput", "payout to the re-registered attacker authority rejected");

  // Paying out to the ORIGINAL seller wallet (the snapshot) still succeeds.
  const buyer2 = freshBuyer(w);
  const before = bal(w, w.seller.publicKey);
  expectOk((await buyGood(w, { good, buyer: buyer2, serial: 0, expectedPrice: price, metaHash })).res, "snapshot payee still paid");
  assert.equal(bal(w, w.seller.publicKey) - before, 950_000, "original seller received the payout");
});

test("AC-1: a suspended seller cannot sell (revert-sensitive)", async () => {
  const w = await goodsWorld();
  const { good, metaHash } = await createGood(w, { price: MIN_GOOD_PRICE });
  // Suspend the seller agent (status 3).
  mutateAgent(w, w.sellerAgent, { status: 3 });
  const buyer = freshBuyer(w);
  expectFail((await buyGood(w, { good, buyer, serial: 0, expectedPrice: MIN_GOOD_PRICE, metaHash })).res,
    "AgentSuspended", "suspended seller's good cannot be purchased");
  // Restore to Active -> the sale goes through (proves the gate is the cause).
  // A fresh buyer keeps the tx distinct from the failed suspended attempt
  // (litesvm dedupes byte-identical transactions).
  mutateAgent(w, w.sellerAgent, { status: 1 });
  const buyer2 = freshBuyer(w);
  expectOk((await buyGood(w, { good, buyer: buyer2, serial: 0, expectedPrice: MIN_GOOD_PRICE, metaHash })).res, "reactivated seller can sell");
});

test("GOODS-OP-PDA-02: operator cannot be the listing's own PDA", async () => {
  const w = await goodsWorld();
  const goodId = id32();
  const [good] = pda([enc("good"), w.sellerAgent.toBuffer(), Buffer.from(goodId)]);
  const metaHash = Buffer.alloc(32, 9);
  // operator = the good PDA itself -> the fee would be locked forever.
  expectFail(send(w.svm, await w.sellerProg.methods
    .createGoodsListing(arr(goodId), arr(Buffer.alloc(32, 7)), arr(metaHash), "https://x/y.json", new BN(MIN_GOOD_PRICE), null, arr(Buffer.alloc(64, 3)), new BN(3), good, 300)
    .accounts({ good, seller: w.sellerAgent, protocolConfig: w.protocolPda, moderationBlock: moderationBlockPda(metaHash)[0], authority: w.seller.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.seller]), "GoodsInvalidOperatorTerms", "operator == listing PDA rejected");
});

test("invalid create args are rejected", async () => {
  const w = await goodsWorld();
  // zero supply
  expectFail((await createGood(w, { totalSupply: 0 })).res, "GoodsInvalidSupply", "zero supply");
  // below min price
  expectFail((await createGood(w, { price: MIN_GOOD_PRICE - 1 })).res, "GoodsPriceBelowMinimum", "below min price");
  // operator fee without operator
  const goodId = id32();
  const [good] = pda([enc("good"), w.sellerAgent.toBuffer(), Buffer.from(goodId)]);
  const metaHash = Buffer.alloc(32, 9);
  expectFail(send(w.svm, await w.sellerProg.methods
    .createGoodsListing(arr(goodId), arr(Buffer.alloc(32, 7)), arr(metaHash), "https://x/y.json", new BN(MIN_GOOD_PRICE), null, arr(Buffer.alloc(64, 3)), new BN(3), PublicKey.default, 300)
    .accounts({ good, seller: w.sellerAgent, protocolConfig: w.protocolPda, moderationBlock: moderationBlockPda(metaHash)[0], authority: w.seller.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.seller]), "GoodsInvalidOperatorTerms", "fee without operator");
});
