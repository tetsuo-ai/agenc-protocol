// Settlement closes the live submission. Its authenticated completion event
// retains the delivery commitment for a buyer who comes back after payment.
import type { Address } from "@solana/kit";
import { findTaskPda, parseAgencCoordinationEvents, values } from "@tetsuo-ai/marketplace-sdk";
import { settlementWorkerIn, type SettlementHistoryRpc } from "./settlement.js";

export interface SettledDelivery {
  worker: Address;
  proofHashHex: string;
  resultData: Uint8Array;
}

export async function settledDeliveryFromLogs(
  logs: readonly string[], task: Address, creator: Address, worker: Address,
): Promise<SettledDelivery | null> {
  for (const event of parseAgencCoordinationEvents(logs)) {
    if (event.eventName !== "TaskCompleted" || event.data.worker !== worker) continue;
    const [completed] = await findTaskPda({ creator, taskId: event.data.taskId });
    if (completed !== task) continue;
    return {
      worker,
      proofHashHex: values.bytesToHex(Uint8Array.from(event.data.proofHash)),
      resultData: Uint8Array.from(event.data.resultData),
    };
  }
  return null;
}

/** Only successful, matching settlements and program-authenticated logs count. */
export async function readSettledDelivery(
  rpc: SettlementHistoryRpc, task: Address, creator: Address,
): Promise<SettledDelivery | null> {
  const history = await rpc.getSignaturesForAddress(task, { limit: 100, commitment: "confirmed" }).send();
  for (const entry of history) {
    if (typeof entry.signature !== "string" || entry.err !== null) continue;
    const transaction = await rpc.getTransaction(entry.signature, {
      commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0,
    }).send();
    const worker = settlementWorkerIn(transaction, task, entry.signature);
    if (worker === null) continue;
    const logs = (transaction as { meta?: { logMessages?: unknown } }).meta?.logMessages;
    if (!Array.isArray(logs) || !logs.every((line) => typeof line === "string")) continue;
    const delivery = await settledDeliveryFromLogs(logs, task, creator, worker);
    if (delivery !== null) return delivery;
  }
  return null;
}
