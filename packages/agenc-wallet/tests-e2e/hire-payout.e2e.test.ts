import { afterEach, expect, it } from "vitest";
import { getCompiledTransactionMessageDecoder, type Address } from "@solana/kit";
import { findProtocolConfigPda, findTaskJobSpecPda, getSetTaskJobSpecDiscriminatorBytes, getProtocolConfigDecoder, getProtocolConfigEncoder, getServiceListingDecoder, getServiceListingEncoder } from "@tetsuo-ai/marketplace-sdk";
import { eventually, startWorld, type World } from "./harness.js";

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

it.each(["protocol fee", "rent", "unrelated counter"])("binds the quote across a signed hire and a change to %s", async field => {
  let change: (() => void) | undefined;
  world = await startWorld({ transport: base => ({ ...base, async sendAndConfirm(signed) {
    if (change) { change(); change = undefined; }
    return base.sendAndConfirm(signed);
  } }) });
  const { wallet, listing, sandbox } = world;
  const buyer = await wallet.createAgent("Buyer");
  const operator = await wallet.createAgent("Operator");
  setListingOperator(operator.address as Address, 125);
  const quote = (await wallet.hire({ agentId: buyer.id, listing, request: "Edit a line." }, true)).approval!;
  const [config] = await findProtocolConfigPda();
  const svm = sandbox.market.svm;
  const configAccount = svm.getAccount(config);
  if (!configAccount.exists) throw new Error("Missing fixture config");
  const configData = getProtocolConfigDecoder().decode(configAccount.data);
  change = () => {
    if (field === "rent") {
      const rent = svm.getRent();
      rent.lamportsPerByteYear += 1n;
      svm.setRent(rent);
    } else {
      const updated = field === "protocol fee" ? { protocolFeeBps: configData.protocolFeeBps + 1 } : { totalTasks: configData.totalTasks + 1n };
      svm.setAccount({ ...configAccount, data: Uint8Array.from(getProtocolConfigEncoder().encode({ ...configData, ...updated })) });
    }
  };
  const before = await world.balance(wallet.mainAddress);
  const outcome = await wallet.decideApproval(quote.id, true);
  expect(change).toBeUndefined();
  if (field === "unrelated counter") {
    expect(outcome.status).toBe("waiting");
    expect(outcome.terms?.hire).toEqual(quote.terms?.hire);
    return;
  }
  expect(outcome.status).toBe("failed");
  expect(outcome.error).toMatch(/fresh quote.*network fee/i);
  expect(await world.balance(wallet.mainAddress)).toBe(before - 5000n);
  expect(await sandbox.chain.readAccount(outcome.task as Address)).toBeNull();
  const raw = svm.getAccount(listing);
  if (!raw.exists) throw new Error("Missing fixture listing");
  expect(getServiceListingDecoder().decode(raw.data).openJobs).toBe(0);
  expect(await world.balance(operator.address)).toBe(0n);
});

it.each(["moderation record", "job spec"] as const)("never pays a later %s above the approved rent and refunds the hire", async stage => {
  let bump: "after hire" | "at activation" | null = null;
  let sends = 0;
  const activation = Buffer.from(getSetTaskJobSpecDiscriminatorBytes());
  world = await startWorld({ transport: base => ({ ...base, async sendAndConfirm(signed) {
    const message = getCompiledTransactionMessageDecoder().decode(signed.messageBytes);
    const activates = ("instructions" in message ? message.instructions : []).some(ix => Buffer.from(ix.data ?? []).subarray(0, 8).equals(activation));
    // Signed with the old rate, landing at the new one.
    if (bump === "at activation" && activates) raiseRent();
    const result = await base.sendAndConfirm(signed);
    if (bump === "after hire" && ++sends === 1) raiseRent();
    return result;
  } }) });
  const { wallet, listing, sandbox } = world;
  const svm = sandbox.market.svm;
  const raiseRent = () => {
    bump = null;
    const rent = svm.getRent();
    rent.lamportsPerByteYear += 1n;
    svm.setRent(rent);
  };
  const buyer = await wallet.createAgent("Buyer");
  await wallet.fundAgent(buyer.id, { usdCents: 500 });
  const quote = (await wallet.hire({ agentId: buyer.id, listing, request: "Edit a line." }, true)).approval!;
  const funds = async () => await world.balance(wallet.mainAddress) + await world.balance(buyer.address);
  const before = await funds();
  bump = stage === "moderation record" ? "after hire" : "at activation";
  const outcome = await wallet.decideApproval(quote.id, true);
  const job = await eventually(async () => {
    await wallet.tick();
    const current = await wallet.getJob(outcome.id, true);
    return current.error && /deposits rose/.test(current.error) ? current : null;
  });
  expect(bump).toBeNull();
  const [spec] = await findTaskJobSpecPda({ task: job.task as Address });
  expect(svm.getAccount(spec).exists).toBe(false);
  expect(job.status).not.toBe("active");
  // Everything that left the buyer stays within the approved total, price included.
  const approvedTotal = BigInt(quote.price.lamports) + BigInt(quote.deposits.lamports);
  expect(before - await funds()).toBeLessThanOrEqual(approvedTotal);
}, 60_000);
