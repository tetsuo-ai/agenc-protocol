import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createHostedServices } from "../src/services.js";
import type { WalletState } from "../src/store.js";
import { startWorld, type World } from "./harness.js";

let world: World;
afterEach(async () => { await world?.wallet.close(); });

it("keeps an unreadable current description out of the saved approval", async () => {
  const stale = "Words from the former listing.";
  world = await startWorld({ services(base) {
    const hosted = createHostedServices({
      siteUrl: "https://catalog.invalid",
      async fetchImpl() {
        const [row] = await base.listServices();
        return Response.json({ total: 1, items: [{
          state: 0, pda: row!.listing, providerAgent: row!.providerAgent, name: row!.name,
          priceMint: null, priceLamports: row!.priceLamports.toString(), defaultDeadlineSecs: row!.deliverySecs,
          specHash: row!.specHashHex, specUri: "https://spec.invalid/current", summary: stale,
        }] });
      },
      publicFetcher: async () => { throw new Error("Description unavailable"); },
    });
    return { ...base, listServices: hosted.listServices };
  } });
  const { wallet, listing } = world;
  const agent = await wallet.createAgent("Buyer");
  const { approval } = await wallet.hire({ agentId: agent.id, listing, request: "Write a poem." });
  expect(approval!.service).toMatchObject({ details: "unavailable", summary: null });
  const state: WalletState = JSON.parse(readFileSync(join(world.dataDir, "state.json"), "utf8"));
  expect(state.approvals[approval!.id]!.service!.summary).toBeNull();
});

it("replays the raw acceptance fingerprint from an older journal after restart", async () => {
  world = await startWorld();
  const { wallet, listing } = world;
  const agent = await wallet.createAgent("Buyer");
  const request = "Write a poem.";
  const acceptance = ["Use   three lines."];
  const input = { request, acceptance, listing, agentId: agent.id, idempotencyKey: "before-upgrade" };
  const original = await wallet.hire(input);
  await wallet.close();
  const file = join(world.dataDir, "state.json");
  const state: WalletState = JSON.parse(readFileSync(file, "utf8"));
  // The shipped raw-text encoding. Keep the fixture independent of today's serializer.
  state.jobs[original.job.id]!.inputFingerprint = createHash("sha256").update(JSON.stringify([
    false, request, acceptance, listing, null, null, null, null, null, 0, "1",
  ])).digest("hex");
  writeFileSync(file, JSON.stringify(state));
  world.wallet = await world.reopen();
  expect((await world.wallet.hire(input)).approval!.id).toBe(original.approval!.id);
  for (const change of [{ acceptance: ["Use four lines."] }, { expectedPriceLamports: "123" }]) {
    await expect(world.wallet.hire({ ...input, ...change })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
  expect(await world.wallet.listJobs({}, true)).toHaveLength(1);
});

it.each(["agent", "main"] as const)("replays a pre-upgrade %s post without funding twice", async payer => {
  world = await startWorld();
  const agent = await world.wallet.createAgent("Buyer");
  const request = "Write a poem.";
  const acceptance = ["Use   three lines."];
  const input = { request, acceptance, reward: { usdCents: 30 }, idempotencyKey: "older-post" };
  const post = (minReputation: number) => payer === "main"
    ? world.wallet.quotePost({ ...input, minReputation })
    : world.wallet.post({ ...input, agentId: agent.id, minReputation });
  const first = await post(10);
  const placed = await world.wallet.decideApproval(first.approval!.id, true);
  expect(placed.task).toBeTruthy();
  await world.wallet.close();
  const file = join(world.dataDir, "state.json");
  const state: WalletState = JSON.parse(readFileSync(file, "utf8"));
  state.jobs[first.job.id]!.inputFingerprint = createHash("sha256").update(JSON.stringify([
    payer === "main", request, acceptance, null, ["usdCents", 30], null, null, 7, null, 10, "1",
  ])).digest("hex");
  writeFileSync(file, JSON.stringify(state));
  world.wallet = await world.reopen();
  const balance = await world.balance(world.wallet.mainAddress);
  expect((await post(10)).job.task).toBe(placed.task);
  await expect(post(11)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(await world.balance(world.wallet.mainAddress)).toBe(balance);
});

it.each([
  [undefined, false], [20, false], [undefined, true], [20, true],
] as const)("refreshes the price within the buyer's own cap (%s, legacy %s)", async (maxPriceCents, legacy) => {
  let rate = 100;
  world = await startWorld({ config: { prices: { solUsd: async () => rate } } });
  const { wallet, listing } = world;
  const agent = await wallet.createAgent("Buyer");
  const first = (await wallet.hire({ agentId: agent.id, listing, request: "Write a poem.", ...(maxPriceCents !== undefined && { maxPriceCents }) })).approval!;
  expect(first.maxPriceCents).toBe(20);
  await wallet.close();
  if (legacy) {
    const file = join(world.dataDir, "state.json");
    const state: WalletState = JSON.parse(readFileSync(file, "utf8"));
    delete state.jobs[first.jobId]!.buyerMaxPriceCents;
    writeFileSync(file, JSON.stringify(state));
  }
  world.wallet = await world.reopen();
  rate = 110;
  await expect(world.wallet.decideApproval(first.id, true)).rejects.toMatchObject({ code: "PRICE_CHANGED" });
  if (maxPriceCents !== undefined) {
    await expect(world.wallet.refreshApproval(first.id)).rejects.toMatchObject({ code: "PRICE_CHANGED" });
    expect((await world.wallet.listApprovals())[0]!.id).toBe(first.id);
    return;
  }
  const { approval } = await world.wallet.refreshApproval(first.id);
  expect(approval).toMatchObject({ jobId: first.jobId, price: { usdCents: 22 }, service: { price: { usdCents: 22 } }, maxPriceCents: 22 });
  await expect(world.wallet.decideApproval(first.id, true)).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
  expect((await world.wallet.decideApproval(approval.id, true)).status).toBe("waiting");
});
