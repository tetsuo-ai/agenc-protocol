import { mkdirSync, openSync, closeSync, fsyncSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "@solana/kit";
import { acquireStateLock, type ModelBudget } from "./state.js";

// Hold one fifth for each of the two possible revisions, with one cent for
// each round on small jobs. The initial run keeps the rest.
function perRevision(total: number): number {
  return total >= 3 ? Math.max(1, Math.floor(total / 5)) : 0;
}

export function correctionAllowance(cents: number): number {
  return cents < 2 ? 0 : Math.max(1, Math.floor(cents / 4));
}

export function claimBudget(totalCents: number, reserve: boolean, correct = false): ModelBudget {
  const slice = reserve ? perRevision(totalCents) : 0;
  const initial = totalCents - 2 * slice;
  const correctionCents = correct ? correctionAllowance(initial) : 0;
  return { totalCents, remainingCents: initial - correctionCents, ...(slice > 0 && { revisionRound: 0 }),
    ...(correctionCents > 0 && { correctionCents }) };
}

/** Only a newer confirmed submission count releases the next slice. Retries,
 * restarts and budgets created before this feature cannot acquire more money. */
export function budgetForRevision(budget: ModelBudget | undefined, round: number): ModelBudget | undefined {
  if (budget?.revisionRound === undefined || round <= budget.revisionRound || (round !== 1 && round !== 2)) return budget;
  return { totalCents: budget.totalCents, remainingCents: perRevision(budget.totalCents), revisionRound: round };
}

export function admissionRounds(total: number, reserveRevisions: boolean, reserveCorrection = false) {
  const budget = claimBudget(total, reserveRevisions, reserveCorrection);
  const laterRoundCents: number[] = [];
  if (budget.revisionRound === 0) {
    for (const round of [1, 2]) laterRoundCents.push(budgetForRevision(budget, round)!.remainingCents);
  }
  const correction = budget.correctionCents ?? 0;
  if (correction) laterRoundCents.push(correction);
  return {firstRoundCents:budget.remainingCents, laterRoundCents};
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

export function pinClaim(dir: string, executor: string, budget?: number, program?:string): boolean {
  const pin = JSON.stringify({executor, budget: budget ?? null,...(program && {program})});
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

export function requireClaimExecutor(dir: string, executor: string, legacyPrivate = false, program?:string): void {
  if (existsSync(join(dir, "admission"))) {
    const saved = JSON.parse(readFileSync(join(dir, "admission"), "utf8"));
    if (saved.executor === executor && saved.program === program) return;
  } else {
    // Only these older runs identify their executor without guessing.
    if (!program && legacyPrivate && executor === "core" && isReleasedClaimRound(dir)) return;
  }
  throw Object.assign(new Error("The executor that took this claim is unavailable."),{name:"ExecutorCapabilityError"});
}

export interface RoundCapacity { calls: number; tokens: number; }

export function requireRoundCapacity(dir: string, needed: RoundCapacity) {
  let {calls, tokens} = needed;
  if (![calls, tokens].every(n => Number.isSafeInteger(n) && n > 0) || existsSync(join(dir, ".agent-active")))
    throw new Error("The previous room turn is active or its limits are unavailable.");
  for (const name of readdirSync(dir).filter(name => /^(?:-1|[0-2])$/.test(name))) {
    const used = JSON.parse(readFileSync(join(dir, name + ".counts"), "utf8"));
    if (![used.calls, used.tokens].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error("Unknown model usage.");
    calls += used.calls;
    tokens += used.tokens;
  }
  if (calls > 64 || tokens > 1000000) throw Object.assign(new Error("The claim has insufficient calls or tokens for this round."), {name:"ExecutorBudgetError"});
}

export function spendClaimRound(root: string, wallet: Address, claim: Address, round: number, cents?: number, needed?: RoundCapacity): string {
  const dir = join(root, wallet + "-" + claim);
  let release: (() => void) | undefined;
  try {
    if (!existsSync(dir)) throw new Error("Missing claim ledger.");
    release = acquireStateLock(dir);
    if (needed) requireRoundCapacity(dir, needed);
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
    release?.();
  }
}
