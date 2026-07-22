import { describe, it, expect } from "vitest";
import {
  AccountRole,
  address,
  createNoopSigner,
  none,
  some,
  type Address,
  type TransactionSigner,
} from "@solana/kit";
import {
  // stake / reputation
  getStakeReputationInstruction,
  getStakeReputationInstructionDataDecoder,
  getWithdrawReputationStakeInstruction,
  getWithdrawReputationStakeInstructionDataDecoder,
  getDelegateReputationInstruction,
  getDelegateReputationInstructionDataDecoder,
  getRevokeDelegationInstruction,
  getRevokeDelegationInstructionDataDecoder,
  // skills
  getRegisterSkillInstruction,
  getRegisterSkillInstructionDataDecoder,
  getUpdateSkillInstruction,
  getUpdateSkillInstructionDataDecoder,
  getRateSkillInstruction,
  getRateSkillInstructionDataDecoder,
  getPurchaseSkillInstruction,
  getPurchaseSkillInstructionDataDecoder,
  // social
  getPostToFeedInstruction,
  getPostToFeedInstructionDataDecoder,
  getUpvotePostInstruction,
  getUpvotePostInstructionDataDecoder,
  findProtocolConfigPda,
  AGENC_COORDINATION_PROGRAM_ADDRESS,
} from "../src/index.js";
import {
  stakeReputation,
  withdrawReputationStake,
  delegateReputation,
  revokeDelegation,
  findDelegationPda,
  registerSkill,
  updateSkill,
  rateSkill,
  purchaseSkill,
  postToFeed,
  upvotePost,
} from "../src/facade/reputation.js";

// Structural tests (the facade-loop template): build the instruction and assert
// program address, account order, and that the encoded data round-trips through
// the matching decoder. Deterministic, no VM — validates the generated builder +
// the facade wiring against the IDL.

const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// Reusable valid base58 placeholders.
const A1 = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
const A2 = address("So11111111111111111111111111111111111111112");
const A3 = address("SysvarRent111111111111111111111111111111111");
const A4 = address("Stake11111111111111111111111111111111111111");
const A5 = address("Vote111111111111111111111111111111111111111");
const A6 = address("ComputeBudget111111111111111111111111111111");
const A7 = address("Config1111111111111111111111111111111111111");

const signerAddr = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

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

describe("reputation facade — staking & delegation", () => {
  it("stakeReputation: program, account order, data round-trip", () => {
    const authority = createNoopSigner(signerAddr);
    const ix = getStakeReputationInstruction({
      authority,
      agent: A1,
      reputationStake: A2,
      protocolConfig: A3,
      amount: 5000n,
    });
    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      authority.address,
      A1,
      A2,
      A3,
      SYSTEM_PROGRAM,
    ]);
    const decoded = getStakeReputationInstructionDataDecoder().decode(ix.data);
    expect(decoded.amount).toBe(5000n);
  });

  it("withdrawReputationStake: program, account order, data round-trip", () => {
    const authority = createNoopSigner(signerAddr);
    const ix = getWithdrawReputationStakeInstruction({
      authority,
      agent: A1,
      reputationStake: A2,
      amount: 1234n,
    });
    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      authority.address,
      A1,
      A2,
    ]);
    const decoded = getWithdrawReputationStakeInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.amount).toBe(1234n);
  });

  it("delegateReputation: program, account order, data round-trip", () => {
    const authority = createNoopSigner(signerAddr);
    const ix = getDelegateReputationInstruction({
      authority,
      delegatorAgent: A1,
      delegateeAgent: A2,
      delegation: A3,
      amount: 250,
      expiresAt: 1_700_000_000n,
    });
    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      authority.address,
      A1,
      A2,
      A3,
      SYSTEM_PROGRAM,
    ]);
    const decoded = getDelegateReputationInstructionDataDecoder().decode(
      ix.data,
    );
    expect(decoded.amount).toBe(250);
    expect(decoded.expiresAt).toBe(1_700_000_000n);
  });

  it("revokeDelegation: program, account order, data round-trip", () => {
    const ix = getRevokeDelegationInstruction({
      authority: signerAddr,
      delegatorAgent: A1,
      delegation: A2,
    });
    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([signerAddr, A1, A2]);
    expect(ix.accounts[0]!.role).toBe(AccountRole.WRITABLE);
    // No args beyond the discriminator — decoding must still succeed.
    const decoded = getRevokeDelegationInstructionDataDecoder().decode(ix.data);
    expect(decoded.discriminator.length).toBe(8);
  });
});

describe("reputation facade — skills", () => {
  it("registerSkill: program, account order, data round-trip", () => {
    const authority = createNoopSigner(signerAddr);
    const skillId = new Uint8Array(32).fill(3);
    const name = new Uint8Array(32).fill(65);
    const contentHash = new Uint8Array(32).fill(9);
    const tags = new Uint8Array(64).fill(1);
    const ix = getRegisterSkillInstruction({
      skill: A1,
      author: A2,
      protocolConfig: A3,
      authority,
      skillId,
      name,
      contentHash,
      price: 1_000_000n,
      priceMint: null,
      tags,
    });
    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      A1,
      A2,
      A3,
      authority.address,
      SYSTEM_PROGRAM,
    ]);
    const decoded = getRegisterSkillInstructionDataDecoder().decode(ix.data);
    expect(decoded.price).toBe(1_000_000n);
    expect(Array.from(decoded.skillId)).toEqual(Array.from(skillId));
    expect(Array.from(decoded.tags)).toEqual(Array.from(tags));
    expect(decoded.priceMint).toEqual(none());
  });

  it("updateSkill: program, account order, data round-trip", () => {
    const authority = createNoopSigner(signerAddr);
    const contentHash = new Uint8Array(32).fill(7);
    const ix = getUpdateSkillInstruction({
      skill: A1,
      author: A2,
      protocolConfig: A3,
      authority,
      contentHash,
      price: 42n,
      tags: null,
      isActive: some(true),
    });
    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      A1,
      A2,
      A3,
      authority.address,
    ]);
    const decoded = getUpdateSkillInstructionDataDecoder().decode(ix.data);
    expect(decoded.price).toBe(42n);
    expect(decoded.tags).toEqual(none());
    expect(decoded.isActive).toEqual(some(true));
  });

  it("rateSkill: program, account order (renamed purchaseRecord PDA), data round-trip", () => {
    const authority = createNoopSigner(signerAddr);
    const ix = getRateSkillInstruction({
      skill: A1,
      ratingAccount: A2,
      rater: A3,
      purchaseRecord: A4,
      authorAgent: A5,
      protocolConfig: A6,
      authority,
      rating: 5,
      reviewHash: null,
    });
    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      A1,
      A2,
      A3,
      A4,
      A5,
      A6,
      authority.address,
      SYSTEM_PROGRAM,
    ]);
    const decoded = getRateSkillInstructionDataDecoder().decode(ix.data);
    expect(decoded.rating).toBe(5);
    expect(decoded.reviewHash).toEqual(none());
  });

  it("purchaseSkill: program, account order, data round-trip", () => {
    const authority = createNoopSigner(signerAddr);
    const expectedContentHash = new Uint8Array(32).fill(8);
    const ix = getPurchaseSkillInstruction({
      skill: A1,
      purchaseRecord: A2,
      buyer: A3,
      authorAgent: A4,
      authorWallet: A5,
      protocolConfig: A6,
      treasury: A7,
      authority,
      // priceMint / token accounts omitted -> default to program id sentinel
      expectedPrice: 7_777n,
      expectedVersion: 3,
      expectedContentHash,
    });
    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.slice(0, 9).map((a) => a.address)).toEqual([
      A1,
      A2,
      A3,
      A4,
      A5,
      A6,
      A7,
      authority.address,
      SYSTEM_PROGRAM,
    ]);
    // Optional accounts default to the program-id sentinel; tokenProgram defaults
    // to the SPL token program. There are 14 metas total.
    expect(ix.accounts.length).toBe(14);
    expect(ix.accounts[13]!.address).toBe(TOKEN_PROGRAM);
    const decoded = getPurchaseSkillInstructionDataDecoder().decode(ix.data);
    expect(decoded.expectedPrice).toBe(7_777n);
    expect(decoded.expectedVersion).toBe(3);
    expect(Array.from(decoded.expectedContentHash)).toEqual(
      Array.from(expectedContentHash),
    );
  });
});

describe("reputation facade — social feed", () => {
  it("postToFeed: program, account order, data round-trip", () => {
    const authority = createNoopSigner(signerAddr);
    const contentHash = new Uint8Array(32).fill(2);
    const nonce = new Uint8Array(32).fill(8);
    const topic = new Uint8Array(32).fill(4);
    const ix = getPostToFeedInstruction({
      post: A1,
      author: A2,
      protocolConfig: A3,
      authority,
      contentHash,
      nonce,
      topic,
      parentPost: null,
    });
    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      A1,
      A2,
      A3,
      authority.address,
      SYSTEM_PROGRAM,
    ]);
    const decoded = getPostToFeedInstructionDataDecoder().decode(ix.data);
    expect(Array.from(decoded.nonce)).toEqual(Array.from(nonce));
    expect(Array.from(decoded.topic)).toEqual(Array.from(topic));
    expect(decoded.parentPost).toEqual(none());
  });

  it("upvotePost: program, account order, data round-trip", () => {
    const authority = createNoopSigner(signerAddr);
    const ix = getUpvotePostInstruction({
      post: A1,
      vote: A2,
      voter: A3,
      protocolConfig: A4,
      authority,
    });
    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts.map((a) => a.address)).toEqual([
      A1,
      A2,
      A3,
      A4,
      authority.address,
      SYSTEM_PROGRAM,
    ]);
    const decoded = getUpvotePostInstructionDataDecoder().decode(ix.data);
    expect(decoded.discriminator.length).toBe(8);
  });
});

describe("reputation facade — async builders auto-derive PDAs", () => {
  it("stakeReputation derives the reputationStake PDA and keeps account order", async () => {
    const authority = createNoopSigner(signerAddr);
    const ix = await stakeReputation({ authority, agent: A1, amount: 100n });
    expect(ix.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(ix.accounts[0]!.address).toBe(authority.address);
    expect(ix.accounts[1]!.address).toBe(A1);
    // reputationStake (idx 2) is derived: not the agent, not the system program.
    expect(ix.accounts[2]!.address).not.toBe(A1);
    const [protocolConfig] = await findProtocolConfigPda();
    expect(ix.accounts[3]!.address).toBe(protocolConfig);
    expect(ix.accounts[4]!.address).toBe(SYSTEM_PROGRAM);
    expect(
      getStakeReputationInstructionDataDecoder().decode(ix.data).amount,
    ).toBe(100n);
  });

  it("withdrawReputationStake derives the reputationStake PDA", async () => {
    const authority = createNoopSigner(signerAddr);
    const ix = await withdrawReputationStake({
      authority,
      agent: A1,
      amount: 9n,
    });
    expect(ix.accounts.length).toBe(3);
    expect(ix.accounts[1]!.address).toBe(A1);
    expect(ix.accounts[2]!.address).not.toBe(A1);
  });

  it("delegateReputation derives the delegation PDA", async () => {
    const authority = createNoopSigner(signerAddr);
    const ix = await delegateReputation({
      authority,
      delegatorAgent: A1,
      delegateeAgent: A2,
      amount: 10,
      expiresAt: 0n,
    });
    expect(ix.accounts.length).toBe(5);
    expect(ix.accounts[1]!.address).toBe(A1);
    expect(ix.accounts[2]!.address).toBe(A2);
    expect(ix.accounts[4]!.address).toBe(SYSTEM_PROGRAM);
  });

  it("revokeDelegation derives the delegation PDA from the agent pair", async () => {
    const authority = createNoopSigner(signerAddr);
    const derived = await revokeDelegation({
      authority,
      delegatorAgent: A1,
      delegateeAgent: A2,
    });
    expect(derived.programAddress).toBe(AGENC_COORDINATION_PROGRAM_ADDRESS);
    expect(derived.accounts.length).toBe(3);
    expect(derived.accounts[0]!.address).toBe(authority.address);
    expect(derived.accounts[1]!.address).toBe(A1);
    // The derived delegation PDA must match an independent derivation with the
    // correct seed order (delegator, then delegatee) — guards against a seed swap.
    const [expectedDelegation] = await findDelegationPda({
      delegatorAgent: A1,
      delegateeAgent: A2,
    });
    expect(derived.accounts[2]!.address).toBe(expectedDelegation);
    // And the explicit-address path must round-trip the same PDA.
    const explicit = await revokeDelegation({
      authority,
      delegatorAgent: A1,
      delegation: derived.accounts[2]!.address,
    });
    expect(explicit.accounts[2]!.address).toBe(derived.accounts[2]!.address);
  });

  it("revokeDelegation appends the exact orphan-recovery account suffix", async () => {
    const authority = createNoopSigner(signerAddr);
    const [protocolConfig] = await findProtocolConfigPda();
    const ix = await revokeDelegation({
      authority,
      delegatorAgent: A1,
      delegation: A2,
      recovery: { treasury: A3 },
    });

    expect(ix.accounts.map((account) => account.address)).toEqual([
      authority.address,
      A1,
      A2,
      protocolConfig,
      A3,
    ]);
    expect(ix.accounts.map((account) => account.role)).toEqual([
      AccountRole.WRITABLE,
      AccountRole.WRITABLE,
      AccountRole.WRITABLE,
      AccountRole.READONLY,
      AccountRole.WRITABLE,
    ]);
  });

  it("registerSkill defaults priceMint to null and derives skill + protocolConfig", async () => {
    const authority = createNoopSigner(signerAddr);
    const ix = await registerSkill({
      author: A2,
      authority,
      skillId: new Uint8Array(32).fill(1),
      name: new Uint8Array(32).fill(2),
      contentHash: new Uint8Array(32).fill(3),
      price: 0n,
      tags: new Uint8Array(64),
    });
    expect(ix.accounts.length).toBe(5);
    expect(ix.accounts[1]!.address).toBe(A2);
    expect(ix.accounts[3]!.address).toBe(authority.address);
    expect(ix.accounts[4]!.address).toBe(SYSTEM_PROGRAM);
    expect(
      getRegisterSkillInstructionDataDecoder().decode(ix.data).priceMint,
    ).toEqual(none());
  });

  it("rateSkill derives the renamed rateSkillPurchaseRecord PDA", async () => {
    const authority = createNoopSigner(signerAddr);
    const ix = await rateSkill({
      skill: A1,
      rater: A3,
      authorAgent: A4,
      authority,
      rating: 4,
    });
    expect(ix.accounts.length).toBe(8);
    expect(ix.accounts[0]!.address).toBe(A1);
    expect(ix.accounts[2]!.address).toBe(A3);
    // ratingAccount (1) and purchaseRecord (3) are distinct derived PDAs.
    expect(ix.accounts[1]!.address).not.toBe(ix.accounts[3]!.address);
    expect(ix.accounts[4]!.address).toBe(A4);
    expect(ix.accounts[7]!.address).toBe(SYSTEM_PROGRAM);
    expect(getRateSkillInstructionDataDecoder().decode(ix.data).rating).toBe(4);
  });

  it("postToFeed defaults parentPost to null and derives post + protocolConfig", async () => {
    const authority = createNoopSigner(signerAddr);
    const ix = await postToFeed({
      author: A2,
      authority,
      contentHash: new Uint8Array(32),
      nonce: new Uint8Array(32).fill(5),
      topic: new Uint8Array(32),
    });
    expect(ix.accounts.length).toBe(5);
    expect(ix.accounts[1]!.address).toBe(A2);
    expect(ix.accounts[4]!.address).toBe(SYSTEM_PROGRAM);
    expect(
      getPostToFeedInstructionDataDecoder().decode(ix.data).parentPost,
    ).toEqual(none());
  });

  it("upvotePost derives the vote + protocolConfig PDAs", async () => {
    const authority = createNoopSigner(signerAddr);
    const ix = await upvotePost({ post: A1, voter: A3, authority });
    expect(ix.accounts.length).toBe(6);
    expect(ix.accounts[0]!.address).toBe(A1);
    expect(ix.accounts[2]!.address).toBe(A3);
    expect(ix.accounts[5]!.address).toBe(SYSTEM_PROGRAM);
  });

  it("updateSkill defaults tags/isActive to null and derives protocolConfig", async () => {
    const authority = createNoopSigner(signerAddr);
    const ix = await updateSkill({
      skill: A1,
      author: A2,
      authority,
      contentHash: new Uint8Array(32).fill(6),
      price: 5n,
    });
    expect(ix.accounts.length).toBe(4);
    expect(ix.accounts[0]!.address).toBe(A1);
    expect(ix.accounts[1]!.address).toBe(A2);
    expect(ix.accounts[3]!.address).toBe(authority.address);
    const decoded = getUpdateSkillInstructionDataDecoder().decode(ix.data);
    expect(decoded.tags).toEqual(none());
    expect(decoded.isActive).toEqual(none());
  });

  it("purchaseSkill derives purchaseRecord/protocolConfig and defaults programs", async () => {
    const authority = createNoopSigner(signerAddr);
    const expectedContentHash = new Uint8Array(32).fill(6);
    const ix = await purchaseSkill({
      skill: A1,
      buyer: A3,
      authorAgent: A4,
      authorWallet: A5,
      treasury: A7,
      authority,
      expectedPrice: 1n,
      expectedVersion: 4,
      expectedContentHash,
    });
    expect(ix.accounts.length).toBe(14);
    expect(ix.accounts[0]!.address).toBe(A1);
    expect(ix.accounts[2]!.address).toBe(A3);
    expect(ix.accounts[8]!.address).toBe(SYSTEM_PROGRAM);
    expect(ix.accounts[13]!.address).toBe(TOKEN_PROGRAM);
    expect(
      getPurchaseSkillInstructionDataDecoder().decode(ix.data).expectedPrice,
    ).toBe(1n);
    expect(ix.data.at(-33)).toBe(4);
    expect(Array.from(ix.data.slice(-32))).toEqual(
      Array.from(expectedContentHash),
    );
  });
});

describe("reputation facade — async transaction intent snapshots", () => {
  it("binds the authority before hostile whole-input reflection", async () => {
    const authority = mutableSigner(signerAddr);
    const input = new Proxy(
      { authority: authority.signer, agent: A1, amount: 100n },
      {
        ownKeys(target) {
          authority.setAddress(A2);
          return Reflect.ownKeys(target);
        },
      },
    );

    const ix = await stakeReputation(input);
    expect(ix.accounts[0]).toMatchObject({
      address: signerAddr,
      signer: authority.signer,
    });
  });

  it("detaches register-skill bytes and its address Option before PDA derivation", async () => {
    const authority = mutableSigner(signerAddr);
    const skillId = new Uint8Array(32).fill(11);
    const name = new Uint8Array(32).fill(12);
    const contentHash = new Uint8Array(32).fill(13);
    const tags = new Uint8Array(64).fill(14);
    const priceMint: { __option: "Some"; value: Address } = {
      __option: "Some",
      value: A6,
    };
    const pending = registerSkill({
      author: A2,
      authority: authority.signer,
      skillId,
      name,
      contentHash,
      price: 1n,
      priceMint,
      tags,
    });

    skillId.fill(91);
    name.fill(92);
    contentHash.fill(93);
    tags.fill(94);
    priceMint.value = A7;
    authority.setAddress(A1);

    const ix = await pending;
    const decoded = getRegisterSkillInstructionDataDecoder().decode(ix.data);
    expect(decoded.skillId).toEqual(new Uint8Array(32).fill(11));
    expect(decoded.name).toEqual(new Uint8Array(32).fill(12));
    expect(decoded.contentHash).toEqual(new Uint8Array(32).fill(13));
    expect(decoded.tags).toEqual(new Uint8Array(64).fill(14));
    expect(decoded.priceMint).toEqual(some(A6));
    expect(ix.accounts[3]).toMatchObject({
      address: signerAddr,
      signer: authority.signer,
    });
  });

  it("detaches update/rating/purchase/feed byte and Option payloads", async () => {
    const authority = createNoopSigner(signerAddr);
    const updateHash = new Uint8Array(32).fill(21);
    const updateTags = new Uint8Array(64).fill(22);
    const tagsOption = { __option: "Some" as const, value: updateTags };
    const activeOption = { __option: "Some" as const, value: true };
    const updatePending = updateSkill({
      skill: A1,
      author: A2,
      authority,
      contentHash: updateHash,
      price: 5n,
      tags: tagsOption,
      isActive: activeOption,
    });
    updateHash.fill(81);
    updateTags.fill(82);
    tagsOption.value = new Uint8Array(64).fill(83);
    activeOption.value = false;
    const updateDecoded = getUpdateSkillInstructionDataDecoder().decode(
      (await updatePending).data,
    );
    expect(updateDecoded.contentHash).toEqual(new Uint8Array(32).fill(21));
    expect(updateDecoded.tags).toEqual(some(new Uint8Array(64).fill(22)));
    expect(updateDecoded.isActive).toEqual(some(true));

    const reviewBytes = new Uint8Array(32).fill(31);
    const reviewOption = { __option: "Some" as const, value: reviewBytes };
    const ratePending = rateSkill({
      skill: A1,
      rater: A3,
      authorAgent: A4,
      authority,
      rating: 5,
      reviewHash: reviewOption,
    });
    reviewBytes.fill(84);
    reviewOption.value = new Uint8Array(32).fill(85);
    expect(
      getRateSkillInstructionDataDecoder().decode((await ratePending).data)
        .reviewHash,
    ).toEqual(some(new Uint8Array(32).fill(31)));

    const expectedContentHash = new Uint8Array(32).fill(41);
    const purchasePending = purchaseSkill({
      skill: A1,
      buyer: A3,
      authorAgent: A4,
      authorWallet: A5,
      treasury: A7,
      authority,
      expectedPrice: 1n,
      expectedVersion: 4,
      expectedContentHash,
    });
    expectedContentHash.fill(86);
    expect(
      getPurchaseSkillInstructionDataDecoder().decode(
        (await purchasePending).data,
      ).expectedContentHash,
    ).toEqual(new Uint8Array(32).fill(41));

    const feedHash = new Uint8Array(32).fill(51);
    const nonce = new Uint8Array(32).fill(52);
    const topic = new Uint8Array(32).fill(53);
    const parent: { __option: "Some"; value: Address } = {
      __option: "Some",
      value: A5,
    };
    const postPending = postToFeed({
      author: A2,
      authority,
      contentHash: feedHash,
      nonce,
      topic,
      parentPost: parent,
    });
    feedHash.fill(87);
    nonce.fill(88);
    topic.fill(89);
    parent.value = A6;
    const postDecoded = getPostToFeedInstructionDataDecoder().decode(
      (await postPending).data,
    );
    expect(postDecoded.contentHash).toEqual(new Uint8Array(32).fill(51));
    expect(postDecoded.nonce).toEqual(new Uint8Array(32).fill(52));
    expect(postDecoded.topic).toEqual(new Uint8Array(32).fill(53));
    expect(postDecoded.parentPost).toEqual(some(A5));
  });

  it("detaches the nested revoke recovery suffix before either PDA await", async () => {
    const recovery: { treasury: Address } = { treasury: A3 };
    const pending = revokeDelegation({
      authority: signerAddr,
      delegatorAgent: A1,
      delegateeAgent: A2,
      recovery,
    });
    recovery.treasury = A4;

    const ix = await pending;
    expect(ix.accounts.at(-1)).toMatchObject({
      address: A3,
      role: AccountRole.WRITABLE,
    });
  });

  it("rejects malformed fixed-width inputs before building an instruction", async () => {
    const authority = createNoopSigner(signerAddr);
    await expect(
      registerSkill({
        author: A2,
        authority,
        skillId: new Uint8Array(31),
        name: new Uint8Array(32),
        contentHash: new Uint8Array(32),
        price: 1n,
        tags: new Uint8Array(64),
      }),
    ).rejects.toThrow(/exactly 32 bytes/u);
    await expect(
      updateSkill({
        skill: A1,
        author: A2,
        authority,
        contentHash: new Uint8Array(32),
        price: 1n,
        tags: new Uint8Array(63),
      }),
    ).rejects.toThrow(/exactly 64 bytes/u);
  });
});
