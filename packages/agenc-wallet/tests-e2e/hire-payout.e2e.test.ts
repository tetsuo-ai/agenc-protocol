import { afterEach, expect, it } from "vitest";
import { type Address } from "@solana/kit";
import { getServiceListingDecoder, getServiceListingEncoder } from "@tetsuo-ai/marketplace-sdk";
import { startWorld, type World } from "./harness.js";

let world: World;
afterEach(async () => { await world?.wallet.close(); });

function setListingOperator(operator: Address, bps: number) {
  const { listing, sandbox } = world;
  const raw = sandbox.market.svm.getAccount(listing);
  if (!raw.exists) throw new Error("Missing fixture listing");
  const previous = getServiceListingDecoder().decode(raw.data);
  const next = { ...previous, operator, operatorFeeBps: bps, version: previous.version + 1n };
  sandbox.market.svm.setAccount({ ...raw, data: Uint8Array.from(getServiceListingEncoder().encode(next)) });
  return next;
}

it("requires fresh approval on a same-price operator change below the allowance", async () => {
  world = await startWorld();
  const { wallet, listing } = world;
  const buyer = await wallet.createAgent("Buyer");
  const first = await wallet.createAgent("First operator");
  const second = await wallet.createAgent("Second operator");
  await wallet.fundAgent(buyer.id, { usdCents: 500 });
  await wallet.setBudget(buyer.id, 1000);
  setListingOperator(first.address as Address, 125);
  const pending = await wallet.hire({ agentId: buyer.id, listing, request: "Edit a line." });
  const quote = pending.approval!;
  expect(quote.terms?.hire?.operator).toBe(first.address);
  const before = await world.balance(buyer.address);
  const changed = setListingOperator(second.address as Address, 125);
  await expect(wallet.decideApproval(quote.id, true)).rejects.toMatchObject({ code: "PRICE_CHANGED" });
  expect(await world.balance(buyer.address)).toBe(before);
  const fresh = (await wallet.refreshApproval(quote.id)).approval;
  expect(fresh.id).not.toBe(quote.id);
  expect(fresh.terms?.hire).toMatchObject({ operator: second.address, listingVersion: String(changed.version),
    operatorFeeBps: 125, price: quote.price, minimumSellerNet: quote.terms!.hire!.minimumSellerNet });
  await expect(wallet.decideApproval(quote.id, true)).rejects.toThrow();
  expect((await wallet.decideApproval(fresh.id, true)).status).toBe("waiting");
});

it("revision 9 rejects a signed hire when the seller updates the listing before execution", async () => {
  let nextOperator: Address | undefined;
  world = await startWorld({ transport: base => ({ ...base, async sendAndConfirm(tx) {
    if (nextOperator) {
      setListingOperator(nextOperator, 75);
      nextOperator = undefined;
    }
    return base.sendAndConfirm(tx);
  } }) });
  const { wallet, listing, sandbox } = world;
  const buyer = await wallet.createAgent("Buyer");
  const operator = await wallet.createAgent("New operator");
  const quote = (await wallet.hire({ agentId: buyer.id, listing, request: "Edit a line." }, true)).approval!;
  const before = await world.balance(operator.address);
  nextOperator = operator.address as Address;
  const outcome = await wallet.decideApproval(quote.id, true);
  expect(nextOperator).toBeUndefined();
  expect(outcome.status).toBe("failed");
  expect(await sandbox.chain.readAccount(outcome.task as Address)).toBeNull();
  const raw = sandbox.market.svm.getAccount(listing);
  if (!raw.exists) throw new Error("Missing fixture listing");
  expect(getServiceListingDecoder().decode(raw.data).openJobs).toBe(0);
  expect(await world.balance(operator.address)).toBe(before);
});
