#!/usr/bin/env node
// Revision-5 mainnet cutover inventory for the legacy skill-rating surface.
//
// The deployed author AgentRegistration can be closed while the loader upload is
// in progress, but SkillRegistration and PurchaseRecord do not snapshot the
// author's wallet. Allowing a missing-author rating would therefore make the
// wallet-level self-rating guard unverifiable. This release uses the stronger,
// stable invariant already true on mainnet: zero SkillRegistration,
// PurchaseRecord, and SkillRating accounts while ProtocolConfig is paused.
// Deployed register/purchase/rate all use the strict pause gate and none of these
// accounts has a close/retype path, so a zero snapshot cannot race nonzero.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "tests-integration", "package.json"));
const { Connection, PublicKey } = require("@solana/web3.js");

export const PROGRAM_ID = new PublicKey(
  "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK",
);
export const MAINNET_GENESIS =
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const SKILL_REGISTRATION_SIZE = 284;
export const PURCHASE_RECORD_SIZE = 93;
export const SKILL_RATING_SIZE = 121;

const DISCRIMINATORS = Object.freeze({
  skill: discriminator("SkillRegistration"),
  purchase: discriminator("PurchaseRecord"),
  rating: discriminator("SkillRating"),
});
const ZERO_PUBKEY = PublicKey.default;

function discriminator(name) {
  return createHash("sha256")
    .update(`account:${name}`)
    .digest()
    .subarray(0, 8);
}

function assertExactAccount(data, expectedSize, expectedDiscriminator, name) {
  if (data.length !== expectedSize) {
    throw new Error(
      `${name}: unexpected account size ${data.length}; expected exactly ${expectedSize}`,
    );
  }
  if (!data.subarray(0, 8).equals(expectedDiscriminator)) {
    throw new Error(`${name}: discriminator mismatch`);
  }
}

function assertNonzeroBytes(value, field) {
  if (value.equals(Buffer.alloc(value.length))) {
    throw new Error(`${field}: all-zero value`);
  }
}

function assertZeroBytes(value, field) {
  if (!value.equals(Buffer.alloc(value.length))) {
    throw new Error(`${field}: non-zero reserved/padding bytes`);
  }
}

function readOptionPubkey(data, offset, field) {
  const tag = data[offset];
  if (tag === 0) return { value: null, offset: offset + 1 };
  if (tag !== 1) throw new Error(`${field}: invalid Option tag ${tag}`);
  const value = new PublicKey(data.subarray(offset + 1, offset + 33));
  if (value.equals(ZERO_PUBKEY)) {
    throw new Error(`${field}: Some(default pubkey)`);
  }
  return { value, offset: offset + 33 };
}

export function decodeSkillRegistration(dataLike) {
  const data = Buffer.from(dataLike);
  assertExactAccount(
    data,
    SKILL_REGISTRATION_SIZE,
    DISCRIMINATORS.skill,
    "SkillRegistration",
  );
  const author = new PublicKey(data.subarray(8, 40));
  if (author.equals(ZERO_PUBKEY)) {
    throw new Error("SkillRegistration.author: default pubkey");
  }
  const skillId = Buffer.from(data.subarray(40, 72));
  assertNonzeroBytes(skillId, "SkillRegistration.skill_id");
  assertNonzeroBytes(data.subarray(72, 104), "SkillRegistration.name");
  assertNonzeroBytes(
    data.subarray(104, 136),
    "SkillRegistration.content_hash",
  );
  const price = data.readBigUInt64LE(136);
  const priceMint = readOptionPubkey(
    data,
    144,
    "SkillRegistration.price_mint",
  );
  let offset = priceMint.offset + 64;
  const totalRating = data.readBigUInt64LE(offset);
  offset += 8;
  const ratingCount = data.readUInt32LE(offset);
  offset += 4;
  const downloadCount = data.readUInt32LE(offset);
  offset += 4;
  const version = data[offset];
  offset += 1;
  const isActiveByte = data[offset];
  offset += 1;
  if (version === 0) throw new Error("SkillRegistration.version: zero");
  if (isActiveByte > 1) {
    throw new Error(`SkillRegistration.is_active: invalid bool ${isActiveByte}`);
  }
  const createdAt = data.readBigInt64LE(offset);
  offset += 8;
  const updatedAt = data.readBigInt64LE(offset);
  offset += 8;
  if (createdAt <= 0n || updatedAt < createdAt) {
    throw new Error(
      `SkillRegistration: invalid timestamps created=${createdAt} updated=${updatedAt}`,
    );
  }
  const bump = data[offset];
  offset += 1;
  assertZeroBytes(
    data.subarray(offset, offset + 8),
    "SkillRegistration._reserved",
  );
  offset += 8;
  assertZeroBytes(data.subarray(offset), "SkillRegistration allocation padding");
  return {
    author,
    skillId,
    price,
    priceMint: priceMint.value,
    totalRating,
    ratingCount,
    downloadCount,
    version,
    isActive: isActiveByte === 1,
    createdAt,
    updatedAt,
    bump,
  };
}

export function decodePurchaseRecord(dataLike) {
  const data = Buffer.from(dataLike);
  assertExactAccount(
    data,
    PURCHASE_RECORD_SIZE,
    DISCRIMINATORS.purchase,
    "PurchaseRecord",
  );
  const skill = new PublicKey(data.subarray(8, 40));
  const buyer = new PublicKey(data.subarray(40, 72));
  if (skill.equals(ZERO_PUBKEY) || buyer.equals(ZERO_PUBKEY)) {
    throw new Error("PurchaseRecord: default skill/buyer pubkey");
  }
  const pricePaid = data.readBigUInt64LE(72);
  const timestamp = data.readBigInt64LE(80);
  if (timestamp <= 0n) {
    throw new Error(`PurchaseRecord.timestamp: invalid ${timestamp}`);
  }
  const bump = data[88];
  const contentVersion = data[89];
  assertZeroBytes(data.subarray(90, 93), "PurchaseRecord._reserved[1..4]");
  return { skill, buyer, pricePaid, timestamp, bump, contentVersion };
}

export function decodeSkillRating(dataLike) {
  const data = Buffer.from(dataLike);
  assertExactAccount(
    data,
    SKILL_RATING_SIZE,
    DISCRIMINATORS.rating,
    "SkillRating",
  );
  const skill = new PublicKey(data.subarray(8, 40));
  const rater = new PublicKey(data.subarray(40, 72));
  if (skill.equals(ZERO_PUBKEY) || rater.equals(ZERO_PUBKEY)) {
    throw new Error("SkillRating: default skill/rater pubkey");
  }
  const rating = data[72];
  if (rating < 1 || rating > 5) {
    throw new Error(`SkillRating.rating: invalid ${rating}`);
  }
  const reviewHash = readOptionHash(data, 73);
  let offset = reviewHash.offset;
  const raterReputation = data.readUInt16LE(offset);
  offset += 2;
  if (raterReputation > 10_000) {
    throw new Error(`SkillRating.rater_reputation: invalid ${raterReputation}`);
  }
  const timestamp = data.readBigInt64LE(offset);
  offset += 8;
  if (timestamp <= 0n) {
    throw new Error(`SkillRating.timestamp: invalid ${timestamp}`);
  }
  const bump = data[offset];
  offset += 1;
  assertZeroBytes(data.subarray(offset, offset + 4), "SkillRating._reserved");
  offset += 4;
  assertZeroBytes(data.subarray(offset), "SkillRating allocation padding");
  return {
    skill,
    rater,
    rating,
    reviewHash: reviewHash.value,
    raterReputation,
    timestamp,
    bump,
  };
}

function readOptionHash(data, offset) {
  const tag = data[offset];
  if (tag === 0) return { value: null, offset: offset + 1 };
  if (tag !== 1) throw new Error(`SkillRating.review_hash: invalid Option tag ${tag}`);
  return {
    value: Buffer.from(data.subarray(offset + 1, offset + 33)),
    offset: offset + 33,
  };
}

function rpcFilter(discriminatorBytes) {
  return {
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: discriminatorBytes.toString("base64"),
          encoding: "base64",
        },
      },
    ],
  };
}

function errorDetail(error) {
  return error instanceof Error ? error.message : String(error);
}

function validateAccounts(accounts, kind, decode, derivePda) {
  const records = [];
  const blockers = [];
  for (const { pubkey, account } of accounts) {
    if (!account.owner.equals(PROGRAM_ID) || account.executable) {
      blockers.push({ kind: `invalid-${kind}-account`, account: pubkey });
      continue;
    }
    try {
      const decoded = decode(account.data);
      const [expected, expectedBump] = derivePda(decoded);
      if (!expected.equals(pubkey) || expectedBump !== decoded.bump) {
        throw new Error(`${kind}: canonical PDA/bump mismatch`);
      }
      records.push({ account: pubkey, ...decoded });
    } catch (error) {
      blockers.push({
        kind: `invalid-${kind}-layout-or-pda`,
        account: pubkey,
        detail: errorDetail(error),
      });
    }
  }
  return { records, blockers };
}

export async function scanSkillRatingCutover(connection) {
  const genesisHash = await connection.getGenesisHash();
  if (genesisHash !== MAINNET_GENESIS) {
    throw new Error(
      `wrong cluster genesis ${genesisHash}; expected mainnet-beta ${MAINNET_GENESIS}`,
    );
  }

  const [skills, purchases, ratings] = await Promise.all([
    connection.getProgramAccounts(PROGRAM_ID, rpcFilter(DISCRIMINATORS.skill)),
    connection.getProgramAccounts(
      PROGRAM_ID,
      rpcFilter(DISCRIMINATORS.purchase),
    ),
    connection.getProgramAccounts(PROGRAM_ID, rpcFilter(DISCRIMINATORS.rating)),
  ]);

  const skillResult = validateAccounts(
    skills,
    "skill-registration",
    decodeSkillRegistration,
    (skill) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("skill"), skill.author.toBuffer(), skill.skillId],
        PROGRAM_ID,
      ),
  );
  const purchaseResult = validateAccounts(
    purchases,
    "purchase-record",
    decodePurchaseRecord,
    (purchase) =>
      PublicKey.findProgramAddressSync(
        [
          Buffer.from("skill_purchase"),
          purchase.skill.toBuffer(),
          purchase.buyer.toBuffer(),
        ],
        PROGRAM_ID,
      ),
  );
  const ratingResult = validateAccounts(
    ratings,
    "skill-rating",
    decodeSkillRating,
    (rating) =>
      PublicKey.findProgramAddressSync(
        [
          Buffer.from("skill_rating"),
          rating.skill.toBuffer(),
          rating.rater.toBuffer(),
        ],
        PROGRAM_ID,
      ),
  );

  return {
    accountCount: skills.length + purchases.length + ratings.length,
    skillCount: skills.length,
    purchaseCount: purchases.length,
    ratingCount: ratings.length,
    decodedSkillCount: skillResult.records.length,
    decodedPurchaseCount: purchaseResult.records.length,
    decodedRatingCount: ratingResult.records.length,
    skills: skillResult.records,
    purchases: purchaseResult.records,
    ratings: ratingResult.records,
    blockers: [
      ...skillResult.blockers,
      ...purchaseResult.blockers,
      ...ratingResult.blockers,
    ],
  };
}

export function redactRpcText(value) {
  return String(value).replace(
    /(?:https?|wss?):\/\/\S+/giu,
    "<redacted-rpc>",
  );
}

async function main() {
  const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  console.log(
    `Scanning mainnet skill-rating cutover via <redacted-rpc> (program ${PROGRAM_ID.toBase58()})`,
  );
  const connection = new Connection(rpcUrl, "confirmed");
  const result = await scanSkillRatingCutover(connection);
  console.log(`SkillRegistration accounts: ${result.skillCount}`);
  console.log(`PurchaseRecord accounts: ${result.purchaseCount}`);
  console.log(`SkillRating accounts: ${result.ratingCount}`);
  for (const blocker of result.blockers) {
    console.error(
      `  BLOCKER ${blocker.kind}: account=${blocker.account?.toBase58?.() ?? "unknown"} ` +
        `detail=${blocker.detail ?? "none"}`,
    );
  }
  if (result.accountCount !== 0 || result.blockers.length !== 0) {
    throw new Error(
      "revision-5 cutover requires the legacy skill registration/purchase/rating surface to be exactly empty",
    );
  }
  console.log(
    "PREFLIGHT OK: legacy skill registration, purchase, and rating state is empty.",
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(
      `PREFLIGHT FAIL: ${redactRpcText(error instanceof Error ? error.message : error)}`,
    );
    process.exitCode = 1;
  });
}
