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

  it("auto-derives the multi-PDA flow with correct order and round-trips its data", async () => {
    const taskId = new Uint8Array(32).fill(5);
    const ix = await hireFromListing({
      listing,
      creatorAgent,
      authority,
      creator,
      taskId,
      expectedPrice: 1000n,
      expectedVersion: 1n,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    // 13 accounts in declared order; only listing/creatorAgent/authority/creator
    // are caller-supplied, the rest are derived.
    expect(ix.accounts.length).toBe(13);
    const accts = ix.accounts.map((a) => a.address);
    expect(accts[3]).toBe(listing);
    // WP-A1 inserts the OPTIONAL moderationAttestor roster account (7) right after
    // listingModeration (6); omitted here -> program-id placeholder, shifting
    // creatorAgent/authority/creator/systemProgram down one slot.
    expect(accts[7]).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS); // moderationAttestor omitted
    expect(accts[8]).toBe(creatorAgent);
    expect(accts[10]).toBe(authority.address);
    expect(accts[11]).toBe(creator.address);
    expect(accts[12]).toBe(SYSTEM_PROGRAM);

    const decoded = getHireFromListingInstructionDataDecoder().decode(ix.data);
    expect(decoded.expectedPrice).toBe(1000n);
    expect(decoded.expectedVersion).toBe(1n);
    expect(Array.from(decoded.taskId)).toEqual(Array.from(taskId));
  });

  it("derives listingModeration from listingSpecHash when given", async () => {
    const taskId = new Uint8Array(32).fill(6);
    const specHash = new Uint8Array(32).fill(9);
    const ix = await hireFromListing({
      listing,
      creatorAgent,
      authority,
      creator,
      taskId,
      expectedPrice: 2000n,
      expectedVersion: 2n,
      listingSpecHash: specHash,
    });

    const [expectedModeration] = await findListingModerationPda({
      listing,
      jobSpecHash: specHash,
    });
    // listingModeration sits at index 6 (between moderationConfig and creatorAgent).
    expect(ix.accounts[6].address).toBe(expectedModeration);
  });
});

describe("hireFromListingHumanless (facade)", () => {
  const listing = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
  // The human visitor wallet — NO registered agent.
  const creator = createNoopSigner(
    address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  );

  it("auto-derives the multi-PDA flow with correct order and round-trips its data", async () => {
    const taskId = new Uint8Array(32).fill(5);
    const ix = await hireFromListingHumanless({
      listing,
      creator,
      taskId,
      expectedPrice: 1000n,
      expectedVersion: 1n,
      reviewWindowSecs: 3600n,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    // 12 accounts in declared order (no creatorAgent — the buyer is a plain
    // wallet); only listing/creator are caller-supplied, the rest are derived.
    expect(ix.accounts.length).toBe(12);
    const accts = ix.accounts.map((a) => a.address);
    expect(accts[4]).toBe(listing);
    // WP-A1 inserts the OPTIONAL moderationAttestor roster account (8) right after
    // listingModeration (7); omitted here -> program-id placeholder, shifting
    // creator/systemProgram down one slot.
    expect(accts[8]).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS); // moderationAttestor omitted
    expect(accts[10]).toBe(creator.address);
    expect(accts[11]).toBe(SYSTEM_PROGRAM);

    const decoded =
      getHireFromListingHumanlessInstructionDataDecoder().decode(ix.data);
    expect(decoded.expectedPrice).toBe(1000n);
    expect(decoded.expectedVersion).toBe(1n);
    expect(decoded.reviewWindowSecs).toBe(3600n);
    expect(Array.from(decoded.taskId)).toEqual(Array.from(taskId));
  });

  it("derives listingModeration from listingSpecHash when given", async () => {
    const taskId = new Uint8Array(32).fill(6);
    const specHash = new Uint8Array(32).fill(9);
    const ix = await hireFromListingHumanless({
      listing,
      creator,
      taskId,
      expectedPrice: 2000n,
      expectedVersion: 2n,
      reviewWindowSecs: 3600n,
      listingSpecHash: specHash,
    });

    const [expectedModeration] = await findListingModerationPda({
      listing,
      jobSpecHash: specHash,
    });
    // listingModeration sits at index 7 (between moderationConfig and authorityRateLimit).
    expect(ix.accounts[7].address).toBe(expectedModeration);
  });
});
