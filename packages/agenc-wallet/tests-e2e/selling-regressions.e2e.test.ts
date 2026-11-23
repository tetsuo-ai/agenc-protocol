import { afterEach, expect, it } from "vitest";
import type { Address } from "@solana/kit";
import { getServiceListingEncoder, getUpdateServiceListingDiscriminatorBytes, values } from "@tetsuo-ai/marketplace-sdk";
import { loadState } from "@tetsuo-ai/agenc-worker";
import { connectWallet } from "../src/client/socket-client.js";
import { serveWallet } from "../src/server.js";
import { readListing } from "../src/market.js";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { startWorld, eventually, setEarnWithApproval, setOfferWithApproval, type World } from "./harness.js";

let world: World | null = null;
afterEach(async () => { await world?.wallet.close(); world = null; });
const EARN = {
  executor: { argv: [process.execPath, "-e", "process.stdout.write('done')", "{prompt}"], mode: "sandboxed" as const, envAllowlist: [], timeoutMs: 10000 },
  pollIntervalMs: 100,
  checkExecutionReady: async () => { throw new Error("unready"); },
};

it("preserves APPROVAL_REQUIRED when earn.set exceeds the automatic cap over the socket", async () => {
  world = await startWorld({ earn: EARN });
  const agent = await world.wallet.createAgent();
  const token = "a".repeat(40);
  const socketPath = path.join(world.dataDir, "s.sock");
  const server = await serveWallet({ wallet: world.wallet, socketPath, ownerToken: token, agentExists: () => true });
  const owner = await connectWallet({ socketPath, token });
  try {
    await expect(owner.call("earn.set", { agentId: agent.id, enabled: true })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED", message: expect.stringMatching(/approval/) });
  } finally {
    owner.close();
    await server.close();
  }
});

it("pauses a legacy unlimited listing with two hires across restart and rejects a third in LiteSVM", async () => {
  world = await startWorld({ earn: EARN });
  const { sandbox } = world;
  let wallet = world.wallet;
  const seller = await wallet.createAgent("Seller");
  const buyer = await wallet.createAgent("Buyer");
  await setEarnWithApproval(wallet, seller.id, true, 10);
  await setOfferWithApproval(wallet, seller.id, { name: "Writer", summary: "A friendly line", price: { usdCents: 30 } });
  const offer = await eventually(async () => {
    await wallet.tick();
    const agent = (await wallet.overview()).agents.find((entry) => entry.id === seller.id)!;
    return agent.earn.offer?.status === "live" ? agent.earn.offer : null;
  });
  const listing = offer.listing as Address;
  const account = (await readListing(sandbox.chain, listing))!;
  const raw = sandbox.market.svm.getAccount(listing);
  // Model the pre-upgrade unlimited policy, then fund two real hires.
  sandbox.market.svm.setAccount({ ...raw, data: new Uint8Array(getServiceListingEncoder().encode({ ...account, maxOpenJobs: 0 })) } as never);
  await wallet.fundAgent(buyer.id, { usdCents: 1000 });
  await wallet.setPolicy(buyer.id, { askAboveCents: 500, refill: { enabled: false, topUpToCents: 0, perDayCents: 0 } });
  const first = (await wallet.hire({ agentId: buyer.id, listing, request: "One" })).job;
  const second = (await wallet.hire({ agentId: buyer.id, listing, request: "Two" })).job;
  expect((await readListing(sandbox.chain, listing))!.openJobs).toBe(2);
  await wallet.tick();
  expect(await readListing(sandbox.chain, listing)).toMatchObject({ maxOpenJobs: 0, openJobs: 2, state: 1 });
  await wallet.close();
  wallet = world.wallet = await world.reopen();
  await wallet.tick();
  expect(await readListing(sandbox.chain, listing)).toMatchObject({ maxOpenJobs: 0, openJobs: 2, state: 1 });
  const paused = (await readListing(sandbox.chain, listing))!;
  // Bypass the wallet precheck: the program itself must refuse this admission.
  await expect(sandbox.market.client.hireFromListingHumanless({
    creator: sandbox.market.payer, listing, providerAgent: paused.providerAgent,
    taskId: values.randomId32(), taskJobSpecHash: new Uint8Array(paused.specHash),
    expectedPrice: paused.price, expectedVersion: paused.version,
    reviewWindowSecs: 3600n, listingSpecHash: new Uint8Array(paused.specHash), moderator: sandbox.market.moderator.address,
  }, { maxRetries: 0 })).rejects.toMatchObject({ errorName: "AGENC_COORDINATION_ERROR__LISTING_NOT_ACTIVE" });
  expect((await readListing(sandbox.chain, listing))!.openJobs).toBe(2);
  const clientFor = sandbox.chain.clientFor;
  let updateUnavailable = true;
  sandbox.chain.clientFor = (signer) => {
    const client = clientFor(signer);
    return { ...client, send: async (...args: Parameters<typeof client.send>) => {
      const update = getUpdateServiceListingDiscriminatorBytes();
      if (updateUnavailable && args[0].some((instruction) => update.every((byte, i) => instruction.data?.[i] === byte))) {
        throw new Error("temporary update outage");
      }
      return client.send(...args);
    } };
  };
  await wallet.refundJob(first.id, true);
  await wallet.refundJob(second.id, true);
  await wallet.tick();
  expect(await readListing(sandbox.chain, listing)).toMatchObject({ maxOpenJobs: 0, openJobs: 0, state: 1 });
  updateUnavailable = false;
  await eventually(async () => {
    await wallet.tick();
    const listingState = await readListing(sandbox.chain, listing);
    return listingState?.state === 0 && listingState.maxOpenJobs === 1 ? listingState : null;
  });
  expect(await readListing(sandbox.chain, listing)).toMatchObject({ maxOpenJobs: 1, openJobs: 0, state: 0 });
}, 30_000);

it("authorizes at most one job price across failing attempts and a wallet restart", async () => {
  world = await startWorld({ earn: EARN });
  const logFile = path.join(world.dataDir, "attempts.txt");
  const earn = {
    ...EARN, checkExecutionReady: async () => {}, retryDelayMs: 1000,
    executor: { ...EARN.executor, argv: [process.execPath, "-e", "require('node:fs').appendFileSync(process.argv[1],process.argv[2]+'\\n');process.exit(3)", logFile, "{pay}", "{prompt}"] },
  };
  await world.wallet.close();
  world.wallet = await world.reopen({ earn });
  const agent = await world.wallet.createAgent();
  await setEarnWithApproval(world.wallet, agent.id, true, 10);
  await world.sandbox.postOpenJob({ title: "Spend", instructions: "Run until model budget is exhausted", rewardLamports: 5000000n });
  await eventually(async () => existsSync(logFile) && readFileSync(logFile, "utf8") === "50\n");
  await world.wallet.close();
  const stateDir = path.join(world.dataDir, "earn", agent.id);
  expect(loadState(stateDir).openClaim?.modelBudget).toEqual({ totalCents: 50, remainingCents: 0 });
  world.wallet = await world.reopen({ earn });
  await eventually(async () => loadState(stateDir).failedJobs.length === 1);
  expect(readFileSync(logFile, "utf8")).toBe("50\n");
  expect(loadState(stateDir).failedJobs[0]?.attempts).toBe(3);
}, 15_000);
