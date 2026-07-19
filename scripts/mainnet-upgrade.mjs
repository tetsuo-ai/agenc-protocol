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
//                         marketplace + verify moderation; ZK stays disabled)
//   Step 5  STAMP       — scripts/mainnet-init-and-stamp.mjs (update_launch_       [INVOKED, stamp-only]
//                         controls -> current surface revision)                   [LAST mutating step]
//   Step 6  IDL         — publish the exact reviewed IDL artifact
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
//     * approved binary bytes already live -> Step 1 is a no-op (re-verify only)
//     * ProtocolConfig already 351B          -> migrate_protocol already ran
//     * all Tasks already 466B               -> sweep complete
//     * BidMarketplaceConfig exists             -> that init already ran
//     * surface_revision already current     -> stamp already done
//     * on-chain anchor IDL account exists   -> Step 6 needs `anchor idl upgrade`
//   It NEVER stamps before migrate+init complete and NEVER reorders.
//
// FROZEN WINDOW
// -------------
//   The instant Step 1 lands, a live 349B ProtocolConfig + legacy 382/432B Tasks fail
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
//   --protocol-authority <path>  PROTOCOL_AUTHORITY   plain keypair = ProtocolConfig.authority.
//                                                     Also used for a direct loader deploy ONLY
//                                                     when its pubkey equals the live loader authority;
//                                                     Squads-controlled deploys must be executed in Squads.
//   --cosigners <p1,p2,...>      COSIGNERS            in-program multisig co-signer keypair PATHS
//                                                     (need M-1 = 1 more owner for the 2-of-3 gate)
//   ZK_IMAGE_ID_HEX / --zk-image-id are FORBIDDEN for this release. Private-task
//   creation and ZkConfig activation remain disabled until an audited guest and
//   mainnet verifier deployment are independently reviewed.
//   --so <path>                  SO_PATH              the full-surface .so to deploy
//                                  default: programs/agenc-coordination/target/deploy/agenc_coordination.so
//   --idl <path>                 IDL_PATH             reviewed full-surface IDL
//                                  default: target/idl/agenc_coordination.json
//   --expected-so-sha256 <hex>   EXPECTED_SO_SHA256   independently reviewed .so digest (REQUIRED)
//   --expected-idl-sha256 <hex>  EXPECTED_IDL_SHA256  independently reviewed IDL digest (REQUIRED)
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
//   --skip-zk-config             compatibility no-op; ZK is always disabled/deferred
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
//   0. SEPARATE MULTISIG ACTION: set protocol_paused=true while preserving the
//      live mask/revision. This script verifies the pause but never creates it.
//   1. PLAN it first:   node scripts/mainnet-upgrade.mjs --rpc <url> --protocol-authority ... --cosigners ... --expected-so-sha256 ... --expected-idl-sha256 ...
//   2. Read the plan, confirm SOL/peak/task-count, stage the cosigner keys.
//   3. EXECUTE:         add --execute and type the program id at the prompt.
//   4. Keep paused through postdeploy rescan/stamp/IDL/canary. Unpause later via
//      a separately reviewed multisig action; this script never unpauses.
// =============================================================================

import { createRequire } from "module";
import { readFileSync, existsSync, statSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { createInterface } from "readline";
import path from "path";
import { scanDelegations } from "./preflight-delegation-scan.mjs";
import { scanReputationStakes } from "./preflight-reputation-stake-scan.mjs";
import { scanSkillRatingCutover } from "./preflight-skill-rating-cutover-scan.mjs";
import { decodeTaskBinding, scanDisputes } from "./preflight-dispute-scan.mjs";
import { scanTaskValidationConfigs } from "./preflight-task-validation-scan.mjs";
import { scanGovernanceProposals } from "./preflight-governance-scan.mjs";
import { scanTaskChildren } from "./preflight-task-children-scan.mjs";
import { scanTokenRewardTasks } from "./preflight-token-task-scan.mjs";
import { scanPrivateTaskCutover } from "./preflight-private-task-scan.mjs";
import { scanHireProviderBindings } from "./preflight-hire-provider-scan.mjs";
import { scanActiveJobSpecBlocks } from "./preflight-active-job-spec-block-scan.mjs";
import { scanTaskDependencies } from "./preflight-task-dependency-scan.mjs";
import { scanRejectFrozenFees } from "./preflight-reject-frozen-fee-scan.mjs";
import { scanBidContracts } from "./preflight-bid-contract-scan.mjs";
import { scanTaskSettlementSafety } from "./preflight-task-settlement-scan.mjs";
import { assertPrivateTaskReleaseDisabled } from "./private-task-release-policy.mjs";
import {
  PROGRAMDATA_METADATA_BYTES,
  assertImmediatePostUpgradeSnapshot,
  assertImmediatePreUpgradeSnapshot,
  loadReviewedUpgradeAuthorityPolicy,
  readProgramUpgradeAuthoritySnapshot,
} from "./program-upgrade-authority-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "tests-integration", "package.json"));
const { Connection, PublicKey } = require("@solana/web3.js");
const bs58 = require("bs58").default ?? require("bs58");

// ------------------------------------------------------------------ constants
const PROGRAM_ID_STR = "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK";
const PROGRAM_ID = new PublicKey(PROGRAM_ID_STR);
const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const REQUIRED_SOLANA_CLI_VERSION = "3.0.13";
// Solana loader account-data overheads (bytes added on top of the .so payload).
const PROGRAMDATA_META_BYTES = PROGRAMDATA_METADATA_BYTES;
const BUFFER_META_BYTES = 37;      // upgrade buffer header
const MIN_PROGRAMDATA_EXTENSION_BYTES = 10 * 1024;
const MAX_ACCOUNT_DATA_BYTES = 10 * 1024 * 1024;
// Layout sizes (state.rs const_assert).
const SIZES = {
  CFG_OLD: 349,
  CFG_NEW: 351,
  TASK_OLD: 382,
  TASK_BATCH2: 432,
  TASK_NEW: 466,
};
const TASK_DISCRIMINATOR = createHash("sha256")
  .update("account:Task")
  .digest()
  .subarray(0, 8);
// Mirrors ProtocolConfig::SURFACE_REVISION_CURRENT. These counts are release
// invariants, not documentation: preflight independently derives each surface
// from the cfg-gated Rust #[program] modules and refuses any drift.
const SURFACE_REVISION_CURRENT = 5;
export const PRODUCTION_INSTRUCTION_COUNT = 97;
export const PRIVATE_ZK_INSTRUCTION_COUNT = 100;
export const CANARY_INSTRUCTION_COUNT = 25;
export const PRIVATE_ZK_INSTRUCTION_NAMES = Object.freeze([
  "complete_task_private",
  "initialize_zk_config",
  "update_zk_image_id",
]);
// Allowed task-type bits (state.rs ProtocolConfig::TASK_TYPE_DISABLE_MASK = 0b0000_1111).
// A SET bit = that task type is DISABLED. 1=Exclusive 2=Collaborative 4=Competitive 8=BidExclusive.
const TASK_TYPE_DISABLE_MASK = 0b0000_1111;
// ResolveDispute must fit every fixed worker account plus a maximum-size rationale
// inside a legacy Solana packet. Mirrors state/instruction DISPUTE_SAFE_MAX_WORKERS.
export const DISPUTE_SAFE_MAX_WORKERS = 4;

/**
 * Compare an approved executable with the live loader allocation. ProgramData
 * growth is a separate, authority-gated mainnet mutation and must never be an
 * implicit side effect of this rail's deploy step.
 */
export function assessProgramDataCapacity(binaryBytes, capacityBytes) {
  for (const [label, value] of Object.entries({ binaryBytes, capacityBytes })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label} must be a non-negative safe integer`);
    }
  }
  const maximumProgramBytes = MAX_ACCOUNT_DATA_BYTES - PROGRAMDATA_META_BYTES;
  if (capacityBytes > maximumProgramBytes) {
    throw new Error(
      `capacity ${capacityBytes} exceeds loader maximum ${maximumProgramBytes}`,
    );
  }
  if (binaryBytes > maximumProgramBytes) {
    throw new Error(
      `binary ${binaryBytes} exceeds loader maximum ${maximumProgramBytes}`,
    );
  }
  const shortfallBytes = Math.max(0, binaryBytes - capacityBytes);
  const remainingBytesToMaximum = maximumProgramBytes - capacityBytes;
  return {
    binaryBytes,
    capacityBytes,
    shortfallBytes,
    extensionBytes:
      shortfallBytes === 0
        ? 0
        : remainingBytesToMaximum < MIN_PROGRAMDATA_EXTENSION_BYTES
          // SIMD-0431 permits a sub-10-KiB extension near the loader limit only
          // when it consumes *all* remaining account headroom.
          ? remainingBytesToMaximum
          : Math.max(shortfallBytes, MIN_PROGRAMDATA_EXTENSION_BYTES),
    maximumProgramBytes,
  };
}

export function loaderRentDataLengths(binaryBytes, capacityBytes) {
  // Reuse the loader-bound validation even though this helper only derives
  // account lengths.
  assessProgramDataCapacity(binaryBytes, capacityBytes);
  return {
    programData: capacityBytes + PROGRAMDATA_META_BYTES,
    bufferAllocation: binaryBytes + BUFFER_META_BYTES,
    // Agave 3.0.13 process_program_deploy passes the ProgramData-sized rent
    // minimum into create_buffer, overfunding its 37-byte metadata allocation.
    cliBufferFunding: binaryBytes + PROGRAMDATA_META_BYTES,
  };
}

export function assertPinnedSolanaCliVersion(output) {
  const match = /^solana-cli\s+(\d+\.\d+\.\d+)(?:\s|$)/.exec(String(output).trim());
  if (!match) {
    throw new Error(`could not parse solana CLI version from: ${String(output).trim()}`);
  }
  if (match[1] !== REQUIRED_SOLANA_CLI_VERSION) {
    throw new Error(
      `solana CLI ${match[1]} != reviewed ${REQUIRED_SOLANA_CLI_VERSION}`,
    );
  }
  return match[1];
}

function assertPinnedSolanaCli() {
  const result = spawnSync("solana", ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    die(`solana --version failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  try {
    const version = assertPinnedSolanaCliVersion(result.stdout);
    info(`Solana CLI         : ${version} (reviewed Agave pin)`);
  } catch (error) {
    die(`${error.message}. Refusing loader/rent operations with unreviewed CLI semantics.`);
  }
}

export function assertProgramDataCapacityUnchanged(before, after) {
  const beforeBytes = before?.payload?.length;
  const afterBytes = after?.payload?.length;
  if (!Number.isSafeInteger(beforeBytes) || !Number.isSafeInteger(afterBytes)) {
    throw new Error("ProgramData capacity snapshots are malformed");
  }
  if (afterBytes !== beforeBytes) {
    throw new Error(
      `ProgramData payload capacity changed during direct deploy: ` +
        `${beforeBytes} -> ${afterBytes} bytes`,
    );
  }
  return afterBytes;
}
// Anchor on-chain IDL account PDA seed = ["anchor:idl"]-derived base; we resolve it
// the same way `anchor idl` does (PDA off a per-program base) — see resolveIdlAddress().
const ANCHOR_IDL_SEED = "anchor:idl";
// Rough tx-fee envelope for the deploy + ~N migrate txns (spec: deploy ~0.02, sweep ~0.00085).
const TX_FEE_BUDGET_SOL = 0.05;

const ALL_STEPS = ["deploy", "sweep", "init", "stamp", "idl"];

/**
 * Prevent an execute-mode subset from opening the typed-account freeze and then
 * exiting before the migration sweep. Plan mode may still inspect a deploy-only
 * command, but adding `--execute` to that same subset fails closed.
 *
 * When both operations are pending, `sweep` must immediately follow `deploy` in
 * the selected execution sequence. The main CLI canonicalizes requested steps,
 * while the adjacency check keeps this exported policy safe for other callers.
 */
export function assertSafeSelectedSteps(
  steps,
  plan,
  { execute = false } = {},
) {
  if (!Array.isArray(steps)) {
    throw new Error("selected upgrade steps must be an array");
  }
  if (!plan?.deploy || !plan?.sweep) {
    throw new Error("selected-step safety requires deploy and sweep plan state");
  }
  if (!execute || !steps.includes("deploy") || !plan.deploy.needed || !plan.sweep.needed) {
    return;
  }

  const deployIndex = steps.indexOf("deploy");
  const sweepIndex = steps.indexOf("sweep");
  if (sweepIndex !== deployIndex + 1) {
    throw new Error(
      "UNSAFE STEP SUBSET: execute mode cannot deploy a needed binary while the " +
        "migration sweep is pending unless 'sweep' immediately follows 'deploy'. " +
        "A deploy-only execution would leave legacy-sized ProtocolConfig/Task " +
        "accounts inside the typed-read frozen window.",
    );
  }
}

// ------------------------------------------------------------------ tiny utils
// RPC secrets can appear in hostnames, paths, query strings, or userinfo. Never
// print any endpoint component; the real URL is still used for calls/child env.
function maskRpc(s) {
  return String(s).replace(/(?:https?|wss?):\/\/[^\s"']+/gi, "<redacted-rpc>");
}
function die(msg) { console.error(`\nERROR: ${maskRpc(msg)}`); process.exit(1); }
function info(msg) { console.log(maskRpc(msg)); }
function banner(msg) {
  const bar = "=".repeat(Math.max(60, msg.length + 4));
  console.log(`\n${bar}\n  ${maskRpc(msg)}\n${bar}`);
}
function expandHome(p) { return p.replace(/^~(?=$|\/)/, process.env.HOME); }
function lamportsToSol(l) { return (Number(l) / 1e9); }
function requiredSha256(args, flag, envName, label) {
  const value = String(args[flag] || process.env[envName] || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) {
    die(`${label}: --${flag} (or ${envName}) must be an independently reviewed 64-hex SHA-256 digest.`);
  }
  return value;
}

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

// Query rent through the already genesis-pinned Connection. `solana rent` would
// silently use the operator's ambient CLI URL rather than this rail's --rpc.
export async function rentLamports(connection, bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error("rent data length must be a non-negative safe integer");
  }
  const lamports = await connection.getMinimumBalanceForRentExemption(bytes);
  if (!Number.isSafeInteger(lamports) || lamports < 0) {
    throw new Error(`RPC returned an invalid rent minimum for ${bytes} bytes`);
  }
  return BigInt(lamports);
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
function assertSafeContextSlot(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function normalizePinnedRpcConfig(
  commitmentOrConfig,
  contextFloor,
  { withContext = false } = {},
) {
  let config;
  if (commitmentOrConfig === undefined) {
    config = {};
  } else if (typeof commitmentOrConfig === "string") {
    config = { commitment: commitmentOrConfig };
  } else if (
    commitmentOrConfig !== null &&
    typeof commitmentOrConfig === "object" &&
    !Array.isArray(commitmentOrConfig)
  ) {
    config = { ...commitmentOrConfig };
  } else {
    throw new Error("RPC commitment/config must be a commitment string or object");
  }

  const commitment = config.commitment ?? "confirmed";
  if (commitment !== "confirmed" && commitment !== "finalized") {
    throw new Error(
      `context-pinned reads require confirmed or finalized commitment, got ${String(commitment)}`,
    );
  }
  const requestedFloor = config.minContextSlot === undefined
    ? contextFloor
    : Math.max(
        contextFloor,
        assertSafeContextSlot(config.minContextSlot, "RPC minContextSlot"),
      );
  return {
    ...config,
    commitment,
    minContextSlot: requestedFloor,
    ...(withContext ? { withContext: true } : {}),
  };
}

function assertRpcResponseContext(response, requiredFloor, stage, operation) {
  if (
    response === null ||
    typeof response !== "object" ||
    response.context === null ||
    typeof response.context !== "object" ||
    !Number.isSafeInteger(response.context.slot) ||
    response.context.slot < 0 ||
    !("value" in response)
  ) {
    throw new Error(`${stage}: ${operation} RPC response context is malformed`);
  }
  if (response.context.slot < requiredFloor) {
    throw new Error(
      `${stage}: ${operation} RPC context slot ${response.context.slot} is below ` +
        `required minContextSlot ${requiredFloor}`,
    );
  }
  return response.context.slot;
}

/**
 * Present scanner modules with the Connection API they already consume while
 * forcing every account/GPA/GMA read through a validated, monotonically
 * increasing context floor. Reads are serialized so a later inventory call can
 * never be served from a slot older than an earlier eligibility call.
 */
export function createContextPinnedConnection(
  connection,
  initialMinContextSlot,
  stage = "Context-pinned scan",
) {
  if (connection === null || typeof connection !== "object") {
    throw new Error(`${stage}: RPC connection is required`);
  }
  let contextFloor = assertSafeContextSlot(
    initialMinContextSlot,
    `${stage} initial minContextSlot`,
  );
  let failed = null;
  let tail = Promise.resolve();

  const requireMethod = (name) => {
    const method = connection[name];
    if (typeof method !== "function") {
      throw new Error(`${stage}: RPC connection has no ${name} method`);
    }
    return method.bind(connection);
  };

  const enqueueContextRead = (operation, request, select) => {
    const pending = tail.then(async () => {
      if (failed) throw failed;
      const requiredFloor = contextFloor;
      try {
        const response = await request(requiredFloor);
        contextFloor = assertRpcResponseContext(
          response,
          requiredFloor,
          stage,
          operation,
        );
        return select(response);
      } catch (error) {
        failed = error instanceof Error ? error : new Error(String(error));
        throw failed;
      }
    });
    // Keep the serializer usable without creating an unhandled rejection. Once
    // one read fails, queued calls observe `failed` and reject without touching RPC.
    tail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };

  const pinnedMethods = {
    getAccountInfo(publicKey, commitmentOrConfig) {
      return enqueueContextRead(
        "getAccountInfo",
        async (requiredFloor) =>
          requireMethod("getAccountInfoAndContext")(
            publicKey,
            normalizePinnedRpcConfig(commitmentOrConfig, requiredFloor),
          ),
        (response) => response.value,
      );
    },
    getAccountInfoAndContext(publicKey, commitmentOrConfig) {
      return enqueueContextRead(
        "getAccountInfoAndContext",
        async (requiredFloor) =>
          requireMethod("getAccountInfoAndContext")(
            publicKey,
            normalizePinnedRpcConfig(commitmentOrConfig, requiredFloor),
          ),
        (response) => response,
      );
    },
    getMultipleAccountsInfo(publicKeys, commitmentOrConfig) {
      return enqueueContextRead(
        "getMultipleAccountsInfo",
        async (requiredFloor) =>
          requireMethod("getMultipleAccountsInfoAndContext")(
            publicKeys,
            normalizePinnedRpcConfig(commitmentOrConfig, requiredFloor),
          ),
        (response) => response.value,
      );
    },
    getMultipleAccountsInfoAndContext(publicKeys, commitmentOrConfig) {
      return enqueueContextRead(
        "getMultipleAccountsInfoAndContext",
        async (requiredFloor) =>
          requireMethod("getMultipleAccountsInfoAndContext")(
            publicKeys,
            normalizePinnedRpcConfig(commitmentOrConfig, requiredFloor),
          ),
        (response) => response,
      );
    },
    getProgramAccounts(programId, commitmentOrConfig) {
      const callerRequestedContext =
        commitmentOrConfig !== null &&
        typeof commitmentOrConfig === "object" &&
        commitmentOrConfig.withContext === true;
      return enqueueContextRead(
        "getProgramAccounts",
        async (requiredFloor) =>
          requireMethod("getProgramAccounts")(
            programId,
            normalizePinnedRpcConfig(commitmentOrConfig, requiredFloor, {
              withContext: true,
            }),
          ),
        (response) => callerRequestedContext ? response : response.value,
      );
    },
    getSlot(commitmentOrConfig) {
      return enqueueContextRead(
        "getSlot",
        async (requiredFloor) => {
          const slot = await requireMethod("getSlot")(
            normalizePinnedRpcConfig(commitmentOrConfig, requiredFloor),
          );
          return { context: { slot }, value: slot };
        },
        (response) => response.value,
      );
    },
  };

  const pinnedConnection = new Proxy(connection, {
    get(target, property, receiver) {
      if (Object.prototype.hasOwnProperty.call(pinnedMethods, property)) {
        return pinnedMethods[property];
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    connection: pinnedConnection,
    getMinContextSlot: () => contextFloor,
  };
}

export async function captureConfirmedContextSlot(
  connection,
  minContextSlot,
  stage = "Cutover context capture",
) {
  const requiredFloor = assertSafeContextSlot(
    minContextSlot,
    `${stage} minContextSlot`,
  );
  if (typeof connection?.getLatestBlockhashAndContext !== "function") {
    throw new Error(`${stage}: RPC connection has no getLatestBlockhashAndContext method`);
  }
  const response = await connection.getLatestBlockhashAndContext({
    commitment: "confirmed",
    minContextSlot: requiredFloor,
  });
  return assertRpcResponseContext(
    response,
    requiredFloor,
    stage,
    "getLatestBlockhashAndContext",
  );
}

function decodeProtocolConfigAccount(ai, protocolPda) {
  if (!ai) {
    throw new Error(
      `ProtocolConfig ${protocolPda.toBase58()} not found at this RPC — wrong cluster/program?`,
    );
  }
  if (!ai.owner?.equals(PROGRAM_ID)) {
    throw new Error(
      `ProtocolConfig owner ${ai.owner?.toBase58?.() ?? "malformed"} != program ${PROGRAM_ID_STR}`,
    );
  }
  const d = ai.data, base = 8;
  if (d.length !== SIZES.CFG_OLD && d.length !== SIZES.CFG_NEW) {
    throw new Error(
      `ProtocolConfig has unexpected size ${d.length}; expected ${SIZES.CFG_OLD} ` +
        `(legacy) or ${SIZES.CFG_NEW} (migrated)`,
    );
  }
  const expectedDiscriminator = createHash("sha256")
    .update("account:ProtocolConfig")
    .digest()
    .subarray(0, 8);
  if (!d.subarray(0, 8).equals(expectedDiscriminator)) {
    throw new Error("ProtocolConfig discriminator mismatch; refusing to decode or deploy");
  }
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
  return {
    dataLen: d.length,
    dataSha256: createHash("sha256").update(d).digest("hex"),
    lamports: BigInt(ai.lamports),
    authority,
    treasury,
    multisigThreshold,
    multisigOwnersLen,
    owners,
    protocolPaused,
    disabledTaskTypeMask,
    migrated,
    surfaceRevision,
  };
}

async function readProtocolConfigAndContext(
  connection,
  protocolPda,
  commitmentOrConfig = "confirmed",
) {
  if (typeof connection?.getAccountInfoAndContext !== "function") {
    throw new Error("ProtocolConfig RPC connection has no getAccountInfoAndContext method");
  }
  const config = normalizePinnedRpcConfig(commitmentOrConfig, 0);
  const response = await connection.getAccountInfoAndContext(protocolPda, config);
  const contextSlot = assertRpcResponseContext(
    response,
    config.minContextSlot,
    "ProtocolConfig read",
    "getAccountInfoAndContext",
  );
  return {
    cfg: decodeProtocolConfigAccount(response.value, protocolPda),
    contextSlot,
  };
}

/**
 * Prove the pause at finalized commitment, capture a current confirmed floor,
 * run all inventory reads through the pinned adapter, and reject any config
 * change before returning the snapshot.
 */
export async function withPinnedRevision5CutoverContext(
  connection,
  protocolPda,
  stage,
  scan,
  { minContextSlot = 0 } = {},
) {
  if (typeof scan !== "function") {
    throw new Error(`${stage}: cutover scan callback is required`);
  }
  const loaderFloor = assertSafeContextSlot(
    minContextSlot,
    `${stage} loader minContextSlot`,
  );
  const finalizedPause = await readProtocolConfigAndContext(
    connection,
    protocolPda,
    "finalized",
  );
  assertRevision5Paused(finalizedPause.cfg, `${stage} finalized pause proof`);

  const confirmedFloor = await captureConfirmedContextSlot(
    connection,
    Math.max(loaderFloor, finalizedPause.contextSlot),
    stage,
  );
  const pinned = createContextPinnedConnection(connection, confirmedFloor, stage);
  const initial = await readProtocolConfigAndContext(
    pinned.connection,
    protocolPda,
    "confirmed",
  );
  assertRevision5Paused(initial.cfg, `${stage} pinned entry proof`);

  const result = await scan(pinned.connection, initial.cfg);

  const final = await readProtocolConfigAndContext(
    pinned.connection,
    protocolPda,
    "confirmed",
  );
  assertRevision5Paused(final.cfg, `${stage} pinned final proof`);
  if (final.cfg.dataSha256 !== initial.cfg.dataSha256) {
    throw new Error(
      `${stage}: ProtocolConfig changed during the cutover scan ` +
        `(entry_context=${initial.contextSlot} final_context=${final.contextSlot})`,
    );
  }
  return {
    cfg: final.cfg,
    contextSlot: pinned.getMinContextSlot(),
    finalizedPauseContextSlot: finalizedPause.contextSlot,
    result,
  };
}

export function inspectTaskMigrationCompatibility(dataLike) {
  const data = Buffer.from(dataLike);
  if (![SIZES.TASK_OLD, SIZES.TASK_BATCH2, SIZES.TASK_NEW].includes(data.length)) {
    throw new Error(`Task: unsupported migration size ${data.length}`);
  }
  if (!data.subarray(0, 8).equals(TASK_DISCRIMINATOR)) {
    throw new Error("Task: discriminator mismatch");
  }
  const task = decodeTaskBinding(data);
  const maxWorkers = data[184];
  const currentWorkers = data[185];
  const status = task.status;
  const taskType = data[187];
  if (taskType > 3) throw new Error(`Task.task_type: invalid enum variant ${taskType}`);
  if ((task.dependsOn === null) !== (task.dependencyType === 0)) {
    throw new Error(
      `Task dependency Option/type mismatch: parent=${task.dependsOn !== null} ` +
      `dependency_type=${task.dependencyType}`,
    );
  }
  const terminal = status === 3 || status === 4;
  return {
    maxWorkers,
    currentWorkers,
    status,
    taskType,
    dependsOn: task.dependsOn,
    dependencyType: task.dependencyType,
    incompatibleExclusive:
      taskType === 0 && !terminal && maxWorkers !== 1,
    aboveDisputeSafeMaxWorkers: maxWorkers > DISPUTE_SAFE_MAX_WORKERS,
    disputeUnsafeActiveWorkers:
      !terminal && currentWorkers > DISPUTE_SAFE_MAX_WORKERS,
  };
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

export function assertRevision5Paused(cfg, stage = "Revision-5 cutover") {
  if (!cfg.protocolPaused) {
    throw new Error(
      `${stage}: live ProtocolConfig.protocol_paused=false. The revision-5 cutover ` +
      "requires the in-program multisig to pause entry first. This rail never pauses " +
      "or unpauses automatically.",
    );
  }
}

export function assertTreasuryAccountBoundary(treasuryAddress, account, stage = "Treasury preflight") {
  const treasury = new PublicKey(treasuryAddress);
  if (treasury.equals(PublicKey.default)) {
    throw new Error(`${stage}: ProtocolConfig.treasury is the default pubkey`);
  }
  if (!account) {
    throw new Error(`${stage}: treasury ${treasury.toBase58()} does not exist`);
  }
  if (
    !account.owner.equals(SYSTEM_PROGRAM_ID) ||
    account.executable ||
    account.data.length !== 0
  ) {
    throw new Error(
      `${stage}: treasury ${treasury.toBase58()} must be a non-executable, zero-data ` +
      `System Program account; owner=${account.owner.toBase58()} ` +
      `executable=${account.executable} data_len=${account.data.length}`,
    );
  }
}

function cfgAttributesBefore(lines, lineIndex) {
  const attributes = [];
  for (let index = lineIndex - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line === "" || line.startsWith("///") || line.startsWith("//")) continue;
    if (line.startsWith("#[") && line.endsWith("]")) {
      attributes.unshift(line);
      continue;
    }
    break;
  }
  return attributes;
}

function cfgAttributesEnabled(attributes, features) {
  for (const attribute of attributes) {
    const positive = attribute.match(/^#\[cfg\(feature\s*=\s*"([^"]+)"\)\]$/);
    if (positive && !features.has(positive[1])) return false;
    const negative = attribute.match(/^#\[cfg\(not\(feature\s*=\s*"([^"]+)"\)\)\]$/);
    if (negative && features.has(negative[1])) return false;
    if (attribute.startsWith("#[cfg(") && !positive && !negative) {
      throw new Error(`unsupported #[cfg] on program entrypoint: ${attribute}`);
    }
  }
  return true;
}

/** Derive one compiled Anchor surface from the cfg-gated Rust source. */
export function deriveProgramInstructionNames(
  sourceText,
  { mainnetCanary = false, privateZk = false } = {},
) {
  const source = String(sourceText);
  const fullMarker = '#[cfg(not(feature = "mainnet-canary"))]';
  const canaryMarker = '#[cfg(feature = "mainnet-canary")]';
  const fullStart = source.indexOf(fullMarker);
  const canaryStart = source.indexOf(canaryMarker, fullStart + fullMarker.length);
  if (fullStart < 0 || canaryStart < 0 || canaryStart <= fullStart) {
    throw new Error("could not isolate cfg-gated #[program] modules in lib.rs");
  }
  const moduleSource = mainnetCanary
    ? source.slice(canaryStart)
    : source.slice(fullStart, canaryStart);
  const features = new Set([
    ...(mainnetCanary ? ["mainnet-canary"] : []),
    ...(privateZk ? ["private-zk"] : []),
  ]);
  const lines = moduleSource.split(/\r?\n/);
  const names = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^    pub fn\s+([A-Za-z0-9_]+)/);
    if (!match) continue;
    if (cfgAttributesEnabled(cfgAttributesBefore(lines, index), features)) {
      names.push(match[1]);
    }
  }
  if (names.length === 0) {
    throw new Error("selected #[program] surface contains no public entrypoints");
  }
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length > 0) {
    throw new Error(`duplicate Rust entrypoints: ${[...new Set(duplicates)].join(", ")}`);
  }
  return names;
}

/** Production/default surface: full program with private-zk explicitly off. */
export function deriveFullProgramInstructionNames(sourceText) {
  return deriveProgramInstructionNames(sourceText, {
    mainnetCanary: false,
    privateZk: false,
  });
}

export function assertProductionCargoFeaturePolicy(cargoTomlText) {
  const featuresSection = String(cargoTomlText).match(
    /^\[features\]\s*$([\s\S]*?)(?=^\[[^\]]+\]\s*$)/m,
  )?.[1];
  if (!featuresSection) throw new Error("Cargo.toml has no parseable [features] table");
  const defaultMatch = featuresSection.match(/^default\s*=\s*\[([^\]]*)\]\s*$/m);
  if (!defaultMatch) throw new Error("Cargo.toml [features].default is not a string array");
  const defaults = [...defaultMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  if (defaults.length !== 1 || defaults[0] !== "spl-token-rewards") {
    throw new Error(
      `production default features must be exactly [spl-token-rewards], found [${defaults.join(", ")}]`,
    );
  }
  if (!/^private-zk\s*=\s*\[\s*\]\s*$/m.test(featuresSection)) {
    throw new Error("private-zk must remain an explicitly enabled, dependency-free feature");
  }
  return { defaultFeatures: defaults, privateZk: false };
}

export function assertProgramSurfaceReleasePolicy(sourceText, cargoTomlText) {
  const cargo = assertProductionCargoFeaturePolicy(cargoTomlText);
  const production = deriveFullProgramInstructionNames(sourceText);
  const privateZk = deriveProgramInstructionNames(sourceText, { privateZk: true });
  const canary = deriveProgramInstructionNames(sourceText, { mainnetCanary: true });
  if (production.length !== PRODUCTION_INSTRUCTION_COUNT) {
    throw new Error(
      `production Rust surface must be exactly ${PRODUCTION_INSTRUCTION_COUNT} instructions, found ${production.length}`,
    );
  }
  if (privateZk.length !== PRIVATE_ZK_INSTRUCTION_COUNT) {
    throw new Error(
      `explicit private-zk Rust surface must be exactly ${PRIVATE_ZK_INSTRUCTION_COUNT} instructions, found ${privateZk.length}`,
    );
  }
  if (canary.length !== CANARY_INSTRUCTION_COUNT) {
    throw new Error(
      `mainnet-canary Rust surface must be exactly ${CANARY_INSTRUCTION_COUNT} instructions, found ${canary.length}`,
    );
  }
  const productionSet = new Set(production);
  const privateOnly = privateZk.filter((name) => !productionSet.has(name));
  if (
    privateOnly.length !== PRIVATE_ZK_INSTRUCTION_NAMES.length ||
    PRIVATE_ZK_INSTRUCTION_NAMES.some((name) => !privateOnly.includes(name))
  ) {
    throw new Error(`private-zk delta is not the reviewed three-instruction quarantine: [${privateOnly.join(", ")}]`);
  }
  return { cargo, production, privateZk, canary, privateOnly };
}

function normalizeInstructionName(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
}

export function assertIdlMatchesProgramInstructions(idlInstructions, sourceNames) {
  if (!Array.isArray(idlInstructions)) {
    throw new Error("IDL instructions is not an array");
  }
  const idlNames = idlInstructions.map((instruction) =>
    normalizeInstructionName(instruction?.name));
  const duplicateIdl = idlNames.filter(
    (name, index) => idlNames.indexOf(name) !== index,
  );
  if (duplicateIdl.length > 0) {
    throw new Error(`duplicate IDL instructions: ${[...new Set(duplicateIdl)].join(", ")}`);
  }
  const sourceSet = new Set(sourceNames);
  const idlSet = new Set(idlNames);
  const missing = sourceNames.filter((name) => !idlSet.has(name));
  const extra = idlNames.filter((name) => !sourceSet.has(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Rust/IDL instruction mismatch: rust=${sourceNames.length} idl=${idlNames.length} ` +
      `missing_in_idl=[${missing.join(", ")}] extra_in_idl=[${extra.join(", ")}]`,
    );
  }
  return { sourceCount: sourceNames.length, idlCount: idlNames.length };
}

export function assertRevision5DisputeCutover(
  disputes,
  stage = "Revision-5 cutover",
) {
  if (disputes.blockers.length > 0 || disputes.statusCounts.active !== 0) {
    const kinds = [...new Set(disputes.blockers.map((item) => item.kind))];
    throw new Error(
      `${stage}: dispute cutover requires zero Active and no incompatible finalizers; ` +
      `found ${disputes.blockers.length} blocker(s) (${kinds.join(", ") || "active-count invariant failure"}). ` +
      "Run scripts/preflight-dispute-scan.mjs and remediate before continuing.",
    );
  }
}

export function assertRevision4BondEntryClosed(
  taskSettlement,
  stage = "Revision-5 cutover",
) {
  if (taskSettlement.blockers.length > 0) {
    const kinds = [...new Set(taskSettlement.blockers.map((item) => item.kind))];
    throw new Error(
      `${stage}: task settlement scan found ${taskSettlement.blockers.length} insolvent, aliased, or malformed condition(s) ` +
      `(${kinds.join(", ")}). Run scripts/preflight-task-settlement-scan.mjs and remediate before continuing.`,
    );
  }
  if (taskSettlement.revision4BondPostEligibleTaskCount !== 0) {
    throw new Error(
      `${stage}: cutover requires zero Tasks eligible for deployed revision-4 post_completion_bond; ` +
      `found count=${String(taskSettlement.revision4BondPostEligibleTaskCount)}. The deployed entry ` +
      "is not pause-gated, so settle/cancel every eligible Exclusive SOL task before invoking the loader. " +
      "Run scripts/preflight-task-settlement-scan.mjs for the exact Task inventory.",
    );
  }
}

export function assertCompletionBondInventoryEmpty(
  taskChildren,
  stage = "Revision-5 cutover",
) {
  if (taskChildren.blockers.length > 0) {
    const kinds = [...new Set(taskChildren.blockers.map((item) => item.kind))];
    throw new Error(
      `${stage}: task-child inventory found ${taskChildren.blockers.length} active/principal or malformed blocker(s) ` +
      `(${kinds.join(", ")}). Run scripts/preflight-task-children-scan.mjs and remediate before continuing.`,
    );
  }
  if (
    taskChildren.liveCompletionBondCount !== 0 ||
    taskChildren.liveCompletionBondPrincipal !== 0n
  ) {
    throw new Error(
      `${stage}: cutover requires zero live CompletionBond principal before invoking the loader; ` +
      `found count=${String(taskChildren.liveCompletionBondCount)} ` +
      `principal=${String(taskChildren.liveCompletionBondPrincipal)}. Run ` +
      "scripts/preflight-task-children-scan.mjs and settle/reclaim every live bond before continuing.",
    );
  }
}

/**
 * Establish the stable completion-bond cutover in its security-critical order:
 * zero Active disputes (no paused exit can restore a bond-eligible status), then
 * zero Tasks accepted by revision 4's unpaused bond entry, and only then the
 * final all-account CompletionBond inventory. Once the first two predicates are
 * true under protocol pause, an unprivileged caller cannot create a new bond.
 */
export async function scanStableRevision5CompletionBondCutover(
  connection,
  disputes,
  stage = "Revision-5 cutover",
  scanners = {},
) {
  const scanTaskSettlement =
    scanners.scanTaskSettlement ?? scanTaskSettlementSafety;
  const scanChildren = scanners.scanTaskChildren ?? scanTaskChildren;

  assertRevision5DisputeCutover(disputes, stage);
  const taskSettlement = await scanTaskSettlement(connection);
  // Deliberately fail before the child scan. Scanning children first permits a
  // revision-4 caller to post, detach, and orphan a bond in the RPC gap.
  assertRevision4BondEntryClosed(taskSettlement, stage);
  const taskChildren = await scanChildren(connection);
  assertCompletionBondInventoryEmpty(taskChildren, stage);
  return { taskSettlement, taskChildren };
}

export function assertRevision5CutoverResults(
  {
    delegation,
    skillRating,
    reputationStakes,
    disputes,
    validation,
    governance,
    taskChildren,
    tokenTasks,
    privateTasks,
    hireProviders,
    jobSpecBlocks,
    dependencies,
    rejectFrozen,
    bidContracts,
    taskSettlement,
  },
  stage = "Revision-5 cutover",
) {
  if (delegation.blockers.length > 0 || delegation.accountCount !== 0) {
    const kinds = [...new Set(delegation.blockers.map((item) => item.kind))];
    throw new Error(
      `${stage}: delegation cutover requires exactly zero accounts; found ` +
      `${delegation.accountCount} (${kinds.join(", ") || "scanner invariant failure"}). ` +
      "Run scripts/preflight-delegation-scan.mjs and retire/remediate before continuing.",
    );
  }
  const skillRatingCounts = [
    skillRating?.accountCount,
    skillRating?.skillCount,
    skillRating?.purchaseCount,
    skillRating?.ratingCount,
    skillRating?.decodedSkillCount,
    skillRating?.decodedPurchaseCount,
    skillRating?.decodedRatingCount,
  ];
  const skillRatingAggregateValid =
    Array.isArray(skillRating?.blockers) &&
    skillRatingCounts.every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) &&
    skillRating.accountCount ===
      skillRating.skillCount +
        skillRating.purchaseCount +
        skillRating.ratingCount &&
    skillRating.decodedSkillCount === skillRating.skillCount &&
    skillRating.decodedPurchaseCount === skillRating.purchaseCount &&
    skillRating.decodedRatingCount === skillRating.ratingCount;
  if (
    !skillRatingAggregateValid ||
    skillRating.blockers.length !== 0 ||
    skillRating.accountCount !== 0 ||
    skillRating.skillCount !== 0 ||
    skillRating.purchaseCount !== 0 ||
    skillRating.ratingCount !== 0
  ) {
    const kinds = Array.isArray(skillRating?.blockers)
      ? [...new Set(skillRating.blockers.map((item) => item.kind))]
      : [];
    throw new Error(
      `${stage}: skill-rating cutover requires exactly zero SkillRegistration, PurchaseRecord, and SkillRating accounts ` +
      `(skills=${String(skillRating?.skillCount)}, purchases=${String(skillRating?.purchaseCount)}, ` +
      `ratings=${String(skillRating?.ratingCount)}, ` +
      `blockers=${kinds.join(", ") || "scanner aggregate invariant failure"}). ` +
      "The deployed skill entry/rating paths are pause-gated, so this zero set is stable. " +
      "Run scripts/preflight-skill-rating-cutover-scan.mjs and remediate before continuing.",
    );
  }
  const stakeCounts = [
    reputationStakes?.accountCount,
    reputationStakes?.decodedAccountCount,
    reputationStakes?.liveAgentCount,
    reputationStakes?.retiredAgentCount,
    reputationStakes?.absentAgentCount,
    reputationStakes?.invalidAgentCount,
    reputationStakes?.principalWithoutAgentCount,
    reputationStakes?.underbackedAccountCount,
  ];
  const stakeLamportAggregates = [
    reputationStakes?.rentMinimumLamports,
    reputationStakes?.trackedStakedAmount,
    reputationStakes?.actualLamports,
    reputationStakes?.requiredRentLamports,
    reputationStakes?.requiredBackingLamports,
    reputationStakes?.backingDeficitLamports,
    reputationStakes?.backingSurplusLamports,
    reputationStakes?.principalWithoutAgentLamports,
  ];
  const stakeAggregateValid =
    Array.isArray(reputationStakes?.blockers) &&
    stakeCounts.every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) &&
    stakeLamportAggregates.every(
      (value) => typeof value === "bigint" && value >= 0n,
    ) &&
    reputationStakes.decodedAccountCount === reputationStakes.accountCount &&
    reputationStakes.liveAgentCount +
      reputationStakes.retiredAgentCount +
      reputationStakes.absentAgentCount +
      reputationStakes.invalidAgentCount ===
      reputationStakes.decodedAccountCount &&
    reputationStakes.requiredRentLamports ===
      reputationStakes.rentMinimumLamports *
        BigInt(reputationStakes.decodedAccountCount) &&
    reputationStakes.requiredBackingLamports ===
      reputationStakes.requiredRentLamports +
        reputationStakes.trackedStakedAmount &&
    reputationStakes.actualLamports +
      reputationStakes.backingDeficitLamports ===
      reputationStakes.requiredBackingLamports +
        reputationStakes.backingSurplusLamports;
  if (
    !stakeAggregateValid ||
    reputationStakes.blockers.length > 0 ||
    reputationStakes.invalidAgentCount !== 0 ||
    reputationStakes.underbackedAccountCount !== 0 ||
    reputationStakes.principalWithoutAgentCount !== 0 ||
    reputationStakes.principalWithoutAgentLamports !== 0n ||
    reputationStakes.backingDeficitLamports !== 0n ||
    reputationStakes.actualLamports < reputationStakes.requiredBackingLamports
  ) {
    const kinds = Array.isArray(reputationStakes?.blockers)
      ? [...new Set(reputationStakes.blockers.map((item) => item.kind))]
      : [];
    throw new Error(
      `${stage}: ReputationStake custody inventory is malformed, orphaned with principal, or underbacked ` +
      `(accounts=${String(reputationStakes?.accountCount)}, ` +
      `principal=${String(reputationStakes?.trackedStakedAmount)}, ` +
      `actual=${String(reputationStakes?.actualLamports)}, ` +
      `required=${String(reputationStakes?.requiredBackingLamports)}, ` +
      `deficit=${String(reputationStakes?.backingDeficitLamports)}, ` +
      `blockers=${kinds.join(", ") || "scanner aggregate invariant failure"}). ` +
      "Run scripts/preflight-reputation-stake-scan.mjs and remediate before continuing.",
    );
  }
  assertRevision5DisputeCutover(disputes, stage);
  if (
    validation.blockers.length > 0 ||
    validation.modeCounts.validatorQuorum !== 0
  ) {
    const kinds = [...new Set(validation.blockers.map((item) => item.kind))];
    throw new Error(
      `${stage}: task-validation cutover found ${validation.blockers.length} blocker(s) ` +
      `(${kinds.join(", ") || "quorum-count invariant failure"}). Run ` +
      "scripts/preflight-task-validation-scan.mjs and settle/remove every ValidatorQuorum config.",
    );
  }
  if (governance.blockers.length > 0 || governance.statusCounts.active !== 0) {
    const kinds = [...new Set(governance.blockers.map((item) => item.kind))];
    throw new Error(
      `${stage}: governance cutover requires zero Active proposals; found ` +
      `${governance.blockers.length} blocker(s) (${kinds.join(", ") || "active-count invariant failure"}). ` +
      "Run scripts/preflight-governance-scan.mjs and settle/cancel every Active proposal.",
    );
  }
  assertCompletionBondInventoryEmpty(taskChildren, stage);
  if (tokenTasks.blockers.length > 0) {
    const kinds = [...new Set(tokenTasks.blockers.map((item) => item.kind))];
    throw new Error(
      `${stage}: token-task escrow scan found ${tokenTasks.blockers.length} unsafe live condition(s) ` +
      `(${kinds.join(", ")}). Run scripts/preflight-token-task-scan.mjs and remediate before continuing.`,
    );
  }
  if (privateTasks.blockers.length > 0) {
    const kinds = [...new Set(privateTasks.blockers.map((item) => item.kind))];
    throw new Error(
      `${stage}: private-task release scan found ${privateTasks.blockers.length} forbidden/malformed condition(s) ` +
      `(${kinds.join(", ")}). Run scripts/preflight-private-task-scan.mjs; this release must remain ZK-disabled.`,
    );
  }
  if (hireProviders.blockers.length > 0) {
    const kinds = [...new Set(hireProviders.blockers.map((item) => item.kind))];
    throw new Error(
      `${stage}: hired-task provider scan found ${hireProviders.blockers.length} unsafe binding condition(s) ` +
      `(${kinds.join(", ")}). Run scripts/preflight-hire-provider-scan.mjs and remediate before continuing.`,
    );
  }
  if (jobSpecBlocks.blockers.length > 0) {
    const kinds = [...new Set(jobSpecBlocks.blockers.map((item) => item.kind))];
    throw new Error(
      `${stage}: active job-spec moderation scan found ${jobSpecBlocks.blockers.length} malformed condition(s) ` +
      `(${kinds.join(", ")}). Run scripts/preflight-active-job-spec-block-scan.mjs and remediate before continuing.`,
    );
  }
  const dependencyTypeCounts = dependencies?.nonterminalDependencyTypeCounts;
  const dependencyAggregateValid =
    Array.isArray(dependencies?.blockers) &&
    Number.isSafeInteger(dependencies?.dependentCount) &&
    dependencies.dependentCount >= 0 &&
    Number.isSafeInteger(dependencies?.nonterminalDependentCount) &&
    dependencies.nonterminalDependentCount >= 0 &&
    [
      dependencyTypeCounts?.data,
      dependencyTypeCounts?.ordering,
      dependencyTypeCounts?.proof,
    ].every((value) => Number.isSafeInteger(value) && value >= 0) &&
    dependencies.nonterminalDependentCount === dependencies.dependentCount &&
    dependencies.nonterminalDependentCount ===
      dependencyTypeCounts.data +
        dependencyTypeCounts.ordering +
        dependencyTypeCounts.proof;
  if (!dependencyAggregateValid || dependencies.blockers.length > 0) {
    const kinds = Array.isArray(dependencies?.blockers)
      ? [...new Set(dependencies.blockers.map((item) => item.kind))]
      : [];
    throw new Error(
      `${stage}: task-dependency scan found malformed or unsafe obligations ` +
      `(${kinds.join(", ") || "scanner aggregate invariant failure"}). ` +
      "Run scripts/preflight-task-dependency-scan.mjs and remediate before continuing.",
    );
  }
  if (dependencies.nonterminalDependentCount !== 0) {
    throw new Error(
      `${stage}: cutover requires zero nonterminal dependent Tasks before invoking the loader; ` +
      `found count=${dependencies.nonterminalDependentCount} ` +
      `(Data=${dependencyTypeCounts.data}, Ordering=${dependencyTypeCounts.ordering}, ` +
      `Proof=${dependencyTypeCounts.proof}). The deployed parent can close during the paused upload, ` +
      "while the candidate requires a live Completed parent for settlement. " +
      "Run scripts/preflight-task-dependency-scan.mjs and settle/cancel every dependent child.",
    );
  }
  if (rejectFrozen.blockers.length > 0) {
    const kinds = [...new Set(rejectFrozen.blockers.map((item) => item.kind))];
    throw new Error(
      `${stage}: RejectFrozen fee/principal scan found ${rejectFrozen.blockers.length} unsafe condition(s) ` +
      `(${kinds.join(", ")}). Run scripts/preflight-reject-frozen-fee-scan.mjs and remediate before continuing.`,
    );
  }
  if (bidContracts.blockers.length > 0) {
    const kinds = [...new Set(bidContracts.blockers.map((item) => item.kind))];
    throw new Error(
      `${stage}: bid-contract scan found ${bidContracts.blockers.length} unsafe contract/principal condition(s) ` +
      `(${kinds.join(", ")}). Run scripts/preflight-bid-contract-scan.mjs and remediate before continuing.`,
    );
  }
  if (
    bidContracts.openBidCount !== 0 ||
    bidContracts.openBidBondPrincipal !== 0n
  ) {
    throw new Error(
      `${stage}: cutover requires zero open TaskBid accounts (Active or BoundActive) before invoking the loader; ` +
      `found count=${String(bidContracts.openBidCount)} ` +
      `bond_principal=${String(bidContracts.openBidBondPrincipal)}. Run ` +
      "scripts/preflight-bid-contract-scan.mjs and cancel/expire every open bid before continuing.",
    );
  }
  assertRevision4BondEntryClosed(taskSettlement, stage);
}

export async function verifyRevision5CutoverState(
  rpcConnection,
  protocolPda,
  stage,
  { minContextSlot = 0 } = {},
) {
  const pinned = await withPinnedRevision5CutoverContext(
    rpcConnection,
    protocolPda,
    stage,
    async (connection, cfg) => {
      info(
        `${stage}: protocol_paused=true (entry paths closed; exits remain available)`,
      );
      const treasuryAccount = await connection.getAccountInfo(
        new PublicKey(cfg.treasury),
        "confirmed",
      );
      assertTreasuryAccountBoundary(cfg.treasury, treasuryAccount, stage);
      info(
        `${stage}: treasury=${cfg.treasury} owner=System Program ` +
          `balance=${treasuryAccount.lamports} executable=false data_len=0`,
      );

      const delegation = await scanDelegations(connection);
      info(
        `${stage}: ReputationDelegation=${delegation.accountCount}, blockers=${delegation.blockers.length}`,
      );
      const skillRating = await scanSkillRatingCutover(connection);
      info(
        `${stage}: skill_rating_cutover=${skillRating.accountCount}, ` +
          `skills=${skillRating.skillCount}, purchases=${skillRating.purchaseCount}, ` +
          `ratings=${skillRating.ratingCount}, blockers=${skillRating.blockers.length}`,
      );
      const reputationStakes = await scanReputationStakes(connection);
      info(
        `${stage}: ReputationStake=${reputationStakes.accountCount}, ` +
          `decoded=${reputationStakes.decodedAccountCount}, ` +
          `principal=${reputationStakes.trackedStakedAmount}, ` +
          `actual_lamports=${reputationStakes.actualLamports}, ` +
          `required_rent=${reputationStakes.requiredRentLamports}, ` +
          `required_backing=${reputationStakes.requiredBackingLamports}, ` +
          `deficit=${reputationStakes.backingDeficitLamports}, ` +
          `principal_without_agent=${reputationStakes.principalWithoutAgentLamports}, ` +
          `blockers=${reputationStakes.blockers.length}`,
      );
      const disputes = await scanDisputes(connection);
      info(
        `${stage}: Dispute=${disputes.accountCount}, active=${disputes.statusCounts.active}, blockers=${disputes.blockers.length}`,
      );
      const validation = await scanTaskValidationConfigs(connection);
      info(
        `${stage}: TaskValidationConfig=${validation.accountCount}, ` +
          `ValidatorQuorum=${validation.modeCounts.validatorQuorum}, blockers=${validation.blockers.length}`,
      );
      const governance = await scanGovernanceProposals(connection);
      info(
        `${stage}: Proposal=${governance.accountCount}, ` +
          `active=${governance.statusCounts.active}, votes=${governance.governanceVoteCount}, ` +
          `approval_bps=${governance.governance?.approvalThresholdBps ?? "unavailable"}, ` +
          `min_proposal_stake=${governance.governance?.minProposalStake ?? "unavailable"}, ` +
          `min_arbiter_stake=${governance.protocol?.minArbiterStake ?? "unavailable"}, ` +
          `eligible_authorities=${governance.voterReachability.eligibleDistinctAuthorityCount}, ` +
          `attainable_weight=${governance.voterReachability.attainableVoteWeight}, ` +
          `fresh_quorum=${governance.voterReachability.freshQuorum ?? "unavailable"}, ` +
          `fresh_reachable=${governance.voterReachability.freshProposalReachable}, ` +
          `blockers=${governance.blockers.length}`,
      );
      const tokenTasks = await scanTokenRewardTasks(connection);
      info(
        `${stage}: token_tasks=${tokenTasks.tokenTaskCount}, live=${tokenTasks.liveCount}, ` +
          `terminal=${tokenTasks.terminalCount}, blockers=${tokenTasks.blockers.length}`,
      );
      const privateTasks = await scanPrivateTaskCutover(connection, {
        targetClaimsPrivateReadiness: false,
      });
      info(
        `${stage}: private_task_release=${privateTasks.releaseState}, ` +
          `nonterminal=${privateTasks.nonterminalTaskCount}, ` +
          `manual_validation_sentinel=${privateTasks.manualValidationSentinelCount}, ` +
          `real_private_nonterminal=${privateTasks.privateTaskCount}, ` +
          `real_private_terminal=${privateTasks.terminalPrivateTaskCount}, ` +
          `zk_config=${privateTasks.zkConfigState}, blockers=${privateTasks.blockers.length}`,
      );
      const hireProviders = await scanHireProviderBindings(connection);
      info(
        `${stage}: HireRecord=${hireProviders.accountCount}, bound=${hireProviders.boundCount}, ` +
          `legacy_fallback=${hireProviders.backfillCount}, ` +
          `nonterminal_fallback=${hireProviders.nonterminalBackfillCount}, ` +
          `terminal_fallback=${hireProviders.terminalBackfillCount}, ` +
          `listings=${hireProviders.listingCount}, ` +
          `capacity_exact=${hireProviders.exactCapacityListingCount}, ` +
          `capacity_undercounted=${hireProviders.undercountedListingCount}, ` +
          `capacity_overcounted=${hireProviders.overcountedListingCount}, ` +
          `open_jobs_deficit=${hireProviders.openJobsDeficitTotal}, ` +
          `open_jobs_excess=${hireProviders.openJobsExcessTotal}, ` +
          `blockers=${hireProviders.blockers.length}`,
      );
      const jobSpecBlocks = await scanActiveJobSpecBlocks(connection);
      info(
        `${stage}: active_job_specs=${jobSpecBlocks.canonicalJobSpecCount}, ` +
          `missing=${jobSpecBlocks.missingJobSpecCount}, ` +
          `missing_unassigned=${jobSpecBlocks.missingJobSpecUnassignedCount}, ` +
          `missing_with_workers=${jobSpecBlocks.missingJobSpecWithWorkersCount}, ` +
          `blocked=${jobSpecBlocks.blockedCount}, ` +
          `blocked_unassigned=${jobSpecBlocks.blockedUnassignedCount}, ` +
          `blocked_with_workers=${jobSpecBlocks.blockedWithWorkersCount}, ` +
          `cleared=${jobSpecBlocks.clearedCount}, blockers=${jobSpecBlocks.blockers.length}`,
      );
      const dependencies = await scanTaskDependencies(connection);
      info(
        `${stage}: dependent_tasks=${dependencies.dependentCount}, ` +
          `nonterminal_dependent=${dependencies.nonterminalDependentCount}, ` +
          `data=${dependencies.nonterminalDependencyTypeCounts.data}, ` +
          `ordering=${dependencies.nonterminalDependencyTypeCounts.ordering}, ` +
          `proof=${dependencies.nonterminalDependencyTypeCounts.proof}, ` +
          `unsafe_parent=${dependencies.unsafeParentCount}, ` +
          `unsafe_unassigned=${dependencies.unsafeUnassignedCount}, ` +
          `unsafe_obligated=${dependencies.unsafeObligatedCount}, ` +
          `dependent_bonds=${dependencies.dependentCompletionBondCount}, ` +
          `dependent_bond_principal=${dependencies.dependentCompletionBondPrincipal}, ` +
          `blockers=${dependencies.blockers.length}`,
      );
      const rejectFrozen = await scanRejectFrozenFees(connection);
      info(
        `${stage}: reject_frozen=${rejectFrozen.rejectFrozenCount}, ` +
          `task_stamped_fees=${rejectFrozen.taskStampedFeeCount}, ` +
          `legacy_hire_fees=${rejectFrozen.legacyHireFeeCount}, ` +
          `escrow_principal=${rejectFrozen.escrowPrincipal}, ` +
          `bonds=${rejectFrozen.completionBondCount}, ` +
          `bond_principal=${rejectFrozen.completionBondPrincipal}, ` +
          `blockers=${rejectFrozen.blockers.length}`,
      );
      const bidContracts = await scanBidContracts(connection);
      info(
        `${stage}: task_bids=${bidContracts.bidCount}, bid_books=${bidContracts.bookCount}, ` +
          `legacy_active=${bidContracts.legacyActiveCount}, ` +
          `bound_active=${bidContracts.boundActiveCount}, accepted=${bidContracts.acceptedCount}, ` +
          `open=${bidContracts.openBidCount}, ` +
          `open_bond_principal=${bidContracts.openBidBondPrincipal}, ` +
          `missing_specs=${bidContracts.missingJobSpecCount}, ` +
          `bond_principal=${bidContracts.bondPrincipal}, blockers=${bidContracts.blockers.length}`,
      );
      // Security-critical final order: eligibility must be proven closed before
      // CompletionBond inventory is captured. Do not move taskChildren above this.
      const { taskSettlement, taskChildren } =
        await scanStableRevision5CompletionBondCutover(
          connection,
          disputes,
          stage,
        );
      info(
        `${stage}: settlement_tasks=${taskSettlement.taskCount}, ` +
          `nonterminal=${taskSettlement.nonterminalCount}, ` +
          `rev4_bond_post_eligible=${taskSettlement.revision4BondPostEligibleTaskCount}, ` +
          `collaborative=${taskSettlement.collaborativeCount}, ` +
          `underfunded_collaborative=${taskSettlement.underfundedCollaborativeCount}, ` +
          `active_fee_tasks=${taskSettlement.activeFeeTaskCount}, ` +
          `legacy_hire_fallback=${taskSettlement.legacyHireFallbackCount}, ` +
          `payee_aliases=${taskSettlement.payeeAliasCount}, ` +
          `blockers=${taskSettlement.blockers.length}`,
      );
      info(
        `${stage}: task_children=${taskChildren.accountCount}, ` +
          `orphans=${taskChildren.orphanCount}, rent_only=${taskChildren.rentOnlyOrphanCount}, ` +
          `orphan_lamports=${taskChildren.orphanLamports}, ` +
          `submission_recoverable=${taskChildren.orphanSubmissionRecoverableCount}, ` +
          `submission_treasury_recovery=${taskChildren.orphanSubmissionTreasuryRecoveryCount}, ` +
          `submission_identity_unavailable=${taskChildren.orphanSubmissionUnavailableIdentityCount}, ` +
          `live_completion_bonds=${taskChildren.liveCompletionBondCount}, ` +
          `live_completion_bond_principal=${taskChildren.liveCompletionBondPrincipal}, ` +
          `blockers=${taskChildren.blockers.length}`,
      );
      assertRevision5CutoverResults(
        {
          delegation,
          skillRating,
          reputationStakes,
          disputes,
          validation,
          governance,
          taskChildren,
          tokenTasks,
          privateTasks,
          hireProviders,
          jobSpecBlocks,
          dependencies,
          rejectFrozen,
          bidContracts,
          taskSettlement,
        },
        stage,
      );

      return {
        delegation,
        skillRating,
        reputationStakes,
        disputes,
        validation,
        governance,
        taskChildren,
        tokenTasks,
        privateTasks,
        hireProviders,
        jobSpecBlocks,
        dependencies,
        rejectFrozen,
        bidContracts,
        taskSettlement,
      };
    },
    { minContextSlot },
  );
  return {
    cfg: pinned.cfg,
    contextSlot: pinned.contextSlot,
    finalizedPauseContextSlot: pinned.finalizedPauseContextSlot,
    ...pinned.result,
  };
}

// ------------------------------------------------------------------ preflight
async function preflight(args, connection) {
  banner("PREFLIGHT (runs in PLAN and EXECUTE)");
  const pf = { checks: [], peakSol: 0 };

  const genesisHash = await connection.getGenesisHash();
  if (genesisHash !== MAINNET_GENESIS) {
    die(`RPC genesis ${genesisHash} is not mainnet-beta (${MAINNET_GENESIS}). Refusing every deployment step.`);
  }
  info(`Cluster genesis    : ${genesisHash} (mainnet-beta)`);
  pf.checks.push("RPC genesis is mainnet-beta");

  // Loader custody is pinned by a committed, strictly parsed policy. The
  // authority account's owner/data shape is deliberately irrelevant: the live
  // Squads vault PDA can look like a zero-data System Program account.
  let upgradeAuthorityPolicy;
  let loaderSnapshot;
  try {
    upgradeAuthorityPolicy = loadReviewedUpgradeAuthorityPolicy();
    if (upgradeAuthorityPolicy.genesisHash !== genesisHash) {
      throw new Error(
        `policy genesis ${upgradeAuthorityPolicy.genesisHash} != RPC genesis ${genesisHash}`,
      );
    }
    if (upgradeAuthorityPolicy.programId !== PROGRAM_ID_STR) {
      throw new Error(
        `policy program ${upgradeAuthorityPolicy.programId} != ${PROGRAM_ID_STR}`,
      );
    }
    loaderSnapshot = await readProgramUpgradeAuthoritySnapshot(
      connection,
      upgradeAuthorityPolicy,
    );
  } catch (error) {
    die(`program upgrade-authority preflight failed: ${error.message}`);
  }
  const custody = upgradeAuthorityPolicy.allowedUpgradeAuthorities[0]?.custody;
  info(`Upgrade authority policy: ${upgradeAuthorityPolicy.policyPath}`);
  info(`    policy sha256  : ${upgradeAuthorityPolicy.policySha256}`);
  info(`    required state : ${upgradeAuthorityPolicy.requiredState}`);
  info(`    ProgramData    : ${loaderSnapshot.programData} (canonical)`);
  info(`    loader slot    : ${loaderSnapshot.programDataSlot}`);
  info(`    authority      : ${loaderSnapshot.authority ?? "immutable"}`);
  if (custody) {
    info(
      `    reviewed custody: ${custody.kind} ${custody.threshold}-of-${custody.memberCount} ` +
        `(multisig ${custody.multisig}, vault index ${custody.vaultIndex})`,
    );
  }
  pf.upgradeAuthorityPolicy = upgradeAuthorityPolicy;
  pf.loaderSnapshot = loaderSnapshot;
  pf.loaderAuthority = loaderSnapshot.authority;
  pf.checks.push(
    "canonical upgradeable-loader Program/ProgramData state matches the reviewed authority policy",
  );

  // Revision 5 removes legacy entry paths. Freeze those paths BEFORE taking any
  // cutover snapshot: otherwise a valid zero-account scan could race a new quorum
  // config or dispute created by the old binary. Exit paths remain available while
  // paused. Reputation delegation has no ProtocolConfig gate, so its predeploy
  // zero scan is only a snapshot and is repeated after disable-first deployment,
  // before the revision-5 stamp. The new permissionless retirement exit makes a
  // raced record deterministically purgeable without restoring reputation; it
  // still blocks the stamp until purged. This rail never pauses or unpauses on
  // behalf of the operator; the multisig must pause explicitly before PLAN/EXECUTE.
  const [protocolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    PROGRAM_ID,
  );
  const cutover = await verifyRevision5CutoverState(
    connection,
    protocolPda,
    "Predeploy cutover snapshot",
    { minContextSlot: loaderSnapshot.contextSlot },
  );
  const postCutoverLoader = await readVerifiedLoaderSnapshot(
    connection,
    pf,
    cutover.contextSlot,
  );
  try {
    assertImmediatePreUpgradeSnapshot(loaderSnapshot, postCutoverLoader);
  } catch (error) {
    die(`loader state changed during predeploy cutover scan: ${error.message}`);
  }
  loaderSnapshot = postCutoverLoader;
  pf.loaderSnapshot = postCutoverLoader;
  pf.loaderAuthority = postCutoverLoader.authority;
  const cfg = cutover.cfg;
  pf.checks.push("ProtocolConfig.protocol_paused=true before all cutover scans");
  pf.cfg = cfg;
  pf.protocolPda = protocolPda;
  pf.checks.push("delegation cutover snapshot passed (zero ReputationDelegation accounts)");
  pf.checks.push("skill-rating cutover passed (zero SkillRegistration, PurchaseRecord, and SkillRating accounts; stable under pause)");
  pf.checks.push(`ReputationStake custody passed (${cutover.reputationStakes.accountCount} account(s), ${cutover.reputationStakes.trackedStakedAmount} tracked principal lamports, ${cutover.reputationStakes.actualLamports} actual lamports, ${cutover.reputationStakes.requiredBackingLamports} required rent-plus-principal backing)`);
  pf.checks.push(`dispute liveness passed (${cutover.disputes.accountCount} dispute account(s), zero Active)`);
  pf.checks.push(`task-validation cutover passed (${cutover.validation.accountCount} canonical config(s), zero ValidatorQuorum)`);
  pf.checks.push(`governance cutover passed (${cutover.governance.accountCount} proposal(s), zero Active)`);
  pf.checks.push(`task-child cutover passed (${cutover.taskChildren.rentOnlyOrphanCount} rent-only orphan(s) inventoried, zero active/principal blockers, zero live CompletionBond principal)`);
  pf.checks.push(`token-task escrow cutover passed (${cutover.tokenTasks.liveCount} live checked, ${cutover.tokenTasks.terminalCount} terminal inventoried)`);
  pf.checks.push(`private-task release cutover passed (${cutover.privateTasks.manualValidationSentinelCount} manual-review sentinel task(s), zero real nonterminal private constraints, ZK ${cutover.privateTasks.zkConfigState})`);
  pf.checks.push(`hired-task provider/capacity binding passed (${cutover.hireProviders.boundCount} direct binding(s), ${cutover.hireProviders.backfillCount} canonical legacy fallback(s), ${cutover.hireProviders.listingCount} listing counter(s), zero undercount)`);
  pf.checks.push(`active job-spec moderation containment passed (${cutover.jobSpecBlocks.blockedUnassignedCount} blocked/unassigned, ${cutover.jobSpecBlocks.blockedWithWorkersCount} blocked/with-workers)`);
  pf.checks.push("dependency cutover passed (zero nonterminal Data/Ordering/Proof dependent Tasks; stable under pause)");
  pf.checks.push(`RejectFrozen fee/principal cutover passed (${cutover.rejectFrozen.rejectFrozenCount} frozen task(s), ${cutover.rejectFrozen.escrowPrincipal} escrow lamports, ${cutover.rejectFrozen.completionBondPrincipal} bond lamports)`);
  pf.checks.push(`bid-contract cutover passed (${cutover.bidContracts.openBidCount} open, ${cutover.bidContracts.acceptedCount} accepted, ${cutover.bidContracts.bondPrincipal} bonded lamports)`);
  pf.checks.push(`task-settlement cutover passed (${cutover.taskSettlement.collaborativeCount} collaborative, ${cutover.taskSettlement.activeFeeTaskCount} nonterminal fee-bearing, zero insolvent/aliased blockers, zero revision-4 bond-post-eligible Tasks)`);

  // (a) Artifacts exist and match independently reviewed, operator-supplied hashes.
  // Sizes and instruction counts are derived from those exact artifacts; no historical
  // release number is accepted as an authority.
  const soPath = expandHome(args.so || process.env.SO_PATH ||
    "programs/agenc-coordination/target/deploy/agenc_coordination.so");
  const soAbs = path.isAbsolute(soPath) ? soPath : path.join(ROOT, soPath);
  if (!existsSync(soAbs)) die(`(a) .so not found: ${soAbs}`);
  const soBytes = statSync(soAbs).size;
  const soSha = createHash("sha256").update(readFileSync(soAbs)).digest("hex");
  const expectedSoSha = requiredSha256(args, "expected-so-sha256", "EXPECTED_SO_SHA256", ".so approval");
  info(`(a) .so            : ${soAbs}`);
  info(`    bytes          : ${soBytes.toLocaleString()} (derived)`);
  info(`    sha256         : ${soSha}`);
  if (soSha !== expectedSoSha) {
    die(`(a) .so sha256 ${soSha} != approved ${expectedSoSha}. Refusing.`);
  }
  const capacity = assessProgramDataCapacity(
    soBytes,
    loaderSnapshot.payload.length,
  );
  info(`    live capacity   : ${capacity.capacityBytes.toLocaleString()} executable bytes`);
  info(`    capacity delta  : ${capacity.shortfallBytes === 0
    ? `${(capacity.capacityBytes - soBytes).toLocaleString()} bytes headroom`
    : `${capacity.shortfallBytes.toLocaleString()} bytes short`}`);
  if (capacity.shortfallBytes > 0) {
    die(
      `(a) approved .so (${soBytes} bytes) exceeds live ProgramData payload capacity ` +
        `(${capacity.capacityBytes} bytes) by ${capacity.shortfallBytes} bytes. ` +
        `Before the binary upgrade, separately review and execute a loader ` +
        `ExtendProgramChecked instruction through the pinned upgrade authority for ` +
        `at least ${capacity.extensionBytes} additional bytes, then re-run this preflight. ` +
        `This rail intentionally refuses implicit auto-extension.`,
    );
  }
  pf.programDataCapacityBytes = capacity.capacityBytes;
  pf.programDataHeadroomBytes = capacity.capacityBytes - soBytes;
  pf.checks.push(
    `(a) approved .so fits live ProgramData capacity with ${pf.programDataHeadroomBytes} byte(s) headroom`,
  );
  // IDL ix-count sanity (full surface, not canary).
  const idlPath = expandHome(args.idl || process.env.IDL_PATH || "target/idl/agenc_coordination.json");
  const idlAbs = path.isAbsolute(idlPath) ? idlPath : path.join(ROOT, idlPath);
  if (!existsSync(idlAbs)) die(`(a) IDL not found: ${idlAbs} (needed for step 6 publish).`);
  const idlBytes = readFileSync(idlAbs);
  const idlSha = createHash("sha256").update(idlBytes).digest("hex");
  const expectedIdlSha = requiredSha256(args, "expected-idl-sha256", "EXPECTED_IDL_SHA256", "IDL approval");
  if (idlSha !== expectedIdlSha) {
    die(`(a) IDL sha256 ${idlSha} != approved ${expectedIdlSha}. Refusing.`);
  }
  const idl = JSON.parse(idlBytes.toString("utf8"));
  if (idl.address !== PROGRAM_ID_STR) {
    die(`(a) IDL program address ${idl.address} != ${PROGRAM_ID_STR}. Refusing.`);
  }
  if (!Array.isArray(idl.instructions)) die("(a) IDL instructions is not an array. Refusing.");
  const ixCount = idl.instructions.length;
  const programSourcePath = path.join(
    ROOT,
    "programs/agenc-coordination/src/lib.rs",
  );
  const cargoManifestPath = path.join(
    ROOT,
    "programs/agenc-coordination/Cargo.toml",
  );
  let surfaces;
  try {
    surfaces = assertProgramSurfaceReleasePolicy(
      readFileSync(programSourcePath, "utf8"),
      readFileSync(cargoManifestPath, "utf8"),
    );
    assertIdlMatchesProgramInstructions(
      idl.instructions,
      surfaces.production,
    );
  } catch (error) {
    die(`(a) ${error instanceof Error ? error.message : String(error)}. Refusing.`);
  }
  const sourceInstructionNames = surfaces.production;
  info(`    IDL            : ${idlAbs}`);
  info(`    IDL sha256     : ${idlSha}`);
  info(`    instructions   : ${ixCount} (derived from approved IDL)`);
  info(`    Rust entrypoints: ${sourceInstructionNames.length} production / ${surfaces.privateZk.length} private-zk / ${surfaces.canary.length} canary (cfg-derived)`);
  if (!idl.instructions.some((i) => i.name === "initialize_bid_marketplace" || i.name === "initializeBidMarketplace")) {
    die("(a) IDL is missing initialize_bid_marketplace — not the full surface. Refusing.");
  }
  if (!idl.instructions.some((i) => i.name === "update_launch_controls" || i.name === "updateLaunchControls")) {
    die("(a) IDL is missing update_launch_controls — cannot stamp the reviewed surface. Refusing.");
  }
  pf.checks.push(`(a) .so + IDL match explicit approved hashes; private-zk is OFF and production Rust/IDL surfaces match at exactly ${ixCount} instructions`);
  pf.soAbs = soAbs; pf.idlAbs = idlAbs; pf.soBytes = soBytes;
  pf.soSha = soSha; pf.idlSha = idlSha; pf.ixCount = ixCount;
  pf.sourceInstructionNames = sourceInstructionNames;

  // Agave 3.0.13 computes the fresh upgrade Buffer's funding from
  // size_of_programdata(program_len), even though the Buffer allocation itself
  // has an eight-byte-smaller metadata prefix. Use the actual CLI debit for peak
  // funding, and the live ProgramData allocation for its permanent rent floor.
  const rentDataLengths = loaderRentDataLengths(
    soBytes,
    capacity.capacityBytes,
  );
  const programDataRent = await rentLamports(
    connection,
    rentDataLengths.programData,
  );
  const bufferAllocationRent = await rentLamports(
    connection,
    rentDataLengths.bufferAllocation,
  );
  const bufferFunding = await rentLamports(
    connection,
    rentDataLengths.cliBufferFunding,
  );
  info(`    live ProgramData rent (${rentDataLengths.programData.toLocaleString()} B): ${lamportsToSol(programDataRent).toFixed(8)} SOL (permanent floor)`);
  info(`    upgrade Buffer allocation rent (${rentDataLengths.bufferAllocation.toLocaleString()} B): ${lamportsToSol(bufferAllocationRent).toFixed(8)} SOL`);
  info(`    Agave CLI Buffer funding (${rentDataLengths.cliBufferFunding.toLocaleString()} B basis): ${lamportsToSol(bufferFunding).toFixed(8)} SOL (TEMPORARY except any ProgramData top-up)`);
  pf.programDataRent = programDataRent;
  pf.bufferAllocationRent = bufferAllocationRent;
  pf.bufferRent = bufferFunding;

  // (b) Protocol authority keypair. Loader authority is checked independently below;
  // the two are no longer assumed to be the same after the Squads migration.
  const uaPathRaw = args["protocol-authority"] || process.env.PROTOCOL_AUTHORITY ||
    args["upgrade-authority"] || process.env.UPGRADE_AUTHORITY;
  if (!uaPathRaw) die("(b) --protocol-authority (or PROTOCOL_AUTHORITY) is required (plain keypair path).");
  const uaClass = classifyKeyFile(uaPathRaw);
  if (!uaClass.ok) die(`(b) protocol-authority ${uaClass.vault ? "VAULT REFUSED" : "invalid"}: ${uaClass.reason}`);
  const uaPub = deriveAddress(uaClass.abs);
  info(`(b) protocol authority: ${uaClass.abs}`);
  info(`    pubkey         : ${uaPub}`);
  pf.uaAbs = uaClass.abs; pf.uaPub = uaPub;

  // Live ProtocolConfig (decode multisig owners, treasury, paused/mask, migration state).
  info(`\n    Live ProtocolConfig ${protocolPda.toBase58()}:`);
  info(`      dataLen=${cfg.dataLen} (${cfg.migrated ? "MIGRATED 351B" : "LEGACY 349B"})  authority=${cfg.authority}`);
  info(`      multisig=${cfg.multisigThreshold}/${cfg.multisigOwnersLen}  paused=${cfg.protocolPaused}  disabledTaskTypeMask=${cfg.disabledTaskTypeMask}  surfaceRevision=${cfg.surfaceRevision}`);
  info(`      owners: ${cfg.owners.join(", ")}`);
  if (cfg.authority !== uaPub) {
    die(`live ProtocolConfig.authority ${cfg.authority} != supplied protocol authority ${uaPub}. Refusing.`);
  }
  pf.checks.push("(b) supplied protocol-authority pubkey matches live ProtocolConfig.authority");
  const loader = pf.loaderSnapshot;
  pf.loaderAuthority = loader.authority;
  pf.canDirectDeploy = loader.authority === uaPub;
  pf.binaryAlreadyExact = isProgramBinaryExactForSnapshot(loader, pf);
  info(`    live loader authority: ${loader.authority ?? "immutable"}`);
  info(`    direct CLI deploy    : ${pf.canDirectDeploy ? "available with supplied signer" : "UNAVAILABLE (use the live authority governance path)"}`);
  info(`    approved binary live : ${pf.binaryAlreadyExact ? "YES (exact ProgramData bytes)" : "NO"}`);
  // Stamp mask override (validated here so PLAN dies on a bad value before any broadcast). The
  // child stamp step writes this instead of preserving the live mask; the orchestrator is the
  // sole authority and forwards it explicitly (see runStamp/buildChildEnv).
  const maskOverride = parseDisabledTaskTypeMaskOverride(args);
  if (maskOverride.provided && (cfg.disabledTaskTypeMask & ~TASK_TYPE_DISABLE_MASK) !== 0) {
    die(`live disabled_task_type_mask=${cfg.disabledTaskTypeMask} has unknown bits — refusing ` +
      `(even with an override, the live account is corrupt and the on-chain re-write would be rejected).`);
  }
  pf.maskOverride = maskOverride;

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
  info(`      sizes: 382B(legacy)=${sizes.old}  432B(batch-2)=${sizes.batch2}  ` +
    `466B(migrated)=${sizes.new}  invalid/other=${sizes.other}`);
  info(`      dispute worker cap=${DISPUTE_SAFE_MAX_WORKERS}  ` +
    `legacy max_workers>${DISPUTE_SAFE_MAX_WORKERS} inventory=${sizes.aboveDisputeSafeMaxWorkers.length}  ` +
    `active/disputed current_workers>${DISPUTE_SAFE_MAX_WORKERS} blockers=${sizes.disputeUnsafeActiveWorkers.length}`);
  if (sizes.other > 0) {
    die(`(e) ${sizes.other} Task account(s) have an invalid owner, discriminator, PDA, or size; ` +
      `refusing to deploy into an account-layout ambiguity.`);
  }
  if (sizes.incompatibleExclusive.length > 0) {
    const sample = sizes.incompatibleExclusive
      .slice(0, 10)
      .map((item) => `${item.pubkey}(status=${item.status},max_workers=${item.maxWorkers},size=${item.dataLen})`)
      .join(", ");
    die(`(e) ${sizes.incompatibleExclusive.length} nonterminal Exclusive Task account(s) have max_workers != 1; ` +
      `migration would preserve an invalid single-worker invariant. Sample: ${sample}`);
  }
  if (sizes.aboveDisputeSafeMaxWorkers.length > 0) {
    const sample = sizes.aboveDisputeSafeMaxWorkers
      .slice(0, 10)
      .map((item) => `${item.pubkey}(status=${item.status},max_workers=${item.maxWorkers},` +
        `current_workers=${item.currentWorkers},size=${item.dataLen})`)
      .join(", ");
    info(`      legacy wide-task sample: ${sample}`);
  }
  if (sizes.disputeUnsafeActiveWorkers.length > 0) {
    const sample = sizes.disputeUnsafeActiveWorkers
      .slice(0, 10)
      .map((item) => `${item.pubkey}(status=${item.status},max_workers=${item.maxWorkers},` +
        `current_workers=${item.currentWorkers},size=${item.dataLen})`)
      .join(", ");
    die(`(e) ${sizes.disputeUnsafeActiveWorkers.length} active/disputed Task account(s) have ` +
      `current_workers > ${DISPUTE_SAFE_MAX_WORKERS}; ResolveDispute with a maximum rationale ` +
      `cannot fit the legacy transaction packet. Settle/reduce these live worker sets before deployment. ` +
      `Sample: ${sample}`);
  }
  const expectedTasks = args["expected-tasks"] || process.env.EXPECTED_TASKS;
  if (expectedTasks && Number(expectedTasks) !== total) {
    die(`(e) --expected-tasks=${expectedTasks} but ${total} live tasks found. Re-verify (tasks may have been created on the live canary).`);
  }
  pf.checks.push(`(e) live Task count re-counted (${total}); EXPECTED_TASKS surfaced for the sweep`);
  pf.checks.push(`(e) dispute-safe worker cap checked (${sizes.aboveDisputeSafeMaxWorkers.length} legacy max_workers>${DISPUTE_SAFE_MAX_WORKERS} inventoried, zero active/disputed current_workers>${DISPUTE_SAFE_MAX_WORKERS})`);
  pf.taskCount = total; pf.taskSizes = sizes;

  // (f) ZK activation is release-disabled. No image-id input may be interpreted
  // as readiness, and the child rail never constructs an init/rotation instruction.
  try {
    assertPrivateTaskReleaseDisabled({
      zkImageId: args["zk-image-id"] || process.env.ZK_IMAGE_ID_HEX,
      privateTasksReady: process.env.PRIVATE_TASKS_READY === "1",
    });
  } catch (error) {
    die(`(f) ${error instanceof Error ? error.message : String(error)}`);
  }
  info(`\n(f) ZK private tasks : DISABLED/DEFERRED — no ZkConfig init or rotation will be constructed`);
  pf.checks.push("(f) ZK activation unconditionally disabled/deferred; image-id readiness inputs refused");
  pf.privateTaskReleaseState = "disabled";

  // ----- SOL need: peak fresh-Buffer debit + migrate rent + fees -----
  const currentPdLamports = await currentProgramDataLamports(
    connection,
    pf.loaderSnapshot,
  );
  const deployPending = !pf.binaryAlreadyExact;
  const programDataTopUp = deployPending && pf.programDataRent > currentPdLamports
    ? pf.programDataRent - currentPdLamports
    : 0n;
  // Upgrade moves the already-counted Buffer balance into ProgramData as needed;
  // it does not make a second payer debit. If that Buffer cannot cover an
  // underfunded live allocation, the loader will reject the upgrade.
  if (programDataTopUp > pf.bufferRent) {
    die(
      `live ProgramData needs ${programDataTopUp} lamports to reach the rent floor for ` +
        `its ${pf.programDataCapacityBytes}-byte payload, but the Agave CLI Buffer carries ` +
        `only ${pf.bufferRent} lamports. Top up ProgramData separately and re-run.`,
    );
  }
  const [taskNewRent, taskOldRent, taskBatch2Rent, cfgNewRent, cfgOldRent] =
    await Promise.all([
      rentLamports(connection, SIZES.TASK_NEW),
      rentLamports(connection, SIZES.TASK_OLD),
      rentLamports(connection, SIZES.TASK_BATCH2),
      rentLamports(connection, SIZES.CFG_NEW),
      rentLamports(connection, SIZES.CFG_OLD),
    ]);
  const perTaskDelta = taskNewRent - taskOldRent;
  const perBatch2TaskDelta = taskNewRent - taskBatch2Rent;
  const cfgDelta = cfgNewRent - cfgOldRent;
  // Only un-migrated tasks/config still owe rent top-up.
  const migrateRentRemaining = perTaskDelta * BigInt(sizes.old) +
    perBatch2TaskDelta * BigInt(sizes.batch2) +
    (cfg.migrated ? 0n : cfgDelta);
  const migrateRentAll = perTaskDelta * BigInt(total) + cfgDelta; // full-sweep figure for reference
  const feeBudget = BigInt(Math.round(TX_FEE_BUDGET_SOL * 1e9));
  const bufferRentNeeded = deployPending ? pf.bufferRent : 0n;
  const peakLamports = bufferRentNeeded + migrateRentRemaining + feeBudget;
  const netPermanentLamports = programDataTopUp + migrateRentRemaining + feeBudget; // after buffer spill/refund

  info(`\n    SOL accounting (recomputed live):`);
  info(`      current ProgramData balance locked : ${lamportsToSol(currentPdLamports).toFixed(8)} SOL`);
  info(`      ProgramData rent top-up from Buffer : ${lamportsToSol(programDataTopUp).toFixed(8)} SOL (part of Buffer funding, not an extra debit)`);
  info(`      migrate rent remaining (un-migrated): ${lamportsToSol(migrateRentRemaining).toFixed(8)} SOL  (full-sweep would be ${lamportsToSol(migrateRentAll).toFixed(8)})`);
  info(`      tx-fee budget                       : ${TX_FEE_BUDGET_SOL.toFixed(8)} SOL`);
  info(`      Agave CLI Buffer funding needed     : ${lamportsToSol(bufferRentNeeded).toFixed(8)} SOL${deployPending ? "" : " (approved binary already live)"}`);
  info(`      PEAK need (Buffer + migrate + fees) : ${lamportsToSol(peakLamports).toFixed(8)} SOL`);
  info(`      NET permanent (after buffer refund): ${lamportsToSol(netPermanentLamports).toFixed(8)} SOL`);
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

async function currentProgramDataLamports(connection, expectedSnapshot) {
  const programData = new PublicKey(expectedSnapshot.programData);
  const response = await connection.getAccountInfoAndContext(programData, {
    commitment: "confirmed",
    minContextSlot: expectedSnapshot.contextSlot,
  });
  if (!response?.value) {
    throw new Error(`ProgramData ${programData.toBase58()} disappeared during preflight`);
  }
  if (response.context.slot < expectedSnapshot.contextSlot) {
    throw new Error("ProgramData balance RPC context regressed");
  }
  const account = response.value;
  if (
    !account.owner.equals(new PublicKey(expectedSnapshot.loaderProgramId)) ||
    account.executable ||
    account.data.length !==
      expectedSnapshot.metadataBytes + expectedSnapshot.payload.length ||
    createHash("sha256").update(account.data).digest("hex") !==
      expectedSnapshot.programDataAccountDataSha256
  ) {
    throw new Error(
      "ProgramData owner/layout/bytes changed before rent accounting; re-run preflight",
    );
  }
  if (!Number.isSafeInteger(account.lamports) || account.lamports < 0) {
    throw new Error("ProgramData lamport balance is invalid");
  }
  return BigInt(account.lamports);
}

// Read just the data length of each task via dataSlice (cheap). Bucket by 382/466/other.
async function sampleTaskSizes(connection, tasks) {
  let oldN = 0, batch2N = 0, newN = 0, other = 0;
  const incompatibleExclusive = [];
  const aboveDisputeSafeMaxWorkers = [];
  const disputeUnsafeActiveWorkers = [];
  // getMultipleAccountsInfo with dataSlice length 0 returns null data; we need the real len.
  // Use getProgramAccounts already-fetched pubkeys with a tiny slice to read length cheaply.
  const pubkeys = tasks.map((t) => new PublicKey(t.pubkey));
  const CHUNK = 100;
  for (let i = 0; i < pubkeys.length; i += CHUNK) {
    const chunk = pubkeys.slice(i, i + CHUNK);
    const infos = await connection.getMultipleAccountsInfo(chunk);
    for (let j = 0; j < infos.length; j++) {
      const ai = infos[j];
      if (!ai) { other++; continue; }
      if (!ai.owner.equals(PROGRAM_ID) || !ai.data.subarray(0, 8).equals(TASK_DISCRIMINATOR)) {
        other++;
        continue;
      }
      const taskId = ai.data.subarray(8, 40);
      const creator = ai.data.subarray(40, 72);
      const [expectedTask] = PublicKey.findProgramAddressSync(
        [Buffer.from("task"), creator, taskId],
        PROGRAM_ID,
      );
      if (!expectedTask.equals(chunk[j])) {
        other++;
        continue;
      }
      try {
        const compatibility = inspectTaskMigrationCompatibility(ai.data);
        if (ai.data.length === SIZES.TASK_OLD) oldN++;
        else if (ai.data.length === SIZES.TASK_BATCH2) batch2N++;
        else newN++;
        if (compatibility.incompatibleExclusive) {
          incompatibleExclusive.push({
            pubkey: chunk[j].toBase58(),
            status: compatibility.status,
            maxWorkers: compatibility.maxWorkers,
            dataLen: ai.data.length,
          });
        }
        if (compatibility.aboveDisputeSafeMaxWorkers) {
          aboveDisputeSafeMaxWorkers.push({
            pubkey: chunk[j].toBase58(),
            status: compatibility.status,
            maxWorkers: compatibility.maxWorkers,
            currentWorkers: compatibility.currentWorkers,
            dataLen: ai.data.length,
          });
        }
        if (compatibility.disputeUnsafeActiveWorkers) {
          disputeUnsafeActiveWorkers.push({
            pubkey: chunk[j].toBase58(),
            status: compatibility.status,
            maxWorkers: compatibility.maxWorkers,
            currentWorkers: compatibility.currentWorkers,
            dataLen: ai.data.length,
          });
        }
      } catch {
        other++;
      }
    }
  }
  return {
    old: oldN,
    batch2: batch2N,
    new: newN,
    other,
    incompatibleExclusive,
    aboveDisputeSafeMaxWorkers,
    disputeUnsafeActiveWorkers,
  };
}

// --------------------------------------------------------------- step planner
// Determine which steps are still NEEDED (resume detection) and enforce order.
async function planSteps(pf, connection, args) {
  const cfg = pf.cfg;
  const planningLoaderSnapshot = await readVerifiedLoaderSnapshot(
    connection,
    pf,
    pf.loaderSnapshot.contextSlot,
  );
  try {
    assertImmediatePreUpgradeSnapshot(
      pf.loaderSnapshot,
      planningLoaderSnapshot,
    );
  } catch (error) {
    die(`loader state changed during preflight planning: ${error.message}`);
  }
  const soUpToDate = isProgramBinaryExactForSnapshot(
    planningLoaderSnapshot,
    pf,
  );
  const sweepDone = cfg.migrated && pf.taskSizes.old === 0 &&
    pf.taskSizes.batch2 === 0 && pf.taskSizes.other === 0;
  const protocolMigrated = cfg.migrated;

  const [bidPda] = PublicKey.findProgramAddressSync([Buffer.from("bid_marketplace")], PROGRAM_ID);
  const [zkPda] = PublicKey.findProgramAddressSync([Buffer.from("zk_config")], PROGRAM_ID);
  const bidExists = !!(await connection.getAccountInfo(bidPda));
  const zkExists = !!(await connection.getAccountInfo(zkPda));
  const initDone = bidExists;
  const stampDone = cfg.surfaceRevision === SURFACE_REVISION_CURRENT;

  const idlAddress = await resolveIdlAddress();
  const idlExists = !!(await connection.getAccountInfo(idlAddress));

  return {
    deploy: { needed: !soUpToDate, done: soUpToDate, note: soUpToDate ? "approved binary bytes already live — no-op" : "DEPLOY the new full-surface binary" },
    sweep: { needed: !sweepDone, done: sweepDone, protocolMigrated,
      note: sweepDone ? "config 351B + all tasks 466B — sweep already complete"
        : `migrate ${protocolMigrated ? "(protocol done)" : "protocol"} + ` +
          `${pf.taskSizes.old + pf.taskSizes.batch2} un-migrated task(s)` },
    init: { needed: !initDone, done: initDone, bidExists, zkExists,
      note: initDone
        ? `BidMarketplaceConfig present; ZK disabled (${zkExists ? "legacy ZkConfig inventoried" : "ZkConfig absent"})`
        : `init bid_marketplace; verify moderation; keep ZK disabled (${zkExists ? "legacy ZkConfig inventoried" : "ZkConfig absent"})` },
    stamp: { needed: !stampDone, done: stampDone,
      note: stampDone ? `surface_revision already current (${SURFACE_REVISION_CURRENT})`
        : pf.maskOverride.provided
          ? `stamp surface_revision=${SURFACE_REVISION_CURRENT} (preserving paused=${cfg.protocolPaused}, mask ${cfg.disabledTaskTypeMask} -> ${pf.maskOverride.value}${pf.maskOverride.value === 0 ? " (ALL task types ENABLED)" : ""})`
          : `stamp surface_revision=${SURFACE_REVISION_CURRENT} (preserving paused=${cfg.protocolPaused}, mask=${cfg.disabledTaskTypeMask})` },
    // Always publish the approved IDL artifact. Account existence selects init vs
    // upgrade; it does NOT prove the stored IDL matches this binary.
    idl: { needed: true, done: false, idlExists, idlAddress: idlAddress.toBase58(),
      note: idlExists ? `anchor IDL account ${idlAddress.toBase58()} EXISTS -> use 'anchor idl upgrade'`
        : `anchor IDL account does NOT exist -> first publish is 'anchor idl init'` },
  };
}

function isProgramBinaryExactForSnapshot(snapshot, pf) {
  const local = readFileSync(pf.soAbs);
  const payload = snapshot.payload;
  if (payload.length < local.length) return false;
  if (!payload.subarray(0, local.length).equals(local)) return false;
  // Loader capacity may exceed the ELF. Exact equality means matching bytes followed
  // only by loader padding; size alone is never accepted as deployment proof.
  return payload.subarray(local.length).every((byte) => byte === 0);
}

async function readVerifiedLoaderSnapshot(connection, pf, minContextSlot) {
  try {
    return await readProgramUpgradeAuthoritySnapshot(
      connection,
      pf.upgradeAuthorityPolicy,
      { minContextSlot },
    );
  } catch (error) {
    die(`program upgrade-authority re-verification failed: ${error.message}`);
  }
}

async function isProgramBinaryUpToDate(connection, pf) {
  const snapshot = await readVerifiedLoaderSnapshot(
    connection,
    pf,
    pf.loaderSnapshot.contextSlot,
  );
  return isProgramBinaryExactForSnapshot(snapshot, pf);
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
    "  --no-auto-extend \\",
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
  argv.push("--no-auto-extend");
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
  env.IDL_PATH = pf.idlAbs;
  env.EXPECTED_IDL_SHA256 = pf.idlSha;
  env.TARGET_SURFACE_REVISION = String(SURFACE_REVISION_CURRENT);
  if (pf.cosignerAbs.length) env.COSIGNERS = pf.cosignerAbs.join(",");
  else delete env.COSIGNERS;
  // Wipe any inherited step-skip / ZK-readiness / mask env so the orchestrator — not the ambient shell —
  // is the sole authority on what each child step does. `extra` (set per phase below) is
  // the explicit, intended set of skips/overrides for that child invocation. DISABLED_TASK_TYPE_MASK
  // is wiped here and re-injected ONLY by the stamp phase (runStamp), so the validated orchestrator
  // value is what reaches the stamp child — never an ambient one, and never another child.
  for (const k of ["SKIP_BID_MARKETPLACE", "SKIP_ZK_CONFIG", "SKIP_MODERATION", "SKIP_STAMP",
    "SKIP_PROTOCOL", "ZK_IMAGE_ID_HEX", "MODERATION_AUTHORITY", "EXPECTED_TASKS",
    "PRIVATE_TASKS_READY", "DISABLED_TASK_TYPE_MASK"]) delete env[k];
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
  // Init-only: skip the stamp (that's our Step 5). ZK activation is not a step in
  // this release; the child prints its unconditional disabled/deferred status.
  const extra = { SKIP_STAMP: "1" };
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
  const extra = { SKIP_BID_MARKETPLACE: "1", SKIP_MODERATION: "1" };
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
  info(`  Verify: anchor idl fetch ${PROGRAM_ID_STR} --provider.cluster ${rpc}  (must match approved IDL SHA-256 ${pf.idlSha} and ${pf.ixCount} instructions)`);
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
  assertPinnedSolanaCli();

  const rpc = args.rpc || process.env.RPC_URL;
  if (!rpc) die("--rpc <url> (or RPC_URL) is required (mainnet RPC for read-only decode + the deploy).");
  const execute = !!args.execute;

  // Fail before any network access if an operator or ambient environment tries
  // to advertise private-task readiness. `--skip-zk-config` remains a harmless
  // compatibility no-op because disabled/deferred is now unconditional.
  try {
    assertPrivateTaskReleaseDisabled({
      zkImageId: args["zk-image-id"] || process.env.ZK_IMAGE_ID_HEX,
      privateTasksReady: process.env.PRIVATE_TASKS_READY === "1",
    });
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }

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

  try {
    assertSafeSelectedSteps(steps, plan, { execute });
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }

  if (steps.includes("deploy") && plan.deploy.needed && !pf.canDirectDeploy) {
    die(`The reviewed binary is not live, but the supplied ProtocolConfig signer (${pf.uaPub}) ` +
      `is not the live loader authority (${pf.loaderAuthority ?? "immutable"}). This program is ` +
      `governance-controlled; create/execute the upgrade through that authority (for mainnet: Squads), ` +
      `then re-run with --only sweep,init,stamp,idl. Refusing a fake direct deploy.`);
  }

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
    if (steps.includes("sweep") && plan.sweep.needed) {
      banner("PLAN VALIDATION — simulate the real migration sweep (no state committed)");
      runSweep(pf, args, false);
    }
    banner("PLAN MODE — exact commands that WOULD run (NOTHING broadcast)");
    if (steps.includes("deploy") && plan.deploy.needed) {
      info("\nStep 1 DEPLOY (binary first; FROZEN WINDOW opens the instant this lands):");
      printDeployCommand(pf, args);
    } else if (steps.includes("deploy")) info("\nStep 1 DEPLOY: already up-to-date (skip).");

    if (steps.includes("sweep")) {
      info("\nStep 2/3 SWEEP (migrate_protocol + migrate_task) — INVOKES scripts/mainnet-migrate-sweep.mjs:");
      info(`  RPC_URL=<rpc> AUTHORITY_KEYPAIR=${pf.uaAbs} ${pf.cosignerAbs.length ? `COSIGNERS=${pf.cosignerAbs.join(",")} ` : ""}EXPECTED_TASKS=${pf.taskCount} \\`);
      info(`    node scripts/mainnet-migrate-sweep.mjs${pf.cfg.migrated ? " --skip-protocol" : ""} [--execute]`);
      info(plan.sweep.needed
        ? "  (real realloc/rent simulations passed above; no state was committed)"
        : "  (sweep is already complete)");
    }
    if (steps.includes("init")) {
      info("\nStep 4 INIT (bid_marketplace + verify moderation; ZK disabled/deferred) — INVOKES scripts/mainnet-init-and-stamp.mjs (SKIP_STAMP=1):");
      info("  SKIP_STAMP=1 node scripts/mainnet-init-and-stamp.mjs [--execute]");
      info(`  ZK status: DISABLED/DEFERRED; ${plan.init.zkExists ? "legacy ZkConfig exists but is not readiness" : "ZkConfig absent"}; no init/rotation instruction constructed.`);
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
      info(`\nStep 5 STAMP surface_revision=${SURFACE_REVISION_CURRENT} (LAST mutating step) — INVOKES scripts/mainnet-init-and-stamp.mjs (init-skipped):`);
      const maskEnvShown = pf.maskOverride.provided ? `DISABLED_TASK_TYPE_MASK=${pf.maskOverride.value} ` : "";
      info(`  ${maskEnvShown}SKIP_BID_MARKETPLACE=1 SKIP_MODERATION=1 node scripts/mainnet-init-and-stamp.mjs [--execute]`);
      if (pf.maskOverride.provided) {
        info(`  (will preserve live protocol_paused=${pf.cfg.protocolPaused}; OVERRIDE disabled_task_type_mask ` +
          `${pf.cfg.disabledTaskTypeMask} -> ${pf.maskOverride.value}` +
          `${pf.maskOverride.value === 0 ? " (ALL task types ENABLED)" : ""})`);
      } else {
        info(`  (will preserve live protocol_paused=${pf.cfg.protocolPaused}, disabled_task_type_mask=${pf.cfg.disabledTaskTypeMask})`);
      }
    }
    if (steps.includes("idl")) {
      info(`\nStep 6 IDL publish (approved ${pf.ixCount}-instruction surface):`);
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
      // Re-take the full cutover snapshot immediately before invoking the loader.
      // This closes the human review/confirmation interval; the postdeploy scan
      // below remains mandatory because reputation delegation was ungated in the
      // old binary and could still race the upload itself.
      const immediatePreUpgradeLoader = await readVerifiedLoaderSnapshot(
        connection,
        pf,
        pf.loaderSnapshot.contextSlot,
      );
      try {
        assertImmediatePreUpgradeSnapshot(
          pf.loaderSnapshot,
          immediatePreUpgradeLoader,
        );
      } catch (error) {
        die(`immediate predeploy loader snapshot failed: ${error.message}`);
      }
      const immediateCutover = await verifyRevision5CutoverState(
        connection,
        pf.protocolPda,
        "Immediate predeploy rescan",
        { minContextSlot: immediatePreUpgradeLoader.contextSlot },
      );
      const immediatePreDeployLoader = await readVerifiedLoaderSnapshot(
        connection,
        pf,
        immediateCutover.contextSlot,
      );
      try {
        assertImmediatePreUpgradeSnapshot(
          immediatePreUpgradeLoader,
          immediatePreDeployLoader,
        );
      } catch (error) {
        die(`loader state changed during immediate predeploy scan: ${error.message}`);
      }
      info(
        `Immediate predeploy loader snapshot: context=${immediatePreDeployLoader.contextSlot} ` +
          `ProgramData slot=${immediatePreDeployLoader.programDataSlot} ` +
          `state=${immediatePreDeployLoader.stateDigest}`,
      );
      banner("!!! FROZEN WINDOW OPENS — the instant the deploy lands, any legacy-sized config/tasks " +
        `fail TYPED reads. Steps 2-3 run IMMEDIATELY with NO pause for ${pf.taskCount} task(s). !!!`);
      runDeploy(pf, args);
      const immediatePostUpgradeLoader = await readVerifiedLoaderSnapshot(
        connection,
        pf,
        immediatePreDeployLoader.contextSlot,
      );
      try {
        assertImmediatePostUpgradeSnapshot(
          immediatePreDeployLoader,
          immediatePostUpgradeLoader,
        );
        assertProgramDataCapacityUnchanged(
          immediatePreDeployLoader,
          immediatePostUpgradeLoader,
        );
      } catch (error) {
        die(`immediate postdeploy loader snapshot failed: ${error.message}`);
      }
      info(
        `Immediate postdeploy loader snapshot: context=${immediatePostUpgradeLoader.contextSlot} ` +
          `ProgramData slot=${immediatePostUpgradeLoader.programDataSlot} ` +
          `authority=${immediatePostUpgradeLoader.authority}`,
      );
      if (!isProgramBinaryExactForSnapshot(immediatePostUpgradeLoader, pf)) {
        die(`post-deploy ProgramData bytes do not exactly match approved .so ${pf.soSha}; refusing every migration/stamp step.`);
      }
      info(`Post-deploy byte verification passed: ${pf.soSha}`);
    } else info("\nStep 1 DEPLOY: binary already up-to-date — skipping.");
  }

  // Step 2/3 SWEEP (immediately after deploy — closes the freeze)
  if (steps.includes("sweep")) {
    if (plan.sweep.needed) { banner("Step 2/3 SWEEP — migrate_protocol + migrate_task (closing the freeze window)"); runSweep(pf, args, true); }
    else info("\nStep 2/3 SWEEP: already complete — skipping.");
  }

  // Step 4 INIT
  if (steps.includes("init")) {
    if (plan.init.needed) { banner("Step 4 INIT — bid_marketplace + verify moderation (ZK disabled/deferred)"); runInit(pf, args, true); }
    else info("\nStep 4 INIT: configs already present — skipping.");
  }

  // Step 5 STAMP (LAST mutating)
  if (steps.includes("stamp")) {
    if (plan.stamp.needed) {
      const prestampLoaderBefore = await readVerifiedLoaderSnapshot(
        connection,
        pf,
        pf.loaderSnapshot.contextSlot,
      );
      if (!isProgramBinaryExactForSnapshot(prestampLoaderBefore, pf)) {
        die("pre-stamp approved-binary verification failed; refusing revision-5 stamp.");
      }
      // Disable-first two-phase cutover: once the reviewed binary is live, new
      // delegations/quorum configs cannot enter. Re-scan before advertising rev5;
      // a delegation that raced the old upload has a permissionless, no-restore
      // retirement path, but blocks the stamp until that deterministic purge runs.
      const prestampCutover = await verifyRevision5CutoverState(
        connection,
        pf.protocolPda,
        "Postdeploy/prestamp rescan",
        { minContextSlot: prestampLoaderBefore.contextSlot },
      );
      const prestampLoaderAfter = await readVerifiedLoaderSnapshot(
        connection,
        pf,
        prestampCutover.contextSlot,
      );
      try {
        assertImmediatePreUpgradeSnapshot(
          prestampLoaderBefore,
          prestampLoaderAfter,
        );
      } catch (error) {
        die(`loader state changed during postdeploy/prestamp scan: ${error.message}`);
      }
      if (!isProgramBinaryExactForSnapshot(prestampLoaderAfter, pf)) {
        die("approved binary changed during postdeploy/prestamp scan; refusing revision-5 stamp.");
      }
      banner(`Step 5 STAMP — update_launch_controls -> surface_revision = ${SURFACE_REVISION_CURRENT} (LAST)`);
      runStamp(pf, args, true);
    }
    else info(`\nStep 5 STAMP: surface_revision already ${SURFACE_REVISION_CURRENT} — skipping.`);
  }

  // Step 6 IDL
  if (steps.includes("idl")) {
    banner(`Step 6 IDL — anchor idl ${plan.idl.idlExists ? "upgrade" : "init"} (approved ${pf.ixCount}-instruction surface)`);
    runIdl(pf, args, plan.idl);
  }

  banner("UPGRADE COMPLETE");
  info(`Verify: fetched IDL matches ${pf.idlSha} (${pf.ixCount} ix), surface_revision=${SURFACE_REVISION_CURRENT}, all tasks 466B, config 351B, BidMarketplaceConfig present, private-task release state DISABLED (ZkConfig presence is not readiness).`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((e) => die(e.stack || e.message || String(e)));
}
