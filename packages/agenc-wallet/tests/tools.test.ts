// What an agent's market_find says about a service: its record, weighed by
// money, and the marketplace's share of the price, and nothing it cannot
// know when a wallet older than its client leaves those out.
import { describe, expect, it } from "vitest";
import { runMarketTool } from "../src/client/tools.js";
import type { WalletClient } from "../src/client/socket-client.js";
import type { ServiceView } from "../src/client/types.js";

const usd = (cents: number) => ({ lamports: String(cents * 100_000), usdCents: cents });

const SERVICE: ServiceView = {
  listing: "AuvhnvakgqfJaBt5CSEnYZGsZYJt5LmCpanZDCWbf9hE",
  name: "Haiku Writer",
  summary: "A three-line poem about anything you name.",
  description: "A three-line poem about anything you name.",
  category: "writing",
  tags: [],
  inputs: [],
  outputs: [],
  terms: [],
  details: "ready",
  price: usd(20),
  marketFee: { bps: 500, amount: usd(1) },
  rating: 4.5,
  ratingCount: 2,
  jobsDone: 3,
  paid: usd(60),
  buyers: 2,
  record: "ready",
  provider: "3PgS4jwwpquqxVotTKkvR8wxNUZrExqtZckHehiABKAg",
  offeredBy: {
    since: Date.UTC(2026, 7, 21),
    jobsDone: 1,
    paid: usd(20),
    buyers: 1,
    turnedDown: 2,
    disputesLost: 1,
    deposit: usd(74),
    otherServices: [],
  },
  deliverySecs: 600,
};

function client(services: unknown[]): WalletClient {
  return {
    role: "agent",
    agentId: "agent_1",
    call: (async () => ({ services, total: services.length, networkFee: usd(22) })) as WalletClient["call"],
    close() {},
  };
}

async function described(service: unknown): Promise<Record<string, unknown>> {
  const result = await runMarketTool(client([service]), "agent_1", "market_find", { query: "poem" });
  expect(result.ok).toBe(true);
  return result.services![0] as unknown as Record<string, unknown>;
}

describe("a service as an agent reads it", () => {
  it("gives its record with the count beside the stars, and the marketplace's share", async () => {
    expect(await described(SERVICE)).toMatchObject({
      marketplace_fee: "$0.01 of the price (5%)",
      rating: "4.5 of 5 from 2 ratings",
      paid_jobs: "3 jobs, $0.60 paid by 2 buyers",
      provider: {
        on_the_marketplace_since: "2026-08-21",
        paid_jobs: "1 job, $0.20 paid by 1 buyer",
        turned_down: 2,
        disputes_lost: 1,
      },
    });
  });

  it("says when the record is not known, and claims nothing from it", async () => {
    const loading = await described({ ...SERVICE, record: "loading", offeredBy: null });
    expect(loading.record).toMatch(/still being read/);
    expect(loading).not.toHaveProperty("rating");
    expect(loading).not.toHaveProperty("paid_jobs");
    const unavailable = await described({ ...SERVICE, record: "unavailable", offeredBy: null });
    expect(unavailable.record).toMatch(/could not be read/);
  });

  it("reads a service from an older wallet, which has no record and no fee", async () => {
    const { marketFee: _fee, paid: _paid, buyers: _buyers, record: _record, offeredBy: _by, ...older } = SERVICE;
    const said = await described(older);
    expect(said).toMatchObject({ name: "Haiku Writer", price: "$0.20" });
    expect(said).not.toHaveProperty("marketplace_fee");
    expect(said).not.toHaveProperty("rating");
    expect(said.record).toMatch(/could not be read/);
  });
});
