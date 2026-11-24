import { approvedPost } from "./harness.js";
import type { Address } from "@solana/kit";
import { findAgentPda, findTaskJobSpecPda, findTaskValidationConfigPda, getTaskDecoder, getTaskJobSpecDecoder, getTaskValidationConfigDecoder, values } from "@tetsuo-ai/marketplace-sdk";
import { afterEach, expect, it } from "vitest";
import { resolveJobTerms } from "../src/job-terms.js";
import { startWorld, SOL, type World } from "./harness.js";

let world: World;
afterEach(async () => { await world?.wallet.close(); });
const brief = { request: "Read the poem.", acceptance: ["Name its author."], reward: { usdCents: 20 } };
// Every new job carries an explicit output agreement, text allowed by default.
const agreed = [...brief.acceptance, "Agreed outputs v1: text-only delivery allowed; no required files"];

it.each(["agent", "main"] as const)("pins the %s post's exact terms to the task, spec and settlement record", async payer => {
  world = await startWorld();
  const { wallet, sandbox } = world;
  const clock = await sandbox.chain.clusterTime();
  const agent = await wallet.createAgent("Buyer");
  if (payer === "agent") sandbox.fund(agent.address as Address, SOL);
  const minReputation = payer === "main" ? 10000 : 0;
  const requiredCapabilities = payer === "main" ? "1" : "18446744073709551615";
  const input = { ...brief, deadline: clock + 719, reviewWindowSecs: 17, minReputation, requiredCapabilities, idempotencyKey: "brief" };
  const prepare = () => payer === "main" ? wallet.quotePost(input) : wallet.post({ ...input, agentId: agent.id });
  const quoted = await prepare();
  expect(quoted.approval).toMatchObject({ acceptance: agreed, terms: { deadline: input.deadline, reviewWindowSecs: 17, eligibility: { minReputation, requiredCapabilities } } });
  expect(quoted.job.task).toBeNull();
  expect((await prepare()).approval?.id).toBe(quoted.approval!.id);
  sandbox.advanceClock(9);
  const posted = await wallet.decideApproval(quoted.approval!.id, true);
  const task = posted.task as Address;
  const account = getTaskDecoder().decode((await sandbox.chain.readAccount(task))!);
  expect(account).toMatchObject({ minReputation, requiredCapabilities: BigInt(requiredCapabilities), deadline: BigInt(input.deadline) });
  const [config] = await findTaskValidationConfigPda({ task });
  expect(getTaskValidationConfigDecoder().decode((await sandbox.chain.readAccount(config))!).reviewWindowSecs).toBe(17n);
  const [pointer] = await findTaskJobSpecPda({ task });
  const spec = getTaskJobSpecDecoder().decode((await sandbox.chain.readAccount(pointer))!);
  const published = JSON.parse(new TextDecoder().decode(await sandbox.services.resolveAgencUri!(spec.jobSpecUri)));
  expect(published.payload).toMatchObject({ instructions: brief.request, acceptance: agreed });
  expect(published.payload.deliverable).toContain(new Date(input.deadline * 1000).toISOString());
  expect(published.payload.deliverable).toContain(`capability mask ${requiredCapabilities}`);
  expect((await wallet.getJob(posted.id, true)).terms).toEqual(quoted.approval!.terms);
  if (minReputation === 10000) {
    const signer = await sandbox.market.fundedSigner();
    const client = sandbox.chain.clientFor(signer);
    const agentId = values.randomId32();
    await client.registerAgent({ authority: signer, agentId, capabilities: 1n, endpoint: "https://sandbox.invalid/worker", metadataUri: null, stakeAmount: 10_000_000n });
    const [worker] = await findAgentPda({ agentId });
    await expect(client.claimTaskWithJobSpec({ task, worker, authority: signer, jobSpecHash: new Uint8Array(spec.jobSpecHash) })).rejects.toMatchObject({ code: 6189 });
  }
});

it("quotes a funded hire without spending and retains its payer, brief, price cap and review clock", async () => {
  world = await startWorld();
  const { wallet, sandbox, listing } = world;
  const agent = await wallet.createAgent("Buyer");
  sandbox.fund(agent.address as Address, SOL);
  const before = await world.balance(wallet.mainAddress);
  const deadline = await sandbox.chain.clusterTime() + 300;
  const { approval, job } = await wallet.hire({ agentId: agent.id, listing, request: brief.request, acceptance: brief.acceptance, deadline, reviewWindowSecs: 1, maxPriceCents: 21 }, true);
  expect(approval).toMatchObject({ fromMain: { lamports: "0" }, maxPriceCents: 21, terms: { deadline, reviewWindowSecs: 1, listingDurationSecs: 3600 } });
  expect(approval!.expiresAt - approval!.createdAt).toBe(300_000);
  expect(job.task).toBeNull();
  expect(await wallet.listJobs({}, true)).toHaveLength(0);
  expect(await wallet.listApprovals()).toHaveLength(0);
  sandbox.advanceClock(10);
  const decisions = await Promise.all([wallet.decideApproval(approval!.id, true), wallet.decideApproval(approval!.id, true)]);
  const placed = decisions[0]!;
  expect(decisions[1]?.task).toBe(placed.task);
  expect(await world.balance(wallet.mainAddress)).toBe(before);
  const task = placed.task as Address;
  const [validation] = await findTaskValidationConfigPda({ task });
  expect(getTaskValidationConfigDecoder().decode((await sandbox.chain.readAccount(validation))!).reviewWindowSecs).toBe(1n);
  expect(await sandbox.workOnce()).toBe(1);
  const delivered = await wallet.getJob(job.id, true);
  expect(delivered).toMatchObject({ acceptance: agreed, terms: approval!.terms, status: "delivered" });
  expect(delivered.marketplaceDeadline).toBe(Number(getTaskDecoder().decode((await sandbox.chain.readAccount(task))!).deadline));
  expect(delivered.autoApproveAt).toBe(((await sandbox.chain.clusterTime()) + 1) * 1000);
  await wallet.close();
  world.wallet = await world.reopen();
  expect((await world.wallet.decideApproval(approval!.id, true)).task).toBe(task);
});

it("refuses changed terms for concurrent calls and after restart, without creating a second job", async () => {
  world = await startWorld();
  const agent = await world.wallet.createAgent("Buyer");
  const input = { ...brief, agentId: agent.id, idempotencyKey: "one-key", minReputation: 100 };
  const pending = world.wallet.post(input);
  await expect(world.wallet.post({ ...input, minReputation: 99 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  const quote = await pending;
  await world.wallet.close();
  world.wallet = await world.reopen();
  for (const change of [{ requiredCapabilities: "2" }, { reviewWindowSecs: 42 }, { acceptance: ["Other terms"] }, { deadlineDays: 3 }]) {
    await expect(world.wallet.post({ ...input, ...change })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
  expect((await world.wallet.post({ ...input, acceptance: ["  Name   its author. "] })).approval?.id).toBe(quote.approval!.id);
  expect(await world.wallet.listJobs({}, true)).toHaveLength(1);
});

it("refuses a changed deposit and an expired quote before funding", async () => {
  world = await startWorld();
  const { wallet, clock } = world;
  const first = await wallet.quotePost(brief);
  await approvedPost(wallet, { ...brief, request: "Start the payer's record." });
  const before = await world.balance(wallet.mainAddress);
  await expect(wallet.decideApproval(first.approval!.id, true)).rejects.toMatchObject({ code: "PRICE_CHANGED" });
  const fresh = await wallet.quotePost(brief);
  clock.now = fresh.approval!.expiresAt;
  await expect(wallet.decideApproval(fresh.approval!.id, true)).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
  expect(await world.balance(wallet.mainAddress)).toBe(before);
});

it.each([null, 3600])("enforces creator-review bounds for delivery period %s", duration => {
  const terms = (window: number) => resolveJobTerms({ reviewWindowSecs: window }, 100, 86400n, duration);
  for (const valid of [1, 604800]) expect(terms(valid).reviewWindowSecs).toBe(valid);
  for (const invalid of [0, -1, 1.1, 604801]) expect(() => terms(invalid)).toThrow(/review window/);
  expect(() => resolveJobTerms({ deadline: 100 }, 100, 86400n, duration)).toThrow(/deadline/);
});

it("keeps the quoted main contribution when the agent gains funds before approval", async () => {
  world = await startWorld();
  const { wallet, sandbox } = world;
  const buyer = await wallet.createAgent("Buyer");
  const { approval } = await wallet.post({ ...brief, agentId: buyer.id });
  expect(approval!.fromMain).toEqual(approval!.total);
  sandbox.fund(buyer.address as Address, SOL);
  const before = await world.balance(buyer.address);
  const placed = await wallet.decideApproval(approval!.id, true);
  const task = getTaskDecoder().decode((await sandbox.chain.readAccount(placed.task as Address))!);
  expect(task.creator).toBe(wallet.mainAddress);
  expect(await world.balance(buyer.address)).toBe(before);
  expect(approval!.marketFee?.bps).toBe(task.protocolFeeBps);
});

it("binds the owner post's key and checks eligibility before main-balance spending", async () => {
  world = await startWorld();
  const { wallet } = world;
  const before = await world.balance(wallet.mainAddress);
  for (const minReputation of [-1, 0.5, 10001]) {
    await expect(approvedPost(wallet, { ...brief, minReputation })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
  for (const mask of ["0", "-1", "1.5", "18446744073709551616"]) {
    await expect(approvedPost(wallet, { ...brief, requiredCapabilities: mask })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
  expect(await world.balance(wallet.mainAddress)).toBe(before);
  const input = { ...brief, idempotencyKey: "main-post", minReputation: 50 };
  const job = await approvedPost(wallet, input);
  expect((await approvedPost(wallet, input)).task).toBe(job.task);
  await expect(approvedPost(wallet, { ...input, minReputation: 51 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

it("requires a new hire quote when the dollar cap can no longer cover the price", async () => {
  let rate = 100;
  world = await startWorld({ config: { prices: { solUsd: async () => rate } } });
  const { wallet, listing } = world;
  const agent = await wallet.createAgent("Buyer");
  const quoted = await wallet.hire({ agentId: agent.id, listing, request: brief.request, maxPriceCents: 21 }, true);
  const before = await world.balance(wallet.mainAddress);
  rate = 200;
  await expect(wallet.decideApproval(quoted.approval!.id, true)).rejects.toMatchObject({ code: "PRICE_CHANGED" });
  expect(await world.balance(wallet.mainAddress)).toBe(before);
  expect(await wallet.listJobs({}, true)).toHaveLength(0);
});
