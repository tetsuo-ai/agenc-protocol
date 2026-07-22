import { describe, it, expect } from "vitest";
import {
  AccountRole,
  address,
  createNoopSigner,
  some,
  none,
  type Address,
  type TransactionSigner,
} from "@solana/kit";
import {
  getRegisterAgentInstructionDataDecoder,
  getUpdateAgentInstructionDataDecoder,
  getDeregisterAgentInstructionDataDecoder,
  getSuspendAgentInstructionDataDecoder,
  getUnsuspendAgentInstructionDataDecoder,
  AGENC_COORDINATION_PROGRAM_ADDRESS,
} from "../src/index.js";
import {
  registerAgent,
  updateAgent,
  deregisterAgent,
  suspendAgent,
  unsuspendAgent,
} from "../src/facade/agents.js";

function mutableSigner(initialAddress: Address): {
  signer: TransactionSigner;
  setAddress(nextAddress: Address): void;
} {
  let liveAddress = initialAddress;
  const signer = { ...createNoopSigner(initialAddress) } as TransactionSigner;
  Object.defineProperty(signer, "address", {
    configurable: true,
    enumerable: true,
    get: () => liveAddress,
  });
  return {
    signer,
    setAddress(nextAddress) {
      liveAddress = nextAddress;
    },
  };
}

// Structural test pattern (the template for the facade loop): build the instruction and
// assert program address, account order, and that the encoded data round-trips. Deterministic,
// no VM — validates the generated builder + (later) the facade wiring against the IDL.
describe("registerAgent (facade)", () => {
  const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
  const agent = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
  const protocolConfig = address("So11111111111111111111111111111111111111112");
  const authority = createNoopSigner(
    address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  );

  it("assembles with the right program, account order, and round-trips its data", async () => {
    const agentId = new Uint8Array(32).fill(7);
    const ix = await registerAgent({
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

  it("detaches agent identity bytes and metadata before PDA derivation", async () => {
    const mutableAuthority = mutableSigner(authority.address);
    const agentId = new Uint8Array(32).fill(17);
    const metadataUri = {
      __option: "Some" as const,
      value: "https://agent.test/v1",
    };
    const pending = registerAgent({
      protocolConfig,
      authority: mutableAuthority.signer,
      agentId,
      capabilities: 1n,
      endpoint: "https://agent.test",
      metadataUri,
      stakeAmount: 0n,
    });

    agentId.fill(99);
    metadataUri.value = "https://attacker.test";
    mutableAuthority.setAddress(agent);

    const ix = await pending;
    const decoded = getRegisterAgentInstructionDataDecoder().decode(ix.data);
    expect(decoded.agentId).toEqual(new Uint8Array(32).fill(17));
    expect(decoded.metadataUri).toEqual(some("https://agent.test/v1"));
    expect(ix.accounts[2]).toMatchObject({
      address: authority.address,
      signer: mutableAuthority.signer,
    });
  });

  it("rejects an accessor-backed signer field without invoking it", async () => {
    let authorityReads = 0;
    const hostileInput = {
      agent,
      protocolConfig,
      agentId: new Uint8Array(32),
      capabilities: 1n,
      endpoint: "https://agent.test",
      metadataUri: null,
      stakeAmount: 0n,
    } as unknown as Parameters<typeof registerAgent>[0];
    Object.defineProperty(hostileInput, "authority", {
      configurable: true,
      enumerable: true,
      get() {
        authorityReads += 1;
        return authority;
      },
    });

    await expect(registerAgent(hostileInput)).rejects.toThrow(
      /authority.*own data property/u,
    );
    expect(authorityReads).toBe(0);
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
    // PDA — audit: stake must be withdrawn before deregister), authority, then the two
    // seeds-pinned remaining_accounts the handler requires (audit, 2026-07 swarm):
    // [4] the ["bidder_market", agent] PDA (read-only; live bids block deregistration),
    // [5] the ["agent_verification", agent] PDA (writable; a live badge is revoked
    // and retained as an audit trail).
    const addrs = ix.accounts.map((a) => a.address);
    expect(addrs).toHaveLength(6);
    expect(addrs[0]).toBe(agent);
    expect(addrs[3]).toBe(authority.address);
    // protocolConfig and reputationStake are derived PDAs distinct from the supplied accounts.
    expect(addrs[1]).not.toBe(agent);
    expect(addrs[1]).not.toBe(authority.address);
    expect(addrs[2]).not.toBe(agent);
    expect(addrs[2]).not.toBe(authority.address);
    expect(addrs[2]).not.toBe(addrs[1]);
    // The remaining accounts are derived PDAs, distinct from the named accounts,
    // with [4] read-only and [5] writable.
    expect(addrs[4]).not.toBe(agent);
    expect(addrs[5]).not.toBe(agent);
    expect(ix.accounts[4]!.role).toBe(AccountRole.READONLY);
    expect(ix.accounts[5]!.role).toBe(AccountRole.WRITABLE);

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
