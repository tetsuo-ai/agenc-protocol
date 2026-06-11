// REAL on-chain watch: boot startLocalMarketplace (the compiled
// agenc-coordination program in litesvm), createTask, and assert
// watchClaimableTasks surfaces the freshly-created Open task through its
// catch-up (gPA) read path — with no hand-tuned poll loop.
//
// litesvm exposes no logsNotifications WebSocket, so the LIVE event path is
// covered by the structural suite (tests/watch.test.ts, fabricated
// TaskCreated events); here we exercise the catch-up sweep against the real
// program state, which is the fallback every HTTP-only worker bot relies on.
import { describe, it, expect } from "vitest";
import {
  facade,
  findAgentPda,
  findTaskPda,
  findTaskJobSpecPda,
  TaskStatus,
} from "../src/index.js";
import { watchClaimableTasks, type ClaimableTask } from "../src/watch/index.js";
import { startLocalMarketplace } from "../src/testing/index.js";
import { GpaSimulator } from "./gpa-sim.js";

describe("e2e: watchClaimableTasks surfaces a real on-chain task via catch-up", () => {
  it("createTask -> watch surfaces the Open task within the first sweep", async () => {
    const market = await startLocalMarketplace();
    const creator = await market.fundedSigner();
    const creatorClient = market.clientFor(creator);

    // Register a creator agent (create_task requires the creator's agent PDA).
    const creatorAgentId = new Uint8Array(32).fill(201);
    await creatorClient.registerAgent({
      authority: creator,
      agentId: creatorAgentId,
      capabilities: 1n,
      endpoint: "http://creator.test",
      metadataUri: null,
      stakeAmount: 0n,
    });
    const [creatorAgent] = await findAgentPda({ agentId: creatorAgentId });

    // Create an Open task: capabilities 0b1, reward 3 SOL-lamports-ish.
    const taskId = new Uint8Array(32).fill(202);
    const reward = 3_000_000n;
    const now = market.svm.getClock().unixTimestamp;
    await creatorClient.send([
      await facade.createTask({
        authority: creator,
        creator,
        creatorAgent,
        taskId,
        requiredCapabilities: 1n,
        description: new Uint8Array(64).fill(7, 0, 32),
        rewardAmount: reward,
        maxWorkers: 1,
        deadline: now + 3600n,
        taskType: 0,
        constraintHash: null,
        minReputation: 0,
        rewardMintArg: null,
      }),
    ]);
    const [taskPda] = await findTaskPda({ creator: creator.address, taskId });

    // Confirm it really minted Open on-chain (sanity for the watch assertion).
    const acct = market.svm.getAccount(taskPda);
    expect(acct?.exists).toBe(true);

    // PIN the job spec — claim_task_with_job_spec (and now the watch's
    // "Open AND pinned" predicate) require it. Attest, then set the pointer.
    const jobSpecHash = new Uint8Array(32).fill(55);
    await market.moderator.attestTask(taskPda, jobSpecHash);
    await creatorClient.send([
      await facade.setTaskJobSpec({
        task: taskPda,
        creator,
        jobSpecHash,
        jobSpecUri: "agenc://job-spec/sha256/watch-e2e",
      }),
    ]);
    const [taskJobSpecPda] = await findTaskJobSpecPda({ task: taskPda });

    // The catch-up read path: a litesvm-backed ProgramAccountsTransport. Register
    // the task, its pinned job-spec PDA, and a non-matching noise account (the
    // creator's agent PDA) to prove the discriminator/status filters do their job.
    const sim = new GpaSimulator(market.svm);
    sim.register(taskPda, taskJobSpecPda, creatorAgent);

    // Watch via the catch-up sweep only (no rpcSubscriptions in litesvm). The
    // worker has capability 0b1 and wants tasks rewarding >= 1 SOL-lamport.
    const surfaced: ClaimableTask[] = [];
    let resolveFirst!: (t: ClaimableTask) => void;
    const first = new Promise<ClaimableTask>((r) => (resolveFirst = r));
    const watch = watchClaimableTasks({
      indexer: sim,
      filter: { capabilities: 0b1n, minReward: 1n },
      onTask: (t) => {
        surfaced.push(t);
        resolveFirst(t);
      },
      pollIntervalMs: 50,
    });

    const claimable = await first;
    await watch.stop();

    expect(claimable.task).toBe(taskPda);
    expect(claimable.creator).toBe(creator.address);
    expect(new Uint8Array(claimable.taskId)).toEqual(taskId);
    expect(claimable.requiredCapabilities).toBe(1n);
    expect(claimable.rewardAmount).toBe(reward);
    expect(claimable.rewardMint).toBeNull(); // SOL-denominated
    expect(claimable.source).toBe("catch-up");
    expect(claimable.account).toBeDefined();
    expect(claimable.account!.status).toBe(TaskStatus.Open);

    // Exactly the one matching task surfaced (noise account filtered out).
    expect(new Set(surfaced.map((t) => t.task))).toEqual(new Set([taskPda]));
  });

  it("excludes a task whose required capabilities exceed the worker's", async () => {
    const market = await startLocalMarketplace();
    const creator = await market.fundedSigner();
    const creatorClient = market.clientFor(creator);

    const creatorAgentId = new Uint8Array(32).fill(211);
    await creatorClient.registerAgent({
      authority: creator,
      agentId: creatorAgentId,
      capabilities: 0b111n,
      endpoint: "http://creator2.test",
      metadataUri: null,
      stakeAmount: 0n,
    });
    const [creatorAgent] = await findAgentPda({ agentId: creatorAgentId });

    // Task requires capability bit 0b100 — a 0b011 worker cannot claim it.
    const taskId = new Uint8Array(32).fill(212);
    const now = market.svm.getClock().unixTimestamp;
    await creatorClient.send([
      await facade.createTask({
        authority: creator,
        creator,
        creatorAgent,
        taskId,
        requiredCapabilities: 0b100n,
        description: new Uint8Array(64).fill(8, 0, 32),
        rewardAmount: 5_000_000n,
        maxWorkers: 1,
        deadline: now + 3600n,
        taskType: 0,
        constraintHash: null,
        minReputation: 0,
        rewardMintArg: null,
      }),
    ]);
    const [taskPda] = await findTaskPda({ creator: creator.address, taskId });

    const sim = new GpaSimulator(market.svm);
    sim.register(taskPda);

    const surfaced: ClaimableTask[] = [];
    const watch = watchClaimableTasks({
      indexer: sim,
      filter: { capabilities: 0b011n }, // missing bit 0b100
      onTask: (t) => {
        surfaced.push(t);
      },
      pollIntervalMs: 20,
    });
    // Let at least two sweeps run, then stop.
    await new Promise((r) => {
      setTimeout(r, 90);
    });
    await watch.stop();

    expect(surfaced).toHaveLength(0);
  });

  // REVERT-SENSITIVE (#4): a REAL on-chain Open task whose job spec is NOT
  // pinned must NOT be surfaced — claiming it would fail AccountNotInitialized
  // (3012). Against the pre-fix Open-only predicate this task is wrongly
  // surfaced. Here we leave set_task_job_spec OUT, so the task stays unpinned.
  it("does NOT surface a real Open-but-unpinned task (claim would fail 3012)", async () => {
    const market = await startLocalMarketplace();
    const creator = await market.fundedSigner();
    const creatorClient = market.clientFor(creator);

    const creatorAgentId = new Uint8Array(32).fill(221);
    await creatorClient.registerAgent({
      authority: creator,
      agentId: creatorAgentId,
      capabilities: 1n,
      endpoint: "http://creator3.test",
      metadataUri: null,
      stakeAmount: 0n,
    });
    const [creatorAgent] = await findAgentPda({ agentId: creatorAgentId });

    const taskId = new Uint8Array(32).fill(222);
    const now = market.svm.getClock().unixTimestamp;
    await creatorClient.send([
      await facade.createTask({
        authority: creator,
        creator,
        creatorAgent,
        taskId,
        requiredCapabilities: 1n,
        description: new Uint8Array(64).fill(9, 0, 32),
        rewardAmount: 4_000_000n,
        maxWorkers: 1,
        deadline: now + 3600n,
        taskType: 0,
        constraintHash: null,
        minReputation: 0,
        rewardMintArg: null,
      }),
    ]);
    const [taskPda] = await findTaskPda({ creator: creator.address, taskId });

    // Sanity: the task is Open on-chain, but NO task_job_spec PDA exists.
    expect(market.svm.getAccount(taskPda)?.exists).toBe(true);
    const [taskJobSpecPda] = await findTaskJobSpecPda({ task: taskPda });
    expect(market.svm.getAccount(taskJobSpecPda)?.exists ?? false).toBe(false);

    // Register both the task AND the (absent) job-spec PDA, so the watch's
    // job-spec gPA scan has every chance to find a pin — there just isn't one.
    const sim = new GpaSimulator(market.svm);
    sim.register(taskPda, taskJobSpecPda);

    const surfaced: ClaimableTask[] = [];
    const watch = watchClaimableTasks({
      indexer: sim,
      filter: { capabilities: 1n, minReward: 1n },
      onTask: (t) => {
        surfaced.push(t);
      },
      pollIntervalMs: 20,
    });
    // Several sweeps — an Open-only predicate would surface it on the first.
    await new Promise((r) => setTimeout(r, 90));
    await watch.stop();

    expect(surfaced.filter((t) => t.task === taskPda)).toHaveLength(0);
  });
});
