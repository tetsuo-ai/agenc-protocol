#!/usr/bin/env node
// Canary-surface freeze gate.
//
// Two layers:
//  1. NAME allowlist — the canary build exposes exactly these 25 instructions.
//  2. WIRE-SHAPE baseline (P1.2 adversarial-review hardening) — for every canary
//     instruction, the full wire shape is pinned against the committed
//     `scripts/canary-idl-baseline.json`: discriminator, account list (order,
//     writable/signer/optional flags, PDA seed literals) and arg list (names +
//     types). A name-only check would miss a reordered cfg-duplicated field, a
//     dropped `cfg_attr` instruction-arg prefix, or a changed frozen seed literal
//     — any of which silently breaks old canary clients at a later redeploy.
//
// Refreshing the baseline is an EXPLICIT act (`--write-baseline`) and means "I
// intend to change the frozen canary wire surface" — never do it to silence a
// failure you don't understand.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const idlPath = process.argv[2] && !process.argv[2].startsWith("--")
  ? process.argv[2]
  : "target/idl/agenc_coordination.canary.json";
const idl = JSON.parse(readFileSync(idlPath, "utf8"));
const actual = idl.instructions.map((instruction) => instruction.name).sort();
const expected = [
  "accept_task_result",
  "cancel_task",
  "claim_task_with_job_spec",
  "configure_task_moderation",
  "configure_task_validation",
  "create_task",
  "deregister_agent",
  "expire_claim",
  "initialize_protocol",
  "migrate_protocol",
  "migrate_task",
  "record_task_moderation",
  "register_agent",
  "reject_task_result",
  "set_task_job_spec",
  "submit_task_result",
  "suspend_agent",
  "unsuspend_agent",
  "update_agent",
  "update_launch_controls",
  "update_min_version",
  "update_multisig",
  "update_protocol_fee",
  "update_rate_limits",
  "update_treasury",
].sort();

const missing = expected.filter((name) => !actual.includes(name));
const unexpected = actual.filter((name) => !expected.includes(name));

if (missing.length > 0 || unexpected.length > 0) {
  console.error("Canary IDL surface mismatch.");
  if (missing.length > 0) console.error(`Missing: ${missing.join(", ")}`);
  if (unexpected.length > 0) console.error(`Unexpected: ${unexpected.join(", ")}`);
  process.exit(1);
}

// --- Layer 2: full wire-shape pin -------------------------------------------

// Everything that affects what a client puts on the wire; `docs` excluded.
const shapeOf = (ix) => ({
  discriminator: ix.discriminator,
  accounts: ix.accounts.map((a) => ({
    name: a.name,
    writable: !!a.writable,
    signer: !!a.signer,
    optional: !!a.optional,
    ...(a.address ? { address: a.address } : {}),
    ...(a.pda ? { pda: a.pda } : {}),
  })),
  args: ix.args.map((a) => ({ name: a.name, type: a.type })),
});

const shape = Object.fromEntries(
  idl.instructions
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((ix) => [ix.name, shapeOf(ix)]),
);

const baselinePath = fileURLToPath(new URL("./canary-idl-baseline.json", import.meta.url));

if (process.argv.includes("--write-baseline")) {
  writeFileSync(baselinePath, `${JSON.stringify(shape, null, 2)}\n`);
  console.log(`Canary wire-shape baseline written (${Object.keys(shape).length} instructions) → ${baselinePath}`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
} catch {
  console.error(
    "Canary wire-shape baseline missing. Generate it ONCE from a verified-frozen canary IDL:\n" +
    "  npm run canary:idl && node scripts/check-canary-idl.mjs --write-baseline",
  );
  process.exit(1);
}

const drifted = [];
for (const name of Object.keys(baseline)) {
  const want = JSON.stringify(baseline[name]);
  const got = JSON.stringify(shape[name]);
  if (want !== got) drifted.push(name);
}
for (const name of Object.keys(shape)) {
  if (!(name in baseline)) drifted.push(name);
}

if (drifted.length > 0) {
  console.error("Canary WIRE SHAPE drifted from the frozen baseline (accounts/args/seeds/flags):");
  for (const name of drifted) {
    console.error(`  ${name}`);
    console.error(`    baseline: ${JSON.stringify(baseline[name])}`);
    console.error(`    actual:   ${JSON.stringify(shape[name])}`);
  }
  console.error(
    "\nThe canary surface is FROZEN. If this change is intentional (it almost never is),\n" +
    "re-baseline explicitly: node scripts/check-canary-idl.mjs --write-baseline",
  );
  process.exit(1);
}

console.log(
  `Canary IDL surface OK (${actual.length} instructions; wire shape matches the frozen baseline).`,
);
