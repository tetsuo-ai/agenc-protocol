import { mkdirSync, openSync, closeSync, fsyncSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "@solana/kit";
import type { ModelBudget } from "./state.js";

// Hold one fifth for each of the two possible revisions, with one cent for
// each round on small jobs. The initial run keeps the rest.
function perRevision(total: number): number {
  return total >= 3 ? Math.max(1, Math.floor(total / 5)) : 0;
}

export function claimBudget(totalCents: number, reserve: boolean): ModelBudget {
  const slice = reserve ? perRevision(totalCents) : 0;
  return slice ? { totalCents, remainingCents: totalCents - 2 * slice, revisionRound: 0 }
    : { totalCents, remainingCents: totalCents };
}

/** Only a newer confirmed submission count releases the next slice. Retries,
 * restarts and budgets created before this feature cannot acquire more money. */
export function budgetForRevision(budget: ModelBudget | undefined, round: number): ModelBudget | undefined {
  if (budget?.revisionRound === undefined || round <= budget.revisionRound || (round !== 1 && round !== 2)) return budget;
  return { totalCents: budget.totalCents, remainingCents: perRevision(budget.totalCents), revisionRound: round };
}

// The wallet keeps this directory outside its restorable worker ledger. A fresh
// claim enrolls once. Recovery can consume a round only for an enrolled claim.
function syncDirectory(dir: string): void {
  // Windows does not support opening directories for fsync. Each marker
  // itself is flushed before any model work begins.
  if (process.platform === "win32") return;
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function enrollClaimBudget(root: string, wallet: Address, claim: Address): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, wallet + "-" + claim), { recursive: true, mode: 0o700 });
  syncDirectory(root);
}

export function spendClaimRound(root: string, wallet: Address, claim: Address, round: number): void {
  const dir = join(root, wallet + "-" + claim);
  try {
    const fd = openSync(join(dir, String(round)), "wx", 0o600);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(dir);
  } catch (cause) {
    throw new Error("Previous model spend for this round is exhausted or unknown.", { cause });
  }
}
