// Owner real test 3, bug 7: a seller's agent took a hire and gave it up
// after its tries failed. The buyer must read what is going on and when the
// price comes back, and a second hire of the busy service must say why it is
// refused and until when. Practice money in the sandbox, one wallet on both
// sides, as on the owner's Mac.
import { afterEach, expect, it } from "vitest";
import type { Address } from "@solana/kit";
import { eventually, setEarnWithApproval, setOfferWithApproval, startWorld, type World } from "./harness.js";

let world: World | null = null;
afterEach(async () => { await world?.wallet.close(); world = null; });

const FAILING = {
  executor: { argv: [process.execPath, "-e", "process.exit(3)", "{prompt}"], mode: "sandboxed" as const, envAllowlist: [], timeoutMs: 10_000 },
  pollIntervalMs: 100,
  retryDelayMs: 100,
  checkExecutionReady: async () => {},
};

async function liveService(w: World) {
  const seller = await w.wallet.createAgent("Seller");
  const buyer = await w.wallet.createAgent("Buyer");
  await w.wallet.fundAgent(seller.id, { usdCents: 1000 });
  await setEarnWithApproval(w.wallet, seller.id, true, 10);
  await setOfferWithApproval(w.wallet, seller.id, { name: "Sea haiku", summary: "A haiku about the sea", price: { usdCents: 20 } });
  const offer = await eventually(async () => {
    await w.wallet.tick();
    const agent = (await w.wallet.overview()).agents.find((entry) => entry.id === seller.id)!;
    return agent.earn.offer?.status === "live" ? agent.earn.offer : null;
  });
  await w.wallet.fundAgent(buyer.id, { usdCents: 1000 });
  await w.wallet.setPolicy(buyer.id, { askAboveCents: 500, refill: { enabled: false, topUpToCents: 0, perDayCents: 10000 } });
  return { buyer, listing: offer.listing as Address };
}

it("says the provider gave a hire back, when the price comes back, and why the service is busy", async () => {
  // Exit 78 is the seller's setup refusing the job (its AI key): the claim is given back at once.
  world = await startWorld({ earn: { ...FAILING, executor: { ...FAILING.executor, argv: [process.execPath, "-e", "process.exit(78)", "{prompt}"] } } });
  const { wallet } = world;
  const { buyer, listing } = await liveService(world);
  const first = (await wallet.hire({ agentId: buyer.id, listing, request: "One haiku" })).job;
  await eventually(async () => {
    await wallet.tick();
    const working = (await wallet.listJobs({ role: "working" }, true)).find((job) => job.task === first.task);
    return working?.status === "failed" ? working : null;
  }, 60_000);
  const back = await eventually(async () => {
    await wallet.tick();
    const job = await wallet.getJob(first.id, true);
    return /gave it back/.test(job.statusText) ? job : null;
  }, 30_000);
  expect(back.status).toBe("waiting");
  expect(back.canRefund).toBe(true);
  expect(back.statusText).toMatch(
    /^The provider took this job and gave it back without doing it\. The price comes back (in .+|any moment now), when the job is cancelled\. You can cancel it now in Jobs to get it back sooner\.$/,
  );
  await expect(wallet.hire({ agentId: buyer.id, listing, request: "Another haiku" })).rejects.toMatchObject({
    code: "NOT_AVAILABLE",
    message: expect.stringMatching(/^That service takes one job at a time, and your earlier hire of it \(Sea haiku\) is not finished\. It is busy until that job is delivered or cancelled, .+ at the latest\. You can cancel that job in Jobs\.$/),
  });
}, 120_000);

it("says when the price of a given-up hire comes back, and why the service is busy until then", async () => {
  world = await startWorld({ earn: FAILING });
  const { wallet } = world;
  const seller = await wallet.createAgent("Seller");
  const buyer = await wallet.createAgent("Buyer");
  await wallet.fundAgent(seller.id, { usdCents: 1000 });
  await setEarnWithApproval(wallet, seller.id, true, 10);
  await setOfferWithApproval(wallet, seller.id, { name: "Sea haiku", summary: "A haiku about the sea", price: { usdCents: 20 } });
  const offer = await eventually(async () => {
    await wallet.tick();
    const agent = (await wallet.overview()).agents.find((entry) => entry.id === seller.id)!;
    return agent.earn.offer?.status === "live" ? agent.earn.offer : null;
  });
  const listing = offer.listing as Address;
  await wallet.fundAgent(buyer.id, { usdCents: 1000 });
  await wallet.setPolicy(buyer.id, { askAboveCents: 500, refill: { enabled: false, topUpToCents: 0, perDayCents: 10000 } });
  const first = (await wallet.hire({ agentId: buyer.id, listing, request: "One haiku" })).job;

  // The seller's agent takes it, its program fails every try, and it gives up.
  await eventually(async () => {
    await wallet.tick();
    const working = (await wallet.listJobs({ role: "working" }, true)).find((job) => job.task === first.task);
    return working?.status === "failed" ? working : null;
  }, 60_000);

  const held = await eventually(async () => {
    await wallet.tick();
    const job = await wallet.getJob(first.id, true);
    return job.status === "working" || /gave it back/.test(job.statusText) ? job : null;
  }, 30_000);
  expect(held.statusText).not.toBe("Waiting for the provider to start.");
  expect(held.statusText).toMatch(/the price comes back (in|any moment)/);

  await expect(wallet.hire({ agentId: buyer.id, listing, request: "Another haiku" })).rejects.toMatchObject({
    code: "NOT_AVAILABLE",
    message: expect.stringMatching(
      /^That service takes one job at a time, and your earlier hire of it \(Sea haiku\) is not finished\. It is busy until that job is delivered or cancelled, (in .+|any moment now) at the latest\.( You can cancel that job in Jobs\.)?$/,
    ),
  });
}, 120_000);
