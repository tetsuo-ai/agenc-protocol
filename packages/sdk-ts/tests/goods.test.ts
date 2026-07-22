import { describe, expect, it } from "vitest";
import {
  AccountRole,
  address,
  createNoopSigner,
  some,
  type Address,
  type TransactionSigner,
} from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  getCreateGoodsListingInstructionDataDecoder,
  getPurchaseGoodInstructionDataDecoder,
  getUpdateGoodsListingInstructionDataDecoder,
  findProtocolConfigPda,
} from "../src/index.js";
import {
  createGoodsListing,
  goodsModerationBlockPda,
  purchaseGood,
  updateGoodsListing,
  findGoodPda,
} from "../src/facade/goods.js";
import { encodeListingTags } from "../src/values/index.js";

const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const good = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
const sellerAgent = address("So11111111111111111111111111111111111111112");
const sellerWallet = address("Vote111111111111111111111111111111111111111");
const treasury = address("SysvarRent111111111111111111111111111111111");
const moderationBlock = address("ComputeBudget111111111111111111111111111111");
const authorityAddress = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

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

describe("createGoodsListing facade", () => {
  it("preserves account order and snapshots fixed bytes, tag arrays, options, and signer identity", async () => {
    const authority = mutableSigner(authorityAddress);
    const goodId = new Uint8Array(32).fill(11);
    const name = new Uint8Array(32).fill(12);
    const metadataHash = new Uint8Array(32).fill(13);
    const tags = ["digital-good", "limited"];
    const priceMint: { __option: "Some"; value: Address } = {
      __option: "Some",
      value: treasury,
    };
    const canonicalModerationBlock = (
      await goodsModerationBlockPda(metadataHash)
    )[0];
    const pending = createGoodsListing({
      seller: sellerAgent,
      moderationBlock: canonicalModerationBlock,
      authority: authority.signer,
      goodId,
      name,
      metadataHash,
      metadataUri: "https://goods.test/metadata.json",
      price: 25_000n,
      priceMint,
      tags,
      totalSupply: 5n,
    });

    goodId.fill(91);
    name.fill(92);
    metadataHash.fill(93);
    tags[0] = "attacker";
    tags.push("extra");
    priceMint.value = sellerWallet;
    authority.setAddress(good);

    const ix = await pending;
    const [expectedGood] = await findGoodPda({
      seller: sellerAgent,
      goodId: new Uint8Array(32).fill(11),
    });
    const [protocolConfig] = await findProtocolConfigPda();
    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((account) => account.address)).toEqual([
      expectedGood,
      sellerAgent,
      protocolConfig,
      canonicalModerationBlock,
      authorityAddress,
      SYSTEM_PROGRAM,
    ]);
    expect(ix.accounts.map((account) => account.role)).toEqual([
      AccountRole.WRITABLE,
      AccountRole.READONLY,
      AccountRole.READONLY,
      AccountRole.READONLY,
      AccountRole.WRITABLE_SIGNER,
      AccountRole.READONLY,
    ]);
    const decoded = getCreateGoodsListingInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.goodId).toEqual(new Uint8Array(32).fill(11));
    expect(decoded.name).toEqual(new Uint8Array(32).fill(12));
    expect(decoded.metadataHash).toEqual(new Uint8Array(32).fill(13));
    expect(decoded.priceMint).toEqual(some(treasury));
    expect(decoded.tags).toEqual(
      encodeListingTags(["digital-good", "limited"]),
    );
    expect(ix.accounts[4]).toMatchObject({
      address: authorityAddress,
      signer: authority.signer,
    });
  });

  it("rejects malformed tag containers without invoking entries", async () => {
    let tagReads = 0;
    const tags: string[] = [];
    Object.defineProperty(tags, "0", {
      configurable: true,
      enumerable: true,
      get() {
        tagReads += 1;
        return "digital-good";
      },
    });
    await expect(
      createGoodsListing({
        seller: sellerAgent,
        moderationBlock,
        authority: createNoopSigner(authorityAddress),
        goodId: new Uint8Array(32),
        name: "Good",
        metadataHash: new Uint8Array(32),
        metadataUri: "https://goods.test/metadata.json",
        price: 25_000n,
        priceMint: null,
        tags,
        totalSupply: 1n,
      }),
    ).rejects.toThrow(/tags.*dense/u);
    expect(tagReads).toBe(0);
  });
});

describe("purchaseGood facade", () => {
  it("appends the reviewed metadata hash to the serial/price CAS", async () => {
    const authority = createNoopSigner(authorityAddress);
    const expectedMetadataHash = new Uint8Array(32).fill(19);

    const ix = await purchaseGood({
      good,
      sellerAgent,
      sellerWallet,
      treasury,
      moderationBlock,
      authority,
      expectedSerial: 3n,
      expectedPrice: 25_000n,
      expectedMetadataHash,
    });

    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts[0]?.address).toBe(good);
    expect(ix.accounts[2]?.address).toBe(sellerAgent);
    expect(ix.accounts[3]?.address).toBe(sellerWallet);
    expect(ix.accounts[5]?.address).toBe(treasury);
    expect(ix.accounts[6]?.address).toBe(moderationBlock);
    expect(ix.accounts[7]?.address).toBe(authority.address);
    const decoded = getPurchaseGoodInstructionDataDecoder().decode(ix.data);
    expect(decoded.expectedSerial).toBe(3n);
    expect(decoded.expectedPrice).toBe(25_000n);
    expect(Array.from(ix.data.slice(-32))).toEqual(
      Array.from(expectedMetadataHash),
    );
  });

  it("detaches the reviewed metadata hash and locks the buyer identity", async () => {
    const authority = mutableSigner(authorityAddress);
    const expectedMetadataHash = new Uint8Array(32).fill(29);
    const pending = purchaseGood({
      good,
      sellerAgent,
      sellerWallet,
      treasury,
      moderationBlock,
      authority: authority.signer,
      expectedSerial: 4n,
      expectedPrice: 30_000n,
      expectedMetadataHash,
    });
    expectedMetadataHash.fill(99);
    authority.setAddress(good);

    const ix = await pending;
    const decoded = getPurchaseGoodInstructionDataDecoder().decode(ix.data);
    expect(decoded.expectedMetadataHash).toEqual(new Uint8Array(32).fill(29));
    expect(ix.accounts[7]).toMatchObject({
      address: authorityAddress,
      signer: authority.signer,
    });
  });
});

describe("updateGoodsListing facade", () => {
  it("detaches every mutable Option payload before protocol-PDA derivation", async () => {
    const authority = createNoopSigner(authorityAddress);
    const metadataBytes = new Uint8Array(32).fill(41);
    const tagBytes = new Uint8Array(64).fill(42);
    const metadataHash = {
      __option: "Some" as const,
      value: metadataBytes,
    };
    const metadataUri = {
      __option: "Some" as const,
      value: "https://goods.test/v2.json",
    };
    const tags = { __option: "Some" as const, value: tagBytes };
    const price = { __option: "Some" as const, value: 50_000n };
    const pending = updateGoodsListing({
      good,
      seller: sellerAgent,
      authority,
      price,
      isActive: null,
      metadataHash,
      metadataUri,
      tags,
      additionalSupply: null,
      operator: null,
      operatorFeeBps: null,
    });

    metadataBytes.fill(94);
    tagBytes.fill(95);
    metadataHash.value = new Uint8Array(32).fill(96);
    metadataUri.value = "https://attacker.test/v2.json";
    tags.value = new Uint8Array(64).fill(97);
    price.value = 1n;

    const ix = await pending;
    expect(ix.accounts.map((account) => account.address)).toEqual([
      good,
      sellerAgent,
      (await findProtocolConfigPda())[0],
      authorityAddress,
    ]);
    const decoded = getUpdateGoodsListingInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.price).toEqual(some(50_000n));
    expect(decoded.metadataHash).toEqual(some(new Uint8Array(32).fill(41)));
    expect(decoded.metadataUri).toEqual(some("https://goods.test/v2.json"));
    expect(decoded.tags).toEqual(some(new Uint8Array(64).fill(42)));
  });
});
