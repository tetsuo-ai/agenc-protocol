#!/usr/bin/env node
// Build-gate: fail on any SBF stack-frame overflow in the full default-features build.
//
// The on-chain SBF VM caps a function's stack frame at 4096 bytes. When the backend
// estimates a frame above that it emits a "Stack offset of N exceeded max offset of
// 4096" / "exceeded max offset" warning and notes the overflow "may cause undefined
// behavior during execution" — a real latent UB, not cosmetic. Anchor's per-instruction
// `try_accounts` trampolines are the usual offenders: each unboxed `Account<'info, T>`
// field deserializes its full struct onto the stack, and a heavy instruction (e.g.
// close_task / cancel_task) can saturate the frame. The fix is to `Box<Account<..>>`
// the heavy fields so the deserialized copy lives on the 32KB heap instead.
//
// This gate runs the full (default-features) `cargo-build-sbf`, captures combined
// stdout+stderr, and exits 1 — printing every offending function — if it finds the
// overflow signature, so the class cannot recur silently. No new dependencies.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = resolve(here, "..", "programs", "agenc-coordination", "Cargo.toml");

// Default-features build is the full surface; that is where the overflow bites (the
// restricted mainnet-canary build has a smaller frame and is unaffected).
const result = spawnSync(
  "cargo-build-sbf",
  ["--manifest-path", manifest],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
);

if (result.error) {
  console.error(`Failed to invoke cargo-build-sbf: ${result.error.message}`);
  process.exit(1);
}

const output = `${result.stdout || ""}${result.stderr || ""}`;

// A hard compile failure (non-overflow) is also a gate failure — surface it.
if (result.status !== 0) {
  process.stdout.write(output);
  console.error(`\ncheck:stack FAILED — cargo-build-sbf exited ${result.status}.`);
  process.exit(1);
}

// Match the SBF backend's two overflow phrasings.
const overflowRe = /exceeded max offset|Stack offset of \d+ exceeded/;
const offenders = output
  .split("\n")
  .filter((line) => overflowRe.test(line));

if (offenders.length > 0) {
  console.error(
    `check:stack FAILED — ${offenders.length} SBF stack-frame overflow(s) ` +
      `(>4096 bytes; latent undefined behavior). Box the heavy Account fields:`
  );
  for (const line of offenders) {
    console.error(`  ${line.trim()}`);
  }
  process.exit(1);
}

console.log("check:stack OK — full SBF build has 0 stack-frame overflows.");
process.exit(0);
