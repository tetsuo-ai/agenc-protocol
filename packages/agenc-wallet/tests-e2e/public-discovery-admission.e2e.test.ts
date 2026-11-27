import { afterEach, expect, it, vi } from "vitest";
import { generateKeyPairSigner, getAddressDecoder, type KeyPairSigner } from "@solana/kit";
import { getAgentRegistrationDecoder, getAgentRegistrationEncoder, getTaskDecoder, getTaskEncoder, TaskStatus, TaskType } from "@tetsuo-ai/marketplace-sdk";
import { EarnHost } from "../src/earn.js";
import { createPublicCatalog } from "../src/public-discovery.js";
import { listingMessageText, verifyListingMessage, type ListingHeartbeat, type ListingQuestion, type SignedListing, type ListingAgreement, type ListingMessage } from "../src/client/listing-exchange.js";
import { readListing } from "../src/market.js";
import { CENT, HAIKU, eventually, setEarnWithApproval, setOfferWithApproval, startWorld, type World } from "./harness.js";

let world: World;
afterEach(async () => { await world?.wallet.close(); });

async function sign<T extends ListingMessage>(signer: KeyPairSigner, message: T) {
  const [result] = await signer.signMessages([{ content: new TextEncoder().encode(listingMessageText(message)), signatures: {} }]);
  return { message, signature: Buffer.from(result![signer.address]!).toString("base64") };
}

it("reads 301 services on a fixed snapshot with no wallet, including a live mutation and a changed filter", async () => {
  world = await startWorld();
  const { sandbox } = world;
  const [row] = await sandbox.services.listServices();
  const rows = Array.from({ length: 301 }, (_, i) => ({ ...row!, listing: getAddressDecoder().decode(Uint8Array.from({length: 32}, (_, n) => n === 0 ? i % 256 : n === 1 ? i >> 8 : 5)),
    listingVersion: "1", maxOpenJobs: 1, operatorFeeBps: 0, operator: null, priceLamports: BigInt(i + 1) }));
  await world.wallet.close();
  const now = vi.spyOn(Date, "now");
  const search = createPublicCatalog(sandbox.chain, { ...sandbox.services, listServices: async () => [...rows] }, sandbox.prices);
  const filters = { sort: "price_low", category: row!.category!, limit: 20 } as const;
  const first = await search(filters);
  expect(first.total).toBe(301);
  rows.splice(20, 1);
  const ids = first.services.map(s => s.listing);
  while (ids.length < first.total) {
    const page = await search({ ...filters, offset: ids.length, cursor: first.cursor! });
    expect(page.cursor).toBe(first.cursor);
    ids.push(...page.services.map(s => s.listing));
  }
  expect(new Set(ids).size).toBe(301);
  expect((await search(filters)).total).toBe(300);
  await expect(search({ ...filters, offset: 20 })).rejects.toThrow(/cursor/);
  await expect(search({ ...filters, sort: "price_high", offset: 20, cursor: first.cursor! })).rejects.toThrow(/filters changed/);
  now.mockReturnValue(Date.now() + 300001);
  await expect(search({ ...filters, offset: 20, cursor: first.cursor! })).rejects.toThrow(/expired/);
  now.mockRestore();
});

it("reports exact revision 9 eligibility and never claims during inspection", async () => {
  world = await startWorld({ earn: { executor: { argv: [process.execPath, "-e", "process.stdout.write('ok')", "{prompt}"],
    mode: "sandboxed", timeoutMs: 3000, envAllowlist: [] }, chosenRoomEnabled: () => true, pollIntervalMs: 200 } });
  const { wallet, sandbox } = world;
  const worker = await wallet.createAgent("Worker");
  wallet.chooseWork(worker.id, true);
  const { task } = await sandbox.postOpenJob({ title: "Task", instructions: "Write one line.", rewardLamports: 50n * CENT, deadlineSeconds: 7200 });
  await wallet.fundAgent(worker.id, { usdCents: 2000 });
  await wallet.setPolicy(worker.id, { askAboveCents: 500, refill: { enabled: true, topUpToCents: 1, perDayCents: 500 } });
  await setEarnWithApproval(wallet, worker.id, true);
  const inspect = () => wallet.openWork(worker.id, 0, task);
  await eventually(async () => (await inspect().catch(() => null))?.jobs.length === 1);
  const account = sandbox.market.svm.getAccount(task);
  if (!account.exists) throw new Error("Missing fixture");
  const raw = getTaskDecoder().decode(account.data);
  const patch = (changes: Partial<typeof raw>) => sandbox.market.svm.setAccount({ ...account,
    data: new Uint8Array(getTaskEncoder().encode({ ...raw, ...changes })) } as never);
  for (const [changes, code] of [
    [{ requiredCapabilities: 8n }, "capability"], [{ minReputation: 10_000 }, "reputation"],
    [{ deadline: 1n }, "expired"], [{ maxWorkers: 1, currentWorkers: 1 }, "occupied"],
    [{ status: TaskStatus.InProgress, taskType: TaskType.Collaborative, maxWorkers: 2, currentWorkers: 1 }, "available"],
    [{ status: TaskStatus.PendingValidation, taskType: TaskType.Collaborative, maxWorkers: 2, currentWorkers: 1 }, "available"],
  ] as const) {
    patch(changes);
    expect((await inspect()).eligibility).toMatchObject({ task, code });
  }
  expect((await wallet.openWork(worker.id, 0, (await generateKeyPairSigner()).address)).eligibility).toMatchObject({ code: "missing" });
  // C supplies the rehearsed local mask. The registration must independently support every requested bit.
  const lane = EarnHost.prototype.workerLane;
  const route = vi.spyOn(EarnHost.prototype, "workerLane").mockImplementation(function (this: EarnHost, ...args) {
    const dispatch = lane.apply(this, args);
    return work => dispatch(async (ctx, agent, signal) => {
      const reg = sandbox.market.svm.getAccount(agent.agentPda);
      if (!reg.exists) throw new Error("Missing test registration");
      const bytes = getAgentRegistrationEncoder().encode({ ...getAgentRegistrationDecoder().decode(reg.data), capabilities: 5n });
      sandbox.market.svm.setAccount({ ...reg, data: new Uint8Array(bytes) } as never);
      return work({ ...ctx, config: { ...ctx.config, capabilities: 5n } }, agent, signal);
    });
  });
  patch({ requiredCapabilities: 5n });
  expect((await inspect()).eligibility).toMatchObject({ task, code: "available" });
  route.mockRestore();
  expect((await inspect()).eligibility).toMatchObject({ task, code: "capability" });
  const failedRead = vi.spyOn(sandbox.chain, "readAccount").mockRejectedValue(new Error("Temporary RPC outage"));
  expect((await inspect()).eligibility).toMatchObject({ task, code: "unavailable", retryable: true });
  failedRead.mockRestore();
  expect(wallet.pendingWork()).toEqual([]);
}, 30000);

it("binds the two signers and only selected terms to a funded hire across a wallet restart", async () => {
  let published = "";
  const relay = vi.fn(async () => Response.json({ ok: true }));
  world = await startWorld({ config: { listingRelay: relay }, services: base => ({ ...base, async publishJobSpec(input) {
    published = input.request;
    return base.publishJobSpec(input);
  } }) });
  const { sandbox, wallet, clock } = world;
  const generated = vi.spyOn(sandbox.market, "fundedSigner");
  const listing = await sandbox.addService({ ...HAIKU, name: "Custom haiku" });
  const seller = await generated.mock.results[0]!.value;
  generated.mockRestore();
  const buyer = await wallet.createAgent("Poetry buyer");
  const current = (await readListing(sandbox.chain, listing))!;
  const identity = { listing, version: current.version.toString(), provider: seller.address };
  expect(seller.address).toBe(current.authority);
  const validity = { issued: clock.now, expires: clock.now + 60000 };
  const question = await wallet.postListingMessage(buyer.id, { ...identity, ...validity, kind: "question",
    buyer: buyer.address, question: "Can you deliver two variations?" }) as SignedListing<ListingQuestion>;
  expect(relay).toHaveBeenCalledOnce();
  const reply = await sign(seller, { ...identity, ...validity, kind: "reply", buyer: buyer.address,
    questionSignature: question.signature, reply: "Here are options.", terms: ["Two variations", "Additional revision"] });
  const agreement: ListingAgreement = { question, reply, selected: [0] };
  const params = { agentId: buyer.id, listing, request: "Write about a pond.", maxPriceCents: 25,
    listingAgreement: agreement, idempotencyKey: "two-poems" };
  const quoted = await wallet.hire(params);
  expect(quoted.approval?.terms?.inquiry).toMatchObject({ ...identity, buyer: buyer.address, terms: ["Two variations"],
    agreementHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  // The unfunded agent asked; the main wallet funds and reviews. Both are bound.
  expect(buyer.address).not.toBe(wallet.mainAddress);
  expect(quoted.approval?.terms?.inquiry?.payingCreator).toBe(wallet.mainAddress);
  const changed = { ...agreement, selected: [1] };
  await expect(wallet.hire({ ...params, listingAgreement: changed })).rejects.toThrow();
  const forged = { ...reply, message: { ...reply.message, terms: ["Different deliverable"] } };
  await expect(wallet.hire({ ...params, idempotencyKey: "forged", listingAgreement: { ...agreement, reply: forged } })).rejects.toMatchObject({ code: "PRICE_CHANGED" });
  await wallet.close();
  world.wallet = await world.reopen();
  expect((await world.wallet.hire(params)).approval?.id).toBe(quoted.approval!.id);
  const paid = await world.wallet.decideApproval(quoted.approval!.id, true);
  expect(paid.status).toBe("waiting");
  // Every projection of the agreed terms names the paying creator beside the requester.
  for (const view of [paid, await world.wallet.getJob(paid.id, true), await world.wallet.getJob(paid.id, false, buyer.id),
    ...(await world.wallet.listJobs({}, true)).filter(j => j.id === paid.id)])
    expect(view.terms?.inquiry).toMatchObject({ buyer: buyer.address, payingCreator: world.wallet.mainAddress });
  expect(published).toContain(quoted.approval!.terms!.inquiry!.agreementHash);
  expect(published).toContain("Two variations");
  expect(published).toContain("Buyer " + buyer.address);
  expect(published).toContain("Paying creator " + wallet.mainAddress);
  expect(paid.task).toBeTruthy();
  const account = sandbox.market.svm.getAccount(paid.task as never);
  if (!account.exists) throw new Error("The funded task is missing");
  expect(String(getTaskDecoder().decode(account.data).creator)).toBe(wallet.mainAddress);
  expect(published).not.toContain("Additional revision");
  expect(published).not.toContain(question.message.question);
});

it("publishes an expiring seller heartbeat only after a room check and uses the owner's listing preference", async () => {
  const sent: SignedListing<ListingHeartbeat>[] = [];
  let ready = true;
  let checks = 0;
  let selected: "core" | "claude-code" = "core";
  world = await startWorld({ config: { listingRelay: async (_url, options) => {
    sent.push(JSON.parse(String(options?.body)));
    return Response.json({ ok: true });
  } }, earn: { executor: { argv: [process.execPath, "-e", "process.stdout.write('ok')", "{prompt}"],
    envAllowlist: [], mode: "sandboxed", timeoutMs: 3000, isolatedJobRoom: true }, pollIntervalMs: 200,
    liveRoomState: () => ({ agent: selected, generation: selected, ready: true, coreCommand: process.execPath }),
    defaultExecutorGeneration: () => selected,
    checkExecutionReady: async () => { checks++; if (!ready) throw new Error("Room offline"); } } });
  const { wallet, clock } = world;
  const seller = await wallet.createAgent("Serving writer");
  await setEarnWithApproval(wallet, seller.id, true);
  await setOfferWithApproval(wallet, seller.id, { name: "Writer", summary: "Write a line.", price: { usdCents: 20 } });
  const listing = await eventually(async () => {
    await wallet.tick();
    const offer = (await wallet.overview()).agents.find(a => a.id === seller.id)?.earn.offer;
    return offer?.status === "live" && offer.listing;
  });
  const runOnce = async () => {
    const initial = sent.length;
    const stop = wallet.startListingHeartbeats();
    try { await eventually(async () => sent.length > initial); }
    finally { stop(); }
    return sent.at(-1)!;
  };
  const initial = await runOnce();
  expect(initial.message.inquiries).toBe(false);
  wallet.setListingInquiries(seller.id, listing, true);
  clock.now += 1000;
  const enabled = await runOnce();
  expect(enabled.message).toMatchObject({ inquiries: true, roomChecked: clock.now, expires: clock.now + 120000, provider: seller.address });
  await verifyListingMessage(enabled, { listing, provider: seller.address, version: enabled.message.version }, clock.now);
  selected = "claude-code";
  await expect(wallet.postListingMessage(seller.id, enabled.message)).rejects.toThrow();
  expect(sent).toHaveLength(2);
  selected = "core";
  ready = false;
  const before = checks;
  const stop = wallet.startListingHeartbeats();
  try { await eventually(async () => checks > before); }
  finally { stop(); }
  expect(sent).toHaveLength(2);
}, 30000);
