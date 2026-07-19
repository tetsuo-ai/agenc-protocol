// P7.1 task-thread client: publish / read / resolve buyer<->worker envelopes
// over the content-rails transport seam. These helpers are pure content rails —
// they hold no key and broadcast nothing. The on-chain digest the message
// anchors (changes_hash / rejection_hash / rationale_hash) is committed by the
// usual facade instruction (request_changes / reject_task_result /
// resolve_dispute); the storefront publish path re-verifies sha256(envelope)
// against that on-chain digest before storing it.
//
// Browser-safe: the transport seam + WebCrypto only — no Node built-ins.
import type { Address } from "@solana/kit";
import type { ContentTransport, UploadTicket } from "./transport.js";
import {
  assertTaskThreadEnvelope,
  assertTaskThreadTaskPda,
  envelopeHash,
  type TaskThreadEnvelope,
} from "./envelope.js";

/** Default maximum number of envelopes accepted in one fetched task thread. */
export const DEFAULT_MAX_TASK_THREAD_MESSAGES = 256;

/** Resource bounds applied while decoding a fetched task thread. */
export interface FetchTaskThreadOptions {
  /** Maximum envelopes accepted in one response. Defaults to 256. */
  maxMessages?: number;
}

/** The ordered thread returned by {@link fetchTaskThread}. */
export interface TaskThread {
  /** Messages in publish order (oldest first), as the content host returned them. */
  messages: TaskThreadEnvelope[];
}

/** The publish receipt returned by {@link postTaskMessage}. */
export interface PostTaskMessageResult {
  /** Lowercase-hex sha256 of the canonical envelope (the on-chain digest it anchors). */
  hash: string;
  /** The envelope that was published (echoed for convenience). */
  envelope: TaskThreadEnvelope;
}

/**
 * Publish a task-thread envelope to the content host
 * (`POST /api/task-threads/<taskPda>`). The SDK computes the canonical
 * envelope hash and sends `{ envelope, hash }`; the storefront re-verifies
 * `sha256(envelope) === hash` AND that the hash matches a known on-chain digest
 * for the task (request_changes / reject_task_result / resolve_dispute) before
 * storing it — an envelope that does not match an anchored digest is rejected.
 *
 * Wallet-verified / upload-ticket gated like the artifact rails: pass `ticket`
 * (or set the transport's default `uploadTicket`).
 *
 * @param transport - The content-rails transport (storefront or fake).
 * @param envelope - The canonical envelope to publish.
 * @param ticket - Optional per-call upload ticket (overrides the transport default).
 * @returns The canonical hash + the published envelope.
 */
export async function postTaskMessage(
  transport: ContentTransport,
  envelope: TaskThreadEnvelope,
  ticket?: UploadTicket,
): Promise<PostTaskMessageResult> {
  const outbound = assertTaskThreadEnvelope(envelope);
  const { hex } = await envelopeHash(outbound);
  const body = await transport.post(
    `/api/task-threads/${encodeURIComponent(outbound.taskPda)}`,
    { envelope: outbound, hash: hex },
    ticket,
  );
  // The publish path echoes the stored envelope; trust the locally-computed
  // hash (we hashed the bytes we sent), and re-narrow the echoed envelope.
  if (body !== null && typeof body === "object" && "envelope" in body) {
    const echoed = assertTaskThreadEnvelope(
      (body as { envelope: unknown }).envelope,
    );
    const echoedHash = await envelopeHash(echoed);
    if (echoedHash.hex !== hex) {
      // A host echo is informational only. Never pair changed content with the
      // commitment calculated over the outbound envelope.
      return { hash: hex, envelope: outbound };
    }
  }
  return { hash: hex, envelope: outbound };
}

/**
 * Fetch the ordered buyer<->worker thread for a task
 * (`GET /api/task-threads/<taskPda>` -> `{ messages: Envelope[] }`). Every
 * message is structurally validated before it is returned.
 *
 * @param transport - The content-rails transport.
 * @param taskPda - The Task PDA whose thread to read.
 * @param options - Optional message-count bound.
 * @returns The ordered thread.
 * @throws TypeError when the body is not `{ messages: Envelope[] }`.
 */
export async function fetchTaskThread(
  transport: ContentTransport,
  taskPda: Address | string,
  options: FetchTaskThreadOptions = {},
): Promise<TaskThread> {
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_TASK_THREAD_MESSAGES;
  if (!Number.isSafeInteger(maxMessages) || maxMessages <= 0) {
    throw new TypeError(
      "fetchTaskThread: maxMessages must be a positive safe integer",
    );
  }
  const task = assertTaskThreadTaskPda(String(taskPda));
  const body = await transport.get(
    `/api/task-threads/${encodeURIComponent(task)}`,
  );
  if (body === null || typeof body !== "object" || !("messages" in body)) {
    throw new TypeError(
      "fetchTaskThread: content host did not return { messages: Envelope[] }",
    );
  }
  const raw = (body as { messages: unknown }).messages;
  if (!Array.isArray(raw)) {
    throw new TypeError("fetchTaskThread: `messages` is not an array");
  }
  if (raw.length > maxMessages) {
    throw new TypeError(
      `fetchTaskThread: content host returned ${raw.length} messages, ` +
        `exceeding the limit of ${maxMessages}`,
    );
  }
  const messages = raw.map((message, index) => {
    const envelope = assertTaskThreadEnvelope(message);
    if (envelope.taskPda !== task) {
      throw new TypeError(
        `fetchTaskThread: message[${index}] belongs to ${envelope.taskPda}, not requested task ${task}`,
      );
    }
    return envelope;
  });
  return { messages };
}

/**
 * Resolve an on-chain change-request digest back to the envelope that produced
 * it. Reads the task thread, finds the envelope whose canonical hash equals
 * `onChainHash` (the `changes_hash` / `rejection_hash` / `rationale_hash` the
 * worker sees on-chain), and returns it — so the worker learns WHAT changes
 * were asked. The hash is verified locally; a thread message that does not hash
 * to its claimed digest is never matched.
 *
 * @param transport - The content-rails transport.
 * @param taskPda - The Task PDA whose thread to search.
 * @param onChainHash - The 32-byte on-chain digest (bytes or lowercase-hex).
 * @param options - Optional message-count bound for the fetched thread.
 * @returns The matching decoded envelope.
 * @throws Error when no thread message hashes to `onChainHash`.
 */
export async function resolveChangesRequest(
  transport: ContentTransport,
  taskPda: Address | string,
  onChainHash: Uint8Array | string,
  options: FetchTaskThreadOptions = {},
): Promise<TaskThreadEnvelope> {
  const wantHex = normalizeHash(onChainHash);
  const { messages } = await fetchTaskThread(transport, taskPda, options);
  for (const envelope of messages) {
    const { hex } = await envelopeHash(envelope);
    if (hex === wantHex) return envelope;
  }
  throw new Error(
    `resolveChangesRequest: no envelope in the thread for ${String(taskPda)} ` +
      `hashes to the on-chain digest ${wantHex}`,
  );
}

/** Normalize an on-chain hash (bytes or hex, any case, optional 0x) to lowercase hex. */
function normalizeHash(hash: Uint8Array | string): string {
  if (typeof hash === "string") {
    const clean =
      hash.startsWith("0x") || hash.startsWith("0X") ? hash.slice(2) : hash;
    if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
      throw new TypeError(
        "resolveChangesRequest: onChainHash must be exactly 32 bytes / 64 hex characters",
      );
    }
    return clean.toLowerCase();
  }
  if (hash.length !== 32) {
    throw new TypeError(
      "resolveChangesRequest: onChainHash must be exactly 32 bytes / 64 hex characters",
    );
  }
  let hex = "";
  for (const byte of hash) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
