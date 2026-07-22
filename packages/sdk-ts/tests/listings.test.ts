import { runInNewContext } from "node:vm";
import { describe, it, expect } from "vitest";
import {
  AccountRole,
  address,
  createNoopSigner,
  type Address,
  type Option,
  type TransactionSigner,
} from "@solana/kit";
import {
  getCreateServiceListingInstructionDataDecoder,
  getUpdateServiceListingInstructionDataDecoder,
  getSetServiceListingStateInstructionDataDecoder,
  getHireFromListingInstructionDataDecoder,
  getHireFromListingHumanlessInstructionDataDecoder,
  getRateHireInstructionDataDecoder,
  findListingPda,
  findListingModerationPda,
  findModerationAttestorPda,
  findModerationBlockPda,
  findTaskPda,
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  HIRE_FROM_LISTING_DISCRIMINATOR,
  HIRE_FROM_LISTING_HUMANLESS_DISCRIMINATOR,
} from "../src/index.js";
import {
  createServiceListing,
  updateServiceListing,
  setServiceListingState,
  hireFromListing,
  hireFromListingHumanless,
  rateHire,
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

function mutableSigner(initialAddress: TransactionSigner["address"]): {
  signer: TransactionSigner;
  setAddress: (next: TransactionSigner["address"]) => void;
} {
  const base = createNoopSigner(initialAddress);
  let liveAddress = initialAddress;
  const signer = Object.create(base) as TransactionSigner;
  Object.defineProperty(signer, "address", {
    configurable: true,
    enumerable: true,
    get: () => liveAddress,
  });
  return {
    signer,
    setAddress(next) {
      liveAddress = next;
    },
  };
}

function invalidFixedByteViews(): Uint8Array[] {
  const proxy = new Proxy(new Uint8Array(32).fill(1), {});
  const detached = new Uint8Array(32).fill(1);
  structuredClone(detached, { transfer: [detached.buffer] });
  return [proxy, detached, new Uint8Array(new SharedArrayBuffer(32)).fill(1)];
}

function unwrapSome<T>(opt: Option<T>): T {
  expect(opt.__option).toBe("Some");
  if (opt.__option !== "Some") throw new Error("expected Some");
  return opt.value;
}

describe("listing facade async intent boundaries", () => {
  it("rejects an accessor-backed signer field without invoking it", async () => {
    let reads = 0;
    const input = {
      providerAgent,
      authority,
      listingId: new Uint8Array(32).fill(0x10),
      name: new Uint8Array(32).fill(0x11),
      category: new Uint8Array(32).fill(0x12),
      tags: new Uint8Array(64).fill(0x13),
      specHash: new Uint8Array(32).fill(0x14),
      specUri: "ipfs://accessor-rejected",
      price: 1n,
      priceMint: null,
      requiredCapabilities: 0n,
      defaultDeadlineSecs: 1n,
      maxOpenJobs: 1,
      operator: null,
      operatorFeeBps: 0,
    };
    Object.defineProperty(input, "authority", {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return authority;
      },
    });

    await expect(createServiceListing(input)).rejects.toThrow(
      "client facade signer field authority must be an own data property",
    );
    expect(reads).toBe(0);
  });

  it("normalizes bounded dense string tags without invoking caller methods", async () => {
    let callbacks = 0;
    const tags = ["safe-tag"];
    Object.defineProperties(tags, {
      join: {
        configurable: true,
        enumerable: false,
        value: () => {
          callbacks += 1;
          throw new Error("caller join invoked");
        },
      },
      [Symbol.iterator]: {
        configurable: true,
        enumerable: false,
        value: () => {
          callbacks += 1;
          throw new Error("caller iterator invoked");
        },
      },
    });
    const base = {
      providerAgent,
      authority,
      listingId: new Uint8Array(32).fill(0x20),
      name: "Safe Listing",
      category: "translation" as const,
      specHash: new Uint8Array(32).fill(0x21),
      specUri: "ipfs://bounded-tags",
      price: 1n,
      priceMint: null,
      requiredCapabilities: 0n,
      defaultDeadlineSecs: 1n,
      maxOpenJobs: 1,
      operator: null,
      operatorFeeBps: 0,
    };

    const decoded = getCreateServiceListingInstructionDataDecoder().decode(
      (await createServiceListing({ ...base, tags })).data,
    );
    expect(new TextDecoder().decode(decoded.tags).replace(/\0+$/u, "")).toBe(
      "safe-tag",
    );
    expect(callbacks).toBe(0);

    const sparse = new Array<string>(1);
    await expect(
      createServiceListing({ ...base, tags: sparse }),
    ).rejects.toThrow(/dense/u);
    await expect(
      createServiceListing({
        ...base,
        tags: new Array(33).fill("a"),
      }),
    ).rejects.toThrow(/at most 32/u);
  });

  it("snapshots every create byte field and the authority before PDA derivation", async () => {
    const selected = mutableSigner(authority.address);
    const moved = address("Stake11111111111111111111111111111111111111");
    const listingId = new Uint8Array(32).fill(0x11);
    const name = new Uint8Array(32).fill(0x12);
    const category = new Uint8Array(32).fill(0x13);
    const tags = new Uint8Array(64).fill(0x14);
    const specHash = new Uint8Array(32).fill(0x15);

    const pending = createServiceListing({
      providerAgent,
      authority: selected.signer,
      listingId,
      name,
      category,
      tags,
      specHash,
      specUri: "ipfs://snapshot",
      price: 1n,
      priceMint: null,
      requiredCapabilities: 0n,
      defaultDeadlineSecs: 1n,
      maxOpenJobs: 1,
      operator: null,
      operatorFeeBps: 0,
    });
    listingId.fill(0x91);
    name.fill(0x92);
    category.fill(0x93);
    tags.fill(0x94);
    specHash.fill(0x95);
    selected.setAddress(moved);

    const instruction = await pending;
    const decoded = getCreateServiceListingInstructionDataDecoder().decode(
      instruction.data,
    );
    expect(decoded.listingId).toEqual(new Uint8Array(32).fill(0x11));
    expect(decoded.name).toEqual(new Uint8Array(32).fill(0x12));
    expect(decoded.category).toEqual(new Uint8Array(32).fill(0x13));
    expect(decoded.tags).toEqual(new Uint8Array(64).fill(0x14));
    expect(decoded.specHash).toEqual(new Uint8Array(32).fill(0x15));
    expect(instruction.accounts[3].address).toBe(authority.address);
  });

  it("snapshots create price-mint and operator Option wrappers", async () => {
    const priceMint: { __option: "Some"; value: Address } = {
      __option: "Some",
      value: providerAgent,
    };
    const operator: { __option: "Some"; value: Address } = {
      __option: "Some",
      value: creatorAgent,
    };
    const pending = createServiceListing({
      providerAgent,
      authority,
      listingId: new Uint8Array(32).fill(0x16),
      name: new Uint8Array(32).fill(0x17),
      category: new Uint8Array(32).fill(0x18),
      tags: new Uint8Array(64).fill(0x19),
      specHash: new Uint8Array(32).fill(0x1a),
      specUri: "ipfs://option-snapshot",
      price: 1n,
      priceMint,
      requiredCapabilities: 0n,
      defaultDeadlineSecs: 1n,
      maxOpenJobs: 1,
      operator,
      operatorFeeBps: 0,
    });
    priceMint.value = SYSTEM_PROGRAM;
    operator.value = SYSTEM_PROGRAM;

    const decoded = getCreateServiceListingInstructionDataDecoder().decode(
      (await pending).data,
    );
    expect(decoded.priceMint).toEqual({
      __option: "Some",
      value: providerAgent,
    });
    expect(decoded.operator).toEqual({
      __option: "Some",
      value: creatorAgent,
    });
  });

  it("snapshots raw and explicit-Some update bytes", async () => {
    const specHash = new Uint8Array(32).fill(0x21);
    const tagBytes = new Uint8Array(64).fill(0x22);
    const tags = { __option: "Some" as const, value: tagBytes };
    const pending = updateServiceListing({
      listing: providerAgent,
      providerAgent,
      authority: createNoopSigner(authority.address),
      price: null,
      specHash,
      specUri: "ipfs://updated",
      tags,
      requiredCapabilities: null,
      defaultDeadlineSecs: null,
      maxOpenJobs: null,
      operator: null,
      operatorFeeBps: null,
    });
    specHash.fill(0xa1);
    tagBytes.fill(0xa2);
    tags.value = new Uint8Array(64).fill(0xa3);

    const decoded = getUpdateServiceListingInstructionDataDecoder().decode(
      (await pending).data,
    );
    expect(decoded.specHash).toEqual({
      __option: "Some",
      value: new Uint8Array(32).fill(0x21),
    });
    expect(decoded.tags).toEqual({
      __option: "Some",
      value: new Uint8Array(64).fill(0x22),
    });
  });

  it("snapshots every scalar and address update Option wrapper", async () => {
    const price = { __option: "Some" as const, value: 41n };
    const requiredCapabilities = {
      __option: "Some" as const,
      value: 42n,
    };
    const defaultDeadlineSecs = {
      __option: "Some" as const,
      value: 43n,
    };
    const maxOpenJobs = { __option: "Some" as const, value: 4 };
    const operator: { __option: "Some"; value: Address } = {
      __option: "Some",
      value: creatorAgent,
    };
    const operatorFeeBps = { __option: "Some" as const, value: 45 };
    const pending = updateServiceListing({
      listing: providerAgent,
      providerAgent,
      authority,
      price,
      specHash: null,
      specUri: null,
      tags: null,
      requiredCapabilities,
      defaultDeadlineSecs,
      maxOpenJobs,
      operator,
      operatorFeeBps,
    });
    price.value = 91n;
    requiredCapabilities.value = 92n;
    defaultDeadlineSecs.value = 93n;
    maxOpenJobs.value = 9;
    operator.value = SYSTEM_PROGRAM;
    operatorFeeBps.value = 95;

    const decoded = getUpdateServiceListingInstructionDataDecoder().decode(
      (await pending).data,
    );
    expect(unwrapSome(decoded.price)).toBe(41n);
    expect(unwrapSome(decoded.requiredCapabilities)).toBe(42n);
    expect(unwrapSome(decoded.defaultDeadlineSecs)).toBe(43n);
    expect(unwrapSome(decoded.maxOpenJobs)).toBe(4);
    expect(unwrapSome(decoded.operator)).toBe(creatorAgent);
    expect(unwrapSome(decoded.operatorFeeBps)).toBe(45);
  });

  it("snapshots rateHire review bytes and buyer identity", async () => {
    const selected = mutableSigner(authority.address);
    const reviewBytes = new Uint8Array(32).fill(0x31);
    const pending = rateHire({
      task: providerAgent,
      listing: providerAgent,
      buyer: selected.signer,
      score: 5,
      reviewHash: { __option: "Some", value: reviewBytes },
      reviewUri: "ipfs://review",
    });
    reviewBytes.fill(0xb1);
    selected.setAddress(address("Stake11111111111111111111111111111111111111"));

    const instruction = await pending;
    const decoded = getRateHireInstructionDataDecoder().decode(
      instruction.data,
    );
    expect(decoded.reviewHash).toEqual({
      __option: "Some",
      value: new Uint8Array(32).fill(0x31),
    });
    expect(instruction.accounts[5].address).toBe(authority.address);
  });

  it("rejects proxy/shared/detached raw fields before building", async () => {
    for (const bad of invalidFixedByteViews()) {
      await expect(
        createServiceListing({
          providerAgent,
          authority: createNoopSigner(authority.address),
          listingId: bad,
          name: new Uint8Array(32),
          category: new Uint8Array(32),
          tags: new Uint8Array(64),
          specHash: new Uint8Array(32).fill(1),
          specUri: "ipfs://invalid",
          price: 1n,
          priceMint: null,
          requiredCapabilities: 0n,
          defaultDeadlineSecs: 1n,
          maxOpenJobs: 1,
          operator: null,
          operatorFeeBps: 0,
        }),
      ).rejects.toThrow(/exactly 32 bytes/);
    }
  });
});

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
    const [expectedListing] = await findListingPda({
      providerAgent,
      listingId,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const accts = ix.accounts.map((a) => a.address);
    expect(accts[0]).toBe(expectedListing);
    expect(accts[1]).toBe(providerAgent);
    expect(accts[3]).toBe(authority.address);
    expect(accts[4]).toBe(SYSTEM_PROGRAM);
    expect(ix.accounts.length).toBe(5);

    const decoded = getCreateServiceListingInstructionDataDecoder().decode(
      ix.data,
    );
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
    const specHash = new Uint8Array(32).fill(8);
    const ix = await updateServiceListing({
      listing,
      providerAgent,
      authority,
      price: 5000n,
      specHash,
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
    expect(accts[1]).toBe(providerAgent);
    // accts[2] = protocolConfig (auto-derived), accts[3] = authority.
    expect(accts[3]).toBe(authority.address);
    expect(ix.accounts.length).toBe(4);

    const decoded = getUpdateServiceListingInstructionDataDecoder().decode(
      ix.data,
    );
    expect(unwrapSome(decoded.price)).toBe(5000n);
    expect(unwrapSome(decoded.specUri)).toBe("ipfs://new");
    expect(unwrapSome(decoded.maxOpenJobs)).toBe(10);
    expect(Array.from(unwrapSome(decoded.specHash))).toEqual(
      Array.from(specHash),
    );
    expect(decoded.tags.__option).toBe("None");
    expect(decoded.operator.__option).toBe("None");
  });

  it("rejects a partial spec update before instruction construction", async () => {
    await expect(
      updateServiceListing({
        listing,
        providerAgent,
        authority,
        price: null,
        specHash: null,
        specUri: "ipfs://orphaned-uri",
        tags: null,
        requiredCapabilities: null,
        defaultDeadlineSecs: null,
        maxOpenJobs: null,
        operator: null,
        operatorFeeBps: null,
      } as never),
    ).rejects.toThrow(/must be updated together/);
  });
});

describe("setServiceListingState (facade)", () => {
  const listing = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");

  it("accepts a raw newState, with right program, account order, and data round-trip", async () => {
    const ix = await setServiceListingState({
      listing,
      providerAgent,
      authority,
      newState: 2,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    const accts = ix.accounts.map((a) => a.address);
    expect(accts[0]).toBe(listing);
    expect(accts[2]).toBe(authority.address);
    expect(ix.accounts.length).toBe(3);

    const decoded = getSetServiceListingStateInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.newState).toBe(2);
  });

  it("maps a friendly state name to the matching u8", async () => {
    const ix = await setServiceListingState({
      listing,
      providerAgent,
      authority,
      state: "Paused",
    });
    const decoded = getSetServiceListingStateInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.newState).toBe(ListingState.Paused);
    expect(decoded.newState).toBe(1);
    expect(ix.accounts.length).toBe(3);

    const retired = await setServiceListingState({
      listing,
      authority,
      state: "Retired",
    });
    expect(
      getSetServiceListingStateInstructionDataDecoder().decode(retired.data)
        .newState,
    ).toBe(ListingState.Retired);
    expect(ListingState.Retired).toBe(2);
    // Source compatibility only; new callers should use the protocol term.
    expect(ListingState.Closed).toBe(ListingState.Retired);
  });

  it("requires and appends the provider proof only for reactivation", async () => {
    await expect(
      setServiceListingState({ listing, authority, state: "Active" }),
    ).rejects.toThrow(/providerAgent is required/);

    const ix = await setServiceListingState({
      listing,
      providerAgent,
      authority,
      state: "Active",
    });
    expect(ix.accounts.length).toBe(4);
    expect(ix.accounts[3]!.address).toBe(providerAgent);
    expect(ix.accounts[3]!.role).toBe(AccountRole.READONLY);
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
    const taskJobSpecHash = new Uint8Array(32).fill(10);
    const ix = await hireFromListing({
      listing,
      providerAgent,
      creatorAgent,
      authority,
      creator,
      taskId,
      expectedPrice: 1000n,
      expectedVersion: 1n,
      listingSpecHash: specHash,
      taskJobSpecHash,
      moderator,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    // P1.2 pins the gate at 15 accounts, including the immutable provider
    // binding and the REQUIRED moderationBlock.
    expect(ix.accounts.length).toBe(15);
    const accts = ix.accounts.map((a) => a.address);
    expect(accts[3]).toBe(listing);
    expect(accts[4]).toBe(providerAgent);
    // listingModeration (7): facade-derived v2 moderator-keyed record PDA
    // ["listing_moderation_v2", listing, specHash, moderator].
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
    expect(accts[10]).toBe(creatorAgent);
    expect(accts[12]).toBe(authority.address);
    expect(accts[13]).toBe(creator.address);
    expect(accts[14]).toBe(SYSTEM_PROGRAM);

    const decoded = getHireFromListingInstructionDataDecoder().decode(ix.data);
    expect(Array.from(decoded.discriminator)).toEqual(
      Array.from(HIRE_FROM_LISTING_DISCRIMINATOR),
    );
    expect(Array.from(decoded.discriminator)).toEqual([
      241, 94, 127, 7, 104, 174, 240, 116,
    ]);
    expect(decoded.expectedPrice).toBe(1000n);
    expect(decoded.expectedVersion).toBe(1n);
    expect(Array.from(decoded.taskId)).toEqual(Array.from(taskId));
    expect(decoded.moderator).toBe(moderator); // P1.2: new arg
    expect(Array.from(decoded.taskJobSpecHash)).toEqual(
      Array.from(taskJobSpecHash),
    );
  });

  it("derives the roster-entry PDA when moderatorIsAttestor is set (P1.2 roster path)", async () => {
    const ix = await hireFromListing({
      listing,
      providerAgent,
      creatorAgent,
      authority,
      creator,
      taskId: new Uint8Array(32).fill(6),
      expectedPrice: 2000n,
      expectedVersion: 2n,
      listingSpecHash: new Uint8Array(32).fill(9),
      taskJobSpecHash: new Uint8Array(32).fill(10),
      moderator,
      moderatorIsAttestor: true,
    });
    const [expectedAttestor] = await findModerationAttestorPda({
      attestor: moderator,
    });
    expect(ix.accounts[8].address).toBe(expectedAttestor);
  });

  it("throws when neither listingSpecHash nor moderationBlock is given (the BLOCK floor is required)", async () => {
    await expect(
      hireFromListing({
        listing,
        providerAgent,
        creatorAgent,
        authority,
        creator,
        taskId: new Uint8Array(32).fill(7),
        expectedPrice: 1000n,
        expectedVersion: 1n,
        taskJobSpecHash: new Uint8Array(32).fill(10),
        moderator,
      }),
    ).rejects.toThrow(/listingSpecHash|moderationBlock/);
  });

  it("rejects task commitments the generated fixed encoder would alter", async () => {
    for (const bad of [
      new Uint8Array(31).fill(1),
      new Uint8Array(33).fill(1),
      new Uint8Array(32),
    ]) {
      await expect(
        hireFromListing({
          listing,
          providerAgent,
          creatorAgent,
          authority,
          creator,
          taskId: new Uint8Array(32).fill(8),
          expectedPrice: 1000n,
          expectedVersion: 1n,
          listingSpecHash: new Uint8Array(32).fill(9),
          taskJobSpecHash: bad,
          moderator,
        }),
      ).rejects.toThrow(/exactly 32 bytes|all zeroes/);
    }
  });

  it("snapshots bytes, same-address signer identity, and signer address before its first await", async () => {
    const originalAddress = address(
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    );
    const movedAddress = address("Stake11111111111111111111111111111111111111");
    const first = mutableSigner(originalAddress);
    const second = mutableSigner(originalAddress);
    const taskId = new Uint8Array(32).fill(0x31);
    const listingSpecHash = new Uint8Array(32).fill(0x32);
    const taskJobSpecHash = new Uint8Array(32).fill(0x33);
    const expectedTaskId = taskId.slice();
    const expectedListingHash = listingSpecHash.slice();
    const expectedJobHash = taskJobSpecHash.slice();

    const pending = hireFromListing({
      listing,
      providerAgent,
      creatorAgent,
      authority: first.signer,
      creator: second.signer,
      taskId,
      expectedPrice: 1000n,
      expectedVersion: 1n,
      listingSpecHash,
      taskJobSpecHash,
      moderator,
    });
    taskId.fill(0x41);
    listingSpecHash.fill(0x42);
    taskJobSpecHash.fill(0x43);
    first.setAddress(movedAddress);
    second.setAddress(movedAddress);

    const ix = await pending;
    const decoded = getHireFromListingInstructionDataDecoder().decode(ix.data);
    const [expectedTask] = await findTaskPda({
      creator: originalAddress,
      taskId: expectedTaskId,
    });
    const [expectedModeration] = await findListingModerationPda({
      listing,
      jobSpecHash: expectedListingHash,
      moderator,
    });
    expect(decoded.taskId).toEqual(expectedTaskId);
    expect(decoded.taskJobSpecHash).toEqual(expectedJobHash);
    expect(ix.accounts[0].address).toBe(expectedTask);
    expect(ix.accounts[7].address).toBe(expectedModeration);
    expect(ix.accounts[12].address).toBe(originalAddress);
    expect(ix.accounts[13].address).toBe(originalAddress);
    expect("signer" in ix.accounts[12] && ix.accounts[12].signer).toBe(
      "signer" in ix.accounts[13] ? ix.accounts[13].signer : undefined,
    );
  });

  it("accepts cross-realm bytes by value and rejects proxy/shared/detached bytes", async () => {
    const ForeignUint8Array = runInNewContext(
      "Uint8Array",
    ) as Uint8ArrayConstructor;
    const foreignTaskId = new ForeignUint8Array(32).fill(0x51);
    const expected = new Uint8Array(foreignTaskId);
    const pending = hireFromListing({
      listing,
      providerAgent,
      creatorAgent,
      authority,
      creator,
      taskId: foreignTaskId,
      expectedPrice: 1000n,
      expectedVersion: 1n,
      listingSpecHash: new ForeignUint8Array(32).fill(0x52),
      taskJobSpecHash: new ForeignUint8Array(32).fill(0x53),
      moderator,
    });
    foreignTaskId.fill(0x61);
    expect(
      getHireFromListingInstructionDataDecoder().decode((await pending).data)
        .taskId,
    ).toEqual(expected);

    for (const bad of invalidFixedByteViews()) {
      await expect(
        hireFromListing({
          listing,
          providerAgent,
          creatorAgent,
          authority,
          creator,
          taskId: new Uint8Array(32).fill(1),
          expectedPrice: 1000n,
          expectedVersion: 1n,
          listingSpecHash: new Uint8Array(32).fill(2),
          taskJobSpecHash: bad,
          moderator,
        }),
      ).rejects.toThrow(/exactly 32 bytes/);
    }
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
    const taskJobSpecHash = new Uint8Array(32).fill(10);
    const ix = await hireFromListingHumanless({
      listing,
      providerAgent,
      creator,
      taskId,
      expectedPrice: 1000n,
      expectedVersion: 1n,
      reviewWindowSecs: 3600n,
      listingSpecHash: specHash,
      taskJobSpecHash,
      moderator,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    // P1.2 pins the gate at 14 accounts (no creatorAgent), including the
    // immutable provider binding and the REQUIRED moderationBlock.
    expect(ix.accounts.length).toBe(14);
    const accts = ix.accounts.map((a) => a.address);
    expect(accts[4]).toBe(listing);
    expect(accts[5]).toBe(providerAgent);
    // listingModeration (8): facade-derived v2 moderator-keyed record PDA.
    const [expectedModeration] = await findListingModerationPda({
      listing,
      jobSpecHash: specHash,
      moderator,
    });
    expect(accts[8]).toBe(expectedModeration);
    // moderationAttestor (9): global-authority path -> program-id placeholder.
    expect(accts[9]).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    // moderationBlock (10): REQUIRED BLOCK-floor PDA ["moderation_block", specHash].
    const [expectedBlock] = await findModerationBlockPda({
      contentHash: specHash,
    });
    expect(accts[10]).toBe(expectedBlock);
    expect(accts[12]).toBe(creator.address);
    expect(accts[13]).toBe(SYSTEM_PROGRAM);

    const decoded = getHireFromListingHumanlessInstructionDataDecoder().decode(
      ix.data,
    );
    expect(Array.from(decoded.discriminator)).toEqual(
      Array.from(HIRE_FROM_LISTING_HUMANLESS_DISCRIMINATOR),
    );
    expect(Array.from(decoded.discriminator)).toEqual([
      229, 163, 171, 114, 38, 116, 215, 85,
    ]);
    expect(decoded.expectedPrice).toBe(1000n);
    expect(decoded.expectedVersion).toBe(1n);
    expect(decoded.reviewWindowSecs).toBe(3600n);
    expect(Array.from(decoded.taskId)).toEqual(Array.from(taskId));
    expect(decoded.moderator).toBe(moderator); // P1.2: new arg
    expect(Array.from(decoded.taskJobSpecHash)).toEqual(
      Array.from(taskJobSpecHash),
    );
  });

  it("throws when neither listingSpecHash nor moderationBlock is given (the BLOCK floor is required)", async () => {
    await expect(
      hireFromListingHumanless({
        listing,
        providerAgent,
        creator,
        taskId: new Uint8Array(32).fill(6),
        expectedPrice: 2000n,
        expectedVersion: 2n,
        reviewWindowSecs: 3600n,
        taskJobSpecHash: new Uint8Array(32).fill(10),
        moderator,
      }),
    ).rejects.toThrow(/listingSpecHash|moderationBlock/);
  });

  it("rejects zero task commitments before storefront funding", async () => {
    await expect(
      hireFromListingHumanless({
        listing,
        providerAgent,
        creator,
        taskId: new Uint8Array(32).fill(7),
        expectedPrice: 1000n,
        expectedVersion: 1n,
        reviewWindowSecs: 3600n,
        listingSpecHash: new Uint8Array(32).fill(9),
        taskJobSpecHash: new Uint8Array(32),
        moderator,
      }),
    ).rejects.toThrow(/all zeroes/);
  });

  it("snapshots bytes, signer identity, and explicit Option referrers before awaiting", async () => {
    const originalAddress = address(
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    );
    const movedAddress = address("Stake11111111111111111111111111111111111111");
    const selected = mutableSigner(originalAddress);
    const taskId = new Uint8Array(32).fill(0x71);
    const taskJobSpecHash = new Uint8Array(32).fill(0x72);
    const expectedTaskId = taskId.slice();
    const expectedJobHash = taskJobSpecHash.slice();
    const referrer = {
      __option: "Some" as const,
      value: providerAgent as Address,
    };

    const pending = hireFromListingHumanless({
      listing,
      providerAgent,
      creator: selected.signer,
      taskId,
      expectedPrice: 1000n,
      expectedVersion: 1n,
      reviewWindowSecs: 3600n,
      listingSpecHash: new Uint8Array(32).fill(0x73),
      taskJobSpecHash,
      moderator,
      referrer,
      referrerFeeBps: 25,
    });
    taskId.fill(0x81);
    taskJobSpecHash.fill(0x82);
    referrer.value = movedAddress;
    selected.setAddress(movedAddress);

    const ix = await pending;
    const decoded = getHireFromListingHumanlessInstructionDataDecoder().decode(
      ix.data,
    );
    const [expectedTask] = await findTaskPda({
      creator: originalAddress,
      taskId: expectedTaskId,
    });
    expect(decoded.taskId).toEqual(expectedTaskId);
    expect(decoded.taskJobSpecHash).toEqual(expectedJobHash);
    expect(decoded.referrer).toEqual({
      __option: "Some",
      value: providerAgent,
    });
    expect(ix.accounts[0].address).toBe(expectedTask);
    expect(ix.accounts[12].address).toBe(originalAddress);
  });

  it("accepts cross-realm bytes and rejects proxy/shared/detached bytes", async () => {
    const ForeignUint8Array = runInNewContext(
      "Uint8Array",
    ) as Uint8ArrayConstructor;
    const foreign = new ForeignUint8Array(32).fill(0x44);
    const expected = new Uint8Array(foreign);
    const pending = hireFromListingHumanless({
      listing,
      providerAgent,
      creator,
      taskId: foreign,
      expectedPrice: 1000n,
      expectedVersion: 1n,
      reviewWindowSecs: 3600n,
      listingSpecHash: new ForeignUint8Array(32).fill(0x45),
      taskJobSpecHash: new ForeignUint8Array(32).fill(0x46),
      moderator,
    });
    foreign.fill(0x54);
    expect(
      getHireFromListingHumanlessInstructionDataDecoder().decode(
        (await pending).data,
      ).taskId,
    ).toEqual(expected);

    for (const bad of invalidFixedByteViews()) {
      await expect(
        hireFromListingHumanless({
          listing,
          providerAgent,
          creator,
          taskId: new Uint8Array(32).fill(1),
          expectedPrice: 1000n,
          expectedVersion: 1n,
          reviewWindowSecs: 3600n,
          listingSpecHash: new Uint8Array(32).fill(2),
          taskJobSpecHash: bad,
          moderator,
        }),
      ).rejects.toThrow(/exactly 32 bytes/);
    }
  });
});
