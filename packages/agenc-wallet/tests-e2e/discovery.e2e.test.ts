import { afterEach, expect, it } from "vitest";
import { getAddressDecoder } from "@solana/kit";
import { createHostedServices } from "../src/services.js";
import { runMarketTool } from "../src/client/tools.js";
import type { WalletClient } from "../src/client/socket-client.js";
import { priceCeiling } from "../src/price-ceiling.js";
import { startWorld, type World } from "./harness.js";

let world: World | undefined;
afterEach(async () => { await world?.wallet.close(); world = undefined; });

const id = (i: number) => getAddressDecoder().decode(new Uint8Array(32).fill(i));
function item(i: number, price: string, patch = {}) {
  return { pda: id(i), providerAgent: id(10), specHash: "a".repeat(64), name: "Proofreader", state: 0, priceLamports: price,
    tags: ["proofreading"], category: "writing", defaultDeadlineSecs: 60, ...patch };
}

it("pages distinct provider terms on one ranking while a third offer gets cheaper", async () => {
  const rows = [item(1, "1000"), item(2, "1000", { defaultDeadlineSecs: 86400, maxOpenJobs: 3, operatorFeeBps: 200 }),
    item(3, "2000"), item(4, "1", { tags: ["editing"], summary: "proofreading" }),
    item(5, "1", { category: "research", summary: "writing" }), item(6, "1000", { state: 1 })];
  let now = 0;
  const hosted = createHostedServices({ now: () => now, fetchImpl: async () => Response.json({ total: rows.length, items: rows }) });
  world = await startWorld({ services: (local) => ({ ...local, listServices: hosted.listServices }) });
  const filter = { provider: id(10), tag: "proofreading", category: "writing", state: "active", sort: "price_low", limit: 2 } as const;
  const first = await world.wallet.find(filter);
  expect(first).toMatchObject({ total: 3, services: [{ listing: id(1), deliverySecs: 60 }, { listing: id(2), deliverySecs: 86400 }] });
  const byOffer = await world.wallet.find({ ...filter, limit: 1 });
  expect(byOffer.services).toMatchObject([{ listing: id(1), deliverySecs: 60 }]);
  const otherTerms = await world.wallet.find({ ...filter, limit: 1, offset: 1, cursor: byOffer.cursor! });
  expect(otherTerms.services).toMatchObject([{ listing: id(2), deliverySecs: 86400 }]);
  const wallet = world.wallet;
  const client = { call: (_method: string, params: Parameters<typeof wallet.findPage>[0]) => wallet.findPage(params) } as unknown as WalletClient;
  const chatArgs = { provider: id(10), tag: "proofreading", category: "writing", state: "active", sort: "price_low", limit: 2 };
  const chat = await runMarketTool(client, "buyer", "market_find", chatArgs);
  expect(chat.services?.map((row) => row.id)).toEqual([id(1), id(2)]);
  now += 61_000;
  rows[2]!.priceLamports = "1";
  const next = await runMarketTool(client, "buyer", "market_find", { ...chatArgs, offset: chat.next_offset, cursor: chat.next_cursor });
  expect(next.services?.map((row) => row.id)).toEqual([id(3)]);
  expect(next.next_offset).toBeNull();
  const second = await world.wallet.find({ ...filter, offset: 2, cursor: first.cursor! });
  expect(second.services.map((entry) => [entry.listing, entry.price.lamports])).toEqual([[id(3), "2000"]]);
  expect((await world.wallet.find(filter)).services[0]?.listing).toBe(id(3));
  expect((await world.wallet.find({ ...filter, sort: "price_high", limit: 1 })).services[0]?.price.lamports).toBe("1000");
  expect((await world.wallet.find({ ...filter, state: "paused" })).services).toMatchObject([{ listing: id(6), state: "paused" }]);
  await expect(world.wallet.find({ ...filter, sort: "rating", cursor: first.cursor! })).rejects.toThrow(/filters changed/);
  world.clock.now += 6 * 60_000;
  await expect(world.wallet.find({ ...filter, cursor: first.cursor! })).rejects.toThrow(/expired/);
});

it("uses the same decimal rate for a ceiling, the displayed price and the network fee", async () => {
  let reads = 0;
  let rate = 50.02;
  const rows = [item(1, "1000000000"), item(2, "1000000001")];
  const hosted = createHostedServices({ fetchImpl: async () => Response.json({ total: 2, items: rows }) });
  world = await startWorld({ services: (local) => ({ ...local, listServices: hosted.listServices }),
    config: { prices: { solUsd: async () => { reads++; return rate; } } } });
  reads = 0;
  const result = await world.wallet.findPage({ maxPriceCents: 5002 });
  expect(result.services.map((row) => [row.listing, row.price.usdCents])).toEqual([[id(1), 5002]]);
  expect(reads).toBe(1);
  rate = 100;
  rows[0]!.priceLamports = "2000000";
  await world.wallet.close();
  const changed = createHostedServices({ fetchImpl: async () => Response.json({ total: 2, items: rows }) });
  world.wallet = await world.reopen({ services: { ...world.sandbox.services, listServices: changed.listServices },
    prices: { solUsd: async () => { const sampled = rate; rate = 110; return sampled; } } });
  rate = 100;
  expect((await world.wallet.findPage({ maxPriceCents: 20 })).services).toMatchObject([{ price: { usdCents: 20 } }]);
  expect(priceCeiling(19.9, 99)).toBe(2010101n);
});

it("prepares an approval without awaiting optional catalog metadata", async () => {
  let catalogReads = 0;
  world = await startWorld({ services: (local) => ({ ...local, listServices: () => {
    catalogReads++;
    return new Promise(() => {});
  } }) });
  const agent = await world.wallet.createAgent("Buyer");
  const result = await world.wallet.hire({ agentId: agent.id, listing: world.listing, request: "A poem." });
  expect(result.approval?.service).toMatchObject({ details: "unavailable", name: "Haiku Writer" });
  expect(catalogReads).toBe(0);
});

it.each([true, false])("checks cached descriptions against the on-chain hash at hire (matching: %s)", async (matching) => {
  world = await startWorld({ services: (local) => ({ ...local, listServices: async (filters) =>
    (await local.listServices(filters)).map((row) => ({
      ...row, specHashHex: matching ? row.specHashHex : "a".repeat(64), description: "Cached service description.",
    })),
  }) });
  const agent = await world.wallet.createAgent("Buyer");
  const found = await world.wallet.find({ query: world.listing });
  expect(found.services[0]?.description).toBe("Cached service description.");
  const hire = await world.wallet.hire({ agentId: agent.id, listing: world.listing, request: "A poem." });
  expect(hire.approval?.service).toMatchObject(matching
    ? { details: "ready", description: "Cached service description." }
    : { details: "unavailable", description: null });
});

it("keeps a higher search ceiling from widening the existing panel price guard", async () => {
  world = await startWorld();
  const agent = await world.wallet.createAgent("Buyer");
  await expect(world.wallet.hire({ agentId: agent.id, listing: world.listing, request: "A poem.",
    maxPriceCents: 100, displayedLimitCents: 19.999999 })).rejects.toMatchObject({ code: "PRICE_CHANGED" });
});
