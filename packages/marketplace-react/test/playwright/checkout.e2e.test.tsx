// @vitest-environment jsdom
/**
 * The A3 checkout Done-when, jsdom fallback: the `<CheckoutFlow>` fixture
 * component completes a REAL hire funded -> accepted against the live
 * solana-test-validator booted by `test/sandbox-up.mjs` — the SAME component the
 * Playwright spec drives in a real browser, exercised here headlessly so the
 * proof always runs even when browser binaries are unavailable.
 *
 * The browser cannot run the Node SDK worker side; here `onHired` runs it inline
 * (the harness) between the buyer's hire and accept, exactly as the Playwright
 * harness does over the window bridge. Both prove the identical on-chain path:
 *   useHire().hire(humanless)  ->  [worker: moderate/jobspec/claim/submit]  ->
 *   useSubmissionReview().accept()  ->  Task Completed + escrow paid to worker.
 *
 * This local-validator integration is intentionally excluded from the default
 * unit suite. Run it with `AGENC_REACT_LOCALNET_E2E=1`; an enabled run fails
 * hard when its validator/.so prerequisites or bootstrap fail.
 */
import * as kit from "@solana/kit";
import {
  createMarketplaceClient,
  findProtocolConfigPda,
  fetchMaybeProtocolConfig,
  getTaskDecoder,
  TaskStatus,
  type Task,
} from "@tetsuo-ai/marketplace-sdk";
import { QueryClient } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { readFile } from "node:fs/promises";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { useCallback, useState } from "react";
import {
  AgencProvider,
  createReadTransport,
  signerFromEmbeddedWallet,
  type AgencProviderConfig,
  type Address,
} from "../../src/index.js";
// The test-only MOCK lives behind the ./testing subpath, not the root barrel.
import { createMockEmbeddedWallet } from "../../src/testing/index.js";
import { useHire, useSubmissionReview } from "../../src/hooks/index.js";
import type { CheckoutConfig } from "../../test-apps/checkout/src/CheckoutFlow.js";
import {
  start,
  stop,
  readSandboxEnv,
  recordedValidatorMayBeLive,
} from "../sandbox-up.mjs";
import {
  registerLocalnetLifecycle,
  sandboxDisposition,
} from "../localnet-e2e-gate.js";
import { completeWorkerSide, fetchListing } from "./worker-harness.mjs";

const LAMPORTS_PER_SOL = 1_000_000_000n;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

interface Ready {
  rpcUrl: string;
  config: CheckoutConfig;
  buyerSigner: ReturnType<typeof signerFromEmbeddedWallet>;
  rpc: ReturnType<typeof kit.createSolanaRpc>;
  workerKeys: { seeder: string; moderator: string };
}

let ready: Ready | null = null;
let ownsSandbox = false;

async function airdrop(
  rpc: ReturnType<typeof kit.createSolanaRpc>,
  addr: string,
) {
  // requestAirdrop is a test-cluster RPC method not on the default all-clusters
  // type; the localnet validator implements it, so call it through a cast.
  await (
    rpc as unknown as {
      requestAirdrop: (
        a: ReturnType<typeof kit.address>,
        l: ReturnType<typeof kit.lamports>,
      ) => { send: () => Promise<unknown> };
    }
  )
    .requestAirdrop(kit.address(addr), kit.lamports(2n * LAMPORTS_PER_SOL))
    .send();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { value } = await rpc.getBalance(kit.address(addr)).send();
    if (BigInt(value) >= LAMPORTS_PER_SOL) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`airdrop to ${addr} did not land`);
}

async function rpcHealthy(rpcUrl: string): Promise<boolean> {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      signal: AbortSignal.timeout(2000),
    });
    const body = (await res.json()) as { result?: string };
    return body.result === "ok";
  } catch {
    return false;
  }
}

async function setupCheckoutSandbox() {
  try {
    // Reuse a running sandbox only when it is healthy, seeded, and loaded with
    // the current repo-built program binary.
    let env = await readSandboxEnv();
    const healthy = env !== null && (await rpcHealthy(env.rpcUrl));
    const usable =
      env !== null &&
      env.fixtures !== null &&
      env.keypairs !== null &&
      env.programCurrent;
    const disposition = sandboxDisposition({
      healthy,
      usable,
      recordedProcessMayBeLive: await recordedValidatorMayBeLive(),
    });
    if (disposition === "create") {
      // An explicitly enabled integration run owns a fresh disposable ledger.
      // Production binaries correctly begin paused; the browser fixture uses
      // the narrow test-only genesis override rather than trying to seed the
      // production-paused configuration.
      await stop({ purge: true, removeState: true, quiet: true });
      ownsSandbox = true;
      env = await start({
        quiet: true,
        devReady: true,
        disposable: true,
      });
    }
    if (env.fixtures === null || env.keypairs === null) {
      throw new Error(
        "sandbox is up but not seeded (fixtures/keypairs missing)",
      );
    }
    const { fixtures, keypairs } = env;
    const rpcUrl = env.rpcUrl;
    const rpc = kit.createSolanaRpc(rpcUrl);

    const listingEntry = fixtures.listings[0];
    if (listingEntry === undefined) throw new Error("no seeded listings");
    const listing = await fetchListing(rpc, kit, listingEntry.address);

    // Buyer wallet (the walletless embedded-wallet seam) + funding.
    const conn = await createMockEmbeddedWallet().connect();
    const buyerSigner = signerFromEmbeddedWallet(conn);
    await airdrop(rpc, String(buyerSigner.address));

    // Treasury from ProtocolConfig (accept needs it).
    const [pcPda] = await findProtocolConfigPda();
    const pc = await fetchMaybeProtocolConfig(rpc, pcPda);
    if (!pc.exists) throw new Error("ProtocolConfig missing on the sandbox");

    const config: CheckoutConfig = {
      listing: listingEntry.address,
      listingSpecHashHex: hex(Uint8Array.from(listing.specHash)),
      expectedPriceLamports: listing.price.toString(),
      expectedVersion: listing.version.toString(),
      reviewWindowSecs: "3600",
      workerAgent: listingEntry.provider,
      // The seeder is the provider authority -> the worker authority paid on accept.
      workerAuthority: "", // filled after the worker side resolves it
      treasury: String(pc.data.treasury),
      // P1.2: the hire gate consumes the sandbox moderation authority's
      // listing attestation — derive its pubkey from the moderator keypair.
      moderator: String(
        (
          await kit.createKeyPairSignerFromBytes(
            Uint8Array.from(
              JSON.parse(await readFile(keypairs.moderator, "utf8")),
            ),
          )
        ).address,
      ),
    };

    ready = {
      rpcUrl,
      config,
      buyerSigner,
      rpc,
      workerKeys: { seeder: keypairs.seeder, moderator: keypairs.moderator },
    };
  } catch (error) {
    if (ownsSandbox) {
      await stop({ purge: true, removeState: true, quiet: true });
      ownsSandbox = false;
    }
    throw error;
  }
}

async function teardownCheckoutSandbox() {
  if (!ownsSandbox) return;
  await stop({ purge: true, removeState: true, quiet: true });
  ownsSandbox = false;
}

function wrap(children: ReactNode, config: AgencProviderConfig) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <AgencProvider config={config} queryClient={queryClient}>
      {children}
    </AgencProvider>
  );
}

/**
 * Inline mirror of `test-apps/checkout/src/CheckoutFlow.tsx`, kept in lockstep
 * with it. We render the mirror (not the literal component) ONLY to avoid the
 * second React copy in the checkout app's node_modules pulling a duplicate
 * dispatcher into the parent vitest — the hook path (useHire -> humanless hire,
 * useSubmissionReview -> accept) is identical. The LITERAL `<CheckoutFlow>` is
 * driven against a real browser by the Playwright spec (single React there).
 */
function hexToBytes(h: string): Uint8Array {
  const clean = h.startsWith("0x") ? h.slice(2) : h;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function CheckoutFlow({
  config,
  onHired,
}: {
  config: CheckoutConfig;
  onHired: (taskPda: string) => Promise<void>;
}) {
  const hire = useHire();
  const [taskPda, setTaskPda] = useState<string | null>(null);
  const [workerReady, setWorkerReady] = useState(false);
  const [phase, setPhase] = useState<"idle" | "hiring" | "worker" | "hired">(
    "idle",
  );
  const review = useSubmissionReview((taskPda ?? "") as Address);

  const onHire = useCallback(async () => {
    setPhase("hiring");
    const result = await hire.hire({
      humanless: true,
      listing: config.listing as Address,
      providerAgent: config.workerAgent as Address,
      taskId: crypto.getRandomValues(new Uint8Array(32)),
      expectedPrice: BigInt(config.expectedPriceLamports),
      expectedVersion: BigInt(config.expectedVersion),
      reviewWindowSecs: BigInt(config.reviewWindowSecs),
      listingSpecHash: hexToBytes(config.listingSpecHashHex),
      moderator: config.moderator as Address,
    } as Parameters<typeof hire.hire>[0]);
    setTaskPda(String(result.taskPda));
    setPhase("worker");
    await onHired(String(result.taskPda));
    setWorkerReady(true);
    setPhase("hired");
  }, [hire, config, onHired]);

  const onAccept = useCallback(async () => {
    await review.accept({
      worker: config.workerAgent as Address,
      treasury: config.treasury as Address,
      workerAuthority: config.workerAuthority as Address,
    } as Parameters<typeof review.accept>[0]);
  }, [review, config]);

  return (
    <div>
      <p data-testid="checkout-phase">{phase}</p>
      <p data-testid="hire-status">{hire.status}</p>
      {hire.error ? <p data-testid="hire-error">{hire.error.message}</p> : null}
      <button
        data-testid="hire-button"
        onClick={onHire}
        disabled={hire.isPending || taskPda !== null}
      >
        Hire
      </button>
      {taskPda ? <p data-testid="task-pda">{taskPda}</p> : null}
      <button
        data-testid="accept-button"
        onClick={onAccept}
        disabled={!workerReady || review.status === "pending"}
      >
        Accept
      </button>
      <p data-testid="review-status">{review.status}</p>
      {review.signature ? (
        <p data-testid="accept-signature">{review.signature}</p>
      ) : null}
      {review.error ? (
        <p data-testid="review-error">{review.error.message}</p>
      ) : null}
    </div>
  );
}

describe.skipIf(process.env.AGENC_REACT_LOCALNET_E2E !== "1")(
  "A3 checkout (jsdom): CheckoutFlow completes a real hire funded -> accepted",
  () => {
    registerLocalnetLifecycle(
      process.env.AGENC_REACT_LOCALNET_E2E === "1",
      { beforeAll, afterAll },
      { setup: setupCheckoutSandbox, teardown: teardownCheckoutSandbox },
    );
    afterEach(() => cleanup());

    it("hires, the worker submits, the buyer accepts, and the task settles Completed", async () => {
      if (ready === null)
        throw new Error("sandbox beforeAll did not initialize");
      const { rpcUrl, rpc, config, workerKeys, buyerSigner } = ready;

      // Build the buyer write client WITHOUT rpcSubscriptions so the SDK confirms
      // via getSignatureStatuses POLLING, not a ws:// channel — jsdom's WebSocket
      // is not the EventTarget the kit subscriptions channel needs. (The real
      // browser, driven by Playwright, has a native WebSocket and uses the
      // provider's default rpcUrl+signer path with WS confirmation.) The client
      // override slot is the same public seam startLocalMarketplace().client uses.
      const buyerClient = createMarketplaceClient({
        rpc: kit.createSolanaRpc(rpcUrl),
        signer: buyerSigner,
      });
      const providerConfig: AgencProviderConfig = {
        network: "localnet",
        client: buyerClient,
        queryTransport: createReadTransport({
          rpc: kit.createSolanaRpc(rpcUrl),
        }),
      };

      // The inline worker side: run the Node harness between hire and accept, and
      // backfill the worker authority into the config so accept settles correctly.
      let workerAuthority = "";
      const onHired = async (taskPda: string) => {
        const res = await completeWorkerSide({
          kit,
          rpcUrl,
          taskPda,
          workerAgentPda: config.workerAgent,
          seederKeyPath: workerKeys.seeder,
          moderatorKeyPath: workerKeys.moderator,
          buyerSigner,
        });
        workerAuthority = res.workerAuthority;
      };

      // The component needs workerAuthority before the buyer accepts; resolve it
      // from the seeder key up front (it is deterministic for the seeded provider).
      const seederBytes = Uint8Array.from(
        JSON.parse(await readFile(workerKeys.seeder, "utf8")),
      );
      const seeder = await kit.createKeyPairSignerFromBytes(seederBytes);
      const runConfig: CheckoutConfig = {
        ...config,
        workerAuthority: String(seeder.address),
      };

      render(
        wrap(
          <CheckoutFlow config={runConfig} onHired={onHired} />,
          providerConfig,
        ),
      );

      // ---- BUYER: click Hire ----
      await act(async () => {
        fireEvent.click(screen.getByTestId("hire-button"));
      });

      // Hire succeeds, worker harness runs, phase reaches "hired" (workerReady).
      await waitFor(
        () =>
          expect(screen.getByTestId("checkout-phase").textContent).toBe(
            "hired",
          ),
        { timeout: 60_000 },
      );
      const taskPda = screen.getByTestId("task-pda").textContent!;
      expect(taskPda.length).toBeGreaterThan(30);
      expect(workerAuthority).toBe(String(seeder.address));

      // The task is PendingValidation on-chain (worker submitted).
      const decode = async (pda: string): Promise<Task | null> => {
        const info = await rpc
          .getAccountInfo(kit.address(pda), { encoding: "base64" })
          .send();
        if (!info.value) return null;
        return getTaskDecoder().decode(
          Uint8Array.from(Buffer.from(info.value.data[0], "base64")),
        ) as Task;
      };
      const pending = await decode(taskPda);
      expect(pending?.status).toBe(TaskStatus.PendingValidation);

      const workerBalBefore = (await rpc.getBalance(seeder.address).send())
        .value;

      // ---- BUYER: click Accept ----
      await act(async () => {
        fireEvent.click(screen.getByTestId("accept-button"));
      });
      await waitFor(
        () =>
          expect(screen.getByTestId("review-status").textContent).toBe(
            "success",
          ),
        { timeout: 30_000 },
      );
      expect(
        screen.getByTestId("accept-signature").textContent!.length,
      ).toBeGreaterThan(30);

      // ---- REAL on-chain assertions: task Completed + worker paid ----
      const completed = await decode(taskPda);
      expect(completed?.status).toBe(TaskStatus.Completed);
      const workerBalAfter = (await rpc.getBalance(seeder.address).send())
        .value;
      expect(BigInt(workerBalAfter)).toBeGreaterThan(BigInt(workerBalBefore));
    }, 180_000);
  },
);
