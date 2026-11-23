import { AccountRole, signature as toSignature, type Address, type Signature } from "@solana/kit";
import {
  AgencCoordinationInstruction as Ix, AGENC_COORDINATION_PROGRAM_ADDRESS,
  findTaskPda, TaskType, parseAgencCoordinationEvents, parseAgencCoordinationInstruction,
} from "@tetsuo-ai/marketplace-sdk";
import { reviewRead } from "./review.js";
import type { ReviewEntry } from "./client/reviews.js";
import { sentInstruction, type SentInstruction, type SettlementHistoryRpc } from "./settlement.js";

export interface ReviewAnchor extends Omit<ReviewEntry, "attachments" | "note" | "fee" | "rent" | "bond"> {
  round?: number;
  feeLamports: bigint | null;
  rentLamports: bigint | null;
  bondLamports: bigint | null;
}
export interface ReviewHistory { entries: ReviewAnchor[]; complete: boolean; missing?: boolean; continuation?: string }

interface TransactionCosts {
  fee: bigint | null;
  balanceChange: (address: Address) => bigint | null;
}

/** Accept only a deadline emitted inside the marketplace invocation. */
function revisionDeadline(logs: readonly string[], claim: Address, round: number): number | null {
  const stack: string[] = [];
  const prefix = `Program log: Revision deadline ${claim} ${round} `;
  for (const line of logs) {
    const invoke = /^Program (\S+) invoke \[(\d+)\]$/.exec(line);
    if (invoke) {
      const depth = Number(invoke[2]);
      if (!Number.isSafeInteger(depth) || depth < 1 || depth > 64) return null;
      stack.length = depth - 1;
      stack.push(invoke[1]!);
    } else if (/^Program \S+ (success|failed:)/.test(line)) stack.pop();
    else if (stack.at(-1) === AGENC_COORDINATION_PROGRAM_ADDRESS && line.startsWith(prefix)) {
      const seconds = Number(line.slice(prefix.length));
      if (Number.isSafeInteger(seconds) && seconds > 0) return seconds * 1000;
    }
  }
  return null;
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
      return { ...common, action: "change", round: event.data.round, hash: Buffer.from(parsed.data.changesHash).toString("hex"), deadline: revisionDeadline(logs, event.data.claim, event.data.round), rentLamports: 0n, bondLamports: 0n };
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
      return { ...common, action: "dispute", evidenceUri: parsed.data.evidenceUri, hash: Buffer.from(event.data.evidenceHash).toString("hex"),
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

// Before the deadline was logged, an exclusive job with a fixed deadline
// started its claim one hour past that deadline. Only its own change requests
// could extend either bound. Replay the original creation and submission events
// so a device seeing the closed job for the first time can recover each round.
async function legacyDeadline(rpc: SettlementHistoryRpc, task: Address, claim: Address, change: ReviewAnchor): Promise<number | null> {
  let cursor = toSignature(change.signature);
  let baseDue: number | undefined;
  const windows = new Map<number, number>();
  const requested = new Map([[change.round!, change.at]]);
  const until = performance.now() + 2400;
  while (performance.now() < until && baseDue === undefined) {
    const rows = await reviewRead(rpc.getSignaturesForAddress(task, { limit: 32, commitment: "confirmed", before: cursor }).send(), 800);
    if (!rows?.length) return null;
    const receipts = await Promise.all(rows.map(async row => {
      if (typeof row.signature !== "string" || row.err !== null) return null;
      const tx = await reviewRead(rpc.getTransaction(row.signature, {
        encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0,
      }).send(), 800) as HistoryTransaction | null;
      return tx?.meta?.err === null && tx.transaction?.signatures?.[0] === row.signature ? tx.meta.logMessages : null;
    }));
    for (const logs of receipts) {
      for (const event of parseAgencCoordinationEvents(logs ?? [])) {
        if (event.eventName === "TaskCreated" && (await findTaskPda({ creator: event.data.creator, taskId: event.data.taskId }))[0] === task) {
          if (event.data.taskType !== TaskType.Exclusive || event.data.deadline <= 0n) return null;
          baseDue = Number(event.data.deadline) * 1000;
        } else if (event.eventName === "TaskResultSubmitted" && event.data.task === task && event.data.claim === claim) {
          windows.set(event.data.submissionCount, Number(event.data.reviewDeadlineAt - event.data.submittedAt));
        } else if (event.eventName === "TaskChangesRequested" && event.data.task === task && event.data.claim === claim) {
          requested.set(event.data.round, Number(event.data.timestamp) * 1000);
        }
      }
    }
    const next = rows.at(-1)?.signature;
    if (typeof next !== "string" || next === cursor || rows.length < 32) break;
    cursor = toSignature(next);
  }
  if (baseDue === undefined) return null;
  for (let round = 1; round <= change.round!; round++) {
    const time = requested.get(round);
    const window = windows.get(round);
    if (time === undefined || window === undefined || window <= 0) return null;
    baseDue = Math.max(baseDue, time + Math.max(86400, window) * 1000);
  }
  return baseDue;
}

export async function readReviewHistory(rpc: SettlementHistoryRpc, task: Address, claim: Address,
  cache?: Map<string, readonly ReviewAnchor[]>, cursor?: string): Promise<ReviewHistory> {
  const entries: ReviewAnchor[] = [];
  let before: Signature | undefined = cursor ? toSignature(cursor) : undefined;
  let complete = true;
  const until = performance.now() + 2200;
  const finish = async (next?: Signature): Promise<ReviewHistory> => {
    await Promise.all(entries.map(async (entry, i) => {
      if (entry.action !== "change" || entry.deadline !== null || !entry.round) return;
      const deadline = await legacyDeadline(rpc, task, claim, entry).catch(() => null);
      entries[i] = { ...entry, deadline };
      if (deadline === null) complete = false;
    }));
    return next ? { entries, complete: false, missing: !complete, continuation: next } : { entries, complete };
  };
  // A normal claim fits on the first page. Bound work for heavily referenced accounts.
  for (let page = 0; page < 8; page++) {
    const rows = await reviewRead(rpc.getSignaturesForAddress(claim, { limit: 32, commitment: "confirmed", ...(before && { before }) }).send(), 1000);
    if (!rows) { complete = false; return finish(); }
    let lastRead: string | undefined;
    for (const row of rows) {
      if (lastRead && performance.now() >= until) return finish(toSignature(lastRead));
      if (typeof row.signature === "string") lastRead = row.signature;
      if (typeof row.signature !== "string" || row.err === undefined) { complete = false; continue; }
      if (row.err !== null) continue;
      const cacheKey = claim + "/" + task + "/" + row.signature;
      const known = cache?.get(cacheKey);
      if (known) { entries.unshift(...known); continue; }
      const tx = await reviewRead(rpc.getTransaction(row.signature, {
        encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0,
      }).send(), 800) as HistoryTransaction | null;
      if (!tx) { complete = false; continue; }
      if (!tx.meta || tx.meta.err !== null || tx.transaction?.signatures?.[0] !== row.signature ||
          !Array.isArray(tx.transaction.message?.instructions) || !tx.meta.logMessages?.length ||
          tx.meta.logMessages.some(line => line.startsWith("Log truncated"))) {
        complete = false;
        continue;
      }
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
      let verified = true;
      for (const raw of instructions) {
        const ix = sentInstruction(raw);
        if (!ix || ix.accounts[0] !== task || ix.accounts[1] !== claim) continue;
        const anchor = reviewAnchor(ix, meta.logMessages ?? [], row.signature, costs);
        if (anchor) transactionEntries.push(anchor);
        else if (ix.programAddress === AGENC_COORDINATION_PROGRAM_ADDRESS) {
          try {
            const { instructionType } = parseAgencCoordinationInstruction({ ...ix,
              accounts: ix.accounts.map(address => ({ address, role: AccountRole.READONLY })) });
            if (instructionType === Ix.RequestChanges || instructionType === Ix.RejectAndFreeze ||
                instructionType === Ix.DisputeRejection) verified = false;
          } catch { verified = false; }
        }
      }
      if (!verified) complete = false;
      if (verified && cache) {
        if (cache.size >= 512) cache.delete(cache.keys().next().value!);
        cache.set(cacheKey, transactionEntries);
      }
      entries.unshift(...transactionEntries);
    }
    if (rows.length < 32) return finish();
    const next = rows.at(-1)?.signature;
    if (typeof next !== "string" || next === before) break;
    before = toSignature(next);
  }
  return finish(before);
}
