import type { ContestEntry } from "./client/types.js";
import { WalletError } from "./errors.js";
import type { JobRecord } from "./store.js";

/** Live entries first. The wallet fetches a full delivery only when its ID is requested. */
export function contestPage(job: JobRecord, after?: string) {
  const rows = [...(job.contestEntries ?? [])].sort((a, b) =>
    Number(b.status === "submitted") - Number(a.status === "submitted") || b.submittedAt - a.submittedAt || a.id.localeCompare(b.id));
  const start = after === undefined ? 0 : rows.findIndex(entry => entry.id === after) + 1;
  if (after !== undefined && start === 0) throw new WalletError("NOT_FOUND", "That entry page is no longer available.");
  const entries: ContestEntry[] = rows.slice(start, start + 12).map(({ commitment, observedEvent, eventId, ...entry }) => ({
    ...entry, files: [], text: entry.text?.slice(0, 512) ?? null, uri: null,
    textTruncated: !!(entry.textTruncated || (entry.text?.length ?? 0) > 512 || entry.files?.length || entry.uri),
  }));
  return { entries, next: start + entries.length < rows.length ? entries.at(-1)!.id : null };
}

export function contestReceipts(job: JobRecord, after?: string) {
  const receipts = job.contestSettlements ?? [];
  const end = after === undefined ? receipts.length : receipts.findIndex(row => row.quoteId === after);
  if (end < 0) throw new WalletError("NOT_FOUND", "That receipt page is no longer available.");
  const start = Math.max(0, end - 12);
  return { receipts: receipts.slice(start, end).reverse(), next: start ? receipts[start]!.quoteId : null };
}
