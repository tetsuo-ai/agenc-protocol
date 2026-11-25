// The buying side, end to end against the real program: an agent hires a
// service from its own allowance, a house provider delivers, the delivery is
// approved, rated and tidied. Money is checked at every step.
import { address } from "@solana/kit";
import { findClaimPda, findTaskSubmissionPda } from "@tetsuo-ai/marketplace-sdk";
import { readAgent, readListing, readProtocolConfig } from "../src/market.js";
import { afterEach, describe, expect, it } from "vitest";
import { confirmPayout, REVIEW_ALLOWANCE, CENT, CHECK_FEE, MARKER_SPACE, startWorld, type World } from "./harness.js";

let world: World | null = null;
afterEach(async () => {
  await world?.wallet.close();
  world = null;
});

describe("buying from an allowance", () => {
  it("hires, receives the delivery, pays, rates and tidies", async () => {
    world = await startWorld();
    const { wallet, sandbox, listing } = world;
    const agent = await wallet.createAgent("My assistant");
    await wallet.setPolicy(agent.id, {
      askAboveCents: 100,
      refill: REVIEW_ALLOWANCE,
    });
    await wallet.fundAgent(agent.id, { usdCents: 300 });
    const funded = await world.balance(agent.address);
    expect(funded).toBe(300n * CENT);

    const found = (await wallet.find({ query: "haiku" })).services;
    expect(found.map((service) => service.listing)).toEqual([listing]);
    expect(found[0]!.price).toEqual({ lamports: (20n * CENT).toString(), usdCents: 20 });

    const { job, approval } = await wallet.hire({
      agentId: agent.id,
      listing,
      request: "A haiku about a lighthouse.",
      acceptance: ["three lines"],
    });
    expect(approval).toBeNull();
    expect(job.status).toBe("waiting");
    expect(job.autoRefundAt).not.toBeNull();
    const afterHire = await world.balance(agent.address);
    expect(funded - afterHire).toBeGreaterThan(20n * CENT);

    expect(await sandbox.workOnce()).toBe(1);
    const delivered = await wallet.getJob(job.id, true);
    expect(delivered.status).toBe("delivered");
    expect(delivered.result?.verified).toBe(true);
    expect(delivered.result?.text).toContain("old pond");
    expect(delivered.result?.text).toContain("A haiku about a lighthouse.");
    expect(delivered.canApprove).toBe(true);

    const { providerAgent } = (await readListing(sandbox.chain, listing))!;
    const { authority } = (await readAgent(sandbox.chain, providerAgent))!;
    const { treasury } = await readProtocolConfig(sandbox.chain);
    const [claim] = await findClaimPda({ task: address(job.task!), bidder: providerAgent });
    const [submission] = await findTaskSubmissionPda({ claim });
    const sellerBefore = await world.balance(authority);
    const deposits = await world.balance(claim) + await world.balance(submission);
    const treasuryBefore = await world.balance(treasury);
    const split = job.terms!.hire!;
    const paid = await confirmPayout(wallet, job.id, 5);
    expect(await world.balance(authority) - sellerBefore - deposits).toBe(BigInt(split.minimumSellerNet.lamports));
    expect(await world.balance(treasury) - treasuryBefore).toBe(BigInt(split.maximumMarketplaceFee.lamports));
    expect(paid.status).toBe("paid");
    expect(paid.rating).toBe(5);

    await wallet.tick();
    const overview = await wallet.overview();
    const view = overview.agents[0]!;
    // The price and the five stars' debit (rt5 A 2: the stars count as spending on the job).
    const starsNote = (await wallet.listActivity()).find(entry => entry.jobId === job.id && entry.text.startsWith("Paid for the stars on"));
    expect(view.spent.lamports).toBe((20n * CENT + BigInt(starsNote!.amount!.lamports)).toString());
    expect(view.held.lamports).toBe("0");
    const final = await world.balance(agent.address);
    // Everything the buyer paid, to the lamport: the price, the marker its
    // tidied job record was compacted into (revision 9), the one-time
    // rate-limit record of a first hire, the rating's permanent record, five
    // transaction fees (hire, post, pay, rate, tidy), and the signatures of
    // the safety check of its request. Every other deposit came back, the
    // safety check's included.
    const rent = (space: number) => world!.sandbox.chain.getMinimumBalanceForRentExemption(space);
    expect(funded - final).toBe(
      20n * CENT +
        (await rent(MARKER_SPACE)) +
        (await rent(67)) +
        (await rent(439)) +
        5n * 5_000n +
        CHECK_FEE,
    );
    const [tidied] = await wallet.listJobs({ role: "buying" }, true);
    expect(tidied!.canRate).toBe(false);
    const kinds = (await wallet.listActivity()).map((entry) => entry.kind);
    expect(kinds).toEqual(expect.arrayContaining(["allowance", "hired", "paid", "tidied"]));
  });

  it("hands a drawing on as a file to open, not as a page of code", async () => {
    const drawings = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>',
      '<?xml version="1.0" encoding="UTF-8"?>\n<!-- made for you -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<SVG width="10" height="10"></SVG>',
      `${String.fromCharCode(0xfeff)}  <svg>\n</svg>`,
    ];
    const words = [
      "Here is your logo, described: a circle. I could not attach an <svg> this time.",
      "<p>A paragraph about svg files.</p>",
      "<?xml version=\"1.0\"?><note>not a drawing</note>",
      "<!-- only a comment",
    ];
    for (const delivery of [...drawings, ...words]) {
      world = await startWorld({
        services: (services) => ({
          ...services,
          fetchResult: async (input) => {
            const found = await services.fetchResult(input);
            return found === null
              ? null
              : { bytes: new TextEncoder().encode(delivery), uri: "https://deliveries.example/logo" };
          },
        }),
      });
      const { wallet, sandbox, listing } = world;
      const agent = await wallet.createAgent("My assistant");
      await wallet.setPolicy(agent.id, {
        askAboveCents: 100,
        refill: { enabled: false, topUpToCents: 0, perDayCents: 10000 },
      });
      await wallet.fundAgent(agent.id, { usdCents: 300 });
      const { job } = await wallet.hire({ agentId: agent.id, listing, request: "A logo." });
      await sandbox.workOnce();
      const result = (await wallet.getJob(job.id, true)).result;
      expect(result?.uri).toBe("https://deliveries.example/logo");
      expect(result?.text ?? null).toBe(drawings.includes(delivery) ? null : delivery);
      await wallet.close();
      world = null;
    }
  });

  it("hands a host nothing but a web address to open for a delivery", async () => {
    // A host opens a delivery's address for a person, and some openers treat
    // anything that is not a web address as a file on the computer. Whatever
    // a source of deliveries says the address is, only https leaves the wallet.
    for (const [claimed, kept] of [
      ["https://deliveries.example/a.txt", "https://deliveries.example/a.txt"],
      ["file:///etc/passwd", null],
      ["/usr/bin/true", null],
      ["\\\\host\\share\\run.exe", null],
      ["http://deliveries.example/a.txt", null],
      ["https://deliveries.example/a b", null],
      ["javascript:alert(1)", null],
    ] as const) {
      world = await startWorld({
        services: (services) => ({
          ...services,
          fetchResult: async (input) => {
            const found = await services.fetchResult(input);
            return found === null ? null : { ...found, uri: claimed };
          },
        }),
      });
      const { wallet, sandbox, listing } = world;
      const agent = await wallet.createAgent("My assistant");
      await wallet.setPolicy(agent.id, {
        askAboveCents: 100,
        refill: { enabled: false, topUpToCents: 0, perDayCents: 10000 },
      });
      await wallet.fundAgent(agent.id, { usdCents: 300 });
      const { job } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku." });
      await sandbox.workOnce();
      const delivered = await wallet.getJob(job.id, true);
      expect(delivered.status).toBe("delivered");
      // The words still arrive; only the address is held to a web address.
      expect(delivered.result?.text).toContain("old pond");
      expect(delivered.result?.uri ?? null).toBe(kept);
      await wallet.close();
      world = null;
    }
  });
});
