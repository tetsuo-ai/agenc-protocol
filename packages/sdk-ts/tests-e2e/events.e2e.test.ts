// REAL on-chain event decoding: drives the listing -> hire flow against the
// compiled agenc-coordination program in litesvm and decodes the Anchor
// events (ServiceListingHired + TaskCreated) straight from the transaction's
// log messages via parseAgencCoordinationEvents — proving the generated event
// codecs match what the real program actually emits.
import { describe, it, expect } from "vitest";
import { isNone } from "@solana/kit";
import { facade, findAgentPda, findTaskPda } from "../src/index.js";
import {
  decodeAgencEvent,
  parseAgencCoordinationEvents,
} from "../src/events/index.js";
import {
  freshSvm,
  seedProtocolConfig,
  seedModerationConfig,
  fundedSigner,
  send,
} from "./harness.js";

describe("e2e: event codecs decode real program logs", () => {
  it("decodes ServiceListingHired and TaskCreated from the hire transaction logs", async () => {
    const svm = freshSvm();

    const admin = await fundedSigner(svm);
    await seedProtocolConfig(svm, admin.address);

    const provider = await fundedSigner(svm);
    const buyer = await fundedSigner(svm);
    const moderator = await fundedSigner(svm);
    await seedModerationConfig(svm, admin.address, moderator.address, true);

    // 1) Register the provider (worker) and buyer (hiring) agents.
    const providerAgentId = new Uint8Array(32).fill(11);
    await send(svm, provider, [
      await facade.registerAgent({
        authority: provider,
        agentId: providerAgentId,
        capabilities: 1n,
        endpoint: "http://provider.test",
        metadataUri: null,
        stakeAmount: 0n,
      }),
    ]);
    const [providerAgent] = await findAgentPda({ agentId: providerAgentId });

    const buyerAgentId = new Uint8Array(32).fill(22);
    await send(svm, buyer, [
      await facade.registerAgent({
        authority: buyer,
        agentId: buyerAgentId,
        capabilities: 1n,
        endpoint: "http://buyer.test",
        metadataUri: null,
        stakeAmount: 0n,
      }),
    ]);
    const [buyerAgent] = await findAgentPda({ agentId: buyerAgentId });

    // 2) Provider creates a standing service listing.
    const listingId = new Uint8Array(32).fill(33);
    const listingSpecHash = new Uint8Array(32).fill(7);
    const price = 1_000_000n;
    await send(svm, provider, [
      await facade.createServiceListing({
        providerAgent,
        authority: provider,
        listingId,
        name: new Uint8Array(32).fill(1),
        category: new Uint8Array(32).fill(2),
        tags: new Uint8Array(64).fill(3),
        specHash: listingSpecHash,
        specUri: "agenc://job-spec/sha256/test",
        price,
        priceMint: null,
        requiredCapabilities: 1n,
        defaultDeadlineSecs: 3600n,
        maxOpenJobs: 0,
        operator: null,
        operatorFeeBps: 0,
      }),
    ]);
    const [listing] = await facade.findListingPda({ providerAgent, listingId });

    // 3) CLEAN listing moderation so the fail-closed hire gate passes.
    await send(svm, moderator, [
      await facade.recordListingModeration({
        moderator,
        listing,
        jobSpecHash: listingSpecHash,
        status: 0,
        riskScore: 0,
        categoryMask: 0n,
        policyHash: new Uint8Array(32).fill(9),
        scannerHash: new Uint8Array(32).fill(8),
        expiresAt: 0n,
      }),
    ]);

    // 4) Buyer hires from the listing — the one tx that emits BOTH
    //    TaskCreated (the minted task) and ServiceListingHired (the link).
    const taskId = new Uint8Array(32).fill(44);
    const hireResult = await send(svm, buyer, [
      await facade.hireFromListing({
        listing,
        providerAgent,
        creatorAgent: buyerAgent,
        authority: buyer,
        creator: buyer,
        taskId,
        expectedPrice: price,
        expectedVersion: 1n,
        listingSpecHash,
        moderator: moderator.address,
      }),
    ]);
    const [task] = await findTaskPda({ creator: buyer.address, taskId });

    // ---- REAL log assertions ----
    const logs = hireResult.logs();

    // Sanity: the Anchor `emit!` convention produced `Program data:` lines.
    const programDataLine = logs.find((line) => line.startsWith("Program data: "));
    console.log("sample event log line:", programDataLine);
    expect(programDataLine).toBeDefined();

    const events = parseAgencCoordinationEvents(logs);
    const names = events.map((event) => event.eventName);
    expect(names).toContain("TaskCreated");
    expect(names).toContain("ServiceListingHired");

    // decodeAgencEvent returns the FIRST decodable event from the same logs.
    expect(decodeAgencEvent(logs)?.eventName).toBe(names[0]);

    // TaskCreated: minted task fields match the hire inputs.
    const created = events.find((event) => event.eventName === "TaskCreated");
    expect(created).toBeDefined();
    if (created?.eventName !== "TaskCreated") throw new Error("unreachable");
    expect(new Uint8Array(created.data.taskId)).toEqual(taskId);
    expect(created.data.creator).toBe(buyer.address);
    expect(created.data.rewardAmount).toBe(price);
    expect(created.data.requiredCapabilities).toBe(1n);
    expect(isNone(created.data.rewardMint)).toBe(true); // SOL-priced listing

    // ServiceListingHired: links the source listing to the minted task.
    const hired = events.find((event) => event.eventName === "ServiceListingHired");
    expect(hired).toBeDefined();
    if (hired?.eventName !== "ServiceListingHired") throw new Error("unreachable");
    expect(hired.data.listing).toBe(listing);
    expect(hired.data.task).toBe(task);
    expect(hired.data.providerAgent).toBe(providerAgent);
    expect(hired.data.buyer).toBe(buyer.address);
    expect(hired.data.price).toBe(price);
    expect(hired.data.totalHires).toBe(1n);
    expect(hired.data.openJobs).toBe(1);
  });
});
