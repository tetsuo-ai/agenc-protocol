// Registration reads the LIVE ProtocolConfig.minAgentStake and stakes exactly
// that (0.1.0 hardcoded 0n, which reverted with InsufficientStake on mainnet
// where the minimum is 10,000,000 lamports), and the funding preflight rejects
// an underfunded wallet with one clear message BEFORE any transaction.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { address, type Address, type TransactionSigner } from "@solana/kit";
import {
  AgentStatus,
  findAgentPda,
  findProtocolConfigPda,
  getAgentRegistrationEncoder,
  getProtocolConfigEncoder,
  type MarketplaceClient,
} from "@tetsuo-ai/marketplace-sdk";
import {
  AGENT_ACCOUNT_RENT_LAMPORTS,
  CLAIM_ACCOUNT_RENT_LAMPORTS,
  ensureRegistered,
  FEE_HEADROOM_LAMPORTS,
  readMinAgentStake,
  registrationFundingRequirement,
  SUBMISSION_ACCOUNT_RENT_LAMPORTS,
  type WorkerContext,
  type WorkerLogEvent,
} from "../src/runtime.js";
import { bytesToHex, saveState, emptyState } from "../src/state.js";

const WALLET = address("7Y9dRMi8ZtyDjLdSpzUCsxDgHooZTfp3RyYs2eZWmL39");
const OTHER = address("F1qYyDAYYS1sLxq5nDprfNknnwGPo7ssyKvhScv6f8Uc");
const DEFAULT_ADDR = address("11111111111111111111111111111111");

/** The live mainnet minimum at the time of the 0.1.0→0.1.1 fix. */
const MAINNET_MIN_STAKE = 10_000_000n;

function protocolConfigData(minAgentStake: bigint): Uint8Array {
  return new Uint8Array(
    getProtocolConfigEncoder().encode({
      authority: OTHER,
      treasury: OTHER,
      disputeThreshold: 50,
      protocolFeeBps: 500,
      minArbiterStake: 0n,
      minAgentStake,
      maxClaimDuration: 604800n,
      maxDisputeDuration: 604800n,
      totalAgents: 0n,
      totalTasks: 0n,
      completedTasks: 0n,
      totalValueDistributed: 0n,
      bump: 255,
      multisigThreshold: 0,
      multisigOwnersLen: 0,
      taskCreationCooldown: 0n,
      maxTasksPer24h: 0,
      disputeInitiationCooldown: 0n,
      maxDisputesPer24h: 0,
      minStakeForDispute: 0n,
      slashPercentage: 50,
      stateUpdateCooldown: 0n,
      votingPeriod: 86400n,
      protocolVersion: 1,
      minSupportedVersion: 1,
      protocolPaused: false,
      disabledTaskTypeMask: 0,
      surfaceRevision: 2,
      multisigOwners: [DEFAULT_ADDR, DEFAULT_ADDR, DEFAULT_ADDR, DEFAULT_ADDR, DEFAULT_ADDR],
    }),
  );
}

function agentRegistrationData(authority: Address, agentId: Uint8Array): Uint8Array {
  return new Uint8Array(
    getAgentRegistrationEncoder().encode({
      agentId,
      authority,
      capabilities: 1n,
      status: AgentStatus.Active,
      endpoint: "https://agenc.ag/worker",
      metadataUri: "",
      registeredAt: 0n,
      lastActive: 0n,
      tasksCompleted: 0n,
      totalEarned: 0n,
      reputation: 3000,
      activeTasks: 0,
      stake: MAINNET_MIN_STAKE,
      bump: 255,
      lastTaskCreated: 0n,
      lastDisputeInitiated: 0n,
      taskCount24h: 0,
      disputeCount24h: 0,
      rateLimitWindowStart: 0n,
      activeDisputeVotes: 0,
      lastVoteTimestamp: 0n,
      lastStateUpdate: 0n,
      disputesAsDefendant: 0,
      reserved: new Uint8Array(4),
    }),
  );
}

type RegistrationHarness = {
  ctx: WorkerContext;
  registerAgent: ReturnType<typeof vi.fn>;
  events: WorkerLogEvent[];
  agentId: Uint8Array;
};

/**
 * A fresh-agent context: the persisted agent id has no on-chain account, the
 * ProtocolConfig account is readable (unless overridden), and the only
 * chain-write surface is a mocked `client.registerAgent`.
 */
async function registrationHarness(options: {
  minAgentStake?: bigint;
  configData?: Uint8Array | null;
  balance?: bigint;
  getBalance?: false;
  dryRun?: boolean;
}): Promise<RegistrationHarness> {
  const agentId = new Uint8Array(32).fill(42);
  const stateDir = mkdtempSync(path.join(tmpdir(), "agenc-worker-runtime-"));
  const state = emptyState();
  state.agentIdHex = bytesToHex(agentId);
  saveState(stateDir, state);

  const [configPda] = await findProtocolConfigPda();
  const configData =
    options.configData !== undefined
      ? options.configData
      : protocolConfigData(options.minAgentStake ?? MAINNET_MIN_STAKE);

  const registerAgent = vi.fn(async () => ({ signature: "sig-register" }));
  const events: WorkerLogEvent[] = [];
  const ctx: WorkerContext = {
    config: {
      capabilities: 1n,
      minRewardLamports: 0n,
      maxRewardLamports: null,
      executor: ["true", "{prompt}"],
      resultUploader: null,
      creatorAllowlist: null,
      endpoint: "https://agenc.ag/worker",
      executorTimeoutMs: 60_000,
      pollIntervalMs: 1_000,
    },
    client: { registerAgent } as unknown as MarketplaceClient,
    signer: { address: WALLET } as TransactionSigner,
    gpa: { getProgramAccounts: async () => [] } as never,
    readAccount: async (addr: Address) => (addr === configPda ? configData : null),
    stateDir,
    log: (event) => events.push(event),
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    ...(options.getBalance === false
      ? {}
      : { getBalance: async () => options.balance ?? 1_000_000_000n }),
  };
  return { ctx, registerAgent, events, agentId };
}

describe("readMinAgentStake", () => {
  it("returns the live on-chain minimum", async () => {
    const [configPda] = await findProtocolConfigPda();
    const data = protocolConfigData(MAINNET_MIN_STAKE);
    const min = await readMinAgentStake(async (addr) =>
      addr === configPda ? data : null,
    );
    expect(min).toBe(MAINNET_MIN_STAKE);
  });

  it("errors clearly when the ProtocolConfig is unreadable — never guesses", async () => {
    await expect(readMinAgentStake(async () => null)).rejects.toThrow(
      /ProtocolConfig .*not found.*refusing to guess/s,
    );
  });
});

describe("registrationFundingRequirement", () => {
  it("sums stake + agent/claim/submission rents + fee headroom (~0.021 SOL on mainnet)", () => {
    const required = registrationFundingRequirement(MAINNET_MIN_STAKE);
    expect(required).toBe(
      MAINNET_MIN_STAKE +
        AGENT_ACCOUNT_RENT_LAMPORTS +
        CLAIM_ACCOUNT_RENT_LAMPORTS +
        SUBMISSION_ACCOUNT_RENT_LAMPORTS +
        FEE_HEADROOM_LAMPORTS,
    );
    expect(required).toBe(20_924_960n);
  });
});

describe("ensureRegistered (fresh agent)", () => {
  it("stakes EXACTLY the live minAgentStake (0.1.0 hardcoded 0n and reverted on mainnet)", async () => {
    const { ctx, registerAgent, events } = await registrationHarness({
      minAgentStake: MAINNET_MIN_STAKE,
    });
    const agent = await ensureRegistered(ctx);
    expect(agent.justRegistered).toBe(true);
    expect(registerAgent).toHaveBeenCalledTimes(1);
    expect(registerAgent.mock.calls[0]![0]).toMatchObject({
      stakeAmount: MAINNET_MIN_STAKE,
    });
    const registered = events.find((e) => e.event === "agent.registered");
    expect(registered?.stakedLamports).toBe(MAINNET_MIN_STAKE.toString());
  });

  it("fails registration when the ProtocolConfig cannot be read — no transaction is sent", async () => {
    const { ctx, registerAgent } = await registrationHarness({ configData: null });
    await expect(ensureRegistered(ctx)).rejects.toThrow(/refusing to guess/);
    expect(registerAgent).not.toHaveBeenCalled();
  });

  it("funding preflight REJECTS an underfunded wallet before any transaction, naming the exact lamports and address", async () => {
    const balance = 1_000_000n;
    const { ctx, registerAgent } = await registrationHarness({
      minAgentStake: MAINNET_MIN_STAKE,
      balance,
    });
    const required = registrationFundingRequirement(MAINNET_MIN_STAKE);
    const error = await ensureRegistered(ctx).then(
      () => null,
      (e: Error) => e,
    );
    expect(error).not.toBeNull();
    expect(error!.message).toContain("insufficient funds");
    expect(error!.message).toContain(WALLET);
    expect(error!.message).toContain(`${required} lamports`);
    expect(error!.message).toContain(`${required - balance} more lamports`);
    expect(registerAgent).not.toHaveBeenCalled();
  });

  it("funding preflight passes at exactly the requirement", async () => {
    const { ctx, registerAgent } = await registrationHarness({
      minAgentStake: MAINNET_MIN_STAKE,
      balance: registrationFundingRequirement(MAINNET_MIN_STAKE),
    });
    const agent = await ensureRegistered(ctx);
    expect(agent.registered).toBe(true);
    expect(registerAgent).toHaveBeenCalledTimes(1);
  });

  it("dry-run signs nothing and needs no funds or config read", async () => {
    const { ctx, registerAgent, events } = await registrationHarness({
      configData: null, // even an unreadable config must not break a preview
      balance: 0n,
      dryRun: true,
    });
    const agent = await ensureRegistered(ctx);
    expect(agent.registered).toBe(false);
    expect(registerAgent).not.toHaveBeenCalled();
    expect(events.some((e) => e.event === "agent.would-register")).toBe(true);
  });
});

describe("ensureRegistered (already registered)", () => {
  it("skips the stake read and preflight entirely — an existing worker keeps running", async () => {
    const harness = await registrationHarness({
      configData: null, // unreadable config must not matter here
      balance: 0n, // nor an empty wallet
    });
    const [agentPda] = await findAgentPda({ agentId: harness.agentId });
    const registration = agentRegistrationData(WALLET, harness.agentId);
    harness.ctx.readAccount = async (addr: Address) =>
      addr === agentPda ? registration : null;
    const agent = await ensureRegistered(harness.ctx);
    expect(agent.registered).toBe(true);
    expect(agent.justRegistered).toBe(false);
    expect(harness.registerAgent).not.toHaveBeenCalled();
  });
});
