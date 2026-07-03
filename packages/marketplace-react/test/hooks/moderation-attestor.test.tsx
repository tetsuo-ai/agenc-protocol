/**
 * WP-A1 activation wiring — the roster `moderation_attestor` account.
 *
 * Post-A1 the publish gate accepts roster-attested task moderation ONLY when
 * the attestor's roster-entry PDA is attached to `set_task_job_spec`. The
 * hooks must resolve + attach it automatically when the recorded moderation
 * was authored by a roster attestor (the default when the activation backend
 * is the public attestation service), and omit it for global-authority
 * moderation.
 *
 * REVERT-SENSITIVE: against the pre-fix hooks (which never attached the
 * account) the "attaches" cases fail — that gap made every roster-attested
 * store activation fail on-chain with UNAUTHORIZED_TASK_MODERATOR (found by
 * the 2026-07-02 cross-node canary).
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
  taskModeration: null as null | { moderator: string },
  moderationConfig: null as null | { moderationAuthority: string },
}));

vi.mock("@tetsuo-ai/marketplace-sdk", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tetsuo-ai/marketplace-sdk")>();
  return {
    ...actual,
    fetchMaybeTaskModeration: vi.fn(async (_rpc: unknown, addr: unknown) =>
      chain.taskModeration
        ? { exists: true, address: addr, data: chain.taskModeration }
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
  findModerationAttestorPda,
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

beforeEach(() => {
  chain.taskModeration = null;
  chain.moderationConfig = null;
});

describe("useTaskActivation — WP-A1 roster attestor resolution", () => {
  function render(client: MarketplaceClient) {
    return renderHook(() => useTaskActivation(TASK_PDA), {
      wrapper: wrapper({
        network: "localnet",
        client,
        queryTransport: mockReadTransport(),
      }),
    });
  }

  it("attaches the roster moderation_attestor account when the moderation was authored by a roster attestor", async () => {
    chain.taskModeration = { moderator: ROSTER_ATTESTOR };
    chain.moderationConfig = { moderationAuthority: GLOBAL_AUTHORITY };
    const client = stubClient();
    const { result } = render(client);

    await result.current.activate({
      jobSpecHash: JOB_SPEC_HASH,
      jobSpecUri: "https://example.test/spec.json",
    });

    const call = (client.setTaskJobSpec as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(call.moderationAttestor).toBe(await expectedRosterPda());
  });

  it("omits the account for global-authority moderation", async () => {
    chain.taskModeration = { moderator: GLOBAL_AUTHORITY };
    chain.moderationConfig = { moderationAuthority: GLOBAL_AUTHORITY };
    const client = stubClient();
    const { result } = render(client);

    await result.current.activate({
      jobSpecHash: JOB_SPEC_HASH,
      jobSpecUri: "https://example.test/spec.json",
    });

    const call = (client.setTaskJobSpec as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(call.moderationAttestor).toBeUndefined();
  });

  it("omits the account when no TaskModeration is recorded", async () => {
    const client = stubClient();
    const { result } = render(client);

    await result.current.activate({
      jobSpecHash: JOB_SPEC_HASH,
      jobSpecUri: "https://example.test/spec.json",
    });

    const call = (client.setTaskJobSpec as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(call.moderationAttestor).toBeUndefined();
  });

  it("a caller-supplied moderationAttestor wins over resolution", async () => {
    chain.taskModeration = { moderator: ROSTER_ATTESTOR };
    chain.moderationConfig = { moderationAuthority: GLOBAL_AUTHORITY };
    const client = stubClient();
    const { result } = render(client);
    const explicit = address(CREATOR_WALLET);

    await result.current.activate({
      jobSpecHash: JOB_SPEC_HASH,
      jobSpecUri: "https://example.test/spec.json",
      moderationAttestor: explicit,
    });

    const call = (client.setTaskJobSpec as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(call.moderationAttestor).toBe(explicit);
  });
});

describe("useHumanlessHireFlow — WP-A1 roster attestor resolution", () => {
  it("attaches the roster account at the activation phase (the cross-node canary regression)", async () => {
    chain.taskModeration = { moderator: ROSTER_ATTESTOR };
    chain.moderationConfig = { moderationAuthority: GLOBAL_AUTHORITY };
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
      },
      jobSpec: { title: "cross-node canary" },
      hostAndModerateJobSpec: vi.fn(async () => ({
        jobSpecHash: JOB_SPEC_HASH,
        jobSpecUri: "https://example.test/spec.json",
        moderationAttested: true,
        moderation: { verdict: "clean" },
      })),
    });

    const [taskPda] = await findTaskPda({
      creator: address(CREATOR_WALLET),
      taskId,
    });
    const call = (client.setTaskJobSpec as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(call.task).toBe(taskPda);
    expect(call.moderationAttestor).toBe(await expectedRosterPda());
  });
});
