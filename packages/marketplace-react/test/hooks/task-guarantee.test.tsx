/**
 * WP-H3 Guaranteed Hire hooks — useTaskGuarantee + useCompletionBond.
 *
 * - useTaskGuarantee reads through the injected `guaranteeReader` seam (same
 *   contract as useTaskStatus/useDispute), and — when no seam is injected —
 *   through the provider's resolved `rpcUrl` via the SDK `fetchTaskGuarantee`
 *   (mocked at the module seam, like moderation-attestor.test.tsx: no RPC or
 *   network is involved).
 * - useCompletionBond drives the write client's named bond methods with the
 *   task bound at hook construction, the post `authority` defaulted to the
 *   client signer, and the reclaim `party` defaulted to the signer's address.
 *
 * REVERT-SENSITIVE: `guaranteed` must key off the WORKER bond — against a
 * variant that flags any live bond (e.g. creator-only) the "creator bond alone
 * is not a guarantee" case goes red; against a client missing the
 * `reclaimCompletionBond` parity method the reclaim case crashes.
 */
import { address, createNoopSigner } from "@solana/kit";
import { QueryClient } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const chain = vi.hoisted(() => ({
  /** The guarantee fetchTaskGuarantee resolves for the rpcUrl default path. */
  guarantee: null as null | {
    guaranteed: boolean;
    workerBond: unknown;
    creatorBond: unknown;
  },
  calls: [] as Array<{ task: string }>,
}));

vi.mock("@tetsuo-ai/marketplace-sdk", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tetsuo-ai/marketplace-sdk")>();
  return {
    ...actual,
    fetchTaskGuarantee: vi.fn(async (_source: unknown, task: unknown) => {
      chain.calls.push({ task: String(task) });
      return (
        chain.guarantee ?? {
          guaranteed: false,
          workerBond: null,
          creatorBond: null,
        }
      );
    }),
  };
});

import type { TaskGuarantee } from "@tetsuo-ai/marketplace-sdk";
import {
  AgencProvider,
  type AgencProviderConfig,
  type MarketplaceClient,
  type ReadTransport,
} from "../../src/index.js";
import {
  useCompletionBond,
  useTaskGuarantee,
} from "../../src/hooks/index.js";

const SIGNER_WALLET = "11111111111111111111111111111111";
const TASK_PDA = address("So11111111111111111111111111111111111111112");
const WORKER_BOND_PDA = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");

function guaranteeFixture(overrides: Partial<TaskGuarantee> = {}): TaskGuarantee {
  return {
    guaranteed: true,
    workerBond: {
      address: WORKER_BOND_PDA,
      account: {
        task: TASK_PDA,
        party: address(SIGNER_WALLET),
        role: 1,
        amount: 1_000_000n,
      },
    } as unknown as NonNullable<TaskGuarantee["workerBond"]>,
    creatorBond: null,
    ...overrides,
  };
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

function stubClient(): MarketplaceClient {
  return {
    signer: createNoopSigner(address(SIGNER_WALLET)),
    transport: {} as MarketplaceClient["transport"],
    postCompletionBond: vi.fn(async () => ({
      signature: "sig-post-bond",
      logs: [],
    })),
    reclaimCompletionBond: vi.fn(async () => ({
      signature: "sig-reclaim-bond",
      logs: [],
    })),
  } as unknown as MarketplaceClient;
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

beforeEach(() => {
  chain.guarantee = null;
  chain.calls = [];
  vi.clearAllMocks();
});

describe("useTaskGuarantee", () => {
  it("reads through the injected guaranteeReader seam and surfaces guaranteed:true", async () => {
    const reader = vi.fn(async () => guaranteeFixture());
    const { result } = renderHook(
      () => useTaskGuarantee(TASK_PDA, { guaranteeReader: reader }),
      { wrapper: wrapper({ queryTransport: mockReadTransport() }) },
    );
    await waitFor(() => expect(result.current.guarantee).not.toBeNull());
    expect(reader).toHaveBeenCalledWith(TASK_PDA);
    expect(result.current.guaranteed).toBe(true);
    expect(result.current.guarantee?.workerBond?.address).toBe(
      WORKER_BOND_PDA,
    );
    expect(result.current.error).toBeNull();
  });

  it("REVERT-SENSITIVE: a creator bond alone is not a guarantee (worker bond keys the flag)", async () => {
    const reader = vi.fn(async () =>
      guaranteeFixture({
        guaranteed: false,
        workerBond: null,
        creatorBond: {
          address: WORKER_BOND_PDA,
          account: { role: 0 },
        } as unknown as NonNullable<TaskGuarantee["creatorBond"]>,
      }),
    );
    const { result } = renderHook(
      () => useTaskGuarantee(TASK_PDA, { guaranteeReader: reader }),
      { wrapper: wrapper({ queryTransport: mockReadTransport() }) },
    );
    await waitFor(() => expect(result.current.guarantee).not.toBeNull());
    expect(result.current.guaranteed).toBe(false);
    expect(result.current.guarantee?.creatorBond).not.toBeNull();
  });

  it("defaults to the provider rpcUrl read path (SDK fetchTaskGuarantee) when no seam is injected", async () => {
    chain.guarantee = guaranteeFixture();
    const { result } = renderHook(() => useTaskGuarantee(TASK_PDA), {
      wrapper: wrapper({
        network: "localnet",
        queryTransport: mockReadTransport(),
      }),
    });
    await waitFor(() => expect(result.current.guarantee).not.toBeNull());
    expect(chain.calls).toEqual([{ task: String(TASK_PDA) }]);
    expect(result.current.guaranteed).toBe(true);
  });

  it("stays idle when disabled or when no task is given", async () => {
    const reader = vi.fn(async () => guaranteeFixture());
    const disabled = renderHook(
      () =>
        useTaskGuarantee(TASK_PDA, { guaranteeReader: reader, enabled: false }),
      { wrapper: wrapper({ queryTransport: mockReadTransport() }) },
    );
    const taskless = renderHook(
      () => useTaskGuarantee(null, { guaranteeReader: reader }),
      { wrapper: wrapper({ queryTransport: mockReadTransport() }) },
    );
    expect(disabled.result.current.guarantee).toBeNull();
    expect(disabled.result.current.guaranteed).toBe(false);
    expect(taskless.result.current.guarantee).toBeNull();
    expect(reader).not.toHaveBeenCalled();
  });
});

describe("useCompletionBond", () => {
  it("post: binds the task and defaults the bonding authority to the client signer", async () => {
    const client = stubClient();
    const { result } = renderHook(() => useCompletionBond(TASK_PDA), {
      wrapper: wrapper({ client, queryTransport: mockReadTransport() }),
    });
    const sig = await result.current.post({ role: 1 });
    expect(sig).toBe("sig-post-bond");
    expect(client.postCompletionBond).toHaveBeenCalledWith(
      expect.objectContaining({
        task: TASK_PDA,
        role: 1,
        authority: client.signer,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("success"));
    expect(result.current.signature).toBe("sig-post-bond");
  });

  it("reclaim: binds the task and defaults party to the signer's address (the posting wallet)", async () => {
    const client = stubClient();
    const { result } = renderHook(() => useCompletionBond(TASK_PDA), {
      wrapper: wrapper({ client, queryTransport: mockReadTransport() }),
    });
    const sig = await result.current.reclaim({ role: 1 });
    expect(sig).toBe("sig-reclaim-bond");
    expect(client.reclaimCompletionBond).toHaveBeenCalledWith(
      expect.objectContaining({
        task: TASK_PDA,
        role: 1,
        party: client.signer.address,
      }),
    );
  });

  it("surfaces client errors untouched and reset returns to idle", async () => {
    const client = stubClient();
    const boom = new Error("BOND_ALREADY_POSTED");
    (client.postCompletionBond as ReturnType<typeof vi.fn>).mockRejectedValue(
      boom,
    );
    const { result } = renderHook(() => useCompletionBond(TASK_PDA), {
      wrapper: wrapper({ client, queryTransport: mockReadTransport() }),
    });
    await expect(result.current.post({ role: 1 })).rejects.toBe(boom);
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe(boom);
    result.current.reset();
    await waitFor(() => expect(result.current.status).toBe("idle"));
  });

  it("errors clearly (no crash) when the provider has no write client", async () => {
    const { result } = renderHook(() => useCompletionBond(TASK_PDA), {
      wrapper: wrapper({ queryTransport: mockReadTransport() }),
    });
    await expect(result.current.post({ role: 1 })).rejects.toThrow();
  });
});
