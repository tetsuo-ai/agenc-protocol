import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { AgencWallet } from "../src/wallet.js";
import { bundleManifest, collectOutput, digest, privateInputCriterion, protectOutput, type Packet } from "../src/private-inputs.js";
import { acceptImportReceipt, ExchangeRelay, importAndAcknowledge } from "../src/exchange-relay.js";
import { REVIEW_ALLOWANCE, SOL, eventually, setEarnWithApproval, setOfferWithApproval, startWorld, type World } from "./harness.js";

let world: World | undefined, seller: AgencWallet | undefined, dir: string;
let stop: (() => void) | undefined;
afterEach(async () => {
  await seller?.close(); await world?.wallet.close(); stop?.();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

it.each(["post", "hire"] as const)("hands private files to the confirmed %s worker and returns a protected multi-chunk delivery", async kind => {
  const log: string[] = [];
  world = await startWorld({ config: { log: text => log.push(text) } });
  const { wallet, sandbox } = world;
  dir = mkdtempSync(join(tmpdir(), "agenc-private-job-"));
  // A local isolated executor double waits for the verified output pointer.
  // The public submission never contains its private text, file names or bytes.
  const pointerFile = join(dir, "approved-output");
  const program = "const fs=require('node:fs');const t=setInterval(()=>{if(fs.existsSync(process.argv[1])){clearInterval(t);process.stdout.write(fs.readFileSync(process.argv[1]))}},50)";
  seller = await AgencWallet.open({ dataDir: join(dir, "seller"), unlockSecret: randomBytes(32), chain: sandbox.chain, services: sandbox.services,
    prices: sandbox.prices, log: text => log.push(text), earn: { executor: { argv: [process.execPath, "-e", program, pointerFile, "{prompt}"],
      mode: "sandboxed", envAllowlist: [], timeoutMs: 40000 }, pollIntervalMs: 120, checkExecutionReady: async () => {} } });
  sandbox.fund(seller.mainAddress, 5n * SOL);
  const provider = await seller.createAgent("Studio"), buyer = await wallet.createAgent("Client");
  await wallet.fundAgent(buyer.id, { usdCents: 1000 });
  await wallet.setPolicy(buyer.id, { askAboveCents: 500, refill: REVIEW_ALLOWANCE });
  const fileBytes = Buffer.from("original confidential figures");
  const file = { name: "internal.csv", bytes: fileBytes.length, sha256: digest(fileBytes), base64: fileBytes.toString("base64") };
  const req = await wallet.stageJobInputs([file], provider.address, "Read inside the isolated room.", { requiredFiles: ["answer.csv"], allowTextOnly: false });
  const approval = await wallet.approvedJobInputs(req.commitment);
  const acceptance = [privateInputCriterion(approval)];
  let listing = "";
  if (kind === "hire") {
    await setEarnWithApproval(seller, provider.id, true, 10);
    await setOfferWithApproval(seller, provider.id, { name: "Studio report", summary: "Prepare a report.", price: { usdCents: 40 } });
    listing = await eventually(async () => { await seller!.tick(); return (await seller!.overview()).agents.find(a => a.id === provider.id)?.earn.offers[0]?.listing; });
  }
  const shared = { agentId: buyer.id, request: "Prepare a report.", acceptance };
  const { job } = kind === "post" ? await wallet.post({ ...shared, reward: { usdCents: 40 } }) : await wallet.hire({ ...shared, listing });
  const room = "f".repeat(64);
  if (kind === "post") {
    await expect(wallet.jobExchange(job.id, room, buyer.id)).rejects.toThrow();
    await setEarnWithApproval(seller, provider.id, true, 10);
  }
  await eventually(async () => (await wallet.getJob(job.id, true)).status === "working");
  const buyerExchange = await wallet.jobExchange(job.id, room, buyer.id);
  const workerExchange = await seller.jobExchange("earn_" + provider.id + "_" + job.task, room, provider.id);
  const [buyerKey, workerKey] = await Promise.all([buyerExchange.announceKey(), workerExchange.announceKey()]);
  const parties = await buyerExchange.live();
  await expect(buyerExchange.grant({ ...req, commitment: "0".repeat(64) }, parties, workerKey)).rejects.toThrow();
  await buyerExchange.grant(req, parties, workerKey);
  const packet = await buyerExchange.inputs(req);
  const events: Packet[] = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const event = JSON.parse(Buffer.concat(chunks).toString()) as Packet;
    if (event.header.purpose === "read") {
      const [after] = JSON.parse(event.payload);
      response.end(JSON.stringify({ cursor: after + 1, packet: events[after] }));
    } else {
      if (!events.some(row => row.signature === event.signature)) events.push(event);
      response.end(JSON.stringify({ cursor: events.length }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  stop = () => { server.closeAllConnections(); server.close(); };
  const relay = new ExchangeRelay("http://127.0.0.1:" + (server.address() as AddressInfo).port);
  await relay.put(buyerExchange, packet); await relay.put(buyerExchange, packet);
  expect(events).toHaveLength(1);
  const event = await relay.next(workerExchange, 0);
  const { receipt, ack } = await importAndAcknowledge(workerExchange, req, event!.packet, buyerKey, async bundle => {
    expect(bundle.files).toEqual([file]);
    expect(bundle.outputs?.requiredFiles).toEqual(["answer.csv"]);
    return { commitment: req.commitment, manifest: bundleManifest(bundle), version: bundle.version, room };
  });
  expect(await acceptImportReceipt(buyerExchange, req, ack)).toEqual(receipt);
  const outputBytes = Buffer.from("private completed figures\n".repeat(2200));
  const output = { salt: randomBytes(32).toString("hex"), version: 1, text: "The private report is complete.", files: [{ name: "answer.csv",
    bytes: outputBytes.length, sha256: digest(outputBytes), base64: outputBytes.toString("base64") }] };
  const sealed = await protectOutput(workerExchange, output, buyerKey);
  await collectOutput(buyerExchange, bundleManifest(output), sealed.packet);
  writeFileSync(pointerFile, sealed.pointer);
  const delivered = await eventually(async () => { const d = await wallet.getJob(job.id, true); return d.status === "delivered" ? d : null; });
  expect(delivered.result?.text).toBe(sealed.pointer);
  expect((await wallet.jobDelivery(job.id, false, buyer.id)).text).toBe(output.text);
  const q = (await wallet.reviewRecord(job.id)).quote!;
  await wallet.readDeliveryChunk(job.id, buyer.id, "text", 0);
  const pieces = [];
  let pos = 0;
  while (pos < outputBytes.length) {
    await expect(wallet.requireDeliveryInspection(job.id, buyer.id, q.deliveryHash, q.submissionCount)).rejects.toThrow();
    const part = Buffer.from((await wallet.readDeliveryChunk(job.id, buyer.id, "answer.csv", pos)).base64, "base64");
    pieces.push(part); pos += part.length;
  }
  expect(Buffer.concat(pieces)).toEqual(outputBytes);
  await wallet.requireDeliveryInspection(job.id, buyer.id, q.deliveryHash, q.submissionCount);
  const publicData = [JSON.stringify(acceptance), JSON.stringify(events), ...log, ...Array.from(sandbox.deliveries.values(), x => Buffer.from(x).toString())].join("\n");
  for (const secret of [file.name, fileBytes.toString(), output.text, "answer.csv", "private completed figures"]) expect(publicData).not.toContain(secret);
}, 60000);
