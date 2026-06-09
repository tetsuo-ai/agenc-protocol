import { describe, it, expect } from "vitest";
import {
  facade,
  findAgentPda,
  getAgentRegistrationDecoder,
} from "../src/index.js";
import { freshSvm, seedProtocolConfig, fundedSigner, send, accountData } from "./harness.js";

// REAL on-chain execution: build register_agent with the SDK, run it through the compiled
// program in litesvm with a real signature, then decode the resulting on-chain account
// with the SDK's own decoder.
describe("e2e: registerAgent executes on the real program", () => {
  it("creates an on-chain AgentRegistration via the SDK facade", async () => {
    const svm = freshSvm();
    const admin = await fundedSigner(svm);
    await seedProtocolConfig(svm, admin.address);

    const payer = await fundedSigner(svm);
    const agentId = new Uint8Array(32).fill(9);

    const ix = await facade.registerAgent({
      authority: payer,
      agentId,
      capabilities: 1n,
      endpoint: "http://agent.test",
      metadataUri: null,
      stakeAmount: 0n,
    });
    await send(svm, payer, [ix]);

    const [agentPda] = await findAgentPda({ agentId });
    const data = accountData(svm, agentPda);
    expect(data).not.toBeNull();

    const decoded = getAgentRegistrationDecoder().decode(data!);
    expect(decoded.authority).toBe(payer.address);
    expect(decoded.capabilities).toBe(1n);
    expect(decoded.endpoint).toBe("http://agent.test");
  });
});
