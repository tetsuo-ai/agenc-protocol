// An agent can offer several services, as the marketplace allows: each is
// its own listing, hired and paid under its own name, and taken off offer on
// its own. They are only on offer while the agent can do the work.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Address } from "@solana/kit";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentView, OfferView } from "../src/client/types.js";
import type { EarnOptions } from "../src/earn.js";
import { readListing } from "../src/market.js";
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
const FAILS = "process.exit(3)";
const LINES = { name: "Line Writer", summary: "One friendly line about anything you name.", price: { usdCents: 30 } };
const HAIKU = { name: "Haiku Smith", summary: "A haiku about anything you name.", price: { usdCents: 40 } };
const NO_REFILL = { enabled: false, topUpToCents: 0, perDayCents: 0 };
const ACTIVE = 0;
const PAUSED = 1;

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

describe("several services for one agent", () => {
  it("are each their own listing, hired and paid under their own name", async () => {
    world = await startWorld({ earn: earning(WORKS) });
    const { wallet, sandbox } = world;
    const worker = await wallet.createAgent("Worker");
    const buyer = await wallet.createAgent("Buyer");
    await wallet.fundAgent(buyer.id, { usdCents: 500 });
    await wallet.setPolicy(buyer.id, { askAboveCents: 100, refill: NO_REFILL });
    await wallet.setEarn(worker.id, true, 10);
    await wallet.setOffer(worker.id, LINES);
    const both = await wallet.setOffer(worker.id, HAIKU);
    expect(both.earn.offers.map((offer) => offer.name)).toEqual(["Line Writer", "Haiku Smith"]);
    expect(new Set(both.earn.offers.map((offer) => offer.id)).size).toBe(2);

    const live = await servicesReach(world, worker.id, (offer) => offer.status === "live");
    const [lines, haiku] = live.earn.offers as [OfferView, OfferView];
    expect(lines.listing).not.toBe(haiku.listing);
    for (const offer of [lines, haiku]) {
      const onChain = (await readListing(sandbox.chain, offer.listing as Address))!;
      expect(onChain.authority).toBe(worker.address);
      expect(Number(onChain.state)).toBe(ACTIVE);
    }
    expect((await readListing(sandbox.chain, haiku.listing as Address))!.price).toBe(40n * CENT);
    const catalog = (await wallet.find({})).services.map((service) => service.listing);
    expect(catalog).toEqual(expect.arrayContaining([lines.listing, haiku.listing]));

    // The agent cannot hire either; another agent can hire both.
    await expect(
      wallet.hire({ agentId: worker.id, listing: haiku.listing!, request: "A haiku." }),
    ).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    const first = await wallet.hire({ agentId: buyer.id, listing: lines.listing!, request: "A line about tea." });
    const second = await wallet.hire({ agentId: buyer.id, listing: haiku.listing!, request: "A haiku about rain." });
    for (const { job } of [first, second]) {
      await eventually(async () => (await wallet.getJob(job.id, true)).status === "delivered", 60_000);
      await wallet.approveJob(job.id, undefined, true);
    }
    const paid = await eventually(async () => {
      const view = await agentView(world!, worker.id);
      return view.earn.jobsDone === 2 ? view : null;
    }, 30_000);
    expect(paid.earned.lamports).toBe((((30n + 40n) * CENT * 95n) / 100n).toString());
    const working = await wallet.listJobs({ role: "working", agentId: worker.id }, true);
    expect(working.map((job) => [job.title, job.status]).sort()).toEqual([
      ["Haiku Smith", "paid"],
      ["Line Writer", "paid"],
    ]);
  }, 180_000);

  it("are taken off offer one at a time", async () => {
    world = await startWorld({ earn: earning(WORKS) });
    const { wallet, sandbox } = world;
    const worker = await wallet.createAgent("Worker");
    await wallet.setEarn(worker.id, true, 10);
    await wallet.setOffer(worker.id, LINES);
    await wallet.setOffer(worker.id, HAIKU);
    const live = await servicesReach(world, worker.id, (offer) => offer.status === "live");
    const [lines, haiku] = live.earn.offers as [OfferView, OfferView];

    // With two on offer, which one has to be said.
    await expect(wallet.setOffer(worker.id, null)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const one = await wallet.setOffer(worker.id, null, lines.id);
    expect(one.earn.offers.map((offer) => [offer.name, offer.wanted, offer.status])).toEqual([
      ["Line Writer", false, "paused"],
      ["Haiku Smith", true, "live"],
    ]);
    expect(Number((await readListing(sandbox.chain, lines.listing as Address))!.state)).toBe(PAUSED);
    expect(Number((await readListing(sandbox.chain, haiku.listing as Address))!.state)).toBe(ACTIVE);

    // A service is changed by its own id, and its name stays.
    const cheaper = await wallet.setOffer(worker.id, { ...HAIKU, price: { usdCents: 35 } }, haiku.id);
    expect(cheaper.earn.offers.map((offer) => offer.id)).toEqual([lines.id, haiku.id]);
    await expect(
      wallet.setOffer(worker.id, { ...HAIKU, name: "Haiku Master" }, haiku.id),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      wallet.setOffer(worker.id, { ...HAIKU, name: "Nope" }, "no-such-service"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Offering one again by its name brings back the same listing.
    await wallet.setOffer(worker.id, LINES);
    const back = await servicesReach(world, worker.id, (offer) => offer.status === "live");
    expect(back.earn.offers.map((offer) => offer.listing)).toEqual([lines.listing, haiku.listing]);
  }, 120_000);

  it("are kept to ten for one agent", async () => {
    world = await startWorld({ earn: earning(WORKS) });
    const { wallet } = world;
    const worker = await wallet.createAgent("Worker");
    // Earning is off, so nothing goes to the marketplace yet.
    for (let index = 1; index <= 10; index += 1) {
      await wallet.setOffer(worker.id, { ...LINES, name: `Service ${index}` });
    }
    await expect(
      wallet.setOffer(worker.id, { ...LINES, name: "Service 11" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Changing one of the ten is still fine.
    const changed = await wallet.setOffer(worker.id, { ...LINES, name: "Service 3", price: { usdCents: 31 } });
    expect(changed.earn.offers).toHaveLength(10);
    expect(changed.earn.offers[2]!.price.usdCents).toBe(31);
  }, 60_000);

  it("carry on from a journal written when an agent had one service", async () => {
    world = await startWorld({ earn: earning(WORKS) });
    const created = await world.wallet.createAgent("Worker");
    await world.wallet.setEarn(created.id, true, 10);
    await world.wallet.setOffer(created.id, LINES);
    const live = await servicesReach(world, created.id, (offer) => offer.status === "live");
    const listing = live.earn.offers[0]!.listing;
    await world.wallet.close();

    // How an older wallet wrote it: one `offer`, without an id.
    const file = path.join(world.dataDir, "state.json");
    const journal = JSON.parse(readFileSync(file, "utf8"));
    const earn = journal.agents[created.id].earn;
    const { id: _id, ...legacy } = earn.offers[0];
    earn.offer = legacy;
    delete earn.offers;
    writeFileSync(file, JSON.stringify(journal));

    world.wallet = await world.reopen();
    const back = await servicesReach(world, created.id, (offer) => offer.status === "live");
    expect(back.earn.offers).toHaveLength(1);
    expect(back.earn.offers[0]).toMatchObject({ name: "Line Writer", listing, id: legacy.listingIdHex });
    // And a second one can be added next to it.
    const two = await world.wallet.setOffer(created.id, HAIKU);
    expect(two.earn.offers.map((offer) => offer.name)).toEqual(["Line Writer", "Haiku Smith"]);
  }, 120_000);

  it("come off offer while the agent is stopped after failed jobs, and back when it is switched on", async () => {
    world = await startWorld({ earn: earning(FAILS, { maxJobAttempts: 1 }) });
    const { wallet, sandbox } = world;
    const worker = await wallet.createAgent("Worker");
    await wallet.fundAgent(worker.id, { usdCents: 1_000 });
    await wallet.setEarn(worker.id, true, 10);
    await wallet.setOffer(worker.id, LINES);
    await wallet.setOffer(worker.id, HAIKU);
    const live = await servicesReach(world, worker.id, (offer) => offer.status === "live");

    for (const title of ["One", "Two", "Three"]) {
      const open = await sandbox.postOpenJob({ title, instructions: "Write a line.", rewardLamports: 50n * CENT });
      await eventually(async () =>
        (await wallet.listJobs({ role: "working" }, true)).some((job) => job.task === open.task && job.status === "failed"),
      30_000);
    }
    const stopped = await servicesReach(world, worker.id, (offer) => offer.status === "paused");
    expect(stopped.earn.state).toBe("error");
    for (const offer of live.earn.offers) {
      expect(Number((await readListing(sandbox.chain, offer.listing as Address))!.state)).toBe(PAUSED);
    }

    await wallet.setEarn(worker.id, false);
    await wallet.setEarn(worker.id, true);
    await servicesReach(world, worker.id, (offer) => offer.status === "live");
    for (const offer of live.earn.offers) {
      expect(Number((await readListing(sandbox.chain, offer.listing as Address))!.state)).toBe(ACTIVE);
    }
  }, 180_000);
});
