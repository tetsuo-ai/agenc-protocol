import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import {
  MAINNET_GENESIS,
  PROGRAM_ID,
  PURCHASE_RECORD_SIZE,
  SKILL_RATING_SIZE,
  SKILL_REGISTRATION_SIZE,
  decodePurchaseRecord,
  decodeSkillRating,
  decodeSkillRegistration,
  scanSkillRatingCutover,
} from "./preflight-skill-rating-cutover-scan.mjs";

const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const { PublicKey } = require("@solana/web3.js");

function discriminator(name) {
  return createHash("sha256")
    .update(`account:${name}`)
    .digest()
    .subarray(0, 8);
}

function skillFixture(marker = 11, { withMint = false } = {}) {
  const author = new PublicKey(Buffer.alloc(32, marker));
  const skillId = Buffer.alloc(32, marker + 1);
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("skill"), author.toBuffer(), skillId],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(SKILL_REGISTRATION_SIZE);
  discriminator("SkillRegistration").copy(data);
  author.toBuffer().copy(data, 8);
  skillId.copy(data, 40);
  Buffer.alloc(32, marker + 2).copy(data, 72);
  Buffer.alloc(32, marker + 3).copy(data, 104);
  data.writeBigUInt64LE(1_000n, 136);
  let offset = 144;
  if (withMint) {
    data[offset] = 1;
    new PublicKey(Buffer.alloc(32, marker + 4)).toBuffer().copy(data, offset + 1);
    offset += 33;
  } else {
    data[offset] = 0;
    offset += 1;
  }
  offset += 64;
  data.writeBigUInt64LE(12_000n, offset);
  offset += 8;
  data.writeUInt32LE(2, offset);
  offset += 4;
  data.writeUInt32LE(3, offset);
  offset += 4;
  data[offset] = 1;
  offset += 1;
  data[offset] = 1;
  offset += 1;
  data.writeBigInt64LE(100n, offset);
  offset += 8;
  data.writeBigInt64LE(101n, offset);
  offset += 8;
  data[offset] = bump;
  return { address, data, author, skillId };
}

function purchaseFixture(skill, buyerMarker = 31) {
  const buyer = new PublicKey(Buffer.alloc(32, buyerMarker));
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("skill_purchase"), skill.toBuffer(), buyer.toBuffer()],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(PURCHASE_RECORD_SIZE);
  discriminator("PurchaseRecord").copy(data);
  skill.toBuffer().copy(data, 8);
  buyer.toBuffer().copy(data, 40);
  data.writeBigUInt64LE(1_000n, 72);
  data.writeBigInt64LE(110n, 80);
  data[88] = bump;
  data[89] = 1;
  return { address, data, skill, buyer };
}

function ratingFixture(skill, rater, { withReview = false } = {}) {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("skill_rating"), skill.toBuffer(), rater.toBuffer()],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(SKILL_RATING_SIZE);
  discriminator("SkillRating").copy(data);
  skill.toBuffer().copy(data, 8);
  rater.toBuffer().copy(data, 40);
  data[72] = 5;
  let offset = 73;
  if (withReview) {
    data[offset] = 1;
    Buffer.alloc(32, 77).copy(data, offset + 1);
    offset += 33;
  } else {
    data[offset] = 0;
    offset += 1;
  }
  data.writeUInt16LE(3_000, offset);
  offset += 2;
  data.writeBigInt64LE(120n, offset);
  offset += 8;
  data[offset] = bump;
  return { address, data, skill, rater };
}

function connectionWith(accounts, genesis = MAINNET_GENESIS) {
  let enumerations = 0;
  return {
    get enumerations() {
      return enumerations;
    },
    getGenesisHash: async () => genesis,
    getProgramAccounts: async (program, options) => {
      enumerations += 1;
      assert.ok(program.equals(PROGRAM_ID));
      const filter = options.filters[0].memcmp;
      assert.equal(filter.offset, 0);
      assert.equal(filter.encoding, "base64");
      const wanted = Buffer.from(filter.bytes, "base64");
      return accounts
        .filter((item) => item.data.subarray(0, 8).equals(wanted))
        .map((item) => ({
          pubkey: item.address,
          account: {
            owner: item.owner ?? PROGRAM_ID,
            executable: item.executable ?? false,
            data: item.data,
            lamports: item.lamports ?? 1_000_000,
          },
        }));
    },
  };
}

test("exact-decodes both compact Option layouts and immutable bindings", () => {
  for (const withMint of [false, true]) {
    const skill = skillFixture(withMint ? 15 : 11, { withMint });
    const decoded = decodeSkillRegistration(skill.data);
    assert.ok(decoded.author.equals(skill.author));
    assert.deepEqual(decoded.skillId, skill.skillId);
    assert.equal(decoded.priceMint !== null, withMint);
    assert.equal(decoded.bump, skill.data[withMint ? 275 : 243]);

    const purchase = purchaseFixture(skill.address, withMint ? 35 : 31);
    const decodedPurchase = decodePurchaseRecord(purchase.data);
    assert.ok(decodedPurchase.skill.equals(skill.address));
    assert.ok(decodedPurchase.buyer.equals(purchase.buyer));
    assert.equal(decodedPurchase.contentVersion, 1);

    const rating = ratingFixture(skill.address, purchase.buyer, {
      withReview: withMint,
    });
    const decodedRating = decodeSkillRating(rating.data);
    assert.ok(decodedRating.skill.equals(skill.address));
    assert.ok(decodedRating.rater.equals(purchase.buyer));
    assert.equal(decodedRating.reviewHash !== null, withMint);
  }
});

test("scanner inventories canonical skill, purchase, and rating state", async () => {
  const skill = skillFixture(41);
  const purchase = purchaseFixture(skill.address, 51);
  const rating = ratingFixture(skill.address, purchase.buyer);
  const result = await scanSkillRatingCutover(
    connectionWith([skill, purchase, rating]),
  );
  assert.equal(result.accountCount, 3);
  assert.equal(result.skillCount, 1);
  assert.equal(result.purchaseCount, 1);
  assert.equal(result.ratingCount, 1);
  assert.equal(result.decodedSkillCount, 1);
  assert.equal(result.decodedPurchaseCount, 1);
  assert.equal(result.decodedRatingCount, 1);
  assert.deepEqual(result.blockers, []);
});

test("empty surface is a stable zero cutover inventory", async () => {
  const connection = connectionWith([]);
  const result = await scanSkillRatingCutover(connection);
  assert.deepEqual(result, {
    accountCount: 0,
    skillCount: 0,
    purchaseCount: 0,
    ratingCount: 0,
    decodedSkillCount: 0,
    decodedPurchaseCount: 0,
    decodedRatingCount: 0,
    skills: [],
    purchases: [],
    ratings: [],
    blockers: [],
  });
  assert.equal(connection.enumerations, 3);
});

test("malformed layout, reserved bytes, owner, and PDA fail closed", async () => {
  const badSkill = skillFixture(61);
  badSkill.data[251] = 1;
  const badPurchase = purchaseFixture(badSkill.address, 71);
  badPurchase.owner = PublicKey.default;
  const badRating = ratingFixture(badSkill.address, badPurchase.buyer);
  badRating.address = new PublicKey(Buffer.alloc(32, 73));
  const result = await scanSkillRatingCutover(
    connectionWith([badSkill, badPurchase, badRating]),
  );
  assert.deepEqual(
    new Set(result.blockers.map((item) => item.kind)),
    new Set([
      "invalid-skill-registration-layout-or-pda",
      "invalid-purchase-record-account",
      "invalid-skill-rating-layout-or-pda",
    ]),
  );
});

test("decoder rejects wrong sizes, invalid enums, and reserved bytes", () => {
  const skill = skillFixture(81);
  assert.throws(
    () => decodeSkillRegistration(skill.data.subarray(0, 283)),
    /expected exactly 284/,
  );
  const purchase = purchaseFixture(skill.address, 91);
  purchase.data[92] = 1;
  assert.throws(
    () => decodePurchaseRecord(purchase.data),
    /reserved\/padding bytes/,
  );
  const rating = ratingFixture(skill.address, purchase.buyer);
  rating.data[72] = 6;
  assert.throws(() => decodeSkillRating(rating.data), /rating: invalid 6/);
});

test("wrong genesis fails before any account enumeration", async () => {
  const connection = connectionWith([], "devnet");
  await assert.rejects(
    () => scanSkillRatingCutover(connection),
    /wrong cluster genesis/,
  );
  assert.equal(connection.enumerations, 0);
});
