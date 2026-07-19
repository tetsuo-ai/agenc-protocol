// Persistent worker state under `stateDir` (default is an RPC+wallet-namespaced
// child of `~/.local/state/agenc-worker`): agent identity, the in-flight WAL,
// and the submission ledger. State is private (0700 directory / 0600 file),
// validated fail-closed, written through a unique+fsynced temp file, and
// protected by an exclusive active-runtime lock.
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";
import { address } from "@solana/kit";

export const WORKER_STATE_VERSION = 1 as const;

/** Hard resource ceilings for the hot worker WAL/state file. */
export const MAX_WORKER_STATE_BYTES = 16 * 1024 * 1024;
export const MAX_UNSETTLED_SUBMISSIONS = 10_000;
export const SETTLED_SUBMISSION_RETENTION = 1_000;
const MAX_PARSED_SUBMISSIONS = 50_000;

/** Executor stdout persisted immediately after a successful execution. */
export type ExecutionIntent = {
  /** Exact executor stdout, canonical base64. The state file is private. */
  resultBytesBase64: string;
  /** sha256 hex of `resultBytesBase64`. */
  resultHashHex: string;
  /** Task reward observed at execution, as decimal lamports. */
  rewardAmount: string;
  /** ISO timestamp at which stdout was durably recorded. */
  executedAt: string;
};

/** Durable result metadata written before the submission transaction is sent. */
export type SubmissionIntent = {
  /** Result URI returned by the uploader (or the agenc:// placeholder). */
  resultUri: string;
  /** sha256 hex of the executor stdout. */
  resultHashHex: string;
  /** Task reward observed when the work was prepared, as decimal lamports. */
  rewardAmount: string;
  /** ISO timestamp at which this intent was durably recorded. */
  preparedAt: string;
  /** ISO timestamp immediately before the most recent broadcast attempt. */
  lastBroadcastAt?: string;
  /** Ambiguous submitted transaction signature, when the SDK surfaced one. */
  transactionSignature?: string;
};

/** A claim/execution/submission transaction that still needs reconciliation. */
export type OpenClaim = {
  /** Task PDA (base58). */
  task: string;
  /** ISO timestamp at which claiming this task began. */
  claimedAt: string;
  /** Durable lifecycle phase. */
  phase: "claiming" | "claimed" | "executed" | "uploading" | "submitting";
  /** Ambiguous claim transaction signature, when the SDK surfaced one. */
  claimTransactionSignature?: string;
  /** Rejected submission_count already acknowledged as request_changes. */
  revisionSubmissionCount?: number;
  /** Required exactly for `executed` and `uploading`. */
  execution?: ExecutionIntent;
  /** Required exactly for `submitting`. */
  submission?: SubmissionIntent;
};

/** One submitted result awaiting (or past) settlement. */
export type SubmissionRecord = {
  /** Task PDA (base58). */
  task: string;
  /** Submission transaction signature, or null when recovered from chain. */
  submissionSignature: string | null;
  /** Result URI retained privately for delivery bookkeeping. */
  resultUri: string;
  /** sha256 hex of the executor stdout (matches the on-chain proofHash). */
  resultHashHex: string;
  /** Task reward at claim time (lamports, as a decimal string). */
  rewardAmount: string;
  /** ISO timestamp of the submission. */
  submittedAt: string;
  /** True once a settlement (or terminal outcome) was observed. */
  settled: boolean;
  /** Terminal outcome once settled. */
  outcome?: "accepted" | "rejected" | "cancelled" | "closed" | "straggler";
  /** Durable evidence observed before terminal child-account reclamation. */
  terminalEvidence?: "collaborative-straggler";
  /** Lamports actually earned (decimal string), when attributable. */
  earnedLamports?: string | null;
  /** Settlement tx signature when observable, else null. */
  settlementSignature?: string | null;
  /** ISO timestamp settlement was observed. */
  settledAt?: string;
};

/** The whole persisted state. */
export type WorkerState = {
  version: typeof WORKER_STATE_VERSION;
  /** 32-byte agent id, hex-encoded (64 chars). */
  agentIdHex: string | null;
  /** The at-most-one in-flight task. */
  openClaim: OpenClaim | null;
  /** `AgentRegistration.totalEarned` baseline, as decimal lamports. */
  totalEarnedBaseline: string;
  /** Submission ledger, oldest first. */
  submissions: SubmissionRecord[];
};

export class WorkerStateError extends Error {
  override name = "WorkerStateError";
}

const STATE_FILE = "state.json";
const LOCK_FILE = ".active.lock";
const HASH_HEX = /^[0-9a-f]{64}$/u;
const DECIMAL = /^\d+$/u;

function fail(message: string): never {
  throw new WorkerStateError(`invalid worker state: ${message}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label}.${key} is not supported`);
  }
  for (const key of required) {
    if (!(key in value)) fail(`${label}.${key} is required`);
  }
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} must be a string`);
  return value;
}

function nonempty(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (parsed.length === 0) fail(`${label} must not be empty`);
  return parsed;
}

function iso(value: unknown, label: string): string {
  const parsed = string(value, label);
  const timestamp = Date.parse(parsed);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== parsed
  ) {
    fail(`${label} must be a canonical ISO timestamp`);
  }
  return parsed;
}

function decimal(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!DECIMAL.test(parsed)) fail(`${label} must be unsigned decimal lamports`);
  return parsed;
}

function hash(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!HASH_HEX.test(parsed))
    fail(`${label} must be a 32-byte lowercase hex hash`);
  return parsed;
}

function taskAddress(value: unknown, label: string): string {
  const parsed = nonempty(value, label);
  try {
    address(parsed);
  } catch {
    fail(`${label} must be a valid Solana address`);
  }
  return parsed;
}

function optionalSignature(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return nonempty(value, label);
}

function executionIntent(value: unknown, label: string): ExecutionIntent {
  const parsed = record(value, label);
  exactKeys(parsed, label, [
    "resultBytesBase64",
    "resultHashHex",
    "rewardAmount",
    "executedAt",
  ]);
  const resultBytesBase64 = string(
    parsed.resultBytesBase64,
    `${label}.resultBytesBase64`,
  );
  const bytes = Buffer.from(resultBytesBase64, "base64");
  if (bytes.toString("base64") !== resultBytesBase64) {
    fail(`${label}.resultBytesBase64 must be canonical base64`);
  }
  const resultHashHex = hash(parsed.resultHashHex, `${label}.resultHashHex`);
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== resultHashHex)
    fail(`${label}.resultHashHex does not match stdout`);
  return {
    resultBytesBase64,
    resultHashHex,
    rewardAmount: decimal(parsed.rewardAmount, `${label}.rewardAmount`),
    executedAt: iso(parsed.executedAt, `${label}.executedAt`),
  };
}

function submissionIntent(value: unknown, label: string): SubmissionIntent {
  const parsed = record(value, label);
  exactKeys(
    parsed,
    label,
    ["resultUri", "resultHashHex", "rewardAmount", "preparedAt"],
    ["lastBroadcastAt", "transactionSignature"],
  );
  const transactionSignature = optionalSignature(
    parsed.transactionSignature,
    `${label}.transactionSignature`,
  );
  return {
    resultUri: nonempty(parsed.resultUri, `${label}.resultUri`),
    resultHashHex: hash(parsed.resultHashHex, `${label}.resultHashHex`),
    rewardAmount: decimal(parsed.rewardAmount, `${label}.rewardAmount`),
    preparedAt: iso(parsed.preparedAt, `${label}.preparedAt`),
    ...(parsed.lastBroadcastAt !== undefined
      ? {
          lastBroadcastAt: iso(
            parsed.lastBroadcastAt,
            `${label}.lastBroadcastAt`,
          ),
        }
      : {}),
    ...(transactionSignature !== undefined ? { transactionSignature } : {}),
  };
}

function openClaim(value: unknown, label: string): OpenClaim {
  const parsed = record(value, label);
  exactKeys(
    parsed,
    label,
    ["task", "claimedAt", "phase"],
    [
      "claimTransactionSignature",
      "revisionSubmissionCount",
      "execution",
      "submission",
    ],
  );
  const phase = parsed.phase;
  if (
    phase !== "claiming" &&
    phase !== "claimed" &&
    phase !== "executed" &&
    phase !== "uploading" &&
    phase !== "submitting"
  ) {
    fail(`${label}.phase is unsupported`);
  }
  const execution =
    parsed.execution === undefined
      ? undefined
      : executionIntent(parsed.execution, `${label}.execution`);
  const submission =
    parsed.submission === undefined
      ? undefined
      : submissionIntent(parsed.submission, `${label}.submission`);
  if (
    (phase === "executed" || phase === "uploading") !==
    (execution !== undefined)
  ) {
    fail(`${label}.execution does not match phase ${phase}`);
  }
  if ((phase === "submitting") !== (submission !== undefined)) {
    fail(`${label}.submission does not match phase ${phase}`);
  }
  const claimTransactionSignature = optionalSignature(
    parsed.claimTransactionSignature,
    `${label}.claimTransactionSignature`,
  );
  if (
    parsed.revisionSubmissionCount !== undefined &&
    (!Number.isInteger(parsed.revisionSubmissionCount) ||
      (parsed.revisionSubmissionCount as number) < 1 ||
      (parsed.revisionSubmissionCount as number) > 65_535)
  ) {
    fail(`${label}.revisionSubmissionCount must be a positive u16`);
  }
  return {
    task: taskAddress(parsed.task, `${label}.task`),
    claimedAt: iso(parsed.claimedAt, `${label}.claimedAt`),
    phase,
    ...(claimTransactionSignature !== undefined
      ? { claimTransactionSignature }
      : {}),
    ...(parsed.revisionSubmissionCount !== undefined
      ? { revisionSubmissionCount: parsed.revisionSubmissionCount as number }
      : {}),
    ...(execution !== undefined ? { execution } : {}),
    ...(submission !== undefined ? { submission } : {}),
  };
}

function submissionRecord(value: unknown, label: string): SubmissionRecord {
  const parsed = record(value, label);
  exactKeys(
    parsed,
    label,
    [
      "task",
      "submissionSignature",
      "resultUri",
      "resultHashHex",
      "rewardAmount",
      "submittedAt",
      "settled",
    ],
    [
      "outcome",
      "terminalEvidence",
      "earnedLamports",
      "settlementSignature",
      "settledAt",
    ],
  );
  if (
    parsed.submissionSignature !== null &&
    typeof parsed.submissionSignature !== "string"
  ) {
    fail(`${label}.submissionSignature must be a string or null`);
  }
  if (typeof parsed.settled !== "boolean")
    fail(`${label}.settled must be boolean`);
  const outcome = parsed.outcome;
  if (
    outcome !== undefined &&
    outcome !== "accepted" &&
    outcome !== "rejected" &&
    outcome !== "cancelled" &&
    outcome !== "closed" &&
    outcome !== "straggler"
  ) {
    fail(`${label}.outcome is unsupported`);
  }
  if (
    parsed.terminalEvidence !== undefined &&
    parsed.terminalEvidence !== "collaborative-straggler"
  ) {
    fail(`${label}.terminalEvidence is unsupported`);
  }
  if (
    parsed.settled &&
    (outcome === undefined || parsed.settledAt === undefined)
  ) {
    fail(`${label} settled records require outcome and settledAt`);
  }
  if (
    !parsed.settled &&
    (outcome !== undefined ||
      parsed.earnedLamports !== undefined ||
      parsed.settlementSignature !== undefined ||
      parsed.settledAt !== undefined)
  ) {
    fail(`${label} unsettled records cannot carry terminal fields`);
  }
  if (
    parsed.settled &&
    (parsed.earnedLamports === undefined ||
      parsed.settlementSignature === undefined)
  ) {
    fail(`${label} settled records require complete settlement fields`);
  }
  if (
    parsed.earnedLamports !== undefined &&
    parsed.earnedLamports !== null &&
    (typeof parsed.earnedLamports !== "string" ||
      !DECIMAL.test(parsed.earnedLamports))
  ) {
    fail(`${label}.earnedLamports must be decimal or null`);
  }
  if (
    parsed.settlementSignature !== undefined &&
    parsed.settlementSignature !== null &&
    (typeof parsed.settlementSignature !== "string" ||
      parsed.settlementSignature.length === 0)
  ) {
    fail(`${label}.settlementSignature must be a nonempty string or null`);
  }
  return {
    task: taskAddress(parsed.task, `${label}.task`),
    submissionSignature:
      parsed.submissionSignature === null
        ? null
        : nonempty(parsed.submissionSignature, `${label}.submissionSignature`),
    resultUri: nonempty(parsed.resultUri, `${label}.resultUri`),
    resultHashHex: hash(parsed.resultHashHex, `${label}.resultHashHex`),
    rewardAmount: decimal(parsed.rewardAmount, `${label}.rewardAmount`),
    submittedAt: iso(parsed.submittedAt, `${label}.submittedAt`),
    settled: parsed.settled,
    ...(outcome !== undefined ? { outcome } : {}),
    ...(parsed.terminalEvidence !== undefined
      ? {
          terminalEvidence:
            parsed.terminalEvidence as "collaborative-straggler",
        }
      : {}),
    ...(parsed.earnedLamports !== undefined
      ? { earnedLamports: parsed.earnedLamports as string | null }
      : {}),
    ...(parsed.settlementSignature !== undefined
      ? { settlementSignature: parsed.settlementSignature as string | null }
      : {}),
    ...(parsed.settledAt !== undefined
      ? { settledAt: iso(parsed.settledAt, `${label}.settledAt`) }
      : {}),
  };
}

function currentState(value: unknown): WorkerState {
  const parsed = record(value, "root");
  exactKeys(parsed, "root", [
    "version",
    "agentIdHex",
    "openClaim",
    "totalEarnedBaseline",
    "submissions",
  ]);
  if (parsed.version !== WORKER_STATE_VERSION) {
    fail(`unsupported version ${String(parsed.version)}`);
  }
  if (parsed.agentIdHex !== null && typeof parsed.agentIdHex !== "string") {
    fail("root.agentIdHex must be a string or null");
  }
  const agentIdHex = parsed.agentIdHex;
  if (typeof agentIdHex === "string" && !HASH_HEX.test(agentIdHex)) {
    fail("root.agentIdHex must encode exactly 32 bytes");
  }
  if (!Array.isArray(parsed.submissions))
    fail("root.submissions must be an array");
  if (parsed.submissions.length > MAX_PARSED_SUBMISSIONS) {
    fail(
      `root.submissions exceeds the ${MAX_PARSED_SUBMISSIONS} record parse limit`,
    );
  }
  const submissions = parsed.submissions.map((item, index) =>
    submissionRecord(item, `root.submissions[${index}]`),
  );
  const unsettledCount = submissions.reduce(
    (count, submission) => count + (submission.settled ? 0 : 1),
    0,
  );
  if (unsettledCount > MAX_UNSETTLED_SUBMISSIONS) {
    fail(
      `root.submissions exceeds the ${MAX_UNSETTLED_SUBMISSIONS} unsettled-record limit`,
    );
  }
  if (
    new Set(submissions.map(({ task }) => task)).size !== submissions.length
  ) {
    fail("root.submissions contains duplicate tasks");
  }
  const parsedOpenClaim =
    parsed.openClaim === null
      ? null
      : openClaim(parsed.openClaim, "root.openClaim");
  if (
    parsedOpenClaim !== null &&
    submissions.some(({ task }) => task === parsedOpenClaim.task)
  ) {
    fail("root.openClaim task also exists in the submission ledger");
  }
  return {
    version: WORKER_STATE_VERSION,
    agentIdHex: agentIdHex as string | null,
    openClaim: parsedOpenClaim,
    totalEarnedBaseline: decimal(
      parsed.totalEarnedBaseline,
      "root.totalEarnedBaseline",
    ),
    submissions,
  };
}

/** Exact v0.1.1 migration: the only old form had no version/phase fields. */
function migrateLegacyState(value: unknown): WorkerState {
  const parsed = record(value, "legacy root");
  exactKeys(parsed, "legacy root", [
    "agentIdHex",
    "openClaim",
    "totalEarnedBaseline",
    "submissions",
  ]);
  let migratedClaim: OpenClaim | null = null;
  if (parsed.openClaim !== null) {
    const legacyClaim = record(parsed.openClaim, "legacy root.openClaim");
    exactKeys(legacyClaim, "legacy root.openClaim", ["task", "claimedAt"]);
    migratedClaim = {
      task: taskAddress(legacyClaim.task, "legacy root.openClaim.task"),
      claimedAt: iso(legacyClaim.claimedAt, "legacy root.openClaim.claimedAt"),
      phase: "claimed",
    };
  }
  return currentState({
    version: WORKER_STATE_VERSION,
    agentIdHex: parsed.agentIdHex,
    openClaim: migratedClaim,
    totalEarnedBaseline: parsed.totalEarnedBaseline,
    submissions: parsed.submissions,
  });
}

/** Fresh empty state. */
export function emptyState(): WorkerState {
  return {
    version: WORKER_STATE_VERSION,
    agentIdHex: null,
    openClaim: null,
    totalEarnedBaseline: "0",
    submissions: [],
  };
}

/**
 * Bound the hot ledger without ever discarding unsettled work. On-chain
 * settlement is the canonical long-term receipt; the local state retains the
 * newest settled records for operator diagnostics.
 */
export function pruneSettledSubmissions(
  state: WorkerState,
  retention = SETTLED_SUBMISSION_RETENTION,
): number {
  if (!Number.isSafeInteger(retention) || retention < 0) {
    throw new WorkerStateError(
      "settled submission retention must be a non-negative safe integer",
    );
  }
  let settledToRemove = Math.max(
    0,
    state.submissions.reduce(
      (count, submission) => count + (submission.settled ? 1 : 0),
      0,
    ) - retention,
  );
  if (settledToRemove === 0) return 0;
  const originalLength = state.submissions.length;
  state.submissions = state.submissions.filter((submission) => {
    if (!submission.settled || settledToRemove === 0) return true;
    settledToRemove -= 1;
    return false;
  });
  return originalLength - state.submissions.length;
}

/** Generate a fresh random 32-byte agent id. */
export function newAgentId(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

/** hex helpers (agent ids are stored hex-encoded). */
export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]+$/u.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`invalid hex string of length ${hex.length}`);
  }
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function assertPrivateOwner(
  metadata: Stats,
  sourcePath: string,
  kind: "directory" | "file",
): void {
  if (
    typeof process.getuid === "function" &&
    metadata.uid !== process.getuid()
  ) {
    throw new WorkerStateError(
      `worker state ${kind} ${sourcePath} must be owned by the current user`,
    );
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new WorkerStateError(
      `worker state ${kind} ${sourcePath} must have private permissions (chmod ${kind === "directory" ? "700" : "600"})`,
    );
  }
}

/** Open the real private state directory without following a final symlink. */
function openPrivateStateDirectory(
  stateDir: string,
  { create, missingOk }: { create: boolean; missingOk: boolean },
): number | null {
  if (create) mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  let before: Stats;
  try {
    before = lstatSync(stateDir);
  } catch (error) {
    if (missingOk && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new WorkerStateError(
      `worker state directory ${stateDir} is unavailable: ${(error as Error).message}`,
    );
  }
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new WorkerStateError(
      `worker state directory ${stateDir} must be a real directory, not a symbolic link`,
    );
  }
  assertPrivateOwner(before, stateDir, "directory");

  let fd: number | null = null;
  try {
    fd = openSync(
      stateDir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const opened = fstatSync(fd);
    if (
      !opened.isDirectory() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error("directory changed while it was being opened");
    }
    assertPrivateOwner(opened, stateDir, "directory");
    return fd;
  } catch (error) {
    if (fd !== null) closeSync(fd);
    throw new WorkerStateError(
      `worker state directory ${stateDir} is unsafe: ${(error as Error).message}`,
    );
  }
}

/** Linux `/proc/self/fd` gives state leaf operations openat-like anchoring. */
function stateLeafPath(stateDir: string, directoryFd: number, leaf: string) {
  return process.platform === "linux"
    ? path.join("/proc/self/fd", String(directoryFd), leaf)
    : path.join(stateDir, leaf);
}

function assertPrivateStateFile(metadata: Stats, sourcePath: string): void {
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new WorkerStateError(
      `worker state file ${sourcePath} must be a regular file and not a symbolic link`,
    );
  }
  assertPrivateOwner(metadata, sourcePath, "file");
  if (metadata.size > MAX_WORKER_STATE_BYTES) {
    throw new WorkerStateError(
      `worker state exceeds ${MAX_WORKER_STATE_BYTES} bytes`,
    );
  }
}

/** Load and validate state, or return an empty state when none exists. */
export function loadState(stateDir: string): WorkerState {
  let raw: string;
  const directoryFd = openPrivateStateDirectory(stateDir, {
    create: false,
    missingOk: true,
  });
  if (directoryFd === null) return emptyState();
  const statePath = stateLeafPath(stateDir, directoryFd, STATE_FILE);
  let stateFd: number | null = null;
  try {
    const before = lstatSync(statePath);
    assertPrivateStateFile(before, path.join(stateDir, STATE_FILE));
    stateFd = openSync(statePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(stateFd);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new WorkerStateError(
        `worker state file ${path.join(stateDir, STATE_FILE)} changed while it was being opened`,
      );
    }
    assertPrivateStateFile(opened, path.join(stateDir, STATE_FILE));
    raw = readFileSync(stateFd, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  } finally {
    if (stateFd !== null) closeSync(stateFd);
    closeSync(directoryFd);
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_WORKER_STATE_BYTES) {
    throw new WorkerStateError(
      `worker state exceeds ${MAX_WORKER_STATE_BYTES} bytes`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new WorkerStateError(
      `invalid worker state JSON: ${(error as Error).message}`,
    );
  }
  const root = record(parsed, "root");
  const state =
    "version" in root ? currentState(root) : migrateLegacyState(root);
  pruneSettledSubmissions(state);
  return state;
}

function ensurePrivateStateDir(stateDir: string): void {
  const fd = openPrivateStateDirectory(stateDir, {
    create: true,
    missingOk: false,
  });
  if (fd === null)
    throw new WorkerStateError("worker state directory vanished");
  closeSync(fd);
}

function fsyncDirectory(stateDir: string): void {
  const fd = openPrivateStateDirectory(stateDir, {
    create: false,
    missingOk: false,
  });
  if (fd === null)
    throw new WorkerStateError("worker state directory vanished");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Persist validated state atomically and durably. */
export function saveState(stateDir: string, state: WorkerState): void {
  const validated = currentState(state);
  pruneSettledSubmissions(validated);
  const serialized = `${JSON.stringify(validated, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_WORKER_STATE_BYTES) {
    throw new WorkerStateError(
      `worker state exceeds ${MAX_WORKER_STATE_BYTES} bytes`,
    );
  }
  const directoryFd = openPrivateStateDirectory(stateDir, {
    create: true,
    missingOk: false,
  });
  if (directoryFd === null)
    throw new WorkerStateError("worker state directory vanished");
  const target = stateLeafPath(stateDir, directoryFd, STATE_FILE);
  const nonce = randomBytes(8).toString("hex");
  const tmp = `${target}.${process.pid}.${nonce}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, serialized, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, target);
    fsyncSync(directoryFd);
  } catch (error) {
    if (fd !== null) closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      // The temp may already have been renamed or removed.
    }
    throw error;
  } finally {
    closeSync(directoryFd);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

type LockOwner = {
  pid: number;
  nonce: string;
  acquiredAt: string;
  bootId?: string;
  processStartTime?: string;
};

type ReaperOwner = LockOwner & {
  targetNonce: string;
};

type ProcessIdentity = {
  bootId: string;
  processStartTime: string;
};

/** Linux process identity, stable across PID reuse; null is a safe fallback. */
export function readProcessIdentity(pid: number): ProcessIdentity | null {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  try {
    const bootId = readFileSync(
      "/proc/sys/kernel/random/boot_id",
      "utf8",
    ).trim();
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
    const commEnd = stat.lastIndexOf(")");
    if (commEnd < 0) return null;
    // The suffix starts at field 3 (state); process start time is field 22.
    const fields = stat
      .slice(commEnd + 1)
      .trim()
      .split(/\s+/u);
    const processStartTime = fields[19];
    if (
      !/^[0-9a-f-]{16,64}$/iu.test(bootId) ||
      processStartTime === undefined ||
      !/^\d+$/u.test(processStartTime)
    ) {
      return null;
    }
    return { bootId, processStartTime };
  } catch {
    return null;
  }
}

function lockIdentity(owner: LockOwner): ProcessIdentity | null {
  if (owner.bootId === undefined || owner.processStartTime === undefined) {
    return null;
  }
  return { bootId: owner.bootId, processStartTime: owner.processStartTime };
}

function processStillOwnsLock(owner: LockOwner): boolean {
  if (!processIsAlive(owner.pid)) return false;
  const expected = lockIdentity(owner);
  if (expected === null) return true; // Legacy/platform fallback: conservative.
  const observed = readProcessIdentity(owner.pid);
  if (observed === null) return true; // Never guess stale when identity is unavailable.
  return (
    observed.bootId === expected.bootId &&
    observed.processStartTime === expected.processStartTime
  );
}

function parseOptionalProcessIdentity(
  parsed: Record<string, unknown>,
  label: string,
  sourcePath: string,
): Pick<LockOwner, "bootId" | "processStartTime"> {
  const hasBoot = "bootId" in parsed;
  const hasStart = "processStartTime" in parsed;
  if (hasBoot !== hasStart) {
    throw new WorkerStateError(
      `${label} ${sourcePath} has incomplete process identity; refusing to remove it`,
    );
  }
  if (!hasBoot) return {};
  if (
    typeof parsed.bootId !== "string" ||
    !/^[0-9a-f-]{16,64}$/iu.test(parsed.bootId) ||
    typeof parsed.processStartTime !== "string" ||
    !/^\d+$/u.test(parsed.processStartTime)
  ) {
    throw new WorkerStateError(
      `${label} ${sourcePath} has invalid process identity; refusing to remove it`,
    );
  }
  return {
    bootId: parsed.bootId,
    processStartTime: parsed.processStartTime,
  };
}

function readLockOwner(lockPath: string): LockOwner {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (error) {
    throw new WorkerStateError(
      `worker state lock ${lockPath} is unreadable; refusing to remove it (${(error as Error).message})`,
    );
  }
  const parsed = record(value, "worker state lock");
  exactKeys(
    parsed,
    "worker state lock",
    ["pid", "nonce", "acquiredAt"],
    ["bootId", "processStartTime"],
  );
  if (
    !Number.isInteger(parsed.pid) ||
    (parsed.pid as number) <= 0 ||
    (parsed.pid as number) > 2_147_483_647
  ) {
    throw new WorkerStateError(
      `worker state lock ${lockPath} has an invalid pid; refusing to remove it`,
    );
  }
  if (
    typeof parsed.nonce !== "string" ||
    !/^[0-9a-f]{32}$/u.test(parsed.nonce)
  ) {
    throw new WorkerStateError(
      `worker state lock ${lockPath} has an invalid nonce; refusing to remove it`,
    );
  }
  let acquiredAt: string;
  try {
    acquiredAt = iso(parsed.acquiredAt, "worker state lock.acquiredAt");
  } catch (error) {
    throw new WorkerStateError(
      `worker state lock ${lockPath} has an invalid timestamp; refusing to remove it (${(error as Error).message})`,
    );
  }
  return {
    pid: parsed.pid as number,
    nonce: parsed.nonce,
    acquiredAt,
    ...parseOptionalProcessIdentity(parsed, "worker state lock", lockPath),
  };
}

function readReaperOwner(reaperPath: string): ReaperOwner {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(reaperPath, "utf8"));
  } catch (error) {
    throw new WorkerStateError(
      `worker state reaper ${reaperPath} is unreadable; refusing to remove it (${(error as Error).message})`,
    );
  }
  const parsed = record(value, "worker state reaper");
  const legacyHardLink = !("targetNonce" in parsed);
  exactKeys(
    parsed,
    "worker state reaper",
    legacyHardLink
      ? ["pid", "nonce", "acquiredAt"]
      : ["pid", "nonce", "targetNonce", "acquiredAt"],
    ["bootId", "processStartTime"],
  );
  if (
    !Number.isInteger(parsed.pid) ||
    (parsed.pid as number) <= 0 ||
    (parsed.pid as number) > 2_147_483_647
  ) {
    throw new WorkerStateError(
      `worker state reaper ${reaperPath} has an invalid pid; refusing to remove it`,
    );
  }
  for (const key of legacyHardLink
    ? (["nonce"] as const)
    : (["nonce", "targetNonce"] as const)) {
    if (
      typeof parsed[key] !== "string" ||
      !/^[0-9a-f]{32}$/u.test(parsed[key] as string)
    ) {
      throw new WorkerStateError(
        `worker state reaper ${reaperPath} has an invalid ${key}; refusing to remove it`,
      );
    }
  }
  let acquiredAt: string;
  try {
    acquiredAt = iso(parsed.acquiredAt, "worker state reaper.acquiredAt");
  } catch (error) {
    throw new WorkerStateError(
      `worker state reaper ${reaperPath} has an invalid timestamp; refusing to remove it (${(error as Error).message})`,
    );
  }
  return {
    pid: parsed.pid as number,
    nonce: parsed.nonce as string,
    // The first implementation used a hard link to the stale lock as its
    // marker. Accept that exact complete shape as an orphan-compatible legacy
    // marker so an upgrade can recover rather than require manual deletion.
    targetNonce: legacyHardLink
      ? (parsed.nonce as string)
      : (parsed.targetNonce as string),
    acquiredAt,
    ...parseOptionalProcessIdentity(parsed, "worker state reaper", reaperPath),
  };
}

function sameFile(left: string, right: string): boolean {
  const leftStat = statSync(left);
  const rightStat = statSync(right);
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
}

/**
 * Publish ownership of one exact stale-lock generation. A complete JSON inode
 * is linked into place atomically, just like the primary lock. If an earlier
 * reaper crashed, its dead PID makes the marker reclaimable on the next run.
 */
function acquireReaperMarker(
  stateDir: string,
  reaperPath: string,
  targetNonce: string,
  contenderNonce: string,
  attempt: number,
): { acquired: boolean; nonce: string } {
  const reaperNonce = randomBytes(16).toString("hex");
  const identity = readProcessIdentity(process.pid);
  const publicationPath = `${reaperPath}.${process.pid}.${contenderNonce}.${attempt}.tmp`;
  const body = `${JSON.stringify({
    pid: process.pid,
    nonce: reaperNonce,
    targetNonce,
    acquiredAt: new Date().toISOString(),
    ...(identity ?? {}),
  })}\n`;
  let fd: number | null = null;
  try {
    fd = openSync(publicationPath, "wx", 0o600);
    writeFileSync(fd, body, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    try {
      linkSync(publicationPath, reaperPath);
      try {
        fsyncDirectory(stateDir);
      } catch (error) {
        releaseReaperMarker(reaperPath, reaperNonce);
        throw error;
      }
      return { acquired: true, nonce: reaperNonce };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    // Snapshot the marker before inspecting it. A live reaper wins; a dead
    // marker is an interrupted recovery operation and may be removed safely.
    const observationPath = `${reaperPath}.observe.${process.pid}.${contenderNonce}.${attempt}`;
    try {
      linkSync(reaperPath, observationPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { acquired: false, nonce: reaperNonce };
      }
      throw error;
    }
    try {
      const incumbent = readReaperOwner(observationPath);
      if (incumbent.targetNonce !== targetNonce) {
        throw new WorkerStateError(
          `worker state reaper ${reaperPath} targets a different lock generation`,
        );
      }
      if (processStillOwnsLock(incumbent)) {
        throw new WorkerStateError(
          `worker state lock ${path.join(stateDir, LOCK_FILE)} is being reclaimed by another process`,
        );
      }
      if (sameFile(reaperPath, observationPath)) {
        unlinkSync(reaperPath);
        fsyncDirectory(stateDir);
      }
      return { acquired: false, nonce: reaperNonce };
    } finally {
      try {
        unlinkSync(observationPath);
      } catch {
        // Another cleanup path may already have removed the observation.
      }
    }
  } finally {
    if (fd !== null) closeSync(fd);
    try {
      unlinkSync(publicationPath);
    } catch {
      // The publication temp may already have been removed.
    }
  }
}

function releaseReaperMarker(reaperPath: string, nonce: string): void {
  try {
    const current = readReaperOwner(reaperPath);
    if (current.nonce === nonce) unlinkSync(reaperPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Acquire the exclusive active runtime lock for a state directory. Stale locks
 * left by dead processes are reclaimed; a live owner fails closed.
 */
export function acquireStateLock(stateDir: string): () => void {
  ensurePrivateStateDir(stateDir);
  const lockPath = path.join(stateDir, LOCK_FILE);
  const nonce = randomBytes(16).toString("hex");
  const identity = readProcessIdentity(process.pid);
  const body = `${JSON.stringify({
    pid: process.pid,
    nonce,
    acquiredAt: new Date().toISOString(),
    ...(identity ?? {}),
  })}\n`;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const publicationPath = `${lockPath}.${process.pid}.${nonce}.${attempt}.tmp`;
    let fd: number | null = null;
    let published = false;
    try {
      // Fully write+fsync a private inode before atomically publishing it at
      // LOCK_FILE. A contender can therefore never observe the zero-byte or
      // partially-written lock that open("wx") + write exposed.
      fd = openSync(publicationPath, "wx", 0o600);
      writeFileSync(fd, body, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      linkSync(publicationPath, lockPath);
      published = true;
      unlinkSync(publicationPath);
      fsyncDirectory(stateDir);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          const current = readLockOwner(lockPath);
          if (current.nonce !== nonce) return;
          unlinkSync(lockPath);
          fsyncDirectory(stateDir);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (fd !== null) closeSync(fd);
      if (published) {
        try {
          const current = readLockOwner(lockPath);
          if (current.nonce === nonce) unlinkSync(lockPath);
        } catch {
          // Preserve the original publication/fsync error. A surviving lock
          // fails closed on the next startup rather than being guessed stale.
        }
      }
      try {
        unlinkSync(publicationPath);
      } catch {
        // It may already have been linked and removed on the success path.
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      // Snapshot the published inode with another hard link. Parsing this
      // immutable observation cannot race a release/replacement at lockPath.
      const observationPath = `${lockPath}.observe.${process.pid}.${nonce}.${attempt}`;
      try {
        linkSync(lockPath, observationPath);
      } catch (observeError) {
        if ((observeError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw observeError;
      }
      let existing: LockOwner;
      try {
        existing = readLockOwner(observationPath);
      } catch (readError) {
        unlinkSync(observationPath);
        throw readError;
      }
      if (processStillOwnsLock(existing)) {
        unlinkSync(observationPath);
        throw new WorkerStateError(
          `worker state directory ${stateDir} is already active in another process`,
        );
      }

      // Serialize reclamation of this exact stale generation. The complete
      // owner marker carries the reaper PID, so a crash at any point below is
      // recoverable instead of leaving an immortal `.reap.*` hard link.
      const reaperPath = `${lockPath}.reap.${existing.nonce}`;
      let reaper: { acquired: boolean; nonce: string };
      try {
        reaper = acquireReaperMarker(
          stateDir,
          reaperPath,
          existing.nonce,
          nonce,
          attempt,
        );
      } catch (reaperError) {
        unlinkSync(observationPath);
        throw reaperError;
      }
      if (!reaper.acquired) {
        unlinkSync(observationPath);
        continue;
      }
      try {
        if (sameFile(lockPath, observationPath)) unlinkSync(lockPath);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
          releaseReaperMarker(reaperPath, reaper.nonce);
          unlinkSync(observationPath);
          throw unlinkError;
        }
      }
      releaseReaperMarker(reaperPath, reaper.nonce);
      unlinkSync(observationPath);
      fsyncDirectory(stateDir);
      // Retry with a newly written publication inode. Another contender may
      // win the empty-name race; the next iteration will then fail closed on
      // its live owner rather than assuming ownership.
      continue;
    } finally {
      try {
        unlinkSync(publicationPath);
      } catch {
        // Publication temp is absent on success and most error paths.
      }
    }
  }
  throw new WorkerStateError(`could not acquire worker state lock ${lockPath}`);
}
