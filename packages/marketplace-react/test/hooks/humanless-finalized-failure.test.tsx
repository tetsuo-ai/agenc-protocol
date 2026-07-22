import { address, createNoopSigner, getBase58Decoder } from "@solana/kit";
import { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const orchestration = vi.hoisted(() => ({
  hire: vi.fn(),
  resume: vi.fn(),
}));

vi.mock("@tetsuo-ai/marketplace-sdk", async () => {
  const actual = await vi.importActual<
    typeof import("@tetsuo-ai/marketplace-sdk")
  >("@tetsuo-ai/marketplace-sdk");
  return {
    ...actual,
    hireAndActivate: orchestration.hire,
    resumeHireAndActivate: orchestration.resume,
  };
});

import {
  HireAndActivateFinalizedFailure,
  type HireAndActivateProgress,
} from "@tetsuo-ai/marketplace-sdk";
import { AgencProvider, type MarketplaceClient } from "../../src/index.js";
import { useHumanlessHireFlow } from "../../src/hooks/index.js";

const WALLET = address("11111111111111111111111111111111");
const LISTING = address("So11111111111111111111111111111111111111112");
const TASK = address("SysvarC1ock11111111111111111111111111111111");
const SIGNATURE = getBase58Decoder().decode(new Uint8Array(64).fill(7));
const HASH = new Uint8Array(32).fill(9);

function wrapper(client: MarketplaceClient) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AgencProvider
        config={{
          network: "mainnet",
          client,
          indexer: { baseUrl: "https://example.test" },
        }}
        queryClient={queryClient}
      >
        {children}
      </AgencProvider>
    );
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("useHumanlessHireFlow finalized failure recovery", () => {
  it("clears the stale recovery token and permits a corrected fresh retry", async () => {
    const client = {
      signer: createNoopSigner(WALLET),
    } as unknown as MarketplaceClient;
    const input = {
      hire: {
        listing: LISTING,
        providerAgent: LISTING,
        taskId: new Uint8Array(32).fill(1),
        expectedPrice: 1n,
        expectedVersion: 1n,
        reviewWindowSecs: 3_600n,
        listingSpecHash: new Uint8Array(32).fill(2),
        taskJobSpecHash: HASH,
        moderator: LISTING,
      },
      jobSpec: null,
      hostAndModerateJobSpec: vi.fn(),
    };
    const recovery: HireAndActivateProgress = {
      phase: "hiring",
      taskPda: TASK,
      candidateSignature: SIGNATURE,
      hireIntentDigest: "ab".repeat(32),
    };
    const finalizedFailure = new HireAndActivateFinalizedFailure(SIGNATURE, {
      InstructionError: [0, "Custom"],
    });
    orchestration.resume.mockRejectedValueOnce(finalizedFailure);
    orchestration.hire.mockResolvedValueOnce({
      taskPda: TASK,
      hireSignature: SIGNATURE,
      activationSignature: SIGNATURE,
      jobSpecHash: HASH,
      jobSpecUri: "agenc://job-spec/sha256/retry",
    });

    const { result } = renderHook(() => useHumanlessHireFlow(), {
      wrapper: wrapper(client),
    });
    let observed: unknown;
    await act(async () => {
      observed = await result.current
        .resumeHireAndActivate(input, recovery)
        .catch((error: unknown) => error);
    });

    expect(observed).toBe(finalizedFailure);
    expect(finalizedFailure.retrySafe).toBe(true);
    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.progress.recovery).toBeNull();
    expect(result.current.progress.taskPda).toBeNull();

    await act(async () => {
      await result.current.hireAndActivate(input);
    });
    expect(orchestration.resume).toHaveBeenCalledTimes(1);
    expect(orchestration.hire).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("activated");
  });

  it("snapshots resume input and recovery before the mutation microtask", async () => {
    const client = {
      signer: createNoopSigner(WALLET),
    } as unknown as MarketplaceClient;
    const taskId = new Uint8Array(32).fill(0x21);
    const listingSpecHash = new Uint8Array(32).fill(0x22);
    const taskJobSpecHash = new Uint8Array(32).fill(0x23);
    const jobSpec = { nested: { prompt: "entry snapshot" } };
    const input = {
      hire: {
        listing: LISTING,
        providerAgent: LISTING,
        taskId,
        expectedPrice: 1n,
        expectedVersion: 1n,
        reviewWindowSecs: 3_600n,
        listingSpecHash,
        taskJobSpecHash,
        moderator: LISTING,
      },
      jobSpec,
      hostAndModerateJobSpec: vi.fn(),
    };
    const recovery = {
      phase: "activating" as const,
      taskPda: TASK,
      hireSignature: SIGNATURE,
      hireIntentDigest: "cd".repeat(32),
      jobSpecHash: new Uint8Array(taskJobSpecHash),
      jobSpecUri: "agenc://job-spec/sha256/entry-snapshot",
      moderator: LISTING,
    } satisfies HireAndActivateProgress;
    let observedInput: typeof input | undefined;
    let observedRecovery: HireAndActivateProgress | undefined;
    orchestration.resume.mockImplementationOnce(async (...args: unknown[]) => {
      observedInput = args[1] as typeof input;
      observedRecovery = args[2] as HireAndActivateProgress;
      return {
        taskPda: TASK,
        hireSignature: SIGNATURE,
        activationSignature: SIGNATURE,
        jobSpecHash: new Uint8Array(32).fill(0x23),
        jobSpecUri: "agenc://job-spec/sha256/entry-snapshot",
      };
    });

    const { result } = renderHook(
      () => useHumanlessHireFlow<typeof jobSpec>(),
      {
        wrapper: wrapper(client),
      },
    );
    await act(async () => {
      const running = result.current.resumeHireAndActivate(input, recovery);
      taskId.fill(0xff);
      listingSpecHash.fill(0xfe);
      taskJobSpecHash.fill(0xfd);
      jobSpec.nested.prompt = "mutated";
      recovery.jobSpecHash.fill(0xfc);
      recovery.jobSpecUri = "agenc://job-spec/sha256/mutated";
      await running;
    });

    expect(observedInput?.hire.taskId).toEqual(new Uint8Array(32).fill(0x21));
    expect(observedInput?.hire.listingSpecHash).toEqual(
      new Uint8Array(32).fill(0x22),
    );
    expect(observedInput?.hire.taskJobSpecHash).toEqual(
      new Uint8Array(32).fill(0x23),
    );
    expect(observedInput?.jobSpec).toEqual({
      nested: { prompt: "entry snapshot" },
    });
    expect(observedRecovery).toMatchObject({
      phase: "activating",
      jobSpecUri: "agenc://job-spec/sha256/entry-snapshot",
    });
    if (observedRecovery?.phase !== "activating") {
      throw new Error("expected activating recovery snapshot");
    }
    expect(observedRecovery.jobSpecHash).toEqual(new Uint8Array(32).fill(0x23));
  });
});
