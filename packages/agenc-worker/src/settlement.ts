import { getBase58Encoder, type Address } from "@solana/kit";

export const AGENC_PROGRAM_ID =
  "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK" as Address;
export const DEFAULT_SETTLEMENT_SIGNATURE_SCAN_LIMIT = 20;

const SETTLEMENT_INSTRUCTIONS = Object.freeze([
  { name: "accept_task_result", discriminator: [89, 230, 51, 25, 0, 219, 5, 137], taskIndex: 0 },
  { name: "auto_accept_task_result", discriminator: [217, 200, 76, 0, 144, 80, 23, 241], taskIndex: 0 },
  { name: "complete_task", discriminator: [109, 167, 192, 41, 129, 108, 220, 196], taskIndex: 0 },
  { name: "resolve_dispute", discriminator: [231, 6, 202, 6, 96, 103, 12, 230], taskIndex: 1 },
]);

type SignatureRecord = {
  signature?: unknown;
  err?: unknown;
  confirmationStatus?: unknown;
};

type SettlementRpc = {
  getSignaturesForAddress(
    task: Address,
    config: { limit: number; commitment: "finalized" },
  ): { send(): Promise<readonly SignatureRecord[]> };
  getTransaction(
    signature: string,
    config: {
      commitment: "finalized";
      encoding: "jsonParsed";
      maxSupportedTransactionVersion: 0;
    },
  ): { send(): Promise<unknown> };
};

function addressString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "pubkey" in value) {
    const pubkey = (value as { pubkey?: unknown }).pubkey;
    return typeof pubkey === "string" ? pubkey : null;
  }
  return null;
}
function instructionData(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return new Uint8Array(getBase58Encoder().encode(value));
  } catch {
    return null;
  }
}

/** Pure verification for a finalized transaction returned by Solana JSON-RPC. */
export function isVerifiedSettlementTransaction(
  value: unknown,
  { task, signature }: { task: Address; signature: string },
): boolean {
  if (!value || typeof value !== "object") return false;
  const transaction = value as {
    meta?: { err?: unknown } | null;
    transaction?: {
      signatures?: unknown;
      message?: { accountKeys?: unknown; instructions?: unknown };
    };
  };
  if (transaction.meta?.err !== null) return false;
  const signatures = transaction.transaction?.signatures;
  if (!Array.isArray(signatures) || signatures[0] !== signature) return false;
  const message = transaction.transaction?.message;
  if (!message || !Array.isArray(message.instructions)) return false;
  const messageKeys = Array.isArray(message.accountKeys)
    ? message.accountKeys.map(addressString)
    : [];
  return message.instructions.some((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const instruction = raw as {
      programId?: unknown;
      programIdIndex?: unknown;
      accounts?: unknown;
      data?: unknown;
    };
    const programId = addressString(instruction.programId) ??
      (Number.isSafeInteger(instruction.programIdIndex)
        ? messageKeys[instruction.programIdIndex as number]
        : null);
    if (programId !== AGENC_PROGRAM_ID || !Array.isArray(instruction.accounts)) return false;
    const accounts = instruction.accounts.map((account) =>
      typeof account === "number" ? messageKeys[account] : addressString(account),
    );
    const data = instructionData(instruction.data);
    if (!data || data.length < 8) return false;
    return SETTLEMENT_INSTRUCTIONS.some(
      ({ discriminator, taskIndex }) =>
        accounts[taskIndex] === task &&
        discriminator.every((byte, index) => data[index] === byte),
    );
  });
}

/**
 * Scan a bounded finalized history and return only a transaction that actually
 * invoked an AgenC terminal settlement instruction for this exact Task PDA.
 */
export async function findVerifiedSettlementSignature(
  rpc: SettlementRpc,
  task: Address,
  limit = DEFAULT_SETTLEMENT_SIGNATURE_SCAN_LIMIT,
): Promise<string | null> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("settlement signature scan limit must be in 1..100");
  }
  const candidates = await rpc
    .getSignaturesForAddress(task, { limit, commitment: "finalized" })
    .send();
  for (const candidate of candidates) {
    if (
      typeof candidate.signature !== "string" ||
      candidate.err !== null ||
      candidate.confirmationStatus !== "finalized"
    ) {
      continue;
    }
    const transaction = await rpc
      .getTransaction(candidate.signature, {
        commitment: "finalized",
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0,
      })
      .send();
    if (
      isVerifiedSettlementTransaction(transaction, {
        task,
        signature: candidate.signature,
      })
    ) {
      return candidate.signature;
    }
  }
  return null;
}
