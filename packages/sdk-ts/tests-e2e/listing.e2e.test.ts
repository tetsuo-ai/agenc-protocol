import { describe, it, expect } from "vitest";
import {
  facade,
  findAgentPda,
  getServiceListingDecoder,
} from "../src/index.js";
import { freshSvm, seedProtocolConfig, fundedSigner, send, accountData } from "./harness.js";

// REAL on-chain execution: register a provider agent, then create a service listing under
// it, and verify the resulting ServiceListing account on-chain via the SDK decoder.
describe("e2e: createServiceListing executes on the real program", () => {
  it("registers an agent and creates an on-chain ServiceListing via the SDK facade", async () => {
    const svm = freshSvm();
    const admin = await fundedSigner(svm);
    await seedProtocolConfig(svm, admin.address);

    const provider = await fundedSigner(svm);
    const agentId = new Uint8Array(32).fill(3);

    await send(svm, provider, [
      await facade.registerAgent({
        authority: provider,
        agentId,
        capabilities: 1n,
        endpoint: "http://provider.test",
        metadataUri: null,
        stakeAmount: 0n,
      }),
    ]);
    const [providerAgent] = await findAgentPda({ agentId });

    const listingId = new Uint8Array(32).fill(4);
    const ix = await facade.createServiceListing({
      providerAgent,
      authority: provider,
      listingId,
      name: new Uint8Array(32).fill(1),
      category: new Uint8Array(32).fill(2),
      tags: new Uint8Array(64).fill(3),
      specHash: new Uint8Array(32).fill(7),
      specUri: "agenc://job-spec/sha256/test",
      price: 1_000_000n,
      priceMint: null,
      requiredCapabilities: 1n,
      defaultDeadlineSecs: 3600n,
      maxOpenJobs: 0,
      operator: null,
      operatorFeeBps: 0,
    });
    await send(svm, provider, [ix]);

    const [listing] = await facade.findListingPda({ providerAgent, listingId });
    const data = accountData(svm, listing);
    expect(data).not.toBeNull();

    const decoded = getServiceListingDecoder().decode(data!);
    expect(decoded.providerAgent).toBe(providerAgent);
    expect(decoded.authority).toBe(provider.address);
    expect(decoded.price).toBe(1_000_000n);
  });
});
