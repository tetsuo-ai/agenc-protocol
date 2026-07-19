// Audit (2026-07 swarm): close_task had no bid awareness. Bids lock real lamports
// on per-bid PDAs, and every withdrawal path (expire_bid / cancel_bid) loads the
// Task by seeds — so a creator could cancel_task + close_task atomically (or
// complete + close) and permanently lock every losing bidder's bond + rent with
// zero withdrawal window. close_task now requires the canonical bid book for
// BidExclusive tasks and refuses while it reports active bids.
//
// Revert-sensitive: without the guard, close_task succeeds at the "active bid"
// step and the bidders are bricked.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode, isClosed,
  injectBidMarketplace, freshWorld,
  taskModV2Pda, moderationBlockPda,
  BN, Keypair, SystemProgram,
} from "./harness.mjs";
import { Buffer } from "node:buffer";

async function setupBidTask(w, { bidExpiresIn = 1800, minBond = 100_000 } = {}) {
  const modProg = makeProgram(w.modAuth);
  const taskId = id32();
  const reward = 4_000_000;
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(reward), 1, new BN(now + 3600), 3, null, 0, null, null, 0)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "bid:create_task");

  const jobHash = id32();
  const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "bid:task-mod");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/bidguard", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "bid:publish");
  const lockedJobSpec = decode(w.svm, "TaskJobSpec", jobSpec);

  const bidMarket = await injectBidMarketplace(w.svm, w.admin, { minBond });
  const [bidBook] = pda([enc("bid_book"), task.toBuffer()]);
  expectOk(send(w.svm, await w.buyerProg.methods
    .initializeBidBook(0, 0, 0, 0, 0)
    .accounts({ task, taskJobSpec: jobSpec, bidBook, protocolConfig: w.protocolPda, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "bid:init-book");

  const [bid] = pda([enc("bid"), task.toBuffer(), w.providerAgent.toBuffer()]);
  const [bidderMarket] = pda([enc("bidder_market"), w.providerAgent.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .createBid(new BN(reward), 900, 5000, arr(Buffer.alloc(32, 4)), arr(Buffer.alloc(32, 5)), new BN(now + bidExpiresIn), arr(jobHash), lockedJobSpec.updated_at)
    .accounts({ protocolConfig: w.protocolPda, bidMarketplace: bidMarket, task, taskJobSpec: jobSpec, bidBook, bid, bidderMarketState: bidderMarket, bidder: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "bid:create_bid");

  return { task, escrow, jobSpec, bidBook, bid, bidMarket, bidderMarket, reward };
}

function closeTaskIx(w, r, withBook) {
  const creatorBond = pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0];
  const ix = w.buyerProg.methods
    .closeTask()
    .accounts({ task: r.task, taskJobSpec: r.jobSpec, escrow: null, hireRecord: pda([enc("hire"), r.task.toBuffer()])[0], listing: null, creatorCompletionBond: creatorBond, workerCompletionBond: null, authority: w.buyer.publicKey });
  // Writable: once active_bids == 0 the close SWEEPS the creator-funded book's
  // rent back to the creator (audit C8) instead of stranding it on the terminal task.
  if (withBook) ix.remainingAccounts([{ pubkey: r.bidBook, isSigner: false, isWritable: true }]);
  return ix.instruction();
}

test("close_task refuses to brick live bids on a BidExclusive task", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await setupBidTask(w, { bidExpiresIn: 60 });
  assert.equal(decode(w.svm, "TaskBidBook", r.bidBook).active_bids, 1, "one live bid");

  // Cancel the Open task (zero-worker BidExclusive path closes the BOOK state only).
  expectOk(send(w.svm, await w.buyerProg.methods
    .cancelTask()
    .accounts({
      task: r.task, escrow: r.escrow, authority: w.buyer.publicKey, protocolConfig: w.protocolPda,
      systemProgram: SystemProgram.programId,
      tokenEscrowAta: null, creatorTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0],
      workerCompletionBond: pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()])[0],
      workerBondAuthority: w.provider.publicKey,
      creatorAgent: null, agentStats: null,
      treasury: null,
    })
    .remainingAccounts([{ pubkey: r.bidBook, isSigner: false, isWritable: true }])
    .instruction(), [w.buyer]), "cancel the open bid task");
  assert.equal(decode(w.svm, "Task", r.task).status.Cancelled !== undefined, true, "task Cancelled");
  assert.equal(decode(w.svm, "TaskBidBook", r.bidBook).active_bids, 1, "the bid is STILL active (book close doesn't settle it)");

  // Omitting the book fails closed.
  expectFail(
    send(w.svm, await closeTaskIx(w, r, false), [w.buyer]),
    "BidSettlementAccountsRequired",
    "close_task on a BidExclusive task requires the bid book",
  );

  // With the book, the active bid blocks the close (pre-fix: brick).
  expectFail(
    send(w.svm, await closeTaskIx(w, r, true), [w.buyer]),
    "TaskNotClosable",
    "close_task refused while a bid is active (pre-fix: permanent bond lock)",
  );
  assert.ok(!isClosed(w.svm, r.task), "Task PDA survives — bidders keep their exit");

  // The bidder withdraws via expire_bid (book is Closed and the bid lapsed).
  const clk = w.svm.getClock();
  clk.unixTimestamp = clk.unixTimestamp + 61n;
  w.svm.setClock(clk);
  const cleaner = Keypair.generate();
  w.svm.airdrop(cleaner.publicKey, BigInt(10e9));
  expectOk(send(w.svm, await makeProgram(cleaner).methods
    .expireBid()
    .accounts({ protocolConfig: w.protocolPda, task: r.task, bidBook: r.bidBook, bid: r.bid, bidderMarketState: r.bidderMarket, bidder: w.providerAgent, bidderAuthority: w.provider.publicKey, authority: cleaner.publicKey })
    .instruction(), [cleaner]), "bidder withdraws via expire_bid");
  assert.equal(decode(w.svm, "TaskBidBook", r.bidBook).active_bids, 0, "no active bids left");

  // Now the close proceeds.
  w.svm.expireBlockhash();
  const bookRent = Number(w.svm.getBalance(r.bidBook));
  const creatorBefore = Number(w.svm.getBalance(w.buyer.publicKey));
  expectOk(send(w.svm, await closeTaskIx(w, r, true), [w.buyer]), "close_task after all bids withdrawn");
  assert.ok(!isClosed(w.svm, r.task), "durable terminal Task anchor remains");
  assert.ok(decode(w.svm, "Task", r.task).status.Cancelled !== undefined, "terminal state remains decodable");

  // Audit C8: the book is swept in the same transaction — its creator-funded
  // rent returns to the creator instead of stranding on the terminal task.
  assert.ok(isClosed(w.svm, r.bidBook), "bid book swept (pre-C8: its rent stranded forever)");
  assert.ok(
    Number(w.svm.getBalance(w.buyer.publicKey)) - creatorBefore >= bookRent - 10_000,
    "book rent returned to the creator",
  );
});
