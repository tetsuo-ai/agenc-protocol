import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export interface ServiceUsage {
  reservedCents: number;
  costUsd: number | null;
  runs: number;
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
  for (const file of files) {
    const cap = Number(readFileSync(path.join(dir, file), "utf8"));
    if (!Number.isSafeInteger(cap) || cap <= 0) throw new Error("Invalid service cost reservation.");
    reservedCents += cap;
    try {
      const cost = JSON.parse(readFileSync(path.join(dir, file.replace(/\.reserve$/, ".receipt")), "utf8")).costUsd;
      if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) costUsd = null;
      else if (costUsd !== null) costUsd += cost;
    } catch { costUsd = null; }
  }
  return files.length ? { reservedCents, costUsd, runs: files.length } : null;
}
