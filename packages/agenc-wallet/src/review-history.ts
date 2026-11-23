import { AccountRole, signature as toSignature, type Address, type Signature } from "@solana/kit";
import {
  AgencCoordinationInstruction as Ix, AGENC_COORDINATION_PROGRAM_ADDRESS,
  parseAgencCoordinationEvents, parseAgencCoordinationInstruction,
} from "@tetsuo-ai/marketplace-sdk";
import type { ReviewEntry } from "./client/reviews.js";
import { sentInstruction, type SentInstruction, type SettlementHistoryRpc } from "./settlement.js";

export interface ReviewAnchor extends Omit<ReviewEntry, "attachments" | "note" | "fee" | "rent" | "bond"> {
  round?: number;
  feeLamports: bigint | null;
  rentLamports: bigint | null;
  bondLamports: bigint | null;
}
export interface ReviewHistory { entries: ReviewAnchor[]; complete: boolean }

interface TransactionCosts {
  fee: bigint | null;
  balanceChange: (address: Address) => bigint | null;
}

/** Only a successful marketplace instruction and its matching event establish a review. */
export function reviewAnchor(ix: SentInstruction, logs: readonly string[], signature: string, costs: TransactionCosts): ReviewAnchor | null {
  if (ix.programAddress !== AGENC_COORDINATION_PROGRAM_ADDRESS) return null;
  let parsed;
  try {
    parsed = parseAgencCoordinationInstruction({
      programAddress: ix.programAddress, accounts: ix.accounts.map(address => ({ address, role: AccountRole.READONLY })), data: ix.data,
    });
  } catch { return null; }
  if (parsed.instructionType !== Ix.RequestChanges && parsed.instructionType !== Ix.RejectAndFreeze &&
      parsed.instructionType !== Ix.DisputeRejection) return null;
  for (const event of parseAgencCoordinationEvents(logs)) {
    if (event.eventName !== "TaskChangesRequested" && event.eventName !== "TaskRejectFrozen" && event.eventName !== "RejectionDisputed") continue;
    if (event.data.task !== parsed.accounts.task.address || event.data.claim !== parsed.accounts.claim.address) continue;
    const common = { signature, at: Number(event.data.timestamp) * 1000, feeLamports: costs.fee };
    if (parsed.instructionType === Ix.RequestChanges && event.eventName === "TaskChangesRequested") {
      return { ...common, action: "change", round: event.data.round, hash: Buffer.from(parsed.data.changesHash).toString("hex"), deadline: null, rentLamports: 0n, bondLamports: 0n };
    }
    if (parsed.instructionType === Ix.RejectAndFreeze && event.eventName === "TaskRejectFrozen" &&
        Buffer.from(event.data.rejectionHash).equals(Buffer.from(parsed.data.rejectionHash))) {
      const creator = costs.balanceChange(parsed.accounts.creatorStats.address);
      const seller = costs.balanceChange(parsed.accounts.agentStats.address);
      return { ...common, action: "reject", hash: Buffer.from(event.data.rejectionHash).toString("hex"),
        deadline: Number(event.data.reviewDeadlineAt) * 1000, bondLamports: 0n,
        rentLamports: creator !== null && seller !== null && creator >= 0n && seller >= 0n ? creator + seller : null };
    }
    if (parsed.instructionType === Ix.DisputeRejection && event.eventName === "RejectionDisputed" &&
        Buffer.from(event.data.evidenceHash).equals(Buffer.from(parsed.data.evidenceHash))) {
      const deposit = costs.balanceChange(parsed.accounts.disputeBond.address);
      const bond = event.data.bondAmount;
      return { ...common, action: "dispute", hash: Buffer.from(event.data.evidenceHash).toString("hex"),
        deadline: Number(event.data.rulingDeadline) * 1000, bondLamports: bond, rentLamports: deposit !== null && deposit >= bond ? deposit - bond : null };
    }
  }
  return null;
}

function lamports(value: unknown): bigint | null {
  if (typeof value === "bigint" && value >= 0n) return value;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
}

interface HistoryTransaction {
  transaction?: { signatures?: string[]; message?: { accountKeys?: (string | { pubkey: string })[]; instructions?: unknown[] } };
  meta?: { err: unknown; fee?: unknown; preBalances?: unknown[]; postBalances?: unknown[]; logMessages?: string[]; innerInstructions?: { instructions: unknown[] }[] };
}

export async function readReviewHistory(rpc: SettlementHistoryRpc, task: Address, claim: Address,
  cache?: Map<string, readonly ReviewAnchor[]>): Promise<ReviewHistory> {
  const entries: ReviewAnchor[] = [];
  let before: Signature | undefined;
  let complete = true;
  // A normal claim fits on the first page. Bound work for heavily referenced accounts.
  for (let page = 0; page < 8; page++) {
    const rows = await rpc.getSignaturesForAddress(claim, { limit: 32, commitment: "confirmed", ...(before && { before }) }).send();
    for (const row of rows) {
      if (row.err !== null || typeof row.signature !== "string") continue;
      const cacheKey = claim + "/" + task + "/" + row.signature;
      const known = cache?.get(cacheKey);
      if (known) { entries.unshift(...known); continue; }
      const tx = await rpc.getTransaction(row.signature, {
        encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0,
      }).send().catch(() => null) as HistoryTransaction | null;
      if (!tx) { complete = false; continue; }
      if (tx.meta?.err !== null || tx.transaction?.signatures?.[0] !== row.signature) continue;
      const message = tx.transaction.message;
      const meta = tx.meta;
      const keys = (message?.accountKeys ?? []).map(key => typeof key === "string" ? key : key.pubkey);
      const costs = { fee: lamports(meta.fee), balanceChange(address: Address) {
        const i = keys.indexOf(address);
        const pre = lamports(meta.preBalances?.[i]);
        const post = lamports(meta.postBalances?.[i]);
        return pre !== null && post !== null ? post - pre : null;
      } };
      const instructions = [...(message?.instructions ?? []), ...(meta.innerInstructions ?? []).flatMap(group => group.instructions)];
      const transactionEntries: ReviewAnchor[] = [];
      for (const raw of instructions) {
        const ix = sentInstruction(raw);
        if (!ix || ix.accounts[0] !== task || ix.accounts[1] !== claim) continue;
        const anchor = reviewAnchor(ix, meta.logMessages ?? [], row.signature, costs);
        if (anchor) transactionEntries.push(anchor);
      }
      if (cache) {
        if (cache.size >= 512) cache.delete(cache.keys().next().value!);
        cache.set(cacheKey, transactionEntries);
      }
      entries.unshift(...transactionEntries);
    }
    if (rows.length < 32) return { entries, complete };
    const next = rows.at(-1)?.signature;
    if (typeof next !== "string" || next === before) break;
    before = toSignature(next);
  }
  return { entries, complete: false };
}
