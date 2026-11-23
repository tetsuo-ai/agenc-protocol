import { afterEach, expect, it, vi } from "vitest";
import { AGENT_METHODS } from "../src/client/protocol.js";
import { createHostedServices, sha256Hex } from "../src/services.js";
import { eventually, setEarnWithApproval, startWorld, type World } from "./harness.js";

import { reviewRpc } from "./review-rpc.js";

let world: World | undefined;
afterEach(async () => { vi.useRealTimers(); await world?.wallet.close(); });

it("delivers a signed hosted revision and its file, then shares both parties' decisions", async () => {
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
  world = await startWorld({
    ...reviewRpc(),
    services: ({ taskThreadTransport: _thread, ...base }) => ({
      ...base, postChangeRequest: hosted.postChangeRequest!.bind(hosted), resultUploader: hosted.resultUploader,
      fetchFile: hosted.fetchFile, fetchResult: hosted.fetchResult, fileLinkPrefix: hosted.fileLinkPrefix,
    }),
    earn: { executor: { argv: [process.execPath, "-e",
      "const fs=require('node:fs'); process.stdout.write(fs.existsSync('inputs/brief.txt') ? fs.readFileSync('inputs/brief.txt') : 'First delivery')", "{prompt}"],
      mode: "sandboxed", reserveRevisionBudget: true, envAllowlist: [], timeoutMs: 10000 }, pollIntervalMs: 100 },
  });
  const { wallet } = world;
  const buyer = await wallet.createAgent("Buyer");
  const seller = await wallet.createAgent("Seller");
  await wallet.setPolicy(buyer.id, { askAboveCents: 1000, refill: { enabled: false, topUpToCents: 0, perDayCents: 0 } });
  await wallet.fundAgent(buyer.id, { usdCents: 500 });
  await setEarnWithApproval(wallet, seller.id, true, 10);
  const { job } = await wallet.post({ agentId: buyer.id, request: "Use the supplied text.", reward: { usdCents: 50 } });
  const delivery = await eventually(async () => {
    const current = await wallet.getJob(job.id, true);
    return current.result?.text === "First delivery" && current;
  });
  const sellerJob = (await wallet.listJobs({ role: "working", agentId: seller.id }, true))[0]!;
  expect(sellerJob.task).toBe(delivery.task);
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
  await expect(wallet.confirmReview(job.id, request, true)).rejects.toMatchObject({ code: "NOT_ALLOWED" });
  const reject = await wallet.draftReview(job.id, "reject", "The acceptance check needs a heading.", [], buyer.id);
  expect((await wallet.reviewRecord(job.id)).quote?.fee.lamports).toBe("5000");
  expect((await wallet.reviewRecord(job.id)).draft?.note).toBe(reject.note);
  await wallet.confirmReview(job.id, reject, true);
  await wallet.tick();
  const held = await wallet.reviewRecord(sellerJob.id);
  expect(held.entries.at(-1)).toMatchObject({ fee: { lamports: "5000" }, rent: expect.objectContaining({ lamports: expect.any(String) }), action: "reject", note: reject.note, deadline: expect.any(Number) });
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
}, 60000);
