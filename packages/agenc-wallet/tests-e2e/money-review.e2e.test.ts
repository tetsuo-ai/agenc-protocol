import path from "node:path";
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
