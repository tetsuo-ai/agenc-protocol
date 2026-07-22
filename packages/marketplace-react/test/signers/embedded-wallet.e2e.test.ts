// @vitest-environment node
/**
 * PART D DONE-WHEN (PLAN_2 D-1): a buyer with NO wallet and NO SOL completes a
 * real hire via the embedded-wallet path against localnet (litesvm).
 *
 * The buyer is provisioned by `createMockEmbeddedWallet()` — the vendor-neutral
 * stand-in for Privy/Dynamic/Web3Auth — funded ONLY by a localnet airdrop
 * (exactly what a real embedded-wallet harness does behind the scenes), then
 * lifted into the SDK client via `signerFromEmbeddedWallet()`. The hire/claim/
 * settle flow then runs on the REAL compiled agenc-coordination program through
 * `startLocalMarketplace()`. No vendor SDK, no RPC, no browser.
 *
 * This is the runnable proof of the walletless seam; the fiat leg (D-2) is NOT
 * part of this Done-when. The Wallet Standard bridge has its own structural
 * proof in `wallet-account.test.ts`.
 *
 * litesvm is an optional peer of `@tetsuo-ai/marketplace-sdk/testing`; it is a
 * devDependency at the workspace root here. The node-only environment is set by
 * the docblock above so the litesvm native module loads (jsdom is the default).
 */
import { lamports, type Address } from "@solana/kit";
import {
  facade,
  findAgentPda,
  findHireRecordPda,
  findTaskPda,
  getTaskDecoder,
  TaskStatus,
} from "@tetsuo-ai/marketplace-sdk";
import {
  startLocalMarketplace,
  type LocalMarketplace,
} from "@tetsuo-ai/marketplace-sdk/testing";
import { describe, expect, it } from "vitest";
import { signerFromEmbeddedWallet } from "../../src/signers/index.js";
// The test-only MOCK lives behind the ./testing subpath, not the signers barrel.
import { createMockEmbeddedWallet } from "../../src/testing/index.js";

function accountData(
  market: LocalMarketplace,
  addr: Address,
): Uint8Array | null {
  const account = market.svm.getAccount(addr);
  if (!account || !account.exists) return null;
  return Uint8Array.from(account.data);
}

describe("e2e: walletless buyer completes a hire via the embedded-wallet path", () => {
  it("provisions an embedded wallet, airdrop-funds it, and settles a real hire", async () => {
    const market = await startLocalMarketplace();

    // The WORKER is an ordinary sandbox wallet.
    const provider = await market.fundedSigner();
    const providerClient = market.clientFor(provider);

    // ---- THE WALLETLESS BUYER ----
    // No pre-existing wallet: an embedded-wallet "email login" provisions one.
    const embedded = createMockEmbeddedWallet();
    expect(embedded.isConnected()).toBe(false);
    const connection = await embedded.connect();
    const buyerAddress = connection.address as Address;

    // It starts with ZERO SOL — assert that, then fund it ONLY via the localnet
    // airdrop, exactly as the Part D harness funds a freshly created wallet.
    expect(market.svm.getBalance(buyerAddress) ?? 0n).toBe(0n);
    market.svm.airdrop(buyerAddress, lamports(100_000_000_000n));
    expect(market.svm.getBalance(buyerAddress) ?? 0n).toBeGreaterThan(0n);

    // Bridge the embedded connection into the kit signer the SDK client expects
    // and bind a client to it — the buyer NEVER touched a browser wallet.
    const buyerSigner = signerFromEmbeddedWallet(connection);
    expect(buyerSigner.address).toBe(buyerAddress);
    const buyerClient = market.clientFor(buyerSigner);

    // 1) register the provider (worker) agent and the buyer (embedded) agent.
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

    const buyerAgentId = new Uint8Array(32).fill(22);
    await buyerClient.registerAgent({
      authority: buyerSigner,
      agentId: buyerAgentId,
      capabilities: 1n,
      endpoint: "http://buyer.test",
      metadataUri: null,
      stakeAmount: 0n,
    });
    const [buyerAgent] = await findAgentPda({ agentId: buyerAgentId });

    // 2) provider lists a service.
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

    // 3) CLEAN listing attestation (the sandbox moderator) so the hire gate passes.
    await market.moderator.attestListing(listing, listingSpecHash);

    // 4) THE WALLETLESS HIRE: the embedded buyer signs + pays for the hire ix.
    const taskId = new Uint8Array(32).fill(44);
    const jobSpecHash = new Uint8Array(32).fill(55);
    await buyerClient.hireFromListing({
      listing,
      providerAgent,
      creatorAgent: buyerAgent,
      authority: buyerSigner,
      creator: buyerSigner,
      taskId,
      expectedPrice: price,
      expectedVersion: 1n,
      listingSpecHash,
      taskJobSpecHash: jobSpecHash,
      // P1.2: the hire gate consumes the named moderator's record.
      moderator: market.moderator.address,
    });
    const [task] = await findTaskPda({ creator: buyerAddress, taskId });
    expect(getTaskDecoder().decode(accountData(market, task)!).status).toBe(
      TaskStatus.Open,
    );

    // 5) CLEAN task attestation + job-spec pin (claim is gated on both).
    await market.moderator.attestTask(task, jobSpecHash);
    await buyerClient.send([
      await facade.setTaskJobSpec({
        task,
        creator: buyerSigner,
        jobSpecHash,
        jobSpecUri: "agenc://job-spec/sha256/x",
        // P1.2: the publish gate consumes the named moderator's record.
        moderator: market.moderator.address,
      }),
    ]);

    // 6) provider claims the hired task -> InProgress.
    await providerClient.claimTaskWithJobSpec({
      task,
      worker: providerAgent,
      authority: provider,
      jobSpecHash,
    });
    expect(getTaskDecoder().decode(accountData(market, task)!).status).toBe(
      TaskStatus.InProgress,
    );

    // 7) provider settles on the direct-pay path (no completion bonds: the
    //    listing did not require them). The sandbox admin is the treasury.
    const workerBalBefore = market.svm.getBalance(provider.address) ?? 0n;
    const [hireRecord] = await findHireRecordPda({ task });
    await providerClient.send([
      await facade.completeTask({
        task,
        creator: buyerAddress,
        worker: providerAgent,
        treasury: market.admin.address,
        authority: provider,
        hireRecord,
        proofHash: new Uint8Array(32).fill(66),
        resultData: null,
      }),
    ]);

    // ---- REAL on-chain assertions: the walletless buyer's hire settled ----
    expect(getTaskDecoder().decode(accountData(market, task)!).status).toBe(
      TaskStatus.Completed,
    );
    // The worker was paid the reward out of the escrow the embedded buyer funded.
    expect(market.svm.getBalance(provider.address) ?? 0n).toBeGreaterThan(
      workerBalBefore,
    );
  });
});
