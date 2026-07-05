import { describe, it, expect } from "vitest";
import { address, createNoopSigner, none, some } from "@solana/kit";
import {
  getRegisterStoreInstructionDataDecoder,
  getUpdateStoreInstructionDataDecoder,
  getCloseStoreInstructionDataDecoder,
  getModerationHeartbeatInstructionDataDecoder,
  CLOSE_STORE_DISCRIMINATOR,
  findStorePda,
  findModerationConfigPda,
  AGENC_COORDINATION_PROGRAM_ADDRESS,
} from "../src/index.js";
import {
  registerStore,
  updateStore,
  closeStore,
  STORE_REGISTRATION_BOND_LAMPORTS,
} from "../src/facade/stores.js";
import { moderationHeartbeat } from "../src/facade/moderation.js";
import {
  STORE_HANDLE_BYTES,
  encodeStoreHandle,
  decodeStoreHandle,
} from "../src/values/index.js";

// Structural tests (the facade-loop template): build each instruction and assert program
// address, account order, and that the encoded data round-trips through the matching
// decoder. Deterministic, no VM — validates the generated builder + facade wiring against
// the IDL. The store facade prefers the *Async builders (auto-derive the `["store",
// owner]` PDA from the owner signer), so account-order assertions await the same PDA.
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");

const owner = createNoopSigner(
  address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
);
const operator = address("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");

describe("store handle codec (values)", () => {
  it("encodes a valid handle NUL-padded to exactly 32 bytes and round-trips", () => {
    const bytes = encodeStoreHandle("acme-agents");
    expect(bytes.length).toBe(STORE_HANDLE_BYTES);
    expect(Array.from(bytes.subarray(0, 11))).toEqual(
      Array.from(new TextEncoder().encode("acme-agents")),
    );
    expect(bytes.subarray(11).every((b) => b === 0)).toBe(true);
    expect(decodeStoreHandle(bytes)).toBe("acme-agents");
  });

  it("rejects handles that violate the on-chain rule", () => {
    for (const bad of [
      "ab", // too short
      "abcdefghij0123456789x", // 21 chars, too long
      "Acme", // uppercase
      "-acme", // leading hyphen
      "acme agents", // space
      "", // empty
    ]) {
      expect(() => encodeStoreHandle(bad)).toThrow(TypeError);
    }
  });

  it("rejects non-canonical padding and wrong-length inputs on decode", () => {
    expect(() => decodeStoreHandle(new Uint8Array(31))).toThrow(RangeError);
    const sneaky = encodeStoreHandle("acme");
    sneaky[10] = 0x61; // a non-NUL byte after the first NUL terminator
    expect(() => decodeStoreHandle(sneaky)).toThrow(TypeError);
  });
});

describe("registerStore (facade)", () => {
  const input = {
    owner,
    handle: "acme-agents",
    metadataHash: new Uint8Array(32).fill(7),
    metadataUri: "https://acme.example/store.json",
    referrerFeeBps: 250,
    operator,
    operatorFeeBps: 100,
    domain: "acme.example",
  };

  it("auto-derives the store PDA, orders accounts, and round-trips its data", async () => {
    const ix = await registerStore(input);
    const [storePda] = await findStorePda({ owner: owner.address });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      storePda,
      owner.address,
      SYSTEM_PROGRAM,
    ]);

    const decoded = getRegisterStoreInstructionDataDecoder().decode(ix.data);
    expect(decodeStoreHandle(new Uint8Array(decoded.handle))).toBe(
      "acme-agents",
    );
    expect(Array.from(decoded.metadataHash)).toEqual(
      Array.from(input.metadataHash),
    );
    expect(decoded.metadataUri).toBe(input.metadataUri);
    expect(decoded.referrerFeeBps).toBe(250);
    expect(decoded.operator).toBe(operator);
    expect(decoded.operatorFeeBps).toBe(100);
    expect(decoded.domain).toBe("acme.example");
  });

  it("passes a raw 32-byte handle through byte-for-byte", async () => {
    const raw = encodeStoreHandle("raw-handle");
    const ix = await registerStore({ ...input, handle: raw });
    const decoded = getRegisterStoreInstructionDataDecoder().decode(ix.data);
    expect(Array.from(decoded.handle)).toEqual(Array.from(raw));
  });

  it("fails fast on an invalid string handle (the program re-validates on-chain)", async () => {
    await expect(
      registerStore({ ...input, handle: "Not-Valid" }),
    ).rejects.toThrow(TypeError);
  });

  it("documents the on-chain bond as a typed constant", () => {
    // 0.05 SOL, mirror of the program's STORE_REGISTRATION_BOND_LAMPORTS.
    expect(STORE_REGISTRATION_BOND_LAMPORTS).toBe(50_000_000n);
  });
});

describe("updateStore (facade)", () => {
  it("auto-derives the store PDA, orders accounts, and round-trips its data", async () => {
    const ix = await updateStore({
      owner,
      handle: "acme-agents-v2",
      metadataHash: new Uint8Array(32).fill(9),
      metadataUri: "https://acme.example/store-v2.json",
      referrerFeeBps: 300,
      operator,
      operatorFeeBps: 150,
      domain: "v2.acme.example",
    });
    const [storePda] = await findStorePda({ owner: owner.address });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      storePda,
      owner.address,
    ]);

    const decoded = getUpdateStoreInstructionDataDecoder().decode(ix.data);
    expect(decodeStoreHandle(new Uint8Array(decoded.handle))).toBe(
      "acme-agents-v2",
    );
    expect(decoded.metadataUri).toBe("https://acme.example/store-v2.json");
    expect(decoded.referrerFeeBps).toBe(300);
    expect(decoded.operatorFeeBps).toBe(150);
    expect(decoded.domain).toBe("v2.acme.example");
  });
});

describe("closeStore (facade)", () => {
  it("auto-derives the store PDA and encodes the bare discriminator", async () => {
    const ix = await closeStore({ owner });
    const [storePda] = await findStorePda({ owner: owner.address });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      storePda,
      owner.address,
    ]);

    // No args: the data is exactly the 8-byte discriminator.
    expect(Array.from(ix.data)).toEqual(Array.from(CLOSE_STORE_DISCRIMINATOR));
    // And it still round-trips through the decoder.
    getCloseStoreInstructionDataDecoder().decode(ix.data);
  });
});

describe("moderationHeartbeat (facade)", () => {
  const authority = createNoopSigner(
    address("So11111111111111111111111111111111111111112"),
  );

  it("auto-derives moderationConfig, orders accounts, and round-trips a window retune", async () => {
    const ix = await moderationHeartbeat({
      authority,
      newWindowSecs: 172800, // 2 days
    });
    const [moderationConfig] = await findModerationConfigPda();

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      moderationConfig,
      authority.address,
    ]);

    const decoded = getModerationHeartbeatInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.newWindowSecs).toEqual(some(172800));
  });

  it("encodes a bare heartbeat (no window change) as None", async () => {
    const ix = await moderationHeartbeat({
      authority,
      newWindowSecs: none(),
    });
    const decoded = getModerationHeartbeatInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.newWindowSecs).toEqual(none());
  });
});
