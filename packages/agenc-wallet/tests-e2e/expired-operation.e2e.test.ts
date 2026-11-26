// A signed money operation whose one broadcast is lost. While the signed bytes
// could still land, the payer stays held and nothing new is signed. Once the
// chain proves they can never land, the operation fails, what it reserved is
// given back, and the payer works again. A transaction that did land is only
// ever settled as done, and nothing is paid twice.
import { readFileSync } from "node:fs";
import path from "node:path";
import { generateKeyPairSigner, getSignatureFromTransaction } from "@solana/kit";
import type { SignedTransaction } from "@tetsuo-ai/marketplace-sdk";
import { afterEach, expect, it } from "vitest";
import type { WalletState } from "../src/store.js";
import { confirmPayout, REVIEW_ALLOWANCE, SOL, startWorld, type World } from "./harness.js";

let w: World;
afterEach(async () => { await w?.wallet.close(); });

/**
 * A network that loses broadcasts. Like a real cluster, an unseen signature is
 * "pending" until the block height passes its last valid height. `expire()`
 * is that moment: the local chain replaces the blockhash, so the saved bytes
 * are refused for good, and its own proof of that becomes available.
 */
function lossyWorld(options: Parameters<typeof startWorld>[0] = {}) {
  const net = { drop: false, expired: false, rpcDown: false, sends: 0, lost: [] as SignedTransaction[],
    deliver: async (_tx: SignedTransaction): Promise<unknown> => undefined, expire() {} };
  const start = async () => {
    const world = await startWorld({ ...options,
      transport: base => {
        net.deliver = tx => base.sendAndConfirm(tx);
        return { ...base, sendAndConfirm(tx) {
          if (net.drop) { net.sends++; net.lost.push(tx); throw new Error("Connection lost before reply"); }
          return base.sendAndConfirm(tx);
        } };
      },
      chain: base => {
        const proven = async (receipt: Parameters<NonNullable<typeof base.sendNeverLands>>[0]) => {
          if (net.rpcDown) throw new Error("fetch failed");
          return net.expired && await base.sendNeverLands!(receipt);
        };
        return { ...base,
          operationBlockhashValid: async hash => !net.expired && base.operationBlockhashValid!(hash),
          reviewSendOutcome: async receipt => {
            const seen = await base.reviewSendOutcome!(receipt);
            return seen === "expired" && !net.expired ? "pending" : seen;
          },
          sendNeverLands: proven,
          // The real chain's rule for an approved funding decision.
          listingSendOutcome: async receipt => {
            const seen = await base.listingSendOutcome!(receipt);
            if (seen !== "failed" || !(receipt.operation?.kind === "funding" && receipt.operation.decision)) return seen;
            return await proven(receipt).catch(() => false) ? "failed" : "pending";
          } };
      },
    });
    net.expire = () => { net.expired = true; world.sandbox.market.expireBlockhash(); };
    return world;
  };
  return { net, start };
}

const state = () => JSON.parse(readFileSync(path.join(w.dataDir, "state.json"), "utf8")) as WalletState;
const withdrawal = (to: string) => ({ kind: "withdraw", to, amount: { lamports: String(SOL) } }) as const;

it("holds the payer while a dropped withdrawal could still land, then fails it on proof and lets a new one through", async () => {
  const { net, start } = lossyWorld();
  w = await start();
  const target = (await generateKeyPairSigner()).address;
  const before = await w.balance(w.wallet.mainAddress);
  const q = await w.wallet.quoteTransfer(withdrawal(target));
  net.drop = true;
  const pending = await w.wallet.confirmTransfer(q.id);
  expect(pending).toMatchObject({ state: "pending", canRetry: true });

  // Not expired yet: it stays pending, also when asked again, and blocks the payer.
  expect((await w.wallet.operationOutcome(q.id))?.state).toBe("pending");
  await expect(w.wallet.quoteTransfer(withdrawal(target))).rejects.toThrow(/awaiting confirmation/);
  expect((await w.wallet.confirmTransfer(q.id)).state).toBe("pending");
  // The retry sent the same signed bytes, never a new signature.
  expect(net.sends).toBe(2);
  expect(net.lost.map(tx => getSignatureFromTransaction(tx))).toEqual([pending.signature, pending.signature]);

  net.drop = false;
  net.expire();
  // The saved bytes really are dead: the chain refuses them, and nothing moved.
  await expect(net.deliver(net.lost[0]!)).rejects.toThrow();
  expect(await w.balance(target)).toBe(0n);
  expect(await w.balance(w.wallet.mainAddress)).toBe(before);

  await w.wallet.close();
  w.wallet = await w.reopen();
  const settled = await w.wallet.confirmTransfer(q.id);
  expect(settled).toMatchObject({ state: "failed", signature: pending.signature });
  expect(net.sends).toBe(2);
  expect(await w.wallet.pendingTransfers()).toEqual([]);
  // The failed operation is final: confirming it again signs nothing.
  expect((await w.wallet.confirmTransfer(q.id)).state).toBe("failed");
  expect(await w.balance(target)).toBe(0n);

  const again = await w.wallet.quoteTransfer(withdrawal(target));
  expect(again.id).not.toBe(q.id);
  const paid = await w.wallet.confirmTransfer(again.id);
  expect(paid.state).toBe("confirmed");
  expect(paid.signature).not.toBe(pending.signature);
  // Paid exactly once.
  expect(await w.balance(target)).toBe(SOL);
});

it("stays pending when the proof of expiry cannot be had, across a restart", async () => {
  const { net, start } = lossyWorld();
  w = await start();
  const target = (await generateKeyPairSigner()).address;
  const q = await w.wallet.quoteTransfer(withdrawal(target));
  net.drop = true;
  await w.wallet.confirmTransfer(q.id);
  net.drop = false;
  net.expire();
  net.rpcDown = true;
  expect((await w.wallet.confirmTransfer(q.id)).state).toBe("pending");
  await w.wallet.close();
  w.wallet = await w.reopen();
  expect((await w.wallet.operationOutcome(q.id))?.state).toBe("pending");
  await expect(w.wallet.quoteTransfer(withdrawal(target))).rejects.toThrow(/awaiting confirmation/);
  expect(net.sends).toBe(1);
  net.rpcDown = false;
  expect((await w.wallet.operationOutcome(q.id))?.state).toBe("failed");
  expect((await w.wallet.confirmTransfer((await w.wallet.quoteTransfer(withdrawal(target))).id)).state).toBe("confirmed");
  expect(await w.balance(target)).toBe(SOL);
});

it("does not fail an operation on a missing signature alone", async () => {
  // The height has passed and no status is found, but the chain cannot prove
  // the bytes are dead (a node without history, or one that lags).
  let lost = false;
  w = await startWorld({
    transport: base => ({ ...base, sendAndConfirm(tx) {
      if (lost) throw new Error("Connection lost before reply");
      return base.sendAndConfirm(tx);
    } }),
    chain: base => ({ ...base, operationBlockhashValid: async () => false, reviewSendOutcome: async () => "expired",
      sendNeverLands: async () => false }),
  });
  const target = (await generateKeyPairSigner()).address;
  const q = await w.wallet.quoteTransfer(withdrawal(target));
  lost = true;
  expect((await w.wallet.confirmTransfer(q.id)).state).toBe("pending");
  w.clock.now += 7 * 86_400_000;
  for (let n = 0; n < 3; n++) await w.wallet.tick();
  expect((await w.wallet.operationOutcome(q.id))?.state).toBe("pending");
  await expect(w.wallet.quoteTransfer(withdrawal(target))).rejects.toThrow(/awaiting confirmation/);
});

it("settles a transfer that landed late as done, never failed, and never pays it again", async () => {
  const { net, start } = lossyWorld();
  w = await start();
  const target = (await generateKeyPairSigner()).address;
  const q = await w.wallet.quoteTransfer(withdrawal(target));
  net.drop = true;
  const pending = await w.wallet.confirmTransfer(q.id);
  expect(pending.state).toBe("pending");
  net.drop = false;
  // The lost broadcast reaches the chain after all, just before its blockhash expires.
  await net.deliver(net.lost[0]!);
  expect(await w.balance(target)).toBe(SOL);
  net.expire();
  await w.wallet.close();
  w.wallet = await w.reopen();
  expect((await w.wallet.operationOutcome(q.id))?.state).toBe("confirmed");
  const settled = await w.wallet.confirmTransfer(q.id);
  expect(settled).toMatchObject({ state: "confirmed", signature: pending.signature });
  await w.wallet.confirmTransfer(q.id);
  expect(await w.balance(target)).toBe(SOL);
  expect(net.sends).toBe(1);
  expect((await w.wallet.listActivity()).filter(row => row.signature === pending.signature)).toHaveLength(1);
});

it("releases a dropped rating and its agent allowance, and rates the hire once with a new quote", async () => {
  const { net, start } = lossyWorld();
  w = await start();
  const { wallet, sandbox } = w;
  const agent = await wallet.createAgent("Reader");
  await wallet.setPolicy(agent.id, { askAboveCents: 100, refill: REVIEW_ALLOWANCE });
  await wallet.fundAgent(agent.id, { usdCents: 300 });
  const hire = await wallet.hire({ agentId: agent.id, listing: w.listing, request: "One poem." });
  expect(hire.approval).toBeNull();
  await sandbox.workOnce();
  await confirmPayout(wallet, hire.job.id);
  const spends = () => state().agents[agent.id]!.jobSpends ?? [];
  const stars = await wallet.quoteRating(hire.job.id, 5, true);
  const held = await w.balance(agent.address);
  net.drop = true;
  await expect(wallet.rateJob(hire.job.id, 5, true, undefined, stars.id)).rejects.toThrow(/pending/);
  // The rating's cost is reserved in the agent's day while it could still land.
  expect(spends().some(row => row.id === stars.id)).toBe(true);
  const reclaim = { kind: "reclaim", agentId: agent.id, amount: { lamports: "1000000" } } as const;
  await expect(wallet.quoteTransfer(reclaim)).rejects.toThrow(/awaiting confirmation/);

  net.drop = false;
  net.expire();
  w.clock.now += 10 * 60_000;
  // Any later operation of the payer settles the dead one first.
  const q = await wallet.quoteTransfer(reclaim);
  expect((await wallet.operationOutcome(stars.id))?.state).toBe("failed");
  expect(spends().some(row => row.id === stars.id)).toBe(false);
  expect((await wallet.confirmTransfer(q.id)).state).toBe("confirmed");
  // The dead quote cannot be used again; a new one rates the hire once.
  await expect(wallet.rateJob(hire.job.id, 5, true, undefined, stars.id)).rejects.toThrow();
  expect((await wallet.getJob(hire.job.id, true)).rating).toBeNull();
  const fresh = await wallet.quoteRating(hire.job.id, 4, true);
  expect((await wallet.rateJob(hire.job.id, 4, true, undefined, fresh.id)).rating).toBe(4);
  expect(spends().filter(row => row.id === fresh.id)).toHaveLength(1);
  expect(held - await w.balance(agent.address)).toBe(1_000_000n + BigInt(q.fee.lamports) + BigInt(fresh.maximumDebit.lamports));
  expect(net.sends).toBe(1);
});

it("does not top an agent up twice while a dropped top-up could still land, and tops it up once after proof", async () => {
  const { net, start } = lossyWorld();
  w = await start();
  const { wallet } = w;
  const agent = await wallet.createAgent("Buyer");
  net.drop = true;
  // Setting a budget hands the allowance over at once; that one broadcast is lost.
  await wallet.setBudget(agent.id, 500);
  expect(net.sends).toBe(1);
  expect(state().agents[agent.id]!.refills).toHaveLength(1);
  net.drop = false;
  w.clock.now += 5 * 60_000;
  for (let n = 0; n < 3; n++) await wallet.tick();
  // Still pending: no second top-up was signed, and the owner's transfers wait.
  expect(await w.balance(agent.address)).toBe(0n);
  expect(state().agents[agent.id]!.refills).toHaveLength(1);
  const target = (await generateKeyPairSigner()).address;
  await expect(wallet.quoteTransfer(withdrawal(target))).rejects.toThrow(/awaiting confirmation/);

  net.expire();
  await wallet.close();
  w.wallet = await w.reopen();
  for (let n = 0; n < 3; n++) await w.wallet.tick();
  const topped = await w.balance(agent.address);
  expect(topped).toBeGreaterThan(0n);
  // One top-up, and one charge in the day: the dropped one's reservation is gone.
  const charges = state().agents[agent.id]!.refills;
  expect(charges).toHaveLength(1);
  expect(charges[0]!.signature).toBeDefined();
  expect(state().agents[agent.id]!.earn.pendingListingSends ?? []).toEqual([]);
  for (let n = 0; n < 3; n++) await w.wallet.tick();
  expect(await w.balance(agent.address)).toBe(topped);
  expect((await w.wallet.confirmTransfer((await w.wallet.quoteTransfer(withdrawal(target))).id)).state).toBe("confirmed");
  expect(net.sends).toBe(1);
});

it("counts a top-up that landed late once: no second top-up and its charge stays in the day", async () => {
  const { net, start } = lossyWorld();
  w = await start();
  const { wallet } = w;
  const agent = await wallet.createAgent("Buyer");
  net.drop = true;
  await wallet.setBudget(agent.id, 500);
  net.drop = false;
  await net.deliver(net.lost[0]!);
  const topped = await w.balance(agent.address);
  expect(topped).toBeGreaterThan(0n);
  net.expire();
  for (let n = 0; n < 3; n++) await wallet.tick();
  expect(await w.balance(agent.address)).toBe(topped);
  const charges = state().agents[agent.id]!.refills;
  expect(charges).toHaveLength(1);
  const target = (await generateKeyPairSigner()).address;
  expect((await wallet.confirmTransfer((await wallet.quoteTransfer(withdrawal(target))).id)).state).toBe("confirmed");
  expect(Object.values(state().moneyOperations ?? {}).filter(op => op.state !== "confirmed")).toEqual([]);
  expect(state().agents[agent.id]!.refills).toHaveLength(1);
  expect(state().agents[agent.id]!.earn.pendingListingSends ?? []).toEqual([]);
  for (let n = 0; n < 3; n++) await wallet.tick();
  expect(await w.balance(agent.address)).toBe(topped);
});

it("closes a dropped funding decision as not funded only on proof, and frees the main balance", async () => {
  const { net, start } = lossyWorld({
    earn: { executor: { argv: [process.execPath, "-e", "process.stdout.write('done')", "{prompt}"],
      mode: "sandboxed", envAllowlist: [], timeoutMs: 10000 } },
  });
  w = await start();
  const { wallet } = w;
  const seller = await wallet.createAgent("Seller");
  const offer = { name: "Index", summary: "Make an index", price: { usdCents: 15 }, setupId: "seller-index" };
  const quote = await wallet.quoteEarn(seller.id, offer);
  const main = await w.balance(wallet.mainAddress);
  net.drop = true;
  await expect(wallet.setOffer(seller.id, offer, undefined, quote.quoteId)).rejects.toThrow();
  net.drop = false;
  expect(wallet.sellerOperation(seller.id, quote.quoteId)?.state).toBe("pending");
  const target = (await generateKeyPairSigner()).address;
  await expect(wallet.quoteTransfer(withdrawal(target))).rejects.toThrow(/awaiting confirmation/);
  for (let n = 0; n < 3; n++) await wallet.tick();
  expect(wallet.sellerOperation(seller.id, quote.quoteId)?.state).toBe("pending");

  net.expire();
  await wallet.close();
  w.wallet = await w.reopen();
  expect((await w.wallet.confirmTransfer((await w.wallet.quoteTransfer(withdrawal(target))).id)).state).toBe("confirmed");
  expect(w.wallet.sellerOperation(seller.id, quote.quoteId)?.state).toBe("failed");
  expect(await w.balance(seller.address)).toBe(0n);
  expect(main - await w.balance(w.wallet.mainAddress)).toBe(SOL + 5_000n);
  const entry = state().agents[seller.id]!;
  expect(entry.earn.pendingListingSends ?? []).toEqual([]);
  expect(entry.refills.filter(row => row.signature === undefined)).toEqual([]);
  expect(Object.values(state().moneyOperations ?? {}).filter(op => op.state === "pending")).toEqual([]);
});
