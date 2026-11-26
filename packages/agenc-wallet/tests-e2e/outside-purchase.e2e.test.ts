// Release fixture: point AGENC_TEST_BRIDGE_DIR at Desktop's installed bridge
// resources. The test hosts only a private socket and a local LiteSVM wallet.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { expect, it } from "vitest";
import { REVIEW_ALLOWANCE, SOL, startWorld } from "./harness.js";
import { WalletError } from "../src/errors.js";

it.skipIf(!process.env.AGENC_TEST_BRIDGE_DIR).each(["market_hire", "market_offer"])("recovers %s across a dropped HTTP reply, new binding and process restarts", async method => {
  const dir = process.env.AGENC_TEST_BRIDGE_DIR!;
  const { forwardPurchaseIntent, bindSellerQuote, sellerQuoteBinding } = await import(/* @vite-ignore */ pathToFileURL(join(dir, "purchase-intent.mjs")).href);
  const w = await startWorld({ earn: { executor: { argv: [process.execPath, "-e", "process.stdout.write('done')", "{prompt}"],
    mode: "sandboxed", envAllowlist: [], timeoutMs: 10000 }, pollIntervalMs: 150 } });
  const a = await w.wallet.createAgent("Connected buyer");
  await w.wallet.setPolicy(a.id, { askAboveCents: 1000, refill: REVIEW_ALLOWANCE });
  if (method === "market_hire") await w.wallet.fundAgent(a.id, { lamports: String(SOL) });
  const data = mkdtempSync(join(tmpdir(), "br-"));
  const profile = join(data, "market-connect");
  mkdirSync(profile, { mode: 0o700 });
  const socket = join(data, "m.sock");
  writeFileSync(join(profile, "desktop.json"), JSON.stringify({ socket }), { mode: 0o600 });
  let sessions = 0, dispatches = 0, loseReply = true;
  const broker = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const msg = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    res.setHeader("content-type", "application/json");
    try {
      if (req.method === "DELETE") return void res.end("{}");
      if (req.url === "/market/connect") return void res.end(JSON.stringify({ token: "a".repeat(64) }));
      if (msg.method === "initialize") {
        res.setHeader("mcp-session-id", String(++sessions));
        return void res.end(JSON.stringify({ id: msg.id, result: { protocolVersion: msg.params.protocolVersion } }));
      }
      if (msg.method !== "tools/call") return void res.end("{}");
      const { operation_id, ...terms } = msg.params.arguments;
      const scope = { installation: "fixture", project: "project", network: "sandbox", payer: a.id };
      const input = { directory: join(data, "operations"), scope, method: msg.params.name, terms };
      const answer = await forwardPurchaseIntent({ ...input, operationId: operation_id,
        lookup: async (key: string) => {
          if (method === "market_offer") {
            const bound = sellerQuoteBinding({ ...input, operationId: key });
            if (!bound) return null;
            const receipt = w.wallet.sellerOperation(a.id, bound.quoteId);
            if (!receipt || receipt.network !== bound.network || receipt.seller !== bound.seller) throw Error("Unresolved seller receipt");
            return receipt;
          }
          try { return (await w.wallet.callOutcome(a.id, "hire", key)).receipt; }
          catch (e) { if (e instanceof WalletError && e.code === "NOT_FOUND") return null; throw e; }
        },
        dispatch: async (key: string) => {
          dispatches++;
          if (method === "market_offer") {
            const offer = { name: terms.name, summary: terms.description, price: { usdCents: Math.round(terms.price_usd * 100) }, setupId: key };
            const quote = await w.wallet.quoteEarn(a.id, offer);
            bindSellerQuote({ ...input, operationId: key }, a.address, quote.quoteId);
            // Simulate the owner confirming the exact local quote.
            await w.wallet.setOffer(a.id, offer, undefined, quote.quoteId);
            return w.wallet.sellerOperation(a.id, quote.quoteId);
          }
          await w.wallet.hire({ agentId: a.id, listing: terms.listing, request: terms.request, idempotencyKey: key });
          return (await w.wallet.callOutcome(a.id, "hire", key)).receipt;
        } });
      if (loseReply) { loseReply = false; res.destroy(); return; }
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: answer }));
    } catch (e) { res.statusCode = 500; res.end(String(e)); }
  });
  broker.listen(socket);
  await once(broker, "listening");
  async function call() {
    const bridge = spawn(process.env.AGENC_TEST_BRIDGE_NODE || process.execPath,
      [join(dir, "market-bridge.mjs"), "--agent", "codex", "--desktop-data", data],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    const done = once(bridge, "exit");
    let out = "";
    bridge.stdout.on("data", b => { out += b.toString(); });
    bridge.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: method, arguments: method === "market_hire" ? { listing: w.listing, request: "One lighthouse poem." } :
        { action: "create", name: "Editing", description: "Line edits", price_usd: 0.30 } } }) + "\n");
    expect((await done)[0]).toBe(0);
    return JSON.parse(out.trim()).result;
  }
  try {
    const first = await call();
    if (method === "market_hire") expect(first.outcome).toMatchObject({ payer: a.address, listing: w.listing, signatures: { hire: expect.any(String) } });
    else expect(first.outcome).toMatchObject({ seller: a.address, network: "sandbox", state: "confirmed", fundingSignature: expect.any(String),
      priceLamports: "3000000", listingId: expect.stringMatching(/^[a-f0-9]{64}$/), terms: expect.stringContaining("Line edits") });
    const payer = method === "market_hire" ? a.address : w.wallet.mainAddress;
    const after = await w.balance(payer);
    await w.wallet.close();
    w.wallet = await w.reopen();
    const second = await call();
    expect(second.operationId).toBe(first.operationId);
    if (method === "market_hire") expect(second.outcome).toEqual(first.outcome);
    else expect(second.outcome).toMatchObject({ fundingSignature: first.outcome.fundingSignature, quoteId: first.outcome.quoteId,
      listingId: first.outcome.listingId, terms: first.outcome.terms, fundedLamports: first.outcome.fundedLamports });
    expect(sessions).toBe(3);
    expect(dispatches).toBe(1);
    expect(await w.balance(payer)).toBe(after);
  } finally {
    broker.closeAllConnections();
    await new Promise<void>(resolve => broker.close(() => resolve()));
    await w.wallet.close();
  }
});
