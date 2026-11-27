import { mkdirSync, openSync, closeSync, fsyncSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const monotonicMs = () => Number(process.hrtime.bigint() / 1_000_000n);

export async function chainDeadline(clock: () => Promise<number>, timeoutMs: number, ...expiries: bigint[]): Promise<number> {
  const start = monotonicMs();
  const chainNow = await clock();
  if (!Number.isSafeInteger(chainNow) || chainNow <= 0) throw new Error("The chain clock is unavailable.");
  let left = timeoutMs;
  for (const expiry of expiries) if (expiry > 0n) left = Math.min(left, 1000 * (Number(expiry) - chainNow));
  const end = start + left;
  if (!Number.isSafeInteger(end) || end <= monotonicMs()) throw new Error("The job deadline passed.");
  return end;
}

export class ExecutorCapabilityError extends Error {
  override name = "ExecutorCapabilityError";
}

function syncDir(dir: string) {
  if (process.platform === "win32") return;
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

// This journal lives outside wallet restores. Reserve before signing. An
// interruption with unknown signer state must also prevent a second signature.
export function claimSignatureJournal(root: string, signer: string, task: string) {
  const dir = join(root, "claim-signatures");
  const id = createHash("sha256").update(JSON.stringify([signer, task])).digest("hex");
  const path = join(dir, id);
  return {
    exists: () => existsSync(path),
    reserve() {
      mkdirSync(dir, {recursive:true,mode:0o700});
      syncDir(root);
      const fd = openSync(path,"wx",0o600);
      try { fsyncSync(fd); } finally { closeSync(fd); }
      syncDir(dir);
    },
    signed(signature: string) { writeFileSync(path,signature,{flag:"r+",flush:true}); },
    landed() { unlinkSync(path); syncDir(dir); },
  };
}
