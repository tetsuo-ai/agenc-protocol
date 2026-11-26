import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The whole job's model budget beside its run reservations (rt5 A 6: the job
 * view said "At most $0.05", the first run's share, while the claim quote said
 * $0.10). Display only: the room is still held to each run's reservation.
 */
export function recordServiceBudget(stateDir: string, task: string, totalCents: number): void {
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0) return;
  const dir = path.join(stateDir, "service-usage", task);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, "budget"), String(totalCents), { mode: 0o600, flush: true });
}

/** The recorded whole-job budget in cents, or null when none was recorded. */
export function serviceBudget(stateDir: string, task: string): number | null {
  let text: string;
  try { text = readFileSync(path.join(stateDir, "service-usage", task, "budget"), "utf8"); }
  catch { return null; }
  const cents = Number(text);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}
