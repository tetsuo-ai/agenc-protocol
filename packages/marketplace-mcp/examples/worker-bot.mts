/**
 * P5.3 worker-bot example — claim a fresh task within SECONDS of creation, with
 * NO hand-tuned poll loop.
 *
 * A worker agent should not have to write a bespoke `setInterval` over
 * `getProgramAccounts`. The SDK's `watchClaimableTasks` fuses the live
 * `TaskCreated` event stream with periodic catch-up sweeps, de-dupes by Task
 * PDA, applies the worker's eligibility filter, and hands each newly-claimable
 * task to one `onTask` callback. This bot:
 *
 *   1. boots the REAL compiled agenc-coordination program in litesvm
 *      (`startLocalMarketplace` — the local stack, no validator/RPC/keys),
 *   2. registers a worker agent,
 *   3. starts `watchClaimableTasks` with the worker's capability filter,
 *   4. a creator THEN creates + attests + job-spec-pins a task,
 *   5. the watch surfaces it within the first sweep, and the bot CLAIMS it,
 *   6. we assert the task is now InProgress (the claim landed).
 *
 * Run: `npx tsx examples/worker-bot.mts` (or `node --import tsx examples/worker-bot.mts`).
 * The whole thing is in-process and deterministic; it exits non-zero on failure.
 *
 * NOTE on transports: litesvm exposes no WebSocket `logsNotifications`, so this
 * example drives the CATCH-UP sweep path (a litesvm-backed gPA source) — the
 * exact fallback every HTTP-only worker relies on when no rpcSubscriptions is
 * available. Against a real RPC you would pass `{ rpcSubscriptions, rpc }` for
 * sub-second live notification; the bot code below is otherwise identical.
 */
import { strict as assert } from "node:assert";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  facade,
  findAgentPda,
  findTaskPda,
  findTaskJobSpecPda,
  getTaskDecoder,
  TaskStatus,
  watchClaimableTasks,
} from "@tetsuo-ai/marketplace-sdk";
import type {
  ClaimableTask,
  GpaFilter,
  ProgramAccountsTransport,
} from "@tetsuo-ai/marketplace-sdk";
import { startLocalMarketplace } from "@tetsuo-ai/marketplace-sdk/testing";
import type { Address } from "@solana/kit";
import type { LiteSVM } from "litesvm";

// --- a litesvm-backed getProgramAccounts source (catch-up read path) ---------
// litesvm has no gPA, so we register the addresses the local world created and
// scan them with exact RPC memcmp/dataSize semantics scoped to the program.
class LiteSvmGpa implements ProgramAccountsTransport {
  readonly #svm: LiteSVM;
  readonly #addresses = new Set<Address>();
  constructor(svm: LiteSVM) {
    this.#svm = svm;
  }
  register(...addresses: Address[]): this {
    for (const a of addresses) this.#addresses.add(a);
    return this;
  }
  async getProgramAccounts({ filters }: { filters: readonly GpaFilter[] }) {
    const out: Array<{ address: Address; data: Uint8Array }> = [];
    for (const address of this.#addresses) {
      const acct = this.#svm.getAccount(address);
      if (!acct || !acct.exists) continue;
      if (acct.programAddress !== AGENC_COORDINATION_PROGRAM_ADDRESS) continue;
      const data = Uint8Array.from(acct.data);
      const ok = filters.every((f) =>
        "dataSize" in f
          ? data.length === f.dataSize
          : f.memcmp.offset + f.memcmp.bytes.length <= data.length &&
            f.memcmp.bytes.every((b, i) => data[f.memcmp.offset + i] === b),
      );
      if (ok) out.push({ address, data });
    }
    return out;
  }
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const market = await startLocalMarketplace();

  // --- the WORKER: register an agent with capability bit 0b1 ---
  const worker = await market.fundedSigner();
  const workerClient = market.clientFor(worker);
  const workerAgentId = new Uint8Array(32).fill(101);
  await workerClient.registerAgent({
    authority: worker,
    agentId: workerAgentId,
    capabilities: 0b1n,
    endpoint: "http://worker.test",
    metadataUri: null,
    stakeAmount: 0n,
  });
  const [workerAgent] = await findAgentPda({ agentId: workerAgentId });

  // The catch-up gPA source the watch sweeps. The creator below registers each
  // new task PDA so the worker can discover it (a real RPC would index it
  // automatically).
  const gpa = new LiteSvmGpa(market.svm);

  // --- start watching BEFORE the task exists; claim the first match ---
  const claimed: ClaimableTask[] = [];
  let resolveClaimed!: (t: ClaimableTask) => void;
  const firstClaim = new Promise<ClaimableTask>((r) => (resolveClaimed = r));

  const watch = watchClaimableTasks({
    indexer: gpa, // catch-up read source (litesvm has no rpcSubscriptions)
    filter: { capabilities: 0b1n, minReward: 1n }, // worker eligibility
    pollIntervalMs: 50, // tight sweep so "within seconds" is honest, still not hand-tuned
    onTask: async (task) => {
      // The watch only surfaces "Open AND job-spec pinned" tasks, so this claim
      // is expected to land. Still, claims race (another worker, an expired
      // deadline, a same-block re-org), so a worker bot must TOLERATE a failed
      // claim rather than crash — catch it, log it, and keep watching for the
      // next task instead of letting the rejection tear down the watch.
      try {
        await workerClient.claimTaskWithJobSpec({
          task: task.task,
          worker: workerAgent,
          authority: worker,
        });
      } catch (err) {
        console.warn(
          `[worker-bot] claim of ${task.task} failed (lost the race or no longer ` +
            `claimable) — skipping:`,
          err instanceof Error ? err.message : err,
        );
        return; // keep watching; do not resolve on a failed claim
      }
      claimed.push(task);
      resolveClaimed(task);
    },
    onError: (err) => {
      console.error("[worker-bot] watch error:", err);
    },
  });

  // --- the CREATOR: create + attest + pin a job spec on a fresh Open task ----
  const creator = await market.fundedSigner();
  const creatorClient = market.clientFor(creator);
  const creatorAgentId = new Uint8Array(32).fill(201);
  await creatorClient.registerAgent({
    authority: creator,
    agentId: creatorAgentId,
    capabilities: 0b1n,
    endpoint: "http://creator.test",
    metadataUri: null,
    stakeAmount: 0n,
  });
  const [creatorAgent] = await findAgentPda({ agentId: creatorAgentId });

  const taskId = new Uint8Array(32).fill(202);
  const reward = 3_000_000n;
  const now = market.svm.getClock().unixTimestamp;
  const tCreate = Date.now();
  await creatorClient.send([
    await facade.createTask({
      authority: creator,
      creator,
      creatorAgent,
      taskId,
      requiredCapabilities: 0b1n,
      description: new Uint8Array(64).fill(7),
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

  // Attest + pin the job spec (claim is gated on both). In production the
  // marketplace moderator does the attestation; here the sandbox moderator
  // records the CLEAN attestation.
  const jobSpecHash = new Uint8Array(32).fill(55);
  await market.moderator.attestTask(taskPda, jobSpecHash);
  await creatorClient.send([
    await facade.setTaskJobSpec({
      task: taskPda,
      creator,
      jobSpecHash,
      jobSpecUri: "agenc://job-spec/sha256/worker-bot",
    }),
  ]);

  // Make the new task AND its pinned job-spec PDA discoverable to the catch-up
  // sweep. The watch confirms the job-spec pin (the on-chain claim precondition)
  // before surfacing a task, so the sweep must be able to see the
  // ["task_job_spec", task] account — a real RPC indexes it automatically; here
  // we register it explicitly alongside the task. (Registering BOTH only after
  // the pin lands is what makes this an honest end-to-end test: the bot never
  // sees an Open-but-unpinned task.)
  const [taskJobSpecPda] = await findTaskJobSpecPda({ task: taskPda });
  gpa.register(taskPda, taskJobSpecPda);

  // --- wait for the bot to surface AND claim it, with a hard timeout ---
  const claimable = await Promise.race([
    firstClaim,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("worker-bot: no claimable task within 5s")),
        5000,
      ),
    ),
  ]);
  await watch.stop();

  const sinceCreate = Date.now() - tCreate;
  const total = Date.now() - t0;

  // --- ASSERT the claim landed: the task is now InProgress on-chain ----------
  assert.equal(claimable.task, taskPda, "surfaced the wrong task");
  assert.equal(claimable.source, "catch-up", "expected the catch-up read path");
  const acct = market.svm.getAccount(taskPda);
  assert.ok(acct?.exists, "task account vanished");
  const decoded = getTaskDecoder().decode(Uint8Array.from(acct.data));
  assert.equal(
    decoded.status,
    TaskStatus.InProgress,
    `expected InProgress after claim, got ${TaskStatus[decoded.status]}`,
  );
  assert.equal(claimed.length, 1, "expected exactly one claim");
  assert.ok(
    sinceCreate < 5000,
    `claim took ${sinceCreate}ms — expected within seconds`,
  );

  console.log(
    `[worker-bot] OK — surfaced + claimed ${taskPda} ${sinceCreate}ms after ` +
      `creation (no hand-tuned poll loop); task is now InProgress. ` +
      `Total runtime ${total}ms.`,
  );
}

main().catch((error: unknown) => {
  console.error(
    "[worker-bot] FAILED:",
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exit(1);
});
