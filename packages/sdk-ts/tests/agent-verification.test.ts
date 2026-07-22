// P7.3(3) on-chain agent-verification reader — SDK unit tests.
//
// Load-bearing requirement (PLAN.md Phase 7 wave 2): fetchAgentVerification
// against a fabricated AgentVerification account returns verified=true when the
// account exists, is NOT revoked, and is NOT expired; and returns verified=false
// (with the right reason) for absent / revoked / expired. getAgentTrackRecord
// folds the same signal into verified + verifiedDomain.
//
// The account bytes are built with the generated encoder and served via a
// minimal address-keyed fake kit RPC (the same getAccountInfo base64 shape
// fetchEncodedAccount consumes, as in surface.test.ts).
import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import {
  address,
  createNoopSigner,
  type Address,
  type TransactionSigner,
} from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  getRecordAgentVerificationInstructionDataDecoder,
  getRevokeAgentVerificationInstructionDataDecoder,
  getAgentVerificationEncoder,
  findAgentVerificationPda,
  findModerationConfigPda,
  type AgentVerificationArgs,
} from "../src/index.js";
import {
  fetchAgentVerification,
  getAgentTrackRecord,
} from "../src/facade/agents.js";
import {
  recordAgentVerification,
  revokeAgentVerification,
} from "../src/facade/verification.js";

const AGENT = address(
  "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK",
) as Address;
const ATTESTOR = address(
  "So11111111111111111111111111111111111111112",
) as Address;
const PROGRAM = "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK" as Address;
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");

function mutableSigner(initialAddress: Address): {
  signer: TransactionSigner;
  setAddress(nextAddress: Address): void;
} {
  let liveAddress = initialAddress;
  const signer = {
    ...createNoopSigner(initialAddress),
  } as TransactionSigner;
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

/** Build the raw on-chain bytes for an AgentVerification account. */
function encodeVerification(
  over: Partial<AgentVerificationArgs> = {},
): Uint8Array {
  const args: AgentVerificationArgs = {
    agent: AGENT,
    verifiedDomain: "agent.example.com",
    method: 1,
    verifiedBy: ATTESTOR,
    verifiedAt: 1_700_000_000n,
    expiresAt: 0n,
    revoked: false,
    bump: 255,
    reserved: new Uint8Array(32),
    ...over,
  };
  return new Uint8Array(getAgentVerificationEncoder().encode(args));
}

/**
 * Address-keyed fake kit RPC: returns the base64 account-info shape
 * fetchEncodedAccount consumes for known addresses, `{ value: null }` otherwise.
 */
function makeRpc(accounts: Map<string, Uint8Array>) {
  return {
    getAccountInfo(addr: Address) {
      return {
        send: async () => {
          const data = accounts.get(addr);
          return data === undefined
            ? { value: null }
            : {
                value: {
                  data: [Buffer.from(data).toString("base64"), "base64"],
                  executable: false,
                  lamports: 1n,
                  owner: PROGRAM,
                  rentEpoch: 0n,
                  space: BigInt(data.length),
                },
              };
        },
      };
    },
  } as never;
}

async function rpcWithVerification(
  over: Partial<AgentVerificationArgs> = {},
): Promise<ReturnType<typeof makeRpc>> {
  const [pda] = await findAgentVerificationPda({ agent: AGENT });
  const map = new Map<string, Uint8Array>();
  map.set(pda, encodeVerification(over));
  return makeRpc(map);
}

describe("fetchAgentVerification (P7.3(3))", () => {
  it("verified=true for an existing, non-revoked, non-expired account", async () => {
    const rpc = await rpcWithVerification();
    const result = await fetchAgentVerification(rpc, AGENT, {
      nowSeconds: 1_700_000_100n,
    });
    expect(result.verified).toBe(true);
    if (!result.verified) throw new Error("unreachable");
    expect(result.domain).toBe("agent.example.com");
    expect(result.method).toBe(1);
    expect(result.verifiedBy).toBe(ATTESTOR);
    expect(result.revoked).toBe(false);
  });

  it("verified=true with no expiry (expiresAt=0) regardless of now", async () => {
    const rpc = await rpcWithVerification({ expiresAt: 0n });
    const result = await fetchAgentVerification(rpc, AGENT, {
      nowSeconds: 9_999_999_999n,
    });
    expect(result.verified).toBe(true);
  });

  it("verified=false reason=absent when the PDA has no account", async () => {
    const rpc = makeRpc(new Map());
    const result = await fetchAgentVerification(rpc, AGENT);
    expect(result).toEqual({ verified: false, reason: "absent" });
  });

  it("verified=false reason=revoked when revoked=true", async () => {
    const rpc = await rpcWithVerification({ revoked: true });
    const result = await fetchAgentVerification(rpc, AGENT, {
      nowSeconds: 1_700_000_100n,
    });
    expect(result).toEqual({ verified: false, reason: "revoked" });
  });

  it("verified=false reason=expired once now >= expiresAt", async () => {
    const rpc = await rpcWithVerification({ expiresAt: 1_700_000_050n });
    const before = await fetchAgentVerification(rpc, AGENT, {
      nowSeconds: 1_700_000_049n,
    });
    expect(before.verified).toBe(true);
    const after = await fetchAgentVerification(rpc, AGENT, {
      nowSeconds: 1_700_000_050n,
    });
    expect(after).toEqual({ verified: false, reason: "expired" });
  });
});

describe("getAgentTrackRecord verified surfacing (P7.3(3))", () => {
  it("carries verified + verifiedDomain from the AgentVerification account", async () => {
    const rpc = await rpcWithVerification({ verifiedDomain: "verified.io" });
    const record = await getAgentTrackRecord(rpc, AGENT, {
      nowSeconds: 1_700_000_100n,
    });
    expect(record.verified).toBe(true);
    expect(record.verifiedDomain).toBe("verified.io");
  });

  it("verified=false / verifiedDomain=null when there is no verification account", async () => {
    const rpc = makeRpc(new Map());
    const record = await getAgentTrackRecord(rpc, AGENT);
    expect(record.verified).toBe(false);
    expect(record.verifiedDomain).toBeNull();
  });
});

describe("agent verification facade instruction boundaries", () => {
  it("records verification with canonical PDA/account order and encoded data", async () => {
    const attestor = createNoopSigner(ATTESTOR);
    const ix = await recordAgentVerification({
      agent: AGENT,
      attestor,
      verifiedDomain: "agent.example.com",
      method: 1,
      expiresAt: 1_800_000_000n,
    });
    const [moderationConfig] = await findModerationConfigPda();
    const [verification] = await findAgentVerificationPda({ agent: AGENT });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((account) => account.address)).toEqual([
      moderationConfig,
      AGENT,
      verification,
      ATTESTOR,
      SYSTEM_PROGRAM,
    ]);
    const decoded = getRecordAgentVerificationInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.verifiedDomain).toBe("agent.example.com");
    expect(decoded.method).toBe(1);
    expect(decoded.expiresAt).toBe(1_800_000_000n);
  });

  it("derives the verification PDA for revoke and preserves account order", async () => {
    const attestor = createNoopSigner(ATTESTOR);
    const ix = await revokeAgentVerification({ agent: AGENT, attestor });
    const [moderationConfig] = await findModerationConfigPda();
    const [verification] = await findAgentVerificationPda({ agent: AGENT });

    expect(ix.accounts.map((account) => account.address)).toEqual([
      moderationConfig,
      verification,
      ATTESTOR,
    ]);
    expect(
      getRevokeAgentVerificationInstructionDataDecoder().decode(ix.data)
        .discriminator,
    ).toHaveLength(8);
  });

  it("binds attestor before hostile whole-input reflection can switch it", async () => {
    const attestor = mutableSigner(ATTESTOR);
    const target = {
      agent: AGENT,
      attestor: attestor.signer,
      verifiedDomain: "stable.example",
      method: 0,
      expiresAt: 0n,
    };
    const adversarialInput = new Proxy(target, {
      ownKeys(currentTarget) {
        attestor.setAddress(AGENT);
        return Reflect.ownKeys(currentTarget);
      },
    });

    const ix = await recordAgentVerification(adversarialInput);
    expect(ix.accounts[3]).toMatchObject({
      address: ATTESTOR,
      signer: attestor.signer,
    });
  });

  it("rejects accessor-backed revoke inputs without invoking the accessor", async () => {
    let reads = 0;
    const input = {
      agent: AGENT,
      attestor: createNoopSigner(ATTESTOR),
    };
    Object.defineProperty(input, "agent", {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return AGENT;
      },
    });

    await expect(revokeAgentVerification(input)).rejects.toThrow(
      /only own data properties/u,
    );
    expect(reads).toBe(0);
  });
});
