import { afterEach, expect, it } from "vitest";
import { childDigest } from "../src/child-hire.js";
import { DEFAULT_SELLER_TERMS } from "../src/client/seller-terms.js";
import type { ChildHirePolicy } from "../src/client/child-hire.js";
import { CENT, eventually, startWorld, REVIEW_ALLOWANCE } from "./harness.js";

let world: Awaited<ReturnType<typeof startWorld>> | undefined;
afterEach(async () => { await world?.wallet.close(); world = undefined; });

// Practice money must carry a listing's verified fulfilment (here a supplier policy) like the real
// catalog, or a practice parent hire cannot bind the supplier digest (g1's three-origin run).
it("lists a practice service's published supplier policy in the catalog", async () => {
  world = await startWorld({ earn: {
    executor: { argv: [process.execPath, "-e", "process.stdout.write('Parent result')", "{prompt}"], mode: "sandboxed", jobRoom:true, isolatedJobRoom:true, envAllowlist: [], timeoutMs: 60_000 },
    pollIntervalMs: 150, serviceRefreshMs: 300,
  } });
  const { wallet, sandbox } = world;
  const seller = await wallet.createAgent("Selling studio");
  await wallet.setPolicy(seller.id, { askAboveCents: 1000, refill: { ...REVIEW_ALLOWANCE, perDayCents: 10000 } });
  await wallet.fundAgent(seller.id, { lamports: String(5000n * CENT) });
  const supplier = await sandbox.addService({ name: "Short report", category: "writing", summary: "A short report",
    deliverySecs: 600, priceLamports: 20n * CENT, replyPrefix: "Supplier result" });
  const policy: ChildHirePolicy = { allowedListings: [supplier], maxDebitLamports: "100000000", returnBeforeSecs: 10,
    reviewWindowSecs: 5, sharing: "public-brief" };
  const offer = { name: "Studio report", summary: "A finished report with one supplier.", price: { usdCents: 100 },
    terms: { ...DEFAULT_SELLER_TERMS, deliverySecs: 36000, childPolicy: policy } };
  const initial = await wallet.quoteEarn(seller.id, offer);
  await wallet.setOffer(seller.id, offer, undefined, initial.quoteId);
  const startup = await wallet.quoteEarn(seller.id, undefined, undefined, 1);
  await wallet.setEarn(seller.id, true, 1, startup.quoteId);
  const listing = await eventually(async () => {
    await wallet.tick();
    return (await wallet.overview()).agents.find((a) => a.id === seller.id)?.earn.offer?.listing;
  });
  const row = await eventually(async () => {
    await wallet.tick();
    const found = (await sandbox.services.listServices({ listing })).find((r) => r.listing === listing);
    return found?.fulfilment?.supplier ? found : undefined;
  });
  expect(row.fulfilment?.supplier).toMatchObject({ payingSeller: seller.address, digest: childDigest(policy) });
});
