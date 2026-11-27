import {
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { monotonicMs } from "./boot-clock.js";
export { monotonicMs };

export async function chainDeadline(clock:()=>Promise<number>,timeoutMs:number,...expiries:bigint[]):Promise<number> {
  const start = monotonicMs();
  return deadlineFromChain(start,await clock(),timeoutMs,...expiries);
}

export function deadlineFromChain(start:number,chainNow:number,timeoutMs:number,...expiries:bigint[]):number {
  if (!Number.isSafeInteger(chainNow) || chainNow <= 0)
    throw new Error("The chain clock is unavailable.");
  let left = timeoutMs;
  for (const expiry of expiries)
    if (expiry > 0n)
      left = Math.min(left, 1000 * (Number(expiry) - chainNow) - 999);
  const end = start + left;
  if (!Number.isSafeInteger(end) || end <= monotonicMs())
    throw new Error("The job deadline passed.");
  return end;
}

export class ExecutorCapabilityError extends Error {
  override name = "ExecutorCapabilityError";
}

function syncDir(dir: string) {
  if (process.platform === "win32") return;
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// This journal lives outside wallet restores. Reserve before signing. An
// interruption with unknown signer state must also prevent a second signature.
export function claimSignatureJournal(
  root: string,
  signer: string,
  task: string,
  claim: string,
) {
  const dir = join(root, signer + "-" + claim);
  const id = createHash("sha256")
    .update(JSON.stringify([signer, task]))
    .digest("hex");
  const legacy = join(root, "claim-signatures", id);
  const path = join(dir, "signature-attempt");
  const confirmed = join(dir, "confirmed");
  const exists = () => existsSync(path) || existsSync(confirmed) || existsSync(legacy) || existsSync(join(dir, "0"));
  return {
    exists,
    reserve() {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      syncDir(root);
      if (exists()) throw new Error("This claim already has a signature attempt.");
      const fd = openSync(path, "wx", 0o600);
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      syncDir(dir);
    },
    signed(signature: string) {
      writeFileSync(path, signature, { flag: "r+", flush: true });
    },
    confirmed(signature?: string) {
      mkdirSync(dir,{recursive:true,mode:0o700});
      syncDir(root);
      const known = signature ?? (existsSync(path) ? readFileSync(path,"utf8") : "");
      writeFileSync(confirmed, known, {mode:0o600, flush:true});
      syncDir(dir);
    },
    clearUnsigned(createdPin = false) {
      if (createdPin) { unlinkSync(join(dir,"admission")); syncDir(dir); }
      unlinkSync(path);
      syncDir(dir);
    },
  };
}
