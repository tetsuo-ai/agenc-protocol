// A required file no delivery can carry (report.xlsx), end to end on the wallet's own sandbox chain.
// The buyer's wallet refuses it before any quote: no job, no transaction. And a public job that already carries such
// an agreement (posted by other software, or before this rule) is skipped by a seller: no claim, no claim deposit,
// while a job with a good agreement posted after it is still claimed and delivered.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCompiledTransactionMessageDecoder } from "@solana/kit";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_SELLER_TERMS } from "../src/client/seller-terms.js";
import { AgencWallet } from "../src/wallet.js";
import { REVIEW_ALLOWANCE, SOL, eventually, setEarnWithApproval, setOfferWithApproval, startWorld, type World } from "./harness.js";

// Stands in for a buyer whose software does not have the rule: while `lenient`, any plain name passes.
const rule = vi.hoisted(() => ({ lenient: false }));
vi.mock("../src/client/delivery-files.js", async (original) => {
  const real = await original<typeof import("../src/client/delivery-files.js")>();
  return { ...real, agreedOutputProblem: (name: string) => (rule.lenient ? null : real.agreedOutputProblem(name)) };
});

let world: World | undefined, seller: AgencWallet | undefined, dir = "";
afterEach(async () => {
  rule.lenient = false;
  await seller?.close(); await world?.wallet.close();
  seller = undefined; world = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// Always attaches report.csv.
const program = [
  "const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');",
  "const [outbox,prefix]=process.argv.slice(1);",
  "const b=Buffer.from('city,total\\nOslo,4\\n');const sha=crypto.createHash('sha256').update(b).digest('hex');",
  "fs.writeFileSync(path.join(outbox,sha),b);",
  "process.stdout.write('The report is ready.\\n\\n---\\nFiles with this delivery:\\n1. report.csv (text/csv, '+b.length+' bytes)\\n   '+prefix+sha+'\\n');",
].join("");

it("refuses report.xlsx before any quote, and a seller skips a job that names it but takes a good one", async () => {
  const sent: string[] = [];
  world = await startWorld({ transport: base => ({ ...base, async sendAndConfirm(tx) {
    sent.push(getCompiledTransactionMessageDecoder().decode(tx.messageBytes).staticAccounts[0]!);
    return base.sendAndConfirm(tx);
  } }) });
  const { wallet, sandbox } = world;
  dir = mkdtempSync(join(tmpdir(), "agenc-outputs-refusal-"));
  const buyer = await wallet.createAgent("Client");
  await wallet.fundAgent(buyer.id, { usdCents: 2000 });
  await wallet.setPolicy(buyer.id, { askAboveCents: 500, refill: { ...REVIEW_ALLOWANCE, perDayCents: 5000 } });
  const openSeller = async () => {
    seller = await AgencWallet.open({ dataDir: join(dir, "seller"), unlockSecret: randomBytes(32), chain: sandbox.chain, services: sandbox.services,
      prices: sandbox.prices, earn: { executor: { argv: [process.execPath, "-e", program, "{outbox}", "{files}", "{prompt}"],
        mode: "sandboxed", envAllowlist: [], timeoutMs: 30000, jobRoom: true, isolatedJobRoom: true }, pollIntervalMs: 120, checkExecutionReady: async () => {} } });
    sandbox.fund(seller.mainAddress, 5n * SOL);
    const provider = await seller.createAgent("Studio");
    await setEarnWithApproval(seller, provider.id, true, 10);
    return provider;
  };

  // 1. The buyer's side: refused in plain words, with nothing sent and no job kept, on a post, a hire and their quotes.
  const provider = await openSeller();
  await setOfferWithApproval(seller!, provider.id, { name: "Studio report", summary: "Prepare a report.", price: { usdCents: 40 },
    terms: { ...DEFAULT_SELLER_TERMS, maxOpenJobs: 3 } });
  const listing = await eventually(async () => { await seller!.tick(); return (await seller!.overview()).agents.find(a => a.id === provider.id)?.earn.offers[0]?.listing; });
  const jobsBefore = (await wallet.listJobs({}, true)).length, sentBefore = sent.length;
  const plain = /^"[A-Za-z.]+" cannot be a required file: .*\. A delivery carries these kinds of file: \.png, \.webp, \.pdf, \.zip, \.txt, \.md, \.csv, \.json\.$/;
  for (const name of ["report.xlsx", "Makefile", "tool.exe", "photo.jpg"]) {
    const outputs = { requiredFiles: [name], allowTextOnly: false };
    await expect(wallet.post({ agentId: buyer.id, request: "Prepare the city report.", outputs, reward: { usdCents: 40 } }), name).rejects.toThrow(plain);
    await expect(wallet.hire({ agentId: buyer.id, request: "Prepare the city report.", outputs, listing: listing! }), name).rejects.toThrow(plain);
  }
  expect(sent.length).toBe(sentBefore);
  expect((await wallet.listJobs({}, true)).length).toBe(jobsBefore);
  await seller!.close();
  seller = undefined;

  // 2. A job already on the chain with that agreement (a buyer without the rule).
  rule.lenient = true;
  const { job: bad } = await wallet.post({ agentId: buyer.id, request: "Prepare the city workbook.",
    outputs: { requiredFiles: ["report.xlsx"], allowTextOnly: false }, reward: { usdCents: 40 } });
  expect(bad.acceptance).toContain("Agreed outputs v1: at least one file; required files: report.xlsx");
  await eventually(async () => (await wallet.getJob(bad.id, true)).task ?? null, 20000);
  rule.lenient = false;

  // 3. A seller with the rule: the good job, posted later, is taken and delivered; the bad one is left alone.
  rmSync(join(dir, "seller"), { recursive: true, force: true });
  const second = await openSeller();
  const { job: good } = await wallet.post({ agentId: buyer.id, request: "Prepare the city report.",
    outputs: { requiredFiles: ["report.csv"], allowTextOnly: false }, reward: { usdCents: 40 } });
  const delivered = await eventually(async () => { const d = await wallet.getJob(good.id, true); return d.status === "delivered" ? d : null; }, 40000);
  expect(delivered.result?.files.map(f => f.name)).toEqual(["report.csv"]);
  // More passes over the open jobs: still not taken.
  for (let pass = 0; pass < 5; pass += 1) await seller!.tick();
  const left = await wallet.getJob(bad.id, true);
  expect(left.status).not.toBe("working");
  expect(left.status).not.toBe("delivered");
  const work = await seller!.listJobs({ role: "working" }, true);
  expect(work.filter(job => job.task === left.task)).toEqual([]);
  expect(work.filter(job => job.task === delivered.task).length).toBe(1);
  expect(second.id).toBeTruthy();
}, 180000);
