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
 * - the P6.2 gate: useHire never injects a referrer and useReferrerEarnings
 *   returns the not-live zero state regardless of configured referrer;
 * - useTaskStatus / useDispute read via their injected reader seam.
 */
import { address, createNoopSigner } from "@solana/kit";
import {
  AgencError,
  TaskStatus,
  type Dispute,
  type IndexerAgentTrackRecord,
  type ServiceListing,
  type Task,
} from "@tetsuo-ai/marketplace-sdk";
import { QueryClient } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
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
    acceptTaskResult: vi.fn(async () => ({ signature: "sig-accept", logs: [] })),
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
// useHire (the P6.2 gate)
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

  it("NEVER injects a referrer (P6.2 gate): referrerInjected is false even with referrer configured", async () => {
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
    expect(res.referrerInjected).toBe(false);
    // The input passed to the client must carry NO referrer field.
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
// useReferrerEarnings (STRICT P6.2 gate)
// ----------------------------------------------------------------------------
describe("useReferrerEarnings (P6.2 gate)", () => {
  it("returns the not-live zero state and makes no request", () => {
    const { result } = renderHook(() => useReferrerEarnings(VALID_WALLET), {
      wrapper: wrapper({
        network: "mainnet",
        queryTransport: mockReadTransport(),
        referrer: { wallet: VALID_WALLET, feeBps: 250 },
      }),
    });
    expect(result.current.live).toBe(false);
    expect(result.current.totalLamports).toBe(0n);
    expect(result.current.hires).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.reason).toBeTruthy();
  });

  it("never fabricates earnings even with a configured referrer wallet", () => {
    const { result } = renderHook(() => useReferrerEarnings(PROVIDER_AGENT), {
      wrapper: wrapper({
        network: "mainnet",
        queryTransport: mockReadTransport(),
        referrer: { wallet: String(PROVIDER_AGENT), feeBps: 1000 },
      }),
    });
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
