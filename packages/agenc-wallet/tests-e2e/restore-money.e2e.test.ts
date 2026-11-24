// What a restored backup may and may not undo: the allowance ledger and quotes
// come back as the backup knew them, while the chain kept moving.
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { restoreBackup } from "../src/backup.js";
import type { Chain } from "../src/chain.js";
import type { AgencWallet } from "../src/wallet.js";
import { generateKeyPairSigner } from "@solana/kit";
import { listingMessageText, type ListingAgreement, type ListingQuestion, type SignedListing } from "../src/client/listing-exchange.js";
import { readListing } from "../src/market.js";
import { RESTORED_ALLOWANCE_TEXT } from "../src/job-money.js";
import { openParentFixture } from "./child-hire-fixture.js";
import { HAIKU, SOL, startWorld, type World } from "./harness.js";

let world: World | null = null;
let restored: AgencWallet | null = null;
afterEach(async () => {
  await restored?.close().catch(() => {});
  await world?.wallet.close().catch(() => {});
  restored = null;
  world = null;
});
const asLocalnet = (chain: Chain): Chain =>
  Object.create(chain, { network: { value: "localnet", enumerable: true } }) as Chain;

it("does not hand an agent a fresh daily allowance when an earlier backup is restored", async () => {
  world = await startWorld({ chain: asLocalnet });
  const { wallet, listing } = world;
  const agent = await wallet.createAgent("Buyer");
  // Plenty of SOL on the agent; the only limit is the day's allowance.
  await wallet.fundAgent(agent.id, { lamports: String(2_000_000_000n) });
  await wallet.setPolicy(agent.id, { askAboveCents: 200, refill: { enabled: true, topUpToCents: 0, perDayCents: 500 } });

  const saved = path.join(mkdtempSync(path.join(tmpdir(), "agenc-restore-backup-")), "backup.agencbackup");
  await wallet.exportBackup("a long enough password", saved);

  // Spend on its own until the wallet stops it.
  const alone = async (w: AgencWallet, n: number) => {
    try {
      const r = await w.hire({ agentId: agent.id, listing, request: "A haiku, number " + n + "." });
      return r.approval === null && r.job.status !== "needs_approval";
    } catch {
      return false;
    }
  };
  let spentAlone = 0;
  while (spentAlone < 20 && (await alone(wallet, spentAlone))) spentAlone += 1;
  expect(spentAlone).toBeGreaterThan(0);
  expect(spentAlone).toBeLessThan(20);
  // The allowance is used up: one more is not autonomous.
  expect(await alone(wallet, 100)).toBe(false);
  const balanceBefore = await world.balance(agent.address);
  await wallet.close();

  const elsewhere = mkdtempSync(path.join(tmpdir(), "agenc-restore-"));
  const secret = randomBytes(32);
  // The same minute, the same day.
  await restoreBackup({ dataDir: elsewhere, unlockSecret: secret, text: readFileSync(saved, "utf8"),
    password: "a long enough password", network: "localnet", now: world.clock.now });
  restored = await world.reopen({ dataDir: elsewhere, unlockSecret: secret });
  expect(await world.balance(agent.address)).toBe(balanceBefore);
  // Sound: the restored wallet still refuses to let the agent spend alone today.
  const again = await alone(restored, 200);
  expect(again, "the agent spent again on its own after the restore, above the day's allowance").toBe(false);
  expect(await world.balance(agent.address)).toBe(balanceBefore);

  // The person is told why, on the agent and in the activity list.
  const view = (await restored.overview()).agents.find(a => a.id === agent.id)!;
  expect(view.allowanceUnknownUntil).toBe(world.clock.now + 86_400_000);
  expect(view.allowanceUnknownText).toBe(RESTORED_ALLOWANCE_TEXT);
  expect((await restored.listActivity()).map(entry => entry.text)).toContainEqual(expect.stringMatching(/Restored from a backup.*24 hours.*approval/));
  // An agent cannot pay a delivery on its own either, and reads the same reason.
  const pendingJob = (await restored.listJobs({}, true)).find(job => job.agentId === agent.id);
  if (pendingJob) await expect(restored.approveJob(pendingJob.id, undefined, false, agent.id, "any")).rejects.toThrow(RESTORED_ALLOWANCE_TEXT);

  // The owner is not locked out: a yes still buys, and counts in the ledger.
  const asked = await restored.hire({ agentId: agent.id, listing, request: "A haiku the owner approves." });
  expect(asked.approval).not.toBeNull();
  expect((await restored.decideApproval(asked.approval!.id, true)).status).toMatch(/^(waiting|working)$/);
  expect(await world.balance(agent.address)).toBeLessThan(balanceBefore);

  // One minute before the day is over the agent still asks. After it, the allowance is its own again.
  world.clock.now += 86_400_000 - 60_000;
  expect(await alone(restored, 300)).toBe(false);
  world.clock.now += 60_000;
  expect((await restored.overview()).agents.find(a => a.id === agent.id)!.allowanceUnknownUntil).toBeUndefined();
  expect(await alone(restored, 301)).toBe(true);
}, 120_000);

it("does not top an agent up again after a restore, until the owner's day is over", async () => {
  world = await startWorld({ chain: asLocalnet });
  const { wallet } = world;
  const agent = await wallet.createAgent("Buyer");
  // One top-up uses the whole day's allowance.
  await wallet.setPolicy(agent.id, { askAboveCents: 0, refill: { enabled: true, topUpToCents: 500, perDayCents: 500 } });
  const saved = path.join(mkdtempSync(path.join(tmpdir(), "agenc-restore-backup-")), "backup.agencbackup");
  await wallet.exportBackup("a long enough password", saved);
  await wallet.tick();
  const topped = await world.balance(agent.address);
  expect(topped).toBeGreaterThan(0n);
  // The agent's money goes back to the main balance, so its balance is under the target again.
  const back = await wallet.quoteTransfer({ kind: "reclaim", agentId: agent.id, amount: "all" });
  await wallet.confirmTransfer(back.id);
  const emptied = await world.balance(agent.address);
  expect(emptied).toBeLessThan(topped / 2n);
  // Control: the wallet that knows the day's top-up does not send another.
  await wallet.tick();
  expect(await world.balance(agent.address)).toBe(emptied);
  await wallet.close();

  restored = await restoreElsewhere(world, saved);
  const main = await world.balance(wallet.mainAddress);
  await restored.tick();
  expect(await world.balance(agent.address)).toBe(emptied);
  expect(await world.balance(wallet.mainAddress)).toBe(main);
  // A day after the restore the automatic top-up works again.
  world.clock.now += 86_400_000;
  await restored.tick();
  expect(await world.balance(agent.address)).toBeGreaterThan(emptied);
}, 120_000);

it("asks the owner for seller funding after a restore, even inside the daily allowance", async () => {
  const earn = { executor: { argv: [process.execPath, "-e", "process.stdout.write('ok')", "{prompt}"],
    mode: "sandboxed" as const, envAllowlist: [], timeoutMs: 10000 }, pollIntervalMs: 50 };
  world = await startWorld({ chain: asLocalnet, earn });
  const { wallet } = world;
  const seller = await wallet.createAgent("Seller");
  await wallet.setPolicy(seller.id, { askAboveCents: 0, refill: { enabled: true, topUpToCents: 0, perDayCents: 100_000 } });
  const input = { setupId: "restore-funding", enableEarns: true as const, name: "Receipt", summary: "Write a line.", price: { lamports: "3000000" } };
  const saved = path.join(mkdtempSync(path.join(tmpdir(), "agenc-restore-backup-")), "backup.agencbackup");
  await wallet.exportBackup("a long enough password", saved);
  const known = await wallet.quoteEarn(seller.id, input);
  expect(BigInt(known.fromMain.lamports)).toBeGreaterThan(0n);
  expect(known.requiresApproval).toBe(false);
  await wallet.close();

  restored = await restoreElsewhere(world, saved);
  const quote = await restored.quoteEarn(seller.id, { ...input, setupId: "restore-funding-2" });
  expect(quote.fromMain.lamports).toBe(known.fromMain.lamports);
  expect(quote.requiresApproval).toBe(true);
  world.clock.now += 86_400_000;
  expect((await restored.quoteEarn(seller.id, { ...input, setupId: "restore-funding-3" })).requiresApproval).toBe(false);
}, 120_000);

it("refuses a new or waiting supplier purchase on a restored device until the owner confirms it", async () => {
  const fixture = await openParentFixture({ world: { chain: asLocalnet } });
  world = fixture.world;
  const { wallet } = world;
  const { grant, request, seller } = fixture;
  // Every supplier purchase is a quote the owner decides. This one waits at backup time.
  const waiting = await wallet.childHires.request(grant, request);
  expect(waiting.phase).toBe("approval");
  const saved = path.join(mkdtempSync(path.join(tmpdir(), "agenc-restore-backup-")), "backup.agencbackup");
  await wallet.exportBackup("a long enough password", saved);
  await wallet.close();
  restored = world.wallet = await restoreElsewhere(world, saved);
  expect(await restored.businessStatus()).toMatchObject({ requiresConsent: true });
  const before = await world.balance(seller.address);
  const consent = /grant this device permission first/;
  await expect(restored.childHires.decide(grant.parentTask, waiting.quote.id, true)).rejects.toThrow(consent);
  await expect(restored.childHires.request(grant, request, undefined, waiting.quote.id)).rejects.toThrow(consent);
  expect(await world.balance(seller.address)).toBe(before);
  // Saying no stays possible, and moves nothing.
  expect((await restored.childHires.decide(grant.parentTask, waiting.quote.id, false)).phase).toBe("declined");
  expect(await world.balance(seller.address)).toBe(before);
}, 120_000);

it("refuses a new supplier request on a restored device until the owner confirms it", async () => {
  const fixture = await openParentFixture({ world: { chain: asLocalnet } });
  world = fixture.world;
  const { grant, request, seller } = fixture;
  const saved = path.join(mkdtempSync(path.join(tmpdir(), "agenc-restore-backup-")), "backup.agencbackup");
  await world.wallet.exportBackup("a long enough password", saved);
  await world.wallet.close();
  restored = world.wallet = await restoreElsewhere(world, saved);
  const before = await world.balance(seller.address);
  await expect(restored.childHires.request(grant, request)).rejects.toThrow(/grant this device permission first/);
  expect(await world.balance(seller.address)).toBe(before);
}, 120_000);

it.each(["withdraw", "fund"] as const)("cannot confirm a %s quote again after a restore once it has moved the money", async (kind) => {
  world = await startWorld({ chain: asLocalnet });
  const { wallet } = world;
  const agent = await wallet.createAgent("Buyer");
  const target = kind === "fund" ? agent.address : (await generateKeyPairSigner()).address;
  const quote = await wallet.quoteTransfer(kind === "fund" ? { kind, agentId: agent.id, amount: { lamports: String(SOL) } }
    : { kind, to: target, amount: { lamports: String(SOL) } });
  const saved = path.join(mkdtempSync(path.join(tmpdir(), "agenc-restore-backup-")), "backup.agencbackup");
  await wallet.exportBackup("a long enough password", saved);
  await wallet.confirmTransfer(quote.id);
  expect(await world.balance(target)).toBe(SOL);
  const main = await world.balance(wallet.mainAddress);
  await wallet.close();
  restored = await restoreElsewhere(world, saved);
  // The quote binds the balances it showed, and the first transfer changed them.
  await expect(restored.confirmTransfer(quote.id)).rejects.toThrow(/figures changed or expired/);
  expect(await world.balance(target)).toBe(SOL);
  expect(await world.balance(wallet.mainAddress)).toBe(main);
}, 120_000);

async function restoreElsewhere(w: World, saved: string) {
  const elsewhere = mkdtempSync(path.join(tmpdir(), "agenc-restore-"));
  const secret = randomBytes(32);
  await restoreBackup({ dataDir: elsewhere, unlockSecret: secret, text: readFileSync(saved, "utf8"),
    password: "a long enough password", network: "localnet", now: w.clock.now });
  return w.reopen({ dataDir: elsewhere, unlockSecret: secret });
}

it("does not pay a purchase twice when its approval is given again after a restore", async () => {
  world = await startWorld({ chain: asLocalnet });
  const { wallet, listing } = world;
  const agent = await wallet.createAgent("Buyer");
  await wallet.fundAgent(agent.id, { lamports: String(2_000_000_000n) });
  // An earlier purchase, so the one-time record costs are already paid and the later quote stays exact.
  await wallet.setPolicy(agent.id, { askAboveCents: 200, refill: { enabled: true, topUpToCents: 0, perDayCents: 2000 } });
  const first = await wallet.hire({ agentId: agent.id, listing, request: "An earlier haiku." });
  expect(first.approval).toBeNull();
  await wallet.setPolicy(agent.id, { askAboveCents: 0, refill: { enabled: true, topUpToCents: 0, perDayCents: 2000 } });
  const asked = await wallet.hire({ agentId: agent.id, listing, request: "A haiku about restores." });
  expect(asked.approval).not.toBeNull();
  const saved = path.join(mkdtempSync(path.join(tmpdir(), "agenc-restore-backup-")), "backup.agencbackup");
  await wallet.exportBackup("a long enough password", saved);
  const before = await world.balance(agent.address);
  const hired = await wallet.decideApproval(asked.approval!.id, true);
  expect(hired.task).toBeTruthy();
  const afterFirst = await world.balance(agent.address);
  expect(afterFirst).toBeLessThan(before);
  await wallet.close();

  restored = await restoreElsewhere(world, saved);
  // The backup still holds the quote as waiting. The owner says yes again.
  const second = await restored.decideApproval(asked.approval!.id, true).catch((error: unknown) => error);
  await restored.tick();
  const afterSecond = await world.balance(agent.address);
  const fee = world.sandbox.chain.transferFeeLamports;
  // One escrow only: at most a failed transaction's fee may have been lost.
  expect(afterFirst - afterSecond).toBeLessThanOrEqual(2n * fee);
  const view = await restored.getJob(asked.job.id, true).catch(() => null);
  // The restored wallet must know the one funded order, not call it failed with "nothing was spent".
  expect({ second: second instanceof Error ? second.message : (second as { status: string }).status, status: view?.status, task: view?.task })
    .toMatchObject({ task: hired.task });
  expect(view?.status).not.toBe("failed");
}, 120_000);

it("cannot use a seller setup quote from before the backup again after a restore", async () => {
  const earn = { executor: { argv: [process.execPath, "-e", "process.stdout.write('ok')", "{prompt}"],
    mode: "sandboxed" as const, envAllowlist: [], timeoutMs: 10000 }, pollIntervalMs: 50 };
  world = await startWorld({ chain: asLocalnet, earn });
  const { wallet } = world;
  const seller = await wallet.createAgent("Seller");
  const input = { setupId: "restore-setup", enableEarns: true as const, name: "Receipt", summary: "Write a line.", price: { lamports: "3000000" } };
  const quote = await wallet.quoteEarn(seller.id, input);
  expect(BigInt(quote.fromMain.lamports)).toBeGreaterThan(0n);
  const saved = path.join(mkdtempSync(path.join(tmpdir(), "agenc-restore-backup-")), "backup.agencbackup");
  await wallet.exportBackup("a long enough password", saved);
  const main0 = await world.balance(wallet.mainAddress);
  await wallet.setOffer(seller.id, input, undefined, quote.quoteId);
  const main1 = await world.balance(wallet.mainAddress);
  expect(main0 - main1).toBe(BigInt(quote.totalFromMain.lamports));
  await wallet.close();

  restored = await restoreElsewhere(world, saved);
  const status = await restored.businessStatus();
  if (status?.requiresConsent) await restored.confirmRestoredDevice(status.restoredAt).catch(() => {});
  await restored.setOffer(seller.id, input, undefined, quote.quoteId).catch(() => {});
  await restored.approveEarnFunding(quote.quoteId).catch(() => {});
  await restored.tick();
  expect(await world.balance(wallet.mainAddress)).toBe(main1);
}, 120_000);

it("knows an escrow it already funded when the restored quote can no longer be approved", async () => {
  world = await startWorld({ chain: asLocalnet });
  const { wallet, listing } = world;
  const agent = await wallet.createAgent("Buyer");
  await wallet.fundAgent(agent.id, { lamports: String(2_000_000_000n) });
  await wallet.setPolicy(agent.id, { askAboveCents: 0, refill: { enabled: true, topUpToCents: 0, perDayCents: 2000 } });
  // The agent's first purchase: its one-time record cost is in this quote and gone once it lands.
  const asked = await wallet.hire({ agentId: agent.id, listing, request: "A first haiku." });
  const saved = path.join(mkdtempSync(path.join(tmpdir(), "agenc-restore-backup-")), "backup.agencbackup");
  await wallet.exportBackup("a long enough password", saved);
  const hired = await wallet.decideApproval(asked.approval!.id, true);
  expect(hired.task).toBeTruthy();
  const funded = await world.balance(agent.address);
  await wallet.close();

  restored = await restoreElsewhere(world, saved);
  const second = await restored.decideApproval(asked.approval!.id, true).catch((error: unknown) => error);
  await restored.tick();
  const view = await restored.getJob(asked.job.id, true);
  // The wallet holds this job's task ID, and the chain holds its funded escrow.
  expect({ refusal: second instanceof Error ? second.message : null, status: view.status, task: view.task })
    .toEqual({ refusal: null, status: "waiting", task: hired.task });
  expect((await restored.listApprovals()).map(approval => approval.id)).not.toContain(asked.approval!.id);
  // Nothing was funded a second time.
  expect(funded - await world.balance(agent.address)).toBeLessThanOrEqual(2n * world.sandbox.chain.transferFeeLamports);
}, 120_000);

/** An agent's first purchase, quoted before the backup and approved after it: its one-time record cost is gone when the backup returns. */
async function fundedAfterBackup() {
  world = await startWorld({ chain: asLocalnet });
  const { wallet, listing } = world;
  const agent = await wallet.createAgent("Buyer");
  await wallet.fundAgent(agent.id, { lamports: String(2_000_000_000n) });
  await wallet.setPolicy(agent.id, { askAboveCents: 0, refill: { enabled: true, topUpToCents: 0, perDayCents: 2000 } });
  const asked = await wallet.hire({ agentId: agent.id, listing, request: "A first haiku." });
  const saved = path.join(mkdtempSync(path.join(tmpdir(), "agenc-restore-backup-")), "backup.agencbackup");
  await wallet.exportBackup("a long enough password", saved);
  const hired = await wallet.decideApproval(asked.approval!.id, true);
  expect(hired.task).toBeTruthy();
  const funded = await world.balance(agent.address);
  await wallet.close();
  restored = await restoreElsewhere(world, saved);
  return { agent, asked, hired, funded, restored };
}

it("does not decline an escrow that was funded after the backup", async () => {
  const { agent, asked, hired, funded, restored: wallet } = await fundedAfterBackup();
  const view = await wallet.decideApproval(asked.approval!.id, false);
  expect({ status: view.status, task: view.task }).toEqual({ status: "waiting", task: hired.task });
  expect(funded - await world!.balance(agent.address)).toBeLessThanOrEqual(2n * world!.sandbox.chain.transferFeeLamports);
}, 120_000);

it("finds the funded escrow on its own, before the restored quote can lapse as unspent", async () => {
  const { agent, asked, hired, funded, restored: wallet } = await fundedAfterBackup();
  world!.clock.now = asked.approval!.expiresAt + 1;
  await wallet.tick();
  const view = await wallet.getJob(asked.job.id, true);
  expect({ status: view.status, task: view.task, error: view.error ?? null }).toEqual({ status: "waiting", task: hired.task, error: null });
  expect(funded - await world!.balance(agent.address)).toBeLessThanOrEqual(2n * world!.sandbox.chain.transferFeeLamports);
}, 120_000);

it("keeps a restored quote that was never funded an ordinary quote: it can be approved once or declined", async () => {
  world = await startWorld({ chain: asLocalnet });
  const { wallet, listing } = world;
  const agent = await wallet.createAgent("Buyer");
  await wallet.fundAgent(agent.id, { lamports: String(2_000_000_000n) });
  await wallet.setPolicy(agent.id, { askAboveCents: 0, refill: { enabled: true, topUpToCents: 0, perDayCents: 2000 } });
  const first = await wallet.hire({ agentId: agent.id, listing, request: "A first haiku." });
  const second = await wallet.hire({ agentId: agent.id, listing, request: "A second haiku." });
  const saved = path.join(mkdtempSync(path.join(tmpdir(), "agenc-restore-backup-")), "backup.agencbackup");
  await wallet.exportBackup("a long enough password", saved);
  await wallet.close();
  restored = await restoreElsewhere(world, saved);
  const before = await world.balance(agent.address);
  expect((await restored.decideApproval(second.approval!.id, false)).status).toBe("declined");
  expect(await world.balance(agent.address)).toBe(before);
  const hired = await restored.decideApproval(first.approval!.id, true);
  expect(hired.status).toBe("waiting");
  const spent = before - await world.balance(agent.address);
  expect(spent).toBeGreaterThanOrEqual(BigInt(first.approval!.price.lamports));
  expect(spent).toBeLessThanOrEqual(BigInt(first.approval!.total!.lamports));
  // A second yes is the same order.
  expect((await restored.decideApproval(first.approval!.id, true)).task).toBe(hired.task);
  expect(before - await world.balance(agent.address)).toBe(spent);
}, 120_000);

// A quote the owner asks for in Market lives in memory until it is answered, so no backup holds it.
// A request that waits in a backup is one an agent asked to post.
it("knows a request that was posted with the owner's yes after the backup", async () => {
  world = await startWorld({ chain: asLocalnet });
  const { wallet } = world;
  const saved = path.join(mkdtempSync(path.join(tmpdir(), "agenc-restore-backup-")), "backup.agencbackup");
  const agent = await wallet.createAgent("Poster");
  await wallet.fundAgent(agent.id, { lamports: String(2_000_000_000n) });
  await wallet.setPolicy(agent.id, { askAboveCents: 0, refill: { enabled: true, topUpToCents: 0, perDayCents: 2000 } });
  const post = await wallet.post({ agentId: agent.id, request: "Write one poem about the sea.", reward: { lamports: "3000000" } });
  expect(post.approval).not.toBeNull();
  await wallet.exportBackup("a long enough password", saved);
  const posted = await wallet.decideApproval(post.approval!.id, true);
  expect(posted.task).toBeTruthy();
  const funded = await world.balance(agent.address);
  const main = await world.balance(wallet.mainAddress);
  await wallet.close();

  restored = await restoreElsewhere(world, saved);
  const again = await restored.decideApproval(post.approval!.id, true).catch((error: unknown) => error);
  await restored.tick();
  const view = await restored.getJob(post.job.id, true);
  expect({ refusal: again instanceof Error ? again.message : null, status: view.status, task: view.task })
    .toEqual({ refusal: null, status: "waiting", task: posted.task });
  expect(funded - await world.balance(agent.address)).toBeLessThanOrEqual(2n * world.sandbox.chain.transferFeeLamports);
  expect(await world.balance(wallet.mainAddress)).toBe(main);
}, 120_000);

it("knows an inquiry checkout that was funded after the backup, although its agreed terms have expired", async () => {
  world = await startWorld({ chain: asLocalnet, config: { listingRelay: vi.fn(async () => Response.json({ ok: true })) } });
  const { sandbox, wallet, clock } = world;
  const generated = vi.spyOn(sandbox.market, "fundedSigner");
  const listing = await sandbox.addService({ ...HAIKU, name: "Custom haiku" });
  const seller = await generated.mock.results[0]!.value;
  generated.mockRestore();
  const buyer = await wallet.createAgent("Poetry buyer");
  const current = (await readListing(sandbox.chain, listing))!;
  const identity = { listing, version: current.version.toString(), provider: seller.address };
  const validity = { issued: clock.now, expires: clock.now + 60000 };
  const question = await wallet.postListingMessage(buyer.id, { ...identity, ...validity, kind: "question",
    buyer: buyer.address, question: "Can you deliver two variations?" }) as SignedListing<ListingQuestion>;
  const message = { ...identity, ...validity, kind: "reply" as const, buyer: buyer.address,
    questionSignature: question.signature, reply: "Here are options.", terms: ["Two variations", "Additional revision"] };
  const [signed] = await seller.signMessages([{ content: new TextEncoder().encode(listingMessageText(message)), signatures: {} }]);
  const agreement: ListingAgreement = { question, reply: { message, signature: Buffer.from(signed![seller.address]!).toString("base64") }, selected: [0] };
  const quoted = await wallet.hire({ agentId: buyer.id, listing, request: "Write about a pond.", listingAgreement: agreement });
  expect(quoted.approval?.terms?.inquiry?.payingCreator).toBe(wallet.mainAddress);
  const saved = path.join(mkdtempSync(path.join(tmpdir(), "agenc-restore-backup-")), "backup.agencbackup");
  await wallet.exportBackup("a long enough password", saved);
  const paid = await wallet.decideApproval(quoted.approval!.id, true);
  expect(paid.status).toBe("waiting");
  const main = await world.balance(wallet.mainAddress);
  await wallet.close();

  restored = await restoreElsewhere(world, saved);
  // The signed reply is no longer valid, so the restored quote could not be approved as a new order.
  clock.now = validity.expires + 1;
  const again = await restored.decideApproval(quoted.approval!.id, true).catch((error: unknown) => error);
  const view = await restored.getJob(quoted.job.id, true);
  expect({ refusal: again instanceof Error ? again.message : null, status: view.status, task: view.task })
    .toEqual({ refusal: null, status: "waiting", task: paid.task });
  expect(main - await world.balance(wallet.mainAddress)).toBeLessThanOrEqual(2n * sandbox.chain.transferFeeLamports);
}, 120_000);
