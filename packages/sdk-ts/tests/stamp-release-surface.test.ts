import { describe, expect, it } from "vitest";
import {
  AccountRole,
  address,
  createNoopSigner,
  type AccountMeta,
  type Address,
  type TransactionSigner,
} from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  getStampReleaseSurfaceInstructionDataDecoder,
} from "../src/index.js";
import {
  stampReleaseSurface,
  type StampReleaseSurfaceInput,
} from "../src/facade/index.js";

const A = {
  protocolConfig: address("So11111111111111111111111111111111111111112"),
  bidMarketplaceConfig: address("Vote111111111111111111111111111111111111111"),
  moderationConfig: address("Stake11111111111111111111111111111111111111"),
  programData: address("Config1111111111111111111111111111111111111"),
  anchorIdl: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
  upgradeAuthorityCustody: address(
    "Sysvar1nstructions1111111111111111111111111",
  ),
  authority: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  changedAuthority: address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK"),
  approvalA: address("E5AhdYwQJK5hnHKveTJ3abMcNqWZXVtDNHuugdxFPjn4"),
  approvalB: address("EFN2MEp3EduDRkn6x7h8NQX3Z9n2S8hwX1B8LUWDHgnx"),
};

const authority = createNoopSigner(A.authority);
const approvalA = createNoopSigner(A.approvalA);
const approvalB = createNoopSigner(A.approvalB);
const approvals = [approvalA, approvalB] as const;

function releaseInput(
  overrides: Partial<StampReleaseSurfaceInput> = {},
): StampReleaseSurfaceInput {
  return {
    protocolConfig: A.protocolConfig,
    bidMarketplaceConfig: A.bidMarketplaceConfig,
    moderationConfig: A.moderationConfig,
    programData: A.programData,
    anchorIdl: A.anchorIdl,
    upgradeAuthorityCustody: A.upgradeAuthorityCustody,
    authority,
    disabledTaskTypeMask: 6,
    surfaceRevision: 5,
    expectedProtocolConfigHash: new Uint8Array(32).fill(1),
    expectedProgramDataSlot: 123_456n,
    expectedProgramDataPayloadLen: 789_012,
    expectedUpgradeAuthority: A.authority,
    expectedBidConfigHash: new Uint8Array(32).fill(2),
    expectedModerationConfigHash: new Uint8Array(32).fill(3),
    expectedIdlAccountHash: new Uint8Array(32).fill(4),
    expectedCustodyAddress: A.upgradeAuthorityCustody,
    expectedCustodyOwner: A.programData,
    expectedCustodyAccountHash: new Uint8Array(32).fill(5),
    multisigSigners: approvals,
    ...overrides,
  };
}

function expectApprovalSuffix(accounts: readonly AccountMeta[]) {
  const suffix = accounts.slice(-approvals.length);
  expect(suffix.map((account) => account.address)).toEqual([
    approvalA.address,
    approvalB.address,
  ]);
  for (const [index, account] of suffix.entries()) {
    expect(account.role).toBe(AccountRole.READONLY_SIGNER);
    expect(account).toHaveProperty("signer", approvals[index]);
  }
}

function createMutableAddressSigner(initialAddress: Address): {
  signer: TransactionSigner;
  setLiveAddress(nextAddress: Address): void;
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
    setLiveAddress(nextAddress) {
      liveAddress = nextAddress;
    },
  };
}

describe("stampReleaseSurface facade", () => {
  it("builds the reviewed release stamp and appends current ProtocolConfig approvals", async () => {
    const input = releaseInput();
    const ix = await stampReleaseSurface(input);

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((account) => account.address)).toEqual([
      A.protocolConfig,
      A.bidMarketplaceConfig,
      A.moderationConfig,
      A.programData,
      A.anchorIdl,
      A.upgradeAuthorityCustody,
      A.authority,
      A.approvalA,
      A.approvalB,
    ]);
    expect(ix.accounts[6]?.role).toBe(AccountRole.READONLY_SIGNER);
    expect(ix.accounts[6]).toHaveProperty("signer", authority);
    expectApprovalSuffix(ix.accounts);

    const decoded = getStampReleaseSurfaceInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.disabledTaskTypeMask).toBe(6);
    expect(decoded.surfaceRevision).toBe(5);
    expect(decoded.expectedProgramDataSlot).toBe(123_456n);
    expect(decoded.expectedProgramDataPayloadLen).toBe(789_012);
    expect(decoded.expectedUpgradeAuthority).toBe(A.authority);
    expect(decoded.expectedCustodyAddress).toBe(A.upgradeAuthorityCustody);
    expect(decoded.expectedCustodyOwner).toBe(A.programData);
    expect(decoded.expectedProtocolConfigHash).toEqual(
      new Uint8Array(32).fill(1),
    );
    expect(decoded.expectedBidConfigHash).toEqual(new Uint8Array(32).fill(2));
    expect(decoded.expectedModerationConfigHash).toEqual(
      new Uint8Array(32).fill(3),
    );
    expect(decoded.expectedIdlAccountHash).toEqual(new Uint8Array(32).fill(4));
    expect(decoded.expectedCustodyAccountHash).toEqual(
      new Uint8Array(32).fill(5),
    );
  });

  it("detaches every reviewed hash and locks authority before default PDA derivation yields", async () => {
    const mutableAuthority = createMutableAddressSigner(A.authority);
    const protocolHash = new Uint8Array(32).fill(11);
    const bidHash = new Uint8Array(32).fill(12);
    const moderationHash = new Uint8Array(32).fill(13);
    const idlHash = new Uint8Array(32).fill(14);
    const custodyHash = new Uint8Array(32).fill(15);
    const input = releaseInput({
      authority: mutableAuthority.signer,
      expectedProtocolConfigHash: protocolHash,
      expectedBidConfigHash: bidHash,
      expectedModerationConfigHash: moderationHash,
      expectedIdlAccountHash: idlHash,
      expectedCustodyAccountHash: custodyHash,
    });
    delete input.protocolConfig;
    delete input.bidMarketplaceConfig;
    delete input.moderationConfig;

    const instructionPromise = stampReleaseSurface(input);
    mutableAuthority.setLiveAddress(A.changedAuthority);
    protocolHash.fill(91);
    bidHash.fill(92);
    moderationHash.fill(93);
    idlHash.fill(94);
    custodyHash.fill(95);

    const ix = await instructionPromise;
    const decoded = getStampReleaseSurfaceInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.expectedProtocolConfigHash).toEqual(
      new Uint8Array(32).fill(11),
    );
    expect(decoded.expectedBidConfigHash).toEqual(new Uint8Array(32).fill(12));
    expect(decoded.expectedModerationConfigHash).toEqual(
      new Uint8Array(32).fill(13),
    );
    expect(decoded.expectedIdlAccountHash).toEqual(new Uint8Array(32).fill(14));
    expect(decoded.expectedCustodyAccountHash).toEqual(
      new Uint8Array(32).fill(15),
    );
    expect(ix.accounts[6]).toMatchObject({
      address: A.authority,
      signer: mutableAuthority.signer,
    });
    expect(
      Object.getOwnPropertyDescriptor(mutableAuthority.signer, "address"),
    ).toMatchObject({
      configurable: false,
      writable: false,
      value: A.authority,
    });
  });

  it("binds authority before hostile whole-input reflection can switch wallets", async () => {
    const mutableAuthority = createMutableAddressSigner(A.authority);
    const target = releaseInput({ authority: mutableAuthority.signer });
    const adversarialInput = new Proxy(target, {
      ownKeys(currentTarget) {
        mutableAuthority.setLiveAddress(A.changedAuthority);
        return Reflect.ownKeys(currentTarget);
      },
    });

    const ix = await stampReleaseSurface(adversarialInput);
    expect(ix.accounts[6]).toMatchObject({
      address: A.authority,
      signer: mutableAuthority.signer,
    });
  });

  it("uses the named authority capability for an equal-address approval", async () => {
    const namedAuthority = createNoopSigner(A.authority);
    const duplicateCapability = createNoopSigner(A.authority);
    const ix = await stampReleaseSurface(
      releaseInput({
        authority: namedAuthority,
        multisigSigners: [duplicateCapability, approvalA],
      }),
    );

    expect(ix.accounts[6]).toMatchObject({
      address: A.authority,
      signer: namedAuthority,
    });
    expect(ix.accounts.at(-2)).toMatchObject({
      address: A.authority,
      role: AccountRole.READONLY_SIGNER,
      signer: namedAuthority,
    });
    expect(ix.accounts.at(-2)).not.toHaveProperty(
      "signer",
      duplicateCapability,
    );
  });

  it("rejects accessor-backed release evidence without invoking it", async () => {
    let reads = 0;
    const input = releaseInput();
    Object.defineProperty(input, "expectedProtocolConfigHash", {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return new Uint8Array(32).fill(99);
      },
    });

    await expect(stampReleaseSurface(input)).rejects.toThrow(
      "client facade input must contain only own data properties",
    );
    expect(reads).toBe(0);
  });
});
