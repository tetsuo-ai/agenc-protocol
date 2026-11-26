// A bounded discovery page and independent retries for missing transactions.
// Transaction order comes from the address index, including transactions in the same slot.
import { createHash } from "node:crypto";
import type { Address, Signature } from "@solana/kit";
import { parseAgencCoordinationEvents, values } from "@tetsuo-ai/marketplace-sdk";

export function submissionId(claim: Address, hash: string, submittedAt: bigint, count: number, dataHex: string) {
  return createHash("sha256").update(JSON.stringify([claim, hash, submittedAt.toString(), count, dataHex])).digest("hex");
}

type Submitted = { status: "submitted"; worker: Address; hash: string; dataHex: string; id: string; submittedAt: number };
type Settlement = { status: "winner" | "released" | "rejected"; worker: Address; prize?: string; fee?: string };
export type NativeChange = { address: string; lamports: string };
export type ContestEvent = (Submitted | Settlement) & { eventId: string; signature: string; changes?: NativeChange[] };
type HistoryRow = { signature: string; events?: ContestEvent[] };
export interface ContestCheckpoint {
  before?: string;
  until?: string;
  nextRetry?: string;
  slot: number;
  rows: HistoryRow[];
}
export type ContestHistory = { cursor: string | null; events: ContestEvent[]; checkpoint?: ContestCheckpoint };

export function contestEvents(task: Address, logs: readonly string[], signature: string, changes?: NativeChange[]): ContestEvent[] {
  const result: ContestEvent[] = [];
  const rewards = new Map<Address, { prize: string; fee: string }>();
  for (const [index, event] of parseAgencCoordinationEvents(logs).entries()) {
    const identity = { signature, eventId: createHash("sha256").update(signature + ":" + index).digest("hex") };
    switch (event.eventName) {
      case "RewardDistributed":
        rewards.set(event.data.recipient, { prize: event.data.amount.toString(), fee: event.data.protocolFee.toString() });
        break;
      case "TaskResultSubmitted": {
        const s = event.data;
        if (s.task !== task) break;
        const hash = values.bytesToHex(Uint8Array.from(s.proofHash));
        const dataHex = values.bytesToHex(Uint8Array.from(s.resultData));
        result.push({ ...identity, status: "submitted", worker: s.worker, hash, dataHex, submittedAt: Number(s.submittedAt),
          id: submissionId(s.claim, hash, s.submittedAt, s.submissionCount, dataHex) });
        break;
      }
      case "TaskResultAccepted":
      case "TaskResultRejected":
        if (event.data.task === task) result.push({ ...identity, status: event.eventName === "TaskResultAccepted" ? "winner" : "rejected",
          worker: event.data.worker, ...(event.eventName === "TaskResultAccepted" && rewards.get(event.data.worker)), ...(changes && { changes }) });
        break;
      case "GhostShareDistributed":
        if (event.data.task === task) result.push({ ...identity, status: "released", worker: event.data.workerAgent,
          ...rewards.get(event.data.workerAgent), prize: event.data.lamports.toString(), ...(changes && { changes }) });
        break;
    }
  }
  return result;
}

interface HistoryRpc {
  getSignaturesForAddress(task: Address, options: { commitment: "confirmed"; limit: number; before?: Signature; until?: Signature }): {
    send(): Promise<readonly { signature: Signature; err: unknown; slot: bigint }[]>;
  };
  getTransaction(signature: Signature, options: { commitment: "confirmed"; encoding: "json"; maxSupportedTransactionVersion: 0 }): {
    send(): Promise<{ transaction: { signatures: readonly string[]; message: { accountKeys: readonly string[] } };
      meta: { err: unknown; logMessages: readonly string[] | null; preBalances: readonly bigint[]; postBalances: readonly bigint[];
        loadedAddresses?: { writable: readonly string[]; readonly: readonly string[] } } | null } | null>;
  };
}

export async function readContestHistory(rpc: HistoryRpc, task: Address, since: string | null, saved?: ContestCheckpoint): Promise<ContestHistory> {
  const pageSize = 16;
  const checkpoint: ContestCheckpoint = structuredClone(saved ?? { slot: 0, rows: [] });
  const until = checkpoint.before ? checkpoint.until : since;
  const page = await rpc.getSignaturesForAddress(task, {
    commitment: "confirmed", limit: pageSize, ...(checkpoint.before && { before: checkpoint.before as Signature }), ...(until && { until: until as Signature }),
  }).send();
  const cursor = checkpoint.before ? since : page[0]?.signature ?? since;
  const added = page.filter(row => row.err === null).map(row => ({ signature: row.signature } as HistoryRow));
  const insert = until ? checkpoint.rows.findIndex(row => row.signature === until) : -1;
  checkpoint.rows.splice(checkpoint.before ? (insert < 0 ? checkpoint.rows.length : insert) : 0, 0, ...added);
  if (page.length === pageSize) {
    if (!checkpoint.before && since) checkpoint.until = since;
    checkpoint.before = page.at(-1)!.signature;
  } else {
    delete checkpoint.before;
    delete checkpoint.until;
  }
  checkpoint.slot = Math.max(checkpoint.slot, Number(page[0]?.slot ?? 0));
  const pending = checkpoint.rows.filter(row => !row.events && !added.includes(row));
  const start = (pending.findIndex(row => row.signature === checkpoint.nextRetry) + 1) % (pending.length || 1);
  const retry = [...pending.slice(start), ...pending.slice(0, start)].slice(0, 2);
  if (retry.length) checkpoint.nextRetry = retry.at(-1)!.signature;
  let changed = false;
  for (const row of [...added, ...retry]) {
    const tx = await rpc.getTransaction(row.signature as Signature, { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 }).send().catch(() => null);
    if (!tx || tx.transaction.signatures[0] !== row.signature || !tx.meta?.logMessages || tx.meta.err !== null) continue;
    const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
    const changes = keys.flatMap((address, i) => {
      const delta = tx.meta!.postBalances[i]! - tx.meta!.preBalances[i]!;
      return delta ? [{ address, lamports: delta.toString() }] : [];
    });
    changed = true;
    row.events = contestEvents(task, tx.meta.logMessages, row.signature, changes);
  }
  // Keep cursor boundaries for pagination, missing rows for retry, and marketplace evidence.
  checkpoint.rows = checkpoint.rows.filter(row => !row.events || row.events.length || row.signature === cursor || row.signature === checkpoint.until);
  return { cursor, events: changed ? checkpoint.rows.slice().reverse().flatMap(row => row.events ?? []) : [], checkpoint };
}
