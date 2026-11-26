import {
  AGENC_COORDINATION_PROGRAM_ADDRESS, CLAIM_TASK_DISCRIMINATOR, CLAIM_TASK_WITH_JOB_SPEC_DISCRIMINATOR,
  COMPLETE_TASK_DISCRIMINATOR, REGISTER_AGENT_DISCRIMINATOR, RELEASE_CLAIM_DISCRIMINATOR, SUBMIT_TASK_RESULT_DISCRIMINATOR,
} from "@tetsuo-ai/marketplace-sdk";
import { getBase58Encoder } from "@solana/kit";
import type { HistoryRow } from "./client/money-operations.js";
import type { WalletState } from "./store.js";

/**
 * What the wallet itself sent, by receipt, so its history can name the row
 * (rt11: a setup or offer funding, a worker's claim and its delivery read
 * "Other change"). Written when the wallet signs or lands the send.
 */
export type SentKind = "funding" | "claim" | "submit" | "release";
export interface SentRecord { kind: SentKind; agentId: string; jobId?: string; at: number }
declare module "./store.js" {
  interface WalletState { sentRecords?: Record<string, SentRecord> }
}

/** The newest records kept; history rows are classified within minutes of landing. */
const KEEP = 2000;

export function recordSent(draft: WalletState, signature: string, record: SentRecord): void {
  const rows = (draft.sentRecords ??= {});
  rows[signature] = record;
  const keys = Object.keys(rows);
  if (keys.length > KEEP) {
    keys.sort((a, b) => rows[a]!.at - rows[b]!.at).slice(0, keys.length - KEEP).forEach(key => delete rows[key]);
  }
}

const SENT_KINDS: Record<SentKind, HistoryRow["kind"]> = {
  funding: "transfer", claim: "job claim", submit: "job delivery", release: "job release",
};

export function sentKind(state: WalletState, signature: string): { kind: HistoryRow["kind"]; jobId?: string } | null {
  const row = state.sentRecords?.[signature];
  return row ? { kind: SENT_KINDS[row.kind], ...(row.jobId && { jobId: row.jobId }) } : null;
}

const INSTRUCTION_KINDS: [ArrayLike<number>, AccountStep][] = [
  [REGISTER_AGENT_DISCRIMINATOR, "registration"],
  [CLAIM_TASK_DISCRIMINATOR, "job claim"],
  [CLAIM_TASK_WITH_JOB_SPEC_DISCRIMINATOR, "job claim"],
  [SUBMIT_TASK_RESULT_DISCRIMINATOR, "job delivery"],
  [COMPLETE_TASK_DISCRIMINATOR, "job delivery"],
  [RELEASE_CLAIM_DISCRIMINATOR, "job release"],
];

/**
 * The marketplace step a receipt this account paid for took, read from its
 * own top-level instructions: the worker's own sends (registration, an
 * automatic claim or delivery) that the wallet has no record of.
 */
export function instructionKind(instructions: readonly unknown[]): AccountStep | null {
  for (const ix of instructions) {
    const row = ix as { programId?: string; data?: string | ArrayLike<number> };
    if (row.programId !== AGENC_COORDINATION_PROGRAM_ADDRESS || row.data === undefined) continue;
    let bytes: ArrayLike<number>;
    try { bytes = typeof row.data === "string" ? getBase58Encoder().encode(row.data) : row.data; } catch { continue; }
    const found = INSTRUCTION_KINDS.find(([tag]) => tag.length <= bytes.length && Array.from(tag).every((b, i) => bytes[i] === b));
    if (found) return found[1];
  }
  return null;
}
export type AccountStep = "registration" | "job claim" | "job delivery" | "job release";
