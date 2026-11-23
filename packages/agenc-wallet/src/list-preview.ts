import type { JobView } from "./client/types.js";

// 200 rows leave more than 200 KiB for the RPC envelope within a 1 MiB frame.
export const MAX_JOB_PREVIEW_BYTES = 4096;
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/** Include JSON quoting/escaping and UTF-8, and never split a surrogate pair. */
export function previewText(value: string, budget: number): string {
  if (bytes(value) <= budget) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytes(value.slice(0, middle) + "…") <= budget) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/u.test(value[low - 1]!)) low -= 1;
  return value.slice(0, low) + "…";
}

/** Bound the entire encoded array, including separators, keys and nested text. */
function previewArray<T>(values: T[], budget: number): T[] {
  const result: T[] = [];
  for (const value of values) {
    if (bytes([...result, value]) > budget) break;
    result.push(value);
  }
  return result;
}

/** List fields are previews. Exact evidence belongs to jobs.get/jobs.delivery. */
export function jobListPreview(job: JobView): JobView {
  let budget = 512;
  for (;;) {
    const text = (value: string): string => previewText(value, budget);
    // A shortened URL would point somewhere else. Omit oversized links instead.
    const link = (value: string | null): string | null => value !== null && bytes(value) > budget ? null : value;
    const result = job.result === null ? null : {
      ...job.result,
      text: job.result.text === null ? null : text(job.result.text),
      uri: link(job.result.uri),
      files: previewArray(job.result.files, budget),
      textTruncated: job.result.textTruncated === true || (job.result.text !== null && bytes(job.result.text) > budget),
    };
    const preview: JobView = {
      ...job,
      title: text(job.title),
      request: text(job.request),
      acceptance: previewArray(job.acceptance.map(text), budget),
      statusText: text(job.statusText),
      receiptUrl: link(job.receiptUrl),
      error: job.error === null ? null : text(job.error),
      result,
    };
    preview.previewTruncated = JSON.stringify(preview) !== JSON.stringify(job);
    if (bytes(preview) <= MAX_JOB_PREVIEW_BYTES) return preview;
    // IDs, addresses, enum values, hashes and numeric amounts are schema bounded.
    // Reduce every variable field together if the fixed fields need more room.
    if (budget <= 8) throw new Error("Job identifiers exceed the list preview limit.");
    budget = Math.max(8, Math.floor(budget / 2));
  }
}
