import { describe, it, expect } from "vitest";
import { address, createNoopSigner } from "@solana/kit";
import {
  createBid,
  cancelBid,
  updateBid,
  expireBid,
  acceptBid,
  initializeBidMarketplace,
  initializeBidBook,
  updateBidMarketplaceConfig,
  findBidPda,
  findBidBookPda,
  findBidMarketplacePda,
  findBidderMarketStatePda,
} from "../src/facade/bids.js";
import {
  getCreateBidInstructionDataDecoder,
  getCancelBidInstructionDataDecoder,
  getUpdateBidInstructionDataDecoder,
  getExpireBidInstructionDataDecoder,
  getAcceptBidInstructionDataDecoder,
  getInitializeBidMarketplaceInstructionDataDecoder,
  getInitializeBidBookInstructionDataDecoder,
  getUpdateBidMarketplaceConfigInstructionDataDecoder,
  findProtocolConfigPda,
  findClaimPda,
  findTaskJobSpecPda,
  AGENC_COORDINATION_PROGRAM_ADDRESS,
} from "../src/index.js";

// Structural tests for the bid-marketplace facade (mirrors tests/agents.test.ts):
// build each instruction through the friendly facade wrapper and assert program
// address, account order, and that the encoded data round-trips through the matching
// generated decoder. The Async builders auto-derive PDAs, so derived accounts are
// asserted against findXPda() rather than literals. Deterministic, no VM.
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const task = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
const bidder = address("So11111111111111111111111111111111111111112");
const authority = createNoopSigner(
  address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
);

// 32-byte fixed hashes used by create/update bid args.
const qualityGuaranteeHash = new Uint8Array(32).fill(3);
const metadataHash = new Uint8Array(32).fill(9);

describe("createBid facade", () => {
  it("assembles with the right program, account order, and round-trips its data", async () => {
    const ix = await createBid({
      task,
      bidder,
      authority,
      requestedRewardLamports: 1_000n,
      etaSeconds: 3600,
      confidenceBps: 8000,
      qualityGuaranteeHash,
      metadataHash,
      expiresAt: 1_700_000_000n,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const [protocolConfig] = await findProtocolConfigPda();
    const [bidMarketplace] = await findBidMarketplacePda();
    const [bidBook] = await findBidBookPda({ task });
    const [bid] = await findBidPda({ task, bidder });
    const [bidderMarketState] = await findBidderMarketStatePda({ bidder });
    expect(ix.accounts.map((a) => a.address)).toEqual([
      protocolConfig,
      bidMarketplace,
      task,
      bidBook,
      bid,
      bidderMarketState,
      bidder,
      authority.address,
      SYSTEM_PROGRAM,
    ]);

    const decoded = getCreateBidInstructionDataDecoder().decode(ix.data);
    expect(decoded.requestedRewardLamports).toBe(1_000n);
    expect(decoded.etaSeconds).toBe(3600);
    expect(decoded.confidenceBps).toBe(8000);
    expect(decoded.expiresAt).toBe(1_700_000_000n);
    expect(Array.from(decoded.qualityGuaranteeHash)).toEqual(
      Array.from(qualityGuaranteeHash),
    );
    expect(Array.from(decoded.metadataHash)).toEqual(Array.from(metadataHash));
  });
});

describe("cancelBid facade", () => {
  it("assembles with the right program, account order, and round-trips its data", async () => {
    const ix = await cancelBid({ task, bidder, authority });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const [bidBook] = await findBidBookPda({ task });
    const [bid] = await findBidPda({ task, bidder });
    const [bidderMarketState] = await findBidderMarketStatePda({ bidder });
    expect(ix.accounts.map((a) => a.address)).toEqual([
      task,
      bidBook,
      bid,
      bidderMarketState,
      bidder,
      authority.address,
    ]);

    // discriminator-only payload still decodes.
    expect(getCancelBidInstructionDataDecoder().decode(ix.data)).toBeTruthy();
  });
});

describe("updateBid facade", () => {
  it("assembles with the right program, account order, and round-trips its data", async () => {
    const ix = await updateBid({
      task,
      bidder,
      authority,
      requestedRewardLamports: 2_500n,
      etaSeconds: 7200,
      confidenceBps: 9500,
      qualityGuaranteeHash,
      metadataHash,
      expiresAt: 1_800_000_000n,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const [bidBook] = await findBidBookPda({ task });
    const [bid] = await findBidPda({ task, bidder });
    const [bidMarketplace] = await findBidMarketplacePda();
    const [protocolConfig] = await findProtocolConfigPda();
    expect(ix.accounts.map((a) => a.address)).toEqual([
      task,
      bidBook,
      bid,
      bidder,
      authority.address,
      bidMarketplace,
      protocolConfig,
    ]);

    const decoded = getUpdateBidInstructionDataDecoder().decode(ix.data);
    expect(decoded.requestedRewardLamports).toBe(2_500n);
    expect(decoded.etaSeconds).toBe(7200);
    expect(decoded.confidenceBps).toBe(9500);
    expect(decoded.expiresAt).toBe(1_800_000_000n);
  });
});

describe("expireBid facade (time-gated)", () => {
  it("assembles with the right program, account order, and round-trips its data", async () => {
    const bidderAuthority = address(
      "Stake11111111111111111111111111111111111111",
    );
    const ix = await expireBid({
      task,
      bidder,
      bidderAuthority,
      authority,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const [protocolConfig] = await findProtocolConfigPda();
    const [bidBook] = await findBidBookPda({ task });
    const [bid] = await findBidPda({ task, bidder });
    const [bidderMarketState] = await findBidderMarketStatePda({ bidder });
    expect(ix.accounts.map((a) => a.address)).toEqual([
      protocolConfig,
      task,
      bidBook,
      bid,
      bidderMarketState,
      bidder,
      bidderAuthority,
      authority.address,
    ]);

    expect(getExpireBidInstructionDataDecoder().decode(ix.data)).toBeTruthy();
  });
});

describe("acceptBid facade", () => {
  it("assembles with the right program, account order, and round-trips its data", async () => {
    // For accept_bid the signer is the creator; bidder is a plain address.
    const creator = createNoopSigner(
      address("Vote111111111111111111111111111111111111111"),
    );
    const ix = await acceptBid({ task, bidder, creator });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const [claim] = await findClaimPda({ task, bidder });
    const [protocolConfig] = await findProtocolConfigPda();
    const [bidBook] = await findBidBookPda({ task });
    const [bid] = await findBidPda({ task, bidder });
    const [bidderMarketState] = await findBidderMarketStatePda({ bidder });
    const [taskJobSpec] = await findTaskJobSpecPda({ task });
    expect(ix.accounts.map((a) => a.address)).toEqual([
      task,
      claim,
      protocolConfig,
      bidBook,
      bid,
      bidderMarketState,
      bidder,
      taskJobSpec,
      creator.address,
      SYSTEM_PROGRAM,
    ]);

    expect(getAcceptBidInstructionDataDecoder().decode(ix.data)).toBeTruthy();
  });
});

describe("initializeBidMarketplace facade", () => {
  it("assembles with the right program, account order, and round-trips its data", async () => {
    const ix = await initializeBidMarketplace({
      authority,
      minBidBondLamports: 50_000n,
      bidCreationCooldownSecs: 60n,
      maxBidsPer24h: 100,
      maxActiveBidsPerTask: 10,
      maxBidLifetimeSecs: 86_400n,
      acceptedNoShowSlashBps: 500,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const [protocolConfig] = await findProtocolConfigPda();
    const [bidMarketplace] = await findBidMarketplacePda();
    expect(ix.accounts.map((a) => a.address)).toEqual([
      protocolConfig,
      bidMarketplace,
      authority.address,
      SYSTEM_PROGRAM,
    ]);

    const decoded =
      getInitializeBidMarketplaceInstructionDataDecoder().decode(ix.data);
    expect(decoded.minBidBondLamports).toBe(50_000n);
    expect(decoded.bidCreationCooldownSecs).toBe(60n);
    expect(decoded.maxBidsPer24h).toBe(100);
    expect(decoded.maxActiveBidsPerTask).toBe(10);
    expect(decoded.maxBidLifetimeSecs).toBe(86_400n);
    expect(decoded.acceptedNoShowSlashBps).toBe(500);
  });
});

describe("initializeBidBook facade", () => {
  it("assembles with the right program, account order, and round-trips its data", async () => {
    const creator = createNoopSigner(
      address("Vote111111111111111111111111111111111111111"),
    );
    const ix = await initializeBidBook({
      task,
      creator,
      policy: 1,
      priceWeightBps: 4000,
      etaWeightBps: 2000,
      confidenceWeightBps: 2000,
      reliabilityWeightBps: 2000,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const [bidBook] = await findBidBookPda({ task });
    const [protocolConfig] = await findProtocolConfigPda();
    expect(ix.accounts.map((a) => a.address)).toEqual([
      task,
      bidBook,
      protocolConfig,
      creator.address,
      SYSTEM_PROGRAM,
    ]);

    const decoded = getInitializeBidBookInstructionDataDecoder().decode(ix.data);
    expect(decoded.policy).toBe(1);
    expect(decoded.priceWeightBps).toBe(4000);
    expect(decoded.etaWeightBps).toBe(2000);
    expect(decoded.confidenceWeightBps).toBe(2000);
    expect(decoded.reliabilityWeightBps).toBe(2000);
  });
});

describe("updateBidMarketplaceConfig facade", () => {
  it("assembles with the right program, account order, and round-trips its data", async () => {
    const ix = await updateBidMarketplaceConfig({
      authority,
      minBidBondLamports: 75_000n,
      bidCreationCooldownSecs: 120n,
      maxBidsPer24h: 200,
      maxActiveBidsPerTask: 20,
      maxBidLifetimeSecs: 172_800n,
      acceptedNoShowSlashBps: 750,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const [protocolConfig] = await findProtocolConfigPda();
    const [bidMarketplace] = await findBidMarketplacePda();
    expect(ix.accounts.map((a) => a.address)).toEqual([
      protocolConfig,
      bidMarketplace,
      authority.address,
    ]);

    const decoded =
      getUpdateBidMarketplaceConfigInstructionDataDecoder().decode(ix.data);
    expect(decoded.minBidBondLamports).toBe(75_000n);
    expect(decoded.bidCreationCooldownSecs).toBe(120n);
    expect(decoded.maxBidsPer24h).toBe(200);
    expect(decoded.maxActiveBidsPerTask).toBe(20);
    expect(decoded.maxBidLifetimeSecs).toBe(172_800n);
    expect(decoded.acceptedNoShowSlashBps).toBe(750);
  });
});
