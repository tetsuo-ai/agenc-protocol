// What a buyer sees of a service before hiring it, against the real program:
// who offers it, and what buyers really paid it, read from the chain and
// weighed by the fee each job paid.
import { afterEach, describe, expect, it } from "vitest";
import type { Address } from "@solana/kit";
import { readMarketRecord } from "../src/records.js";
import { NO_FIRST_PARTY } from "../src/trust.js";
import { CENT, HAIKU, startWorld, type World } from "./harness.js";

let world: World | null = null;
afterEach(async () => {
  await world?.wallet.close();
  world = null;
});

const NAMES = {
  name: "Northlight",
  category: "marketing",
  summary: "Ten name ideas for a product, pet or project.",
  priceLamports: 80n * CENT,
  replyPrefix: "Ten ideas.",
};

/** An agent that may spend this much on its own, with the money for it. */
async function spender(world: World, cents: number) {
  const agent = await world.wallet.createAgent("Buyer");
  await world.wallet.setPolicy(agent.id, {
    askAboveCents: cents,
    refill: { enabled: false, topUpToCents: 0, perDayCents: 0 },
  });
  await world.wallet.fundAgent(agent.id, { usdCents: cents });
  return agent;
}

/** Hire `listing`, let its provider deliver, and pay, with stars or without. */
async function paidJob(world: World, agentId: string, listing: Address, score?: number): Promise<string> {
  const { job } = await world.wallet.hire({ agentId, listing, request: "Something small, please." });
  expect(await world.sandbox.workOnce()).toBeGreaterThanOrEqual(1);
  const paid = await world.wallet.approveJob(job.id, score, true);
  expect(paid.status).toBe("paid");
  return job.id;
}

describe("a service's record", () => {
  it("shows who offers it and what buyers really paid it", async () => {
    world = await startWorld();
    const { wallet, listing } = world;
    const startedAt = Date.now();

    const [fresh] = (await wallet.find({ query: "haiku" })).services;
    expect(fresh).toMatchObject({
      listing,
      record: "ready",
      rating: null,
      ratingCount: 0,
      jobsDone: 0,
      buyers: 0,
      paid: { lamports: "0", usdCents: 0 },
    });
    expect(fresh!.offeredBy).toMatchObject({
      jobsDone: 0,
      buyers: 0,
      turnedDown: 0,
      disputesLost: 0,
      // The practice marketplace's stake for taking jobs: 0.01 at a hundred dollars.
      deposit: { lamports: "10000000", usdCents: 100 },
      otherServices: [],
    });
    expect(fresh!.offeredBy!.since).toBeGreaterThan(startedAt - 60 * 60_000);
    expect(fresh!.offeredBy!.since).toBeLessThanOrEqual(Date.now() + 60_000);

    const agent = await spender(world, 300);
    await paidJob(world, agent.id, listing, 5);
    // Tidying closes the job's link to its service on the chain: the record keeps it.
    await wallet.tick();

    const [after] = (await wallet.find({ query: "haiku" })).services;
    expect(after).toMatchObject({
      record: "ready",
      rating: 5,
      ratingCount: 1,
      jobsDone: 1,
      buyers: 1,
      paid: { lamports: HAIKU.priceLamports.toString(), usdCents: 20 },
    });
    expect(after!.offeredBy).toMatchObject({ jobsDone: 1, buyers: 1, paid: { usdCents: 20 } });
  });

  it("ranks many paid jobs above one cheap five-star rating", async () => {
    world = await startWorld();
    const { wallet, sandbox, listing: haiku } = world;
    const names = await sandbox.addService(NAMES);
    const agent = await spender(world, 2000);

    // One five-star rating on a twenty-cent job...
    await paidJob(world, agent.id, haiku, 5);
    // ...and three paid jobs on an eighty-cent service, two of them rated four.
    await paidJob(world, agent.id, names, 4);
    await paidJob(world, agent.id, names, 4);
    await paidJob(world, agent.id, names);

    const listed = (await wallet.find({})).services;
    expect(listed.map((service) => service.name)).toEqual(["Northlight", "Haiku Writer"]);
    const [northlight, poem] = listed;
    // What the person reads next to each: the stars with how many there are,
    // and what was paid by how many buyers.
    expect(northlight).toMatchObject({ rating: 4, ratingCount: 2, jobsDone: 3, buyers: 1 });
    expect(northlight!.paid.usdCents).toBe(240);
    expect(poem).toMatchObject({ rating: 5, ratingCount: 1, jobsDone: 1, buyers: 1 });
  });

  it("ties a job to the service it was hired from, and counts it once for its agent", async () => {
    world = await startWorld();
    const { sandbox, listing } = world;
    const names = await sandbox.addService(NAMES);
    const agent = await spender(world, 2000);
    await paidJob(world, agent.id, listing);
    await paidJob(world, agent.id, names, 3);
    const rows = await sandbox.services.listServices();
    const record = await readMarketRecord(
      { chain: sandbox.chain, services: sandbox.services, firstParty: NO_FIRST_PARTY },
      rows.map((row) => ({ listing: row.listing, providerAgent: row.providerAgent, specHashHex: row.specHashHex })),
    );
    const haikuRow = rows.find((row) => row.listing === listing)!;
    const namesRow = rows.find((row) => row.listing === names)!;
    expect(record.listings.get(listing)).toMatchObject({ jobs: 1, ratings: 0, rating: null });
    expect(record.listings.get(names)).toMatchObject({ jobs: 1, ratings: 1, rating: 3 });
    expect(record.providers.get(haikuRow.providerAgent)).toMatchObject({ jobs: 1 });
    expect(record.providers.get(namesRow.providerAgent)).toMatchObject({ jobs: 1 });

    // A buyer that is the marketplace's own counts for nothing, rated or not.
    const buyer = (await world.wallet.overview()).agents.find((entry) => entry.id === agent.id)!.address;
    const own = await readMarketRecord(
      {
        chain: sandbox.chain,
        services: sandbox.services,
        firstParty: { wallets: new Set([buyer]), agents: new Set(), listings: new Set() },
      },
      rows.map((row) => ({ listing: row.listing, providerAgent: row.providerAgent, specHashHex: row.specHashHex })),
    );
    expect(own.listings.size).toBe(0);
    expect(own.providers.size).toBe(0);
    // So does a provider that is.
    const ownAgent = await readMarketRecord(
      {
        chain: sandbox.chain,
        services: sandbox.services,
        firstParty: { wallets: new Set(), agents: new Set([namesRow.providerAgent]), listings: new Set() },
      },
      rows.map((row) => ({ listing: row.listing, providerAgent: row.providerAgent, specHashHex: row.specHashHex })),
    );
    expect(ownAgent.listings.has(names)).toBe(false);
    expect(ownAgent.listings.get(listing)).toMatchObject({ jobs: 1 });
  });
});
