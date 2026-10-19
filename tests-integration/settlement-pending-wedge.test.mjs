// AGNC-01: terminal cleanup must preserve peer claims until the dispute crank
// settles them. Derived from the reporter's expiry/control reproduction; also
// covers resolver rulings, multiple peers, review debt, pause, and legacy tasks.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  enc,
  arr,
  pda,
  id32,
  deregisterRemaining,
  makeProgram,
  send,
  sendMany,
  expectOk,
  expectFail,
  decode,
  isClosed,
  freshWorld,
  coder,
  configureTestMultisig,
  setProtocolPaused,
  warpSeconds,
  taskModV2Pda,
  moderationBlockPda,
  BN,
  Keypair,
  SystemProgram,
} from "./harness.mjs";
import { Buffer } from "node:buffer";

const STAKE = 1_000_000;

async function registerAgent(w, kp) {
  const agentId = id32();
  const [agent] = pda([enc("agent"), agentId]);
  expectOk(
    send(
      w.svm,
      await makeProgram(kp)
        .methods.registerAgent(
          arr(agentId),
          new BN(1),
          "http://peer.test",
          null,
          new BN(0),
        )
        .accounts({
          agent,
          protocolConfig: w.protocolPda,
          authority: kp.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [kp],
    ),
    "register peer agent",
  );
  return agent;
}

// Set the registration stake AND back it with matching lamports, keeping the
// account at its allocated size (the harness injectAgentStake helper rewrites the
// field only and re-encodes the account shorter).
async function fundStake(w, agentPda, amount) {
  const acct = w.svm.getAccount(agentPda);
  const data = Buffer.from(acct.data);
  const agent = coder.accounts.decode("AgentRegistration", data);
  agent.stake = new BN(amount);
  const encoded = await coder.accounts.encode("AgentRegistration", agent);
  encoded.copy(data, 0);
  w.svm.setAccount(agentPda, {
    ...acct,
    data,
    lamports: Number(acct.lamports) + amount,
  });
}

// A real task with a defendant and up to three peers, followed by a creator
// dispute against the defendant. All lifecycle transitions execute the program;
// only registration stake and the historical Competitive schema use fixtures.
async function setup(
  w,
  {
    peerCount = 1,
    taskType = 1,
    resolutionType = 0,
    submissionState = "absent",
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
  const [hireRecord] = pda([enc("hire"), task.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  expectOk(
    send(
      w.svm,
      await w.buyerProg.methods
        .createTask(
          arr(taskId),
          new BN(1),
          arr(desc),
          new BN(4_000_000),
          peerCount + 1,
          new BN(now + 3 * 86_400),
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
    "create multi-worker task",
  );

  if (taskType === 2) {
    // Only historical schema-0 Competitive tasks use the non-contest dispute
    // path. Preserve the current allocation while recreating that schema.
    const account = w.svm.getAccount(task);
    const data = Buffer.from(account.data);
    const value = decode(w.svm, "Task", task);
    value._reserved[0] = 0;
    (await coder.accounts.encode("Task", value)).copy(data);
    w.svm.setAccount(task, { ...account, data });
  }
  let validation = null;
  if (submissionState !== "absent") {
    [validation] = pda([enc("task_validation"), task.toBuffer()]);
    expectOk(
      send(
        w.svm,
        await w.buyerProg.methods
          .configureTaskValidation(1, new BN(3600), 0, null)
          .accounts({
            task,
            taskValidationConfig: validation,
            taskAttestorConfig: pda([enc("task_attestor"), task.toBuffer()])[0],
            protocolConfig: w.protocolPda,
            hireRecord,
            creator: w.buyer.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
        [w.buyer],
      ),
      "configure CreatorReview",
    );
  }

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
    "task-mod",
  );
  expectOk(
    send(
      w.svm,
      await w.buyerProg.methods
        .setTaskJobSpec(
          arr(jobHash),
          "agenc://job-spec/sha256/wedge",
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
    "publish",
  );

  const claimFor = async (kp, agent) => {
    const [claim] = pda([enc("claim"), task.toBuffer(), agent.toBuffer()]);
    expectOk(
      send(
        w.svm,
        await makeProgram(kp)
          .methods.claimTaskWithJobSpec()
          .accounts({
            task,
            taskJobSpec: jobSpec,
            hireRecord,
            legacyListing: null,
            moderationBlock: moderationBlockPda(jobHash)[0],
            claim,
            protocolConfig: w.protocolPda,
            worker: agent,
            authority: kp.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
        [kp],
      ),
      "claim",
    );
    return claim;
  };
  const claimA = await claimFor(w.provider, w.providerAgent);
  const peers = [];
  for (let i = 0; i < peerCount; i++) {
    const peer = Keypair.generate();
    w.svm.airdrop(peer.publicKey, BigInt(100e9));
    const peerAgent = await registerAgent(w, peer);
    const claimB = await claimFor(peer, peerAgent);
    const [subB] = pda([enc("task_submission"), claimB.toBuffer()]);
    peers.push({ peer, peerAgent, claimB, subB });
    if (submissionState !== "absent") {
      expectOk(
        send(
          w.svm,
          await makeProgram(peer)
            .methods.submitTaskResult(arr(id32()), arr(desc))
            .accounts({
              task,
              claim: claimB,
              taskValidationConfig: validation,
              taskSubmission: subB,
              protocolConfig: w.protocolPda,
              worker: peerAgent,
              authority: peer.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .instruction(),
          [peer],
        ),
        "submit peer delivery",
      );
      if (submissionState === "rejected") {
        expectOk(
          send(
            w.svm,
            await w.buyerProg.methods
              .requestChanges(arr(id32()))
              .accounts({
                task,
                claim: claimB,
                taskValidationConfig: validation,
                taskSubmission: subB,
                protocolConfig: w.protocolPda,
                creator: w.buyer.publicKey,
              })
              .instruction(),
            [w.buyer],
          ),
          "reject peer delivery",
        );
      }
    }
  }
  assert.equal(
    decode(w.svm, "Task", task).current_workers,
    peerCount + 1,
    "all workers are live",
  );

  // Give the initiator (creator agent) a real registration stake that must stay recoverable.
  await fundStake(w, w.buyerAgent, STAKE);

  const tid = decode(w.svm, "Task", task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [initRate] = pda([
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
          resolutionType,
          "evidence",
        )
        .accounts({
          dispute,
          task,
          agent: w.buyerAgent,
          authorityRateLimit: initRate,
          protocolConfig: w.protocolPda,
          initiatorClaim: null,
          workerAgent: w.providerAgent,
          workerClaim: claimA,
          taskSubmission: null,
          authority: w.buyer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [w.buyer],
    ),
    "creator disputes worker A",
  );

  return {
    task,
    escrow,
    hireRecord,
    dispute,
    claimA,
    validation,
    jobSpec,
    peers,
    ...peers[0],
    subA: pda([enc("task_submission"), claimA.toBuffer()])[0],
  };
}

function expireIx(w, r, crank) {
  return makeProgram(crank)
    .methods.expireDispute()
    .accounts({
      dispute: r.dispute,
      task: r.task,
      escrow: r.escrow,
      protocolConfig: w.protocolPda,
      creator: w.buyer.publicKey,
      authority: crank.publicKey,
      workerClaim: r.claimA,
      worker: w.providerAgent,
      workerWallet: w.provider.publicKey,
      hireRecord: r.hireRecord,
      disputeOperator: null,
      disputeReferrer: null,
      tokenEscrowAta: null,
      creatorTokenAccount: null,
      workerTokenAccountAta: null,
      rewardMint: null,
      tokenProgram: null,
      creatorCompletionBond: pda([
        enc("completion_bond"),
        r.task.toBuffer(),
        w.buyer.publicKey.toBuffer(),
      ])[0],
      workerCompletionBond: pda([
        enc("completion_bond"),
        r.task.toBuffer(),
        w.provider.publicKey.toBuffer(),
      ])[0],
      taskSubmission: r.subA,
      taskValidationConfig: r.validation,
    })
    .instruction();
}

function reclaimIx(w, r, crank) {
  return makeProgram(crank)
    .methods.reclaimTerminalClaim()
    .accounts({
      authority: crank.publicKey,
      task: r.task,
      claim: r.claimB,
      taskSubmission: r.subB,
      taskValidationConfig: r.validation,
      worker: r.peerAgent,
      protocolConfig: w.protocolPda,
      treasury: w.admin.publicKey,
      rentRecipient: r.peer.publicKey,
    })
    .instruction();
}

function settleIx(w, r, crank) {
  return makeProgram(crank)
    .methods.settleDisputeClaim()
    .accounts({
      protocolConfig: w.protocolPda,
      dispute: r.dispute,
      task: r.task,
      claim: r.claimB,
      worker: r.peerAgent,
      taskSubmission: r.subB,
      taskValidationConfig: r.validation,
      authority: crank.publicKey,
    })
    .instruction();
}

function slashIx(w, r, crank) {
  return makeProgram(crank)
    .methods.applyInitiatorSlash()
    .accounts({
      dispute: r.dispute,
      initiatorAgent: w.buyerAgent,
      protocolConfig: w.protocolPda,
      treasury: w.admin.publicKey,
      authority: crank.publicKey,
    })
    .instruction();
}

function deregisterIx(w) {
  return w.buyerProg.methods
    .deregisterAgent()
    .accounts({
      agent: w.buyerAgent,
      protocolConfig: w.protocolPda,
      reputationStake: pda([
        enc("reputation_stake"),
        w.buyerAgent.toBuffer(),
      ])[0],
      authority: w.buyer.publicKey,
    })
    .remainingAccounts(deregisterRemaining(w.buyerAgent))
    .instruction();
}

function warpPastResolverWindow(w, r) {
  const votingDeadline = Number(
    decode(w.svm, "Dispute", r.dispute).voting_deadline,
  );
  const c = w.svm.getClock();
  c.unixTimestamp = BigInt(votingDeadline + 121);
  w.svm.setClock(c);
  w.svm.expireBlockhash();
}

function newCrank(w) {
  const k = Keypair.generate();
  w.svm.airdrop(k.publicKey, BigInt(10e9));
  return k;
}

async function resolveIx(w, r, { resolutionType = 0, approve = true } = {}) {
  const resolver = newCrank(w);
  const approvals = await configureTestMultisig(w);
  const [resolverEntry] = pda([
    enc("dispute_resolver"),
    resolver.publicKey.toBuffer(),
  ]);
  expectOk(
    send(
      w.svm,
      await makeProgram(w.admin)
        .methods.assignDisputeResolver(resolver.publicKey)
        .accounts({
          protocolConfig: w.protocolPda,
          disputeResolver: resolverEntry,
          authority: w.admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(approvals.remainingAccounts)
        .instruction(),
      approvals.approvers,
    ),
    "assign resolver",
  );
  const ix = await makeProgram(resolver)
    .methods.resolveDispute(approve, arr(id32()), "agenc://ruling/agnc-01")
    .accounts({
      dispute: r.dispute,
      task: r.task,
      escrow: r.escrow,
      protocolConfig: w.protocolPda,
      authority: resolver.publicKey,
      resolverAssignment: resolverEntry,
      creator: w.buyer.publicKey,
      workerClaim: r.claimA,
      worker: w.providerAgent,
      workerWallet: w.provider.publicKey,
      agentStats:
        resolutionType === 2 && approve
          ? null
          : pda([enc("agent_stats"), w.providerAgent.toBuffer()])[0],
      hireRecord: r.hireRecord,
      disputeOperator: null,
      disputeReferrer: null,
      systemProgram: SystemProgram.programId,
      tokenEscrowAta: null,
      creatorTokenAccount: null,
      workerTokenAccountAta: null,
      treasuryTokenAccount: null,
      rewardMint: null,
      tokenProgram: null,
      creatorCompletionBond: pda([
        enc("completion_bond"),
        r.task.toBuffer(),
        w.buyer.publicKey.toBuffer(),
      ])[0],
      workerCompletionBond: pda([
        enc("completion_bond"),
        r.task.toBuffer(),
        w.provider.publicKey.toBuffer(),
      ])[0],
      bondTreasury: w.admin.publicKey,
      taskSubmission: r.subA,
      taskValidationConfig: r.validation,
    })
    .instruction();
  return { ix, resolver };
}

async function finalizeAndRecoverStake(w, r, crank, expectedStake = STAKE) {
  expectOk(
    send(w.svm, await slashIx(w, r, crank), [crank]),
    "initiator finalizer",
  );
  assert.equal(
    decode(w.svm, "AgentRegistration", w.buyerAgent).active_dispute_votes,
    0,
  );
  assert.equal(
    decode(w.svm, "AgentRegistration", w.buyerAgent).stake.toNumber(),
    expectedStake,
  );
  w.svm.expireBlockhash();
  const before = Number(w.svm.getBalance(w.buyer.publicKey));
  expectOk(
    send(w.svm, await deregisterIx(w), [w.buyer]),
    "initiator deregisters",
  );
  const refunded = Number(w.svm.getBalance(w.buyer.publicKey)) - before + 5_000;
  assert.equal(
    refunded,
    expectedStake,
    "registration stake returned to the initiator",
  );
}

function assertSettlement(
  w,
  r,
  { total, settled, terminal, workerSlash = false },
) {
  const dispute = decode(w.svm, "Dispute", r.dispute);
  const task = decode(w.svm, "Task", r.task);
  assert.equal(dispute.peer_workers_total, total);
  assert.equal(dispute.peer_workers_settled, settled);
  assert.ok(
    dispute.status[settled === total ? terminal : "SettlementPending"] !==
      undefined,
  );
  assert.equal(
    task._reserved[11],
    Number(settled < total),
    "peer reservation lasts through the final peer",
  );
  assert.equal(
    task._reserved[2],
    Number(workerSlash),
    "worker slash reservation is independent",
  );
  assert.equal(task.current_workers, total - settled + Number(workerSlash));
}

async function assertReclaimBlocked(
  w,
  r,
  crank,
  error = "ClaimSettlementPending",
) {
  const watched = [
    r.task,
    r.dispute,
    r.claimB,
    r.subB,
    r.peerAgent,
    r.peer.publicKey,
    w.admin.publicKey,
  ];
  const snapshot = () => watched.map((key) => w.svm.getAccount(key));
  const before = snapshot();
  w.svm.expireBlockhash();
  expectFail(
    send(w.svm, await reclaimIx(w, r, crank), [crank]),
    error,
    "generic cleanup cannot consume a reserved peer",
  );
  assert.deepEqual(
    snapshot(),
    before,
    "blocked reclaim changes no account data or lamports",
  );
}

test("AGNC-01 control: expiry, peer settlement and initiator stake recovery", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await setup(w);
  warpPastResolverWindow(w, r);
  const crank = newCrank(w);
  expectOk(send(w.svm, await expireIx(w, r, crank), [crank]), "expire_dispute");
  assertSettlement(w, r, { total: 1, settled: 0, terminal: "Expired" });
  expectOk(send(w.svm, await settleIx(w, r, crank), [crank]), "settle peer");
  assertSettlement(w, r, { total: 1, settled: 1, terminal: "Expired" });
  await finalizeAndRecoverStake(w, r, crank);
});

test("AGNC-01: expiry + reclaim in one stranger transaction rolls back; stake remains recoverable", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await setup(w);
  warpPastResolverWindow(w, r);
  const stranger = newCrank(w);
  const watched = [
    r.task,
    r.dispute,
    r.escrow,
    r.claimA,
    r.claimB,
    w.buyerAgent,
    w.providerAgent,
    r.peerAgent,
  ];
  const before = watched.map((key) => w.svm.getAccount(key));
  expectFail(
    sendMany(
      w.svm,
      [await expireIx(w, r, stranger), await reclaimIx(w, r, stranger)],
      [stranger],
    ),
    "ClaimSettlementPending",
    "atomic expiry + reclaim",
  );
  assert.deepEqual(
    watched.map((key) => w.svm.getAccount(key)),
    before,
    "both instructions roll back",
  );

  w.svm.expireBlockhash();
  expectOk(
    send(w.svm, await expireIx(w, r, stranger), [stranger]),
    "standalone expiry",
  );
  await assertReclaimBlocked(w, r, stranger);
  expectFail(
    send(w.svm, await slashIx(w, r, stranger), [stranger]),
    "DisputeNotResolved",
    "must settle peers first",
  );
  expectFail(
    send(w.svm, await deregisterIx(w), [w.buyer]),
    "ActiveDisputeVotes",
    "counter still guards deregistration",
  );

  // Recovery and the reservation remain available even years later and paused.
  warpSeconds(w.svm, 5 * 365 * 86_400);
  await setProtocolPaused(w.svm, true);
  await assertReclaimBlocked(w, r, stranger);
  expectOk(
    send(w.svm, await settleIx(w, r, stranger), [stranger]),
    "permissionless peer settlement while paused",
  );
  assertSettlement(w, r, { total: 1, settled: 1, terminal: "Expired" });
  await finalizeAndRecoverStake(w, r, stranger);
});

for (const taskType of [1, 2]) {
  for (const outcome of ["expire", "reject", "complete", "split", "refund"]) {
    test(`AGNC-01: ${taskType === 1 ? "Collaborative" : "legacy Competitive"} ${outcome} reserves every peer`, async () => {
      const w = await freshWorld({ moderationEnabled: true });
      const resolutionType =
        outcome === "complete" ? 1 : outcome === "split" ? 2 : 0;
      const r = await setup(w, { taskType, peerCount: 3, resolutionType });
      const crank = newCrank(w);
      const terminal = outcome === "expire" ? "Expired" : "Resolved";
      const workerSlash = outcome === "refund";
      if (outcome === "expire") {
        warpPastResolverWindow(w, r);
        expectOk(send(w.svm, await expireIx(w, r, crank), [crank]), "expire");
      } else {
        const { ix, resolver } = await resolveIx(w, r, {
          resolutionType,
          approve: outcome !== "reject",
        });
        expectOk(send(w.svm, ix, [resolver]), "resolve");
      }
      const generation = decode(w.svm, "Task", r.task)._reserved.slice(3, 11);
      assertSettlement(w, r, { total: 3, settled: 0, terminal, workerSlash });
      for (let i = 0; i < r.peers.length; i++) {
        const peer = { ...r, ...r.peers[i] };
        await assertReclaimBlocked(
          w,
          peer,
          crank,
          workerSlash ? "ClaimSlashPending" : "ClaimSettlementPending",
        );
        expectOk(
          send(w.svm, await settleIx(w, peer, crank), [crank]),
          "settle next peer",
        );
        assert.ok(isClosed(w.svm, peer.claimB));
        assert.equal(
          decode(w.svm, "AgentRegistration", peer.peerAgent).active_tasks,
          0,
        );
        assertSettlement(w, r, {
          total: 3,
          settled: i + 1,
          terminal,
          workerSlash,
        });
        if (i === 0) {
          w.svm.expireBlockhash();
          expectFail(
            send(w.svm, await settleIx(w, peer, crank), [crank]),
            "AccountDiscriminatorMismatch",
            "no double settlement of a tombstoned claim",
          );
          assertSettlement(w, r, {
            total: 3,
            settled: 1,
            terminal,
            workerSlash,
          });
        }
      }
      assert.deepEqual(
        decode(w.svm, "Task", r.task)._reserved.slice(3, 11),
        generation,
      );
      if (workerSlash) {
        expectOk(
          send(
            w.svm,
            await makeProgram(crank)
              .methods.applyDisputeSlash()
              .accounts({
                dispute: r.dispute,
                task: r.task,
                workerClaim: r.claimA,
                workerAgent: w.providerAgent,
                workerAuthority: w.provider.publicKey,
                protocolConfig: w.protocolPda,
                treasury: w.admin.publicKey,
                authority: crank.publicKey,
                escrow: null,
                tokenEscrowAta: null,
                treasuryTokenAccount: null,
                rewardMint: null,
                tokenProgram: null,
                creator: null,
              })
              .instruction(),
            [crank],
          ),
          "worker slash finalizer",
        );
        assertSettlement(w, r, { total: 3, settled: 3, terminal });
      }
      await finalizeAndRecoverStake(
        w,
        r,
        crank,
        outcome === "reject" ? STAKE / 2 : STAKE,
      );
    });
  }
}

for (const submissionState of ["submitted", "rejected"]) {
  for (const outcome of ["expire", "complete"]) {
    test(`AGNC-01: ${outcome} preserves ${submissionState} peer submission and review counters`, async () => {
      const w = await freshWorld({ moderationEnabled: true });
      const r = await setup(w, { submissionState, resolutionType: 1 });
      const crank = newCrank(w);
      if (outcome === "expire") {
        warpPastResolverWindow(w, r);
        expectOk(
          send(w.svm, await expireIx(w, r, crank), [crank]),
          "expire reviewed task",
        );
      } else {
        const { ix, resolver } = await resolveIx(w, r, { resolutionType: 1 });
        expectOk(send(w.svm, ix, [resolver]), "complete reviewed task");
      }
      const debt = submissionState === "submitted" ? 1 : 0;
      const pending = () =>
        Buffer.from(
          decode(w.svm, "TaskValidationConfig", r.validation)._reserved,
        ).readUInt16LE(1);
      assert.equal(pending(), debt);
      assert.equal(decode(w.svm, "Task", r.task)._reserved[1], debt);
      await assertReclaimBlocked(w, r, crank);
      expectOk(
        send(w.svm, await settleIx(w, r, crank), [crank]),
        "settle review debt through dispute crank",
      );
      assert.ok(isClosed(w.svm, r.subB));
      assert.ok(isClosed(w.svm, r.claimB));
      assert.equal(pending(), 0);
      assert.equal(decode(w.svm, "Task", r.task)._reserved[1], 0);
      assertSettlement(w, r, {
        total: 1,
        settled: 1,
        terminal: outcome === "expire" ? "Expired" : "Resolved",
      });
      await finalizeAndRecoverStake(w, r, crank);
    });
  }
}

for (const outcome of ["expire", "resolve"]) {
  test(`AGNC-01: single-worker ${outcome} stays terminal without a peer reservation`, async () => {
    const w = await freshWorld({ moderationEnabled: true });
    const r = await setup(w, { peerCount: 0, taskType: 0, resolutionType: 1 });
    const crank = newCrank(w);
    if (outcome === "expire") {
      warpPastResolverWindow(w, r);
      expectOk(
        send(w.svm, await expireIx(w, r, crank), [crank]),
        "expire single-worker dispute",
      );
    } else {
      const { ix, resolver } = await resolveIx(w, r, { resolutionType: 1 });
      expectOk(send(w.svm, ix, [resolver]), "resolve single-worker dispute");
    }
    assertSettlement(w, r, {
      total: 0,
      settled: 0,
      terminal: outcome === "expire" ? "Expired" : "Resolved",
    });
    await finalizeAndRecoverStake(w, r, crank);
  });
}
