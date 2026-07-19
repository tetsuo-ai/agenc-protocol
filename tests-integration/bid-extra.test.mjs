// In-process litesvm integration tests for the bid-marketplace lifecycle
// instructions that marketplace.test.mjs does not directly exercise:
//   - initialize_bid_marketplace  (multisig-gated config init)
//   - update_bid_marketplace_config (multisig-gated config update)
//   - cancel_bid                   (bidder withdraws an active bid, bond refunded)
//   - expire_bid                   (permissionless cleanup after bid lifetime, bond refunded)
//   - update_bid                   (bidder re-prices/extends an active bid)
//
// Executes the COMPILED program (target/deploy/agenc_coordination.so).
//
// Run:  cd /home/tetsuo/git/AgenC/agenc-protocol && node --test tests-integration/bid-extra.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import {
  PID, coder, enc, arr, pda, id32,
  makeProgram, send, sendMany, expectOk, expectFail, decode, isClosed,
  injectBidMarketplace, setMultisig, freshWorld,
  BN, Keypair, PublicKey, SystemProgram,
} from "./harness.mjs";
import { setupBidExclusiveFixture } from "./bid-fixture.mjs";

/// Builds a BidExclusive task (task_type=3) in a moderation-enabled world, injects
/// a BidMarketplaceConfig, opens a bid book (creator), and posts ONE active bid by
/// the provider agent. Returns all the handles cancel/expire/update_bid need.
/// `bidExpiresIn` controls the bid's lifetime relative to `now` (for expire tests);
/// `minBond` overrides the injected min bid bond (for refund assertions).
async function setupBidTask(w, { bidExpiresIn = 1800, minBond = 100_000 } = {}) {
  return setupBidExclusiveFixture(w, {
    bidExpiresIn,
    minBond,
    jobUri: "agenc://job-spec/sha256/bid",
  });
}

const BID_CFG_PDA = () => pda([enc("bid_marketplace")])[0];

// ---------------------------------------------------------------------------
// initialize_bid_marketplace
// ---------------------------------------------------------------------------

test("initialize_bid_marketplace: 2-of-2 multisig creates the config with the given params", async () => {
  // Do NOT inject the config — the real initializer requires it uninitialized.
  const w = await freshWorld();
  const owner2 = Keypair.generate(); w.svm.airdrop(owner2.publicKey, BigInt(10e9));
  await setMultisig(w.svm, [w.admin.publicKey, owner2.publicKey], 2);

  const bidCfg = BID_CFG_PDA();
  const signerMetas = [
    { pubkey: w.admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: owner2.publicKey, isSigner: true, isWritable: false },
  ];
  const buildIx = async () => makeProgram(w.admin).methods
    .initializeBidMarketplace(new BN(250_000), new BN(0), 100, 10, new BN(86_400), 0)
    .accounts({ protocolConfig: w.protocolPda, bidMarketplace: bidCfg, authority: w.admin.publicKey, systemProgram: SystemProgram.programId })
    .remainingAccounts(signerMetas)
    .instruction();

  expectOk(send(w.svm, await buildIx(), [w.admin, owner2]), "init bid marketplace (2-of-2)");

  const cfg = decode(w.svm, "BidMarketplaceConfig", bidCfg);
  assert.ok(cfg !== null, "config account created");
  assert.equal(cfg.authority.toBase58(), w.admin.publicKey.toBase58(), "authority == protocol authority");
  assert.equal(cfg.min_bid_bond_lamports.toString(), "250000", "min bond stored");
  assert.equal(cfg.max_bids_per_24h, 100, "max_bids_per_24h stored");
  assert.equal(cfg.max_active_bids_per_task, 10, "max_active_bids_per_task stored");
  assert.equal(cfg.max_bid_lifetime_secs.toString(), "86400", "max lifetime stored");
  assert.notEqual(cfg.bump, 0, "bump set (config is live)");
});

test("initialize_bid_marketplace: a single signer fails the multisig gate (MultisigNotEnoughSigners)", async () => {
  const w = await freshWorld();
  const owner2 = Keypair.generate(); w.svm.airdrop(owner2.publicKey, BigInt(10e9));
  await setMultisig(w.svm, [w.admin.publicKey, owner2.publicKey], 2);

  const bidCfg = BID_CFG_PDA();
  // Only admin signs / is passed as a remaining account -> 1 approval < threshold 2.
  const res = send(w.svm, await makeProgram(w.admin).methods
    .initializeBidMarketplace(new BN(250_000), new BN(0), 100, 10, new BN(86_400), 0)
    .accounts({ protocolConfig: w.protocolPda, bidMarketplace: bidCfg, authority: w.admin.publicKey, systemProgram: SystemProgram.programId })
    .remainingAccounts([{ pubkey: w.admin.publicKey, isSigner: true, isWritable: false }])
    .instruction(), [w.admin]);
  expectFail(res, "MultisigNotEnoughSigners", "single signer cannot initialize the bid marketplace");
  assert.ok(isClosed(w.svm, bidCfg), "config NOT created (tx reverted)");
});

// ---------------------------------------------------------------------------
// update_bid_marketplace_config
// ---------------------------------------------------------------------------

test("update_bid_marketplace_config: 2-of-2 multisig mutates the live config in place", async () => {
  const w = await freshWorld();
  const owner2 = Keypair.generate(); w.svm.airdrop(owner2.publicKey, BigInt(10e9));
  await setMultisig(w.svm, [w.admin.publicKey, owner2.publicKey], 2);

  // Inject a starting config (min bond 100_000) — the update is to a NEW value.
  const bidCfg = await injectBidMarketplace(w.svm, w.admin, { minBond: 100_000 });
  assert.equal(decode(w.svm, "BidMarketplaceConfig", bidCfg).min_bid_bond_lamports.toString(), "100000", "starting bond");

  const signerMetas = [
    { pubkey: w.admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: owner2.publicKey, isSigner: true, isWritable: false },
  ];
  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .updateBidMarketplaceConfig(new BN(500_000), new BN(60), 50, 7, new BN(43_200), 250)
    .accounts({ protocolConfig: w.protocolPda, bidMarketplace: bidCfg, authority: w.admin.publicKey })
    .remainingAccounts(signerMetas)
    .instruction(), [w.admin, owner2]), "update bid marketplace config");

  const cfg = decode(w.svm, "BidMarketplaceConfig", bidCfg);
  assert.equal(cfg.min_bid_bond_lamports.toString(), "500000", "min bond updated");
  assert.equal(cfg.bid_creation_cooldown_secs.toString(), "60", "cooldown updated");
  assert.equal(cfg.max_bids_per_24h, 50, "max_bids_per_24h updated");
  assert.equal(cfg.max_active_bids_per_task, 7, "max_active_bids_per_task updated");
  assert.equal(cfg.max_bid_lifetime_secs.toString(), "43200", "lifetime updated");
  assert.equal(cfg.accepted_no_show_slash_bps, 250, "slash bps updated");
});

test("update_bid_marketplace_config: a single signer fails the multisig gate (MultisigNotEnoughSigners)", async () => {
  const w = await freshWorld();
  const owner2 = Keypair.generate(); w.svm.airdrop(owner2.publicKey, BigInt(10e9));
  await setMultisig(w.svm, [w.admin.publicKey, owner2.publicKey], 2);
  const bidCfg = await injectBidMarketplace(w.svm, w.admin, { minBond: 100_000 });

  const res = send(w.svm, await makeProgram(w.admin).methods
    .updateBidMarketplaceConfig(new BN(500_000), new BN(60), 50, 7, new BN(43_200), 250)
    .accounts({ protocolConfig: w.protocolPda, bidMarketplace: bidCfg, authority: w.admin.publicKey })
    .remainingAccounts([{ pubkey: w.admin.publicKey, isSigner: true, isWritable: false }])
    .instruction(), [w.admin]);
  expectFail(res, "MultisigNotEnoughSigners", "single signer cannot update the bid marketplace config");
  // unchanged
  assert.equal(decode(w.svm, "BidMarketplaceConfig", bidCfg).min_bid_bond_lamports.toString(), "100000", "config unchanged on revert");
});

// ---------------------------------------------------------------------------
// cancel_bid
// ---------------------------------------------------------------------------

test("cancel_bid: the bidder withdraws an active bid; the bond is refunded and the bid closed", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const minBond = 200_000;
  const b = await setupBidTask(w, { minBond });

  const bookBefore = decode(w.svm, "TaskBidBook", b.bidBook);
  assert.equal(bookBefore.active_bids, 1, "one active bid before cancel");
  const marketBefore = decode(w.svm, "BidderMarketState", b.bidderMarket);
  assert.equal(marketBefore.active_bid_count, 1, "bidder has one active bid before cancel");
  const bidLamports = Number(w.svm.getBalance(b.bid)); // rent + bond, all refunded on close
  assert.ok(bidLamports >= minBond, "bid account holds at least the bond");
  const providerBefore = Number(w.svm.getBalance(w.provider.publicKey));

  expectOk(send(w.svm, await w.providerProg.methods
    .cancelBid()
    .accounts({ task: b.task, bidBook: b.bidBook, bid: b.bid, bidderMarketState: b.bidderMarket, bidder: w.providerAgent, authority: w.provider.publicKey })
    .instruction(), [w.provider]), "cancel_bid");

  assert.ok(isClosed(w.svm, b.bid), "bid account closed");
  const providerAfter = Number(w.svm.getBalance(w.provider.publicKey));
  // close = authority refunds the full bid balance (rent + bond) to the bidder authority.
  assert.ok(providerAfter - providerBefore >= minBond, `bidder refunded the bond (delta ${providerAfter - providerBefore} >= ${minBond})`);

  const bookAfter = decode(w.svm, "TaskBidBook", b.bidBook);
  assert.equal(bookAfter.active_bids, 0, "active_bids decremented");
  assert.equal(bookAfter.version.toString(), bookBefore.version.add(new BN(1)).toString(), "book version bumped");
  const marketAfter = decode(w.svm, "BidderMarketState", b.bidderMarket);
  assert.equal(marketAfter.active_bid_count, 0, "bidder active_bid_count decremented");
});

test("cancel_bid: a non-owner signer is rejected (UnauthorizedAgent)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const b = await setupBidTask(w, {});

  // The buyer (task creator) is a valid signer but is NOT the bid's bidder_authority.
  const res = send(w.svm, await w.buyerProg.methods
    .cancelBid()
    .accounts({ task: b.task, bidBook: b.bidBook, bid: b.bid, bidderMarketState: b.bidderMarket, bidder: w.providerAgent, authority: w.buyer.publicKey })
    .instruction(), [w.buyer]);
  expectFail(res, "UnauthorizedAgent", "non-owner cannot cancel another agent's bid");
  assert.ok(!isClosed(w.svm, b.bid), "bid NOT closed (tx reverted)");
});

// ---------------------------------------------------------------------------
// expire_bid
// ---------------------------------------------------------------------------

test("expire_bid: after the bid lifetime lapses, a permissionless cleaner refunds the bond and closes the bid", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const minBond = 200_000;
  const b = await setupBidTask(w, { minBond, bidExpiresIn: 1800 });
  const cleaner = Keypair.generate(); w.svm.airdrop(cleaner.publicKey, BigInt(10e9));

  const expireIx = async () => makeProgram(cleaner).methods
    .expireBid()
    .accounts({ protocolConfig: w.protocolPda, task: b.task, bidBook: b.bidBook, bid: b.bid, bidderMarketState: b.bidderMarket, bidder: w.providerAgent, bidderAuthority: w.provider.publicKey, authority: cleaner.publicKey })
    .instruction();

  // Before the bid expires -> BidNotExpired.
  expectFail(send(w.svm, await expireIx(), [cleaner]), "BidNotExpired", "expire too early");
  assert.ok(!isClosed(w.svm, b.bid), "bid still live before expiry");

  // Warp past the bid's expires_at (now + 1800).
  const clk = w.svm.getClock(); clk.unixTimestamp = clk.unixTimestamp + 1801n; w.svm.setClock(clk);
  const providerBefore = Number(w.svm.getBalance(w.provider.publicKey));
  const bookBefore = decode(w.svm, "TaskBidBook", b.bidBook);
  w.svm.expireBlockhash();

  expectOk(send(w.svm, await expireIx(), [cleaner]), "expire_bid after lifetime");

  assert.ok(isClosed(w.svm, b.bid), "bid account closed by expire_bid");
  // expire_bid closes the bid to bidder_authority (the provider), refunding rent + bond.
  const providerAfter = Number(w.svm.getBalance(w.provider.publicKey));
  assert.ok(providerAfter - providerBefore >= minBond, `bond refunded to the bidder authority on expiry (delta ${providerAfter - providerBefore} >= ${minBond})`);
  const bookAfter = decode(w.svm, "TaskBidBook", b.bidBook);
  assert.equal(bookAfter.active_bids, bookBefore.active_bids - 1, "active_bids decremented on expiry");
  assert.equal(decode(w.svm, "BidderMarketState", b.bidderMarket).active_bid_count, 0, "bidder active_bid_count decremented");
});

// ---------------------------------------------------------------------------
// update_bid
// ---------------------------------------------------------------------------

test("update_bid: the bidder re-prices/extends an active bid; fields + book version change", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const b = await setupBidTask(w, {});

  const before = decode(w.svm, "TaskBid", b.bid);
  const bookBefore = decode(w.svm, "TaskBidBook", b.bidBook);
  assert.equal(before.requested_reward_lamports.toString(), b.reward.toString(), "starting reward == task reward");

  const newReward = b.reward - 500_000; // strictly below task budget, > 0
  const newEta = 600;
  const newConfidence = 9000;
  const newQuality = arr(Buffer.alloc(32, 7));
  const newMeta = arr(Buffer.alloc(32, 8));
  const newExpires = b.now + 3000; // > now, <= deadline (now+3600), within lifetime (86400)

  expectOk(send(w.svm, await w.providerProg.methods
    .updateBid(new BN(newReward), newEta, newConfidence, newQuality, newMeta, new BN(newExpires), arr(b.jobHash), b.jobSpecUpdatedAt)
    .accounts({ task: b.task, taskJobSpec: b.jobSpec, bidBook: b.bidBook, bid: b.bid, bidder: w.providerAgent, authority: w.provider.publicKey, bidMarketplace: b.bidMarket, protocolConfig: w.protocolPda })
    .instruction(), [w.provider]), "update_bid");

  const after = decode(w.svm, "TaskBid", b.bid);
  assert.equal(after.requested_reward_lamports.toString(), newReward.toString(), "reward updated");
  assert.equal(after.eta_seconds, newEta, "eta updated");
  assert.equal(after.confidence_bps, newConfidence, "confidence updated");
  assert.equal(after.expires_at.toString(), newExpires.toString(), "expiry updated");
  assert.deepEqual(after.quality_guarantee_hash, newQuality, "quality hash updated");
  assert.deepEqual(after.metadata_hash, newMeta, "metadata hash updated");
  assert.ok(after.state.BoundActive !== undefined, "bid stays BoundActive after update");

  const bookAfter = decode(w.svm, "TaskBidBook", b.bidBook);
  assert.equal(bookAfter.version.toString(), bookBefore.version.add(new BN(1)).toString(), "book version bumped on update");
});

test("update_bid: a bid above the task budget is rejected (BidPriceExceedsTaskBudget)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const b = await setupBidTask(w, {});

  const tooHigh = b.reward + 1; // exceeds task.reward_amount
  const res = send(w.svm, await w.providerProg.methods
    .updateBid(new BN(tooHigh), 900, 5000, arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 8)), new BN(b.now + 1800), arr(b.jobHash), b.jobSpecUpdatedAt)
    .accounts({ task: b.task, taskJobSpec: b.jobSpec, bidBook: b.bidBook, bid: b.bid, bidder: w.providerAgent, authority: w.provider.publicKey, bidMarketplace: b.bidMarket, protocolConfig: w.protocolPda })
    .instruction(), [w.provider]);
  expectFail(res, "BidPriceExceedsTaskBudget", "update_bid above the task budget is refused");
  // unchanged
  assert.equal(decode(w.svm, "TaskBid", b.bid).requested_reward_lamports.toString(), b.reward.toString(), "bid reward unchanged on revert");
});
