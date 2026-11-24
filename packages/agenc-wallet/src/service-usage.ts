import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import type { ServiceUsage } from "./client/seller-terms.js";
export type { ServiceUsage } from "./client/seller-terms.js";

declare module "./store.js" {
  interface JobRecord { modelUsage?: ServiceUsage; settledSellerLamports?: string | null }
}
/** This path goes only to the trusted room process. The guest sees no host path. */
export function reserveServiceRun(stateDir: string, task: string, reservedCents: number) {
  const dir = path.join(stateDir, "service-usage", task);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  writeFileSync(path.join(dir, id + ".reserve"), String(reservedCents), { flag: "wx", mode: 0o600, flush: true });
  return path.join(dir, id + ".receipt");
}

export function serviceUsage(stateDir: string, task: string): ServiceUsage | null {
  const dir = path.join(stateDir, "service-usage", task);
  let files: string[];
  try { files = readdirSync(dir).filter(f => f.endsWith(".reserve")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  let costUsd: number | null = 0;
  let reservedCents = 0;
  let unknownReservedCents = 0;
  for (const file of files) {
    const cap = Number(readFileSync(path.join(dir, file), "utf8"));
    if (!Number.isSafeInteger(cap) || cap <= 0) throw new Error("Invalid service cost reservation.");
    reservedCents += cap;
    let measured: unknown;
    try {
      measured = JSON.parse(readFileSync(path.join(dir, file.replace(/\.reserve$/, ".receipt")), "utf8")).costUsd;
    } catch { /* An unfinished run keeps its reservation. */ }
    if (typeof measured === "number" && Number.isFinite(measured) && measured >= 0) {
      if (costUsd !== null) costUsd += measured;
    } else {
      unknownReservedCents += cap;
      costUsd = null;
    }
  }
  return files.length ? { reservedCents, unknownReservedCents, costUsd, runs: files.length } : null;
}
