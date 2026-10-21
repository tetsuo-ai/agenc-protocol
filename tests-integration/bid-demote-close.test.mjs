// Isolates the close-on-demotion half of the fix: the bidder never calls update_bid.
import test from "node:test";
import assert from "node:assert/strict";
import { freshWorld, makeProgram, send, expectOk, decode, isClosed, warpSeconds } from "./harness.mjs";
import { setupBidExclusiveFixture } from "./bid-fixture.mjs";

test("demotion closes a dead leader even when update_bid was never called", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const b = await setupBidExclusiveFixture(w, { tag: "demote-close" });
  warpSeconds(w.svm, 61);
  expectOk(send(w.svm, await w.providerProg.methods.updateAgent(null, null, null, 0)
    .accounts({ agent: w.providerAgent, authority: w.provider.publicKey }).instruction(), [w.provider]), "become Inactive");
  const refundBefore = Number(w.svm.getBalance(w.provider.publicKey));
  const bidBalance = Number(w.svm.getBalance(b.bid));
  const ix = await makeProgram(w.admin).methods.demoteIneligibleBest().accounts({
    protocolConfig: w.protocolPda, task: b.task, bidBook: b.bidBook, bid: b.bid,
    bidder: w.providerAgent, bidderMarketState: b.bidderMarket,
    bidderAuthority: w.provider.publicKey, authority: w.admin.publicKey,
  }).instruction();
  expectOk(send(w.svm, ix, [w.admin]), "permissionless demotion");
  assert.ok(isClosed(w.svm, b.bid), "the demoted bid must close");
  assert.equal(Number(w.svm.getBalance(w.provider.publicKey)), refundBefore + bidBalance);
  assert.equal(decode(w.svm, "TaskBidBook", b.bidBook).active_bids, 0);
  assert.equal(decode(w.svm, "BidderMarketState", b.bidderMarket).active_bid_count, 0);
});
