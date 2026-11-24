import type { Address } from "@solana/kit";
import { AgencError, findProtocolConfigPda, lighthouse } from "@tetsuo-ai/marketplace-sdk";
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
  const terms = Buffer.from(account.data.subarray(0, 16));
  const lamportsPerByteYear = terms.readBigUInt64LE(0);
  const exemptionThreshold = terms.readDoubleLE(8);
  return {
    hex: terms.toString("hex"),
    minimumBalance(space: number) {
      // Rent::minimum_balance includes 128 bytes of storage overhead. Price
      // every deposit from the exact bytes the transaction will assert.
      const amount = Math.trunc(Number(BigInt(space + 128) * lamportsPerByteYear) * exemptionThreshold);
      if (!Number.isSafeInteger(amount) || amount < 0) throw new WalletError("NETWORK", "The rent quote is out of range.");
      return BigInt(amount);
    },
  };
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

export function assertionFailed(error: unknown) {
  return error instanceof AgencError && error.logs.some(line => line.startsWith(`Program ${lighthouse.LIGHTHOUSE} failed:`));
}
