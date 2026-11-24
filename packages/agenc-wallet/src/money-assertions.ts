import type { Address } from "@solana/kit";
import { AgencError, facade, findProtocolConfigPda, getTaskEncoder, lighthouse, type Task } from "@tetsuo-ai/marketplace-sdk";
import type { ReviewedDelivery } from "./client/reviews.js";
import type { Chain } from "./chain.js";
import { WalletError } from "./errors.js";

// Revision 9 Anchor/Borsh offsets include the 8-byte account discriminator.
const proofHashOffset = 8 + 3 * 32 + 1; // task, claim, worker, status
const submissionCountOffset = proofHashOffset + 32 + 64; // proof_hash, result_data
const protocolFeeOffset = 8 + 2 * 32 + 1; // authority, treasury, dispute_threshold

function le16(value: number) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
}

export function submissionAssertions(submission: Address, expected: ReviewedDelivery) {
  if (!Number.isInteger(expected.submissionCount) || expected.submissionCount < 1 ||
      expected.submissionCount > 65535 || !/^[0-9a-f]{64}$/.test(expected.deliveryHash)) {
    throw new RangeError("Invalid reviewed delivery.");
  }
  return [
    lighthouse.assertBytes(submission, submissionCountOffset, le16(expected.submissionCount)),
    lighthouse.assertBytes(submission, proofHashOffset, Buffer.from(expected.deliveryHash, "hex")),
  ];
}

// Rent's rate and exemption threshold determine the deposits. The final byte
// controls how collected rent is distributed and has no effect on the quote.
export async function readHireRent(chain: Chain) {
  const account = await chain.readRawAccount(lighthouse.RENT);
  if (account?.owner !== "Sysvar1111111111111111111111111111111111111" || account.data.length !== 17) {
    throw new WalletError("NETWORK", "The current rent settings could not be verified.");
  }
  const hex = Buffer.from(account.data.subarray(0, 16)).toString("hex");
  return { hex, minimumBalance: rentFromTerms(hex) };
}

export async function hireCostAssertions(protocolFeeBps: number, rentTerms: string) {
  if (!Number.isInteger(protocolFeeBps) || protocolFeeBps < 0 || protocolFeeBps > 10_000 || !/^[0-9a-f]{32}$/.test(rentTerms)) {
    throw new WalletError("NOT_AVAILABLE", "Refresh the hire quote to get the current costs.");
  }
  const [config] = await findProtocolConfigPda();
  return [
    lighthouse.assertBytes(config, protocolFeeOffset, le16(protocolFeeBps)),
    lighthouse.assertBytes(lighthouse.RENT, 0, Buffer.from(rentTerms, "hex")),
  ];
}

// Task._reserved[3..11] is revision 9's monotonic claim generation. Every
// instruction that creates a claim increments it, so a claim released and taken
// again (which reopens round one at the same claim and submission addresses)
// never shares it. The task ends with _reserved[16], referrer and referrer bps.
export function claimGenerationOffset(task: Task) {
  return getTaskEncoder().encode(task).length - 32 - 2 - 16 + 3;
}

export function claimGeneration(task: Task) {
  return Buffer.from(task.reserved).readBigUInt64LE(3).toString();
}

/** A reviewed delivery and the claim it was delivered on. */
export interface BoundDelivery extends ReviewedDelivery { claimGeneration?: string }

/**
 * The guards of one buyer decision: the submission's round and hash, and the
 * claim generation the buyer reviewed. A replacement claim fails all three
 * together, as a newer delivery fails the first two.
 */
export function decisionAssertions(task: Address, account: Task, submission: Address, expected: BoundDelivery) {
  const generation = expected.claimGeneration;
  if (generation === undefined || !/^[0-9]{1,20}$/.test(generation) || BigInt(generation) > 0xffffffffffffffffn) {
    throw new WalletError("NOT_ALLOWED", "The delivery changed before signing. Open the new delivery and review it again.");
  }
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(generation));
  return [...submissionAssertions(submission, expected), lighthouse.assertBytes(task, claimGenerationOffset(account), bytes)];
}

/** True for the claim-generation guard decisionAssertions builds on `task`. */
export function isGenerationGuard(programAddress: unknown, accounts: readonly unknown[], data: Uint8Array) {
  if (programAddress !== lighthouse.LIGHTHOUSE || accounts.length !== 1 || data[0] !== 2 || data[1] !== 0) return false;
  let at = 2, offset = 0, scale = 1;
  while (at < data.length && data[at]! >= 128) { offset += (data[at]! - 128) * scale; scale *= 128; at++; }
  if (at >= data.length) return false;
  offset += data[at]! * scale;
  return offset > 0 && data[at + 1] === 11 && data[at + 2] === 8 && data.length === at + 3 + 8 + 1 && data[at + 11] === 0;
}

/**
 * Bind what revision 9 charges for missing marketplace records to the quote.
 * The charge is Rent::minimum_balance(space) less the lamports already at the
 * record address. Price it from the exact Rent bytes the transaction asserts,
 * refuse it above `approved`, and require the prefunded balance to be at least
 * what was read: a stranger's top-up only lowers the charge, and nothing but
 * the coordination program (as it creates the record) can lower it.
 */
export async function recordCostGuards(chain: Chain, parties: { creator?: Address; workerAgent?: Address }, approved: bigint | undefined) {
  const rent = await readHireRent(chain);
  const cost = await facade.missingRecordCost(async key => chain.readRawAccount(key), async size => rent.minimumBalance(size), parties);
  if (approved === undefined || cost.lamports > approved) {
    throw new WalletError("PRICE_CHANGED", "This now costs more than you approved. Open the job and review it again.");
  }
  const guards = [];
  for (const record of [cost.creatorRecord, cost.workerRecord]) {
    if (!record || record.exists) continue;
    const held = (await chain.readRawAccount(record.address))?.lamports ?? 0n;
    if (held > 0n) guards.push(lighthouse.assertLamportsAtLeast(record.address, held));
  }
  if (guards.length || [cost.creatorRecord, cost.workerRecord].some(record => record && !record.exists)) {
    guards.unshift(lighthouse.assertBytes(lighthouse.RENT, 0, Buffer.from(rent.hex, "hex")));
  }
  return { guards, lamports: cost.lamports };
}

/**
 * Accounts a hire creates after funding (the moderation record and the job
 * spec) are paid at the rate in force when each lands. Compare that rate with
 * the approved Rent bytes for the given sizes. Returns the current Rent bytes
 * when nothing costs more than approved, else null.
 */
export async function laterRentWithinApproval(chain: Chain, approvedTerms: string, spaces: readonly number[]) {
  const current = await readHireRent(chain);
  if (current.hex === approvedTerms) return current.hex;
  const approved = rentFromTerms(approvedTerms);
  return spaces.every(space => current.minimumBalance(space) <= approved(space)) ? current.hex : null;
}

function rentFromTerms(hex: string) {
  const terms = Buffer.from(hex, "hex");
  if (terms.length !== 16) throw new WalletError("NOT_AVAILABLE", "Refresh the hire quote to get the current costs.");
  const lamportsPerByteYear = terms.readBigUInt64LE(0), exemptionThreshold = terms.readDoubleLE(8);
  return (space: number) => {
    // Rent::minimum_balance includes 128 bytes of storage overhead. Price
    // every deposit from the exact bytes the transaction will assert.
    const amount = Math.trunc(Number(BigInt(space + 128) * lamportsPerByteYear) * exemptionThreshold);
    if (!Number.isSafeInteger(amount) || amount < 0) throw new WalletError("NETWORK", "The rent quote is out of range.");
    return BigInt(amount);
  };
}

export function assertionFailed(error: unknown) {
  return error instanceof AgencError && error.logs.some(line => line.startsWith(`Program ${lighthouse.LIGHTHOUSE} failed:`));
}
