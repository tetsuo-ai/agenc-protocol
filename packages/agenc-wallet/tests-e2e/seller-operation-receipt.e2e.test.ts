// Item 3: one seller decision carries the network and the funded amount, and
// A's receipt and C's setup record are written in the same journal commit.
import { afterEach, expect, it } from "vitest";
import { startWorld, type World } from "./harness.js";

let world: World;
afterEach(async () => { await world?.wallet.close(); });

it("records the network, the actual funded amount and the funding signature once, across a restart", async () => {
  const earn = { executor: { argv: [process.execPath, "-e", "process.stdout.write('ok')", "{prompt}"],
    mode: "sandboxed" as const, envAllowlist: [], timeoutMs: 10000 }, pollIntervalMs: 50 };
  world = await startWorld({ earn });
  const seller = await world.wallet.createAgent();
  const input = { setupId: "receipt-setup", enableEarns: true as const, name: "Receipt", summary: "Write a line.", price: { lamports: "3000000" } };
  const quote = await world.wallet.quoteEarn(seller.id, input);
  const [mainBefore, agentBefore] = [await world.balance(world.wallet.mainAddress), await world.balance(seller.address)];
  await world.wallet.setOffer(seller.id, input, undefined, quote.quoteId);
  const mainDebit = mainBefore - await world.balance(world.wallet.mainAddress);
  const agentGain = await world.balance(seller.address) - agentBefore;
  await world.wallet.close(); world.wallet = await world.reopen();
  const operation = world.wallet.sellerOperation(seller.id, quote.quoteId)!;
  const setup = world.wallet.sellerSetup(seller.id, input.setupId)!;
  const fee = world.sandbox.chain.transferFeeLamports;
  expect(operation).toMatchObject({ network: "sandbox", quoteId: quote.quoteId, state: "confirmed", seller: seller.address });
  expect(BigInt(operation.fundedLamports)).toBeGreaterThan(0n);
  // The funded amount is the actual debit less the network fee, as the agent received it.
  expect(BigInt(operation.fundedLamports)).toBe(mainDebit - fee);
  expect(operation.fundedLamports).toBe(quote.fromMain.lamports);
  expect(operation.fundingSignature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
  expect(setup).toMatchObject({ quoteId: quote.quoteId, fundedLamports: operation.fundedLamports, signature: operation.fundingSignature });
  expect(agentGain).toBeLessThanOrEqual(BigInt(operation.fundedLamports));
  // A replay of the same confirmation spends nothing and keeps the same receipt.
  const mainNow = await world.balance(world.wallet.mainAddress);
  await world.wallet.setOffer(seller.id, input, undefined, quote.quoteId).catch(() => null);
  expect(await world.balance(world.wallet.mainAddress)).toBe(mainNow);
  expect(world.wallet.sellerOperation(seller.id, quote.quoteId)).toEqual(operation);
}, 60000);
