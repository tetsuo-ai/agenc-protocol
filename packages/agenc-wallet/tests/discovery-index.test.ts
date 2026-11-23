import { getAddressDecoder, getBase58Decoder } from "@solana/kit";
import { createIndexerClient, getServiceListingEncoder, ListingState, values } from "@tetsuo-ai/marketplace-sdk";
import { describe, expect, it } from "vitest";
import { createHostedServices } from "../src/services.js";

const id = (i: number) => {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(0, i + 1);
  return getAddressDecoder().decode(bytes);
};
const rows = Array.from({ length: 200 }, (_, i) => ({
  pda: id(i), name: "Service", providerAgent: id(300), state: 0, priceLamports: "100",
}));

describe("the hosted discovery index", () => {
  it.each([ListingState.Active, "Active", "Paused", "Retired"] as const)(
    "keeps the SDK listing terms on a cold ID read with state %s", async (wireState) => {
      const state = typeof wireState === "number" ? wireState : ListingState[wireState];
      const stateFilter = (["active", "paused", "retired"] as const)[state]!;
      const pda = id(1), provider = id(2), authority = id(3);
      const name = "Proofreader", category = "writing", tags = ["editing", "english"];
      const fields = {
        name, category, tags, provider, authority, state: wireState, price: "5000", priceMint: null,
        specHash: "ab".repeat(32), specUri: "agenc://description", openJobs: 1, maxOpenJobs: 4,
        totalHires: "6", version: "2", createdAt: "10", updatedAt: "20",
      };
      const bytes = getServiceListingEncoder().encode({
        ...fields, name: values.encodeListingName(name), category: values.encodeListingCategory(category),
        tags: values.encodeListingTags(tags), state, providerAgent: provider, listingId: new Uint8Array(32),
        specHash: Buffer.from(fields.specHash, "hex"), price: 5000n, defaultDeadlineSecs: 3600n,
        requiredCapabilities: 1n, operator: authority, operatorFeeBps: 0, ratingCount: 2, totalRating: 8n,
        totalHires: 6n, version: 2n, createdAt: 10n, updatedAt: 20n, reserved: new Uint8Array(32), bump: 1,
      });
      const listing = { pda, decoded: fields, accountData: Buffer.from(bytes).toString("base64"),
        metadataValid: true, metadataIssues: [], lastSlot: 25, lastSignature: getBase58Decoder().decode(new Uint8Array(64)) };
      const item = { ...fields, state, pda, providerAgent: provider, priceLamports: fields.price,
        defaultDeadlineSecs: 3600, ratingCount: 2, provenance: { rawRatingAverage: 4 } };
      const fetchImpl: typeof fetch = async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === `/api/explorer/listings/${pda}`) return Response.json({ success: true, listing });
        if (path === `/listings/${pda}/agent-card.json`) return Response.json({ id: pda, providerAgent: provider, hireability: { hireable: true } });
        expect(path).toBe("/api/listings");
        return Response.json({ items: [item], total: 1 });
      };
      const sdk = createIndexerClient({ baseUrl: "http://localhost", fetchImpl });
      expect((await sdk.getListing(pda)).decoded.state).toBe(wireState);
      const adapter = createHostedServices({ fetchImpl });
      const [cold] = await adapter.listServices({ listing: pda, state: stateFilter });
      const [catalog] = await adapter.listServices({ state: stateFilter });
      expect(catalog).toMatchObject({ listing: pda, deliverySecs: 3600, rating: 4, ratingCount: 2, jobsDone: 0, tags });
      expect(cold).toMatchObject(catalog!);
    },
  );

  it.each(["overlap", "early end", "new slot", "changed page"])("never publishes an incomplete or mixed catalog after %s", async (fault) => {
    let broken = true;
    let calls = 0;
    let firstPages = 0;
    const adapter = createHostedServices({ fetchImpl: async (input) => {
      calls++;
      const page = Number(new URL(String(input)).searchParams.get("page"));
      const items = rows.slice((page - 1) * 100, page * 100);
      if (broken && page === 2 && fault === "early end") items.length = 0;
      if (broken && page === 2 && fault === "overlap") items[0] = rows[99]!;
      if (page === 1) firstPages++;
      if (broken && page === 1 && firstPages % 2 === 0 && fault === "changed page") items.reverse();
      return Response.json({ page, total: rows.length, items,
        ...(fault === "changed page" ? {} : { slot: broken && fault === "new slot" ? page : 99 }) });
    } });
    await expect(adapter.listServices()).rejects.toMatchObject({ code: "NETWORK" });
    expect(calls).toBe(fault === "changed page" ? 6 : 4);
    broken = false;
    expect((await adapter.listServices()).map((row) => row.listing)).toEqual(rows.map((row) => row.pda));
    const verified = calls;
    await adapter.listServices();
    expect(calls).toBe(verified);
  });

  it("bounds the whole scan, resumes at the interrupted page, and reads a cold ID while it is busy", async () => {
    let blocked = true;
    let onSecond!: () => void;
    const second = new Promise<void>((resolve) => { onSecond = resolve; });
    const asked: number[] = [];
    const wanted = rows[199]!;
    const adapter = createHostedServices({ catalogTimeoutMs: 100, fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === `/api/explorer/listings/${wanted.pda}`) return Response.json({ listing: {
        pda: wanted.pda, metadataValid: true, decoded: { ...wanted, provider: wanted.providerAgent, price: wanted.priceLamports },
      } });
      if (url.pathname.endsWith("/agent-card.json")) return Response.json({ id: wanted.pda, providerAgent: wanted.providerAgent, hireability: { hireable: true } });
      if (url.searchParams.has("providerAgent")) return Response.json({ total: 1, items: [wanted] });
      const page = Number(url.searchParams.get("page"));
      asked.push(page);
      if (blocked && page === 2) { onSecond(); return new Promise<Response>(() => {}); }
      return Response.json({ slot: 2, page, total: 200, items: rows.slice((page - 1) * 100, page * 100) });
    } });
    const full = adapter.listServices();
    const timeout = expect(full).rejects.toMatchObject({ code: "NETWORK" });
    await second;
    expect(await adapter.listServices({ listing: wanted.pda })).toMatchObject([{ listing: wanted.pda }]);
    await timeout;
    blocked = false;
    expect(await adapter.listServices()).toHaveLength(200);
    expect(asked).toEqual([1, 2, 2]);
  });
});
