// A live service keeps the money it needs for its next job. The agent's own
// purchases may not spend it: a hire or post that would dip into it is paid
// from the main balance with the person's yes instead.
import type { Address } from "@solana/kit";
import { afterEach, describe, expect, it } from "vitest";
import { purchaseDeposits, requestDeposits } from "../src/market.js";
import { CENT, eventually, setEarnWithApproval, setOfferWithApproval, startWorld, type World } from "./harness.js";

const EARN = {
  executor: {
    argv: [process.execPath, "-e", "process.stdout.write('done')", "{prompt}"],
    mode: "sandboxed" as const,
    envAllowlist: [],
    timeoutMs: 30_000,
  },
  pollIntervalMs: 150,
};
const NO_REFILL = { enabled: false, topUpToCents: 0, perDayCents: 10_000 };
const SERVICE = { name: "Line Writer", summary: "One friendly line about anything you name.", price: { usdCents: 30 } };

let world: World | null = null;
afterEach(async () => {
  await world?.wallet.close();
  world = null;
});

/** A live seller whose own money is brought to just what a hire needs, without its job reserve. */
async function liveSellerJustCoveringAHire(kind: "hire" | "post" = "hire") {
  world = await startWorld({ earn: EARN });
  const { wallet, sandbox } = world;
  const seller = await wallet.createAgent("My assistant");
  await setEarnWithApproval(wallet, seller.id, true, 10);
  await setOfferWithApproval(wallet, seller.id, SERVICE);
  await eventually(async () => {
    await wallet.tick();
    const view = (await wallet.overview()).agents.find((agent) => agent.id === seller.id)!;
    return view.earn.offer?.status === "live" ? view : null;
  }, 30_000);
  await wallet.setPolicy(seller.id, { askAboveCents: 10_000, refill: NO_REFILL });
  await wallet.confirmTransfer((await wallet.quoteTransfer({ kind: "reclaim", agentId: seller.id, amount: "all" })).id);
  const left = await world.balance(seller.address);
  const deposits = await (kind === "hire" ? purchaseDeposits : requestDeposits)(sandbox.chain, seller.address as Address);
  const floor = await sandbox.chain.getMinimumBalanceForRentExemption(0);
  const price = 20n * CENT; // the house Haiku Writer, or a 20 cent reward
  const enough = price + deposits.total + floor;
  sandbox.fund(seller.address as Address, enough - left + 1_000n);
  return { wallet, seller, enough };
}

describe("a live service keeps its job money", () => {
  it("pays a hire from the main balance, with the person's yes, when the agent's money is its service's reserve", async () => {
    const { wallet, seller } = await liveSellerJustCoveringAHire();
    const main = await world!.balance(wallet.mainAddress);
    const { job, approval } = await wallet.hire({ agentId: seller.id, listing: world!.listing, request: "A poem about tea." });
    // Before: the agent paid from its own money with no question and its service could no longer take a job.
    expect(approval).not.toBeNull();
    expect(BigInt(approval!.fromMain!.lamports)).toBeGreaterThan(20n * CENT);
    expect(job.status).toBe("needs_approval");
    expect(await world!.balance(wallet.mainAddress)).toBe(main);
  }, 90_000);

  it("lets the agent pay itself once it holds the reserve too", async () => {
    const { wallet, seller } = await liveSellerJustCoveringAHire();
    world!.sandbox.fund(seller.address as Address, 1_000_000_000n);
    const { approval } = await wallet.hire({ agentId: seller.id, listing: world!.listing, request: "A poem about tea." });
    expect(approval === null || approval.fromMain?.lamports === "0").toBe(true);
  }, 90_000);

  it("pays a post from the main balance too", async () => {
    const { wallet, seller } = await liveSellerJustCoveringAHire("post");
    const { job, approval } = await wallet.post({ agentId: seller.id, request: "Write a line about rain.", reward: { usdCents: 20 } });
    expect(approval).not.toBeNull();
    expect(BigInt(approval!.fromMain!.lamports)).toBeGreaterThan(0n);
    expect(job.status).toBe("needs_approval");
  }, 90_000);

  it("refuses a yes for the agent's own money once its service went live, and says why", async () => {
    world = await startWorld({ earn: EARN });
    const { wallet, sandbox } = world;
    const seller = await wallet.createAgent("My assistant");
    await wallet.setPolicy(seller.id, { askAboveCents: 1, refill: NO_REFILL });
    const deposits = await purchaseDeposits(sandbox.chain, seller.address as Address);
    const floor = await sandbox.chain.getMinimumBalanceForRentExemption(0);
    sandbox.fund(seller.address as Address, 20n * CENT + deposits.total + floor + 1_000n);
    const { approval } = await wallet.hire({ agentId: seller.id, listing: world.listing, request: "A poem about tea." });
    expect(approval!.fromMain!.lamports).toBe("0");
    await setEarnWithApproval(wallet, seller.id, true, 10);
    await setOfferWithApproval(wallet, seller.id, SERVICE);
    await eventually(async () => {
      await wallet.tick();
      const view = (await wallet.overview()).agents.find((agent) => agent.id === seller.id)!;
      return view.earn.offer?.status === "live" ? view : null;
    }, 30_000);
    await wallet.confirmTransfer((await wallet.quoteTransfer({ kind: "reclaim", agentId: seller.id, amount: "all" })).id);
    const left = await world.balance(seller.address);
    sandbox.fund(seller.address as Address, 20n * CENT + deposits.total + floor - left + 1_000n);
    await expect(wallet.decideApproval(approval!.id, true)).rejects.toMatchObject({
      code: "NOT_ENOUGH_MONEY",
      message: expect.stringContaining("leave its service on offer unable to take jobs"),
    });
  }, 90_000);
});

describe("a live service that cannot fund a hire", () => {
  it("says which service and how much, tells the buyer, and starts the job once the money is there", async () => {
    world = await startWorld({ earn: EARN });
    const { wallet, sandbox } = world;
    const seller = await wallet.createAgent("Seller");
    const buyer = await wallet.createAgent("Buyer");
    await wallet.fundAgent(buyer.id, { usdCents: 500 });
    await wallet.setPolicy(buyer.id, { askAboveCents: 100, refill: NO_REFILL });
    await setEarnWithApproval(wallet, seller.id, true, 10);
    await setOfferWithApproval(wallet, seller.id, SERVICE);
    const live = await eventually(async () => {
      await wallet.tick();
      const view = (await wallet.overview()).agents.find((agent) => agent.id === seller.id)!;
      return view.earn.offer?.status === "live" ? view : null;
    }, 30_000);
    await wallet.setPolicy(seller.id, { askAboveCents: 100, refill: NO_REFILL });
    // The person takes the seller's money back: its next hire cannot be funded.
    await wallet.confirmTransfer((await wallet.quoteTransfer({ kind: "reclaim", agentId: seller.id, amount: "all" })).id);
    const { job } = await wallet.hire({ agentId: buyer.id, listing: live.earn.offer!.listing!, request: "A line about tea." });
    const short = await eventually(async () => {
      await wallet.tick();
      const view = (await wallet.overview()).agents.find((agent) => agent.id === seller.id)!;
      return view.earn.needsMoney ? view : null;
    }, 30_000);
    const needs = short.earn.needsMoney!;
    expect(needs.service).toBe(SERVICE.name);
    expect(BigInt(needs.amount.lamports)).toBeGreaterThan(0n);
    expect(needs.text).toContain("Line Writer cannot take jobs: Seller needs $");
    const waiting = await wallet.getJob(job.id, true);
    expect(waiting.status).toBe("waiting");
    expect(waiting.statusText).toContain("The provider cannot start this job yet");
    expect(waiting.statusText).toContain("You can cancel it now in Jobs");
    // Exactly the amount Market names is enough; Earns is never switched off and on.
    sandbox.fund(seller.address as Address, BigInt(needs.amount.lamports));
    const delivered = await eventually(async () => {
      await wallet.tick();
      const view = await wallet.getJob(job.id, true);
      return view.status === "delivered" ? view : null;
    }, 30_000);
    expect(delivered.status).toBe("delivered");
    const after = (await wallet.overview()).agents.find((agent) => agent.id === seller.id)!;
    expect(after.earn.needsMoney ?? null).toBeNull();
  }, 90_000);
});
