import { AccountRole, signature as toSignature, type Address, type Signature } from "@solana/kit";
import {
  AgencCoordinationInstruction as Ix, AGENC_COORDINATION_PROGRAM_ADDRESS, findTaskSubmissionPda,
  parseAgencCoordinationEvents, parseAgencCoordinationInstruction,
} from "@tetsuo-ai/marketplace-sdk";
import { closedRevisionDeadline } from "./review-deadline.js";
import { settledDeliveryFromLogs } from "./delivery-history.js";
import { reviewRead } from "./review.js";
import { submissionAssertions } from "./money-assertions.js";
import { intendedDelivery } from "./review-memo.js";
import type { ReviewEntry, ReviewedDelivery } from "./client/reviews.js";
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
export function reviewAnchor(ix: SentInstruction, logs: readonly string[], signature: string, costs: TransactionCosts, memo?: unknown): ReviewAnchor | null {
  if (ix.programAddress !== AGENC_COORDINATION_PROGRAM_ADDRESS) return null;
  let parsed;
  try {
    parsed = parseAgencCoordinationInstruction({
      programAddress: ix.programAddress, accounts: ix.accounts.map(address => ({ address, role: AccountRole.READONLY })), data: ix.data,
    });
  } catch { return null; }
  if (parsed.instructionType !== Ix.RequestChanges && parsed.instructionType !== Ix.RejectAndFreeze &&
      parsed.instructionType !== Ix.DisputeRejection && parsed.instructionType !== Ix.AcceptTaskResult) return null;
  for (const event of parseAgencCoordinationEvents(logs)) {
    if (event.eventName === "TaskResultAccepted" && parsed.instructionType === Ix.AcceptTaskResult &&
        event.data.task === parsed.accounts.task.address && event.data.claim === parsed.accounts.claim.address) {
      const intended = intendedDelivery(memo, event.data.claim, "approve");
      if (intended) return { action: "approve", signature, at: Number(event.data.acceptedAt) * 1000, intendedDelivery: intended,
        hash: intended.deliveryHash, deadline: null, feeLamports: costs.fee, rentLamports: 0n, bondLamports: 0n };
    }
    if (event.eventName !== "TaskChangesRequested" && event.eventName !== "TaskRejectFrozen" && event.eventName !== "RejectionDisputed") continue;
    if (event.data.task !== parsed.accounts.task.address || event.data.claim !== parsed.accounts.claim.address) continue;
    const common = { signature, at: Number(event.data.timestamp) * 1000, feeLamports: costs.fee };
    if (parsed.instructionType === Ix.RequestChanges && event.eventName === "TaskChangesRequested") {
      return { ...common, action: "change", intendedDelivery: intendedDelivery(memo, event.data.claim, "change"), round: event.data.round, hash: Buffer.from(parsed.data.changesHash).toString("hex"), deadline: revisionDeadline(logs, event.data.claim, event.data.round), rentLamports: 0n, bondLamports: 0n };
    }
    if (parsed.instructionType === Ix.RejectAndFreeze && event.eventName === "TaskRejectFrozen" &&
        Buffer.from(event.data.rejectionHash).equals(Buffer.from(parsed.data.rejectionHash))) {
      const creator = costs.balanceChange(parsed.accounts.creatorStats.address);
      const seller = costs.balanceChange(parsed.accounts.agentStats.address);
      return { ...common, action: "reject", intendedDelivery: intendedDelivery(memo, event.data.claim, "reject"), hash: Buffer.from(event.data.rejectionHash).toString("hex"),
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

export interface HistoryTransaction {
  transaction?: { signatures?: string[]; message?: { accountKeys?: (string | { pubkey: string })[]; instructions?: unknown[] } };
  meta?: { err: unknown; fee?: unknown; preBalances?: unknown[]; postBalances?: unknown[]; logMessages?: string[]; innerInstructions?: { instructions: unknown[] }[] };
}

export function submittedDelivery(logs: readonly string[], task: Address, claim: Address): ReviewedDelivery | undefined {
  for (const event of parseAgencCoordinationEvents(logs).reverse()) {
    if (event.eventName === "TaskResultSubmitted" && event.data.task === task && event.data.claim === claim) {
      return { deliveryHash: Buffer.from(event.data.proofHash).toString("hex"), submissionCount: event.data.submissionCount };
    }
  }
}

// A revision 9 receipt does not always carry the delivery. Read backwards
// from this exact decision, never from the current account or the current tip.
// A missing intervening receipt could itself be a resubmission.
async function deliveryBeforeDecision(rpc: SettlementHistoryRpc, task: Address, claim: Address, decision: ReviewAnchor) {
  let before = toSignature(decision.signature);
  const until = performance.now() + 2000;
  while (performance.now() < until) {
    const rows = await reviewRead(rpc.getSignaturesForAddress(claim, { before, limit: 16, commitment: "confirmed" }).send(), 800);
    if (!rows?.length) return;
    for (const row of rows) {
      if (typeof row.signature !== "string" || row.err === undefined || performance.now() >= until) return;
      if (row.err !== null) continue;
      const tx = await reviewRead(rpc.getTransaction(row.signature, {
        encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0,
      }).send(), 800) as HistoryTransaction | null;
      const logs = tx?.meta?.logMessages;
      if (!logs?.length || tx?.meta?.err !== null || tx.transaction?.signatures?.[0] !== row.signature ||
          logs.some(line => line.startsWith("Log truncated"))) return;
      const delivery = submittedDelivery(logs, task, claim);
      if (delivery) return decision.round === undefined || decision.round === delivery.submissionCount ? delivery : undefined;
    }
    const next = rows.at(-1)?.signature;
    if (rows.length < 16 || typeof next !== "string" || next === before) return;
    before = toSignature(next);
  }
}

async function identifyAppliedDelivery(rpc: SettlementHistoryRpc, task: Address, claim: Address, logs: readonly string[], anchor: ReviewAnchor, guarded: boolean) {
  if (anchor.action === "approve") {
    const acceptance = parseAgencCoordinationEvents(logs).find(event =>
      event.eventName === "TaskResultAccepted" && event.data.task === task && event.data.claim === claim);
    if (acceptance?.eventName === "TaskResultAccepted") {
      const paid = await settledDeliveryFromLogs(logs, task, acceptance.data.acceptedBy, acceptance.data.worker);
      if (paid) anchor.paidDeliveryHash = paid.proofHashHex;
    }
  }
  anchor.appliedDelivery = guarded ? anchor.intendedDelivery : await deliveryBeforeDecision(rpc, task, claim, anchor).catch(() => undefined);
  if (anchor.paidDeliveryHash && anchor.appliedDelivery?.deliveryHash !== anchor.paidDeliveryHash) delete anchor.appliedDelivery;
}

// A legacy wallet put the memo immediately after its compute budget. A bound
// decision adds exactly two checks on this claim's submission before the memo.
// Other batches cannot establish the affected delivery from the memo alone.
async function decisionBinding(prefix: unknown[], claim: Address, intended: ReviewedDelivery) {
  const first = prefix.findIndex(raw =>
    (raw as { programId?: string } | null)?.programId !== "ComputeBudget111111111111111111111111111111");
  if (first < 0) return "legacy";
  if (prefix.length - first !== 2) return "unrecognized";
  const [submission] = await findTaskSubmissionPda({ claim });
  const matches = submissionAssertions(submission, intended).every((expected, i) => {
    const actual = sentInstruction(prefix[first + i]);
    return actual?.programAddress === expected.programAddress && actual.accounts.length === 1 &&
      actual.accounts[0] === submission && Buffer.from(actual.data).equals(Buffer.from(expected.data!));
  });
  return matches ? "guarded" : "unrecognized";
}

export function deliveryNotice(entry: ReviewAnchor): string | undefined {
  const intended = entry.intendedDelivery;
  if (!intended) return;
  const applied = entry.appliedDelivery;
  const decision = entry.action === "approve" ? "payment" : entry.action === "reject" ? "rejection" : "change request";
  if (applied && applied.deliveryHash === intended.deliveryHash && applied.submissionCount === intended.submissionCount) return;
  const round = applied?.submissionCount ?? entry.round;
  if (applied || (round !== undefined && round !== intended.submissionCount) ||
      (entry.paidDeliveryHash && entry.paidDeliveryHash !== intended.deliveryHash)) {
    const which = round === undefined ? "" : ` (round ${round})`;
    return `The buyer reviewed delivery ${intended.submissionCount}, but the confirmed ${decision} applied to a different delivery${which}.`;
  }
  return `The buyer reviewed delivery ${intended.submissionCount}. The ${decision} was confirmed. Its affected delivery could not be verified.`;
}

export async function readReviewHistory(rpc: SettlementHistoryRpc, task: Address, claim: Address,
  cache?: Map<string, readonly ReviewAnchor[]>, cursor?: string, claimDuration?: () => Promise<bigint>): Promise<ReviewHistory> {
  const entries: ReviewAnchor[] = [];
  let before: Signature | undefined = cursor ? toSignature(cursor) : undefined;
  let complete = true;
  const until = performance.now() + 2200;
  const finish = async (next?: Signature): Promise<ReviewHistory> => {
    await Promise.all(entries.map(async (entry, i) => {
      if (entry.action !== "change" || entry.deadline !== null || !entry.round) return;
      const deadline = await closedRevisionDeadline(rpc, task, claim, entry, claimDuration).catch(() => null);
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
      const outer = message?.instructions ?? [];
      const instructions = [...outer, ...(meta.innerInstructions ?? []).flatMap(group => group.instructions)];
      const transactionEntries: ReviewAnchor[] = [];
      let verified = true;
      for (const [index, raw] of instructions.entries()) {
        const ix = sentInstruction(raw);
        if (!ix || ix.accounts[0] !== task || ix.accounts[1] !== claim) continue;
        const memo = index > 0 && index === outer.length - 1 ? outer[index - 1] : undefined;
        let anchor = reviewAnchor(ix, meta.logMessages ?? [], row.signature, costs, memo);
        if (anchor?.intendedDelivery) {
          const binding = await decisionBinding(outer.slice(0, index - 1), claim, anchor.intendedDelivery);
          if (binding === "unrecognized") anchor = reviewAnchor(ix, meta.logMessages ?? [], row.signature, costs);
          else {
            await identifyAppliedDelivery(rpc, task, claim, meta.logMessages!, anchor, binding === "guarded");
            if (!anchor.appliedDelivery) verified = false;
          }
        }
        if (anchor) {
          transactionEntries.push(anchor);
        } else if (ix.programAddress === AGENC_COORDINATION_PROGRAM_ADDRESS) {
          try {
            const { instructionType } = parseAgencCoordinationInstruction({ ...ix,
              accounts: ix.accounts.map(address => ({ address, role: AccountRole.READONLY })) });
            if (instructionType === Ix.RequestChanges || instructionType === Ix.RejectAndFreeze ||
                instructionType === Ix.DisputeRejection) verified = false;
            // Older payments have no delivery memo. Their acceptance event still has to be present.
            if ((instructionType === Ix.AcceptTaskResult || instructionType === Ix.AutoAcceptTaskResult) && !parseAgencCoordinationEvents(meta.logMessages!).some(event =>
              event.eventName === "TaskResultAccepted" && event.data.task === task && event.data.claim === claim)) verified = false;
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
