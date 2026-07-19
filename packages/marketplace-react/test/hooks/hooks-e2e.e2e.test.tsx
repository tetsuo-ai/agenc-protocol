// @vitest-environment jsdom
/**
 * E2E: the full hire -> review -> accept flow driven THROUGH HOOKS ALONE
 * against the REAL compiled agenc-coordination program in litesvm, via the A1
 * `client` + `queryTransport` override slots (PLAN_2 A2 Done-when).
 *
 * No RPC, no validator, no network: `startLocalMarketplace()` boots the program
 * in-process and hands back `clientFor(signer)` clients that plug straight into
 * `<AgencProvider config={{ client }}>`, and a `queryTransport` `ReadTransport`
 * backed by litesvm `getAccount` + the SDK decoders feeds the read hooks
 * (litesvm has no `getProgramAccounts`, so the read transport is implemented
 * over known PDAs — the same `queryTransport` seam mocks use, but here over the
 * REAL on-chain bytes).
 *
 * The buyer-facing flow is exercised with NO direct SDK call:
 *   - `useListings()` / `useListing()` -> read the real listing bytes
 *   - `useHire()`                      -> mints the Task (the hire)
 *   - `useTaskStatus()`                -> observes on-chain status transitions
 *   - `useSubmissionReview().accept()` -> settles the escrow to the worker
 *
 * The worker-side claim/submit and the provider listing/moderation setup are NOT
 * A2 hooks (no claim/submit hook exists in the inventory), so they are done with
 * the SDK as test scaffolding.
 */
import {
  facade,
  findAgentPda,
  findTaskPda,
  getServiceListingDecoder,
  getTaskDecoder,
  TaskStatus,
  type Task,
  type ServiceListing,
} from "@tetsuo-ai/marketplace-sdk";
import { startLocalMarketplace } from "@tetsuo-ai/marketplace-sdk/testing";
import type { LocalMarketplace } from "@tetsuo-ai/marketplace-sdk/testing";
import { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import {
  AgencProvider,
  ReadTransportUnsupportedError,
  type AgencProviderConfig,
  type DecodedProgramAccount,
  type ReadListingResult,
  type ReadTransport,
} from "../../src/index.js";
import {
  useHire,
  useListing,
  useListings,
  useSubmissionReview,
  useTaskStatus,
  type TaskReader,
} from "../../src/hooks/index.js";

/** Read raw account bytes from litesvm, or null when absent/empty. */
function svmBytes(market: LocalMarketplace, pda: string): Uint8Array | null {
  const acct = market.svm.getAccount(pda as Parameters<typeof market.svm.getAccount>[0]);
  if (!acct || acct.exists !== true || acct.data.length === 0) return null;
  return Uint8Array.from(acct.data);
}

/** Decode a ServiceListing from a litesvm account, or throw if absent. */
function decodeListing(market: LocalMarketplace, pda: string): ServiceListing {
  const data = svmBytes(market, pda);
  if (data === null) throw new Error(`listing ${pda} not found in svm`);
  return getServiceListingDecoder().decode(data);
}

/**
 * A `ReadTransport` over litesvm, backed by an explicit listing-PDA registry
 * (litesvm has no `getProgramAccounts`). This is the same public `queryTransport`
 * seam mocks use — but every byte here is the REAL on-chain account.
 */
function svmReadTransport(
  market: LocalMarketplace,
  listingPdas: string[],
): ReadTransport {
  const rows = (): Array<DecodedProgramAccount<ServiceListing>> =>
    listingPdas.map((pda) => ({
      address: pda as never,
      account: decodeListing(market, pda),
    }));
  return {
    kind: "gpa",
    listActiveListings: async () => rows(),
    getListing: async (pda): Promise<ReadListingResult> => ({
      address: String(pda) as never,
      account: decodeListing(market, String(pda)),
    }),
    listingHires: async () => [],
    // gPA-style transport: the aggregated track record has no trustless gPA
    // equivalent, so this throws the typed unsupported error — useListing
    // degrades it to a null trackRecord (the documented behavior).
    agentTrackRecord: async () => {
      throw new ReadTransportUnsupportedError("agentTrackRecord");
    },
  };
}

/** Build a litesvm-backed task reader for useTaskStatus. */
function svmTaskReader(market: LocalMarketplace): TaskReader {
  return async (pda) => {
    const data = svmBytes(market, String(pda));
    if (data === null) return null;
    return getTaskDecoder().decode(data) as Task;
  };
}

function makeWrapper(config: AgencProviderConfig) {
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

describe("e2e (hooks-only): hire -> review -> accept on the real program", () => {
  let market: LocalMarketplace;

  beforeAll(async () => {
    market = await startLocalMarketplace();
  });

  it("the buyer reads, hires, watches status, and accepts — paying the worker, all via hooks", async () => {
    // ---- Scaffolding (SDK directly; NOT the buyer flow under test) ----
    const provider = await market.fundedSigner(); // worker wallet
    const buyer = await market.fundedSigner(); // creator/hiring wallet
    const providerClient = market.clientFor(provider);
    const buyerClient = market.clientFor(buyer);

    const providerAgentId = new Uint8Array(32).fill(11);
    await providerClient.registerAgent({
      authority: provider,
      agentId: providerAgentId,
      capabilities: 1n,
      endpoint: "http://provider.test",
      metadataUri: null,
      stakeAmount: 0n,
    });
    const [providerAgent] = await findAgentPda({ agentId: providerAgentId });

    // The buyer is a plain wallet (NO registered agent) — the storefront-visitor
    // (humanless) path, which pins CreatorReview so the buyer reviews via hooks.

    const listingId = new Uint8Array(32).fill(33);
    const listingSpecHash = new Uint8Array(32).fill(7);
    const price = 1_000_000n;
    await providerClient.createServiceListing({
      providerAgent,
      authority: provider,
      listingId,
      name: new Uint8Array(32).fill(1),
      category: new Uint8Array(32).fill(2),
      tags: new Uint8Array(64).fill(3),
      specHash: listingSpecHash,
      specUri: "agenc://job-spec/sha256/test",
      price,
      priceMint: null,
      requiredCapabilities: 1n,
      defaultDeadlineSecs: 3600n,
      maxOpenJobs: 0,
      operator: null,
      operatorFeeBps: 0,
    });
    const [listing] = await facade.findListingPda({ providerAgent, listingId });
    await market.moderator.attestListing(listing, listingSpecHash);

    // Buyer's provider: write client = buyerClient, read = litesvm transport.
    const buyerConfig: AgencProviderConfig = {
      network: "localnet",
      client: buyerClient,
      queryTransport: svmReadTransport(market, [String(listing)]),
    };

    // ===================================================================
    // READ HOOKS e2e: useListings + useListing over the real listing bytes.
    // ===================================================================
    const { result: listGrid } = renderHook(() => useListings(), {
      wrapper: makeWrapper(buyerConfig),
    });
    await waitFor(() => expect(listGrid.current.isLoading).toBe(false));
    expect(listGrid.current.total).toBe(1);
    expect(String(listGrid.current.listings[0]!.address)).toBe(String(listing));
    expect(listGrid.current.listings[0]!.account.price).toBe(price);

    const { result: detail } = renderHook(() => useListing(listing), {
      wrapper: makeWrapper(buyerConfig),
    });
    await waitFor(() => expect(detail.current.isLoading).toBe(false));
    expect(detail.current.listing?.price).toBe(price);
    expect(detail.current.provider).toBe(providerAgent);

    // ===================================================================
    // useHire() — the BUYER hires via the hook.
    // ===================================================================
    const { result: hireHook } = renderHook(() => useHire(), {
      wrapper: makeWrapper(buyerConfig),
    });

    const taskId = new Uint8Array(32).fill(44);
    let hireResult!: {
      signature: string;
      taskPda: string;
      referrerInjected: boolean;
    };
    await act(async () => {
      hireResult = (await hireHook.current.hire({
        humanless: true,
        listing,
        providerAgent,
        taskId,
        expectedPrice: price,
        expectedVersion: 1n,
        reviewWindowSecs: 3600n,
        listingSpecHash,
        // P1.2: the hire gate consumes the named moderator's record.
        moderator: market.moderator.address,
      } as never)) as never;
    });
    // No provider referrer configured in this e2e path, so no referrer injected.
    expect(hireResult.referrerInjected).toBe(false);
    expect(hireResult.signature).toBeTruthy();

    const [task] = await findTaskPda({ creator: buyer.address, taskId });
    expect(String(hireResult.taskPda)).toBe(String(task));

    // ===================================================================
    // useTaskStatus() — observe the Open task.
    // ===================================================================
    const reader = svmTaskReader(market);
    const statusConfig: AgencProviderConfig = { ...buyerConfig };
    const { result: statusHook } = renderHook(
      () => useTaskStatus(task, { taskReader: reader, pollIntervalMs: 50 }),
      { wrapper: makeWrapper(statusConfig) },
    );
    await waitFor(() => expect(statusHook.current.status).toBe(TaskStatus.Open));

    // ---- Scaffolding: moderate task, publish job spec, claim, submit ----
    // The humanless hire already pinned CreatorReview + initialized the
    // validation config, so the submit -> accept review path is ready; no
    // separate configure_task_validation is needed (and would be rejected).
    const jobHash = new Uint8Array(32).fill(55);
    await market.moderator.attestTask(task, jobHash);
    await buyerClient.send([
      await facade.setTaskJobSpec({
        task,
        creator: buyer,
        jobSpecHash: jobHash,
        jobSpecUri: "agenc://job-spec/sha256/x",
        // P1.2: the publish gate consumes the named moderator's record.
        moderator: market.moderator.address,
      }),
    ]);
    await providerClient.claimTaskWithJobSpec({
      task,
      worker: providerAgent,
      authority: provider,
      jobSpecHash: jobHash,
    });
    await providerClient.submitTaskResult({
      task,
      worker: providerAgent,
      authority: provider,
      proofHash: new Uint8Array(32).fill(66),
      resultData: new Uint8Array(64).fill(9),
    });

    // useTaskStatus reflects PendingValidation after a refetch. (On the review
    // path the worker's result lives in the TaskSubmission account, not
    // Task.result, so `submission` — which projects Task.result — is null here;
    // it is populated on the worker-completion path. The status transition is
    // the proof the submit landed.)
    await act(async () => {
      await statusHook.current.refetch();
    });
    await waitFor(() =>
      expect(statusHook.current.status).toBe(TaskStatus.PendingValidation),
    );

    // ===================================================================
    // useSubmissionReview().accept — the BUYER accepts via the hook.
    // ===================================================================
    const workerBalBefore = market.svm.getBalance(provider.address) ?? 0n;

    const { result: reviewHook } = renderHook(() => useSubmissionReview(task), {
      wrapper: makeWrapper(buyerConfig),
    });
    await act(async () => {
      await reviewHook.current.accept({
        worker: providerAgent,
        treasury: market.admin.address,
        workerAuthority: provider.address,
      } as never);
    });
    expect(reviewHook.current.status).toBe("success");
    expect(reviewHook.current.signature).toBeTruthy();

    // ===================================================================
    // REAL on-chain assertions (the hook flow actually settled).
    // ===================================================================
    await act(async () => {
      await statusHook.current.refetch();
    });
    await waitFor(() =>
      expect(statusHook.current.status).toBe(TaskStatus.Completed),
    );

    const workerBalAfter = market.svm.getBalance(provider.address) ?? 0n;
    expect(workerBalAfter).toBeGreaterThan(workerBalBefore);
  });
});
