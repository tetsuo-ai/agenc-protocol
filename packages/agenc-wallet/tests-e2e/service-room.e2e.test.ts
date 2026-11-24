import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { readAgent, readListing } from "../src/market.js";
import { serviceUsage } from "../src/service-usage.js";
import { confirmPayout, eventually, setEarnWithApproval, REVIEW_ALLOWANCE, startWorld } from "./harness.js";
import type { Address } from "@solana/kit";

const program = process.env.AGENC_TEST_SERVICE_ROOM;
const assets = process.env.AGENC_TEST_ROOM_ASSETS;

const electron = process.env.AGENC_TEST_ROOM_ELECTRON;
function runFixture(argv: string[], input: object) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: "pipe" });
    let out = "", err = "";
    child.stdout.on("data", b => out += b); child.stderr.on("data", b => err += b);
    child.on("error", reject); child.on("close", code => code === 0 ? resolve(out) : reject(new Error(err)));
    child.stdin.end(JSON.stringify(input));
  });
}
function panel(input: object) {
  return runFixture([electron!, path.resolve(path.dirname(program!), "../scripts/check-service-room.cjs"), "--no-sandbox"], input);
}

it.skipIf(!program || !assets).each(["register", "upgrade"])("rehearses and serves a different wallet with verified capabilities (%s)", async (mode) => {
  const scratch = mkdtempSync(path.join(tmpdir(), "service-journey-"));
  const room = path.join(scratch, "{agent}");
  const earn = {
    executor: { argv: [process.execPath, program!, "job", room, process.execPath, "120", assets!, "{outbox}", "{files}", "{pay}", "{requestSource}", "{prompt}"],
      mode: "sandboxed" as const, isolatedJobRoom: true, envAllowlist: [], timeoutMs: 150000,
      readiness: { argv: [process.execPath, program!, "self-test", assets!, scratch], timeoutMs: 120000 } },
    pollIntervalMs: 100, serviceRefreshMs: 1000,
  };
  const world = await startWorld({ earn, config: { listingTimeoutMs: 120000 } });
  const buyerWallet = await world.reopen({ dataDir: path.join(scratch, "buyer"), earn: { executor: null } });
  try {
    const seller = await world.wallet.createAgent();
    if (mode === "upgrade") {
      await setEarnWithApproval(world.wallet, seller.id, true, 10);
      await eventually(async () => (await world.wallet.effectiveServiceCapabilities(seller.id)) === 1n);
      await world.wallet.setEarn(seller.id, false);
    }
    const sellerDir = path.join(world.dataDir, "earn", seller.id);
    const sample = { files: [
      { name: "service.py", base64: Buffer.from("import pathlib,sys\np=pathlib.Path\n(p('/work/outbox')/'result.txt').write_text(p('/inbox/prefix.txt').read_text()+p(sys.argv[1]).read_text())\nprint('Text ready')").toString("base64") },
      { name: "prefix.txt", base64: Buffer.from("Verified: ").toString("base64") },
    ], entry: "service.py", seconds: 20, referenceFiles: true, outputs: ["result.txt"], sample: "Sample" };
    const args = [process.execPath, program!, "rehearse", sellerDir, scratch, assets!];
    await expect(runFixture(args, { ...sample, tools: ["guest-python", "host-shell"] })).rejects.toThrow(/tool set/);
    const checked = electron ? await panel({ mode: "rehearse", sample, node: process.execPath, program, stateDir: sellerDir, scratch, assets }) :
      await runFixture(args, sample);
    const rehearsal = JSON.parse(checked);
    expect(rehearsal).toMatchObject({ costUsd: 0, pin: { capabilities: "5" }, files: [{ name: "result.txt" }] });
    await expect(world.wallet.quoteEarn(seller.id, { name: "Unproved", summary: "Test", price: { usdCents: 50 }, terms: { servicePin: { ...rehearsal.pin, capabilities: "9" } } })).rejects.toThrow(/Rehearse/i);
    const offer = { name: "Prefix a document", summary: "Deliver a signed-off text file.", price: { usdCents: 80 }, enableEarns: true as const,
      setupId: "immutable-workflow", terms: { servicePin: rehearsal.pin, minimumMarginCents: 5, modelCapCents: 10 } };
    const file = path.join(sellerDir, "service-bundles", rehearsal.pin.digest, "manifest.json");
    const original = readFileSync(file);
    writeFileSync(file, Buffer.concat([original, Buffer.from(" ")]));
    await expect(world.wallet.quoteEarn(seller.id, offer)).rejects.toThrow(/rehearsal/);
    writeFileSync(file, original);
    const quote = await world.wallet.quoteEarn(seller.id, offer);
    expect(quote.serviceAdmission).toMatchObject({ capabilities: "5", modelBudgetCents: 10 });
    const approved = electron ? JSON.parse(await panel({ mode: "approve", quote, offer })).id : quote.quoteId;
    expect(approved).toBe(quote.quoteId);
    await world.wallet.setOffer(seller.id, offer, undefined, approved);
    const listing = await eventually(async () => { await world.wallet.tick(); const s = world.wallet.sellerSetup(seller.id, offer.setupId); return s?.stage === "live" ? s.listing : null; }, 120000);
    const stored = await readListing(world.sandbox.chain, listing as Address);
    expect(stored?.requiredCapabilities).toBe(5n);
    expect((await readAgent(world.sandbox.chain, stored!.providerAgent))!.capabilities).toBe(5n);
    world.sandbox.fund(buyerWallet.mainAddress, 2_000_000_000n);
    const buyer = await buyerWallet.createAgent();
    await buyerWallet.fundAgent(buyer.id, { usdCents: 500 });
    await buyerWallet.setPolicy(buyer.id, { askAboveCents: 100, refill: REVIEW_ALLOWANCE });
    const { job } = await buyerWallet.hire({ agentId: buyer.id, listing, request: "Invoice 17" });
    const delivered = await eventually(async () => { const j = await buyerWallet.getJob(job.id, true); return j.status === "delivered" ? j : null; }, 140000);
    const delivery = await buyerWallet.jobDelivery(delivered.id, true);
    expect((delivery.files ?? []).map(f => f.name)).toContain("result.txt");
    const fileBytes = await buyerWallet.jobFile(delivered.id, delivery.files![0]!.sha256);
    expect(Buffer.from(fileBytes.base64, "base64").toString()).toBe("Verified: Invoice 17");
    await confirmPayout(buyerWallet, job.id);
    const usage = serviceUsage(sellerDir, delivered.task!);
    if (electron) {
      const jobView = await eventually(async () => {
        await world.wallet.tick();
        return (await world.wallet.listJobs({ role: "working" }, true)).find(j => j.task === delivered.task && j.status === "paid");
      });
      const credit = jobView.price;
      expect(credit.usdCents).toBeGreaterThan(0);
      await panel({ mode: "margin", usage, credit, expectedMargin: "$" + (credit.usdCents! / 100).toFixed(2) });
    }
    expect(usage).toMatchObject({ costUsd: 0, reservedCents: 10, runs: 1 });
  } finally { await buyerWallet.close(); await world.wallet.close(); }
}, 360000);
