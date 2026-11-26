// A real post or hire that requires report.csv. With no file delivered the
// paying agent's approval sends nothing; with the file inspected it pays once.
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCompiledTransactionMessageDecoder, type Address } from "@solana/kit";
import { findEscrowPda } from "@tetsuo-ai/marketplace-sdk";
import { afterEach, expect, it } from "vitest";
import { deliveryChunkAck } from "../src/client/job-exchange.js";
import { DEFAULT_SELLER_TERMS } from "../src/client/seller-terms.js";
import { AgencWallet } from "../src/wallet.js";
import { REVIEW_ALLOWANCE, SOL, eventually, setEarnWithApproval, setOfferWithApproval, startWorld, type World } from "./harness.js";

let world: World | undefined, seller: AgencWallet | undefined, dir = "";
afterEach(async () => {
  await seller?.close(); await world?.wallet.close();
  seller = undefined; world = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// Attaches report.csv only while the flag file exists.
const program = [
  "const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');",
  "const [flag,outbox,prefix]=process.argv.slice(1);",
  "let reply='The report is ready.';",
  "if(fs.existsSync(flag)&&outbox){const b=Buffer.from('city,total\\nOslo,4\\n');const sha=crypto.createHash('sha256').update(b).digest('hex');",
  "fs.writeFileSync(path.join(outbox,sha),b);reply+='\\n\\n---\\nFiles with this delivery:\\n1. report.csv (text/csv, '+b.length+' bytes)\\n   '+prefix+sha+'\\n';}",
  "process.stdout.write(reply);",
].join("");

it.each(["post", "hire"] as const)("refuses an agent %s approval without the agreed report.csv and pays once with it", async kind => {
  const sent: string[] = [];
  world = await startWorld({ transport: base => ({ ...base, async sendAndConfirm(tx) {
    const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    sent.push(msg.staticAccounts[0]!);
    return base.sendAndConfirm(tx);
  } }) });
  const { wallet, sandbox } = world;
  dir = mkdtempSync(join(tmpdir(), "agenc-outputs-"));
  const flag = join(dir, "attach");
  seller = await AgencWallet.open({ dataDir: join(dir, "seller"), unlockSecret: randomBytes(32), chain: sandbox.chain, services: sandbox.services,
    prices: sandbox.prices, earn: { executor: { argv: [process.execPath, "-e", program, flag, "{outbox}", "{files}", "{prompt}"],
      mode: "sandboxed", envAllowlist: [], timeoutMs: 30000, isolatedJobRoom: true }, pollIntervalMs: 120, checkExecutionReady: async () => {} } });
  sandbox.fund(seller.mainAddress, 5n * SOL);
  const provider = await seller.createAgent("Studio"), buyer = await wallet.createAgent("Client");
  await wallet.fundAgent(buyer.id, { usdCents: 2000 });
  await wallet.setPolicy(buyer.id, { askAboveCents: 500, refill: { ...REVIEW_ALLOWANCE, perDayCents: 5000 } });
  await setEarnWithApproval(seller, provider.id, true, 10);
  let listing = "";
  if (kind === "hire") {
    await setOfferWithApproval(seller, provider.id, { name: "Studio report", summary: "Prepare a report.", price: { usdCents: 40 },
      terms: { ...DEFAULT_SELLER_TERMS, maxOpenJobs: 3 } });
    listing = await eventually(async () => { await seller!.tick(); return (await seller!.overview()).agents.find(a => a.id === provider.id)?.earn.offers[0]?.listing; });
  }
  const outputs = { requiredFiles: ["report.csv"], allowTextOnly: false };
  const buy = async (request: string) => {
    const shared = { agentId: buyer.id, request, outputs };
    const { job } = kind === "post" ? await wallet.post({ ...shared, reward: { usdCents: 40 } }) : await wallet.hire({ ...shared, listing });
    expect(job.acceptance).toContain("Agreed outputs v1: at least one file; required files: report.csv");
    return eventually(async () => { const d = await wallet.getJob(job.id, true); return d.status === "delivered" ? d : null; }, 40000);
  };
  const readAll = async (jobId: string, files: string[]) => {
    for (const part of ["text", ...files]) {
      let offset = 0, total = 1;
      while (offset < total) {
        const chunk = await wallet.readDeliveryChunk(jobId, buyer.id, part, offset);
        await wallet.acknowledgeDeliveryChunk(jobId, buyer.id, await deliveryChunkAck(chunk));
        total = chunk.totalBytes; offset += Buffer.from(chunk.base64, "base64").length;
        if (total === 0) break;
      }
    }
  };
  const balances = async (task: string) => {
    const [escrow] = await findEscrowPda({ task: task as Address });
    return Promise.all([world!.balance(buyer.address), world!.balance(provider.address), world!.balance(escrow)]);
  };
  const fromBuyer = () => sent.filter(payer => payer === buyer.address || payer === wallet.mainAddress).length;

  // 1. Text only: the agent can neither read a verified delivery nor pay.
  const missing = await buy("Prepare the city report.");
  expect(missing.result?.files ?? []).toEqual([]);
  await expect(readAll(missing.id, [])).rejects.toThrow();
  const quote = (await wallet.reviewRecord(missing.id)).quote!;
  const before = await balances(missing.task!), count = fromBuyer();
  await expect(wallet.approveJob(missing.id, undefined, false, buyer.id, quote.id)).rejects.toThrow();
  expect(fromBuyer()).toBe(count);
  expect(await balances(missing.task!)).toEqual(before);
  expect((await wallet.getJob(missing.id, true)).status).toBe("delivered");

  // 2. The file delivered and every byte inspected: exactly one payment.
  writeFileSync(flag, "");
  expect(existsSync(flag)).toBe(true);
  const delivered = await buy("Prepare the second city report.");
  expect(delivered.result?.files.map(f => f.name)).toEqual(["report.csv"]);
  const q2 = (await wallet.reviewRecord(delivered.id)).quote!;
  await expect(wallet.approveJob(delivered.id, undefined, false, buyer.id, q2.id)).rejects.toThrow();
  await readAll(delivered.id, ["report.csv"]);
  const [, sellerBefore] = await balances(delivered.task!), paidCount = fromBuyer();
  const results = await Promise.allSettled([1, 2].map(() => wallet.approveJob(delivered.id, undefined, false, buyer.id, q2.id)));
  expect(results.some(r => r.status === "fulfilled")).toBe(true);
  expect(fromBuyer()).toBe(paidCount + 1);
  expect((await wallet.getJob(delivered.id, true)).status).toBe("paid");
  const [, sellerAfter, escrowAfter] = await balances(delivered.task!);
  expect(sellerAfter).toBeGreaterThan(sellerBefore);
  expect(escrowAfter).toBe(0n);
}, 120000);
