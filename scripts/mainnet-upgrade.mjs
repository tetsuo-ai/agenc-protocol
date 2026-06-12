#!/usr/bin/env node
// =============================================================================
// mainnet-upgrade.mjs — full-surface mainnet upgrade ORCHESTRATOR (HUMAN-RUN)
// =============================================================================
//
// One safe-by-default driver for the entire full-surface mainnet upgrade
// (MAINNET_ROLLOUT_RUNBOOK §3). It runs the steps in the ONLY correct order and
// REFUSES to reorder them:
//
//   Step 1  DEPLOY      — solana program deploy (the new full-surface .so)        [binary first]
//   Step 2/3 SWEEP      — scripts/mainnet-migrate-sweep.mjs (migrate_protocol +    [INVOKED, not reimplemented]
//                         migrate_task for every live Task)
//   Step 4  INIT        — scripts/mainnet-init-and-stamp.mjs (initialize_bid_      [INVOKED, init-only]
//                         marketplace + initialize_zk_config + verify moderation)
//   Step 5  STAMP       — scripts/mainnet-init-and-stamp.mjs (update_launch_       [INVOKED, stamp-only]
//                         controls -> surface_revision = FULL)                    [LAST mutating step]
//   Step 6  IDL         — anchor idl init (first publish of the full 84-ix IDL)
//
// SAFE BY DEFAULT
// --------------
//   * With NO flags this runs in PLAN mode: it validates every input, re-decodes
//     live mainnet state read-only, prints the full ordered plan with REAL
//     numbers (bytes, sha256, rent, SOL need, task count), and BROADCASTS NOTHING.
//   * Broadcasting requires BOTH:  --execute  AND  a typed confirmation — you must
//     type the program id (HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK) at the
//     prompt. (--yes-i-typed-the-program-id <id> may be supplied non-interactively.)
//
// THIS SCRIPT NEVER READS, DECRYPTS, OR EMBEDS A KEY.
// --------------------------------------------------
//   * It takes keypair FILE PATHS at runtime (flags / env). It loads keypair bytes
//     ONLY by handing the path straight to the child scripts / the solana CLI; it
//     never prints, logs, or copies secret bytes.
//   * Public addresses are derived ONLY via `solana address -k <file>` (pubkey out,
//     secret never read).
//   * If a supplied path is an encrypted kit *.vault.json (a JSON OBJECT with a
//     `cipher`/`ciphertext`, not a bare 64-int keypair array) the script DETECTS it
//     and STOPS — it does NOT attempt to decrypt. Supply a decrypted plain keypair
//     JSON for the CLI / web3 steps.
//
// ORDER + RESUMABILITY
// --------------------
//   The script DETECTS already-done steps from live chain state and skips them:
//     * binary already the new size/sha     -> Step 1 is a no-op (re-verify only)
//     * ProtocolConfig already 351B          -> migrate_protocol already ran
//     * all Tasks already 466B               -> sweep complete
//     * BidMarketplaceConfig / ZkConfig exist-> that init already ran
//     * surface_revision already FULL        -> stamp already done
//     * on-chain anchor IDL account exists   -> Step 6 needs `anchor idl upgrade`
//   It NEVER stamps before migrate+init complete and NEVER reorders.
//
// FROZEN WINDOW
// -------------
//   The instant Step 1 lands, the live 349B ProtocolConfig + every 382B Task fail
//   TYPED reads (the program now expects the new layout). The script prints a
//   "FROZEN WINDOW OPENS" banner before the deploy and, in --execute mode, runs the
//   sweep IMMEDIATELY after with NO interactive pause. Have the cosigner key paths
//   staged before you deploy.
//
// USAGE (resolves deps from tests-integration/node_modules like the sibling scripts):
//
//   node scripts/mainnet-upgrade.mjs [flags]
//
//   --- required (flags OR the matching env var) ---
//   --rpc <url>                  RPC_URL              mainnet RPC (read + the human's deploy)
//   --upgrade-authority <path>   UPGRADE_AUTHORITY    plain keypair = program upgrade authority
//                                                     AND ProtocolConfig.authority (HcecpKXM...)
//   --cosigners <p1,p2,...>      COSIGNERS            in-program multisig co-signer keypair PATHS
//                                                     (need M-1 = 1 more owner for the 2-of-3 gate)
//   --zk-image-id <64hex>        ZK_IMAGE_ID_HEX      AUDITED mainnet RISC-Zero image id — NO DEFAULT.
//                                                     (or SKIP_ZK_CONFIG=1 to DEFER ZkConfig)
//   --so <path>                  SO_PATH              the full-surface .so to deploy
//                                  default: programs/agenc-coordination/target/deploy/agenc_coordination.so
//   --idl <path>                 IDL_PATH             full 84-ix IDL for `anchor idl init`
//                                  default: target/idl/agenc_coordination.json
//
//   --- broadcasting (both required to send anything) ---
//   --execute                                          actually run the steps (else PLAN/dry-run)
//   --yes-i-typed-the-program-id <id>                  non-interactive typed confirmation
//                                                      (interactive prompt used if omitted)
//
//   --- optional ---
//   --compute-unit-price <microlamports>  COMPUTE_UNIT_PRICE   priority fee for the deploy
//   --expected-tasks <n>         EXPECTED_TASKS       sweep count guard (default: auto-detect live)
//   --only <steps>               run only a subset, e.g. --only deploy,sweep  (still order-checked)
//   --skip-zk-config             SKIP_ZK_CONFIG=1     defer ZkConfig (no audited image id yet)
//   --disabled-task-type-mask <n> DISABLED_TASK_TYPE_MASK  STAMP override (0..15): the value the
//                                                     surface stamp WRITES instead of preserving the
//                                                     live mask. set bit = DISABLED task type
//                                                     (1=Exclusive 2=Collaborative 4=Competitive
//                                                     8=BidExclusive). 0 = enable ALL task types;
//                                                     UNSET = preserve the live mask (legacy behavior).
//   --moderation-authority <pk>  MODERATION_AUTHORITY only if rotating the attestor (verify-only otherwise)
//   --bid-*                      BID_*                bid-marketplace policy overrides (see init script)
//   --help, -h                                        print this and exit
//
//   Bid policy overrides (forwarded to the init script, conservative defaults if unset):
//     --bid-min-bond-lamports / BID_MIN_BOND_LAMPORTS
//     --bid-creation-cooldown-secs / BID_CREATION_COOLDOWN_SECS
//     --bid-max-per-24h / BID_MAX_PER_24H
//     --bid-max-active-per-task / BID_MAX_ACTIVE_PER_TASK
//     --bid-max-lifetime-secs / BID_MAX_LIFETIME_SECS
//     --bid-noshow-slash-bps / BID_NOSHOW_SLASH_BPS
//
// EXACT RUN ORDER (do NOT pause between 1 and 3 in execute mode):
//   1. PLAN it first:   node scripts/mainnet-upgrade.mjs --rpc <url> --upgrade-authority ... --cosigners ... --zk-image-id <hex>
//   2. Read the plan, confirm SOL/peak/task-count, stage the cosigner keys.
//   3. EXECUTE:         add --execute and type the program id at the prompt.
// =============================================================================

import { createRequire } from "module";
import { readFileSync, existsSync, statSync } from "fs";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { createInterface } from "readline";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "tests-integration", "package.json"));
const { Connection, PublicKey } = require("@solana/web3.js");
const bs58 = require("bs58").default ?? require("bs58");

// ------------------------------------------------------------------ constants
const PROGRAM_ID_STR = "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK";
const PROGRAM_ID = new PublicKey(PROGRAM_ID_STR);
// Decoded LIVE from the 349B ProtocolConfig at DeBPkxhzE6MJr66HhEgcHBv5rBFoHWysb6uyK4skufUs.
const EXPECTED_UPGRADE_AUTHORITY = "HcecpKXMwkZuaBByA1drmW2t2xxu18iRL6HHTJTLGLqh";
const EXPECTED_SO_BYTES = 1948384;
const EXPECTED_SO_SHA256 = "ea2fa92fc729acfe2c2cb476987929ff49025bf6c00618ecaa8c7f28c7d86f89";
const EXPECTED_FULL_IX_COUNT = 84; // full surface (canary = 25)
// Solana loader account-data overheads (bytes added on top of the .so payload).
const PROGRAMDATA_META_BYTES = 45; // ProgramData header
const BUFFER_META_BYTES = 37;      // upgrade buffer header
// Layout sizes (state.rs const_assert).
const SIZES = { CFG_OLD: 349, CFG_NEW: 351, TASK_OLD: 382, TASK_NEW: 466 };
const SURFACE_REVISION_FULL = 1;
// Allowed task-type bits (state.rs ProtocolConfig::TASK_TYPE_DISABLE_MASK = 0b0000_1111).
// A SET bit = that task type is DISABLED. 1=Exclusive 2=Collaborative 4=Competitive 8=BidExclusive.
const TASK_TYPE_DISABLE_MASK = 0b0000_1111;
// Anchor on-chain IDL account PDA seed = ["anchor:idl"]-derived base; we resolve it
// the same way `anchor idl` does (PDA off a per-program base) — see resolveIdlAddress().
const ANCHOR_IDL_SEED = "anchor:idl";
// Rough tx-fee envelope for the deploy + ~N migrate txns (spec: deploy ~0.02, sweep ~0.00085).
const TX_FEE_BUDGET_SOL = 0.05;

const ALL_STEPS = ["deploy", "sweep", "init", "stamp", "idl"];

// ------------------------------------------------------------------ tiny utils
// Redact RPC credentials from anything we PRINT (api-key / token query params and
// any userinfo), so the plan/execute output is safe to screenshot or share — the
// real URL is still used for the actual calls, only the logged copy is masked.
function maskRpc(s) {
  return String(s)
    .replace(/([?&](?:api[-_]?key|key|token|secret|auth|access[-_]?token)=)[^&\s"']+/gi, "$1***")
    .replace(/(\/\/[^/\s@:]+):[^/\s@]+@/g, "$1:***@");
}
function die(msg) { console.error(`\nERROR: ${maskRpc(msg)}`); process.exit(1); }
function info(msg) { console.log(maskRpc(msg)); }
function banner(msg) {
  const bar = "=".repeat(Math.max(60, msg.length + 4));
  console.log(`\n${bar}\n  ${maskRpc(msg)}\n${bar}`);
}
function expandHome(p) { return p.replace(/^~(?=$|\/)/, process.env.HOME); }
function lamportsToSol(l) { return (Number(l) / 1e9); }

// --------------------------------------------------------------- arg parsing
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { out.help = true; continue; }
    if (a === "--execute") { out.execute = true; continue; }
    if (a === "--skip-zk-config") { out.skipZkConfig = true; continue; }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) die(`flag ${a} expects a value.`);
      out[key] = next; i++;
      continue;
    }
    out._.push(a);
  }
  return out;
}

function printHelpAndExit() {
  // The usage block at the top of this file is the canonical reference.
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const lines = src.split("\n");
  // Print the leading comment block (everything before the first import).
  for (const line of lines) {
    if (line.startsWith("import ")) break;
    if (line.startsWith("#!")) continue;
    console.log(line.replace(/^\/\/ ?/, "").replace(/^\/\/$/, ""));
  }
  process.exit(0);
}

// --------------------------------------------------------------- key handling
// Detect an encrypted kit vault WITHOUT decrypting it. A plain Solana keypair file
// is a bare JSON array of 64 ints; a kit vault is a JSON object with cipher/ciphertext.
// We must NEVER load a vault as a keypair, NEVER decrypt it.
function classifyKeyFile(p) {
  const abs = expandHome(p);
  if (!existsSync(abs)) return { ok: false, reason: `keypair file not found: ${abs}` };
  let raw;
  try { raw = readFileSync(abs, "utf8"); } catch (e) { return { ok: false, reason: `cannot read ${abs}: ${e.message}` }; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, reason: `not JSON: ${abs}` }; }
  if (Array.isArray(parsed)) {
    if (parsed.length === 64 || parsed.length === 32) return { ok: true, abs, kind: "plain-keypair" };
    return { ok: false, reason: `JSON array of length ${parsed.length} is not a 32/64-byte keypair: ${abs}` };
  }
  // Object form => encrypted kit vault (kind/cipher/ciphertext) — REFUSE.
  const keys = Object.keys(parsed);
  if (keys.includes("ciphertext") || keys.includes("cipher") || keys.includes("kdf") || parsed.kind === "vault") {
    return {
      ok: false, vault: true,
      reason: `encrypted kit vault detected (${path.basename(abs)} has keys [${keys.join(",")}]). ` +
        `This script does NOT decrypt vaults. Provide a DECRYPTED plain keypair JSON for the CLI step ` +
        `(or use the vault outside this script and pass the derived plain key path).`,
    };
  }
  return { ok: false, reason: `unrecognized keypair JSON shape (object keys [${keys.join(",")}]): ${abs}` };
}

// Derive a PUBLIC address ONLY (pubkey out, secret never read).
function deriveAddress(absPath) {
  const r = spawnSync("solana", ["address", "-k", absPath], { encoding: "utf8" });
  if (r.status !== 0) die(`solana address -k ${absPath} failed: ${(r.stderr || r.stdout || "").trim()}`);
  return r.stdout.trim();
}

// solana rent <bytes> (works offline) -> lamports. We only ever READ rent.
function rentLamports(bytes) {
  const r = spawnSync("solana", ["rent", "--lamports", String(bytes)], { encoding: "utf8" });
  if (r.status !== 0) die(`solana rent ${bytes} failed: ${(r.stderr || r.stdout || "").trim()}`);
  const m = (r.stdout || "").match(/([0-9]+)\s*lamports/);
  if (!m) die(`could not parse 'solana rent ${bytes}' output: ${r.stdout}`);
  return BigInt(m[1]);
}

// --------------------------------------------------------- known test-id guard
// Refuse a ZK image id that looks like a throwaway test/devnet pattern
// (e.g. Uint8Array(32).fill(N) -> all-same-byte, or all-zero). The audited mainnet
// id is high-entropy; these patterns are a fund-drain vector on complete_task_private.
function looksLikeTestImageId(hex) {
  const h = hex.toLowerCase();
  if (/^0+$/.test(h)) return "all-zero";
  // fill(N): the 32-byte buffer is one repeated byte -> 64 hex = repeated 2-char pair.
  const pair = h.slice(0, 2);
  if (h === pair.repeat(32)) return `repeated single byte 0x${pair} (looks like Uint8Array(32).fill(${parseInt(pair, 16)}))`;
  // trivial ascending 00 01 02 ... or 01 02 03 ...
  const bytes = h.match(/.{2}/g).map((x) => parseInt(x, 16));
  if (bytes.every((b, i) => b === i)) return "sequential 00,01,02,... pattern";
  if (bytes.every((b, i) => b === (i + 1) % 256)) return "sequential 01,02,03,... pattern";
  return null;
}

function parseZkImageId(args) {
  const raw = (args["zk-image-id"] || process.env.ZK_IMAGE_ID_HEX || "").trim().replace(/^0x/i, "");
  if (!raw) return { provided: false };
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) die(`--zk-image-id must be exactly 64 hex chars (32 bytes); got ${raw.length}.`);
  const test = looksLikeTestImageId(raw);
  if (test) die(`--zk-image-id ${raw} looks like a TEST/devnet image id (${test}). ` +
    `Refusing — supply the AUDITED mainnet image id from the agenc-prover build.`);
  return { provided: true, hex: raw.toLowerCase() };
}

// Parse the OPTIONAL disabled_task_type_mask stamp override (--disabled-task-type-mask /
// DISABLED_TASK_TYPE_MASK). Returns { provided:false } when unset (=> the stamp preserves
// the live mask), or { provided:true, value } with a validated integer 0..15. Mirrors the
// child script AND the on-chain validate_disabled_task_type_mask: non-negative integer with
// NO bits outside TASK_TYPE_DISABLE_MASK (0b1111). HARD-FAILS on 16/99/-1/non-int so the
// orchestrator (the sole authority) refuses an invalid mask before any broadcast.
function parseDisabledTaskTypeMaskOverride(args) {
  const raw = (args["disabled-task-type-mask"] ?? process.env.DISABLED_TASK_TYPE_MASK ?? "").toString().trim();
  if (raw === "") return { provided: false };
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    die(`--disabled-task-type-mask '${raw}' is not a non-negative integer. Valid: 0..15 ` +
        `(0=ALL task types enabled, 14=Exclusive only).`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 255) {
    die(`--disabled-task-type-mask '${raw}' is out of u8 range. Valid: 0..15.`);
  }
  if ((n & ~TASK_TYPE_DISABLE_MASK) !== 0) {
    die(`--disabled-task-type-mask ${n} has bits outside 0b1111 (TASK_TYPE_DISABLE_MASK) — ` +
        `the program's validate_disabled_task_type_mask would reject it on-chain. Valid: 0..15.`);
  }
  return { provided: true, value: n };
}

// Resolve the bid-marketplace economics the INIT step (mainnet-init-and-stamp.mjs §4a) WILL
// set, reading the SAME --bid-* flags / BID_* env / conservative defaults the child uses. This
// is display-only (so the human sees the money rules in the PLAN before --execute); the child
// remains the single place these values are actually written on-chain. `flag` is the CLI form
// the orchestrator forwards (runInit), `env` the var name the child reads, and they stay in
// lockstep with the child's defaults at scripts/mainnet-init-and-stamp.mjs §4a.
function resolveBidEconomics(args) {
  const pick = (flag, env, def) => {
    if (args[flag] !== undefined) return String(args[flag]);
    if (process.env[env] !== undefined && process.env[env] !== "") return String(process.env[env]);
    return def;
  };
  const minBondLamports = pick("bid-min-bond-lamports", "BID_MIN_BOND_LAMPORTS", "1000000");
  const cooldownSecs = pick("bid-creation-cooldown-secs", "BID_CREATION_COOLDOWN_SECS", "60");
  const maxPer24h = pick("bid-max-per-24h", "BID_MAX_PER_24H", "50");
  const maxActivePerTask = pick("bid-max-active-per-task", "BID_MAX_ACTIVE_PER_TASK", "20");
  const maxLifetimeSecs = pick("bid-max-lifetime-secs", "BID_MAX_LIFETIME_SECS", "604800");
  const noShowSlashBps = pick("bid-noshow-slash-bps", "BID_NOSHOW_SLASH_BPS", "1000");
  return { minBondLamports, cooldownSecs, maxPer24h, maxActivePerTask, maxLifetimeSecs, noShowSlashBps };
}

// ------------------------------------------------------- live state decoding
async function readProtocolConfig(connection, protocolPda) {
  const ai = await connection.getAccountInfo(protocolPda);
  if (!ai) die(`ProtocolConfig ${protocolPda.toBase58()} not found at this RPC — wrong cluster/program?`);
  if (!ai.owner.equals(PROGRAM_ID)) die(`ProtocolConfig owner ${ai.owner.toBase58()} != program ${PROGRAM_ID_STR}.`);
  const d = ai.data, base = 8;
  const authority = new PublicKey(d.subarray(base, base + 32)).toBase58();
  const treasury = new PublicKey(d.subarray(base + 32, base + 64)).toBase58();
  const multisigThreshold = d[base + 132];
  const multisigOwnersLen = d[base + 133];
  const protocolPaused = d[base + 179] !== 0;
  const disabledTaskTypeMask = d[base + 180];
  const owners = [];
  for (let i = 0; i < multisigOwnersLen && i < 5; i++) {
    owners.push(new PublicKey(d.subarray(base + 181 + i * 32, base + 181 + i * 32 + 32)).toBase58());
  }
  const migrated = d.length >= SIZES.CFG_NEW;
  const surfaceRevision = migrated ? d.readUInt16LE(base + 341) : null;
  return { dataLen: d.length, lamports: BigInt(ai.lamports), authority, treasury,
    multisigThreshold, multisigOwnersLen, owners, protocolPaused, disabledTaskTypeMask, migrated, surfaceRevision };
}

// Enumerate Task accounts by Anchor discriminator (layout-independent) and bucket by size.
async function enumerateTasks(connection) {
  const disc = createHash("sha256").update("account:Task").digest().subarray(0, 8);
  const accts = await connection.getProgramAccounts(PROGRAM_ID, {
    dataSlice: { offset: 0, length: 0 },
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc) } }],
  });
  return accts.map((a) => ({ pubkey: a.pubkey.toBase58() }));
}

// Resolve the anchor on-chain IDL account address the same way the anchor CLI does:
// base = PDA([], programId); idlAddress = createWithSeed(base, "anchor:idl", programId).
async function resolveIdlAddress() {
  const [base] = await PublicKey.findProgramAddress([], PROGRAM_ID);
  return PublicKey.createWithSeed(base, ANCHOR_IDL_SEED, PROGRAM_ID);
}

// ------------------------------------------------------------------ preflight
async function preflight(args, connection) {
  banner("PREFLIGHT (runs in PLAN and EXECUTE)");
  const pf = { checks: [], peakSol: 0 };

  // (a) .so exists; bytes + sha256 + rent recompute.
  const soPath = expandHome(args.so || process.env.SO_PATH ||
    "programs/agenc-coordination/target/deploy/agenc_coordination.so");
  const soAbs = path.isAbsolute(soPath) ? soPath : path.join(ROOT, soPath);
  if (!existsSync(soAbs)) die(`(a) .so not found: ${soAbs}`);
  const soBytes = statSync(soAbs).size;
  const soSha = createHash("sha256").update(readFileSync(soAbs)).digest("hex");
  info(`(a) .so            : ${soAbs}`);
  info(`    bytes          : ${soBytes.toLocaleString()}  ${soBytes === EXPECTED_SO_BYTES ? "(== expected)" : `(EXPECTED ${EXPECTED_SO_BYTES.toLocaleString()})`}`);
  info(`    sha256         : ${soSha}  ${soSha === EXPECTED_SO_SHA256 ? "(== audited)" : "(DOES NOT MATCH AUDITED — re-measure!)"}`);
  if (soBytes !== EXPECTED_SO_BYTES) {
    info(`    NOTE: byte count differs from the investigated spec; rent below is recomputed for the ACTUAL ${soBytes} B.`);
  }
  if (soSha !== EXPECTED_SO_SHA256) {
    die(`(a) .so sha256 ${soSha} != audited ${EXPECTED_SO_SHA256}. Refusing — deploy ONLY the audited full-surface binary.`);
  }
  // IDL ix-count sanity (full surface, not canary).
  const idlPath = expandHome(args.idl || process.env.IDL_PATH || "target/idl/agenc_coordination.json");
  const idlAbs = path.isAbsolute(idlPath) ? idlPath : path.join(ROOT, idlPath);
  if (!existsSync(idlAbs)) die(`(a) IDL not found: ${idlAbs} (needed for step 6 publish).`);
  const idl = JSON.parse(readFileSync(idlAbs, "utf8"));
  const ixCount = idl.instructions.length;
  info(`    IDL            : ${idlAbs}  (${ixCount} instructions)`);
  if (ixCount !== EXPECTED_FULL_IX_COUNT) {
    die(`(a) IDL has ${ixCount} instructions, expected the FULL surface ${EXPECTED_FULL_IX_COUNT}. ` +
      `Did you point at the 25-ix canary IDL? Refusing.`);
  }
  if (!idl.instructions.some((i) => i.name === "initialize_bid_marketplace" || i.name === "initializeBidMarketplace")) {
    die("(a) IDL is missing initialize_bid_marketplace — not the full surface. Refusing.");
  }
  pf.checks.push("(a) .so bytes+sha256 match audited; IDL is the full 84-ix surface");
  pf.soAbs = soAbs; pf.idlAbs = idlAbs; pf.soBytes = soBytes;

  // Rent recompute against the ACTUAL .so.
  const programDataRent = rentLamports(soBytes + PROGRAMDATA_META_BYTES);
  const bufferRent = rentLamports(soBytes + BUFFER_META_BYTES);
  info(`    ProgramData rent (${(soBytes + PROGRAMDATA_META_BYTES).toLocaleString()} B): ${lamportsToSol(programDataRent).toFixed(8)} SOL (permanent floor)`);
  info(`    upgrade buffer rent (${(soBytes + BUFFER_META_BYTES).toLocaleString()} B): ${lamportsToSol(bufferRent).toFixed(8)} SOL (TEMPORARY — refunds on clean upgrade)`);
  pf.programDataRent = programDataRent; pf.bufferRent = bufferRent;

  // (b) upgrade-authority keypair: classify + derive pubkey + match expected.
  const uaPathRaw = args["upgrade-authority"] || process.env.UPGRADE_AUTHORITY;
  if (!uaPathRaw) die("(b) --upgrade-authority (or UPGRADE_AUTHORITY) is required (plain keypair path).");
  const uaClass = classifyKeyFile(uaPathRaw);
  if (!uaClass.ok) die(`(b) upgrade-authority ${uaClass.vault ? "VAULT REFUSED" : "invalid"}: ${uaClass.reason}`);
  const uaPub = deriveAddress(uaClass.abs);
  info(`(b) upgrade-authority: ${uaClass.abs}`);
  info(`    pubkey         : ${uaPub}  ${uaPub === EXPECTED_UPGRADE_AUTHORITY ? "(== program upgrade authority)" : "(MISMATCH)"}`);
  if (uaPub !== EXPECTED_UPGRADE_AUTHORITY) {
    die(`(b) upgrade-authority pubkey ${uaPub} != expected ${EXPECTED_UPGRADE_AUTHORITY}. Refusing.`);
  }
  pf.checks.push("(b) --upgrade-authority pubkey == HcecpKXM... (program upgrade authority + ProtocolConfig.authority)");
  pf.uaAbs = uaClass.abs; pf.uaPub = uaPub;

  // Live ProtocolConfig (decode multisig owners, treasury, paused/mask, migration state).
  const [protocolPda] = PublicKey.findProgramAddressSync([Buffer.from("protocol")], PROGRAM_ID);
  const cfg = await readProtocolConfig(connection, protocolPda);
  info(`\n    Live ProtocolConfig ${protocolPda.toBase58()}:`);
  info(`      dataLen=${cfg.dataLen} (${cfg.migrated ? "MIGRATED 351B" : "LEGACY 349B"})  authority=${cfg.authority}`);
  info(`      multisig=${cfg.multisigThreshold}/${cfg.multisigOwnersLen}  paused=${cfg.protocolPaused}  disabledTaskTypeMask=${cfg.disabledTaskTypeMask}  surfaceRevision=${cfg.surfaceRevision}`);
  info(`      owners: ${cfg.owners.join(", ")}`);
  if (cfg.authority !== EXPECTED_UPGRADE_AUTHORITY) {
    die(`live ProtocolConfig.authority ${cfg.authority} != the upgrade authority ${EXPECTED_UPGRADE_AUTHORITY}. Unexpected — refusing.`);
  }
  // Stamp mask override (validated here so PLAN dies on a bad value before any broadcast). The
  // child stamp step writes this instead of preserving the live mask; the orchestrator is the
  // sole authority and forwards it explicitly (see runStamp/buildChildEnv).
  const maskOverride = parseDisabledTaskTypeMaskOverride(args);
  if (maskOverride.provided && (cfg.disabledTaskTypeMask & ~TASK_TYPE_DISABLE_MASK) !== 0) {
    die(`live disabled_task_type_mask=${cfg.disabledTaskTypeMask} has unknown bits — refusing ` +
      `(even with an override, the live account is corrupt and the on-chain re-write would be rejected).`);
  }
  pf.cfg = cfg; pf.protocolPda = protocolPda; pf.maskOverride = maskOverride;

  // (d) cosigners exist + form a valid M-of-N set against LIVE owners.
  const cosPathsRaw = (args.cosigners || process.env.COSIGNERS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const cosignerAbs = [];
  const cosignerPubs = [];
  for (const p of cosPathsRaw) {
    const c = classifyKeyFile(p);
    if (!c.ok) die(`(d) cosigner ${c.vault ? "VAULT REFUSED" : "invalid"}: ${c.reason}`);
    const pub = deriveAddress(c.abs);
    cosignerAbs.push(c.abs); cosignerPubs.push(pub);
  }
  // Unique owner-signers among {authority} ∪ cosigners that are ProtocolConfig owners.
  const ownerSet = new Set(cfg.owners);
  const signerPubs = [uaPub, ...cosignerPubs].filter((p, i, a) => a.indexOf(p) === i);
  const eligible = signerPubs.filter((p) => ownerSet.has(p));
  const unmet = cfg.owners.filter((o) => !signerPubs.includes(o));
  info(`\n(d) multisig signers : authority + ${cosignerAbs.length} cosigner(s)`);
  for (const p of cosignerPubs) info(`      cosigner pubkey: ${p}  ${ownerSet.has(p) ? "(owner)" : "(NOT an owner)"}`);
  info(`    eligible owner-signers: ${eligible.length} of required threshold ${cfg.multisigThreshold}`);
  if (eligible.length < cfg.multisigThreshold) {
    die(`(d) multisig-gated steps need >= ${cfg.multisigThreshold} owner-signers; only ${eligible.length} supplied are owners. ` +
      `Unmet owners (any one more satisfies 2-of-${cfg.multisigOwnersLen}): ${unmet.join(", ")}. Add a cosigner via --cosigners.`);
  }
  pf.checks.push(`(d) cosigners present and form a valid ${cfg.multisigThreshold}-of-${cfg.multisigOwnersLen} owner-signer set`);
  pf.cosignerAbs = cosignerAbs;

  // (e) live Task count (re-counted) for the sweep EXPECTED_TASKS.
  const tasks = await enumerateTasks(connection);
  const total = tasks.length;
  // Bucket by size for resume detection.
  const sizes = await sampleTaskSizes(connection, tasks);
  info(`\n(e) live Task count  : ${total}  (sweep EXPECTED_TASKS = ${total})`);
  info(`      sizes: 382B(legacy)=${sizes.old}  466B(migrated)=${sizes.new}  other=${sizes.other}`);
  const expectedTasks = args["expected-tasks"] || process.env.EXPECTED_TASKS;
  if (expectedTasks && Number(expectedTasks) !== total) {
    die(`(e) --expected-tasks=${expectedTasks} but ${total} live tasks found. Re-verify (tasks may have been created on the live canary).`);
  }
  pf.checks.push(`(e) live Task count re-counted (${total}); EXPECTED_TASKS surfaced for the sweep`);
  pf.taskCount = total; pf.taskSizes = sizes;

  // (f) audited ZK image id MUST be supplied unless explicitly deferred.
  const skipZk = !!args.skipZkConfig || process.env.SKIP_ZK_CONFIG === "1";
  const zk = parseZkImageId(args);
  if (!skipZk && !zk.provided) {
    die("(f) audited ZK image id is REQUIRED (--zk-image-id <64hex> or ZK_IMAGE_ID_HEX). NO DEFAULT. " +
      "There is no in-repo mainnet image id — supply the audited one from the agenc-prover build, " +
      "or pass --skip-zk-config to DEFER ZkConfig (complete_task_private stays unusable until set).");
  }
  if (skipZk) info(`\n(f) ZK image id      : DEFERRED (--skip-zk-config) — ZkConfig NOT initialized this run`);
  else info(`\n(f) ZK image id      : provided (64-hex, non-zero, not a known test pattern) — validated`);
  pf.checks.push(skipZk
    ? "(f) ZK image id explicitly DEFERRED (--skip-zk-config)"
    : "(f) audited ZK image id supplied + validated (64hex, non-zero, not a test pattern; no default)");
  pf.skipZk = skipZk; pf.zk = zk;

  // ----- SOL need: peak (buffer + permanent extension + migrate rent + fees) -----
  const currentPdLamports = await currentProgramDataLamports(connection);
  const extensionTopUp = pf.programDataRent > currentPdLamports ? pf.programDataRent - currentPdLamports : 0n;
  const perTaskDelta = rentLamports(SIZES.TASK_NEW) - rentLamports(SIZES.TASK_OLD);
  const cfgDelta = rentLamports(SIZES.CFG_NEW) - rentLamports(SIZES.CFG_OLD);
  // Only un-migrated tasks/config still owe rent top-up.
  const migrateRentRemaining = perTaskDelta * BigInt(sizes.old) + (cfg.migrated ? 0n : cfgDelta);
  const migrateRentAll = perTaskDelta * BigInt(total) + cfgDelta; // full-sweep figure for reference
  const feeBudget = BigInt(Math.round(TX_FEE_BUDGET_SOL * 1e9));
  const peakLamports = pf.bufferRent + extensionTopUp + migrateRentRemaining + feeBudget;
  const netPermanentLamports = extensionTopUp + migrateRentRemaining + feeBudget; // after buffer refunds

  info(`\n    SOL accounting (recomputed live):`);
  info(`      current ProgramData balance locked : ${lamportsToSol(currentPdLamports).toFixed(8)} SOL`);
  info(`      permanent ProgramData extension top-up: ${lamportsToSol(extensionTopUp).toFixed(8)} SOL (locked forever)`);
  info(`      migrate rent remaining (un-migrated): ${lamportsToSol(migrateRentRemaining).toFixed(8)} SOL  (full-sweep would be ${lamportsToSol(migrateRentAll).toFixed(8)})`);
  info(`      tx-fee budget                       : ${TX_FEE_BUDGET_SOL.toFixed(8)} SOL`);
  info(`      PEAK need (buffer + ext + migrate + fees): ${lamportsToSol(peakLamports).toFixed(8)} SOL`);
  info(`      NET permanent (after ~${lamportsToSol(pf.bufferRent).toFixed(2)} buffer refund): ${lamportsToSol(netPermanentLamports).toFixed(8)} SOL`);
  pf.peakLamports = peakLamports;

  // (c) authority balance >= peak need.
  const bal = await connection.getBalance(new PublicKey(uaPub));
  info(`\n(c) authority balance: ${lamportsToSol(BigInt(bal)).toFixed(8)} SOL  (peak need ${lamportsToSol(peakLamports).toFixed(8)} SOL)`);
  if (BigInt(bal) < peakLamports) {
    const short = peakLamports - BigInt(bal);
    die(`(c) authority ${uaPub} holds ${lamportsToSol(BigInt(bal)).toFixed(8)} SOL but PEAK need is ${lamportsToSol(peakLamports).toFixed(8)} SOL ` +
      `— SHORTFALL ${lamportsToSol(short).toFixed(8)} SOL. Fund before deploying.`);
  }
  pf.checks.push(`(c) authority SOL balance (${lamportsToSol(BigInt(bal)).toFixed(4)}) >= peak need (${lamportsToSol(peakLamports).toFixed(4)})`);

  banner("PREFLIGHT PASSED");
  for (const c of pf.checks) info(`  OK ${c}`);
  return pf;
}

async function currentProgramDataLamports(connection) {
  // ProgramData account = PDA([programId], BPFLoaderUpgradeable). Read-only balance.
  const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const [programData] = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], BPF_LOADER_UPGRADEABLE);
  const ai = await connection.getAccountInfo(programData);
  return ai ? BigInt(ai.lamports) : 0n;
}

// Read just the data length of each task via dataSlice (cheap). Bucket by 382/466/other.
async function sampleTaskSizes(connection, tasks) {
  let oldN = 0, newN = 0, other = 0;
  // getMultipleAccountsInfo with dataSlice length 0 returns null data; we need the real len.
  // Use getProgramAccounts already-fetched pubkeys with a tiny slice to read length cheaply.
  const pubkeys = tasks.map((t) => new PublicKey(t.pubkey));
  const CHUNK = 100;
  for (let i = 0; i < pubkeys.length; i += CHUNK) {
    const chunk = pubkeys.slice(i, i + CHUNK);
    const infos = await connection.getMultipleAccountsInfo(chunk);
    for (const ai of infos) {
      if (!ai) { other++; continue; }
      if (ai.data.length === SIZES.TASK_OLD) oldN++;
      else if (ai.data.length === SIZES.TASK_NEW) newN++;
      else other++;
    }
  }
  return { old: oldN, new: newN, other };
}

// --------------------------------------------------------------- step planner
// Determine which steps are still NEEDED (resume detection) and enforce order.
async function planSteps(pf, connection, args) {
  const cfg = pf.cfg;
  const soUpToDate = await isProgramBinaryUpToDate(connection, pf.soBytes);
  const sweepDone = cfg.migrated && pf.taskSizes.old === 0 && pf.taskSizes.other === 0;
  const protocolMigrated = cfg.migrated;

  const [bidPda] = PublicKey.findProgramAddressSync([Buffer.from("bid_marketplace")], PROGRAM_ID);
  const [zkPda] = PublicKey.findProgramAddressSync([Buffer.from("zk_config")], PROGRAM_ID);
  const bidExists = !!(await connection.getAccountInfo(bidPda));
  const zkExists = !!(await connection.getAccountInfo(zkPda));
  const initDone = bidExists && (zkExists || pf.skipZk);
  const stampDone = cfg.surfaceRevision === SURFACE_REVISION_FULL;

  const idlAddress = await resolveIdlAddress();
  const idlExists = !!(await connection.getAccountInfo(idlAddress));

  return {
    deploy: { needed: !soUpToDate, done: soUpToDate, note: soUpToDate ? "binary already the new size/sha — no-op" : "DEPLOY the new full-surface binary" },
    sweep: { needed: !sweepDone, done: sweepDone, protocolMigrated,
      note: sweepDone ? "config 351B + all tasks 466B — sweep already complete"
        : `migrate ${protocolMigrated ? "(protocol done)" : "protocol"} + ${pf.taskSizes.old} un-migrated task(s)` },
    init: { needed: !initDone, done: initDone, bidExists, zkExists,
      note: initDone ? "BidMarketplaceConfig + ZkConfig present (or zk deferred)"
        : `${bidExists ? "" : "init bid_marketplace; "}${zkExists || pf.skipZk ? "" : "init zk_config; "}verify moderation`.trim() },
    stamp: { needed: !stampDone, done: stampDone,
      note: stampDone ? `surface_revision already FULL (${SURFACE_REVISION_FULL})`
        : pf.maskOverride.provided
          ? `stamp surface_revision=${SURFACE_REVISION_FULL} (preserving paused=${cfg.protocolPaused}, mask ${cfg.disabledTaskTypeMask} -> ${pf.maskOverride.value}${pf.maskOverride.value === 0 ? " (ALL task types ENABLED)" : ""})`
          : `stamp surface_revision=${SURFACE_REVISION_FULL} (preserving paused=${cfg.protocolPaused}, mask=${cfg.disabledTaskTypeMask})` },
    idl: { needed: !idlExists, done: false, idlExists, idlAddress: idlAddress.toBase58(),
      note: idlExists ? `anchor IDL account ${idlAddress.toBase58()} EXISTS -> use 'anchor idl upgrade'`
        : `anchor IDL account does NOT exist -> first publish is 'anchor idl init'` },
  };
}

async function isProgramBinaryUpToDate(connection, soBytes) {
  // Compare the on-chain ProgramData payload length against the local .so size.
  // ProgramData layout: 45-byte header (UpgradeableLoaderState::ProgramData) then the ELF.
  const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const [programData] = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], BPF_LOADER_UPGRADEABLE);
  const ai = await connection.getAccountInfo(programData);
  if (!ai) return false;
  // The on-chain ELF is right-padded with zeros up to the original deploy length, so an exact
  // payload match is not guaranteed; treat "account already big enough for the new size" as a
  // hint but rely on the operator's sha verification. We only flag "clearly the old, smaller
  // canary binary" => needs deploy.
  const onChainPayload = ai.data.length - PROGRAMDATA_META_BYTES;
  return onChainPayload >= soBytes; // if it can already hold the new size, treat as deployed
}

// --------------------------------------------------------------- confirmation
async function confirmProgramId(args) {
  const typed = args["yes-i-typed-the-program-id"];
  if (typed !== undefined) {
    if (typed !== PROGRAM_ID_STR) die(`typed confirmation '${typed}' != program id ${PROGRAM_ID_STR}. Refusing to broadcast.`);
    info(`\nTyped confirmation accepted (non-interactive): ${typed}`);
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => rl.question(
    `\nTo BROADCAST, type the program id to proceed (${PROGRAM_ID_STR}):\n> `, (a) => { rl.close(); res(a.trim()); }));
  if (answer !== PROGRAM_ID_STR) die(`confirmation '${answer}' != program id. Aborting — nothing broadcast.`);
  info("Confirmation accepted.");
}

// --------------------------------------------------------------- step runners
function printDeployCommand(pf, args) {
  const cup = args["compute-unit-price"] || process.env.COMPUTE_UNIT_PRICE;
  const rpc = args.rpc || process.env.RPC_URL;
  const lines = [
    "solana program deploy \\",
    `  --program-id ${PROGRAM_ID_STR} \\`,
    `  --upgrade-authority ${pf.uaAbs} \\`,
    `  --fee-payer ${pf.uaAbs} \\`,
    `  --keypair ${pf.uaAbs} \\`,
    `  --url ${rpc} \\`,
    ...(cup ? [`  --with-compute-unit-price ${cup} \\`] : []),
    `  ${pf.soAbs}`,
  ];
  info(lines.join("\n"));
  info(`  (optional resumability: add --buffer <mainnet-upgrade-buffer-...json>)`);
}

function runDeploy(pf, args) {
  const cup = args["compute-unit-price"] || process.env.COMPUTE_UNIT_PRICE;
  const rpc = args.rpc || process.env.RPC_URL;
  // --fee-payer + --keypair both point at the funded authority so the buffer rent
  // and tx fees come from Hcecp…, never the (empty) default CLI keypair.
  const argv = ["program", "deploy", "--program-id", PROGRAM_ID_STR,
    "--upgrade-authority", pf.uaAbs, "--fee-payer", pf.uaAbs, "--keypair", pf.uaAbs, "--url", rpc];
  if (cup) argv.push("--with-compute-unit-price", String(cup));
  argv.push(pf.soAbs);
  info(`\n+ solana ${argv.join(" ")}`);
  const r = spawnSync("solana", argv, { stdio: "inherit" });
  if (r.status !== 0) die(`deploy failed (exit ${r.status}). FIX and re-run with --only sweep,init,stamp,idl to resume (binary may be partially written; re-run deploy with --buffer to resume the write).`);
  info("Deploy step complete.");
}

function buildChildEnv(pf, args, extra = {}) {
  const env = { ...process.env };
  env.RPC_URL = args.rpc || process.env.RPC_URL;
  env.AUTHORITY_KEYPAIR = pf.uaAbs;
  if (pf.cosignerAbs.length) env.COSIGNERS = pf.cosignerAbs.join(",");
  else delete env.COSIGNERS;
  // Wipe any inherited step-skip / zk / mask env so the orchestrator — not the ambient shell —
  // is the sole authority on what each child step does. `extra` (set per phase below) is
  // the explicit, intended set of skips/overrides for that child invocation. DISABLED_TASK_TYPE_MASK
  // is wiped here and re-injected ONLY by the stamp phase (runStamp), so the validated orchestrator
  // value is what reaches the stamp child — never an ambient one, and never another child.
  for (const k of ["SKIP_BID_MARKETPLACE", "SKIP_ZK_CONFIG", "SKIP_MODERATION", "SKIP_STAMP",
    "SKIP_PROTOCOL", "ZK_IMAGE_ID_HEX", "MODERATION_AUTHORITY", "EXPECTED_TASKS",
    "DISABLED_TASK_TYPE_MASK"]) delete env[k];
  return { ...env, ...extra };
}

function runChild(scriptRel, childArgs, env, label) {
  const scriptAbs = path.join(ROOT, scriptRel);
  if (!existsSync(scriptAbs)) die(`missing child script: ${scriptAbs}`);
  info(`\n+ node ${scriptRel} ${childArgs.join(" ")}`);
  const r = spawnSync("node", [scriptAbs, ...childArgs], { stdio: "inherit", env });
  if (r.status !== 0) die(`${label} failed (exit ${r.status}). See its output above; fix and re-run this orchestrator (it resumes from live state).`);
}

function runSweep(pf, args, execute) {
  const env = buildChildEnv(pf, args, { EXPECTED_TASKS: String(pf.taskCount) });
  const childArgs = [];
  if (execute) childArgs.push("--execute");
  if (pf.cfg.migrated) childArgs.push("--skip-protocol"); // protocol already migrated -> resume task-only
  runChild("scripts/mainnet-migrate-sweep.mjs", childArgs, env, "migrate sweep");
}

function runInit(pf, args, execute) {
  // Init-only: skip the stamp (that's our Step 5). Forward zk image id + bid + moderation env.
  const extra = { SKIP_STAMP: "1" };
  if (pf.skipZk) extra.SKIP_ZK_CONFIG = "1";
  else extra.ZK_IMAGE_ID_HEX = pf.zk.hex;
  // forward bid-* and moderation overrides
  const fwd = {
    "bid-min-bond-lamports": "BID_MIN_BOND_LAMPORTS",
    "bid-creation-cooldown-secs": "BID_CREATION_COOLDOWN_SECS",
    "bid-max-per-24h": "BID_MAX_PER_24H",
    "bid-max-active-per-task": "BID_MAX_ACTIVE_PER_TASK",
    "bid-max-lifetime-secs": "BID_MAX_LIFETIME_SECS",
    "bid-noshow-slash-bps": "BID_NOSHOW_SLASH_BPS",
  };
  for (const [flag, envName] of Object.entries(fwd)) if (args[flag] !== undefined) extra[envName] = String(args[flag]);
  if (args["moderation-authority"]) extra.MODERATION_AUTHORITY = String(args["moderation-authority"]);
  const env = buildChildEnv(pf, args, extra);
  const childArgs = execute ? ["--execute"] : [];
  runChild("scripts/mainnet-init-and-stamp.mjs", childArgs, env, "config init");
}

function runStamp(pf, args, execute) {
  // Stamp-only: skip the inits (already done in Step 4); only update_launch_controls.
  const extra = { SKIP_BID_MARKETPLACE: "1", SKIP_ZK_CONFIG: "1", SKIP_MODERATION: "1" };
  // Forward the validated mask override EXPLICITLY (the orchestrator is the sole authority —
  // buildChildEnv wipes any ambient DISABLED_TASK_TYPE_MASK). When unset, the child preserves
  // the live mask exactly as before.
  if (pf.maskOverride.provided) extra.DISABLED_TASK_TYPE_MASK = String(pf.maskOverride.value);
  const env = buildChildEnv(pf, args, extra);
  const childArgs = execute ? ["--execute"] : [];
  runChild("scripts/mainnet-init-and-stamp.mjs", childArgs, env, "surface_revision stamp");
}

function printIdlCommand(pf, args, idlStep) {
  const rpc = args.rpc || process.env.RPC_URL;
  const verb = idlStep.idlExists ? "upgrade" : "init";
  info(`anchor idl ${verb} ${PROGRAM_ID_STR} \\`);
  info(`  -f ${pf.idlAbs} \\`);
  info(`  --provider.cluster ${rpc} \\`);
  info(`  --provider.wallet ${pf.uaAbs}`);
  if (!idlStep.idlExists) info(`  (first publish — 'anchor idl init' can only run ONCE; subsequent re-publishes use 'anchor idl upgrade')`);
  info(`  Verify: anchor idl fetch ${PROGRAM_ID_STR} --provider.cluster ${rpc}  (should show ${EXPECTED_FULL_IX_COUNT} instructions)`);
}

function runIdl(pf, args, idlStep) {
  const rpc = args.rpc || process.env.RPC_URL;
  const verb = idlStep.idlExists ? "upgrade" : "init";
  const argv = ["idl", verb, PROGRAM_ID_STR, "-f", pf.idlAbs, "--provider.cluster", rpc, "--provider.wallet", pf.uaAbs];
  info(`\n+ anchor ${argv.join(" ")}`);
  const r = spawnSync("anchor", argv, { stdio: "inherit" });
  if (r.status !== 0) die(`anchor idl ${verb} failed (exit ${r.status}). Resume: re-run this orchestrator with --only idl.`);
}

// ------------------------------------------------------------------ main
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) printHelpAndExit();

  const rpc = args.rpc || process.env.RPC_URL;
  if (!rpc) die("--rpc <url> (or RPC_URL) is required (mainnet RPC for read-only decode + the deploy).");
  const execute = !!args.execute;

  // Fail FAST (before any network) on a bad/missing ZK image id — the authoritative
  // presence check is preflight (f), but validating shape + refusing test patterns here
  // gives an immediate, offline-reproducible refusal. parseZkImageId already die()s on a
  // wrong length / all-zero / known test pattern. Missing+not-skipped is caught in (f).
  const earlySkipZk = !!args.skipZkConfig || process.env.SKIP_ZK_CONFIG === "1";
  if (!earlySkipZk) parseZkImageId(args);

  // Step subset (still order-checked).
  let steps = ALL_STEPS;
  if (args.only) {
    const want = String(args.only).split(",").map((s) => s.trim()).filter(Boolean);
    for (const s of want) if (!ALL_STEPS.includes(s)) die(`--only: unknown step '${s}'. Valid: ${ALL_STEPS.join(",")}`);
    // Enforce contiguity in canonical order (cannot run a later step before an earlier one
    // unless the earlier is already done — verified below against live state).
    steps = ALL_STEPS.filter((s) => want.includes(s));
  }

  banner(`AgenC full-surface mainnet upgrade — ${execute ? "EXECUTE" : "PLAN (dry-run, nothing broadcast)"}`);
  info(`Program: ${PROGRAM_ID_STR}`);
  info(`RPC    : ${rpc}`);
  info(`Steps  : ${steps.join(" -> ")} (canonical order: ${ALL_STEPS.join(" -> ")})`);

  const connection = new Connection(rpc, "confirmed");

  // --- PREFLIGHT (plan AND execute) ---
  const pf = await preflight(args, connection);

  // --- resume detection / step plan ---
  const plan = await planSteps(pf, connection, args);

  banner("ORDERED PLAN");
  for (const s of ALL_STEPS) {
    const p = plan[s];
    const selected = steps.includes(s);
    const state = p.done ? "DONE (skip)" : p.needed ? "PENDING" : "skip";
    info(`  [${selected ? "x" : " "}] ${s.padEnd(7)} : ${state.padEnd(11)} ${p.note}`);
  }

  // ORDER ENFORCEMENT: a selected step may run only if every earlier canonical step is
  // already done OR also selected-and-runnable. Never stamp before migrate+init.
  for (const s of steps) {
    const idx = ALL_STEPS.indexOf(s);
    for (let j = 0; j < idx; j++) {
      const earlier = ALL_STEPS[j];
      if (!plan[earlier].done && !steps.includes(earlier)) {
        die(`ORDER VIOLATION: cannot run '${s}' while earlier step '${earlier}' is neither done nor selected. ` +
          `Run steps strictly ${ALL_STEPS.join(" -> ")}.`);
      }
    }
  }
  // Hard guard: never stamp unless migrate (sweep) + init are done or running ahead of it.
  if (steps.includes("stamp") && !plan.stamp.done) {
    const sweepReady = plan.sweep.done || steps.includes("sweep");
    const initReady = plan.init.done || steps.includes("init");
    if (!sweepReady || !initReady) die("REFUSING to stamp surface_revision before the migrate sweep AND config init are complete.");
  }

  // ---------- PLAN MODE: print the exact commands, broadcast NOTHING ----------
  if (!execute) {
    banner("PLAN MODE — exact commands that WOULD run (NOTHING broadcast)");
    if (steps.includes("deploy") && plan.deploy.needed) {
      info("\nStep 1 DEPLOY (binary first; FROZEN WINDOW opens the instant this lands):");
      printDeployCommand(pf, args);
    } else if (steps.includes("deploy")) info("\nStep 1 DEPLOY: already up-to-date (skip).");

    if (steps.includes("sweep")) {
      info("\nStep 2/3 SWEEP (migrate_protocol + migrate_task) — INVOKES scripts/mainnet-migrate-sweep.mjs:");
      info(`  RPC_URL=<rpc> AUTHORITY_KEYPAIR=${pf.uaAbs} ${pf.cosignerAbs.length ? `COSIGNERS=${pf.cosignerAbs.join(",")} ` : ""}EXPECTED_TASKS=${pf.taskCount} \\`);
      info(`    node scripts/mainnet-migrate-sweep.mjs${pf.cfg.migrated ? " --skip-protocol" : ""} [--execute]`);
      info("  (dry-run here exercises migrate_task with dry_run=true on-chain — read-only)");
    }
    if (steps.includes("init")) {
      info("\nStep 4 INIT (bid_marketplace + zk_config + verify moderation) — INVOKES scripts/mainnet-init-and-stamp.mjs (SKIP_STAMP=1):");
      info(`  ${pf.skipZk ? "SKIP_ZK_CONFIG=1" : "ZK_IMAGE_ID_HEX=<audited>"} SKIP_STAMP=1 node scripts/mainnet-init-and-stamp.mjs [--execute]`);
      // Surface the bid-marketplace economics that initialize_bid_marketplace WILL set, so the
      // human sees the money rules BEFORE --execute. Only printed when the bid_marketplace init is
      // still pending (already-initialized => the on-chain config is immutable to this script).
      if (plan.init.needed && !plan.init.bidExists) {
        const b = resolveBidEconomics(args);
        info("  bid-marketplace economics (initialize_bid_marketplace — conservative defaults unless --bid-*/BID_* set):");
        info(`      min bid bond        : ${b.minBondLamports} lamports (${lamportsToSol(BigInt(b.minBondLamports)).toFixed(9)} SOL)`);
        info(`      creation cooldown   : ${b.cooldownSecs}s`);
        info(`      max bids / 24h      : ${b.maxPer24h}`);
        info(`      max active / task   : ${b.maxActivePerTask}`);
        info(`      max bid lifetime    : ${b.maxLifetimeSecs}s (${(Number(b.maxLifetimeSecs) / 86400).toFixed(2)} days)`);
        info(`      no-show slash       : ${b.noShowSlashBps} bps (${(Number(b.noShowSlashBps) / 100).toFixed(2)}%)`);
      } else if (plan.init.bidExists) {
        info("  bid-marketplace economics: BidMarketplaceConfig already exists on-chain — init is a no-op (values unchanged).");
      }
    }
    if (steps.includes("stamp")) {
      info("\nStep 5 STAMP surface_revision=FULL (LAST mutating step) — INVOKES scripts/mainnet-init-and-stamp.mjs (init-skipped):");
      const maskEnvShown = pf.maskOverride.provided ? `DISABLED_TASK_TYPE_MASK=${pf.maskOverride.value} ` : "";
      info(`  ${maskEnvShown}SKIP_BID_MARKETPLACE=1 SKIP_ZK_CONFIG=1 SKIP_MODERATION=1 node scripts/mainnet-init-and-stamp.mjs [--execute]`);
      if (pf.maskOverride.provided) {
        info(`  (will preserve live protocol_paused=${pf.cfg.protocolPaused}; OVERRIDE disabled_task_type_mask ` +
          `${pf.cfg.disabledTaskTypeMask} -> ${pf.maskOverride.value}` +
          `${pf.maskOverride.value === 0 ? " (ALL task types ENABLED)" : ""})`);
      } else {
        info(`  (will preserve live protocol_paused=${pf.cfg.protocolPaused}, disabled_task_type_mask=${pf.cfg.disabledTaskTypeMask})`);
      }
    }
    if (steps.includes("idl")) {
      info("\nStep 6 IDL publish (full 84-ix surface):");
      printIdlCommand(pf, args, plan.idl);
    }
    banner("PLAN COMPLETE — re-run with --execute AND the typed program-id confirmation to broadcast");
    info("Reminder: in --execute mode, steps 1->3 run with NO interactive pause (the typed-read freeze window).");
    return;
  }

  // ---------- EXECUTE MODE: requires the typed confirmation ----------
  await confirmProgramId(args);

  // Step 1 DEPLOY
  if (steps.includes("deploy")) {
    if (plan.deploy.needed) {
      banner("!!! FROZEN WINDOW OPENS — the instant the deploy lands, the live 349B config + " +
        `${pf.taskCount} 382B tasks fail TYPED reads. Steps 2-3 run IMMEDIATELY with NO pause. !!!`);
      runDeploy(pf, args);
    } else info("\nStep 1 DEPLOY: binary already up-to-date — skipping.");
  }

  // Step 2/3 SWEEP (immediately after deploy — closes the freeze)
  if (steps.includes("sweep")) {
    if (plan.sweep.needed) { banner("Step 2/3 SWEEP — migrate_protocol + migrate_task (closing the freeze window)"); runSweep(pf, args, true); }
    else info("\nStep 2/3 SWEEP: already complete — skipping.");
  }

  // Step 4 INIT
  if (steps.includes("init")) {
    if (plan.init.needed) { banner("Step 4 INIT — bid_marketplace + zk_config + verify moderation"); runInit(pf, args, true); }
    else info("\nStep 4 INIT: configs already present — skipping.");
  }

  // Step 5 STAMP (LAST mutating)
  if (steps.includes("stamp")) {
    if (plan.stamp.needed) { banner("Step 5 STAMP — update_launch_controls -> surface_revision = FULL (LAST)"); runStamp(pf, args, true); }
    else info("\nStep 5 STAMP: surface_revision already FULL — skipping.");
  }

  // Step 6 IDL
  if (steps.includes("idl")) {
    if (plan.idl.needed) { banner(`Step 6 IDL — anchor idl init (full ${EXPECTED_FULL_IX_COUNT}-ix surface)`); runIdl(pf, args, plan.idl); }
    else info(`\nStep 6 IDL: account ${plan.idl.idlAddress} already exists — use 'anchor idl upgrade' to re-publish (skipping init).`);
  }

  banner("UPGRADE COMPLETE");
  info("Verify: anchor idl fetch (84 ix), surface_revision=FULL, all tasks 466B, config 351B, BidMarketplaceConfig + ZkConfig present.");
}

main().catch((e) => die(e.stack || e.message || String(e)));
