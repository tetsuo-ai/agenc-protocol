import { address, createNoopSigner } from "@solana/kit";
import { QueryClient } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AgencProvider, type MarketplaceClient, type ReadTransport } from "../../src/index.js";
import { useCompletionBond, useSubmissionReview, useTaskLifecycle, useTaskWork } from "../../src/hooks/index.js";

const SIGNER = address("11111111111111111111111111111111");
const TASK = address("So11111111111111111111111111111111111111112");

function readTransport(): ReadTransport {
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
  };
}

function client(overrides: Partial<MarketplaceClient> = {}): MarketplaceClient {
  return {
    signer: createNoopSigner(SIGNER),
    transport: {} as MarketplaceClient["transport"],
    send: vi.fn(async () => ({ signature: "sig-send", logs: [] })),
    acceptTaskResult: vi.fn(async () => ({
      signature: "sig-accept",
      logs: [],
    })),
    postCompletionBond: vi.fn(async () => ({
      signature: "sig-post",
      logs: [],
    })),
    reclaimCompletionBond: vi.fn(async () => ({
      signature: "sig-reclaim",
      logs: [],
    })),
    cancelTask: vi.fn(async () => ({ signature: "sig-cancel", logs: [] })),
    closeTask: vi.fn(async () => ({ signature: "sig-close", logs: [] })),
    autoAcceptTaskResult: vi.fn(async () => ({
      signature: "sig-auto-accept",
      logs: [],
    })),
    claimTaskWithJobSpec: vi.fn(async () => ({
      signature: "sig-claim",
      logs: [],
    })),
    submitTaskResult: vi.fn(async () => ({
      signature: "sig-submit",
      logs: [],
    })),
    ...overrides,
  } as unknown as MarketplaceClient;
}

function wrapper(writeClient: MarketplaceClient) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AgencProvider
        config={{
          network: "localnet",
          client: writeClient,
          queryTransport: readTransport(),
        }}
        queryClient={queryClient}
      >
        {children}
      </AgencProvider>
    );
  };
}

const ACCEPT_INPUT = {
  worker: TASK,
  treasury: SIGNER,
  workerAuthority: SIGNER,
} as never;

const REJECT_INPUT = {
  worker: TASK,
  claim: TASK,
  workerAuthority: SIGNER,
  rejectionHash: new Uint8Array(32).fill(7),
} as never;

describe("latest action state for multi-mutation hooks", () => {
  describe("useSubmissionReview", () => {
    it("reports a later failure after an earlier success", async () => {
      const boom = new Error("reject failed");
      const writeClient = client({
        send: vi.fn(async () => {
          throw boom;
        }),
      });
      const { result } = renderHook(() => useSubmissionReview(TASK), {
        wrapper: wrapper(writeClient),
      });

      await result.current.accept(ACCEPT_INPUT);
      await expect(result.current.reject(REJECT_INPUT)).rejects.toBe(boom);

      await waitFor(() => expect(result.current.status).toBe("error"));
      expect(result.current.error).toBe(boom);
      expect(result.current.signature).toBeNull();
    });

    it("reports a later success after an earlier failure", async () => {
      const boom = new Error("accept failed");
      const writeClient = client({
        acceptTaskResult: vi.fn(async () => {
          throw boom;
        }),
      });
      const { result } = renderHook(() => useSubmissionReview(TASK), {
        wrapper: wrapper(writeClient),
      });

      await expect(result.current.accept(ACCEPT_INPUT)).rejects.toBe(boom);
      await result.current.reject(REJECT_INPUT);

      await waitFor(() => expect(result.current.status).toBe("success"));
      expect(result.current.error).toBeNull();
      expect(result.current.signature).toBe("sig-send");
    });
  });

  describe("useCompletionBond", () => {
    it("reports a later failure after an earlier success", async () => {
      const boom = new Error("reclaim failed");
      const writeClient = client({
        reclaimCompletionBond: vi.fn(async () => {
          throw boom;
        }),
      });
      const { result } = renderHook(() => useCompletionBond(TASK), {
        wrapper: wrapper(writeClient),
      });

      await result.current.post({ role: 1 });
      await expect(result.current.reclaim({ role: 1 })).rejects.toBe(boom);

      await waitFor(() => expect(result.current.status).toBe("error"));
      expect(result.current.error).toBe(boom);
      expect(result.current.signature).toBeNull();
    });

    it("reports a later success after an earlier failure", async () => {
      const boom = new Error("post failed");
      const writeClient = client({
        postCompletionBond: vi.fn(async () => {
          throw boom;
        }),
      });
      const { result } = renderHook(() => useCompletionBond(TASK), {
        wrapper: wrapper(writeClient),
      });

      await expect(result.current.post({ role: 1 })).rejects.toBe(boom);
      await result.current.reclaim({ role: 1 });

      await waitFor(() => expect(result.current.status).toBe("success"));
      expect(result.current.error).toBeNull();
      expect(result.current.signature).toBe("sig-reclaim");
    });
  });

  describe("useTaskLifecycle", () => {
    it("reports a later failure after an earlier success", async () => {
      const boom = new Error("close failed");
      const writeClient = client({
        closeTask: vi.fn(async () => {
          throw boom;
        }),
      });
      const { result } = renderHook(() => useTaskLifecycle(TASK), {
        wrapper: wrapper(writeClient),
      });

      await result.current.cancel();
      await expect(result.current.close()).rejects.toBe(boom);

      await waitFor(() => expect(result.current.status).toBe("error"));
      expect(result.current.error).toBe(boom);
      expect(result.current.signature).toBeNull();
    });

    it("reports a later success after an earlier failure", async () => {
      const boom = new Error("cancel failed");
      const writeClient = client({
        cancelTask: vi.fn(async () => {
          throw boom;
        }),
      });
      const { result } = renderHook(() => useTaskLifecycle(TASK), {
        wrapper: wrapper(writeClient),
      });

      await expect(result.current.cancel()).rejects.toBe(boom);
      await result.current.close();

      await waitFor(() => expect(result.current.status).toBe("success"));
      expect(result.current.error).toBeNull();
      expect(result.current.signature).toBe("sig-close");
    });
  });

  describe("useTaskWork", () => {
    it("reports a later failure after an earlier success", async () => {
      const boom = new Error("submit failed");
      const writeClient = client({
        submitTaskResult: vi.fn(async () => {
          throw boom;
        }),
      });
      const { result } = renderHook(() => useTaskWork(TASK), {
        wrapper: wrapper(writeClient),
      });

      await result.current.claim({} as never);
      await expect(result.current.submit({} as never)).rejects.toBe(boom);

      await waitFor(() => expect(result.current.status).toBe("error"));
      expect(result.current.error).toBe(boom);
      expect(result.current.signature).toBeNull();
    });

    it("reports a later success after an earlier failure", async () => {
      const boom = new Error("claim failed");
      const writeClient = client({
        claimTaskWithJobSpec: vi.fn(async () => {
          throw boom;
        }),
      });
      const { result } = renderHook(() => useTaskWork(TASK), {
        wrapper: wrapper(writeClient),
      });

      await expect(result.current.claim({} as never)).rejects.toBe(boom);
      await result.current.submit({} as never);

      await waitFor(() => expect(result.current.status).toBe("success"));
      expect(result.current.error).toBeNull();
      expect(result.current.signature).toBe("sig-submit");
    });
  });
});
