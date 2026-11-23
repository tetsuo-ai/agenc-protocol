// A settled contest submission closes immediately. Replay the program's own events
// so an owner who was offline can still see the entries and who received each share.
import { createHash } from "node:crypto";
import type { Address, Signature } from "@solana/kit";
import { parseAgencCoordinationEvents, values } from "@tetsuo-ai/marketplace-sdk";

export function submissionId(claim: Address, hash: string, submittedAt: bigint, count: number, dataHex: string) {
  return createHash("sha256").update(JSON.stringify([claim, hash, submittedAt.toString(), count, dataHex])).digest("hex");
}

type Submitted = { status: "submitted"; worker: Address; hash: string; dataHex: string; id: string; submittedAt: number };
export type ContestEvent = Submitted | { status: "winner" | "released" | "rejected"; worker: Address };
export type ContestHistory = { cursor: string | null; events: ContestEvent[] };

export function contestEvents(task: Address, logs: readonly string[]): ContestEvent[] {
  const result: ContestEvent[] = [];
  for (const event of parseAgencCoordinationEvents(logs)) {
    switch (event.eventName) {
      case "TaskResultSubmitted": {
        const s = event.data;
        if (s.task !== task) break;
        const hash = values.bytesToHex(Uint8Array.from(s.proofHash));
        const dataHex = values.bytesToHex(Uint8Array.from(s.resultData));
        result.push({ status: "submitted", worker: s.worker, hash, dataHex, submittedAt: Number(s.submittedAt),
          id: submissionId(s.claim, hash, s.submittedAt, s.submissionCount, dataHex) });
        break;
      }
      case "TaskResultAccepted":
      case "TaskResultRejected":
        if (event.data.task === task) result.push({ status: event.eventName === "TaskResultAccepted" ? "winner" : "rejected", worker: event.data.worker });
        break;
      case "GhostShareDistributed":
        if (event.data.task === task) result.push({ status: "released", worker: event.data.workerAgent });
        break;
    }
  }
  return result;
}

interface HistoryRpc {
  getSignaturesForAddress(task: Address, options: { commitment: "confirmed"; limit: number; before?: Signature; until?: Signature }): {
    send(): Promise<readonly { signature: Signature; err: unknown }[]>;
  };
  getTransaction(signature: Signature, options: { commitment: "confirmed"; encoding: "json"; maxSupportedTransactionVersion: 0 }): {
    send(): Promise<{ transaction: { signatures: readonly string[] }; meta: { err: unknown; logMessages: readonly string[] | null } | null } | null>;
  };
}

export async function readContestHistory(rpc: HistoryRpc, task: Address, since: string | null): Promise<ContestHistory> {
  const signatures: Signature[] = [];
  let before: Signature | undefined;
  let cursor = since;
  for (;;) {
    const page = await rpc.getSignaturesForAddress(task, {
      commitment: "confirmed", limit: 100, ...(before && { before }), ...(since && { until: since as Signature }),
    }).send();
    if (!before && page[0]) cursor = page[0].signature;
    signatures.push(...page.filter(item => item.err === null).map(item => item.signature));
    if (page.length < 100) break;
    before = page[page.length - 1]!.signature;
  }
  const events: ContestEvent[] = [];
  signatures.reverse();
  // Preserve program order without sending an unbounded burst of reads to the RPC.
  for (let start = 0; start < signatures.length; start += 4) {
    const batch = await Promise.all(signatures.slice(start, start + 4).map(async signature => {
      const tx = await rpc.getTransaction(signature, { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 }).send();
      if (!tx || tx.transaction.signatures[0] !== signature || !tx.meta?.logMessages || tx.meta.err !== null) {
        throw new Error("The contest history is not available yet.");
      }
      return contestEvents(task, tx.meta.logMessages);
    }));
    events.push(...batch.flat());
  }
  return { cursor, events };
}
