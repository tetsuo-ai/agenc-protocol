import { describe, it, expect } from "vitest";
import { address, createNoopSigner, type Option } from "@solana/kit";
import {
  getCreateServiceListingInstructionDataDecoder,
  getUpdateServiceListingInstructionDataDecoder,
  getSetServiceListingStateInstructionDataDecoder,
  getHireFromListingInstructionDataDecoder,
  getHireFromListingHumanlessInstructionDataDecoder,
  findListingPda,
  findListingModerationPda,
  findModerationAttestorPda,
  findModerationBlockPda,
  AGENC_COORDINATION_PROGRAM_ADDRESS,
} from "../src/index.js";
import {
  createServiceListing,
  updateServiceListing,
  setServiceListingState,
  hireFromListing,
  hireFromListingHumanless,
  ListingState,
} from "../src/facade/listings.js";

// Structural tests: build each facade instruction and assert program address,
// account order, and that the encoded data round-trips through the matching
// generated decoder. Deterministic, no VM — validates the facade wiring + the
// generated builder against the IDL.

const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
// Valid base58 placeholders for accounts the async builder does not derive.
const providerAgent = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
const creatorAgent = address("So11111111111111111111111111111111111111112");
const authority = createNoopSigner(
  address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
);

function unwrapSome<T>(opt: Option<T>): T {
  expect(opt.__option).toBe("Some");
  if (opt.__option !== "Some") throw new Error("expected Some");
  return opt.value;
}

describe("createServiceListing (facade)", () => {
  it("assembles with the right program, account order, and round-trips its data", async () => {
    const listingId = new Uint8Array(32).fill(3);
    const name = new Uint8Array(32).fill(0);
    name.set([...new TextEncoder().encode("listing")]);
    const category = new Uint8Array(32).fill(0);
    const tags = new Uint8Array(64).fill(0);
    const specHash = new Uint8Array(32).fill(9);

    const ix = await createServiceListing({
      providerAgent,
      authority,
      listingId,
      name,
      category,
      tags,
      specHash,
      specUri: "ipfs://spec",
      price: 1000n,
      priceMint: null,
      requiredCapabilities: 7n,
      defaultDeadlineSecs: 3600n,
      maxOpenJobs: 5,
      operator: null,
      operatorFeeBps: 250,
    });

    // listing + protocolConfig auto-derived by the async builder.
    const [expectedListing] = await findListingPda({ providerAgent, listingId });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const accts = ix.accounts.map((a) => a.address);
    expect(accts[0]).toBe(expectedListing);
    expect(accts[1]).toBe(providerAgent);
    expect(accts[3]).toBe(authority.address);
    expect(accts[4]).toBe(SYSTEM_PROGRAM);
    expect(ix.accounts.length).toBe(5);

    const decoded = getCreateServiceListingInstructionDataDecoder().decode(ix.data);
    expect(decoded.price).toBe(1000n);
    expect(decoded.specUri).toBe("ipfs://spec");
    expect(decoded.requiredCapabilities).toBe(7n);
    expect(decoded.defaultDeadlineSecs).toBe(3600n);
    expect(decoded.maxOpenJobs).toBe(5);
    expect(decoded.operatorFeeBps).toBe(250);
    expect(Array.from(decoded.listingId)).toEqual(Array.from(listingId));
    expect(Array.from(decoded.specHash)).toEqual(Array.from(specHash));
    expect(decoded.priceMint.__option).toBe("None");
    expect(decoded.operator.__option).toBe("None");
  });
});

describe("updateServiceListing (facade)", () => {
  const listing = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");

  it("assembles with the right program, account order, and round-trips its data", async () => {
    const ix = await updateServiceListing({
      listing,
      authority,
      price: 5000n,
      specHash: null,
      specUri: "ipfs://new",
      tags: null,
      requiredCapabilities: null,
      defaultDeadlineSecs: null,
      maxOpenJobs: 10,
      operator: null,
      operatorFeeBps: null,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const accts = ix.accounts.map((a) => a.address);
    expect(accts[0]).toBe(listing);
    // accts[1] = protocolConfig (auto-derived), accts[2] = authority.
    expect(accts[2]).toBe(authority.address);
    expect(ix.accounts.length).toBe(3);

    const decoded = getUpdateServiceListingInstructionDataDecoder().decode(ix.data);
    expect(unwrapSome(decoded.price)).toBe(5000n);
    expect(unwrapSome(decoded.specUri)).toBe("ipfs://new");
    expect(unwrapSome(decoded.maxOpenJobs)).toBe(10);
    expect(decoded.specHash.__option).toBe("None");
    expect(decoded.tags.__option).toBe("None");
    expect(decoded.operator.__option).toBe("None");
  });
});

describe("setServiceListingState (facade)", () => {
  const listing = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");

  it("accepts a raw newState, with right program, account order, and data round-trip", async () => {
    const ix = await setServiceListingState({
      listing,
      authority,
      newState: 2,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const accts = ix.accounts.map((a) => a.address);
    expect(accts[0]).toBe(listing);
    expect(accts[2]).toBe(authority.address);
    expect(ix.accounts.length).toBe(3);

    const decoded = getSetServiceListingStateInstructionDataDecoder().decode(ix.data);
    expect(decoded.newState).toBe(2);
  });

  it("maps a friendly state name to the matching u8", async () => {
    const ix = await setServiceListingState({
      listing,
      authority,
      state: "Paused",
    });
    const decoded = getSetServiceListingStateInstructionDataDecoder().decode(ix.data);
    expect(decoded.newState).toBe(ListingState.Paused);
    expect(decoded.newState).toBe(1);
  });
});

describe("hireFromListing (facade)", () => {
  const listing = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
  const creator = createNoopSigner(
    address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  );
  // P1.2: the moderator whose listing attestation the hire consumes.
  const moderator = address("9Y8Nt5Z3sYTLNm6n5jKj7c5y8C2y2H8gPq4y6t9q1aA");

  it("auto-derives the multi-PDA flow with correct order (P1.2: 14 with the BLOCK floor) and round-trips its data", async () => {
    const taskId = new Uint8Array(32).fill(5);
    const specHash = new Uint8Array(32).fill(9);
    const ix = await hireFromListing({
      listing,
      creatorAgent,
      authority,
      creator,
      taskId,
      expectedPrice: 1000n,
      expectedVersion: 1n,
      listingSpecHash: specHash,
      moderator,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    // P1.2 pins the gate at 14 accounts: WP-A1's 13 + the REQUIRED
    // moderationBlock (8); only listing/creatorAgent/authority/creator (and the
    // spec hash the moderation PDAs derive from) are caller-supplied.
    expect(ix.accounts.length).toBe(14);
    const accts = ix.accounts.map((a) => a.address);
    expect(accts[3]).toBe(listing);
    // listingModeration (6): facade-derived v2 moderator-keyed record PDA
    // ["listing_moderation_v2", listing, specHash, moderator].
    const [expectedModeration] = await findListingModerationPda({
      listing,
      jobSpecHash: specHash,
      moderator,
    });
    expect(accts[6]).toBe(expectedModeration);
    // moderationAttestor (7): global-authority path -> program-id placeholder.
    expect(accts[7]).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    // moderationBlock (8): REQUIRED BLOCK-floor PDA ["moderation_block", specHash].
    const [expectedBlock] = await findModerationBlockPda({
      contentHash: specHash,
    });
    expect(accts[8]).toBe(expectedBlock);
    expect(accts[9]).toBe(creatorAgent);
    expect(accts[11]).toBe(authority.address);
    expect(accts[12]).toBe(creator.address);
    expect(accts[13]).toBe(SYSTEM_PROGRAM);

    const decoded = getHireFromListingInstructionDataDecoder().decode(ix.data);
    expect(decoded.expectedPrice).toBe(1000n);
    expect(decoded.expectedVersion).toBe(1n);
    expect(Array.from(decoded.taskId)).toEqual(Array.from(taskId));
    expect(decoded.moderator).toBe(moderator); // P1.2: new arg
  });

  it("derives the roster-entry PDA when moderatorIsAttestor is set (P1.2 roster path)", async () => {
    const ix = await hireFromListing({
      listing,
      creatorAgent,
      authority,
      creator,
      taskId: new Uint8Array(32).fill(6),
      expectedPrice: 2000n,
      expectedVersion: 2n,
      listingSpecHash: new Uint8Array(32).fill(9),
      moderator,
      moderatorIsAttestor: true,
    });
    const [expectedAttestor] = await findModerationAttestorPda({
      attestor: moderator,
    });
    expect(ix.accounts[7].address).toBe(expectedAttestor);
  });

  it("throws when neither listingSpecHash nor moderationBlock is given (the BLOCK floor is required)", async () => {
    await expect(
      hireFromListing({
        listing,
        creatorAgent,
        authority,
        creator,
        taskId: new Uint8Array(32).fill(7),
        expectedPrice: 1000n,
        expectedVersion: 1n,
        moderator,
      }),
    ).rejects.toThrow(/listingSpecHash|moderationBlock/);
  });
});

describe("hireFromListingHumanless (facade)", () => {
  const listing = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
  // The human visitor wallet — NO registered agent.
  const creator = createNoopSigner(
    address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  );
  // P1.2: the moderator whose listing attestation the hire consumes.
  const moderator = address("9Y8Nt5Z3sYTLNm6n5jKj7c5y8C2y2H8gPq4y6t9q1aA");

  it("auto-derives the multi-PDA flow with correct order (P1.2: 13 with the BLOCK floor) and round-trips its data", async () => {
    const taskId = new Uint8Array(32).fill(5);
    const specHash = new Uint8Array(32).fill(9);
    const ix = await hireFromListingHumanless({
      listing,
      creator,
      taskId,
      expectedPrice: 1000n,
      expectedVersion: 1n,
      reviewWindowSecs: 3600n,
      listingSpecHash: specHash,
      moderator,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    // P1.2 pins the gate at 13 accounts (no creatorAgent — the buyer is a plain
    // wallet): WP-A1's 12 + the REQUIRED moderationBlock (9).
    expect(ix.accounts.length).toBe(13);
    const accts = ix.accounts.map((a) => a.address);
    expect(accts[4]).toBe(listing);
    // listingModeration (7): facade-derived v2 moderator-keyed record PDA.
    const [expectedModeration] = await findListingModerationPda({
      listing,
      jobSpecHash: specHash,
      moderator,
    });
    expect(accts[7]).toBe(expectedModeration);
    // moderationAttestor (8): global-authority path -> program-id placeholder.
    expect(accts[8]).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    // moderationBlock (9): REQUIRED BLOCK-floor PDA ["moderation_block", specHash].
    const [expectedBlock] = await findModerationBlockPda({
      contentHash: specHash,
    });
    expect(accts[9]).toBe(expectedBlock);
    expect(accts[11]).toBe(creator.address);
    expect(accts[12]).toBe(SYSTEM_PROGRAM);

    const decoded =
      getHireFromListingHumanlessInstructionDataDecoder().decode(ix.data);
    expect(decoded.expectedPrice).toBe(1000n);
    expect(decoded.expectedVersion).toBe(1n);
    expect(decoded.reviewWindowSecs).toBe(3600n);
    expect(Array.from(decoded.taskId)).toEqual(Array.from(taskId));
    expect(decoded.moderator).toBe(moderator); // P1.2: new arg
  });

  it("throws when neither listingSpecHash nor moderationBlock is given (the BLOCK floor is required)", async () => {
    await expect(
      hireFromListingHumanless({
        listing,
        creator,
        taskId: new Uint8Array(32).fill(6),
        expectedPrice: 2000n,
        expectedVersion: 2n,
        reviewWindowSecs: 3600n,
        moderator,
      }),
    ).rejects.toThrow(/listingSpecHash|moderationBlock/);
  });
});
