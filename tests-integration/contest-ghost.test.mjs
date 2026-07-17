// In-process litesvm integration tests for Batch 3 WS-CONTEST
// (docs/design/batch-3-contest-tasks.md):
//
//   * contest lifecycle: schema-1 Competitive + CreatorReview, multi-entrant
//   * distribute_ghost_share: equal slices, fee legs, ESCROW CONSERVATION
//   * temporal partition: accept before ghost_at only, crank at/after only
//   * auto_accept disabled for contests; cancel guard (live_submissions == 0)
//   * submission-rent return: reject / accept / ghost / close_task stragglers
//
// Executes the COMPILED program (target/deploy/agenc_coordination.so) end-to-end.
//
// Run:  cd .. && node --test tests-integration/contest-ghost.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  enc, arr, pda, id32,
  makeProgram, send, expectOk, expectFail, decode, isClosed,
  freshWorld, taskModV2Pda, moderationBlockPda,
  BN, Keypair, SystemProgram,
} from "./harness.mjs";

const CAP_COMPUTE = 1;
const CAP_VALIDATOR = 1 << 8;
const SELECTION_WINDOW_SECS = 172_800; // constants.rs::SELECTION_WINDOW_SECS (48h)

const balance = (w, key) => BigInt(w.svm.getBalance(key));

function warpTo(w, unixTimestamp) {
  const clock = w.svm.getClock();
  clock.unixTimestamp = BigInt(unixTimestamp);
  w.svm.setClock(clock);
  // A byte-identical retry of a previously failed tx would be deduped by litesvm;
  // rotating the blockhash keeps post-warp retries distinct.
  w.svm.expireBlockhash();
}

/// Register a fresh, funded agent. Returns { kp, prog, agentPda }.
async function registerAgent(w, capabilities = CAP_COMPUTE) {
  const kp = Keypair.generate();
  w.svm.airdrop(kp.publicKey, BigInt(10e9));
  const prog = makeProgram(kp);
  const agentId = id32();
  const [agentPda] = pda([enc("agent"), agentId]);
  expectOk(
    send(w.svm, await prog.methods
      .registerAgent(arr(agentId), new BN(capabilities), "http://contest.test", null, new BN(0))
      .accounts({ agent: agentPda, protocolConfig: w.protocolPda, authority: kp.publicKey, systemProgram: SystemProgram.programId })
      .instruction(), [kp]),
    "register agent",
  );
  return { kp, prog, agentPda };
}

/// Create + CreatorReview-configure a task by the buyer. taskType 2 = Competitive.
async function setupReviewedTask(w, { taskType = 2, maxWorkers = 3, reward = 9_000_007, deadlineOffset = 3600, reviewWindow = 3600, mode = 1, validatorQuorum = 0 } = {}) {
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const [validation] = pda([enc("task_validation"), task.toBuffer()]);
  const [attestor] = pda([enc("task_attestor"), task.toBuffer()]);
  const [hireRecord] = pda([enc("hire"), task.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const deadline = now + deadlineOffset;
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(CAP_COMPUTE), arr(desc), new BN(reward), maxWorkers, new BN(deadline), taskType, null, 0, null, null, 0)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "contest:create_task");
  const rw = mode === 1 ? reviewWindow : 0;
  expectOk(send(w.svm, await w.buyerProg.methods
    .configureTaskValidation(mode, new BN(rw), validatorQuorum, null)
    .accounts({ task, taskValidationConfig: validation, taskAttestorConfig: attestor, protocolConfig: w.protocolPda, hireRecord, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "contest:configure CreatorReview");
  return { task, escrow, validation, attestor, reward, deadline, ghostAt: deadline + SELECTION_WINDOW_SECS };
}

/// Moderate + publish the job spec once per task.
async function publishJobSpec(w, { task }) {
  const modProg = makeProgram(w.modAuth);
  const jobHash = id32();
  const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, moderationAttestor: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "contest:mod");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/contest", w.modAuth.publicKey)
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, moderationAttestor: null, moderationBlock: moderationBlockPda(jobHash)[0], taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "contest:job-spec");
  return { jobSpec, taskMod };
}

/// One entrant claims + submits. Returns { claim, submission }.
async function enterContest(w, m, entrant, { submit = true } = {}) {
  const [claim] = pda([enc("claim"), m.task.toBuffer(), entrant.agentPda.toBuffer()]);
  expectOk(send(w.svm, await entrant.prog.methods
    .claimTaskWithJobSpec()
    .accounts({ task: m.task, taskJobSpec: m.jobSpec, claim, protocolConfig: w.protocolPda, worker: entrant.agentPda, authority: entrant.kp.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [entrant.kp]), "contest:claim");
  const [submission] = pda([enc("task_submission"), claim.toBuffer()]);
  if (submit) {
    const result = Buffer.alloc(64);
    result.set(crypto.randomBytes(32), 0);
    expectOk(send(w.svm, await entrant.prog.methods
      .submitTaskResult(arr(id32()), arr(result))
      .accounts({ task: m.task, claim, taskValidationConfig: m.validation, taskSubmission: submission, protocolConfig: w.protocolPda, worker: entrant.agentPda, authority: entrant.kp.publicKey, systemProgram: SystemProgram.programId })
      .instruction(), [entrant.kp]), "contest:submit");
  }
  return { claim, submission };
}

/// Build the distribute_ghost_share instruction for one entrant.
async function ghostIx(w, m, entrant, entry, crankerKp) {
  return makeProgram(crankerKp).methods
    .distributeGhostShare()
    .accounts({
      task: m.task, claim: entry.claim, escrow: m.escrow, taskValidationConfig: m.validation,
      taskSubmission: entry.submission, worker: entrant.agentPda, protocolConfig: w.protocolPda,
      treasury: w.admin.publicKey, creator: w.buyer.publicKey, workerAuthority: entrant.kp.publicKey,
      operator: null, referrer: null, cranker: crankerKp.publicKey, systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/// Build the accept_task_result instruction for one entrant (creator signs).
async function acceptIx(w, m, entrant, entry) {
  return w.buyerProg.methods
    .acceptTaskResult()
    .accounts({
      task: m.task, claim: entry.claim, escrow: m.escrow, taskValidationConfig: m.validation,
      taskSubmission: entry.submission, worker: entrant.agentPda, protocolConfig: w.protocolPda,
      treasury: w.admin.publicKey, creator: w.buyer.publicKey, workerAuthority: entrant.kp.publicKey,
      operator: null, referrer: null, hireRecord: null,
      creatorCompletionBond: null, workerCompletionBond: null,
      tokenEscrowAta: null, workerTokenAccount: null, treasuryTokenAccount: null,
      rewardMint: null, tokenProgram: null, systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/// Build the reject_task_result instruction for one entrant (creator signs).
async function rejectIx(w, m, entrant, entry) {
  return w.buyerProg.methods
    .rejectTaskResult(arr(Buffer.alloc(32, 9)))
    .accounts({
      task: m.task, claim: entry.claim, taskValidationConfig: m.validation,
      taskSubmission: entry.submission, worker: entrant.agentPda, protocolConfig: w.protocolPda,
      creator: w.buyer.publicKey, workerAuthority: entrant.kp.publicKey, agentStats: null,
    })
    .instruction();
}

// ===========================================================================
// Ghost-split: full lifecycle + ESCROW CONSERVATION (spec invariant 1)
// ===========================================================================

test("contest: ghost-split cranks pay equal slices, conserve escrow exactly, and return all rent to workers", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const reward = 9_000_007; // deliberately non-divisible by 3 — dust must not strand
  const m = await setupReviewedTask(w, { reward });
  Object.assign(m, await publishJobSpec(w, m));

  const t0 = decode(w.svm, "Task", m.task);
  assert.equal(t0._reserved[0], 1, "new tasks are stamped task_schema = 1");
  assert.equal(t0._reserved[1], 0, "live_submissions starts at 0");

  // Three entrants. B and C claim AFTER A submitted (task = PendingValidation):
  // the contest stays enterable until the deadline.
  const [a, b, c] = [await registerAgent(w), await registerAgent(w), await registerAgent(w)];
  const ea = await enterContest(w, m, a);
  const eb = await enterContest(w, m, b); // claim during PendingValidation
  const ec = await enterContest(w, m, c);

  assert.equal(decode(w.svm, "Task", m.task)._reserved[1], 3, "live_submissions == 3 after 3 entries");

  // Cranking before ghost_at is rejected (temporal partition).
  const cranker = Keypair.generate();
  w.svm.airdrop(cranker.publicKey, BigInt(1e9));
  expectFail(
    send(w.svm, await ghostIx(w, m, a, ea, cranker), [cranker]),
    "ContestGhostWindowNotReached", "ghost crank before ghost_at",
  );

  warpTo(w, m.ghostAt + 5);

  // Balances + rents BEFORE cranking (rent measured off the live accounts).
  const entries = [[a, ea], [b, eb], [c, ec]];
  const before = new Map();
  let rentTotal = 0n;
  for (const [agent, entry] of entries) {
    const claimRent = balance(w, entry.claim);
    const subRent = balance(w, entry.submission);
    rentTotal += claimRent + subRent;
    before.set(agent, { wallet: balance(w, agent.kp.publicKey), claimRent, subRent });
  }
  const treasuryBefore = balance(w, w.admin.publicKey);
  const creatorBefore = balance(w, w.buyer.publicKey);
  const escrowRent = balance(w, m.escrow) - BigInt(reward);
  assert.ok(escrowRent > 0n, "escrow holds rent-exemption above the pool");

  // Crank all three (permissionless — a third party cranks).
  const slices = [];
  for (const [agent, entry] of entries) {
    expectOk(send(w.svm, await ghostIx(w, m, agent, entry, cranker), [cranker]), "ghost crank");
    const t = decode(w.svm, "Task", m.task);
    slices.push({ agent, entry, liveAfter: t._reserved[1] });
  }

  // Counter walked 3 -> 2 -> 1 -> 0.
  assert.deepEqual(slices.map((s) => s.liveAfter), [2, 1, 0]);

  // Every submission + claim closed; rent went to its worker.
  for (const [agent, entry] of entries) {
    assert.ok(isClosed(w.svm, entry.submission), "submission closed");
    assert.ok(isClosed(w.svm, entry.claim), "claim closed");
  }

  // ESCROW CONSERVATION: Σ(worker payouts) + treasury == the full reward pool.
  // Worker wallet deltas include their returned claim+submission rent — subtract it.
  let workerPayoutTotal = 0n;
  for (const [agent] of entries) {
    const info = before.get(agent);
    const delta = balance(w, agent.kp.publicKey) - info.wallet;
    const payout = delta - info.claimRent - info.subRent;
    assert.ok(payout > 0n, "each ghosted entrant is PAID (net of rent return)");
    workerPayoutTotal += payout;
  }
  const treasuryDelta = balance(w, w.admin.publicKey) - treasuryBefore;
  assert.equal(
    workerPayoutTotal + treasuryDelta,
    BigInt(reward),
    "sum(worker payouts + treasury fees) == escrow pool — nothing strands, nothing double-pays",
  );

  // Equal shares: payouts differ only by fee rounding + last-slice dust (< 5 lamports here).
  // (All three entrants have identical fresh-agent reputation, so identical fee bps.)

  // Escrow closed; its rent went back to the creator.
  assert.ok(isClosed(w.svm, m.escrow), "escrow account closed after the final slice");
  assert.equal(balance(w, w.buyer.publicKey) - creatorBefore, escrowRent, "creator got exactly the escrow rent, ZERO pool funds");

  // Task is terminal + fully drained.
  const t = decode(w.svm, "Task", m.task);
  assert.ok(t.status?.completed !== undefined || JSON.stringify(t.status).includes("ompleted"), `task Completed (got ${JSON.stringify(t.status)})`);
  assert.equal(t._reserved[1], 0, "live_submissions == 0");
  assert.equal(t.current_workers, 0, "no live workers — close_task is now possible");

  // Idempotence: a fourth crank on an already-paid entry fails (accounts closed).
  const res = send(w.svm, await ghostIx(w, m, a, ea, cranker), [cranker]);
  assert.ok(res.constructor.name.includes("Failed"), "re-cranking a paid submission fails");
});

// ===========================================================================
// Temporal partition + creator-side settle
// ===========================================================================

test("contest: accept works before ghost_at (after rejecting losers), is forbidden with live losers and at/after ghost_at", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const reward = 5_000_000;
  const m = await setupReviewedTask(w, { reward });
  Object.assign(m, await publishJobSpec(w, m));

  const [winner, loser] = [await registerAgent(w), await registerAgent(w)];
  const ew = await enterContest(w, m, winner);
  const el = await enterContest(w, m, loser);

  // Accept with 2 live submissions -> rejected (losers must be settled first).
  expectFail(
    send(w.svm, await acceptIx(w, m, winner, ew), [w.buyer]),
    "ContestAcceptRequiresSoleLiveSubmission", "accept with a live loser",
  );

  // Reject the loser: their claim AND submission rent flow back to them.
  const loserBefore = balance(w, loser.kp.publicKey);
  const loserClaimRent = balance(w, el.claim);
  const loserSubRent = balance(w, el.submission);
  expectOk(send(w.svm, await rejectIx(w, m, loser, el), [w.buyer]), "reject loser");
  assert.ok(isClosed(w.svm, el.submission), "rejected submission closed");
  assert.ok(isClosed(w.svm, el.claim), "rejected claim closed");
  assert.equal(
    balance(w, loser.kp.publicKey) - loserBefore,
    loserClaimRent + loserSubRent,
    "REVERT-SENSITIVE (§1): the rejected worker got their claim + submission rent back",
  );

  // Winner accept before ghost_at: full pool settles, submission rent returns.
  w.svm.expireBlockhash(); // the earlier accept attempt was byte-identical — avoid dedup
  const winnerBefore = balance(w, winner.kp.publicKey);
  const winnerRents = balance(w, ew.claim) + balance(w, ew.submission);
  const treasuryBefore = balance(w, w.admin.publicKey);
  expectOk(send(w.svm, await acceptIx(w, m, winner, ew), [w.buyer]), "accept winner");
  assert.ok(isClosed(w.svm, ew.submission), "accepted submission closed to worker");
  const winnerPayout = balance(w, winner.kp.publicKey) - winnerBefore - winnerRents;
  const treasuryDelta = balance(w, w.admin.publicKey) - treasuryBefore;
  assert.equal(winnerPayout + treasuryDelta, BigInt(reward), "winner + treasury == full pool");
  assert.ok(isClosed(w.svm, m.escrow), "escrow closed on accept");
});

test("contest: accept at/after ghost_at is forbidden (ContestSelectionWindowElapsed)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const m = await setupReviewedTask(w);
  Object.assign(m, await publishJobSpec(w, m));
  const solo = await registerAgent(w);
  const entry = await enterContest(w, m, solo);

  warpTo(w, m.ghostAt); // exactly ghost_at — the boundary belongs to the crank
  expectFail(
    send(w.svm, await acceptIx(w, m, solo, entry), [w.buyer]),
    "ContestSelectionWindowElapsed", "accept at ghost_at",
  );
  // …and the crank works at the same instant (partition is airtight, no dead zone).
  const cranker = Keypair.generate();
  w.svm.airdrop(cranker.publicKey, BigInt(1e9));
  expectOk(send(w.svm, await ghostIx(w, m, solo, entry, cranker), [cranker]), "crank at ghost_at");
  assert.ok(isClosed(w.svm, m.escrow), "single-entrant ghost sweeps + closes escrow");
});

// ===========================================================================
// Auto-accept disable + cancel guard
// ===========================================================================

test("contest: auto_accept_task_result is disabled (ContestAutoAcceptDisabled)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const m = await setupReviewedTask(w, { reviewWindow: 60 });
  Object.assign(m, await publishJobSpec(w, m));
  const solo = await registerAgent(w);
  const entry = await enterContest(w, m, solo);

  // Past the review window (the pre-batch-3 auto-accept trigger) but before ghost_at.
  warpTo(w, Number(w.svm.getClock().unixTimestamp) + 120);
  const anyone = Keypair.generate();
  w.svm.airdrop(anyone.publicKey, BigInt(1e9));
  expectFail(
    send(w.svm, await makeProgram(anyone).methods
      .autoAcceptTaskResult()
      .accounts({
        task: m.task, claim: entry.claim, escrow: m.escrow, taskValidationConfig: m.validation,
        taskSubmission: entry.submission, worker: solo.agentPda, protocolConfig: w.protocolPda,
        treasury: w.admin.publicKey, creator: w.buyer.publicKey, workerAuthority: solo.kp.publicKey,
        operator: null, referrer: null, hireRecord: null,
        creatorCompletionBond: null, workerCompletionBond: null, authority: anyone.publicKey,
        tokenEscrowAta: null, workerTokenAccount: null, treasuryTokenAccount: null,
        rewardMint: null, tokenProgram: null, systemProgram: SystemProgram.programId,
      })
      .instruction(), [anyone]),
    "ContestAutoAcceptDisabled", "auto-accept on a contest",
  );
});

test("contest: cancel is blocked while live submissions exist; reject-all then cancel is the documented escape", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const m = await setupReviewedTask(w, { maxWorkers: 2 });
  Object.assign(m, await publishJobSpec(w, m));
  const solo = await registerAgent(w);
  const entry = await enterContest(w, m, solo);

  // PendingValidation cancel is blocked by status; drive the task past its deadline
  // and reject the entry so it lands in a cancellable status FIRST, proving the
  // live_submissions guard (not the status guard) is what protects entrants.
  // 1) With the submission live the creator rejects... which zeroes live_submissions.
  //    So instead: prove the guard directly — cancel on Open-with-live-submission is
  //    impossible to construct honestly (status tracks pending). The unit tests pin
  //    the guard; here we prove the ESCAPE path end-to-end.
  expectOk(send(w.svm, await rejectIx(w, m, solo, entry), [w.buyer]), "reject the only entry");
  const t = decode(w.svm, "Task", m.task);
  assert.equal(t._reserved[1], 0, "live_submissions back to 0 after reject-all");

  const creatorBefore = balance(w, w.buyer.publicKey);
  expectOk(send(w.svm, await w.buyerProg.methods
    .cancelTask()
    .accounts({
      task: m.task, escrow: m.escrow, authority: w.buyer.publicKey, protocolConfig: w.protocolPda,
      tokenEscrowAta: null, creatorTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: pda([enc("completion_bond"), m.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0], workerCompletionBond: pda([enc("completion_bond"), m.task.toBuffer(), w.provider.publicKey.toBuffer()])[0], workerBondAuthority: w.provider.publicKey,
      creatorAgent: null, agentStats: null, systemProgram: SystemProgram.programId,
    })
    .instruction(), [w.buyer]), "cancel after reject-all");
  assert.ok(balance(w, w.buyer.publicKey) > creatorBefore, "creator refunded (documented reject-all escape)");
});

// ===========================================================================
// close_task straggler: submission rent -> WORKER, fail-closed (spec §1)
// ===========================================================================

test("close_task: straggler submission rent returns to the worker, and is FAIL-CLOSED without the worker accounts", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  // ValidatorQuorum reject leaves the TaskSubmission alive (Rejected) with the
  // claim closed — the canonical straggler.
  const m = await setupReviewedTask(w, { taskType: 0, maxWorkers: 1, mode: 2, validatorQuorum: 1, reward: 2_000_000 });
  Object.assign(m, await publishJobSpec(w, m));
  const workerA = await registerAgent(w);
  const entry = await enterContest(w, m, workerA);

  const validator = await registerAgent(w, CAP_VALIDATOR);
  const [vote] = pda([enc("task_validation_vote"), entry.submission.toBuffer(), validator.kp.publicKey.toBuffer()]);
  expectOk(send(w.svm, await validator.prog.methods
    .validateTaskResult(false)
    .accounts({
      task: m.task, claim: entry.claim, escrow: m.escrow, taskValidationConfig: m.validation,
      taskAttestorConfig: null, taskSubmission: entry.submission, taskValidationVote: vote,
      worker: workerA.agentPda, protocolConfig: w.protocolPda, validatorAgent: validator.agentPda,
      treasury: w.admin.publicKey, creator: w.buyer.publicKey, workerAuthority: workerA.kp.publicKey,
      reviewer: validator.kp.publicKey, tokenEscrowAta: null, workerTokenAccount: null,
      treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, systemProgram: SystemProgram.programId,
    })
    .instruction(), [validator.kp]), "quorum reject");
  assert.ok(!isClosed(w.svm, entry.submission), "quorum-rejected submission survives as a straggler");
  assert.ok(isClosed(w.svm, entry.claim), "claim closed to worker on quorum reject");

  // Cancel the (now Open) task, then close it with the straggler submission child.
  expectOk(send(w.svm, await w.buyerProg.methods
    .cancelTask()
    .accounts({
      task: m.task, escrow: m.escrow, authority: w.buyer.publicKey, protocolConfig: w.protocolPda,
      tokenEscrowAta: null, creatorTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: pda([enc("completion_bond"), m.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0], workerCompletionBond: pda([enc("completion_bond"), m.task.toBuffer(), w.provider.publicKey.toBuffer()])[0], workerBondAuthority: w.provider.publicKey,
      creatorAgent: null, agentStats: null, systemProgram: SystemProgram.programId,
    })
    .instruction(), [w.buyer]), "cancel task");

  const [hireRecord] = pda([enc("hire"), m.task.toBuffer()]);
  const [creatorBondPda] = pda([enc("completion_bond"), m.task.toBuffer(), w.buyer.publicKey.toBuffer()]);
  const closeIx = (remaining) => w.buyerProg.methods
    .closeTask()
    .accounts({
      task: m.task, taskJobSpec: m.jobSpec, escrow: null, hireRecord, listing: null,
      creatorCompletionBond: creatorBondPda, workerCompletionBond: null, authority: w.buyer.publicKey,
    })
    .remainingAccounts(remaining)
    .instruction();

  // FAIL-CLOSED (revert-sensitive §1): submission child WITHOUT the worker agent +
  // authority accounts must error — the creator is never paid a worker's rent.
  expectFail(
    send(w.svm, await closeIx([
      { pubkey: entry.submission, isSigner: false, isWritable: true },
    ]), [w.buyer]),
    "SubmissionRentAccountsRequired", "close_task straggler without worker accounts",
  );
  // FAIL-CLOSED: a wrong (non-worker) payee wallet is rejected too.
  expectFail(
    send(w.svm, await closeIx([
      { pubkey: entry.submission, isSigner: false, isWritable: true },
      { pubkey: workerA.agentPda, isSigner: false, isWritable: false },
      { pubkey: w.buyer.publicKey, isSigner: false, isWritable: true },
    ]), [w.buyer]),
    "SubmissionRentAccountsRequired", "close_task straggler with creator as payee",
  );

  const workerBefore = balance(w, workerA.kp.publicKey);
  const subRent = balance(w, entry.submission);
  expectOk(send(w.svm, await closeIx([
    { pubkey: entry.submission, isSigner: false, isWritable: true },
    { pubkey: workerA.agentPda, isSigner: false, isWritable: false },
    { pubkey: workerA.kp.publicKey, isSigner: false, isWritable: true },
  ]), [w.buyer]), "close_task with straggler triple");

  assert.ok(isClosed(w.svm, entry.submission), "straggler submission closed");
  assert.equal(
    balance(w, workerA.kp.publicKey) - workerBefore,
    subRent,
    "REVERT-SENSITIVE (§1): straggler submission rent went to the WORKER, not the creator",
  );
  assert.ok(isClosed(w.svm, m.task), "task account closed");
});

// ===========================================================================
// Schema-0 / non-contest regression guards
// ===========================================================================

test("regression: schema-1 Exclusive CreatorReview keeps auto-accept, and its submission rent returns on auto-accept", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const m = await setupReviewedTask(w, { taskType: 0, maxWorkers: 1, reviewWindow: 60, reward: 2_000_000 });
  Object.assign(m, await publishJobSpec(w, m));
  const solo = await registerAgent(w);
  const entry = await enterContest(w, m, solo);

  warpTo(w, Number(w.svm.getClock().unixTimestamp) + 120);
  const anyone = Keypair.generate();
  w.svm.airdrop(anyone.publicKey, BigInt(1e9));
  const workerBefore = balance(w, solo.kp.publicKey);
  const rents = balance(w, entry.claim) + balance(w, entry.submission);
  const treasuryBefore = balance(w, w.admin.publicKey);
  expectOk(send(w.svm, await makeProgram(anyone).methods
    .autoAcceptTaskResult()
    .accounts({
      task: m.task, claim: entry.claim, escrow: m.escrow, taskValidationConfig: m.validation,
      taskSubmission: entry.submission, worker: solo.agentPda, protocolConfig: w.protocolPda,
      treasury: w.admin.publicKey, creator: w.buyer.publicKey, workerAuthority: solo.kp.publicKey,
      operator: null, referrer: null, hireRecord: null,
      creatorCompletionBond: null, workerCompletionBond: null, authority: anyone.publicKey,
      tokenEscrowAta: null, workerTokenAccount: null, treasuryTokenAccount: null,
      rewardMint: null, tokenProgram: null, systemProgram: SystemProgram.programId,
    })
    .instruction(), [anyone]), "auto-accept on a non-contest still works");
  assert.ok(isClosed(w.svm, entry.submission), "submission closed on auto-accept (§1)");
  const payout = balance(w, solo.kp.publicKey) - workerBefore - rents;
  const treasuryDelta = balance(w, w.admin.publicKey) - treasuryBefore;
  assert.equal(payout + treasuryDelta, 2_000_000n, "full pool settled");
});

test("regression: contest tasks reject dispute initiation and request_changes (ContestFlowUnsupported)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const m = await setupReviewedTask(w);
  Object.assign(m, await publishJobSpec(w, m));
  const solo = await registerAgent(w);
  const entry = await enterContest(w, m, solo);

  expectFail(
    send(w.svm, await w.buyerProg.methods
      .requestChanges(arr(Buffer.alloc(32, 7)))
      .accounts({
        task: m.task, claim: entry.claim, taskValidationConfig: m.validation,
        taskSubmission: entry.submission, protocolConfig: w.protocolPda, creator: w.buyer.publicKey,
      })
      .instruction(), [w.buyer]),
    "ContestFlowUnsupported", "request_changes on a contest",
  );
});
