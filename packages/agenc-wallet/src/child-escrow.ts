import type { Address } from "@solana/kit";
import { findTaskPda, parseAgencCoordinationEvents } from "@tetsuo-ai/marketplace-sdk";
import type { SettlementHistoryRpc } from "./settlement.js";
import type { HistoryTransaction } from "./review-history.js";

export type EscrowReceipt = { status: "paid" | "refunded"; signature: string };

export async function escrowEvent(
  logs: readonly string[],
  task: Address,
  creator?: Address,
): Promise<EscrowReceipt["status"] | null> {
  for (const e of parseAgencCoordinationEvents(logs)) {
    if (e.eventName === "RejectFrozenResolved" && e.data.task === task)
      return e.data.outcome === 0 ? "refunded" : e.data.outcome === 1 ? "paid" : null;
    if (e.eventName === "RejectFrozenExpired" && e.data.task === task)
      return e.data.workerPayout > 0n ? "paid" : "refunded";
    if (e.eventName === "TaskResultAccepted" && e.data.task === task) return "paid";
    if (e.eventName === "TaskCancelled" && (await findTaskPda(e.data))[0] === task) return "refunded";
    if (
      e.eventName === "TaskCompleted" &&
      creator &&
      (await findTaskPda({ creator, taskId: e.data.taskId }))[0] === task
    )
      return "paid";
  }
  return null;
}

export async function readEscrowReceipt(
  rpc: SettlementHistoryRpc,
  task: Address,
  creator?: Address,
): Promise<EscrowReceipt | null> {
  const rows = await rpc.getSignaturesForAddress(task, { commitment: "confirmed", limit: 20 }).send();
  for (const row of rows) {
    if (row.err !== null || typeof row.signature !== "string") continue;
    const tx = (await rpc
      .getTransaction(row.signature, {
        encoding: "jsonParsed",
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      })
      .send()) as HistoryTransaction | null;
    if (tx?.meta?.err !== null || tx.transaction?.signatures?.[0] !== row.signature || !tx.meta.logMessages)
      continue;
    const status = await escrowEvent(tx.meta.logMessages, task, creator);
    if (status) return { status, signature: row.signature };
  }
  return null;
}
