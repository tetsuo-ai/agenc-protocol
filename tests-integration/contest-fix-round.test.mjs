// In-process litesvm integration tests for the batch-3 ADVERSARIAL-REVIEW FIX
// ROUND (PR #129). One test block per finding:
//
//   FIX 1  — no-show claim strand: PendingValidation expiry with an unfakeable
//            absence proof + the new `reclaim_terminal_claim` un-bricker
//   FIX 2  — temporal partition symmetric: reject forbidden at/after ghost_at
//   FIX 3  — contest gates narrowed to contest-CONFIGURED tasks (auto-mode
//            Competitive keeps dispute recourse)
//   FIX 4  — refundable contest entry deposit as claim-PDA surplus; forfeited
//            to the TREASURY on no-show expiry and empty/Rejected terminal
//            cleanup; normal settlement refunds it
//   FIX 5  — close_task straggler with a deregistered agent -> treasury
//   FIX 6  — TaskCompleted emitted only on the FINAL ghost slice
//
// Executes the COMPILED program (target/deploy/agenc_coordination.so) end-to-end.
//
// Run:  cd .. && node --test tests-integration/contest-fix-round.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  enc,
  arr,
  pda,
  id32,
  coder,
  makeProgram,
  send,
  expectOk,
  expectFail,
  decode,
  isClosed,
  freshWorld,
  injectAgentStake,
  taskModV2Pda,
  moderationBlockPda,
  deregisterRemaining,
  BN,
  Keypair,
  SystemProgram,
} from "./harness.mjs";

const CAP_COMPUTE = 1;
const CAP_VALIDATOR = 1 << 8;
const SELECTION_WINDOW_SECS = 172_800; // constants.rs::SELECTION_WINDOW_SECS (48h)
const CONTEST_ENTRY_DEPOSIT = 10_000_000n; // constants.rs::CONTEST_ENTRY_DEPOSIT_LAMPORTS

const balance = (w, key) => BigInt(w.svm.getBalance(key));

function warpTo(w, unixTimestamp) {
  const clock = w.svm.getClock();
  clock.unixTimestamp = BigInt(unixTimestamp);
  w.svm.setClock(clock);
  w.svm.expireBlockhash();
}

/// Decode anchor event names out of a transaction result's logs.
function eventNames(res) {
  const logs = typeof res.logs === "function" ? res.logs() : res.meta().logs();
  return logs
    .filter((l) => l.startsWith("Program data: "))
    .map((l) => {
      try {
        return coder.events.decode(l.slice("Program data: ".length));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .map((e) => e.name.toLowerCase());
}

async function registerAgent(w, capabilities = CAP_COMPUTE) {
  const kp = Keypair.generate();
  w.svm.airdrop(kp.publicKey, BigInt(10e9));
  const prog = makeProgram(kp);
  const agentId = id32();
  const [agentPda] = pda([enc("agent"), agentId]);
  expectOk(
    send(
      w.svm,
      await prog.methods
        .registerAgent(
          arr(agentId),
          new BN(capabilities),
          "http://fixround.test",
          null,
          new BN(0),
        )
        .accounts({
          agent: agentPda,
          protocolConfig: w.protocolPda,
          authority: kp.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [kp],
    ),
    "register agent",
  );
  return { kp, prog, agentPda };
}

/// Create a task; configure CreatorReview/quorum unless mode === null (auto).
async function setupTask(
  w,
  {
    taskType = 2,
    maxWorkers = 3,
    reward = 9_000_007,
    deadlineOffset = 3600,
    reviewWindow = 3600,
    mode = 1,
    validatorQuorum = 0,
  } = {},
) {
  const taskId = id32();
  const [task] = pda([
    enc("task"),
    w.buyer.publicKey.toBuffer(),
    Buffer.from(taskId),
  ]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([
    enc("authority_rate_limit"),
    w.buyer.publicKey.toBuffer(),
  ]);
  const [validation] = pda([enc("task_validation"), task.toBuffer()]);
  const [attestor] = pda([enc("task_attestor"), task.toBuffer()]);
  const [hireRecord] = pda([enc("hire"), task.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const deadline = now + deadlineOffset;
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  expectOk(
    send(
      w.svm,
      await w.buyerProg.methods
        .createTask(
          arr(taskId),
          new BN(CAP_COMPUTE),
          arr(desc),
          new BN(reward),
          maxWorkers,
          new BN(deadline),
          taskType,
          null,
          0,
          null,
          null,
          0,
        )
        .accounts({
          task,
          escrow,
          protocolConfig: w.protocolPda,
          creatorAgent: w.buyerAgent,
          authorityRateLimit: rateLimit,
          authority: w.buyer.publicKey,
          creator: w.buyer.publicKey,
          systemProgram: SystemProgram.programId,
          rewardMint: null,
          creatorTokenAccount: null,
          tokenEscrowAta: null,
          tokenProgram: null,
          associatedTokenProgram: null,
        })
        .instruction(),
      [w.buyer],
    ),
    "fixround:create_task",
  );
  if (mode !== null) {
    // New quorum entry is disabled. Configure the supported CreatorReview mode,
    // then inject mode 2 only when testing the grandfathered quorum exit.
    expectOk(
      send(
        w.svm,
        await w.buyerProg.methods
          .configureTaskValidation(1, new BN(reviewWindow), 0, null)
          .accounts({
            task,
            taskValidationConfig: validation,
            taskAttestorConfig: attestor,
            protocolConfig: w.protocolPda,
            hireRecord,
            creator: w.buyer.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
        [w.buyer],
      ),
      "fixround:configure validation",
    );
    if (mode === 2) {
      const account = w.svm.getAccount(validation);
      const config = coder.accounts.decode(
        "TaskValidationConfig",
        Buffer.from(account.data),
      );
      config.mode = { ValidatorQuorum: {} };
      config.review_window_secs = new BN(0);
      config._reserved[0] = validatorQuorum;
      const data = await coder.accounts.encode("TaskValidationConfig", config);
      w.svm.setAccount(validation, { ...account, data });
    }
  }
  return {
    task,
    escrow,
    validation,
    attestor,
    hireRecord,
    reward,
    deadline,
    ghostAt: deadline + SELECTION_WINDOW_SECS,
  };
}

async function publishJobSpec(w, { task }) {
  const modProg = makeProgram(w.modAuth);
  const jobHash = id32();
  const [taskMod] = taskModV2Pda(task, jobHash, w.modAuth.publicKey);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  expectOk(
    send(
      w.svm,
      await modProg.methods
        .recordTaskModeration(
          arr(jobHash),
          0,
          0,
          new BN(0),
          arr(Buffer.alloc(32, 1)),
          arr(Buffer.alloc(32, 2)),
          new BN(0),
        )
        .accounts({
          moderationConfig: w.modCfg,
          task,
          taskModeration: taskMod,
          moderator: w.modAuth.publicKey,
          moderationAttestor: null,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [w.modAuth],
    ),
    "fixround:mod",
  );
  expectOk(
    send(
      w.svm,
      await w.buyerProg.methods
        .setTaskJobSpec(
          arr(jobHash),
          "agenc://job-spec/sha256/fixround",
          w.modAuth.publicKey,
        )
        .accounts({
          protocolConfig: w.protocolPda,
          task,
          moderationConfig: w.modCfg,
          taskModeration: taskMod,
          moderationAttestor: null,
          moderationBlock: moderationBlockPda(jobHash)[0],
          taskJobSpec: jobSpec,
          creator: w.buyer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [w.buyer],
    ),
    "fixround:job-spec",
  );
  return { jobSpec, jobHash, taskMod };
}

async function enterContest(w, m, entrant, { submit = true } = {}) {
  const [claim] = pda([
    enc("claim"),
    m.task.toBuffer(),
    entrant.agentPda.toBuffer(),
  ]);
  expectOk(
    send(
      w.svm,
      await entrant.prog.methods
        .claimTaskWithJobSpec()
        .accounts({
          task: m.task,
          taskJobSpec: m.jobSpec,
          hireRecord: pda([enc("hire"), m.task.toBuffer()])[0],
          legacyListing: null,
          moderationBlock: moderationBlockPda(m.jobHash)[0],
          claim,
          protocolConfig: w.protocolPda,
          worker: entrant.agentPda,
          authority: entrant.kp.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [entrant.kp],
    ),
    "fixround:claim",
  );
  const [submission] = pda([enc("task_submission"), claim.toBuffer()]);
  if (submit) {
    const result = Buffer.alloc(64);
    result.set(crypto.randomBytes(32), 0);
    expectOk(
      send(
        w.svm,
        await entrant.prog.methods
          .submitTaskResult(arr(id32()), arr(result))
          .accounts({
            task: m.task,
            claim,
            taskValidationConfig: m.validation,
            taskSubmission: submission,
            protocolConfig: w.protocolPda,
            worker: entrant.agentPda,
            authority: entrant.kp.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
        [entrant.kp],
      ),
      "fixround:submit",
    );
  }
  return { claim, submission };
}

async function ghostIx(w, m, entrant, entry, crankerKp) {
  return makeProgram(crankerKp)
    .methods.distributeGhostShare()
    .accounts({
      task: m.task,
      claim: entry.claim,
      escrow: m.escrow,
      taskValidationConfig: m.validation,
      taskSubmission: entry.submission,
      worker: entrant.agentPda,
      protocolConfig: w.protocolPda,
      treasury: w.admin.publicKey,
      creator: w.buyer.publicKey,
      workerAuthority: entrant.kp.publicKey,
      operator: null,
      referrer: null,
      cranker: crankerKp.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

async function acceptIx(w, m, entrant, entry) {
  return w.buyerProg.methods
    .acceptTaskResult()
    .accounts({
      task: m.task,
      claim: entry.claim,
      escrow: m.escrow,
      taskValidationConfig: m.validation,
      taskSubmission: entry.submission,
      worker: entrant.agentPda,
      protocolConfig: w.protocolPda,
      treasury: w.admin.publicKey,
      creator: w.buyer.publicKey,
      workerAuthority: entrant.kp.publicKey,
      operator: null,
      referrer: null,
      hireRecord: null,
      creatorCompletionBond: null,
      workerCompletionBond: null,
      tokenEscrowAta: null,
      workerTokenAccount: null,
      treasuryTokenAccount: null,
      rewardMint: null,
      tokenProgram: null,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

async function rejectIx(w, m, entrant, entry) {
  return w.buyerProg.methods
    .rejectTaskResult(arr(Buffer.alloc(32, 9)))
    .accounts({
      task: m.task,
      claim: entry.claim,
      taskValidationConfig: m.validation,
      taskSubmission: entry.submission,
      worker: entrant.agentPda,
      protocolConfig: w.protocolPda,
      creator: w.buyer.publicKey,
      workerAuthority: entrant.kp.publicKey,
      agentStats: null,
      workerCompletionBond: pda([
        enc("completion_bond"),
        m.task.toBuffer(),
        entrant.kp.publicKey.toBuffer(),
      ])[0],
    })
    .instruction();
}

async function expireIx(
  w,
  m,
  entrant,
  entry,
  callerKp,
  { withSubmission = true, withTreasury = true, withValidation = true } = {},
) {
  return makeProgram(callerKp)
    .methods.expireClaim()
    .accounts({
      authority: callerKp.publicKey,
      task: m.task,
      escrow: m.escrow,
      claim: entry.claim,
      worker: entrant.agentPda,
      protocolConfig: w.protocolPda,
      taskValidationConfig: withValidation ? m.validation : null,
      taskSubmission: withSubmission ? entry.submission : null,
      rentRecipient: entrant.kp.publicKey,
      workerCompletionBond: null,
      bondCreator: null,
      agentStats: null,
      treasury: withTreasury ? w.admin.publicKey : null,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

async function reclaimIx(w, m, entrant, entry, callerKp) {
  return makeProgram(callerKp)
    .methods.reclaimTerminalClaim()
    .accounts({
      authority: callerKp.publicKey,
      task: m.task,
      claim: entry.claim,
      taskSubmission: entry.submission,
      taskValidationConfig: null,
      worker: entrant.agentPda,
      protocolConfig: w.protocolPda,
      treasury: w.admin.publicKey,
      rentRecipient: entrant.kp.publicKey,
    })
    .instruction();
}

function closeTaskIx(w, m, remaining = [], { protocolConfig = null } = {}) {
  const [creatorBondPda] = pda([
    enc("completion_bond"),
    m.task.toBuffer(),
    w.buyer.publicKey.toBuffer(),
  ]);
  return w.buyerProg.methods
    .closeTask()
    .accounts({
      task: m.task,
      taskJobSpec: m.jobSpec,
      escrow: null,
      hireRecord: m.hireRecord,
      listing: null,
      creatorCompletionBond: creatorBondPda,
      workerCompletionBond: null,
      authority: w.buyer.publicKey,
      protocolConfig,
    })
    .remainingAccounts(remaining)
    .instruction();
}

// ===========================================================================
// FIX 4 — contest entry deposit charged (and only for contests)
// ===========================================================================

test("FIX 4: contest claims carry the 0.01 SOL entry deposit as claim surplus; non-contest claims pay none", async () => {
  const w = await freshWorld({ moderationEnabled: true });

  // Non-contest baseline: Exclusive + CreatorReview claim = pure rent.
  const mEx = await setupTask(w, {
    taskType: 0,
    maxWorkers: 1,
    reward: 2_000_000,
  });
  Object.assign(mEx, await publishJobSpec(w, mEx));
  const workerEx = await registerAgent(w);
  const entryEx = await enterContest(w, mEx, workerEx, { submit: false });
  const exclusiveClaimBalance = balance(w, entryEx.claim);

  // Contest claim: rent + the deposit, debited from the worker's wallet.
  const m = await setupTask(w);
  Object.assign(m, await publishJobSpec(w, m));
  const worker = await registerAgent(w);
  const before = balance(w, worker.kp.publicKey);
  const entry = await enterContest(w, m, worker, { submit: false });
  const contestClaimBalance = balance(w, entry.claim);

  assert.equal(
    contestClaimBalance - exclusiveClaimBalance,
    CONTEST_ENTRY_DEPOSIT,
    "REVERT-SENSITIVE (FIX 4): contest claim holds rent + exactly the 0.01 SOL deposit",
  );
  // Worker paid rent + deposit + tx fees (fees are why >=).
  assert.ok(
    before - balance(w, worker.kp.publicKey) >= contestClaimBalance,
    "worker funded rent + deposit",
  );
});

// ===========================================================================
// FIX 1a + FIX 4 — PendingValidation no-show expiry with absence proof;
// deposit forfeits to the TREASURY, rent to the worker
// ===========================================================================

test("FIX 1a/FIX 4: a no-show contest claim is expirable during PendingValidation; the deposit forfeits to the treasury (never the creator)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const m = await setupTask(w, { maxWorkers: 2 });
  Object.assign(m, await publishJobSpec(w, m));

  const [submitter, ghostEntrant] = [
    await registerAgent(w),
    await registerAgent(w),
  ];
  const es = await enterContest(w, m, submitter); // submits -> task PendingValidation
  const eg = await enterContest(w, m, ghostEntrant, { submit: false }); // no-show

  const t0 = decode(w.svm, "Task", m.task);
  assert.equal(t0.current_workers, 2);
  assert.equal(t0._reserved[1], 1, "one live submission");

  // Past claim expiry + grace so a third party can expire.
  warpTo(w, m.deadline + 3600 + 120);
  const cleaner = Keypair.generate();
  w.svm.airdrop(cleaner.publicKey, BigInt(1e9));

  // Caller-omission attack stays closed: PendingValidation without the derived
  // submission account is rejected.
  expectFail(
    send(
      w.svm,
      await expireIx(w, m, ghostEntrant, eg, cleaner, {
        withSubmission: false,
      }),
      [cleaner],
    ),
    "TaskSubmissionRequired",
    "expire without the absence proof",
  );
  // Forfeit is non-skippable: the treasury account is required.
  expectFail(
    send(
      w.svm,
      await expireIx(w, m, ghostEntrant, eg, cleaner, { withTreasury: false }),
      [cleaner],
    ),
    "ContestForfeitTreasuryRequired",
    "expire without the treasury",
  );

  const treasuryBefore = balance(w, w.admin.publicKey);
  const workerBefore = balance(w, ghostEntrant.kp.publicKey);
  const claimTotal = balance(w, eg.claim);
  expectOk(
    send(w.svm, await expireIx(w, m, ghostEntrant, eg, cleaner), [cleaner]),
    "REVERT-SENSITIVE (FIX 1a): PendingValidation no-show expiry with the empty derived submission PDA",
  );

  assert.ok(isClosed(w.svm, eg.claim), "no-show claim closed");
  assert.equal(
    balance(w, w.admin.publicKey) - treasuryBefore,
    CONTEST_ENTRY_DEPOSIT,
    "REVERT-SENSITIVE (FIX 4): the forfeited deposit went to the TREASURY",
  );
  assert.equal(
    balance(w, ghostEntrant.kp.publicKey) - workerBefore,
    claimTotal - CONTEST_ENTRY_DEPOSIT,
    "the worker got back exactly the claim rent (deposit forfeited)",
  );

  const t1 = decode(w.svm, "Task", m.task);
  assert.equal(t1.current_workers, 1, "slot freed");
  assert.equal(
    t1._reserved[1],
    1,
    "the submitter's live submission is untouched",
  );
  const agent = decode(w.svm, "AgentRegistration", ghostEntrant.agentPda);
  assert.equal(
    agent.active_tasks,
    0,
    "no-show worker's active_tasks slot freed",
  );

  // The live submitter's Submitted claim still cannot be expired (guard intact).
  expectFail(
    send(w.svm, await expireIx(w, m, submitter, es, cleaner), [cleaner]),
    "TaskNotInProgress",
    "expiring a claim with live Submitted work",
  );
});

// ===========================================================================
// FIX 1b — reclaim_terminal_claim un-bricks close_task (ghost + accept paths)
// ===========================================================================

test("FIX 1b: ghost lifecycle with a no-show claim -> reclaim_terminal_claim -> close_task succeeds", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const m = await setupTask(w, { maxWorkers: 3 });
  Object.assign(m, await publishJobSpec(w, m));

  const [a, b, ghost] = [
    await registerAgent(w),
    await registerAgent(w),
    await registerAgent(w),
  ];
  const ea = await enterContest(w, m, a);
  const eb = await enterContest(w, m, b);
  const eg = await enterContest(w, m, ghost, { submit: false }); // the no-show

  const cranker = Keypair.generate();
  w.svm.airdrop(cranker.publicKey, BigInt(1e9));

  // Reclaim on a NON-terminal task is rejected.
  expectFail(
    send(w.svm, await reclaimIx(w, m, ghost, eg, cranker), [cranker]),
    "ClaimReclaimRequiresTerminalTask",
    "reclaim before the task is terminal",
  );

  warpTo(w, m.ghostAt + 5);
  expectOk(
    send(w.svm, await ghostIx(w, m, a, ea, cranker), [cranker]),
    "ghost crank a",
  );
  expectOk(
    send(w.svm, await ghostIx(w, m, b, eb, cranker), [cranker]),
    "ghost crank b (final slice)",
  );

  const t = decode(w.svm, "Task", m.task);
  assert.ok(
    JSON.stringify(t.status).includes("ompleted"),
    "task Completed after the final slice",
  );
  assert.equal(t.current_workers, 1, "the no-show claim still holds a slot");

  // Pre-fix strand proof: expire_claim is dead on a terminal task (the ghost
  // settlement already closed the escrow account expire_claim requires).
  expectFail(
    send(w.svm, await expireIx(w, m, ghost, eg, cranker), [cranker]),
    "AccountNotInitialized",
    "expire_claim on a Completed task",
  );
  // ...and close_task is bricked while current_workers > 0.
  expectFail(
    send(w.svm, await closeTaskIx(w, m), [w.buyer]),
    "TaskNotClosable",
    "close_task with a stranded no-show claim",
  );

  // REVERT-SENSITIVE (FIX 1b): the reclaim frees everything.
  const treasuryBefore = balance(w, w.admin.publicKey);
  const workerBefore = balance(w, ghost.kp.publicKey);
  const claimTotal = balance(w, eg.claim);
  expectOk(
    send(w.svm, await reclaimIx(w, m, ghost, eg, cranker), [cranker]),
    "reclaim_terminal_claim",
  );
  assert.ok(isClosed(w.svm, eg.claim), "stranded claim closed");
  assert.equal(
    balance(w, w.admin.publicKey) - treasuryBefore,
    CONTEST_ENTRY_DEPOSIT,
    "deposit forfeited to treasury",
  );
  assert.equal(
    balance(w, ghost.kp.publicKey) - workerBefore,
    claimTotal - CONTEST_ENTRY_DEPOSIT,
    "rent back to the worker",
  );
  assert.equal(
    decode(w.svm, "Task", m.task).current_workers,
    0,
    "current_workers -> 0",
  );
  assert.equal(
    decode(w.svm, "AgentRegistration", ghost.agentPda).active_tasks,
    0,
    "active_tasks slot freed",
  );

  // Re-reclaiming fails (claim closed).
  const again = send(w.svm, await reclaimIx(w, m, ghost, eg, cranker), [
    cranker,
  ]);
  assert.ok(again.constructor.name.includes("Failed"), "re-reclaim fails");

  // close_task now succeeds while retaining the durable Task parent. (The earlier
  // bricked attempt was byte-identical; rotate the blockhash past litesvm dedup.)
  w.svm.expireBlockhash();
  expectOk(
    send(w.svm, await closeTaskIx(w, m), [w.buyer]),
    "close_task after reclaim",
  );
  assert.ok(!isClosed(w.svm, m.task), "durable terminal Task anchor remains");
  assert.ok(
    decode(w.svm, "Task", m.task).status.Completed !== undefined,
    "terminal state remains decodable",
  );
});

test("FIX 1b: accept-path variant — winner accepted, no-show reclaimed, close_task succeeds", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const m = await setupTask(w, { maxWorkers: 2, reward: 5_000_000 });
  Object.assign(m, await publishJobSpec(w, m));

  const [winner, ghost] = [await registerAgent(w), await registerAgent(w)];
  const ew = await enterContest(w, m, winner);
  const eg = await enterContest(w, m, ghost, { submit: false });

  // The no-show has no live submission, so live_submissions == 1 and the winner
  // can be accepted directly.
  expectOk(
    send(w.svm, await acceptIx(w, m, winner, ew), [w.buyer]),
    "accept winner",
  );
  assert.ok(isClosed(w.svm, m.escrow), "escrow closed on accept");
  assert.equal(
    decode(w.svm, "Task", m.task).current_workers,
    1,
    "no-show claim survives accept",
  );

  const cranker = Keypair.generate();
  w.svm.airdrop(cranker.publicKey, BigInt(1e9));
  const treasuryBefore = balance(w, w.admin.publicKey);
  expectOk(
    send(w.svm, await reclaimIx(w, m, ghost, eg, cranker), [cranker]),
    "reclaim after accept",
  );
  assert.equal(
    balance(w, w.admin.publicKey) - treasuryBefore,
    CONTEST_ENTRY_DEPOSIT,
    "deposit forfeited",
  );
  assert.equal(decode(w.svm, "Task", m.task).current_workers, 0);

  expectOk(
    send(w.svm, await closeTaskIx(w, m), [w.buyer]),
    "close_task after accept-path reclaim",
  );
  assert.ok(!isClosed(w.svm, m.task), "durable terminal Task anchor remains");
});

// ===========================================================================
// FIX 4 — deposit refunded in full on the submit -> reject path
// ===========================================================================

test("FIX 4: a submitting loser is refunded the deposit in full on reject (losers lose nothing)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const m = await setupTask(w, { maxWorkers: 2 });
  Object.assign(m, await publishJobSpec(w, m));
  const loser = await registerAgent(w);
  const el = await enterContest(w, m, loser);

  const before = balance(w, loser.kp.publicKey);
  const claimTotal = balance(w, el.claim); // rent + deposit
  const subRent = balance(w, el.submission);
  assert.ok(claimTotal > CONTEST_ENTRY_DEPOSIT, "claim carries the deposit");
  expectOk(
    send(w.svm, await rejectIx(w, m, loser, el), [w.buyer]),
    "reject the entry",
  );
  assert.equal(
    balance(w, loser.kp.publicKey) - before,
    claimTotal + subRent,
    "REVERT-SENSITIVE (FIX 4): reject returns claim rent + DEPOSIT + submission rent in full",
  );
});

// ===========================================================================
// FIX 2 — temporal partition, reject side
// ===========================================================================

test("FIX 2: reject works strictly before ghost_at and is forbidden at/after it (crank owns >= ghost_at)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const m = await setupTask(w, { maxWorkers: 2 });
  Object.assign(m, await publishJobSpec(w, m));
  const [x, y] = [await registerAgent(w), await registerAgent(w)];
  const ex = await enterContest(w, m, x);
  const ey = await enterContest(w, m, y);

  // Strictly before ghost_at: reject succeeds.
  warpTo(w, m.ghostAt - 1);
  expectOk(
    send(w.svm, await rejectIx(w, m, x, ex), [w.buyer]),
    "reject at ghost_at - 1",
  );

  // At ghost_at the creator can no longer reject-claw-back...
  warpTo(w, m.ghostAt);
  expectFail(
    send(w.svm, await rejectIx(w, m, y, ey), [w.buyer]),
    "ContestSelectionWindowElapsed",
    "REVERT-SENSITIVE (FIX 2): reject at ghost_at",
  );
  // ...the crank owns the submission from here.
  const cranker = Keypair.generate();
  w.svm.airdrop(cranker.publicKey, BigInt(1e9));
  expectOk(
    send(w.svm, await ghostIx(w, m, y, ey, cranker), [cranker]),
    "crank at ghost_at",
  );
  assert.ok(isClosed(w.svm, m.escrow), "contest settled by the crank");
});

// ===========================================================================
// FIX 3 — gates narrowed to contest-CONFIGURED tasks
// ===========================================================================

test("FIX 3: an AUTO-validation schema-1 Competitive task keeps dispute recourse; a CreatorReview contest does not", async () => {
  const w = await freshWorld({ moderationEnabled: true });

  // CreatorReview contest: dispute blocked (ContestFlowUnsupported).
  const contest = await setupTask(w);
  Object.assign(contest, await publishJobSpec(w, contest));
  const entrant = await registerAgent(w);
  const ec = await enterContest(w, contest, entrant, { submit: false });
  {
    const tid = decode(w.svm, "Task", contest.task).task_id;
    const disputeId = id32();
    const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
    const [buyerRate] = pda([
      enc("authority_rate_limit"),
      w.buyer.publicKey.toBuffer(),
    ]);
    expectFail(
      send(
        w.svm,
        await w.buyerProg.methods
          .initiateDispute(
            arr(disputeId),
            arr(tid),
            arr(Buffer.alloc(32, 1)),
            0,
            "bad work",
          )
          .accounts({
            dispute,
            task: contest.task,
            agent: w.buyerAgent,
            authorityRateLimit: buyerRate,
            protocolConfig: w.protocolPda,
            initiatorClaim: null,
            workerAgent: entrant.agentPda,
            workerClaim: ec.claim,
            taskSubmission: null,
            authority: w.buyer.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
        [w.buyer],
      ),
      "ContestFlowUnsupported",
      "dispute on a CreatorReview contest",
    );
  }

  // AUTO-mode schema-1 Competitive (no validation config): dispute still works.
  const auto = await setupTask(w, { mode: null });
  Object.assign(auto, await publishJobSpec(w, auto));
  const worker = await registerAgent(w);
  const ea = await enterContest(w, auto, worker, { submit: false });
  {
    const tid = decode(w.svm, "Task", auto.task).task_id;
    const disputeId = id32();
    const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
    const [buyerRate] = pda([
      enc("authority_rate_limit"),
      w.buyer.publicKey.toBuffer(),
    ]);
    expectOk(
      send(
        w.svm,
        await w.buyerProg.methods
          .initiateDispute(
            arr(disputeId),
            arr(tid),
            arr(Buffer.alloc(32, 1)),
            0,
            "bad work",
          )
          .accounts({
            dispute,
            task: auto.task,
            agent: w.buyerAgent,
            authorityRateLimit: buyerRate,
            protocolConfig: w.protocolPda,
            initiatorClaim: null,
            workerAgent: worker.agentPda,
            workerClaim: ea.claim,
            taskSubmission: null,
            authority: w.buyer.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
        [w.buyer],
      ),
      "REVERT-SENSITIVE (FIX 3): auto-mode Competitive keeps initiate_dispute",
    );
    const d = decode(w.svm, "Dispute", dispute);
    assert.ok(
      d.status.Active !== undefined,
      "dispute Active on the auto-mode Competitive task",
    );
  }

  // Auto-mode Competitive pays NO contest deposit (it never enters the lifecycle).
  const autoClaimBalance = balance(w, ea.claim);
  const contestClaimBalance = balance(w, ec.claim);
  assert.equal(
    contestClaimBalance - autoClaimBalance,
    CONTEST_ENTRY_DEPOSIT,
    "deposit charged only on the configured contest",
  );
});

// ===========================================================================
// FIX 5 — close_task straggler with a deregistered worker agent
// ===========================================================================

test("FIX 5: a retired identity tombstone still proves the worker rent recipient", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  // ValidatorQuorum reject leaves the TaskSubmission alive with the claim closed
  // — the canonical straggler (same setup as the §1 fail-closed test).
  const m = await setupTask(w, {
    taskType: 0,
    maxWorkers: 1,
    mode: 2,
    validatorQuorum: 1,
    reward: 2_000_000,
  });
  Object.assign(m, await publishJobSpec(w, m));
  const workerA = await registerAgent(w);
  // Identity continuity is intentionally strict: a registration timestamp equal
  // to the submission timestamp is ambiguous because revision 4 allowed a
  // close-and-recreate bundle in the same second. Model an actual pre-existing
  // worker here so the later RETD tombstone proves the original authority.
  warpTo(w, Number(w.svm.getClock().unixTimestamp) + 1);
  const entry = await enterContest(w, m, workerA);

  const validator = await registerAgent(w, CAP_VALIDATOR);
  // 2026-07 swarm: quorum votes require the anti-griefing stake floor.
  await injectAgentStake(w.svm, validator.agentPda, 100_000_000);
  const [vote] = pda([
    enc("task_validation_vote"),
    entry.submission.toBuffer(),
    validator.kp.publicKey.toBuffer(),
  ]);
  expectOk(
    send(
      w.svm,
      await validator.prog.methods
        .validateTaskResult(false)
        .accounts({
          task: m.task,
          claim: entry.claim,
          escrow: m.escrow,
          taskValidationConfig: m.validation,
          taskAttestorConfig: null,
          taskSubmission: entry.submission,
          taskValidationVote: vote,
          worker: workerA.agentPda,
          protocolConfig: w.protocolPda,
          validatorAgent: validator.agentPda,
          treasury: w.admin.publicKey,
          creator: w.buyer.publicKey,
          workerAuthority: workerA.kp.publicKey,
          reviewer: validator.kp.publicKey,
          tokenEscrowAta: null,
          workerTokenAccount: null,
          treasuryTokenAccount: null,
          rewardMint: null,
          tokenProgram: null,
          systemProgram: SystemProgram.programId,
          // 2026-07 swarm: bonds are required + seeds-pinned on validate_task_result
          creatorCompletionBond: pda([
            enc("completion_bond"),
            m.task.toBuffer(),
            w.buyer.publicKey.toBuffer(),
          ])[0],
          workerCompletionBond: pda([
            enc("completion_bond"),
            m.task.toBuffer(),
            workerA.kp.publicKey.toBuffer(),
          ])[0],
        })
        .instruction(),
      [validator.kp],
    ),
    "quorum reject",
  );
  assert.ok(
    !isClosed(w.svm, entry.submission),
    "rejected submission survives as a straggler",
  );

  // The worker deregisters (allowed: active_tasks == 0 after the quorum reject).
  expectOk(
    send(
      w.svm,
      await workerA.prog.methods
        .deregisterAgent()
        .accounts({
          agent: workerA.agentPda,
          protocolConfig: w.protocolPda,
          reputationStake: pda([
            enc("reputation_stake"),
            workerA.agentPda.toBuffer(),
          ])[0],
          authority: workerA.kp.publicKey,
        })
        .remainingAccounts(deregisterRemaining(workerA.agentPda))
        .instruction(),
      [workerA.kp],
    ),
    "deregister the straggler's agent",
  );
  const retired = decode(w.svm, "AgentRegistration", workerA.agentPda);
  assert.ok(
    !isClosed(w.svm, workerA.agentPda),
    "retired identity tombstone remains",
  );
  assert.deepEqual(
    Buffer.from(retired._reserved),
    Buffer.from("RETD"),
    "worker is provably retired",
  );

  expectOk(
    send(
      w.svm,
      await w.buyerProg.methods
        .cancelTask()
        .accounts({
          task: m.task,
          escrow: m.escrow,
          authority: w.buyer.publicKey,
          protocolConfig: w.protocolPda,
          tokenEscrowAta: null,
          creatorTokenAccount: null,
          rewardMint: null,
          tokenProgram: null,
          creatorCompletionBond: pda([
            enc("completion_bond"),
            m.task.toBuffer(),
            w.buyer.publicKey.toBuffer(),
          ])[0],
          workerCompletionBond: pda([
            enc("completion_bond"),
            m.task.toBuffer(),
            w.provider.publicKey.toBuffer(),
          ])[0],
          workerBondAuthority: w.provider.publicKey,
          creatorAgent: null,
          agentStats: null,
          systemProgram: SystemProgram.programId,
          treasury: null,
        })
        .instruction(),
      [w.buyer],
    ),
    "cancel task",
  );

  const triple = (wallet) => [
    { pubkey: entry.submission, isSigner: false, isWritable: true },
    { pubkey: workerA.agentPda, isSigner: false, isWritable: false },
    { pubkey: wallet, isSigner: false, isWritable: true },
  ];

  // FAIL-CLOSED both ways: without protocol_config there is no validated
  // treasury, and the CREATOR is never an acceptable payee.
  expectFail(
    send(w.svm, await closeTaskIx(w, m, triple(w.admin.publicKey)), [w.buyer]),
    "SubmissionRentAccountsRequired",
    "deregistered-agent straggler without protocol_config",
  );
  expectFail(
    send(
      w.svm,
      await closeTaskIx(w, m, triple(w.buyer.publicKey), {
        protocolConfig: w.protocolPda,
      }),
      [w.buyer],
    ),
    "SubmissionRentAccountsRequired",
    "deregistered-agent straggler with the CREATOR as payee",
  );
  // The durable tombstone retains the immutable authority, so the worker remains
  // a provable rent recipient even after retirement. Treasury fallback is only
  // needed for historical registrations that were actually closed.
  const workerBefore = balance(w, workerA.kp.publicKey);
  const subRent = balance(w, entry.submission);
  expectOk(
    send(
      w.svm,
      await closeTaskIx(w, m, triple(workerA.kp.publicKey), {
        protocolConfig: w.protocolPda,
      }),
      [w.buyer],
    ),
    "close_task with the tombstone-proven worker payee",
  );
  assert.ok(isClosed(w.svm, entry.submission), "straggler submission closed");
  assert.equal(
    balance(w, workerA.kp.publicKey) - workerBefore,
    subRent,
    "straggler rent returned to the worker",
  );
  assert.ok(!isClosed(w.svm, m.task), "durable terminal Task anchor remains");
});

// ===========================================================================
// FIX 6 — TaskCompleted only on the final ghost slice
// ===========================================================================

test("FIX 6: TaskCompleted fires only on the FINAL ghost slice; GhostShareDistributed fires per slice", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const m = await setupTask(w, { maxWorkers: 2, reward: 6_000_000 });
  Object.assign(m, await publishJobSpec(w, m));
  const [a, b] = [await registerAgent(w), await registerAgent(w)];
  const ea = await enterContest(w, m, a);
  const eb = await enterContest(w, m, b);

  warpTo(w, m.ghostAt + 5);
  const cranker = Keypair.generate();
  w.svm.airdrop(cranker.publicKey, BigInt(1e9));

  const res1 = send(w.svm, await ghostIx(w, m, a, ea, cranker), [cranker]);
  expectOk(res1, "first slice");
  const ev1 = eventNames(res1);
  assert.ok(
    ev1.includes("ghostsharedistributed"),
    "slice 1 emits GhostShareDistributed",
  );
  assert.ok(
    !ev1.includes("taskcompleted"),
    "REVERT-SENSITIVE (FIX 6): a non-final slice must NOT emit TaskCompleted",
  );

  const res2 = send(w.svm, await ghostIx(w, m, b, eb, cranker), [cranker]);
  expectOk(res2, "final slice");
  const ev2 = eventNames(res2);
  assert.ok(
    ev2.includes("ghostsharedistributed"),
    "final slice emits GhostShareDistributed",
  );
  assert.ok(
    ev2.includes("taskcompleted"),
    "the FINAL slice emits TaskCompleted",
  );
});
