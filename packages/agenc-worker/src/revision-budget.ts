import { mkdirSync, openSync, closeSync, fsyncSync, unlinkSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
  const dir = join(root, wallet + "-" + claim);
  try { mkdirSync(dir,{mode:0o700}); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return; throw error; }
  writeFileSync(join(dir,"format"),"1",{flag:"wx",mode:0o600,flush:true});
  syncDirectory(dir);
  syncDirectory(root);
}

export function pinClaim(dir: string, executor: string, budget?: number): boolean {
  const pin = JSON.stringify({executor, budget: budget ?? null});
  try { writeFileSync(join(dir, "admission"), pin, {flag:"wx", mode:0o600, flush:true}); syncDirectory(dir); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || readFileSync(join(dir, "admission"), "utf8") !== pin)
      throw new Error("This claim already has different terms.", {cause:error});
    return false;
  }
}

export function isReleasedClaimRound(dir:string):boolean {
  return !existsSync(join(dir,"format")) && existsSync(join(dir,"0")) && readFileSync(join(dir,"0"),"utf8")==="";
}

export function requireClaimExecutor(dir: string, executor: string, legacyPrivate = false): void {
  if (existsSync(join(dir, "admission"))) {
    if (JSON.parse(readFileSync(join(dir, "admission"), "utf8")).executor === executor) return;
  } else {
    // Only these older runs identify their executor without guessing.
    if (legacyPrivate && executor === "core" && isReleasedClaimRound(dir)) return;
  }
  throw Object.assign(new Error("The executor that took this claim is unavailable."),{name:"ExecutorCapabilityError"});
}

// Each numbered round has its own measured counters in the durable claim directory.
export function claimModelCounts(dir: string): { tokens: number; calls: number } {
  let tokens = 0, calls = 0;
  if (existsSync(join(dir, ".agent-active"))) throw new Error("A round is still active.");
  try {
    for (const name of readdirSync(dir).filter(name => /^(?:-1|[0-2])$/.test(name))) {
      const used = JSON.parse(readFileSync(join(dir, name + ".counts"), "utf8"));
      if (![used.tokens, used.calls].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error();
      tokens += used.tokens;
      calls += used.calls;
    }
    if (Number.isSafeInteger(tokens) && Number.isSafeInteger(calls)) return { tokens, calls };
  } catch { /* Missing or unreadable counters close admission. */ }
  throw Object.assign(new Error("The claim's model usage is unknown."), { name: "ExecutorBudgetError" });
}

export function spendClaimRound(root: string, wallet: Address, claim: Address, round: number, cents?: number): string {
  const dir = join(root, wallet + "-" + claim);
  const lock = join(dir,".reserving");
  let held = false;
  try {
    writeFileSync(lock,"",{flag:"wx",mode:0o600,flush:true});
    held = true;
    if (existsSync(join(dir, "admission"))) {
      const {budget} = JSON.parse(readFileSync(join(dir, "admission"), "utf8"));
      const prior = readdirSync(dir).filter(n => /^(?:-1|[0-2])$/.test(n)).map(n => Number(readFileSync(join(dir,n), "utf8")));
      if (!Number.isSafeInteger(budget) || !Number.isSafeInteger(cents) || cents! <= 0 ||
          prior.some(n => !Number.isSafeInteger(n) || n <= 0) || prior.reduce((a,b) => a+b, cents!) > budget)
        throw new Error("The claim has no further allowance.");
    }
    const reservation = join(dir,String(round));
    if (existsSync(reservation)) throw new Error("This round already has a reservation.");
    if (cents !== undefined) {
      const zero = JSON.stringify({reservedCents:cents,costUsd:0});
      const usage = reservation+".usage";
      try { writeFileSync(usage,zero,{flag:"wx",mode:0o600,flush:true}); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || readFileSync(usage,"utf8") !== zero) throw error; }
      syncDirectory(dir);
    }
    writeFileSync(reservation,cents === undefined ? "" : String(cents),{flag:"wx",mode:0o600,flush:true});
    syncDirectory(dir);
    return join(dir, String(round));
  } catch (cause) {
    throw new Error("Previous model spend for this round is exhausted or unknown.", { cause });
  } finally {
    if (held) { unlinkSync(lock); syncDirectory(dir); }
  }
}
