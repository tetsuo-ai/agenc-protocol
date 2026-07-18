// Audit (2026-07 swarm) — C8 low-severity batch:
//
// 1. cancel_task's claim drain refunded the whole claim PDA (rent + contest
//    entry deposit) to a NO-SHOW squatter — while every other no-show exit
//    (expire_claim / reclaim_terminal_claim) forfeits the deposit to the
//    treasury. A cancel now forfeits the surplus too (rent still returns to
//    the worker), gated on a treasury account that is REQUIRED when a drained
//    claim carries a deposit.
//
// 2. deregister_agent was blind to the bid market: an agent with live bids
//    could deregister, and every bid-withdrawal path loads the (then closed)
//    AgentRegistration — bricking the bidder's own bonds. The canonical
//    ["bidder_market", agent] PDA is now a required remaining account and the
//    guard refuses while active_bid_count > 0.
//
// 3. The AgentVerification badge is keyed ["agent_verification", agent] and the
//    agent PDA is agent_id-seeded, so a deregister -> re-register cycle (by
//    ANYONE — the agent_id is up for grabs) inherited the old registration's
//    verified-domain badge. deregister_agent now sweeps a live badge (required
//    remaining account; rent to the deregistering authority).
//
// All three are revert-sensitive: each assertion below flips if its guard is
// removed.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode, isClosed,
  freshWorld, deregisterRemaining, injectBidMarketplace,
  taskModV2Pda, moderationBlockPda,
  BN, Keypair, SystemProgram,
} from "./harness.mjs";
import { Buffer } from "node:buffer";

const CONTEST_ENTRY_DEPOSIT = 10_000_000n; // constants.rs::CONTEST_ENTRY_DEPOSIT_LAMPORTS
const balance = (w, key) => BigInt(w.svm.getBalance(key));

// ---------------------------------------------------------------------------
// Shared setups (mirrored from contest-fix-round / close-task-bid-guard).
// ---------------------------------------------------------------------------

async function registerAgent(w, capabilities = 1) {
  const kp = Keypair.generate();
  w.svm.airdrop(kp.publicKey, BigInt(100e9));
  const prog = makeProgram(kp);
  const agentId = id32();
  const [agentPda] = pda([enc("agent"), agentId]);
  expectOk(send(w.svm, await prog.methods
    .registerAgent(arr(agentId), new BN(capabilities), "http://c8.test", null, new BN(0))
    .accounts({ agent: agentPda, protocolConfig: w.protocolPda, authority: kp.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [kp]), "register agent");
  return { kp, prog, agentPda, agentId };
}

async function publishJobSpec(w, task) {
  const modProg = makeProgram(w.modAuth);
  const jobHash = id32();
  const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "task-mod");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/c8", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "job-spec");
  return { jobSpec };
}

// A CreatorReview Competitive (contest) task with a short deadline.
async function setupContestTask(w, { deadlineOffset = 60 } = {}) {
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const [validation] = pda([enc("task_validation"), task.toBuffer()]);
  const [attestor] = pda([enc("task_attestor"), task.toBuffer()]);
  const [hireRecord] = pda([enc("hire"), task.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(9_000_007), 3, new BN(now + deadlineOffset), 2, null, 0, null, null, 0)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "contest:create_task");
  expectOk(send(w.svm, await w.buyerProg.methods
    .configureTaskValidation(1, new BN(3600), 0, null)
    .accounts({ task, taskValidationConfig: validation, taskAttestorConfig: attestor, protocolConfig: w.protocolPda, hireRecord, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "contest:configure CreatorReview");
  return { task, escrow, validation };
}

function cancelTaskIx(w, m, entrant, claim, treasury) {
  return w.buyerProg.methods
    .cancelTask()
    .accounts({
      task: m.task, escrow: m.escrow, authority: w.buyer.publicKey, protocolConfig: w.protocolPda,
      tokenEscrowAta: null, creatorTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: pda([enc("completion_bond"), m.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0],
      workerCompletionBond: pda([enc("completion_bond"), m.task.toBuffer(), entrant.kp.publicKey.toBuffer()])[0],
      workerBondAuthority: entrant.kp.publicKey,
      creatorAgent: null, agentStats: null, systemProgram: SystemProgram.programId,
      treasury,
    })
    .remainingAccounts([
      { pubkey: claim, isSigner: false, isWritable: true },
      { pubkey: entrant.agentPda, isSigner: false, isWritable: true },
      { pubkey: entrant.kp.publicKey, isSigner: false, isWritable: true },
    ])
    .instruction();
}

// ---------------------------------------------------------------------------
// 1) Contest cancel: the no-show deposit is forfeited to the treasury
// ---------------------------------------------------------------------------

test("cancel_task: a no-show contest claim forfeits its entry deposit to the treasury (not back to the squatter)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const m = await setupContestTask(w, { deadlineOffset: 60 });
  const { jobSpec } = await publishJobSpec(w, m.task);
  const entrant = await registerAgent(w);

  // The squatter claims but never submits (the claim carries rent + deposit).
  const [claim] = pda([enc("claim"), m.task.toBuffer(), entrant.agentPda.toBuffer()]);
  expectOk(send(w.svm, await entrant.prog.methods
    .claimTaskWithJobSpec()
    .accounts({ task: m.task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: entrant.agentPda, authority: entrant.kp.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [entrant.kp]), "squatter claims");
  const claimTotal = balance(w, claim);
  assert.ok(claimTotal > CONTEST_ENTRY_DEPOSIT, "claim carries the entry deposit");

  // Past the deadline the creator may cancel (InProgress, completions == 0).
  const c = w.svm.getClock();
  c.unixTimestamp = c.unixTimestamp + 61n;
  w.svm.setClock(c);

  // Omitting the treasury fails closed (the forfeit cannot be dodged).
  expectFail(
    send(w.svm, await cancelTaskIx(w, m, entrant, claim, null), [w.buyer]),
    "ContestForfeitTreasuryRequired",
    "contest cancel without the treasury account",
  );

  const treasuryBefore = balance(w, w.admin.publicKey);
  const workerBefore = balance(w, entrant.kp.publicKey);
  w.svm.expireBlockhash(); // the retry shares no tx shape with the failed one, but stay safe
  expectOk(
    send(w.svm, await cancelTaskIx(w, m, entrant, claim, w.admin.publicKey), [w.buyer]),
    "contest cancel with the treasury account",
  );

  // The deposit went to the treasury; the worker got back ONLY the claim rent
  // (pre-fix: the worker got rent + deposit, the treasury nothing).
  assert.equal(
    balance(w, w.admin.publicKey) - treasuryBefore,
    CONTEST_ENTRY_DEPOSIT,
    "deposit forfeited to the treasury",
  );
  assert.equal(
    balance(w, entrant.kp.publicKey) - workerBefore,
    claimTotal - CONTEST_ENTRY_DEPOSIT,
    "worker recovered only the claim rent",
  );
  assert.ok(isClosed(w.svm, claim), "claim closed");
});

// ---------------------------------------------------------------------------
// 2) deregister_agent: live bids block deregistration
// ---------------------------------------------------------------------------

async function setupBidTask(w, { bidExpiresIn = 1800 } = {}) {
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
  const { jobSpec } = await publishJobSpec(w, task);

  const bidMarket = await injectBidMarketplace(w.svm, w.admin, { minBond: 100_000 });
  const [bidBook] = pda([enc("bid_book"), task.toBuffer()]);
  expectOk(send(w.svm, await w.buyerProg.methods
    .initializeBidBook(0, 0, 0, 0, 0)
    .accounts({ task, bidBook, protocolConfig: w.protocolPda, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "bid:init-book");

  const [bid] = pda([enc("bid"), task.toBuffer(), w.providerAgent.toBuffer()]);
  const [bidderMarket] = pda([enc("bidder_market"), w.providerAgent.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .createBid(new BN(reward), 3600, 5000, arr(Buffer.alloc(32, 4)), arr(Buffer.alloc(32, 5)), new BN(now + bidExpiresIn))
    .accounts({ protocolConfig: w.protocolPda, bidMarketplace: bidMarket, task, bidBook, bid, bidderMarketState: bidderMarket, bidder: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "bid:create_bid");

  return { task, escrow, jobSpec, bidBook, bid, bidMarket, bidderMarket };
}

function deregisterIx(w, kp, agentPda, withRemaining = true) {
  let m = makeProgram(kp).methods
    .deregisterAgent()
    .accounts({
      agent: agentPda, protocolConfig: w.protocolPda,
      reputationStake: pda([enc("reputation_stake"), agentPda.toBuffer()])[0],
      authority: kp.publicKey,
    });
  if (withRemaining) m = m.remainingAccounts(deregisterRemaining(agentPda));
  return m.instruction();
}

test("deregister_agent: a live bid blocks deregistration (AgentHasActiveBids); omission fails closed", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const b = await setupBidTask(w);
  assert.equal(decode(w.svm, "BidderMarketState", b.bidderMarket).active_bid_count, 1, "one live bid");

  // Omitting the required remaining accounts fails closed.
  expectFail(
    send(w.svm, await deregisterIx(w, w.provider, w.providerAgent, false), [w.provider]),
    "InvalidInput",
    "deregister without the bidder-market account",
  );

  // The guard itself: a live bid blocks deregistration (pre-fix: succeeded and
  // bricked the bidder's own bond — every withdrawal path loads this agent).
  expectFail(
    send(w.svm, await deregisterIx(w, w.provider, w.providerAgent), [w.provider]),
    "AgentHasActiveBids",
    "deregister with a live bid",
  );
  assert.ok(!isClosed(w.svm, w.providerAgent), "agent still registered");

  // Withdraw the bid; deregistration now succeeds.
  expectOk(send(w.svm, await w.providerProg.methods
    .cancelBid()
    .accounts({ task: b.task, bidBook: b.bidBook, bid: b.bid, bidderMarketState: b.bidderMarket, bidder: w.providerAgent, authority: w.provider.publicKey })
    .instruction(), [w.provider]), "bidder withdraws");
  assert.equal(decode(w.svm, "BidderMarketState", b.bidderMarket).active_bid_count, 0, "no live bids");

  w.svm.expireBlockhash(); // same ix shape as the blocked attempt above
  expectOk(send(w.svm, await deregisterIx(w, w.provider, w.providerAgent), [w.provider]), "deregister after withdrawal");
  assert.ok(isClosed(w.svm, w.providerAgent), "agent deregistered");
});

// ---------------------------------------------------------------------------
// 3) deregister_agent: the verification badge is swept with the registration
// ---------------------------------------------------------------------------

test("deregister_agent: a live verification badge is closed with the registration (no badge inheritance)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const a = await registerAgent(w);

  // The global moderation authority records a domain verification for the agent.
  const [verification] = pda([enc("agent_verification"), a.agentPda.toBuffer()]);
  expectOk(send(w.svm, await makeProgram(w.modAuth).methods
    .recordAgentVerification("agent.example.com", 0, new BN(0))
    .accounts({ moderationConfig: w.modCfg, agent: a.agentPda, agentVerification: verification, attestor: w.modAuth.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "record verification");
  assert.ok(!isClosed(w.svm, verification), "badge live before deregistration");

  const badgeRent = balance(w, verification);
  const agentRent = balance(w, a.agentPda);
  const authBefore = balance(w, a.kp.publicKey);

  expectOk(send(w.svm, await deregisterIx(w, a.kp, a.agentPda), [a.kp]), "deregister with a live badge");
  assert.ok(isClosed(w.svm, a.agentPda), "agent closed");
  assert.ok(isClosed(w.svm, verification), "badge swept with the registration (pre-fix: survived)");

  // Both accounts' rent (minus the tx fee) returned to the deregistering authority.
  const gained = balance(w, a.kp.publicKey) - authBefore;
  assert.ok(
    gained >= agentRent + badgeRent - 20_000n,
    `authority reclaimed agent + badge rent (gained ${gained}, expected ~${agentRent + badgeRent})`,
  );

  // Re-registering the same agent_id does NOT revive a badge.
  w.svm.expireBlockhash();
  expectOk(send(w.svm, await a.prog.methods
    .registerAgent(arr(a.agentId), new BN(1), "http://c8.test", null, new BN(0))
    .accounts({ agent: a.agentPda, protocolConfig: w.protocolPda, authority: a.kp.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [a.kp]), "re-register same agent_id");
  assert.ok(isClosed(w.svm, verification), "no badge attaches to the new registration");
});
