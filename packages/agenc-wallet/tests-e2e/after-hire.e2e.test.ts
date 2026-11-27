import { chmodSync, cpSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { address } from "@solana/kit";
import type { WalletState } from "../src/store.js";
import { afterEach, expect, it, vi } from "vitest";
import { runMarketTool } from "../src/client/tools.js";
import type { WalletClient } from "../src/client/socket-client.js";
import { AGENT_METHODS } from "../src/client/protocol.js";
import { createHostedServices, sha256Hex } from "../src/services.js";
import { eventually, setEarnWithApproval, startWorld, type World } from "./harness.js";

import { reviewRpc } from "./review-rpc.js";

let world: World | undefined;
afterEach(async () => { vi.useRealTimers(); await world?.wallet.close(); });

it.each(["reject", "approve", "change"] as const)("refuses a signed %s for a superseded delivery and confirms the fresh round for both parties", async action => {
  const objects = new Map<string, Uint8Array>();
  let serve = true;
  const hosted = createHostedServices({
    artifactBaseUrl: "https://read.invalid", artifactUploadUrl: "https://write.invalid/api/artifacts",
    fetchImpl: async (url, init) => {
      expect(url).toBe("https://write.invalid/api/artifacts");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("x-agenc-signature")).toBeTruthy();
      const bytes = new Uint8Array(init!.body as Uint8Array);
      const hash = sha256Hex(bytes);
      objects.set(hash, bytes);
      return Response.json({ sha256: hash });
    },
    publicFetcher: async uri => {
      expect(uri).toMatch(/^https:\/\/read\.invalid\/artifacts\/[a-f0-9]{64}$/);
      const bytes = objects.get(uri.split("/").pop()!);
      if (!bytes || !serve) throw new Error("offline");
      return bytes;
    },
  });
  const history = reviewRpc();
  let intercept = false;
  let captured!: () => void;
  let release!: () => void;
  const capturedSend = new Promise<void>(resolve => { captured = resolve; });
  const waitForNewDelivery = new Promise<void>(resolve => { release = resolve; });
  world = await startWorld({
    chain: history.chain,
    transport: base => {
      const indexed = history.transport(base);
      return { ...indexed, async sendAndConfirm(signed) {
        if (intercept) {
          intercept = false;
          captured();
          await waitForNewDelivery;
          return indexed.sendAndConfirm(signed);
        }
        return indexed.sendAndConfirm(signed);
      } };
    },
    services: ({ taskThreadTransport: _thread, ...base }) => ({
      ...base, postChangeRequest: hosted.postChangeRequest!.bind(hosted), resultUploader: hosted.resultUploader,
      fetchFile: hosted.fetchFile, fetchResult: hosted.fetchResult, fileLinkPrefix: hosted.fileLinkPrefix,
    }),
    earn: { runReviewRoom: async ({ reviewInputs }) => {
      expect(reviewInputs?.map(f => f.name)).toEqual(["brief.txt"]);
      return { stdout: Buffer.from(reviewInputs![0]!.bytes), exitCode: 0 };
    }, executor: { argv: [process.execPath, "-e",
      "process.stdout.write('First delivery')", "{prompt}"],
      mode: "sandboxed", jobRoom: true, isolatedJobRoom: true, reserveRevisionBudget: true, envAllowlist: [], timeoutMs: 10000 }, pollIntervalMs: 100 },
  });
  const { wallet } = world;
  const buyer = await wallet.createAgent("Buyer");
  const seller = await wallet.createAgent("Seller");
  await wallet.setPolicy(buyer.id, { askAboveCents: 1000, refill: { enabled: true, topUpToCents: 1, perDayCents: 1000 } });
  await wallet.setPolicy(seller.id, { askAboveCents: 1000, refill: { enabled: true, topUpToCents: 1, perDayCents: 3000 } });
  await wallet.fundAgent(buyer.id, { usdCents: 500 });
  await setEarnWithApproval(wallet, seller.id, true, 10);
  const { job } = await wallet.post({ agentId: buyer.id, request: "Use the supplied text.", reward: { usdCents: 50 } });
  const delivery = await eventually(async () => {
    const current = await wallet.getJob(job.id, true);
    return current.result?.text === "First delivery" && current;
  });
  const sellerJob = (await wallet.listJobs({ role: "working", agentId: seller.id }, true))[0]!;
  expect(sellerJob.task).toBe(delivery.task);
  // A second owner session holds a signed decision for the first submission.
  const peerDir = mkdtempSync(join(tmpdir(), "review-peer-"));
  cpSync(world.dataDir, peerDir, { recursive: true });
  chmodSync(join(peerDir, "earn", seller.id), 0o700);
  const lateDir = mkdtempSync(join(tmpdir(), "review-late-"));
  cpSync(peerDir, lateDir, { recursive: true });
  chmodSync(join(lateDir, "earn", seller.id), 0o700);
  const peer = await world.reopen({ dataDir: peerDir });
  const firstQuote = (await peer.reviewRecord(job.id)).quote!;
  const noteForFirst = "First delivery has no heading.";
  const staleDraft = action === "approve" ? null : await peer.draftReview(job.id, action, noteForFirst);
  intercept = true;
  const delayed = (staleDraft ? peer.confirmReview(job.id, staleDraft, true) : peer.approveJob(job.id, undefined, true, undefined, firstQuote.id)).then(() => null, err => err);
  await capturedSend;
  const note = "Use the attached brief.";
  const draft = await wallet.draftReview(job.id, "change", note, [], buyer.id);
  await expect(wallet.draftReview(job.id, "reject", "x", [], seller.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(wallet.draftReview(sellerJob.id, "reject", "x", [], buyer.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(wallet.confirmReview(job.id, draft, false)).rejects.toMatchObject({ code: "NOT_ALLOWED" });
  expect(AGENT_METHODS).not.toContain("jobs.confirmReview");
  const contents = Buffer.from("Second delivery.").toString("base64");
  const request = { ...draft, files: [{ name: "brief.txt", base64: contents }] };
  await expect(wallet.confirmReview(job.id, { ...request, files: [{ name: "../outside.txt", base64: contents }] }, true)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  serve = false;
  await expect(wallet.confirmReview(job.id, request, true)).rejects.toMatchObject({ code: "NETWORK" });
  expect((await wallet.getJob(job.id, true)).status).toBe("delivered");
  const partial = (await wallet.reviewRecord(job.id)).publication!;
  expect(partial.confirmed).toBe(false);
  expect(partial.hashes).toContain(sha256Hex(Buffer.from(contents, "base64")));
  serve = true;
  expect((await wallet.confirmReview(job.id, request, true)).status).toBe("changes_requested");
  const revision = await wallet.reviewRecord(job.id, buyer.id);
  const originalNote = objects.get(revision.entries[0]!.hash)!;
  objects.set(revision.entries[0]!.hash, Buffer.from("altered"));
  expect((await wallet.reviewRecord(job.id)).entries[0]?.note).toBeNull();
  objects.set(revision.entries[0]!.hash, originalNote);
  const sellerCopy = await wallet.reviewRecord(sellerJob.id, seller.id);
  expect(revision.entries[0]).toMatchObject({ action: "change", note, attachments: [{ uri: expect.stringMatching(/#brief.txt$/) }] });
  expect(sellerCopy.entries).toEqual(revision.entries);
  expect(revision.entries[0]!.appliedDelivery).toEqual({ deliveryHash: delivery.result!.hash, submissionCount: 1 });
  expect(revision.entries[0]!.intendedDelivery).toEqual(revision.entries[0]!.appliedDelivery);
  expect(revision.entries[0]!.deliveryNotice).toBeUndefined();
  expect(sellerCopy.resubmitBy).toEqual(revision.resubmitBy);
  expect(revision.resubmitBy).toBeGreaterThan(0);
  expect((await wallet.jobFile(sellerJob.id, revision.entries[0]!.attachments[0]!.hash)).base64).toBe(contents);

  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 130_000);
  const target = performance.now() + 12000;
  while ((await wallet.getJob(job.id, true)).result?.text !== "Second delivery.") {
    if (performance.now() > target) throw new Error("The revised delivery was not received.");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  vi.useRealTimers();
  const second = await wallet.getJob(job.id, true);
  await expect(wallet.confirmReview(job.id, request, true)).rejects.toMatchObject({ code: "NOT_ALLOWED" });
  expect((await wallet.reviewRecord(job.id)).quote?.fee.lamports).toBe("5000");
  const originalBalance = await world.balance(seller.address);
  release();
  expect(await delayed).toMatchObject({ code: "NOT_ALLOWED", message: expect.stringContaining("delivery changed") });
  await peer.close();
  expect(await world.balance(seller.address)).toBe(originalBalance);
  expect((await wallet.getJob(job.id, true)).status).toBe("delivered");
  const freshQuote = (await wallet.reviewRecord(job.id)).quote!;
  expect(freshQuote.submissionCount).toBe(2);
  expect(freshQuote.deliveryHash).toBe(second.result!.hash);
  const reading = { call: async (method: string) => method === "jobs.get" ? { job: second } : { quote: freshQuote } } as unknown as WalletClient;
  expect((await runMarketTool(reading, buyer.id, "market_status", { job_id: job.id })).message).toContain("This decision applies only to delivery 2.");
  const priorEntries = (await wallet.reviewRecord(job.id)).entries;
  expect(priorEntries.map(entry => entry.action)).toEqual(["change"]);
  const freshNote = "Second delivery has no heading.";
  if (action === "approve") {
    await wallet.approveJob(job.id, undefined, true, undefined, freshQuote.id);
  } else {
    const draft = await wallet.draftReview(job.id, action, freshNote);
    await wallet.confirmReview(job.id, draft, true);
  }
  const reviewed = { submissionCount: 2, deliveryHash: second.result!.hash };
  history.pruneSubmissions();
  for (const [id, agentId] of [[job.id, buyer.id], [sellerJob.id, seller.id]] as const) {
    const record = await wallet.reviewRecord(id, agentId);
    expect(record.entries.at(-1)).toMatchObject({ action, intendedDelivery: reviewed, appliedDelivery: reviewed });
    expect(record.entries.at(-1)?.deliveryNotice).toBeUndefined();
    const scoped = { call: async (method: string) => method === "jobs.get" ? { job: await wallet.getJob(id, false, agentId) } : record } as unknown as WalletClient;
    const receipt = await runMarketTool(scoped, agentId, "market_review", { action: "record", job_id: id });
    expect(receipt.review_record?.entries.at(-1)?.appliedDelivery).toEqual(reviewed);
    expect(receipt.message).not.toContain("could not be verified");
  }
  history.pruneSubmissions(false);
  if (action !== "reject") return;
  const held = await wallet.reviewRecord(sellerJob.id);
  expect(held.entries.at(-1)).toMatchObject({ fee: freshQuote.fee, rent: freshQuote.rejectionRent, action, note: freshNote,
    intendedDelivery: reviewed, appliedDelivery: reviewed, deadline: expect.any(Number) });
  const scoped = { call: async (method: string) => method === "jobs.get" ? { job: await wallet.getJob(sellerJob.id, false, seller.id) } : held } as unknown as WalletClient;
  const status = await runMarketTool(scoped, seller.id, "market_status", { job_id: sellerJob.id });
  expect(status.job?.can).toEqual(["draft_dispute", "record"]);
  expect(held.quote).toMatchObject({ actions: ["dispute"], bond: { lamports: "10000000" } });
  expect(BigInt(held.quote!.disputeRent.lamports)).toBeGreaterThan(0n);
  const { bond, disputeRent, fee, disputeTotal } = held.quote!;
  expect(BigInt(disputeTotal.lamports)).toBe(BigInt(bond.lamports) + BigInt(disputeRent.lamports) + BigInt(fee.lamports));
  const dispute = await wallet.draftReview(sellerJob.id, "dispute", "The agreed brief contained no heading.", [], seller.id);
  await wallet.fundAgent(seller.id, { usdCents: 200 });
  await wallet.confirmReview(sellerJob.id, { ...dispute, files: [{ name: "receipt.txt", base64: contents }] }, true);
  const buyerRecord = await wallet.reviewRecord(job.id);
  expect(buyerRecord.entries[0]?.deadline).toBe(revision.resubmitBy);
  expect(buyerRecord.entries.at(-1)).toMatchObject({ action: "dispute", fee: held.quote!.fee, bond: held.quote!.bond, rent: held.quote!.disputeRent, note: dispute.note, deadline: expect.any(Number) });
  expect((await wallet.reviewRecord(sellerJob.id)).entries).toEqual(buyerRecord.entries);
  expect(await wallet.jobFile(job.id, buyerRecord.entries.at(-1)!.attachments[0]!.hash)).toMatchObject({ base64: contents });
  await expect(wallet.confirmReview(sellerJob.id, dispute, true)).rejects.toMatchObject({ code: "NOT_ALLOWED" });
  const state = JSON.parse(readFileSync(join(world.dataDir, "state.json"), "utf8")) as WalletState;
  const charges = (id: string) => state.agents[id]!.refills.filter(row => row.id?.startsWith("review:")).map(row => row.lamports);
  expect(charges(seller.id)).toEqual([disputeTotal.lamports]);
  expect(charges(buyer.id)).toEqual([firstQuote.fee.lamports, freshQuote.rejectionTotal.lamports]);
  const due = revision.resubmitBy!;
  await world.sandbox.ruleOnTurnedDown({ task: address(job.task!), payProvider: true });
  await wallet.tick();
  // The other device took its local snapshot before any change, rejection or dispute.
  history.useLegacyReceipts();
  const lateReader = await world.reopen({ dataDir: lateDir });
  try {
    for (const id of [job.id, sellerJob.id]) {
      const late = await lateReader.reviewRecord(id);
      expect(late.entries.map(e => [e.action, e.deadline])).toEqual([
        ["change", due], ["reject", expect.any(Number)], ["dispute", expect.any(Number)],
      ]);
      expect(late.entries.find(entry => entry.action === "reject")?.appliedDelivery).toEqual(reviewed);
      expect(late.entries.at(-1)).toMatchObject({ evidenceUri: expect.stringMatching(/^agenc:/), note: dispute.note });
    }
    history.pruneSubmissions();
    const unavailable = await lateReader.reviewRecord(sellerJob.id);
    const closedRejection = unavailable.entries.find(entry => entry.action === "reject");
    expect(closedRejection?.deliveryNotice).toBeUndefined();
    expect(closedRejection?.appliedDelivery).toEqual(reviewed);
    history.showGuards("legacy");
    const legacy = (await lateReader.reviewRecord(sellerJob.id)).entries.find(entry => entry.action === "reject");
    expect(legacy?.deliveryNotice).toContain("affected delivery could not be verified");
    expect(legacy?.appliedDelivery).toBeUndefined();
    history.showGuards("wrongTarget");
    const unbound = (await lateReader.reviewRecord(sellerJob.id)).entries.find(entry => entry.action === "reject");
    expect(unbound?.action).toBe("reject");
    expect(unbound?.appliedDelivery).toBeUndefined();
  } finally { await lateReader.close(); }
}, 60000);
