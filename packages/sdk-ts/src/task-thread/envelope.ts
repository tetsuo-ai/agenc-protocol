// P7.1 task-thread message envelope: the canonical JSON the buyer<->worker
// exchange anchors on-chain. The worker must learn WHAT changes were asked, so
// the request body is content-addressed: sha256 of the CANONICAL-JSON envelope
// bytes equals the on-chain digest the protocol stores —
//   request_changes      -> changes_hash
//   reject_task_result   -> rejection_hash
//   resolve_dispute      -> rationale_hash
//
// The canonicalization is the SAME `json-stable-v1` the SDK already uses for
// job-spec hashing (sorted keys, dropped `undefined`, no whitespace, no Unicode
// normalization), so an envelope hash interoperates with the on-chain field
// byte-for-byte.
//
// Browser-safe: WebCrypto + the existing values codecs only — no Node built-ins.
import {
  canonicalJobSpecJson,
  type CanonicalJobSpecHash,
} from "../values/job-spec.js";
import { sha256, bytesToHex } from "../values/hash.js";

/** The current task-thread envelope version. */
export const TASK_THREAD_ENVELOPE_VERSION = 1;

/** Who authored an envelope in the buyer<->worker thread. */
export type TaskThreadRole = "buyer" | "worker";

/** An attachment referenced (not inlined) by an envelope. */
export interface TaskThreadAttachment {
  /** URI of the attachment (e.g. an `agenc://` or `https://` artifact pointer). */
  uri: string;
  /** Lowercase-hex sha256 of the attachment bytes (content address). */
  hash: string;
}

/**
 * The canonical task-thread message envelope (v1). `sha256` of its
 * canonical-JSON bytes is the on-chain digest it anchors. Field order is
 * irrelevant — canonicalization sorts keys — but the SHAPE is fixed.
 */
export interface TaskThreadEnvelope {
  /** Envelope version. MUST be {@link TASK_THREAD_ENVELOPE_VERSION} (1). */
  v: typeof TASK_THREAD_ENVELOPE_VERSION;
  /** The Task PDA this message belongs to (base58). */
  taskPda: string;
  /**
   * Lowercase-hex sha256 of the PARENT envelope this one replies to, or `null`
   * for the first message in the thread. Chains the thread so order/lineage is
   * verifiable.
   */
  parentHash: string | null;
  /** Who authored this message. */
  role: TaskThreadRole;
  /** The free-text message body (e.g. the change request rationale). */
  body: string;
  /** Referenced attachments (empty array when none). */
  attachments: TaskThreadAttachment[];
  /** Author Unix timestamp (seconds). */
  ts: number;
}

/**
 * Canonicalize an envelope to its `json-stable-v1` string — the EXACT byte
 * source the hash is taken over. Exposed so callers can inspect/store the
 * canonical form. Same canonicalization as {@link canonicalJobSpecJson}.
 *
 * @param envelope - The envelope to canonicalize.
 * @returns The canonical JSON string.
 */
export function canonicalEnvelopeJson(envelope: TaskThreadEnvelope): string {
  return canonicalJobSpecJson(envelope);
}

/**
 * Compute the on-chain digest of an envelope: sha256 of its canonical-JSON
 * bytes. The result equals the `changes_hash` / `rejection_hash` /
 * `rationale_hash` the protocol stores for the message.
 *
 * @param envelope - The envelope to hash.
 * @returns `{ bytes, hex }`: 32 raw bytes for the on-chain `[u8; 32]` field,
 *   lowercase hex for comparison/display.
 */
export async function envelopeHash(
  envelope: TaskThreadEnvelope,
): Promise<CanonicalJobSpecHash> {
  const bytes = await sha256(canonicalEnvelopeJson(envelope));
  return { bytes, hex: bytesToHex(bytes) };
}

/**
 * Structurally validate an unknown value as a {@link TaskThreadEnvelope}. Used
 * by {@link fetchTaskThread} to narrow untrusted server bodies before hashing.
 *
 * @returns The narrowed envelope.
 * @throws TypeError describing the first structural problem found.
 */
export function assertTaskThreadEnvelope(value: unknown): TaskThreadEnvelope {
  if (value === null || typeof value !== "object") {
    throw new TypeError("task-thread envelope: not a JSON object");
  }
  const e = value as Record<string, unknown>;
  if (e.v !== TASK_THREAD_ENVELOPE_VERSION) {
    throw new TypeError(
      `task-thread envelope: unsupported version ${String(e.v)} (expected ${TASK_THREAD_ENVELOPE_VERSION})`,
    );
  }
  if (typeof e.taskPda !== "string" || e.taskPda.length === 0) {
    throw new TypeError("task-thread envelope: `taskPda` must be a non-empty string");
  }
  if (e.parentHash !== null && typeof e.parentHash !== "string") {
    throw new TypeError("task-thread envelope: `parentHash` must be a hex string or null");
  }
  if (e.role !== "buyer" && e.role !== "worker") {
    throw new TypeError('task-thread envelope: `role` must be "buyer" or "worker"');
  }
  if (typeof e.body !== "string") {
    throw new TypeError("task-thread envelope: `body` must be a string");
  }
  if (!Array.isArray(e.attachments)) {
    throw new TypeError("task-thread envelope: `attachments` must be an array");
  }
  const attachments: TaskThreadAttachment[] = e.attachments.map((a, i) => {
    if (a === null || typeof a !== "object") {
      throw new TypeError(`task-thread envelope: attachment[${i}] is not an object`);
    }
    const att = a as Record<string, unknown>;
    if (typeof att.uri !== "string" || typeof att.hash !== "string") {
      throw new TypeError(
        `task-thread envelope: attachment[${i}] must be { uri: string, hash: string }`,
      );
    }
    return { uri: att.uri, hash: att.hash };
  });
  if (typeof e.ts !== "number" || !Number.isFinite(e.ts)) {
    throw new TypeError("task-thread envelope: `ts` must be a finite number");
  }
  return {
    v: TASK_THREAD_ENVELOPE_VERSION,
    taskPda: e.taskPda,
    parentHash: e.parentHash,
    role: e.role,
    body: e.body,
    attachments,
    ts: e.ts,
  };
}
