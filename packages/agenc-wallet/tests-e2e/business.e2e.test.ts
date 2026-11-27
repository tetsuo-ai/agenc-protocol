import type { Address } from "@solana/kit";
import { findClaimPda, getTaskClaimDecoder } from "@tetsuo-ai/marketplace-sdk";
import { mkdirSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  approvedPost,
  CENT,
  eventually,
  startWorld,
  type World,
} from "./harness.js";
import { businessHandlers } from "../src/business-handlers.js";
import { withFiles } from "../src/client/delivery-files.js";
import { restoreBackup } from "../src/backup.js";
import type { WalletState } from "../src/store.js";
import type { JobParties, PortableBusiness } from "../src/client/business.js";

const owner = { role: "owner" as const, agentId: null };
let world: World;
afterEach(async () => {
  await world?.wallet.close();
});
const digest = (body: Buffer) =>
  createHash("sha256").update(body).digest("hex");

it("reopens a manual funding quote, takes only the chosen task, inspects files, repairs once and submits the new hash", async () => {
  const body = Buffer.from("first draft file");
  const file = {
    name: "first.txt",
    sha256: digest(body),
    type: "text/plain",
    bytes: body.length,
  };
  const original = withFiles(
    "a".repeat(53000) + " final line",
    [file],
    "agenc://file/",
  );
  const program =
    "require('fs').writeFileSync(require('path').join(process.argv[1],process.argv[2]),process.argv[3]);process.stdout.write(" +
    JSON.stringify(original) +
    ")";
  const correct = vi.fn(async () => ({
    stdout: Buffer.from(
      withFiles("Corrected final line", [file], "agenc://file/"),
    ),
    stderr: Buffer.alloc(0),
    exitCode: 0 as const,
  }));
  const ready = vi.fn(async () => {});
  world = await startWorld({
    earn: {
      chosenRoomEnabled: () => true,
      checkExecutionReady: ready,
      pollIntervalMs: 70,
      executor: {
        argv: [
          process.execPath,
          "-e",
          program,
          "{outbox}",
          file.sha256,
          body.toString(),
          "{prompt}",
        ],
        mode: "sandboxed",
        jobRoom: true, isolatedJobRoom: true,
        timeoutMs: 3000,
        envAllowlist: [],
      },
      runReviewRoom: correct,
    },
  });
  const { id } = await world.wallet.createAgent("Chosen worker");
  await world.wallet.fundAgent(id, { usdCents: 2000 });
  await world.wallet.setPolicy(id, {
    askAboveCents: 500,
    refill: { enabled: true, topUpToCents: 1, perDayCents: 500 },
  });
  const post = () =>
    world.sandbox.postOpenJob({
      title: "Check the report",
      instructions: "Write the report.",
      rewardLamports: 50n * CENT,
      deadlineSeconds: 7200,
    });
  const posted = await approvedPost(world.wallet, {
    request: "Check the report",
    reward: { usdCents: 50 },
  });
  const task = posted.task!;
  await post();
  const quote = await world.wallet.quoteManualWork(id);
  await world.wallet.close();
  world.wallet = await world.reopen();
  const wallet = world.wallet;
  const api = businessHandlers(wallet);
  await expect(
    wallet.setEarn(id, true, undefined, quote.quoteId),
  ).rejects.toThrow(/selected worker/);
  await expect(wallet.startManualWork(id, "missing")).rejects.toThrow();
  expect((await wallet.overview()).agents[0]?.earn.enabled).toBe(false);
  const agent = await api["work.startManual"](
    { agentId: id, fundingQuoteId: quote.quoteId },
    owner,
  );
  expect(agent.earn).toMatchObject({ chooseOpenJobs: true, offers: [] });
  expect(ready).toHaveBeenCalled();
  await eventually(
    async () =>
      (await wallet.openWork(id).catch(() => null))?.jobs.length === 2,
  );
  await wallet.decideWork((await wallet.quoteWork(id, task, "claim")).id, true);
  const hash = await eventually(
    async () => (await wallet.openWork(id)).held?.resultHash,
  );
  const tracked = await wallet.getJob(posted.id, true);
  expect(tracked.parties?.creatorWallet).toBe(wallet.mainAddress);
  const [claim] = await findClaimPda({
    task: task as Address,
    bidder: tracked.parties!.workerRegistration as Address,
  });
  const account = await world.sandbox.chain.readAccountInfo(claim);
  const claimedAt =
    Number(getTaskClaimDecoder().decode(account!.data).claimedAt) * 1000;
  expect(tracked.parties?.claimedAt).toBe(claimedAt);
  const params = { agentId: id, task, hash, part: "text", offset: 0 };
  const chunk = await api["work.inspect"](params, owner);
  expect(chunk.files).toEqual([file]);
  expect(chunk.correctionCents).toBeGreaterThan(0);
  const tail = await api["work.inspect"](
    { ...params, offset: chunk.next! },
    owner,
  );
  expect(Buffer.from(tail.base64, "base64").toString()).toMatch(/ final line$/);
  expect(
    await api["work.inspect"]({ ...params, part: file.sha256 }, owner),
  ).toMatchObject({ base64: body.toString("base64") });
  await expect(
    api["work.correct"](
      { ...params, note: "Fix the final line." },
      { role: "agent", agentId: id },
    ),
  ).rejects.toThrow();
  const old = await wallet.quoteWork(id, task, "submit");
  const revised = await api["work.correct"](
    { ...params, note: "Fix the final line." },
    owner,
  );
  expect(correct).toHaveBeenCalledTimes(1);
  await expect(wallet.decideWork(old.id, true)).rejects.toThrow();
  await expect(api["work.inspect"](params, owner)).rejects.toThrow();
  await expect(
    wallet.correctWork(id, task, revised.hash, "Run again"),
  ).rejects.toThrow(/reserved/);
  const sellerJob = (await wallet.listJobs({ role: "working" }, true))[0]!;
  const parties = (sellerJob as typeof sellerJob & { parties: JobParties })
    .parties;
  expect(parties).toMatchObject({
    creatorWallet: old.job.buyer,
    workerWallet: agent.address,
    claimedAt,
  });
  expect(parties.workerRegistration).not.toBe(agent.address);
  const approval = await wallet.quoteWork(id, task, "submit");
  expect(approval.job.resultHash).toBe(revised.hash);
  await wallet.decideWork(approval.id, true);
  expect(world.sandbox.deliveries.has(revised.hash)).toBe(true);
  expect(world.sandbox.deliveries.has(hash)).toBe(false);
}, 60000);

it("rehydrates a buyer decision, its prior dismissal and the current deadline on reconnect", async () => {
  world = await startWorld();
  const { wallet, sandbox, listing } = world;
  const buyer = await wallet.createAgent("Buyer");
  await wallet.fundAgent(buyer.id, { usdCents: 500 });
  await wallet.setPolicy(buyer.id, {
    askAboveCents: 500,
    refill: { enabled: true, topUpToCents: 0, perDayCents: 500 },
  });
  const { job } = await wallet.hire({
    agentId: buyer.id,
    listing,
    request: "A poem",
  });
  await sandbox.workOnce();
  const seen = await wallet.getJob(job.id, true);
  expect((seen as typeof seen & { parties: JobParties }).parties).toMatchObject(
    { creatorWallet: buyer.address, workerRegistration: seen.provider },
  );
  const action = wallet
    .jobInbox(buyer.id)
    .actions.find((a) => a.jobId === job.id)!;
  expect(action.event).toBe("review");
  expect(wallet.jobInbox("other").actions).toEqual([]);
  expect(wallet.dismissJobAction(action.id, "other").dismissed).toBe(false);
  await wallet.close();
  world.clock.now = action.dueAt! - 1000;
  world.wallet = await world.reopen();
  expect(world.wallet.jobInbox(buyer.id).actions).toContainEqual({
    ...action,
    stage: "soon",
  });
  expect(world.wallet.dismissJobAction(action.id, buyer.id).dismissed).toBe(
    true,
  );
  await world.wallet.close();
  world.wallet = await world.reopen();
  expect(world.wallet.jobInbox().actions).toEqual([]);
}, 30000);

it("restores a verified draft and assets, reconciles a pending signature and waits for fresh device consent", async () => {
  let pending = true;
  const ready = vi.fn(async () => {});
  world = await startWorld({
    chain: (base) => ({
      ...base,
      network: "localnet",
      workOutcome: async () => (pending ? "pending" : "expired"),
    }),
    earn: {
      executor: {
        argv: [process.execPath, "-v", "{prompt}"],
        mode: "sandboxed",
        envAllowlist: [],
        timeoutMs: 1000,
      },
      chosenRoomEnabled: () => true,
      checkExecutionReady: ready,
    },
  });
  const buyer = await world.wallet.createAgent("Business", "external-project");
  await world.wallet.fundAgent(buyer.id, { usdCents: 500 });
  await world.wallet.setPolicy(buyer.id, {
    askAboveCents: 500,
    refill: { enabled: true, topUpToCents: 0, perDayCents: 500 },
  });
  const { job } = await world.wallet.hire({
    agentId: buyer.id,
    listing: world.listing,
    request: "An outstanding hire",
  });
  await world.wallet.close();
  const statePath = path.join(world.dataDir, "state.json");
  const state: WalletState = JSON.parse(readFileSync(statePath, "utf8"));
  state.agents[buyer.id]!.refills.push({
    ts: world.clock.now,
    id: "pending-work",
    signature: "pending",
    lamports: "5000",
    work: { lastValidBlockHeight: "20", fee: "5000", rate: 100 },
  });
  writeFileSync(statePath, JSON.stringify(state));
  world.wallet = await world.reopen();
  const code = Buffer.from("print('sample')");
  const bytes = Buffer.from(
    JSON.stringify({
      version: 1,
      entry: "entry.py",
      outputs: ["out.txt"],
      seconds: 20,
      tools: ["guest-python"],
      runtimeDigest: "a".repeat(64),
      permissionDigest: "b".repeat(64),
      capabilities: "1",
      files: [{ name: "entry.py", bytes: code.length, sha256: digest(code) }],
    }),
  );
  const portable: PortableBusiness = {
    version: 1,
    drafts: [
      {
        id: "draft_1",
        agentId: buyer.id,
        name: "A draft",
        description: "Saved work",
        priceCents: 8,
        createdAt: 1,
      },
    ],
    services: [
      {
        agentId: buyer.id,
        listingId: "listing",
        version: "v1",
        manifest: digest(bytes),
        assets: [
          { sha256: digest(bytes), base64: bytes.toString("base64") },
          { sha256: digest(code), base64: code.toString("base64") },
        ],
      },
    ],
  };
  const cache = path.join("earn", buyer.id, "service-bundles", digest(bytes));
  mkdirSync(path.join(world.dataDir, cache), { recursive: true });
  writeFileSync(
    path.join(world.dataDir, cache, "passed.json"),
    '{"passed":true}',
  );
  const file = path.join(world.dataDir, "saved");
  await world.wallet.exportBackup("synthetic backup", file, portable);
  const text = readFileSync(file, "utf8");
  expect(text).not.toContain("Saved work");
  await world.wallet.close();
  const dir = mkdtempSync(path.join(tmpdir(), "agenc-business-restored-"));
  const secret = randomBytes(32);
  writeFileSync(
    path.join(dir, "connection-grants.json"),
    JSON.stringify({ fixture: "previous device" }),
  );
  await restoreBackup({
    dataDir: dir,
    unlockSecret: secret,
    text,
    password: "synthetic backup",
    network: "localnet",
    now: world.clock.now,
  });
  expect(() => readFileSync(path.join(dir, "connection-grants.json"))).toThrow(
    /ENOENT/,
  );
  expect(() => readFileSync(path.join(dir, cache, "passed.json"))).toThrow(
    /ENOENT/,
  );
  world.wallet = await world.reopen({ dataDir: dir, unlockSecret: secret });
  const recovery = await world.wallet.businessStatus();
  expect(recovery).toMatchObject({
    drafts: 1,
    services: 1,
    requiresConsent: true,
    pendingSignatures: ["pending"],
    obligations: expect.arrayContaining([
      expect.objectContaining({ jobId: job.id }),
    ]),
  });
  expect((await world.wallet.overview()).agents[0]!.scope).toBeNull();
  await expect(world.wallet.setEarn(buyer.id, true)).rejects.toThrow(
    /permission/,
  );
  await expect(
    world.wallet.confirmRestoredDevice(recovery!.restoredAt),
  ).rejects.toThrow(/pending/);
  pending = false;
  await expect(
    world.wallet.confirmRestoredDevice(recovery!.restoredAt),
  ).rejects.toThrow(/Rehearse/);
  writeFileSync(
    path.join(dir, "business-rehearsals.json"),
    JSON.stringify({
      restoredAt: recovery!.restoredAt,
      services: [JSON.stringify([buyer.id, digest(bytes)])],
    }),
  );
  await expect(
    world.wallet.confirmRestoredDevice(recovery!.restoredAt),
  ).resolves.toMatchObject({ requiresConsent: false, pendingSignatures: [] });
  expect((await world.wallet.overview()).agents[0]!.earn.enabled).toBe(false);
}, 30000);

it("discovers a live seller hire accepted after the last backup", async () => {
  world = await startWorld({
    chain: (base) => ({ ...base, network: "localnet" }),
    earn: {
      chosenRoomEnabled: () => true,
      checkExecutionReady: async () => {},
      pollIntervalMs: 60000,
      executor: {
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write('done')",
          "{prompt}",
        ],
        mode: "sandboxed",
        envAllowlist: [],
        timeoutMs: 10000,
      },
    },
  });
  const seller = await world.wallet.createAgent("First device");
  const input = {
    name: "Copy edit",
    summary: "Edit a short draft",
    price: { usdCents: 25 },
  };
  const price = await world.wallet.quoteEarn(seller.id, input);
  await world.wallet.setOffer(seller.id, input, undefined, price.quoteId);
  const startup = await world.wallet.quoteManualWork(seller.id);
  await world.wallet.startManualWork(seller.id, startup.quoteId);
  const listing = await eventually(async () => {
    await world.wallet.tick();
    const offer = (await world.wallet.overview()).agents.find(
      (a) => a.id === seller.id,
    )?.earn.offer;
    return offer?.status === "live" && offer.listing;
  });
  const archive = path.join(world.dataDir, "snapshot");
  await world.wallet.exportBackup("test business recovery", archive);
  const previousWallet = world.wallet;
  const buyerDir = mkdtempSync(path.join(tmpdir(), "business-buyer-"));
  world.wallet = await world.reopen({
    dataDir: buyerDir,
    unlockSecret: randomBytes(32),
  });
  world.sandbox.fund(world.wallet.mainAddress, 2_000_000_000n);
  const buyer = await world.wallet.createAgent("Buyer");
  await world.wallet.fundAgent(buyer.id, { usdCents: 300 });
  await world.wallet.setPolicy(buyer.id, {
    askAboveCents: 300,
    refill: { enabled: true, topUpToCents: 0, perDayCents: 500 },
  });
  const { job } = await world.wallet.hire({
    agentId: buyer.id,
    listing,
    request: "Edit a new draft",
  });
  await world.wallet.close();
  await previousWallet.close();
  const dir = mkdtempSync(path.join(tmpdir(), "business-seller-"));
  const unlockSecret = randomBytes(32);
  await restoreBackup({
    dataDir: dir,
    unlockSecret,
    password: "test business recovery",
    text: readFileSync(archive, "utf8"),
    network: "localnet",
    now: world.clock.now,
  });
  world.wallet = await world.reopen({ dataDir: dir, unlockSecret });
  const recovery = await world.wallet.businessStatus();
  expect(recovery?.obligations).toContainEqual(
    expect.objectContaining({
      unclaimed: true,
      task: job.task,
      agentId: seller.id,
      role: "working",
    }),
  );
  expect(recovery?.requiresConsent).toBe(true);
  expect((await world.wallet.overview()).agents[0]?.earn.enabled).toBe(false);
}, 60000);
