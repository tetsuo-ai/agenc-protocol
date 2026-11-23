import { setEarnWithApproval, setOfferWithApproval } from "./harness.js";
// "Stop earning for good": an agent that took jobs locked a deposit with the
// marketplace when it registered. Retiring it there brings that deposit back,
// to the lamport, once its services are off the marketplace for good. It is
// refused while the agent still takes jobs or has a job that is not finished.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Address } from "@solana/kit";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentView, OfferView } from "../src/client/types.js";
import type { EarnOptions } from "../src/earn.js";
import { TaskStatus } from "@tetsuo-ai/marketplace-sdk";
import { isRetiredAgent, listingsOf, readAgent, readListing, readTask } from "../src/market.js";
import { CENT, eventually, startWorld, type World } from "./harness.js";

function earning(script: string, extra: Partial<EarnOptions> = {}): EarnOptions {
  return {
    executor: {
      argv: [process.execPath, "-e", script, "{prompt}"],
      mode: "sandboxed",
      envAllowlist: [],
      timeoutMs: 30_000,
    },
    pollIntervalMs: 150,
    ...extra,
  };
}
const WORKS = "process.stdout.write('Here is the finished work.')";
const LINES = { name: "Line Writer", summary: "One friendly line about anything you name.", price: { usdCents: 30 } };
const HAIKU = { name: "Haiku Smith", summary: "A haiku about anything you name.", price: { usdCents: 40 } };
const NO_REFILL = { enabled: false, topUpToCents: 0, perDayCents: 0 };
const ACTIVE = 0;
const PAUSED = 1;
const RETIRED = 2;

let world: World | null = null;
afterEach(async () => {
  await world?.wallet.close();
  world = null;
});

async function agentView(w: World, agentId: string): Promise<AgentView> {
  return (await w.wallet.overview()).agents.find((agent) => agent.id === agentId)!;
}

/** Run housekeeping until every service of the agent matches `check`. */
async function servicesReach(
  w: World,
  agentId: string,
  check: (offer: OfferView) => boolean,
): Promise<AgentView> {
  return eventually(async () => {
    await w.wallet.tick();
    const view = await agentView(w, agentId);
    return view.earn.offers.length > 0 && view.earn.offers.every(check) ? view : null;
  }, 30_000);
}

/** The agent's address on the marketplace, from one of its listings. */
async function providerOf(w: World, offer: OfferView): Promise<Address> {
  return (await readListing(w.sandbox.chain, offer.listing as Address))!.providerAgent;
}

async function listingStates(w: World, offers: readonly OfferView[]): Promise<number[]> {
  const states: number[] = [];
  for (const offer of offers) {
    states.push(Number((await readListing(w.sandbox.chain, offer.listing as Address))!.state));
  }
  return states;
}

describe("stopping an agent's earning for good", () => {
  it("is refused while a service of its is on offer, and nothing changes", async () => {
    world = await startWorld({ earn: earning(WORKS) });
    const { wallet, sandbox } = world;
    const worker = await wallet.createAgent("Worker");
    await setEarnWithApproval(wallet, worker.id, true, 10);
    await setOfferWithApproval(wallet, worker.id, LINES);
    const live = await servicesReach(world, worker.id, (offer) => offer.status === "live");
    const provider = await providerOf(world, live.earn.offers[0]!);
    const before = (await readAgent(sandbox.chain, provider))!;
    expect(before.stake).toBeGreaterThan(0n);

    const words = "Worker still offers “Line Writer”. Switch off Earns first.";
    // The panel knows before anyone asks.
    expect(live.earn.retire).toEqual({ refusal: words });
    await expect(wallet.retireAgent(worker.id)).rejects.toMatchObject({ code: "NOT_ALLOWED", message: words });

    // Still on offer, still registered, with its whole deposit.
    expect(await listingStates(world, live.earn.offers)).toEqual([ACTIVE]);
    const after = (await readAgent(sandbox.chain, provider))!;
    expect(after.stake).toBe(before.stake);
    expect(isRetiredAgent(after)).toBe(false);
    const view = await agentView(world, worker.id);
    expect(view.earn).toMatchObject({ enabled: true, retired: false });
    expect(view.earn.offers[0]!.wanted).toBe(true);
  }, 120_000);

  it("brings the deposit back to the lamport, after taking every service off for good", async () => {
    world = await startWorld({ earn: earning(WORKS) });
    const { wallet, sandbox } = world;
    const worker = await wallet.createAgent("Worker");
    await setEarnWithApproval(wallet, worker.id, true, 10);
    await setOfferWithApproval(wallet, worker.id, LINES);
    await setOfferWithApproval(wallet, worker.id, HAIKU);
    const live = await servicesReach(world, worker.id, (offer) => offer.status === "live");
    await setEarnWithApproval(wallet, worker.id, false);
    const paused = await servicesReach(world, worker.id, (offer) => offer.status === "paused");
    expect(await listingStates(world, paused.earn.offers)).toEqual([PAUSED, PAUSED]);

    const provider = await providerOf(world, live.earn.offers[0]!);
    const registration = (await readAgent(sandbox.chain, provider))!;
    const record = (await sandbox.chain.readRawAccount(provider))!;
    const floor = await sandbox.chain.getMinimumBalanceForRentExemption(record.data.length);
    // Everything the record holds above the network's minimum is the deposit.
    expect(record.lamports - floor).toBe(registration.stake);
    expect(paused.earn.setAside.lamports).toBe(registration.stake.toString());
    expect(paused.earn.retire).toEqual({ refusal: null });
    const own = await world.balance(worker.address);

    const retired = await wallet.retireAgent(worker.id);

    // Both services taken off for good in one transaction, then the agent
    // retired: two fees, and its whole deposit came back.
    const fee = sandbox.chain.transferFeeLamports;
    expect(await world.balance(worker.address)).toBe(own + registration.stake - 2n * fee);
    expect((await sandbox.chain.readRawAccount(provider))!.lamports).toBe(floor);
    const after = (await readAgent(sandbox.chain, provider))!;
    expect(after.stake).toBe(0n);
    expect(isRetiredAgent(after)).toBe(true);
    expect(await listingStates(world, paused.earn.offers)).toEqual([RETIRED, RETIRED]);

    expect(retired.earn).toMatchObject({ enabled: false, state: "off", retired: true, retire: null });
    expect(retired.earn.setAside.lamports).toBe("0");
    expect(retired.balance.lamports).toBe((own + registration.stake - 2n * fee).toString());
    const [latest] = await wallet.listActivity(1);
    expect(latest).toMatchObject({
      kind: "returned",
      text: "Worker stopped earning for good. Its deposit came back to its own money.",
      agentId: worker.id,
    });
    expect(latest!.amount?.lamports).toBe(registration.stake.toString());

    // It never takes jobs or offers anything again, even after a restart.
    await expect(wallet.setEarn(worker.id, true, 10)).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    await expect(wallet.setOffer(worker.id, LINES)).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    await wallet.close();
    world.wallet = await world.reopen();
    const reopened = await agentView(world, worker.id);
    expect(reopened.earn).toMatchObject({ enabled: false, retired: true, retire: null });
    expect(await world.wallet.retireAgent(worker.id)).toMatchObject({ earn: { retired: true } });

    // Its money stays its own until the person takes it back: then all of it.
    const kept = await world.balance(worker.address);
    const main = await world.balance(world.wallet.mainAddress);
    await world.wallet.reclaimFromAgent(worker.id, "all");
    expect(await world.balance(worker.address)).toBe(0n);
    expect(await world.balance(world.wallet.mainAddress)).toBe(main + kept - fee);
  }, 180_000);

  it("is refused while a job of its waits to be paid, and goes ahead once it is", async () => {
    world = await startWorld({ earn: earning(WORKS) });
    const { wallet, sandbox } = world;
    const worker = await wallet.createAgent("Worker");
    const buyer = await wallet.createAgent("Buyer");
    await wallet.fundAgent(buyer.id, { usdCents: 500 });
    await wallet.setPolicy(buyer.id, { askAboveCents: 100, refill: NO_REFILL });
    await setEarnWithApproval(wallet, worker.id, true, 10);
    await setOfferWithApproval(wallet, worker.id, LINES);
    const live = await servicesReach(world, worker.id, (offer) => offer.status === "live");
    const { job } = await wallet.hire({ agentId: buyer.id, listing: live.earn.offers[0]!.listing!, request: "A line about tea." });
    await eventually(async () => (await wallet.getJob(job.id, true)).status === "delivered", 60_000);
    await setEarnWithApproval(wallet, worker.id, false);
    await servicesReach(world, worker.id, (offer) => offer.status === "paused");

    const provider = await providerOf(world, live.earn.offers[0]!);
    const stake = (await readAgent(sandbox.chain, provider))!.stake;
    const words = "Worker is waiting to be paid for a job. Try again once it is paid.";
    // Asking is what may settle a job (a buyer who went quiet), so the panel
    // is not told beforehand; asking says why.
    expect((await agentView(world, worker.id)).earn.retire).toEqual({ refusal: null });
    await expect(wallet.retireAgent(worker.id)).rejects.toMatchObject({ code: "NOT_ALLOWED", message: words });
    // Nothing was taken off for good, and the deposit is still there.
    expect(await listingStates(world, live.earn.offers)).toEqual([PAUSED]);
    expect((await readAgent(sandbox.chain, provider))!.stake).toBe(stake);

    // The buyer pays. Its loop is off, so the wallet records that pay
    // itself before it stops the agent for good.
    await wallet.approveJob(job.id, undefined, true);
    const retired = await wallet.retireAgent(worker.id);
    expect(retired.earn.retired).toBe(true);
    expect(retired.earn.jobsDone).toBe(1);
    expect(retired.earned.lamports).toBe(((30n * CENT * 95n) / 100n).toString());
    const working = await wallet.listJobs({ role: "working", agentId: worker.id }, true);
    expect(working.map((entry) => [entry.title, entry.status])).toEqual([["Line Writer", "paid"]]);
    expect(isRetiredAgent((await readAgent(sandbox.chain, provider))!)).toBe(true);
  }, 180_000);

  it("stops short of retiring while a hire of it waits to be started", async () => {
    // A slow look for work, so a hire can land without being taken.
    world = await startWorld({ earn: earning(WORKS, { pollIntervalMs: 120_000, serviceRefreshMs: 120_000 }) });
    const { wallet, sandbox } = world;
    const worker = await wallet.createAgent("Worker");
    const buyer = await wallet.createAgent("Buyer");
    await wallet.fundAgent(buyer.id, { usdCents: 500 });
    await wallet.setPolicy(buyer.id, { askAboveCents: 100, refill: NO_REFILL });
    await setEarnWithApproval(wallet, worker.id, true, 10);
    await setOfferWithApproval(wallet, worker.id, LINES);
    const live = await servicesReach(world, worker.id, (offer) => offer.status === "live");
    const { job } = await wallet.hire({ agentId: buyer.id, listing: live.earn.offers[0]!.listing!, request: "A line about tea." });
    await eventually(async () => (await wallet.getJob(job.id, true)).status === "waiting", 30_000);
    await setEarnWithApproval(wallet, worker.id, false);

    const provider = await providerOf(world, live.earn.offers[0]!);
    const stake = (await readAgent(sandbox.chain, provider))!.stake;
    await expect(wallet.retireAgent(worker.id)).rejects.toMatchObject({
      code: "NOT_ALLOWED",
      message: "Someone hired Worker and is waiting for the work. Switch on Earns until it is done and paid, then switch it off and try again.",
    });
    // Nothing for good happened: the service is only off offer, still wanted,
    // and the agent is still there to do the job it was paid for.
    expect(await listingStates(world, live.earn.offers)).toEqual([PAUSED]);
    const registration = (await readAgent(sandbox.chain, provider))!;
    expect(registration.stake).toBe(stake);
    expect(isRetiredAgent(registration)).toBe(false);
    const view = await agentView(world, worker.id);
    expect(view.earn.retired).toBe(false);
    expect(view.earn.offers[0]!.wanted).toBe(true);

    // As it says: with Earns on the hire is done and paid, and then it can stop.
    await setEarnWithApproval(wallet, worker.id, true, 10);
    await eventually(async () => (await wallet.getJob(job.id, true)).status === "delivered", 60_000);
    await wallet.approveJob(job.id, undefined, true);
    await setEarnWithApproval(wallet, worker.id, false);
    const retired = await wallet.retireAgent(worker.id);
    expect(retired.earn).toMatchObject({ retired: true, jobsDone: 1 });
    expect(await listingStates(world, live.earn.offers)).toEqual([RETIRED]);
  }, 180_000);

  it("does a waiting hire of a service it took off offer, whatever its smallest pay, so it can stop", async () => {
    world = await startWorld({ earn: earning(WORKS, { pollIntervalMs: 120_000, serviceRefreshMs: 120_000 }) });
    const { wallet } = world;
    const worker = await wallet.createAgent("Worker");
    const buyer = await wallet.createAgent("Buyer");
    await wallet.fundAgent(buyer.id, { usdCents: 500 });
    await wallet.setPolicy(buyer.id, { askAboveCents: 100, refill: NO_REFILL });
    await setEarnWithApproval(wallet, worker.id, true, 10);
    await setOfferWithApproval(wallet, worker.id, LINES);
    const live = await servicesReach(world, worker.id, (offer) => offer.status === "live");
    const { job } = await wallet.hire({ agentId: buyer.id, listing: live.earn.offers[0]!.listing!, request: "A line about tea." });
    await eventually(async () => (await wallet.getJob(job.id, true)).status === "waiting", 30_000);
    // The person takes the service off offer, then switches Earns off.
    await setOfferWithApproval(wallet, worker.id, null, live.earn.offers[0]!.id);
    await setEarnWithApproval(wallet, worker.id, false);
    await expect(wallet.retireAgent(worker.id)).rejects.toMatchObject({ code: "NOT_ALLOWED" });

    // A stranger's job paying more than the hire but less than the smallest pay.
    const stranger = await world.sandbox.postOpenJob({ title: "A line", instructions: "Write one line.", rewardLamports: 40n * CENT });
    // Earns on with a smallest pay above the service's price: the hire it owes is still done.
    await setEarnWithApproval(wallet, worker.id, true, 50);
    await eventually(async () => (await wallet.getJob(job.id, true)).status === "delivered", 60_000);
    // The smallest pay still holds for every other job.
    expect(Number((await readTask(world.sandbox.chain, stranger.task))!.status)).toBe(TaskStatus.Open);
    await wallet.approveJob(job.id, undefined, true);
    await setEarnWithApproval(wallet, worker.id, false);
    expect((await wallet.retireAgent(worker.id)).earn.retired).toBe(true);
  }, 180_000);

  it("is not held up by a hire whose time to deliver is over", async () => {
    world = await startWorld({ earn: earning(WORKS, { pollIntervalMs: 120_000, serviceRefreshMs: 120_000 }) });
    const { wallet, sandbox, clock } = world;
    const worker = await wallet.createAgent("Worker");
    const buyer = await wallet.createAgent("Buyer");
    await wallet.fundAgent(buyer.id, { usdCents: 500 });
    await wallet.setPolicy(buyer.id, { askAboveCents: 100, refill: NO_REFILL });
    await setEarnWithApproval(wallet, worker.id, true, 10);
    await setOfferWithApproval(wallet, worker.id, LINES);
    const live = await servicesReach(world, worker.id, (offer) => offer.status === "live");
    const { job } = await wallet.hire({ agentId: buyer.id, listing: live.earn.offers[0]!.listing!, request: "A line about tea." });
    await eventually(async () => (await wallet.getJob(job.id, true)).status === "waiting", 30_000);
    await setEarnWithApproval(wallet, worker.id, false);
    await expect(wallet.retireAgent(worker.id)).rejects.toMatchObject({ code: "NOT_ALLOWED" });

    // Nobody can do it once its time is over (its buyer gets the price back).
    sandbox.advanceClock(2 * 24 * 3_600);
    clock.now += 2 * 24 * 3_600_000;
    const retired = await wallet.retireAgent(worker.id);
    expect(retired.earn.retired).toBe(true);
  }, 180_000);

  it("pays itself for a delivery whose buyer went quiet, then stops", async () => {
    world = await startWorld({ earn: earning(WORKS) });
    const { wallet, sandbox, clock } = world;
    const agent = await wallet.createAgent("My assistant");
    await setEarnWithApproval(wallet, agent.id, true, 10);
    const open = await sandbox.postOpenJob({ title: "Write a line", instructions: "Write one friendly line.", rewardLamports: 50n * CENT });
    await eventually(async () => {
      const jobs = await wallet.listJobs({ role: "working" }, true);
      return jobs.some((entry) => entry.task === open.task && entry.status === "delivered");
    }, 30_000);
    await setEarnWithApproval(wallet, agent.id, false);

    // The buyer never looks at it, and Earns is off: nothing else would collect it.
    await expect(wallet.retireAgent(agent.id)).rejects.toMatchObject({
      code: "NOT_ALLOWED",
      message: "My assistant is waiting to be paid for a job. Try again once it is paid.",
    });
    sandbox.advanceClock(3_700);
    clock.now += 3_700_000;
    const retired = await wallet.retireAgent(agent.id);
    expect(retired.earn).toMatchObject({ retired: true, jobsDone: 1 });
    expect(BigInt(retired.earned.lamports)).toBeGreaterThan(0n);
    expect((await wallet.getJob(`earn_${agent.id}_${open.task}`, true)).status).toBe("paid");
  }, 180_000);

  it("stays retired when its records are put back from before it stopped", async () => {
    world = await startWorld({ earn: earning(WORKS) });
    const { wallet, sandbox, dataDir } = world;
    const worker = await wallet.createAgent("Worker");
    await setEarnWithApproval(wallet, worker.id, true, 10);
    await setOfferWithApproval(wallet, worker.id, LINES);
    const live = await servicesReach(world, worker.id, (offer) => offer.status === "live");
    const provider = await providerOf(world, live.earn.offers[0]!);
    // Records from while it earned, with its service wanted on offer.
    const journal = path.join(dataDir, "state.json");
    const beforeStopping = readFileSync(journal);
    await setEarnWithApproval(wallet, worker.id, false);
    await wallet.retireAgent(worker.id);
    await wallet.close();
    writeFileSync(journal, beforeStopping);

    world.wallet = await world.reopen();
    const view = await agentView(world, worker.id);
    expect(view.earn).toMatchObject({ enabled: false, state: "off", retired: true, retire: null });
    await world.wallet.tick();
    // It offers nothing again (no new listing) and cannot be switched on.
    expect((await listingsOf(sandbox.chain, provider)).map((entry) => Number(entry.listing.state))).toEqual([RETIRED]);
    await expect(world.wallet.setEarn(worker.id, true, 10)).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    expect((await agentView(world, worker.id)).earn.offers[0]!.wanted).toBe(false);
  }, 180_000);
});
