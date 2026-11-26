import { mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { restoreBackup } from "../src/backup.js";
import { generateKeyPairSigner, SolanaError, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND } from "@solana/kit";
import { createRpcTransport, type RpcTransportRpc } from "@tetsuo-ai/marketplace-sdk";
import { afterEach, expect, it } from "vitest";
import { StateStore, type WalletState } from "../src/store.js";
import { confirmPayout, eventually, SOL, startWorld, type World } from "./harness.js";

let w: World;
afterEach(async () => { await w?.wallet.close(); });

async function restart(update?: (state: WalletState) => void) {
  await w.wallet.close();
  if (update) {
    const store = StateStore.open(path.join(w.dataDir, "state.json"));
    store.update(update);
    store.close();
  }
  w.wallet = await w.reopen();
}

function compact(state: WalletState, id: string) {
  const job = state.jobs[id]!;
  Object.assign(job, { phase: "done", tidied: true, contestScanned: true });
  for (let i = 1; i <= 500; i++) {
    const { contestRegistration: _reg, ...copy } = job;
    state.jobs["finished-" + i] = { ...copy, id: "finished-" + i, idempotencyKey: null, updatedAt: job.updatedAt + i };
  }
}

it("requires a choice for ambiguous legacy transfers and exact approval for all", async () => {
  w = await startWorld();
  const agent = await w.wallet.createAgent("Writer");
  const amount = { lamports: String(SOL) };
  await w.wallet.fundAgent(agent.id, amount);
  await restart();
  await expect(w.wallet.fundAgent(agent.id, amount)).rejects.toThrow(/quote|receipt/i);
  const next = await w.wallet.quoteTransfer({ kind: "fund", agentId: agent.id, amount });
  await w.wallet.confirmTransfer(next.id);
  expect(await w.balance(agent.address)).toBe(2n * SOL);
  await expect(w.wallet.reclaimFromAgent(agent.id, "all")).rejects.toThrow(/quote/i);
  const all = await w.wallet.quoteTransfer({ kind: "reclaim", agentId: agent.id, amount: "all" });
  const before = await w.balance(w.wallet.mainAddress);
  await w.wallet.confirmTransfer(all.id);
  expect(await w.balance(w.wallet.mainAddress) - before).toBe(BigInt(all.credit.lamports));
});

it("releases a proven first preflight refusal and never retries that operation", async () => {
  const refusal = createRpcTransport({ rpc: { sendTransaction: () => ({ send: async () => {
    throw new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {
      cause: new SolanaError(SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND),
      accounts: null, fee: null, loadedAccountsDataSize: null, loadedAddresses: null, logs: null,
      postBalances: null, postTokenBalances: null, preBalances: null, preTokenBalances: null, replacementBlockhash: null,
      returnData: null, unitsConsumed: null,
    });
  } }) } as unknown as RpcTransportRpc });
  let refuse = false;
  w = await startWorld({ transport: base => ({ ...base, sendAndConfirm: tx => refuse ? refusal.sendAndConfirm(tx) : base.sendAndConfirm(tx) }) });
  const request = { kind: "withdraw", to: (await generateKeyPairSigner()).address, amount: { lamports: String(SOL) } } as const;
  const q = await w.wallet.quoteTransfer(request);
  refuse = true;
  const failed = await w.wallet.confirmTransfer(q.id);
  expect(failed.state).toBe("failed");
  refuse = false;
  await restart();
  expect(await w.wallet.confirmTransfer(q.id)).toEqual(failed);
  await w.wallet.confirmTransfer((await w.wallet.quoteTransfer(request)).id);
  expect(await w.balance(request.to)).toBe(SOL);
});

it.each(["transfer", "rating", "retirement"])("rejects %s expiry during the last blockhash fetch", async kind => {
  let expire = false;
  w = await startWorld({ transport: base => ({ ...base, async getLatestBlockhash() {
    const hash = await base.getLatestBlockhash();
    if (expire) w.clock.now += 120_001;
    return hash;
  } }) });
  const { wallet, sandbox } = w;
  let confirm: () => Promise<unknown>, id: string;
  if (kind === "transfer") {
    const q = await wallet.quoteTransfer({ kind: "withdraw", to: (await generateKeyPairSigner()).address, amount: { lamports: String(SOL) } });
    id = q.id;
    confirm = () => wallet.confirmTransfer(id);
  } else if (kind === "rating") {
    const a = await wallet.createAgent("Buyer");
    const hire = await wallet.hire({ agentId: a.id, listing: w.listing, request: "A haiku." });
    await wallet.decideApproval(hire.approval!.id, true);
    await sandbox.workOnce();
    await confirmPayout(wallet, hire.job.id);
    id = (await wallet.quoteRating(hire.job.id, 3, true)).id;
    confirm = () => wallet.rateJob(hire.job.id, 3, true, undefined, id);
  } else {
    const job = await finishContest();
    id = (await wallet.quoteContestRetirement(job)).id;
    confirm = () => wallet.retireContestRegistration(id);
  }
  const before = await w.balance(wallet.mainAddress);
  expire = true;
  await expect(confirm()).rejects.toThrow(/expired/i);
  expect(await wallet.operationOutcome(id)).toBeNull();
  expect(await w.balance(wallet.mainAddress)).toBe(before);
});

async function finishContest() {
  const { wallet, sandbox } = w;
  const q = await wallet.quotePost({ request: "Write a poem.", reward: { lamports: "90000001" }, contestEntries: 2,
    reviewWindowSecs: 60, deadline: await sandbox.chain.clusterTime() + 900 });
  const job = await wallet.decideApproval(q.approval!.id, true);
  sandbox.advanceClock(901);
  const refund = await wallet.refundJob(job.id, true);
  await wallet.decideContest(job.id, refund.contestQuote!.id, true);
  await wallet.tick();
  return job.id;
}

it("retains the registration after the final contest leaves the job window", async () => {
  w = await startWorld();
  const id = await finishContest();
  const first = await w.wallet.quoteContestRetirement(id);
  await restart(s => compact(s, id));
  expect(w.wallet.contestRegistrations().map(row => row.jobId)).toContain(id);
  const q = await w.wallet.quoteContestRetirement(id);
  expect(q.registration).toBe(first.registration);
  expect(await w.wallet.retireContestRegistration(q.id)).toMatchObject({ actualCreditLamports: q.credit.lamports });
});

it("returns the agreed request and acceptance criteria after purchase compaction", async () => {
  w = await startWorld();
  const a = await w.wallet.createAgent("Buyer");
  const args = { agentId: a.id, listing: w.listing, request: "Two poems.", acceptance: ["Both use rhyme."], idempotencyKey: "poems" };
  const hire = await w.wallet.hire(args);
  await w.wallet.decideApproval(hire.approval!.id, true);
  await restart(s => compact(s, hire.job.id));
  const { receipt } = await w.wallet.callOutcome(a.id, "hire", args.idempotencyKey);
  // The wallet appends the explicit output agreement line to every new job's checks.
  expect(receipt).toMatchObject({ request: args.request, signatures: { hire: expect.any(String) } });
  expect(receipt!.acceptance.slice(0, args.acceptance.length)).toEqual(args.acceptance);
  expect(receipt!.acceptance.slice(args.acceptance.length)).toEqual([expect.stringMatching(/^Agreed outputs v1: /)]);
});

it("keeps listing creation evidence through an offer edit and restart", async () => {
  w = await startWorld({ earn: { executor: { argv: [process.execPath, "-e", "process.stdout.write('done')", "{prompt}"],
    mode: "sandboxed", envAllowlist: [], timeoutMs: 10000 }, pollIntervalMs: 150 } });
  const seller = await w.wallet.createAgent("Seller");
  const input = { name: "Editor", summary: "Line edits", price: { lamports: "3000999" } };
  const q = await w.wallet.quoteEarn(seller.id, input);
  await w.wallet.setOffer(seller.id, input, undefined, q.quoteId);
  const earn = await w.wallet.quoteEarn(seller.id, undefined, undefined, 10);
  await w.wallet.setEarn(seller.id, true, 10, earn.quoteId);
  const first = await eventually(async () => {
    await w.wallet.tick();
    const receipt = w.wallet.sellerOperation(seller.id, q.quoteId);
    return receipt?.listingSignature ? receipt : null;
  });
  const changed = { ...input, price: { lamports: "4000999" } };
  const edit = await w.wallet.quoteEarn(seller.id, changed, first.offerId);
  await w.wallet.setOffer(seller.id, changed, first.offerId, edit.quoteId);
  await restart();
  expect(w.wallet.sellerOperation(seller.id, q.quoteId)).toEqual(first);
});

it("advances the live head during a pruned backfill and later fills the gap", async () => {
  let top = "older", pruned = true;
  w = await startWorld({ chain: base => ({ ...base, async accountChanges(account, before, until) {
    const all = top === "older" ? ["older", "missing"] : ["new", "older", "missing"];
    const rows = [];
    for (const sig of all.slice(before ? all.indexOf(before) + 1 : 0)) {
      if (sig === until) break;
      if (sig === "missing" && pruned) return { rows, end: false, gap: "Receipt is pruned." };
      rows.push({ signature: sig, account, delta: "10", payerFee: "0", at: 1, externalSender: null, failed: false });
    }
    return { rows, end: true };
  } }) });
  await w.wallet.tick();
  top = "new";
  await restart();
  await w.wallet.tick();
  expect(w.wallet.moneyHistory().rows.map(r => r.signature)).toContain("new");
  expect(w.wallet.moneyHistory().gaps).toHaveLength(1);
  pruned = false;
  await w.wallet.tick();
  expect(w.wallet.moneyHistory().gaps).toHaveLength(0);
  expect(w.wallet.moneyHistory().rows).toHaveLength(3);
});

it("pages same-time signatures by account and archives terminal evidence outside the signing journal", async () => {
  w = await startWorld();
  const agent = await w.wallet.createAgent("Writer");
  const q = await w.wallet.quoteTransfer({ kind: "fund", agentId: agent.id, amount: { lamports: String(SOL) } });
  const outcome = await w.wallet.confirmTransfer(q.id);
  for (let i = 0; i < 8; i++) w.sandbox.fund(w.wallet.mainAddress, 1000n + BigInt(i));
  await w.wallet.tick();
  await restart();
  const account = w.wallet.mainAddress;
  const first = w.wallet.moneyHistory({ account, limit: 3 });
  expect(first.rows).toHaveLength(3);
  expect(first.next).toEqual({ account, signature: first.rows[2]!.signature });
  const second = w.wallet.moneyHistory({ account, limit: 3, before: first.next! });
  expect(second.rows).toHaveLength(3);
  expect([...first.rows, ...second.rows].every(r => r.account === account)).toBe(true);
  expect(new Set([...first.rows, ...second.rows].map(r => r.signature)).size).toBe(6);
  const journal = JSON.parse(readFileSync(path.join(w.dataDir, "state.json"), "utf8"));
  expect(Object.keys(journal.moneyRows ?? {})).toHaveLength(0);
  expect(journal.moneyOperations?.[q.id]).toBeUndefined();
  expect(await w.wallet.confirmTransfer(q.id)).toEqual(outcome);
  expect(await w.balance(agent.address)).toBe(SOL);
});

it("restores the archived operation, its quote and a legacy replay key from backup", async () => {
  w = await startWorld({ chain: base => ({ ...base, network: "localnet" }) });
  const a = await w.wallet.createAgent("Writer");
  const amount = { lamports: String(SOL) };
  await w.wallet.fundAgent(a.id, amount);
  const q = await w.wallet.quoteTransfer({ kind: "fund", agentId: a.id, amount });
  const first = await w.wallet.confirmTransfer(q.id);
  await w.wallet.tick();
  const page = w.wallet.moneyHistory({ account: a.address });
  const backup = path.join(w.dataDir, "archive-test.backup");
  const password = "local test archive password";
  await w.wallet.exportBackup(password, backup);
  await w.wallet.close();
  const dataDir = mkdtempSync(path.join(tmpdir(), "receipt-restore-"));
  await restoreBackup({ dataDir, unlockSecret: w.secret, text: readFileSync(backup, "utf8"), password, now: w.clock.now, network: "localnet" });
  w.wallet = await w.reopen({ dataDir });
  expect(await w.wallet.confirmTransfer(q.id)).toEqual(first);
  expect(w.wallet.moneyHistory({ account: a.address })).toEqual(page);
  await expect(w.wallet.fundAgent(a.id, amount)).rejects.toThrow(/quote|receipt/i);
  expect(await w.balance(a.address)).toBe(2n * SOL);
});

it("restores owner-only pending transfers without sending, and disables retry after blockhash expiry", async () => {
  let drop = false, valid = true, sends = 0;
  w = await startWorld({
    transport: base => ({ ...base, sendAndConfirm(tx) {
      if (drop) { sends++; throw new Error("Connection lost before reply"); }
      return base.sendAndConfirm(tx);
    } }),
    chain: base => ({ ...base, operationBlockhashValid: async () => valid, reviewSendOutcome: async () => "pending" })
  });
  const { moneyHandlers } = await import("../src/money-handlers.js");
  const a = await w.wallet.createAgent();
  const owner = { role: "owner", agentId: null } as const;
  const q = await w.wallet.quoteTransfer({ kind: "fund", agentId: a.id, amount: { lamports: String(SOL) } });
  drop = true;
  const pending = await w.wallet.confirmTransfer(q.id);
  await restart();
  const methods = moneyHandlers(w.wallet);
  await expect(methods["wallet.pendingTransfers"]({}, { role: "agent", agentId: a.id })).rejects.toThrow(/owner/);
  expect(await methods["wallet.pendingTransfers"]({}, owner)).toEqual([{ quote: q, outcome: {
    id: q.id, state: "pending", signature: pending.signature, canRetry: true,
  } }]);
  valid = false;
  expect(await methods["wallet.operationOutcome"]({ id: q.id }, owner)).toMatchObject({ canRetry: false });
  await w.wallet.confirmTransfer(q.id);
  expect(sends).toBe(1);
  expect(await w.balance(a.address)).toBe(0n);
});
