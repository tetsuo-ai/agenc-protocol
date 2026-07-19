/**
 * Structural tests for the A2 headless hooks.
 *
 * These bind every hook over a mock `ReadTransport` (the `queryTransport`
 * override slot) and a stub write client (the `client` slot) — the same public
 * seams `startLocalMarketplace()` plugs into for e2e — so there is no RPC, no
 * litesvm, and no network here. They assert:
 * - reads resolve through the transport and shape correctly (useListings
 *   pagination, useListing join, useAgentTrackRecord projection);
 * - writes call the right client method with task-bound / signer-defaulted
 *   input and surface typed errors untouched (useHire, useSubmissionReview,
 *   useDispute);
 * - referrers: useHire injects configured referrer terms and
 *   useReferrerEarnings returns the not-live zero state until the earnings
 *   indexer ships;
 * - useTaskStatus / useDispute read via their injected reader seam.
 */
import { address, createNoopSigner } from "@solana/kit";
import {
  AgencError,
  TaskStatus,
  findTaskPda,
  type Dispute,
  type IndexerAgentTrackRecord,
  type ServiceListing,
  type Task,
} from "@tetsuo-ai/marketplace-sdk";
import { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgencProvider,
  type AgencProviderConfig,
  type DecodedProgramAccount,
  type MarketplaceClient,
  type ReadListingResult,
  type ReadTransport,
} from "../../src/index.js";
import {
  projectTrackRecord,
  queryKeys,
  useAgentTrackRecord,
  useDispute,
  useHire,
  useHumanlessHireFlow,
  useListing,
  useListings,
  useReferrerEarnings,
  useSubmissionReview,
  useTaskStatus,
  useWalletSigner,
} from "../../src/hooks/index.js";

const VALID_WALLET = "11111111111111111111111111111111";
const PROVIDER_AGENT = address("So11111111111111111111111111111111111111112");

/** A decoded listing row fixture. */
function listingRow(
  addr: string,
  overrides: Partial<ServiceListing> = {},
): DecodedProgramAccount<ServiceListing> {
  return {
    address: address(addr),
    account: {
      providerAgent: PROVIDER_AGENT,
      price: 1_000_000n,
      ...overrides,
    } as unknown as ServiceListing,
  };
}

function trackRecordFixture(
  overrides: Partial<IndexerAgentTrackRecord> = {},
): IndexerAgentTrackRecord {
  return {
    agent: String(PROVIDER_AGENT),
    completions: 8,
    disputesInitiated: 1,
    disputesLost: 2,
    slashHistory: [],
    source: "events",
    ...overrides,
  };
}

/** A mock read transport via the `queryTransport` override slot. */
function mockReadTransport(
  overrides: Partial<ReadTransport> = {},
): ReadTransport {
  return {
    kind: "indexer",
    listActiveListings: vi.fn(async () => []),
    getListing: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    listingHires: vi.fn(async () => []),
    agentTrackRecord: vi.fn(async () => trackRecordFixture()),
    ...overrides,
  };
}

/** A stub write client capturing calls, via the `client` override slot. */
function stubClient(overrides: Partial<MarketplaceClient> = {}): MarketplaceClient {
  return {
    signer: createNoopSigner(address(VALID_WALLET)),
    transport: {} as MarketplaceClient["transport"],
    send: vi.fn(async () => ({ signature: "sig-send", logs: [] })),
    hireFromListing: vi.fn(async () => ({ signature: "sig-hire", logs: [] })),
    hireFromListingHumanless: vi.fn(async () => ({
      signature: "sig-humanless",
      logs: [],
    })),
    setTaskJobSpec: vi.fn(async () => ({ signature: "sig-activate", logs: [] })),
    claimTaskWithJobSpec: vi.fn(async () => ({ signature: "sig-claim", logs: [] })),
    submitTaskResult: vi.fn(async () => ({ signature: "sig-submit", logs: [] })),
    acceptTaskResult: vi.fn(async () => ({ signature: "sig-accept", logs: [] })),
    rejectTaskResult: vi.fn(async () => ({ signature: "sig-reject", logs: [] })),
    autoAcceptTaskResult: vi.fn(async () => ({
      signature: "sig-autoaccept",
      logs: [],
    })),
    cancelTask: vi.fn(async () => ({ signature: "sig-cancel", logs: [] })),
    closeTask: vi.fn(async () => ({ signature: "sig-close", logs: [] })),
    rateHire: vi.fn(async () => ({ signature: "sig-rate", logs: [] })),
    initiateDispute: vi.fn(async () => ({ signature: "sig-dispute", logs: [] })),
    ...overrides,
  } as unknown as MarketplaceClient;
}

function wrapper(config: AgencProviderConfig) {
  // A fresh QueryClient with retries off so error assertions are immediate.
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

// ----------------------------------------------------------------------------
// useListings
// ----------------------------------------------------------------------------
describe("useListings", () => {
  it("loads listings through the transport and exposes total", async () => {
    const rows = [listingRow(VALID_WALLET), listingRow(String(PROVIDER_AGENT))];
    const read = mockReadTransport({
      listActiveListings: vi.fn(async () => rows),
    });
    const { result } = renderHook(() => useListings(), {
      wrapper: wrapper({ network: "localnet", queryTransport: read }),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.total).toBe(2);
    expect(result.current.listings).toHaveLength(2);
    expect(result.current.error).toBeNull();
  });

  it("forwards the filter to the transport", async () => {
    const fn = vi.fn(async () => []);
    const read = mockReadTransport({ listActiveListings: fn });
    renderHook(() => useListings({ category: "code-generation" }), {
      wrapper: wrapper({ network: "localnet", queryTransport: read }),
    });
    await waitFor(() => expect(fn).toHaveBeenCalled());
    expect(fn).toHaveBeenCalledWith({ category: "code-generation" });
  });

  it("paginates client-side: fetchMore reveals the next page", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      listingRow(VALID_WALLET, { price: BigInt(i) }),
    );
    const read = mockReadTransport({
      listActiveListings: vi.fn(async () => rows),
    });
    const { result } = renderHook(() => useListings(undefined, { pageSize: 2 }), {
      wrapper: wrapper({ network: "localnet", queryTransport: read }),
    });
    await waitFor(() => expect(result.current.listings.length).toBe(2));
    expect(result.current.hasMore).toBe(true);
    result.current.fetchMore();
    await waitFor(() => expect(result.current.listings.length).toBe(4));
    result.current.fetchMore();
    await waitFor(() => expect(result.current.listings.length).toBe(5));
    expect(result.current.hasMore).toBe(false);
  });

  it("surfaces a transport error", async () => {
    const read = mockReadTransport({
      listActiveListings: vi.fn(async () => {
        throw new Error("rpc down");
      }),
    });
    const { result } = renderHook(() => useListings(), {
      wrapper: wrapper({ network: "localnet", queryTransport: read }),
    });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toContain("rpc down");
  });
});

// ----------------------------------------------------------------------------
// useListing
// ----------------------------------------------------------------------------
describe("useListing", () => {
  it("joins listing + provider + track record", async () => {
    const detail: ReadListingResult = {
      address: address(VALID_WALLET),
      account: { providerAgent: PROVIDER_AGENT } as unknown as ServiceListing,
    };
    const read = mockReadTransport({
      getListing: vi.fn(async () => detail),
      agentTrackRecord: vi.fn(async () => trackRecordFixture()),
    });
    const { result } = renderHook(() => useListing(VALID_WALLET), {
      wrapper: wrapper({ network: "localnet", queryTransport: read }),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.provider).toBe(PROVIDER_AGENT);
    expect(result.current.trackRecord?.completions).toBe(8);
    expect(result.current.listing).not.toBeNull();
  });

  it("is disabled when pda is falsy", () => {
    const read = mockReadTransport();
    const { result } = renderHook(() => useListing(null), {
      wrapper: wrapper({ network: "localnet", queryTransport: read }),
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.detail).toBeNull();
    expect(read.getListing).not.toHaveBeenCalled();
  });

  it("degrades to null track record when the gPA fallback is unsupported", async () => {
    const { ReadTransportUnsupportedError } = await import(
      "../../src/index.js"
    );
    const detail: ReadListingResult = {
      address: address(VALID_WALLET),
      account: { providerAgent: PROVIDER_AGENT } as unknown as ServiceListing,
    };
    const read = mockReadTransport({
      kind: "gpa",
      getListing: vi.fn(async () => detail),
      agentTrackRecord: vi.fn(async () => {
        throw new ReadTransportUnsupportedError("agentTrackRecord");
      }),
    });
    const { result } = renderHook(() => useListing(VALID_WALLET), {
      wrapper: wrapper({ network: "localnet", queryTransport: read }),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.trackRecord).toBeNull();
    expect(result.current.provider).toBe(PROVIDER_AGENT);
  });
});

// ----------------------------------------------------------------------------
// useAgentTrackRecord (P6.6 partial)
// ----------------------------------------------------------------------------
describe("useAgentTrackRecord", () => {
  it("projects rates from the indexer counts and flags partial", () => {
    const projected = projectTrackRecord(
      trackRecordFixture({ completions: 8, disputesLost: 2 }),
    );
    // settledKnown = 10, completionRate = 0.8, disputeRate = 0.2
    expect(projected.completionRate).toBeCloseTo(0.8);
    expect(projected.disputeRate).toBeCloseTo(0.2);
    expect(projected.partial).toBe(true);
  });

  it("returns null rates when there is no denominator", () => {
    const projected = projectTrackRecord(
      trackRecordFixture({ completions: 0, disputesLost: 0 }),
    );
    expect(projected.completionRate).toBeNull();
    expect(projected.disputeRate).toBeNull();
  });

  it("reads via the transport and exposes convenience fields", async () => {
    const read = mockReadTransport({
      agentTrackRecord: vi.fn(async () => trackRecordFixture()),
    });
    const { result } = renderHook(() => useAgentTrackRecord(PROVIDER_AGENT), {
      wrapper: wrapper({ network: "localnet", queryTransport: read }),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.completionRate).toBeCloseTo(0.8);
    expect(result.current.slashHistory).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// useHire
// ----------------------------------------------------------------------------
describe("useHire", () => {
  const hireArgs = {
    listing: PROVIDER_AGENT,
    creatorAgent: PROVIDER_AGENT,
    taskId: new Uint8Array(32).fill(7),
    expectedPrice: 1_000_000n,
    expectedVersion: 1n,
  } as never;

  it("calls client.hireFromListing and derives the task PDA", async () => {
    const client = stubClient();
    const { result } = renderHook(() => useHire(), {
      wrapper: wrapper({
        network: "localnet",
        client,
        queryTransport: mockReadTransport(),
      }),
    });
    const res = await result.current.hire(hireArgs);
    expect(client.hireFromListing).toHaveBeenCalledTimes(1);
    expect(res.signature).toBe("sig-hire");
    expect(res.taskPda).toBeTruthy();
  });

  it("calls client.hireFromListingHumanless for storefront-visitor hires", async () => {
    const client = stubClient();
    const { result } = renderHook(() => useHire(), {
      wrapper: wrapper({
        network: "localnet",
        client,
        queryTransport: mockReadTransport(),
      }),
    });
    const res = await result.current.hire({
      listing: PROVIDER_AGENT,
      taskId: new Uint8Array(32).fill(8),
      expectedPrice: 1_000_000n,
      expectedVersion: 1n,
      listingSpecHash: new Uint8Array(32).fill(9),
      humanless: true,
    } as never);
    expect(client.hireFromListingHumanless).toHaveBeenCalledTimes(1);
    expect(res.signature).toBe("sig-humanless");
    expect(res.taskPda).toBeTruthy();
  });

  it("injects a configured referrer into the hire input", async () => {
    const client = stubClient();
    const { result } = renderHook(() => useHire(), {
      wrapper: wrapper({
        network: "localnet",
        client,
        queryTransport: mockReadTransport(),
        referrer: { wallet: VALID_WALLET, feeBps: 250 },
      }),
    });
    const res = await result.current.hire(hireArgs);
    expect(res.referrerInjected).toBe(true);
    const passed = (client.hireFromListing as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(passed).toHaveProperty("referrer", VALID_WALLET);
    expect(passed).toHaveProperty("referrerFeeBps", 250);
  });

  it("does not forward per-call referrer fields when provider referrer is absent", async () => {
    const client = stubClient();
    const { result } = renderHook(() => useHire(), {
      wrapper: wrapper({
        network: "localnet",
        client,
        queryTransport: mockReadTransport(),
      }),
    });
    await result.current.hire({
      listing: PROVIDER_AGENT,
      creatorAgent: PROVIDER_AGENT,
      taskId: new Uint8Array(32).fill(7),
      expectedPrice: 1_000_000n,
      expectedVersion: 1n,
      referrer: PROVIDER_AGENT,
      referrerFeeBps: 999,
    } as never);
    const passed = (client.hireFromListing as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(passed).not.toHaveProperty("referrer");
    expect(passed).not.toHaveProperty("referrerFeeBps");
  });

  it("surfaces a typed AgencError untouched", async () => {
    const err = new AgencError("hire failed", { code: 6000 });
    const client = stubClient({
      hireFromListing: vi.fn(async () => {
        throw err;
      }),
    });
    const { result } = renderHook(() => useHire(), {
      wrapper: wrapper({
        network: "localnet",
        client,
        queryTransport: mockReadTransport(),
      }),
    });
    await expect(result.current.hire(hireArgs)).rejects.toBe(err);
    await waitFor(() => expect(result.current.error).toBe(err));
    expect(result.current.status).toBe("error");
  });

  it("errors clearly when no write client is configured", async () => {
    const { result } = renderHook(() => useHire(), {
      wrapper: wrapper({ network: "localnet", queryTransport: mockReadTransport() }),
    });
    await expect(result.current.hire(hireArgs)).rejects.toThrowError(
      /No write client/,
    );
  });
});

// ----------------------------------------------------------------------------
// useHumanlessHireFlow
// ----------------------------------------------------------------------------
describe("useHumanlessHireFlow", () => {
  const flowTaskId = new Uint8Array(32).fill(8);
  const flowHash = new Uint8Array(32).fill(13);
  const flowJobSpec = { title: "Ship a marketplace audit" };
  const flowHire = {
    listing: PROVIDER_AGENT,
    providerAgent: PROVIDER_AGENT,
    taskId: flowTaskId,
    expectedPrice: 1_000_000n,
    expectedVersion: 1n,
    reviewWindowSecs: 3600n,
    listingSpecHash: new Uint8Array(32).fill(9),
    // P1.2: the hire gate names the moderator whose listing attestation it consumes.
    moderator: PROVIDER_AGENT,
  };

  async function expectedFlowTaskPda() {
    const [taskPda] = await findTaskPda({
      creator: address(VALID_WALLET),
      taskId: flowTaskId,
    });
    return taskPda;
  }

  it("hires, hosts a moderated job spec, and activates the same task", async () => {
    const client = stubClient();
    const hostAndModerateJobSpec = vi.fn(async () => ({
      jobSpecHash: flowHash,
      jobSpecUri: "https://example.test/specs/flow.json",
      moderationAttested: true,
      moderator: PROVIDER_AGENT,
      moderation: { verdict: "allow" },
    }));
    const { result } = renderHook(() => useHumanlessHireFlow<typeof flowJobSpec>(), {
      wrapper: wrapper({
        network: "localnet",
        client,
        queryTransport: mockReadTransport(),
      }),
    });

    const res = await result.current.hireAndActivate({
      hire: flowHire,
      jobSpec: flowJobSpec,
      hostAndModerateJobSpec,
    });
    const taskPda = await expectedFlowTaskPda();

    expect(client.hireFromListingHumanless).toHaveBeenCalledTimes(1);
    expect(hostAndModerateJobSpec).toHaveBeenCalledWith({
      taskPda,
      taskId: flowTaskId,
      listing: PROVIDER_AGENT,
      jobSpec: flowJobSpec,
      hireSignature: "sig-humanless",
      referrerInjected: false,
    });
    expect(client.setTaskJobSpec).toHaveBeenCalledTimes(1);
    const activation = (client.setTaskJobSpec as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(activation.task).toBe(taskPda);
    expect(activation.creator).toBe(client.signer);
    expect(activation.jobSpecHash).toBe(flowHash);
    expect(activation.jobSpecUri).toBe("https://example.test/specs/flow.json");
    expect(res).toMatchObject({
      taskPda,
      hireSignature: "sig-humanless",
      activationSignature: "sig-activate",
      jobSpecUri: "https://example.test/specs/flow.json",
      referrerInjected: false,
      moderation: { verdict: "allow" },
    });
    await waitFor(() => expect(result.current.phase).toBe("activated"));
    expect(result.current.progress.activationSignature).toBe("sig-activate");
  });

  it("injects provider referrer config and reports it to the backend seam", async () => {
    const client = stubClient();
    const hostAndModerateJobSpec = vi.fn(
      async (_input: { referrerInjected: boolean }) => ({
        jobSpecHash: flowHash,
        jobSpecUri: "https://example.test/specs/referrer.json",
        moderationAttested: true,
        moderator: PROVIDER_AGENT,
      }),
    );
    const { result } = renderHook(() => useHumanlessHireFlow<typeof flowJobSpec>(), {
      wrapper: wrapper({
        network: "localnet",
        client,
        queryTransport: mockReadTransport(),
        referrer: { wallet: VALID_WALLET, feeBps: 250 },
      }),
    });

    const res = await result.current.hireAndActivate({
      hire: flowHire,
      jobSpec: flowJobSpec,
      hostAndModerateJobSpec,
    });

    const hireInput = (client.hireFromListingHumanless as ReturnType<typeof vi.fn>)
      .mock.calls[0]![0];
    expect(hireInput).toHaveProperty("referrer", VALID_WALLET);
    expect(hireInput).toHaveProperty("referrerFeeBps", 250);
    expect(hostAndModerateJobSpec.mock.calls[0]![0].referrerInjected).toBe(true);
    expect(res.referrerInjected).toBe(true);
  });

  it("strips unsafe per-call referrer fields from the flow hire input", async () => {
    const client = stubClient();
    const hostAndModerateJobSpec = vi.fn(
      async (_input: { referrerInjected: boolean }) => ({
        jobSpecHash: flowHash,
        jobSpecUri: "https://example.test/specs/no-referrer.json",
        moderationAttested: true,
        moderator: PROVIDER_AGENT,
      }),
    );
    const { result } = renderHook(() => useHumanlessHireFlow<typeof flowJobSpec>(), {
      wrapper: wrapper({
        network: "localnet",
        client,
        queryTransport: mockReadTransport(),
      }),
    });

    const res = await result.current.hireAndActivate({
      hire: {
        ...flowHire,
        referrer: PROVIDER_AGENT,
        referrerFeeBps: 999,
      } as never,
      jobSpec: flowJobSpec,
      hostAndModerateJobSpec,
    });

    const hireInput = (client.hireFromListingHumanless as ReturnType<typeof vi.fn>)
      .mock.calls[0]![0];
    expect(hireInput).not.toHaveProperty("referrer");
    expect(hireInput).not.toHaveProperty("referrerFeeBps");
    expect(hostAndModerateJobSpec.mock.calls[0]![0].referrerInjected).toBe(false);
    expect(res.referrerInjected).toBe(false);
  });

  it("preserves hire progress when the backend moderation request fails", async () => {
    const backendError = new Error("moderation backend offline");
    const client = stubClient();
    const hostAndModerateJobSpec = vi.fn(async () => {
      throw backendError;
    });
    const { result } = renderHook(() => useHumanlessHireFlow<typeof flowJobSpec>(), {
      wrapper: wrapper({
        network: "localnet",
        client,
        queryTransport: mockReadTransport(),
      }),
    });

    await expect(
      result.current.hireAndActivate({
        hire: flowHire,
        jobSpec: flowJobSpec,
        hostAndModerateJobSpec,
      }),
    ).rejects.toBe(backendError);

    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.progress.taskPda).toBeTruthy();
    expect(result.current.progress.hireSignature).toBe("sig-humanless");
    expect(result.current.progress.activationSignature).toBeNull();
    expect(client.setTaskJobSpec).not.toHaveBeenCalled();
  });

  it("rejects non-attested moderation before signing activation", async () => {
    const client = stubClient();
    const hostAndModerateJobSpec = vi.fn(async () => ({
      jobSpecHash: flowHash,
      jobSpecUri: "https://example.test/specs/rejected.json",
      moderationAttested: false,
      moderator: PROVIDER_AGENT,
    }));
    const { result } = renderHook(() => useHumanlessHireFlow<typeof flowJobSpec>(), {
      wrapper: wrapper({
        network: "localnet",
        client,
        queryTransport: mockReadTransport(),
      }),
    });

    await expect(
      result.current.hireAndActivate({
        hire: flowHire,
        jobSpec: flowJobSpec,
        hostAndModerateJobSpec,
      }),
    ).rejects.toThrow(/not attested/);

    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.progress.taskPda).toBeTruthy();
    expect(result.current.progress.hireSignature).toBe("sig-humanless");
    expect(result.current.progress.jobSpecHash).toBeNull();
    expect(client.setTaskJobSpec).not.toHaveBeenCalled();
  });

  it("rejects invalid moderation hash and empty URI before activation", async () => {
    const invalidHashClient = stubClient();
    const invalidHashHost = vi.fn(async () => ({
      jobSpecHash: new Uint8Array(31),
      jobSpecUri: "https://example.test/specs/invalid-hash.json",
      moderationAttested: true,
      moderator: PROVIDER_AGENT,
    }));
    const invalidHash = renderHook(() => useHumanlessHireFlow<typeof flowJobSpec>(), {
      wrapper: wrapper({
        network: "localnet",
        client: invalidHashClient,
        queryTransport: mockReadTransport(),
      }),
    });

    await expect(
      invalidHash.result.current.hireAndActivate({
        hire: flowHire,
        jobSpec: flowJobSpec,
        hostAndModerateJobSpec: invalidHashHost,
      }),
    ).rejects.toThrow(/invalid jobSpecHash/);
    expect(invalidHashClient.setTaskJobSpec).not.toHaveBeenCalled();

    const emptyUriClient = stubClient();
    const emptyUriHost = vi.fn(async () => ({
      jobSpecHash: flowHash,
      jobSpecUri: "   ",
      moderationAttested: true,
      moderator: PROVIDER_AGENT,
    }));
    const emptyUri = renderHook(() => useHumanlessHireFlow<typeof flowJobSpec>(), {
      wrapper: wrapper({
        network: "localnet",
        client: emptyUriClient,
        queryTransport: mockReadTransport(),
      }),
    });

    await expect(
      emptyUri.result.current.hireAndActivate({
        hire: flowHire,
        jobSpec: flowJobSpec,
        hostAndModerateJobSpec: emptyUriHost,
      }),
    ).rejects.toThrow(/empty jobSpecUri/);
    expect(emptyUriClient.setTaskJobSpec).not.toHaveBeenCalled();
  });

  it("preserves moderation progress when activation signing fails", async () => {
    const activationError = new AgencError("activation failed", { code: 7001 });
    const client = stubClient({
      setTaskJobSpec: vi.fn(async () => {
        throw activationError;
      }),
    });
    const hostAndModerateJobSpec = vi.fn(async () => ({
      jobSpecHash: flowHash,
      jobSpecUri: "https://example.test/specs/activation-fail.json",
      moderationAttested: true,
      moderator: PROVIDER_AGENT,
    }));
    const { result } = renderHook(() => useHumanlessHireFlow<typeof flowJobSpec>(), {
      wrapper: wrapper({
        network: "localnet",
        client,
        queryTransport: mockReadTransport(),
      }),
    });

    await expect(
      result.current.hireAndActivate({
        hire: flowHire,
        jobSpec: flowJobSpec,
        hostAndModerateJobSpec,
      }),
    ).rejects.toBe(activationError);

    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.progress.taskPda).toBeTruthy();
    expect(result.current.progress.hireSignature).toBe("sig-humanless");
    expect(result.current.progress.jobSpecHash).toBe(flowHash);
    expect(result.current.progress.jobSpecUri).toBe(
      "https://example.test/specs/activation-fail.json",
    );
    expect(result.current.progress.activationSignature).toBeNull();
  });

  it("rejects overlapping flow runs so recovery state cannot mix paid hires", async () => {
    let resolveHost:
      | ((value: {
          jobSpecHash: Uint8Array;
          jobSpecUri: string;
          moderationAttested: true;
          moderator: typeof PROVIDER_AGENT;
        }) => void)
      | undefined;
    const client = stubClient();
    const hostAndModerateJobSpec = vi.fn(
      () =>
        new Promise<{
          jobSpecHash: Uint8Array;
          jobSpecUri: string;
          moderationAttested: true;
          moderator: typeof PROVIDER_AGENT;
        }>((resolve) => {
          resolveHost = resolve;
        }),
    );
    const { result } = renderHook(() => useHumanlessHireFlow<typeof flowJobSpec>(), {
      wrapper: wrapper({
        network: "localnet",
        client,
        queryTransport: mockReadTransport(),
      }),
    });

    const first = result.current.hireAndActivate({
      hire: flowHire,
      jobSpec: flowJobSpec,
      hostAndModerateJobSpec,
    });
    await waitFor(() => expect(result.current.phase).toBe("moderating"));

    await expect(
      result.current.hireAndActivate({
        hire: { ...flowHire, taskId: new Uint8Array(32).fill(10) },
        jobSpec: flowJobSpec,
        hostAndModerateJobSpec,
      }),
    ).rejects.toThrow(/already in progress/);

    expect(client.hireFromListingHumanless).toHaveBeenCalledTimes(1);
    expect(resolveHost).toBeTypeOf("function");
    resolveHost?.({
      jobSpecHash: flowHash,
      jobSpecUri: "https://example.test/specs/overlap.json",
      moderationAttested: true,
      moderator: PROVIDER_AGENT,
    });
    await expect(first).resolves.toMatchObject({
      activationSignature: "sig-activate",
    });
  });

  it("errors clearly when no write client is configured", async () => {
    const { result } = renderHook(() => useHumanlessHireFlow<typeof flowJobSpec>(), {
      wrapper: wrapper({ network: "localnet", queryTransport: mockReadTransport() }),
    });

    await expect(
      result.current.hireAndActivate({
        hire: flowHire,
        jobSpec: flowJobSpec,
        hostAndModerateJobSpec: vi.fn(),
      }),
    ).rejects.toThrowError(/No write client/);
    await waitFor(() => expect(result.current.phase).toBe("idle"));
  });

  it("reset clears progress and result", async () => {
    const client = stubClient();
    const hostAndModerateJobSpec = vi.fn(async () => ({
      jobSpecHash: flowHash,
      jobSpecUri: "https://example.test/specs/reset.json",
      moderationAttested: true,
      moderator: PROVIDER_AGENT,
    }));
    const { result } = renderHook(() => useHumanlessHireFlow<typeof flowJobSpec>(), {
      wrapper: wrapper({
        network: "localnet",
        client,
        queryTransport: mockReadTransport(),
      }),
    });

    await result.current.hireAndActivate({
      hire: flowHire,
      jobSpec: flowJobSpec,
      hostAndModerateJobSpec,
    });
    await waitFor(() => expect(result.current.phase).toBe("activated"));

    act(() => result.current.reset());

    expect(result.current.phase).toBe("idle");
    expect(result.current.result).toBeNull();
    expect(result.current.progress).toMatchObject({
      taskPda: null,
      hireSignature: null,
      activationSignature: null,
      jobSpecHash: null,
      jobSpecUri: null,
      referrerInjected: false,
    });
  });
});

// ----------------------------------------------------------------------------
// useSubmissionReview
// ----------------------------------------------------------------------------
describe("useSubmissionReview", () => {
  const TASK = PROVIDER_AGENT;

  it("accept calls client.acceptTaskResult with the bound task + default signer", async () => {
    const client = stubClient();
    const { result } = renderHook(() => useSubmissionReview(TASK), {
      wrapper: wrapper({
        network: "localnet",
        client,
        queryTransport: mockReadTransport(),
      }),
    });
    const sig = await result.current.accept({
      worker: PROVIDER_AGENT,
      treasury: address(VALID_WALLET),
      workerAuthority: address(VALID_WALLET),
    } as never);
    expect(sig).toBe("sig-accept");
    const passed = (client.acceptTaskResult as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(passed.task).toBe(TASK);
    expect(passed.creator).toBe(client.signer);
  });

  it("reject builds a facade ix and sends it", async () => {
    const client = stubClient();
    const { result } = renderHook(() => useSubmissionReview(TASK), {
      wrapper: wrapper({
        network: "localnet",
        client,
        queryTransport: mockReadTransport(),
      }),
    });
    const sig = await result.current.reject({
      worker: PROVIDER_AGENT,
      claim: PROVIDER_AGENT,
      workerAuthority: address(VALID_WALLET),
      rejectionHash: new Uint8Array(32).fill(3),
    } as never);
    expect(sig).toBe("sig-send");
    expect(client.send).toHaveBeenCalledTimes(1);
  });
});

// ----------------------------------------------------------------------------
// useTaskStatus (reader seam, terminal stop)
// ----------------------------------------------------------------------------
describe("useTaskStatus", () => {
  it("reads task status through the injected reader", async () => {
    const task = {
      status: TaskStatus.Completed,
      result: new Uint8Array(0),
    } as unknown as Task;
    const reader = vi.fn(async () => task);
    const { result } = renderHook(
      () => useTaskStatus(PROVIDER_AGENT, { taskReader: reader }),
      { wrapper: wrapper({ network: "localnet", queryTransport: mockReadTransport() }) },
    );
    await waitFor(() => expect(result.current.status).toBe(TaskStatus.Completed));
    expect(result.current.task).toBe(task);
    expect(result.current.submission).toBeNull();
  });

  it("surfaces the submission result bytes when present", async () => {
    const resultBytes = new Uint8Array(8).fill(9);
    const task = {
      status: TaskStatus.PendingValidation,
      result: resultBytes,
    } as unknown as Task;
    const reader = vi.fn(async () => task);
    const { result } = renderHook(
      () => useTaskStatus(PROVIDER_AGENT, { taskReader: reader }),
      { wrapper: wrapper({ network: "localnet", queryTransport: mockReadTransport() }) },
    );
    await waitFor(() => expect(result.current.submission).not.toBeNull());
    expect(Array.from(result.current.submission!)).toEqual(Array.from(resultBytes));
  });

  it("stays idle without a reader", () => {
    const { result } = renderHook(() => useTaskStatus(PROVIDER_AGENT), {
      wrapper: wrapper({ network: "localnet", queryTransport: mockReadTransport() }),
    });
    expect(result.current.task).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// useDispute
// ----------------------------------------------------------------------------
describe("useDispute", () => {
  it("reads the dispute via the reader and initiate calls the client", async () => {
    const dispute = { status: 0 } as unknown as Dispute;
    const reader = vi.fn(async () => dispute);
    const client = stubClient();
    const { result } = renderHook(
      () => useDispute(PROVIDER_AGENT, { disputeReader: reader }),
      {
        wrapper: wrapper({
          network: "localnet",
          client,
          queryTransport: mockReadTransport(),
        }),
      },
    );
    await waitFor(() => expect(result.current.dispute).toBe(dispute));
    const sig = await result.current.initiate({
      agent: PROVIDER_AGENT,
      disputeId: new Uint8Array(32).fill(1),
      taskId: new Uint8Array(32).fill(2),
      evidenceHash: new Uint8Array(32).fill(3),
      resolutionType: 0,
      evidence: "x",
    } as never);
    expect(sig).toBe("sig-dispute");
    expect(client.initiateDispute).toHaveBeenCalledTimes(1);
  });
});

// ----------------------------------------------------------------------------
// useWalletSigner
// ----------------------------------------------------------------------------
describe("useWalletSigner", () => {
  it("falls back to the provider signer when no adapter is passed", () => {
    const signer = createNoopSigner(address(VALID_WALLET));
    const { result } = renderHook(() => useWalletSigner(), {
      wrapper: wrapper({
        network: "localnet",
        signer,
        queryTransport: mockReadTransport(),
      }),
    });
    expect(result.current.signer).toBe(signer);
    expect(result.current.connected).toBe(true);
  });

  it("prefers the adapter signer + connected flag", () => {
    const adapterSigner = createNoopSigner(address(String(PROVIDER_AGENT)));
    const connect = vi.fn();
    const { result } = renderHook(
      () =>
        useWalletSigner({
          adapter: { signer: adapterSigner, connected: true, connect },
        }),
      { wrapper: wrapper({ network: "localnet", queryTransport: mockReadTransport() }) },
    );
    expect(result.current.signer).toBe(adapterSigner);
    expect(result.current.connected).toBe(true);
    result.current.connect();
    expect(connect).toHaveBeenCalled();
  });

  it("reports not connected when neither adapter nor provider signer exists", () => {
    const { result } = renderHook(() => useWalletSigner(), {
      wrapper: wrapper({ network: "localnet", queryTransport: mockReadTransport() }),
    });
    expect(result.current.signer).toBeNull();
    expect(result.current.connected).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// useReferrerEarnings (indexer gate)
// ----------------------------------------------------------------------------
describe("useReferrerEarnings (P3.8 earnings endpoint)", () => {
  // The wire fixture mirrors the deployed endpoint's shape — ground-truthed
  // against the cross-node canary's on-chain referrer leg (125,000 lamports).
  const wire = {
    live: true,
    wallet: VALID_WALLET,
    leg: "referrer",
    totalLamports: "125000",
    hires: [
      {
        taskPda: "CQwmEWVirRgq2hxurJgCtouQsxA5YTdHFXi2uhrDWYWJ",
        hireRecordPda: String(PROVIDER_AGENT),
        feeLamports: "125000",
        signature: "",
        settledAtUnix: 1_780_000_000,
        feeBps: 250,
      },
    ],
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches + parses live earnings from the hosted default on mainnet", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => wire,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useReferrerEarnings(VALID_WALLET), {
      wrapper: wrapper({
        network: "mainnet",
        queryTransport: mockReadTransport(),
        referrer: { wallet: VALID_WALLET, feeBps: 250 },
      }),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.live).toBe(true);
    expect(result.current.totalLamports).toBe(125_000n);
    expect(result.current.hires).toHaveLength(1);
    expect(result.current.hires[0]!.feeLamports).toBe(125_000n);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.agenc.ag/api/explorer/referrers/${VALID_WALLET}/hires`,
      expect.anything(),
    );
  });

  it("prefers a configured indexer.baseUrl over the hosted default", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("/api/explorer/referrers/")
        ? { ok: true, status: 200, json: async () => wire }
        : { ok: true, status: 200, json: async () => ({ items: [] }) },
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useReferrerEarnings(VALID_WALLET), {
      wrapper: wrapper({
        network: "mainnet",
        indexer: { baseUrl: "https://indexer.example" },
        referrer: { wallet: VALID_WALLET, feeBps: 250 },
      }),
    });
    await waitFor(() => expect(result.current.live).toBe(true));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `https://indexer.example/api/explorer/referrers/${VALID_WALLET}/hires`,
        expect.anything(),
      ),
    );
  });

  it("returns the not-live zero state with NO request when no endpoint resolves (localnet)", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useReferrerEarnings(VALID_WALLET), {
      wrapper: wrapper({
        network: "localnet",
        queryTransport: mockReadTransport(),
        referrer: { wallet: VALID_WALLET, feeBps: 250 },
      }),
    });
    expect(result.current.live).toBe(false);
    expect(result.current.totalLamports).toBe(0n);
    expect(result.current.hires).toEqual([]);
    expect(result.current.reason).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never fabricates on a failed fetch — zeros + surfaced error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })),
    );
    const { result } = renderHook(() => useReferrerEarnings(VALID_WALLET), {
      wrapper: wrapper({
        network: "mainnet",
        queryTransport: mockReadTransport(),
        referrer: { wallet: VALID_WALLET, feeBps: 250 },
      }),
    });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.totalLamports).toBe(0n);
    expect(result.current.hires).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// query keys
// ----------------------------------------------------------------------------
describe("queryKeys", () => {
  it("namespaces and structures keys", () => {
    expect(queryKeys.listings({ category: "x" })).toEqual([
      "agenc",
      "listings",
      { category: "x" },
    ]);
    expect(queryKeys.listing("abc")).toEqual(["agenc", "listing", "abc"]);
  });
});
