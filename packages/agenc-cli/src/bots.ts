// `agenc dev`'s bot loop core — the localnet-first-hire flow (WP-D4),
// generalized and dependency-injected so the SAME code runs against the real
// localnet stack (the CLI) and litesvm (the e2e suite):
//
//   provider registers an agent + lists the project's service (with an
//   OPERATOR + fee) -> moderator attests the listing CLEAN -> a buyer bot
//   `hireAndActivate`s the listing (with a REFERRER + fee, so the split is
//   genuinely 4-way) -> a worker bot (the @tetsuo-ai/agenc-worker runtime,
//   reused programmatically with a stub executor) claims + submits -> the
//   buyer accepts -> the settlement deltas are read from the chain.
//
// LOCALNET/LITESVM ONLY. Throwaway keys. Never real funds.
import type { Address, KeyPairSigner } from "@solana/kit";
import {
  facade,
  findAgentPda,
  findHireRecordPda,
  findModerationConfigPda,
  findProtocolConfigPda,
  findTaskJobSpecPda,
  findTaskModerationPda,
  getModerationConfigDecoder,
  getProtocolConfigDecoder,
  getTaskDecoder,
  hireAndActivate,
  TaskStatus,
  values,
  type MarketplaceClient,
  type ProgramAccountsSource,
} from "@tetsuo-ai/marketplace-sdk";
import {
  bytesToHex,
  emptyState,
  newAgentId,
  runTickOnce,
  saveState,
  type AccountInfoReader,
  type WorkerContext,
  type WorkerLogEvent,
} from "@tetsuo-ai/agenc-worker";
import type { SettlementLeg } from "./split.js";

/** One side of the marketplace: a funded signer + its SDK client. */
export interface DevActor {
  client: MarketplaceClient;
  signer: KeyPairSigner;
}

export interface DevListingTerms {
  name: string;
  category: string;
  tags: string[];
  priceLamports: bigint;
  operatorFeeBps: number;
  referrerFeeBps: number;
}

export interface DevLoopDeps {
  /** Buyer bot (hires + accepts). */
  buyer: DevActor;
  /** Provider/worker bot (lists, claims, submits). */
  provider: DevActor;
  /** The cluster's global moderation authority (attests CLEAN directly). */
  moderator: DevActor;
  /** Operator payee wallet (must be rent-exempt-funded). */
  operator: Address;
  /** Referrer payee wallet (must be rent-exempt-funded). */
  referrer: Address;
  /** Raw account reader (localnet RPC or litesvm). */
  readAccount: (address: Address) => Promise<Uint8Array | null>;
  /** Ownership/executable-aware account reader for canonical PDA classification. */
  readAccountInfo: AccountInfoReader;
  /** Lamport balance reader. */
  getBalance: (address: Address) => Promise<bigint>;
  /** Live cluster rent lookup used by the worker's fail-closed claim gate. */
  getMinimumBalanceForRentExemption: (space: number) => Promise<bigint>;
  /** getProgramAccounts source for the worker bot's sweep. */
  gpa: ProgramAccountsSource;
  /** Scratch dir for the worker bot's state files. */
  stateDir: string;
  log: (line: string) => void;
  listing: DevListingTerms;
  /**
   * litesvm has no getProgramAccounts, so its GPA simulator must be told
   * which addresses exist; the real RPC path leaves this undefined.
   */
  registerGpaAddress?: (...addresses: Address[]) => void;
  /** Poll cadence for on-chain state waits (default 400ms). */
  pollIntervalMs?: number;
  /** Per-wait timeout (default 90s). */
  timeoutMs?: number;
}

export interface DevLoopResult {
  task: Address;
  listing: Address;
  providerAgent: Address;
  rewardLamports: bigint;
  hireSignature: string;
  acceptSignature: string;
  /** Raw lamport deltas across the settlement transaction. */
  legs: {
    worker: SettlementLeg;
    operator: SettlementLeg;
    referrer: SettlementLeg;
    treasury: SettlementLeg;
  };
  /**
   * The worker's cut OF THE REWARD (reward minus the three fee legs). The raw
   * worker delta is larger: settlement also closes the worker's
   * claim/submission accounts back to it — that rent portion is
   * {@link workerRentRefundLamports}.
   */
  workerRewardCutLamports: bigint;
  workerRentRefundLamports: bigint;
  durationMs: number;
}

const CLEAN_ATTESTATION = {
  status: 0, // CLEAN
  riskScore: 0,
  categoryMask: 0n,
  policyHash: new Uint8Array(32),
  scannerHash: new Uint8Array(32),
  expiresAt: 0n,
} as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  what: string,
  poll: () => Promise<T | null>,
  pollIntervalMs: number,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await poll();
    if (value !== null) return value;
    if (Date.now() >= deadline) {
      throw new Error(`${what} did not happen within ${timeoutMs}ms`);
    }
    await sleep(pollIntervalMs);
  }
}

/** Worker-bot log passthrough: surface the interesting events, drop noise. */
function workerLogLine(
  log: (line: string) => void,
): (event: WorkerLogEvent) => void {
  const interesting = new Set([
    "task.claimed",
    "task.submitted",
    "task.claim-failed",
    "task.execution-failed",
    "task.job-spec-rejected",
    "settlement.observed",
  ]);
  return (event) => {
    if (interesting.has(event.event)) {
      const { event: name, ...rest } = event;
      log(`worker bot: ${name} ${JSON.stringify(rest)}`);
    }
  };
}

/**
 * Run the full counterparty-bot loop once and return the settled 4-way
 * split, measured as REAL lamport deltas around the accept transaction.
 */
export async function runDevLoop(deps: DevLoopDeps): Promise<DevLoopResult> {
  const startedAt = Date.now();
  const pollIntervalMs = deps.pollIntervalMs ?? 400;
  const timeoutMs = deps.timeoutMs ?? 90_000;
  const { log } = deps;

  // ---- 0) cluster config: stake floor, treasury, moderation authority ----
  const [protocolConfigPda] = await findProtocolConfigPda();
  const protocolConfigBytes = await deps.readAccount(protocolConfigPda);
  if (protocolConfigBytes === null) {
    throw new Error(
      `ProtocolConfig ${protocolConfigPda} not found — the sandbox program is ` +
        `not initialized (did scripts/localnet-up.mjs finish?)`,
    );
  }
  const protocolConfig = getProtocolConfigDecoder().decode(protocolConfigBytes);
  const treasury = protocolConfig.treasury;

  const [moderationConfigPda] = await findModerationConfigPda();
  const moderationConfigBytes = await deps.readAccount(moderationConfigPda);
  if (moderationConfigBytes === null) {
    throw new Error(
      `ModerationConfig ${moderationConfigPda} not found — the moderation ` +
        `gate is not configured on this sandbox`,
    );
  }
  const moderationAuthority = getModerationConfigDecoder().decode(
    moderationConfigBytes,
  ).moderationAuthority;
  if (moderationAuthority !== deps.moderator.signer.address) {
    throw new Error(
      `moderator keypair ${deps.moderator.signer.address} is not the on-chain ` +
        `moderation authority (${moderationAuthority}) — its attestations ` +
        `would not pass the fail-closed hire gate`,
    );
  }
  const moderator = moderationAuthority;

  // ---- 1) provider bot: register agent + list the project's service ----
  const agentId = newAgentId();
  await deps.provider.client.registerAgent({
    authority: deps.provider.signer,
    agentId,
    capabilities: 1n,
    endpoint: "https://example.invalid/agenc-dev/worker-bot",
    metadataUri: null,
    stakeAmount: protocolConfig.minAgentStake,
  });
  const [providerAgent] = await findAgentPda({ agentId });
  log(`provider bot: registered agent ${providerAgent}`);

  const listingId = values.randomId32();
  const listingSpecHash = await values.descriptionHash(
    `agenc dev listing for ${deps.listing.name}`,
  );
  await deps.provider.client.createServiceListing({
    providerAgent,
    authority: deps.provider.signer,
    listingId,
    // Config parsing already validates the fixed-width metadata by UTF-8 byte
    // length; never truncate by JavaScript code units here.
    name: deps.listing.name,
    category: deps.listing.category as Parameters<
      typeof deps.provider.client.createServiceListing
    >[0]["category"],
    tags: deps.listing.tags,
    specHash: listingSpecHash,
    specUri: `agenc://job-spec/sha256/${values.bytesToHex(listingSpecHash)}`,
    price: deps.listing.priceLamports,
    priceMint: null,
    requiredCapabilities: 1n,
    defaultDeadlineSecs: 3600n,
    maxOpenJobs: 0,
    operator: deps.operator, // the 3rd leg of the split
    operatorFeeBps: deps.listing.operatorFeeBps,
  });
  const [listing] = await facade.findListingPda({ providerAgent, listingId });
  log(
    `provider bot: listed "${deps.listing.name}" at ${listing} ` +
      `(${deps.listing.priceLamports} lamports, operator fee ${deps.listing.operatorFeeBps} bps)`,
  );

  // ---- 2) moderator bot: attest the listing CLEAN (fail-closed hire gate) --
  await deps.moderator.client.send([
    await facade.recordListingModeration({
      moderator: deps.moderator.signer,
      listing,
      jobSpecHash: listingSpecHash,
      ...CLEAN_ATTESTATION,
    }),
  ]);
  const [listingModeration] = await facade.findListingModerationPda({
    listing,
    jobSpecHash: listingSpecHash,
    moderator,
  });
  await waitFor(
    `ListingModeration ${listingModeration}`,
    () => deps.readAccount(listingModeration),
    pollIntervalMs,
    timeoutMs,
  );
  log("moderator bot: listing attested CLEAN");

  // ---- 3) buyer bot: hireAndActivate (WP-D6, the blessed hire path) with a
  // REFERRER so the settlement split is genuinely 4-way.
  const jobSpecInstructions = `agenc dev job spec for ${deps.listing.name}: run the demo deliverable`;
  const jobSpecPayload = { instructions: jobSpecInstructions };
  const jobSpecDigest = await values.canonicalJobSpecHash(jobSpecPayload);
  const jobSpecHash = jobSpecDigest.bytes;
  const jobSpecUri = `agenc://job-spec/sha256/${values.bytesToHex(jobSpecHash)}`;
  const jobSpecEnvelope = new TextEncoder().encode(
    JSON.stringify({
      integrity: {
        algorithm: "sha256",
        canonicalization: "json-stable-v1",
        payloadHash: jobSpecDigest.hex,
      },
      payload: jobSpecPayload,
    }),
  );
  const hireResult = await hireAndActivate(deps.buyer.client, {
    hire: {
      listing,
      providerAgent,
      taskId: values.randomId32(),
      expectedPrice: deps.listing.priceLamports,
      expectedVersion: 1n,
      reviewWindowSecs: 3600n,
      listingSpecHash,
      taskJobSpecHash: jobSpecHash,
      moderator,
      referrer: deps.referrer, // the 4th leg
      referrerFeeBps: deps.listing.referrerFeeBps,
    },
    jobSpec: { instructions: jobSpecInstructions },
    hostAndModerateJobSpec: async (host) => {
      await deps.moderator.client.send([
        await facade.recordTaskModeration({
          moderator: deps.moderator.signer,
          task: host.taskPda,
          jobSpecHash,
          ...CLEAN_ATTESTATION,
        }),
      ]);
      const [taskModeration] = await findTaskModerationPda({
        task: host.taskPda,
        jobSpecHash,
        moderator,
      });
      await waitFor(
        `TaskModeration ${taskModeration}`,
        () => deps.readAccount(taskModeration),
        pollIntervalMs,
        timeoutMs,
      );
      return { jobSpecHash, jobSpecUri, moderationAttested: true, moderator };
    },
  });
  const task = hireResult.taskPda;
  log(
    `buyer bot: hired + activated -> task ${task} ` +
      `(referrer fee ${deps.listing.referrerFeeBps} bps, hire sig ${hireResult.hireSignature})`,
  );

  // litesvm's GPA simulator must learn the new accounts; a real RPC doesn't.
  if (deps.registerGpaAddress !== undefined) {
    const [taskJobSpec] = await findTaskJobSpecPda({ task });
    deps.registerGpaAddress(task, taskJobSpec);
  }

  // ---- 4) worker bot: the REAL @tetsuo-ai/agenc-worker runtime, reused
  // programmatically. The agent is pre-registered above because its PDA is the
  // provider identity used by the listing and hire created earlier in this
  // scenario. Seed the runtime state with that same agent id, then run a sweep
  // tick: claim -> execute (stub executor) -> submit.
  const workerState = emptyState();
  workerState.agentIdHex = bytesToHex(agentId);
  saveState(deps.stateDir, workerState);
  const workerCtx: WorkerContext = {
    config: {
      capabilities: 1n,
      minRewardLamports: 0n,
      maxRewardLamports: null,
      allowUnboundedReward: true,
      // Stub executor: a real spawned process (node -e) that prints the
      // deliverable — the same seam a real coding-agent CLI plugs into.
      executor: [
        process.execPath,
        "-e",
        'console.log("agenc dev stub deliverable: done")',
        "{prompt}",
      ],
      executorMode: "unsafe",
      executorEnvAllowlist: [],
      resultUploader: null,
      creatorAllowlist: [deps.buyer.signer.address], // only work for our buyer bot
      allowAnyCreator: false,
      endpoint: "https://example.invalid/agenc-dev/worker-bot",
      executorTimeoutMs: 60_000,
      pollIntervalMs: 1_000,
    },
    client: deps.provider.client,
    signer: deps.provider.signer,
    gpa: deps.gpa,
    readAccount: deps.readAccount,
    readAccountInfo: deps.readAccountInfo,
    getBalance: deps.getBalance,
    getMinimumBalanceForRentExemption: deps.getMinimumBalanceForRentExemption,
    resolveAgencUri: async (uri) => {
      if (uri !== jobSpecUri) {
        throw new Error(`unknown sandbox job-spec URI: ${uri}`);
      }
      return jobSpecEnvelope;
    },
    stateDir: deps.stateDir,
    log: workerLogLine(log),
  };
  await waitFor(
    "worker bot claim + submit",
    async () => {
      const tick = await runTickOnce(workerCtx);
      if (tick.outcome?.status === "submitted" && tick.outcome.task === task) {
        return tick.outcome;
      }
      if (
        tick.outcome?.status === "execution-failed" ||
        tick.outcome?.status === "claim-failed"
      ) {
        throw new Error(
          `worker bot ${tick.outcome.status} on ${tick.outcome.task}: ${tick.outcome.reason}`,
        );
      }
      return null; // task not visible to the sweep yet — retry
    },
    Math.max(pollIntervalMs, 750),
    timeoutMs,
  );
  log(
    "worker bot: claimed, executed (stub), submitted — task PendingValidation",
  );

  await waitFor(
    `task ${task} PendingValidation`,
    async () => {
      const bytes = await deps.readAccount(task);
      if (bytes === null) return null;
      return getTaskDecoder().decode(bytes).status ===
        TaskStatus.PendingValidation
        ? true
        : null;
    },
    pollIntervalMs,
    timeoutMs,
  );

  // ---- 5) balance snapshots, then the buyer accepts (Task Validation V2
  // settlement). The accept tx is fee-paid by the BUYER, so the deltas on
  // worker/operator/referrer/treasury are pure settlement legs.
  const payees = {
    worker: deps.provider.signer.address,
    operator: deps.operator,
    referrer: deps.referrer,
    treasury,
  };
  const before = {
    worker: await deps.getBalance(payees.worker),
    operator: await deps.getBalance(payees.operator),
    referrer: await deps.getBalance(payees.referrer),
    treasury: await deps.getBalance(payees.treasury),
  };

  const [hireRecord] = await findHireRecordPda({ task });
  const accept = await deps.buyer.client.acceptTaskResult({
    task,
    worker: providerAgent,
    creator: deps.buyer.signer,
    treasury,
    workerAuthority: payees.worker,
    operator: payees.operator,
    referrer: payees.referrer,
    hireRecord,
  });
  await waitFor(
    `task ${task} Completed`,
    async () => {
      const bytes = await deps.readAccount(task);
      if (bytes === null) return null;
      return getTaskDecoder().decode(bytes).status === TaskStatus.Completed
        ? true
        : null;
    },
    pollIntervalMs,
    timeoutMs,
  );
  log(`buyer bot: accepted — escrow settled (sig ${accept.signature})`);

  const legs = {
    worker: {
      label: "worker",
      address: payees.worker as string,
      deltaLamports: (await deps.getBalance(payees.worker)) - before.worker,
    },
    operator: {
      label: "operator",
      address: payees.operator as string,
      deltaLamports: (await deps.getBalance(payees.operator)) - before.operator,
    },
    referrer: {
      label: "referrer",
      address: payees.referrer as string,
      deltaLamports: (await deps.getBalance(payees.referrer)) - before.referrer,
    },
    treasury: {
      label: "protocol treasury",
      address: payees.treasury as string,
      deltaLamports: (await deps.getBalance(payees.treasury)) - before.treasury,
    },
  };

  const workerRewardCutLamports =
    deps.listing.priceLamports -
    legs.operator.deltaLamports -
    legs.referrer.deltaLamports -
    legs.treasury.deltaLamports;
  const workerRentRefundLamports =
    legs.worker.deltaLamports > workerRewardCutLamports
      ? legs.worker.deltaLamports - workerRewardCutLamports
      : 0n;

  return {
    task,
    listing,
    providerAgent,
    rewardLamports: deps.listing.priceLamports,
    hireSignature: hireResult.hireSignature,
    acceptSignature: accept.signature,
    legs,
    workerRewardCutLamports,
    workerRentRefundLamports,
    durationMs: Date.now() - startedAt,
  };
}
