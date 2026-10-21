// AGNC-04 regression: update_bid must require the full bidder eligibility
// predicate (an unacceptable bidder can never install as the tracked winner),
// and demote_ineligible_best closes the provably-dead leader's bid so it
// cannot be reinstalled inside the re-promotion grace window. Derived from the
// reporter's PoC (control preserved).
import test from "node:test";
import assert from "node:assert/strict";
import {
  enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode, isClosed,
  freshWorld, moderationBlockPda,
  BN, Keypair, SystemProgram,
} from "./harness.mjs";
import { createPublishedTaskFixture, createActiveBidFixture } from "./bid-fixture.mjs";
import { calculateBidTermsHash } from "../scripts/preflight-bid-contract-scan.mjs";
import { Buffer } from "node:buffer";

const BUDGET = 4_000_000;
const HONEST_PRICE = 3_000_000;
const GRACE = 300; // BID_REPROMOTION_GRACE_SECS in the production build

function warp(w, secs) {
  const c = w.svm.getClock();
  c.unixTimestamp = c.unixTimestamp + BigInt(secs);
  w.svm.setClock(c);
  w.svm.expireBlockhash();
}

function termsHash(w, b, bid) {
  const s = decode(w.svm, "TaskBid", bid);
  const spec = decode(w.svm, "TaskJobSpec", b.jobSpec);
  return calculateBidTermsHash(b.task, bid, {
    task: s.task, bidBook: s.bid_book, bidder: s.bidder, bidderAuthority: s.bidder_authority,
    requestedReward: BigInt(s.requested_reward_lamports.toString()), etaSeconds: s.eta_seconds,
    confidenceBps: s.confidence_bps, reputationSnapshotBps: s.reputation_snapshot_bps,
    qualityGuaranteeHash: Buffer.from(s.quality_guarantee_hash), metadataHash: Buffer.from(s.metadata_hash),
    expiresAt: BigInt(s.expires_at.toString()), createdAt: BigInt(s.created_at.toString()),
    updatedAt: BigInt(s.updated_at.toString()), bondLamports: BigInt(s.bond_lamports.toString()),
    acceptedNoShowSlashBps: s.accepted_no_show_slash_bps,
  }, { jobSpecHash: Buffer.from(spec.job_spec_hash), updatedAt: BigInt(spec.updated_at.toString()) });
}

function acceptIx(w, b, bid, bidderAgent) {
  const [claim] = pda([enc("claim"), b.task.toBuffer(), bidderAgent.toBuffer()]);
  return w.buyerProg.methods
    .acceptBid(arr(termsHash(w, b, bid)))
    .accounts({
      task: b.task, claim, protocolConfig: w.protocolPda, bidBook: b.bidBook, bid,
      bidderMarketState: pda([enc("bidder_market"), bidderAgent.toBuffer()])[0],
      bidder: bidderAgent, taskJobSpec: b.jobSpec, moderationBlock: moderationBlockPda(b.jobHash)[0],
      creator: w.buyer.publicKey, systemProgram: SystemProgram.programId,
    })
    .instruction();
}

function demoteIx(w, b, bid, bidderAgent, bidderAuthority, signer) {
  return makeProgram(signer).methods
    .demoteIneligibleBest()
    .accounts({
      protocolConfig: w.protocolPda, task: b.task, bidBook: b.bidBook, bid,
      bidder: bidderAgent,
      bidderMarketState: pda([enc("bidder_market"), bidderAgent.toBuffer()])[0],
      bidderAuthority,
      authority: signer.publicKey,
    })
    .instruction();
}

function promoteIx(w, b, bid, bidderAgent, signer) {
  return makeProgram(signer).methods
    .promoteBid()
    .accounts({ protocolConfig: w.protocolPda, task: b.task, bidBook: b.bidBook, bid, bidder: bidderAgent, authority: signer.publicKey })
    .instruction();
}

async function setup(w) {
  const t = await createPublishedTaskFixture(w, { budget: BUDGET, taskType: 3, tag: "m6" });
  const b = await createActiveBidFixture(w, t, { bidPrice: HONEST_PRICE, tag: "m6" });
  const m = Keypair.generate();
  w.svm.airdrop(m.publicKey, BigInt(100e9));
  const mProg = makeProgram(m);
  const agentId = id32();
  const [mAgent] = pda([enc("agent"), agentId]);
  expectOk(send(w.svm, await mProg.methods
    .registerAgent(arr(agentId), new BN(1), "http://m.test", null, new BN(0))
    .accounts({ agent: mAgent, protocolConfig: w.protocolPda, authority: m.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [m]), "register attacker agent");
  const [mBid] = pda([enc("bid"), b.task.toBuffer(), mAgent.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  expectOk(send(w.svm, await mProg.methods
    .createBid(new BN(3_900_000), 900, 5_000, arr(Buffer.alloc(32, 4)), arr(Buffer.alloc(32, 5)), new BN(now + 1_800), arr(b.jobHash), b.jobSpecUpdatedAt)
    .accounts({ protocolConfig: w.protocolPda, bidMarketplace: b.bidMarketplace, task: b.task, taskJobSpec: b.jobSpec, bidBook: b.bidBook, bid: mBid, bidderMarketState: pda([enc("bidder_market"), mAgent.toBuffer()])[0], bidder: mAgent, authority: m.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [m]), "attacker creates a worse bid while Active");
  assert.equal(decode(w.svm, "TaskBidBook", b.bidBook).best_bid.toBase58(), b.bid.toBase58(), "honest bid is the tracked best");
  return { b, m, mProg, mAgent, mBid };
}

async function mUpdateIx(w, s, salt) {
  const now = Number(w.svm.getClock().unixTimestamp);
  return s.mProg.methods
    .updateBid(new BN(1), 1, 10_000, arr(Buffer.alloc(32, 4)), arr(Buffer.alloc(32, salt)), new BN(now + 1_800), arr(s.b.jobHash), s.b.jobSpecUpdatedAt)
    .accounts({ task: s.b.task, taskJobSpec: s.b.jobSpec, bidBook: s.b.bidBook, bid: s.mBid, bidder: s.mAgent, authority: s.m.publicKey, bidMarketplace: s.b.bidMarketplace, protocolConfig: w.protocolPda })
    .instruction();
}

test("control: with no ineligible leader the creator accepts the honest bid", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const s = await setup(w);
  expectOk(send(w.svm, await acceptIx(w, s.b, s.b.bid, w.providerAgent), [w.buyer]), "accept honest bid");
  assert.ok(decode(w.svm, "Task", s.b.task).status.InProgress !== undefined, "task assigned to the honest bidder");
});

test("AGNC-04: an Inactive bidder cannot install via update_bid; demote closes the dead leader", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const s = await setup(w);
  const stranger = Keypair.generate();
  w.svm.airdrop(stranger.publicKey, BigInt(10e9));

  // Attacker becomes ineligible, then tries to install unbeatable terms.
  warp(w, 61); // update_agent cooldown
  expectOk(send(w.svm, await s.mProg.methods.updateAgent(null, null, null, 0).accounts({ agent: s.mAgent, authority: s.m.publicKey }).instruction(), [s.m]), "attacker sets its agent Inactive");
  expectFail(send(w.svm, await mUpdateIx(w, s, 11), [s.m]), "BidDoesNotSatisfyMatchingPolicy",
    "update_bid refuses the Inactive bidder");
  assert.equal(decode(w.svm, "TaskBidBook", s.b.bidBook).best_bid.toBase58(), s.b.bid.toBase58(),
    "honest bid remains the tracked best");

  // Even an installed ineligible leader cannot persist: attacker flips Active,
  // installs, flips Inactive; a stranger demotes and the bid is CLOSED.
  warp(w, 61);
  expectOk(send(w.svm, await s.mProg.methods.updateAgent(null, null, null, 1).accounts({ agent: s.mAgent, authority: s.m.publicKey }).instruction(), [s.m]), "attacker reactivates");
  expectOk(send(w.svm, await mUpdateIx(w, s, 12), [s.m]), "eligible update installs");
  warp(w, 61);
  expectOk(send(w.svm, await s.mProg.methods.updateAgent(null, null, null, 0).accounts({ agent: s.mAgent, authority: s.m.publicKey }).instruction(), [s.m]), "attacker goes Inactive again");

  const bidderBefore = Number(w.svm.getBalance(s.m.publicKey));
  const bidLamports = Number(w.svm.getBalance(s.mBid));
  const market = pda([enc("bidder_market"), s.mAgent.toBuffer()])[0];
  const activeBefore = decode(w.svm, "TaskBidBook", s.b.bidBook).active_bids;
  const bidderActiveBefore = decode(w.svm, "BidderMarketState", market).active_bid_count;
  expectFail(send(w.svm, await demoteIx(w, s.b, s.mBid, s.mAgent, stranger.publicKey, stranger), [stranger]),
    "UnauthorizedAgent", "demotion cannot redirect the closed bid refund");
  expectOk(send(w.svm, await demoteIx(w, s.b, s.mBid, s.mAgent, s.m.publicKey, stranger), [stranger]),
    "stranger demotes the ineligible leader");
  assert.ok(isClosed(w.svm, s.mBid), "dead leader's bid is closed, not merely untracked");
  assert.equal(Number(w.svm.getBalance(s.m.publicKey)), bidderBefore + bidLamports, "exact bond + rent returned to bidder");
  assert.equal(decode(w.svm, "TaskBidBook", s.b.bidBook).active_bids, activeBefore - 1);
  assert.equal(decode(w.svm, "BidderMarketState", market).active_bid_count, bidderActiveBefore - 1);
  w.svm.expireBlockhash(); // Make the retry a new transaction, not AlreadyProcessed.
  expectFail(send(w.svm, await demoteIx(w, s.b, s.mBid, s.mAgent, s.m.publicKey, stranger), [stranger]),
    "AccountNotInitialized", "demoted bid cannot decrement counters twice");
  expectFail(send(w.svm, await mUpdateIx(w, s, 13), [s.m]), "AccountNotInitialized",
    "the closed bid can no longer be updated at all");

  // The honest bid is promoted and, after the grace window, accepted.
  expectOk(send(w.svm, await promoteIx(w, s.b, s.b.bid, w.providerAgent, stranger), [stranger]), "honest bid promoted");
  expectFail(send(w.svm, await acceptIx(w, s.b, s.b.bid, w.providerAgent), [w.buyer]), "BidRepromotionGraceActive",
    "accept blocked during grace");
  warp(w, GRACE + 5);
  expectOk(send(w.svm, await acceptIx(w, s.b, s.b.bid, w.providerAgent), [w.buyer]), "accept honest bid after grace");
  assert.ok(decode(w.svm, "Task", s.b.task).status.InProgress !== undefined, "task assigned to the honest bidder");
});
