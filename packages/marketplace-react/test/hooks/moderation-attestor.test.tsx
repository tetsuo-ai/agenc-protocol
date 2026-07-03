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
import { address, createNoopSigner } from "@solana/kit";
import { QueryClient } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const chain = vi.hoisted(() => ({
  /** On-chain moderation records by ADDRESS (v2 and legacy PDAs both land here). */
  records: {} as Record<string, { moderator: string }>,
  /** Existing roster entries by roster-PDA ADDRESS. */
  attestors: {} as Record<string, true>,
  moderationConfig: null as null | { moderationAuthority: string },
}));

vi.mock("@tetsuo-ai/marketplace-sdk", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tetsuo-ai/marketplace-sdk")>();
  const fetchRecord = async (_rpc: unknown, addr: unknown) => {
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
      async (_rpc: unknown, addr: unknown) =>
        chain.attestors[addr as string]
          ? { exists: true, address: addr, data: {} }
          : { exists: false, address: addr },
    ),
    fetchMaybeModerationConfig: vi.fn(async (_rpc: unknown, addr: unknown) =>
      chain.moderationConfig
        ? { exists: true, address: addr, data: chain.moderationConfig }
        : { exists: false, address: addr },
    ),
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
  useTaskActivation,
} from "../../src/hooks/index.js";

const CREATOR_WALLET = "11111111111111111111111111111111";
const GLOBAL_AUTHORITY = "11111111111111111111111111111111";
const ROSTER_ATTESTOR = "So11111111111111111111111111111111111111112";
const TASK_PDA = address("So11111111111111111111111111111111111111112");
const JOB_SPEC_HASH = new Uint8Array(32).fill(13);

function stubClient(): MarketplaceClient {
  return {
    signer: createNoopSigner(address(CREATOR_WALLET)),
    transport: {} as MarketplaceClient["transport"],
    hireFromListingHumanless: vi.fn(async () => ({
      signature: "sig-humanless",
      logs: [],
    })),
    setTaskJobSpec: vi.fn(async () => ({ signature: "sig-activate", logs: [] })),
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
});

describe("useTaskActivation — P1.2 moderation account resolution", () => {
  function render(client: MarketplaceClient) {
    return renderHook(() => useTaskActivation(TASK_PDA), {
      wrapper: wrapper({
        network: "localnet",
        client,
        queryTransport: mockReadTransport(),
      }),
    });
  }

  it("attaches the roster moderation_attestor account and passes the moderator through when the moderator is a roster attestor", async () => {
    chain.moderationConfig = { moderationAuthority: GLOBAL_AUTHORITY };
    chain.attestors[await expectedRosterPda()] = true;
    chain.records[await v2RecordPda(ROSTER_ATTESTOR)] = {
      moderator: ROSTER_ATTESTOR,
    };
    const client = stubClient();
    const { result } = render(client);

    await result.current.activate({
      jobSpecHash: JOB_SPEC_HASH,
      jobSpecUri: "https://example.test/spec.json",
      moderator: address(ROSTER_ATTESTOR),
    });

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

    await result.current.activate({
      jobSpecHash: JOB_SPEC_HASH,
      jobSpecUri: "https://example.test/spec.json",
      moderator: address(GLOBAL_AUTHORITY),
    });

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

    await result.current.activate({
      jobSpecHash: JOB_SPEC_HASH,
      jobSpecUri: "https://example.test/spec.json",
      moderator: address(ROSTER_ATTESTOR),
    });

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

    await result.current.activate({
      jobSpecHash: JOB_SPEC_HASH,
      jobSpecUri: "https://example.test/spec.json",
      moderator: address(ROSTER_ATTESTOR),
    });

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

    await result.current.activate({
      jobSpecHash: JOB_SPEC_HASH,
      jobSpecUri: "https://example.test/spec.json",
      moderator: address(ROSTER_ATTESTOR),
    });

    const call = (client.setTaskJobSpec as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(call.moderationAttestor).toBeUndefined();
  });

  it("a caller-supplied moderationAttestor wins over resolution", async () => {
    chain.moderationConfig = { moderationAuthority: GLOBAL_AUTHORITY };
    const client = stubClient();
    const { result } = render(client);
    const explicit = address(CREATOR_WALLET);

    await result.current.activate({
      jobSpecHash: JOB_SPEC_HASH,
      jobSpecUri: "https://example.test/spec.json",
      moderator: address(ROSTER_ATTESTOR),
      moderationAttestor: explicit,
    });

    const call = (client.setTaskJobSpec as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(call.moderationAttestor).toBe(explicit);
  });
});

describe("useHumanlessHireFlow — P1.2 moderation account resolution", () => {
  it("carries the moderation result's moderator into activation and attaches the roster account (the cross-node canary regression)", async () => {
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

    await result.current.hireAndActivate({
      hire: {
        listing: address(ROSTER_ATTESTOR),
        taskId,
        expectedPrice: 1_000_000n,
        expectedVersion: 1n,
        reviewWindowSecs: 3600n,
        listingSpecHash: new Uint8Array(32).fill(9),
        moderator: address(ROSTER_ATTESTOR),
      },
      jobSpec: { title: "cross-node canary" },
      hostAndModerateJobSpec: vi.fn(async () => ({
        jobSpecHash: JOB_SPEC_HASH,
        jobSpecUri: "https://example.test/spec.json",
        moderationAttested: true,
        moderator: address(ROSTER_ATTESTOR),
        moderation: { verdict: "clean" },
      })),
    });

    const [taskPda] = await findTaskPda({
      creator: address(CREATOR_WALLET),
      taskId,
    });
    const hireCall = (
      client.hireFromListingHumanless as ReturnType<typeof vi.fn>
    ).mock.calls[0]![0];
    // The hire gate names the listing moderator and gets the roster account.
    expect(hireCall.moderator).toBe(address(ROSTER_ATTESTOR));
    expect(hireCall.moderationAttestor).toBe(await expectedRosterPda());
    const call = (client.setTaskJobSpec as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(call.task).toBe(taskPda);
    expect(call.moderator).toBe(address(ROSTER_ATTESTOR));
    expect(call.moderationAttestor).toBe(await expectedRosterPda());
  });
});
