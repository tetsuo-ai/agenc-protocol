import { describe, it, expect } from "vitest";
import { address, createNoopSigner, some, none } from "@solana/kit";
import {
  getRegisterAgentInstruction,
  getRegisterAgentInstructionDataDecoder,
  getUpdateAgentInstructionDataDecoder,
  getDeregisterAgentInstructionDataDecoder,
  getSuspendAgentInstructionDataDecoder,
  getUnsuspendAgentInstructionDataDecoder,
  AGENC_COORDINATION_PROGRAM_ADDRESS,
} from "../src/index.js";
import {
  updateAgent,
  deregisterAgent,
  suspendAgent,
  unsuspendAgent,
} from "../src/facade/agents.js";

// Structural test pattern (the template for the facade loop): build the instruction and
// assert program address, account order, and that the encoded data round-trips. Deterministic,
// no VM — validates the generated builder + (later) the facade wiring against the IDL.
describe("registerAgent (generated instruction)", () => {
  const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
  const agent = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
  const protocolConfig = address("So11111111111111111111111111111111111111112");
  const authority = createNoopSigner(
    address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  );

  it("assembles with the right program, account order, and round-trips its data", () => {
    const agentId = new Uint8Array(32).fill(7);
    const ix = getRegisterAgentInstruction({
      agent,
      protocolConfig,
      authority,
      agentId,
      capabilities: 1n,
      endpoint: "http://agent.test",
      metadataUri: null,
      stakeAmount: 0n,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      agent,
      protocolConfig,
      authority.address,
      SYSTEM_PROGRAM,
    ]);

    const decoded = getRegisterAgentInstructionDataDecoder().decode(ix.data);
    expect(decoded.capabilities).toBe(1n);
    expect(decoded.endpoint).toBe("http://agent.test");
    expect(Array.from(decoded.agentId)).toEqual(Array.from(agentId));
  });
});

describe("updateAgent (facade)", () => {
  const agent = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
  const authority = createNoopSigner(
    address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  );

  it("assembles with the right program, account order, and round-trips its data", () => {
    const ix = updateAgent({
      agent,
      authority,
      capabilities: 5n,
      endpoint: "http://agent.updated",
      status: 1,
      // metadataUri intentionally omitted -> should encode as `none`
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      agent,
      authority.address,
    ]);

    const decoded = getUpdateAgentInstructionDataDecoder().decode(ix.data);
    expect(decoded.capabilities).toEqual(some(5n));
    expect(decoded.endpoint).toEqual(some("http://agent.updated"));
    expect(decoded.status).toEqual(some(1));
    // omitted field is encoded as `none`
    expect(decoded.metadataUri).toEqual(none());
  });

  it("encodes every field as `none` when only the accounts are provided", () => {
    const ix = updateAgent({ agent, authority });
    const decoded = getUpdateAgentInstructionDataDecoder().decode(ix.data);
    expect(decoded.capabilities).toEqual(none());
    expect(decoded.endpoint).toEqual(none());
    expect(decoded.metadataUri).toEqual(none());
    expect(decoded.status).toEqual(none());
  });
});

describe("deregisterAgent (facade)", () => {
  const agent = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
  const authority = createNoopSigner(
    address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  );

  it("assembles with the right program, auto-derived protocolConfig, account order, and round-trips its data", async () => {
    const ix = await deregisterAgent({ agent, authority });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    // Accounts: agent, protocolConfig (auto-derived PDA), reputationStake (auto-derived
    // PDA — audit: stake must be withdrawn before deregister), authority.
    const addrs = ix.accounts.map((a) => a.address);
    expect(addrs).toHaveLength(4);
    expect(addrs[0]).toBe(agent);
    expect(addrs[3]).toBe(authority.address);
    // protocolConfig and reputationStake are derived PDAs distinct from the supplied accounts.
    expect(addrs[1]).not.toBe(agent);
    expect(addrs[1]).not.toBe(authority.address);
    expect(addrs[2]).not.toBe(agent);
    expect(addrs[2]).not.toBe(authority.address);
    expect(addrs[2]).not.toBe(addrs[1]);

    // Data is just the discriminator; it must round-trip through the decoder.
    const decoded = getDeregisterAgentInstructionDataDecoder().decode(ix.data);
    expect(decoded.discriminator).toBeDefined();
  });
});

describe("suspendAgent (facade)", () => {
  const agent = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
  const authority = createNoopSigner(
    address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  );

  it("assembles with the right program, auto-derived protocolConfig, account order, and round-trips its data", async () => {
    const ix = await suspendAgent({ agent, authority });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    // Accounts: agent, protocolConfig (auto-derived PDA), authority.
    const addrs = ix.accounts.map((a) => a.address);
    expect(addrs).toHaveLength(3);
    expect(addrs[0]).toBe(agent);
    expect(addrs[2]).toBe(authority.address);
    // protocolConfig is a derived PDA distinct from the supplied accounts.
    expect(addrs[1]).not.toBe(agent);
    expect(addrs[1]).not.toBe(authority.address);

    // Data is just the discriminator; it must round-trip through the decoder.
    const decoded = getSuspendAgentInstructionDataDecoder().decode(ix.data);
    expect(decoded.discriminator).toHaveLength(8);
  });
});

describe("unsuspendAgent (facade)", () => {
  const agent = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
  const authority = createNoopSigner(
    address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  );

  it("assembles with the right program, auto-derived protocolConfig, account order, and round-trips its data", async () => {
    const ix = await unsuspendAgent({ agent, authority });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    // Accounts: agent, protocolConfig (auto-derived PDA), authority.
    const addrs = ix.accounts.map((a) => a.address);
    expect(addrs).toHaveLength(3);
    expect(addrs[0]).toBe(agent);
    expect(addrs[2]).toBe(authority.address);
    // protocolConfig is a derived PDA distinct from the supplied accounts.
    expect(addrs[1]).not.toBe(agent);
    expect(addrs[1]).not.toBe(authority.address);

    // Data is just the discriminator; it must round-trip through the decoder.
    const decoded = getUnsuspendAgentInstructionDataDecoder().decode(ix.data);
    expect(decoded.discriminator).toHaveLength(8);
  });
});
