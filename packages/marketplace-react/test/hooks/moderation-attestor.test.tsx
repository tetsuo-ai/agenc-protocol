/**
 * P1.2 consumption-gate wiring — moderator, roster PDA, legacy grace window.
 *
 * Post-P1.2 the publish gate consumes the record of an EXPLICIT `moderator`
 * (v2 moderator-keyed seeds). The hooks must: attach the roster-entry PDA
 * automatically when the named moderator is a registered attestor (not the
 * global authority); point the gate at the FROZEN legacy record when the
 * attestation predates the upgrade and was authored by the same moderator;
 * and pass the moderator through as the instruction arg.
 *
 * REVERT-SENSITIVE: against the pre-P1.2 hooks (which derived the record
 * from task+hash alone and never carried a moderator) the "roster" and
 * "legacy override" cases fail — the WP-A1 ancestor of that gap made every
 * roster-attested store activation fail on-chain with
 * UNAUTHORIZED_TASK_MODERATOR (found by the 2026-07-02 cross-node canary).
 *
 * The SDK account fetchers are mocked at the module seam so no RPC/network is
 * involved; PDA derivation and everything else use the real SDK.
 */
import {
  address,
  createNoopSigner,
  getBase58Decoder,
  type TransactionSigner,
} from "@solana/kit";
import { QueryClient } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const chain = vi.hoisted(() => ({
  /** On-chain moderation records by ADDRESS (v2 and legacy PDAs both land here). */
  records: {} as Record<string, { moderator: string }>,
  /** Existing roster entries by roster-PDA ADDRESS. */
  attestors: {} as Record<string, true>,
  moderationConfig: null as null | { moderationAuthority: string },
  accountReadGate: null as Promise<void> | null,
  onAccountRead: null as (() => void) | null,
}));

vi.mock("@tetsuo-ai/marketplace-sdk", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tetsuo-ai/marketplace-sdk")>();
  const waitForAccountRead = async () => {
    chain.onAccountRead?.();
    if (chain.accountReadGate !== null) await chain.accountReadGate;
  };
  const fetchRecord = async (_rpc: unknown, addr: unknown) => {
    await waitForAccountRead();
    const data = chain.records[addr as string];
    return data
      ? { exists: true, address: addr, data }
      : { exists: false, address: addr };
  };
  return {
    ...actual,
    fetchMaybeTaskModeration: vi.fn(fetchRecord),
    fetchMaybeListingModeration: vi.fn(fetchRecord),
    fetchMaybeModerationAttestor: vi.fn(
      async (_rpc: unknown, addr: unknown) => {
        await waitForAccountRead();
        return chain.attestors[addr as string]
          ? { exists: true, address: addr, data: {} }
          : { exists: false, address: addr };
      },
    ),
    fetchMaybeModerationConfig: vi.fn(async (_rpc: unknown, addr: unknown) => {
      await waitForAccountRead();
      return chain.moderationConfig
        ? { exists: true, address: addr, data: chain.moderationConfig }
        : { exists: false, address: addr };
    }),
  };
});

import {
  facade,
  findModerationAttestorPda,
  findTaskModerationPda,
  findTaskPda,
} from "@tetsuo-ai/marketplace-sdk";
import {
  AgencProvider,
  type AgencProviderConfig,
  type MarketplaceClient,
  type ReadTransport,
} from "../../src/index.js";
import {
  useHumanlessHireFlow,
  useHire,
  useTaskActivation,
} from "../../src/hooks/index.js";
import { actAsync } from "../act-async.js";

const CREATOR_WALLET = "11111111111111111111111111111111";
const GLOBAL_AUTHORITY = "11111111111111111111111111111111";
const ROSTER_ATTESTOR = "So11111111111111111111111111111111111111112";
const TASK_PDA = address("So11111111111111111111111111111111111111112");
const JOB_SPEC_HASH = new Uint8Array(32).fill(13);
const HIRE_SIGNATURE = getBase58Decoder().decode(new Uint8Array(64).fill(21));
const ACTIVATION_SIGNATURE = getBase58Decoder().decode(
  new Uint8Array(64).fill(22),
);

function stubClient(): MarketplaceClient {
  return {
    signer: createNoopSigner(address(CREATOR_WALLET)),
    transport: {} as MarketplaceClient["transport"],
    hireFromListingHumanless: vi.fn(async () => ({
      signature: HIRE_SIGNATURE,
      logs: [],
    })),
    setTaskJobSpec: vi.fn(async () => ({
      signature: ACTIVATION_SIGNATURE,
      logs: [],
    })),
  } as unknown as MarketplaceClient;
}

function mockReadTransport(): ReadTransport {
  return {
    kind: "indexer",
    listActiveListings: vi.fn(async () => []),
    getListing: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    listingHires: vi.fn(async () => []),
    agentTrackRecord: vi.fn(async () => {
      throw new Error("not implemented");
    }),
  } as unknown as ReadTransport;
}

function wrapper(config: AgencProviderConfig) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AgencProvider config={config} queryClient={queryClient}>
        {children}
      </AgencProvider>
    );
  };
}

async function expectedRosterPda(): Promise<string> {
  const [pda] = await findModerationAttestorPda({
    attestor: address(ROSTER_ATTESTOR),
  });
  return pda;
}

/** The v2 moderator-keyed record PDA for (TASK_PDA, JOB_SPEC_HASH, moderator). */
async function v2RecordPda(moderator: string): Promise<string> {
  const [pda] = await findTaskModerationPda({
    task: TASK_PDA,
    jobSpecHash: JOB_SPEC_HASH,
    moderator: address(moderator),
  });
  return pda;
}

/** The frozen pre-P1.2 record PDA for (TASK_PDA, JOB_SPEC_HASH). */
async function legacyRecordPda(): Promise<string> {
  const [pda] = await facade.findLegacyTaskModerationPda({
    task: TASK_PDA,
    jobSpecHash: JOB_SPEC_HASH,
  });
  return pda;
}

beforeEach(() => {
  chain.records = {};
  chain.attestors = {};
  chain.moderationConfig = null;
  chain.accountReadGate = null;
  chain.onAccountRead = null;
});

describe("useTaskActivation — P1.2 moderation account resolution", () => {
  function render(client: MarketplaceClient) {
    return renderHook(() => useTaskActivation(TASK_PDA), {
      wrapper: wrapper({
        network: "localnet",
        client,
        // The custom-client contract requires an explicit reconciliation/read
        // seam; the SDK fetch exports above are mocked against this object.
        orchestrationRpc: {} as NonNullable<
          AgencProviderConfig["orchestrationRpc"]
        >,
        queryTransport: mockReadTransport(),
      }),
    });
  }

  it("rejects a malformed job-spec hash before moderation or enqueue while preserving the Promise API", async () => {
    const client = stubClient();
    const { result } = render(client);
    const onAccountRead = vi.fn();
    chain.onAccountRead = onAccountRead;

    const rejection = result.current.activate({
      jobSpecHash: new Uint8Array(31),
      jobSpecUri: "https://example.test/invalid-spec.json",
      moderator: address(GLOBAL_AUTHORITY),
    });

    expect(rejection).toBeInstanceOf(Promise);
    await expect(rejection).rejects.toThrow(
      "useTaskActivation: jobSpecHash must be exactly 32 bytes",
    );
    expect(client.setTaskJobSpec).not.toHaveBeenCalled();
    expect(onAccountRead).not.toHaveBeenCalled();
  });

  it("attaches the roster moderation_attestor account and passes the moderator through when the moderator is a roster attestor", async () => {
    chain.moderationConfig = { moderationAuthority: GLOBAL_AUTHORITY };
    chain.attestors[await expectedRosterPda()] = true;
    chain.records[await v2RecordPda(ROSTER_ATTESTOR)] = {
      moderator: ROSTER_ATTESTOR,
    };
    const client = stubClient();
    const { result } = render(client);

    await actAsync(() =>
      result.current.activate({
        jobSpecHash: JOB_SPEC_HASH,
        jobSpecUri: "https://example.test/spec.json",
        moderator: address(ROSTER_ATTESTOR),
      }),
    );

    const call = (client.setTaskJobSpec as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(call.moderator).toBe(address(ROSTER_ATTESTOR));
    expect(call.moderationAttestor).toBe(await expectedRosterPda());
    // v2 record exists → the facade's default derivation is correct; no override.
    expect(call.taskModeration).toBeUndefined();
  });

  it("omits the roster account for global-authority moderation", async () => {
    chain.moderationConfig = { moderationAuthority: GLOBAL_AUTHORITY };
    chain.records[await v2RecordPda(GLOBAL_AUTHORITY)] = {
      moderator: GLOBAL_AUTHORITY,
    };
    const client = stubClient();
    const { result } = render(client);

    await actAsync(() =>
      result.current.activate({
        jobSpecHash: JOB_SPEC_HASH,
        jobSpecUri: "https://example.test/spec.json",
        moderator: address(GLOBAL_AUTHORITY),
      }),
    );

    const call = (client.setTaskJobSpec as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(call.moderator).toBe(address(GLOBAL_AUTHORITY));
    expect(call.moderationAttestor).toBeUndefined();
  });

  it("points the gate at the FROZEN legacy record when no v2 record exists and the legacy record was authored by the same moderator (grace window)", async () => {
    chain.moderationConfig = { moderationAuthority: GLOBAL_AUTHORITY };
    chain.attestors[await expectedRosterPda()] = true;
    chain.records[await legacyRecordPda()] = { moderator: ROSTER_ATTESTOR };
    const client = stubClient();
    const { result } = render(client);

    await actAsync(() =>
      result.current.activate({
        jobSpecHash: JOB_SPEC_HASH,
        jobSpecUri: "https://example.test/spec.json",
        moderator: address(ROSTER_ATTESTOR),
      }),
    );

    const call = (client.setTaskJobSpec as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(call.moderationAttestor).toBe(await expectedRosterPda());
    expect(call.taskModeration).toBe(await legacyRecordPda());
  });

  it("does NOT point at a legacy record authored by a DIFFERENT moderator", async () => {
    chain.moderationConfig = { moderationAuthority: GLOBAL_AUTHORITY };
    chain.records[await legacyRecordPda()] = { moderator: GLOBAL_AUTHORITY };
    const client = stubClient();
    const { result } = render(client);

    await actAsync(() =>
      result.current.activate({
        jobSpecHash: JOB_SPEC_HASH,
        jobSpecUri: "https://example.test/spec.json",
        moderator: address(ROSTER_ATTESTOR),
      }),
    );

    const call = (client.setTaskJobSpec as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(call.taskModeration).toBeUndefined();
  });

  it("does NOT attach a roster entry it cannot verify exists (stray-cluster regression)", async () => {
    chain.moderationConfig = { moderationAuthority: GLOBAL_AUTHORITY };
    // The moderator is not the authority, but no roster entry exists on the
    // chain the resolver reads — attaching the derived PDA would fail the
    // gate with AccountNotInitialized, strictly worse than attaching nothing.
    const client = stubClient();
    const { result } = render(client);

    await actAsync(() =>
      result.current.activate({
        jobSpecHash: JOB_SPEC_HASH,
        jobSpecUri: "https://example.test/spec.json",
        moderator: address(ROSTER_ATTESTOR),
      }),
    );

    const call = (client.setTaskJobSpec as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(call.moderationAttestor).toBeUndefined();
  });

  it("a caller-supplied moderationAttestor wins over resolution", async () => {
    chain.moderationConfig = { moderationAuthority: GLOBAL_AUTHORITY };
    const client = stubClient();
    const { result } = render(client);
    const explicit = address(CREATOR_WALLET);

    await actAsync(() =>
      result.current.activate({
        jobSpecHash: JOB_SPEC_HASH,
        jobSpecUri: "https://example.test/spec.json",
        moderator: address(ROSTER_ATTESTOR),
        moderationAttestor: explicit,
      }),
    );

    const call = (client.setTaskJobSpec as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(call.moderationAttestor).toBe(explicit);
  });

  it("snapshots the activation hash and creator before enqueue and moderation awaits", async () => {
    let releaseRead!: () => void;
    chain.accountReadGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    chain.onAccountRead = markReadStarted;
    chain.moderationConfig = { moderationAuthority: GLOBAL_AUTHORITY };

    const baseSigner = createNoopSigner(address(CREATOR_WALLET));
    let liveAddress: TransactionSigner["address"] = address(CREATOR_WALLET);
    const mutableSigner = Object.create(baseSigner) as TransactionSigner;
    Object.defineProperty(mutableSigner, "address", {
      configurable: true,
      enumerable: true,
      get: () => liveAddress,
    });
    const client = stubClient();
    const { result } = render(client);
    const jobSpecHash = new Uint8Array(32).fill(0x41);
    const expectedJobSpecHash = new Uint8Array(jobSpecHash);

    await act(async () => {
      const running = result.current.activate({
        jobSpecHash,
        jobSpecUri: "https://example.test/stable-spec.json",
        moderator: address(GLOBAL_AUTHORITY),
        creator: mutableSigner,
      });

      jobSpecHash.fill(0xa1);
      liveAddress = address(ROSTER_ATTESTOR);
      await readStarted;
      jobSpecHash.fill(0xb1);
      liveAddress = address(ROSTER_ATTESTOR);
      releaseRead();
      await running;
    });

    const submitted = (client.setTaskJobSpec as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(submitted.jobSpecHash).toEqual(expectedJobSpecHash);
    expect(submitted.jobSpecHash).not.toBe(jobSpecHash);
    expect(submitted.creator).toBe(client.signer);
    expect(submitted.creator.address).toBe(address(CREATOR_WALLET));
    expect(Object.isFrozen(mutableSigner)).toBe(false);
  });
});

describe("useHire — P1.2 moderation account resolution", () => {
  it("snapshots every fixed-byte commitment and creator across moderation and send awaits", async () => {
    let releaseRead!: () => void;
    chain.accountReadGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    chain.onAccountRead = markReadStarted;
    chain.moderationConfig = { moderationAuthority: GLOBAL_AUTHORITY };

    let releaseSend!: () => void;
    let markSendStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const baseSigner = createNoopSigner(address(CREATOR_WALLET));
    let liveAddress: TransactionSigner["address"] = address(CREATOR_WALLET);
    const mutableSigner = Object.create(baseSigner) as TransactionSigner;
    Object.defineProperty(mutableSigner, "address", {
      configurable: true,
      enumerable: true,
      get: () => liveAddress,
    });
    const client = stubClient();
    (client as { signer: TransactionSigner }).signer = mutableSigner;
    client.hireFromListingHumanless = vi.fn(async () => {
      markSendStarted();
      await sendGate;
      return { signature: HIRE_SIGNATURE, logs: [] };
    });

    const taskId = new Uint8Array(32).fill(0x51);
    const listingSpecHash = new Uint8Array(32).fill(0x52);
    const taskJobSpecHash = new Uint8Array(32).fill(0x53);
    const expectedTaskId = new Uint8Array(taskId);
    const expectedListingSpecHash = new Uint8Array(listingSpecHash);
    const expectedTaskJobSpecHash = new Uint8Array(taskJobSpecHash);
    const [expectedTaskPda] = await findTaskPda({
      creator: address(CREATOR_WALLET),
      taskId: expectedTaskId,
    });
    const { result } = renderHook(() => useHire(), {
      wrapper: wrapper({
        network: "localnet",
        client,
        orchestrationRpc: {} as NonNullable<
          AgencProviderConfig["orchestrationRpc"]
        >,
        queryTransport: mockReadTransport(),
      }),
    });

    let settled!: Awaited<ReturnType<typeof result.current.hire>>;
    await act(async () => {
      const running = result.current.hire({
        listing: address(ROSTER_ATTESTOR),
        providerAgent: address(ROSTER_ATTESTOR),
        taskId,
        expectedPrice: 1_000_000n,
        expectedVersion: 1n,
        reviewWindowSecs: 3600n,
        listingSpecHash,
        taskJobSpecHash,
        moderator: address(GLOBAL_AUTHORITY),
        humanless: true,
      });

      taskId.fill(0xa1);
      listingSpecHash.fill(0xa2);
      taskJobSpecHash.fill(0xa3);
      liveAddress = address(ROSTER_ATTESTOR);
      await readStarted;

      taskId.fill(0xb1);
      listingSpecHash.fill(0xb2);
      taskJobSpecHash.fill(0xb3);
      liveAddress = address(ROSTER_ATTESTOR);
      releaseRead();
      await sendStarted;

      taskId.fill(0xc1);
      listingSpecHash.fill(0xc2);
      taskJobSpecHash.fill(0xc3);
      liveAddress = address(ROSTER_ATTESTOR);
      releaseSend();
      settled = await running;
    });

    const submitted = (
      client.hireFromListingHumanless as ReturnType<typeof vi.fn>
    ).mock.calls[0]![0];
    expect(submitted.taskId).toEqual(expectedTaskId);
    expect(submitted.taskId).not.toBe(taskId);
    expect(submitted.listingSpecHash).toEqual(expectedListingSpecHash);
    expect(submitted.listingSpecHash).not.toBe(listingSpecHash);
    expect(submitted.taskJobSpecHash).toEqual(expectedTaskJobSpecHash);
    expect(submitted.taskJobSpecHash).not.toBe(taskJobSpecHash);
    expect(submitted.creator).toBe(mutableSigner);
    expect(submitted.creator.address).toBe(address(CREATOR_WALLET));
    expect(Object.isFrozen(mutableSigner)).toBe(false);
    expect(
      Object.getOwnPropertyDescriptor(mutableSigner, "address"),
    ).toMatchObject({
      configurable: false,
      writable: false,
      value: address(CREATOR_WALLET),
    });
    expect(settled.taskPda).toBe(expectedTaskPda);
  });
});

describe("useHumanlessHireFlow — P1.2 moderation account resolution", () => {
  it("keeps a custom client off implicit localnet RPC while preserving explicit roster mechanics", async () => {
    chain.moderationConfig = { moderationAuthority: GLOBAL_AUTHORITY };
    chain.attestors[await expectedRosterPda()] = true;
    const client = stubClient();
    const taskId = new Uint8Array(32).fill(8);

    const { result } = renderHook(() => useHumanlessHireFlow(), {
      wrapper: wrapper({
        network: "localnet",
        client,
        queryTransport: mockReadTransport(),
      }),
    });

    await actAsync(() =>
      result.current.hireAndActivate({
        hire: {
          listing: address(ROSTER_ATTESTOR),
          providerAgent: address(ROSTER_ATTESTOR),
          taskId,
          expectedPrice: 1_000_000n,
          expectedVersion: 1n,
          reviewWindowSecs: 3600n,
          listingSpecHash: new Uint8Array(32).fill(9),
          taskJobSpecHash: JOB_SPEC_HASH,
          moderator: address(ROSTER_ATTESTOR),
          moderatorIsAttestor: true,
        },
        jobSpec: { title: "cross-node canary" },
        activation: { moderatorIsAttestor: true },
        hostAndModerateJobSpec: vi.fn(async () => ({
          jobSpecHash: JOB_SPEC_HASH,
          jobSpecUri: "https://example.test/spec.json",
          moderationAttested: true,
          moderator: address(ROSTER_ATTESTOR),
          moderation: { verdict: "clean" },
        })),
      }),
    );

    const [taskPda] = await findTaskPda({
      creator: address(CREATOR_WALLET),
      taskId,
    });
    const hireCall = (
      client.hireFromListingHumanless as ReturnType<typeof vi.fn>
    ).mock.calls[0]![0];
    // The SDK facade deterministically derives the roster account from this
    // explicit mechanic. The custom client must not be coupled to localnet's
    // implicit HTTP endpoint to discover it.
    expect(hireCall.moderator).toBe(address(ROSTER_ATTESTOR));
    expect(hireCall.moderatorIsAttestor).toBe(true);
    expect(hireCall.moderationAttestor).toBeUndefined();
    const call = (client.setTaskJobSpec as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(call.task).toBe(taskPda);
    expect(call.moderator).toBe(address(ROSTER_ATTESTOR));
    expect(call.moderatorIsAttestor).toBe(true);
    expect(call.moderationAttestor).toBeUndefined();
  });
});
