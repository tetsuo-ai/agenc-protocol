// Persistent worker state under `stateDir` (default
// `~/.local/state/agenc-worker`): the 32-byte agentId, the at-most-one open
// claim, and the submission ledger settlement checks reconcile against.
//
// One JSON file (`state.json`), written atomically (tmp + rename), directory
// mode 0700 / file mode 0600 — the state names the tasks this wallet worked,
// keep it private.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** A claim taken but not yet submitted (crash-recovery marker). */
export type OpenClaim = {
  /** Task PDA (base58). */
  task: string;
  /** ISO timestamp of the claim. */
  claimedAt: string;
};

/** One submitted result awaiting (or past) settlement. */
export type SubmissionRecord = {
  /** Task PDA (base58). */
  task: string;
  /** Submission transaction signature. */
  submissionSignature: string;
  /** Result URI submitted (uploader-returned or the agenc:// placeholder). */
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
  outcome?: "accepted" | "rejected" | "cancelled" | "closed";
  /** Lamports actually earned (decimal string), when attributable. */
  earnedLamports?: string | null;
  /** Settlement tx signature when observable, else null. */
  settlementSignature?: string | null;
  /** ISO timestamp settlement was observed. */
  settledAt?: string;
};

/** The whole persisted state. */
export type WorkerState = {
  /** 32-byte agent id, hex-encoded (64 chars). */
  agentIdHex: string | null;
  /** The at-most-one open (claimed, unsubmitted) task. */
  openClaim: OpenClaim | null;
  /**
   * `AgentRegistration.totalEarned` at the last settlement reconciliation
   * (decimal string) — the baseline settlement deltas are computed against.
   */
  totalEarnedBaseline: string;
  /** Submission ledger, oldest first. */
  submissions: SubmissionRecord[];
};

const STATE_FILE = "state.json";

/** Fresh empty state. */
export function emptyState(): WorkerState {
  return {
    agentIdHex: null,
    openClaim: null,
    totalEarnedBaseline: "0",
    submissions: [],
  };
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
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`invalid hex string of length ${hex.length}`);
  }
  return new Uint8Array(Buffer.from(hex, "hex"));
}

/** Load state from `stateDir`, or the empty state when none exists. */
export function loadState(stateDir: string): WorkerState {
  let raw: string;
  try {
    raw = readFileSync(path.join(stateDir, STATE_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<WorkerState>;
  return {
    agentIdHex: parsed.agentIdHex ?? null,
    openClaim: parsed.openClaim ?? null,
    totalEarnedBaseline: parsed.totalEarnedBaseline ?? "0",
    submissions: Array.isArray(parsed.submissions) ? parsed.submissions : [],
  };
}

/** Persist state atomically (tmp file + rename), 0700 dir / 0600 file. */
export function saveState(stateDir: string, state: WorkerState): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const target = path.join(stateDir, STATE_FILE);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
}
