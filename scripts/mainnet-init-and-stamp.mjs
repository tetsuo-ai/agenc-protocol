#!/usr/bin/env node
// Mainnet full-surface config init + surface_revision stamp (MAINNET_ROLLOUT_RUNBOOK §3 steps 4–5).
//
// Runs, IN ORDER, AFTER the binary deploy (step 1) and the migrate sweep (steps 2–3):
//   4. initialize_bid_marketplace   (creates BidMarketplaceConfig) — MULTISIG-gated
//   4. initialize_zk_config          (creates ZkConfig with the AUDITED mainnet image id) — single authority
//   4. configure_task_moderation     (verify/realign ModerationConfig authority) — single authority
//   5. update_launch_controls        (stamp surface_revision = FULL) — MULTISIG-gated  [LAST]
//
// The surface_revision stamp is LAST on purpose: advertising the full surface before the
// configs exist / tasks are migrated would point clients at not-yet-initialized state.
//
// SAFE BY DEFAULT: dry-run unless you pass --execute. Dry-run is read-only — it decodes the
// live ProtocolConfig + each target account, prints the exact plan + decoded current values,
// and SENDS NOTHING. It also refuses to proceed if the live state is unexpected.
//
// THIS SCRIPT NEVER READS, DECRYPTS, OR EMBEDS A KEY. It takes keypair FILE PATHS at runtime
// (env vars) and loads them only inside the Solana web3 keypair loader, exactly like
// mainnet-migrate-sweep.mjs. Encrypted *.vault.json files are NOT supported here — pass plain
// keypair JSON paths (or adapt to your signer); the human owns the keys.
//
// The binary deploy (step 1) and the on-chain IDL publish (step 6) are single CLI commands —
// see the runbook; they are NOT done here.
//
// USAGE (resolves deps from tests-integration/node_modules):
//   RPC_URL=https://your-mainnet-rpc \
//   AUTHORITY_KEYPAIR=/path/to/upgrade-authority.json \           # = ProtocolConfig.authority
//   COSIGNERS=/path/multisig-second.json,/path/multisig-third.json \  # in-program multisig co-signers (M-1 of them)
//   ZK_IMAGE_ID_HEX=<64-hex-char audited mainnet RISC-Zero image id> \  # REQUIRED for initialize_zk_config; NO DEFAULT
//   [MODERATION_AUTHORITY=<pubkey>] \   # only if you intend to (re)set the moderation attestor
//   [SKIP_BID_MARKETPLACE=1] [SKIP_ZK_CONFIG=1] [SKIP_MODERATION=1] [SKIP_STAMP=1] \
//   [DISABLED_TASK_TYPE_MASK=0] \   # stamp override: 0..15, set bit = DISABLED task type
//                                   # (1=Exclusive 2=Collaborative 4=Competitive 8=BidExclusive).
//                                   # 0 = enable ALL task types; UNSET = preserve the live mask.
//   [BID_MIN_BOND_LAMPORTS=...] [BID_CREATION_COOLDOWN_SECS=...] [BID_MAX_PER_24H=...] \
//   [BID_MAX_ACTIVE_PER_TASK=...] [BID_MAX_LIFETIME_SECS=...] [BID_NOSHOW_SLASH_BPS=...] \
//   node scripts/mainnet-init-and-stamp.mjs [--execute]
//
//   --execute   actually send the transactions (otherwise dry-run/plan only)
//
// REQUIRES the deployed binary to be the FULL surface (initialize_bid_marketplace /
// initialize_zk_config do not exist on the canary). Run AFTER step 1.

import { createRequire } from "module";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "tests-integration", "package.json"));
const { Connection, Keypair, PublicKey, Transaction, SystemProgram } = require("@solana/web3.js");
const anchor = require("@coral-xyz/anchor");

const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
const RPC_URL = process.env.RPC_URL;
const EXECUTE = process.argv.includes("--execute");

// SURFACE_REVISION_FULL — mirrors ProtocolConfig::SURFACE_REVISION_FULL (state.rs). Do not change
// without the on-chain constant.
const SURFACE_REVISION_FULL = 1;
// Allowed task-type bits (state.rs ProtocolConfig::TASK_TYPE_DISABLE_MASK = 0b0000_1111).
const TASK_TYPE_DISABLE_MASK = 0b0000_1111;

function die(msg) { console.error(`ERROR: ${msg}`); process.exit(1); }
function loadKeypair(p) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p.replace(/^~/, process.env.HOME), "utf8"))));
}
function envOrDie(name) { const v = process.env[name]; if (!v) die(`${name} is required.`); return v; }

if (!RPC_URL) die("RPC_URL is required (a mainnet RPC).");
if (!process.env.AUTHORITY_KEYPAIR) die("AUTHORITY_KEYPAIR is required (must equal ProtocolConfig.authority).");

const authority = loadKeypair(process.env.AUTHORITY_KEYPAIR);
const cosigners = (process.env.COSIGNERS || "")
  .split(",").map((s) => s.trim()).filter(Boolean).map(loadKeypair);
// All in-program multisig signers (authority + co-signers), deduped — passed as remaining
// accounts on the multisig-gated instructions. The program counts UNIQUE signer pubkeys that
// are present in this account set AND in ProtocolConfig.multisig_owners.
const signerKps = [authority, ...cosigners].filter(
  (kp, i, arr) => arr.findIndex((k) => k.publicKey.equals(kp.publicKey)) === i,
);
const signerMetas = signerKps.map((kp) => ({ pubkey: kp.publicKey, isSigner: true, isWritable: false }));

// REQUIRED, NO DEFAULT: the audited mainnet RISC-Zero image id (32 bytes / 64 hex chars). The
// program only rejects all-zero; a permissive/test image id is a fund-drain vector on
// complete_task_private. There is NO in-repo mainnet image id — it MUST come from the audited
// agenc-prover build. This script HARD-FAILS rather than defaulting to any value.
function parseZkImageId() {
  const hex = (process.env.ZK_IMAGE_ID_HEX || "").trim().replace(/^0x/i, "");
  if (!hex) {
    die("ZK_IMAGE_ID_HEX is required for initialize_zk_config (the AUDITED mainnet image id; " +
        "no default — supply the 64-hex-char id from the audited agenc-prover build). " +
        "Pass SKIP_ZK_CONFIG=1 only if you are intentionally deferring ZkConfig.");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) die(`ZK_IMAGE_ID_HEX must be exactly 64 hex chars (32 bytes); got ${hex.length} chars.`);
  const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
  if (bytes.every((b) => b === 0)) die("ZK_IMAGE_ID_HEX is all-zero — the program rejects this (InvalidImageId). Supply the real audited id.");
  return bytes;
}

// Parse the OPTIONAL DISABLED_TASK_TYPE_MASK stamp override. Returns null when unset (=>
// preserve the live mask), or a validated integer 0..15. Mirrors the on-chain validator
// validate_disabled_task_type_mask: the value must be a non-negative integer with NO bits
// outside TASK_TYPE_DISABLE_MASK (0b1111). HARD-FAILS on anything else (16, 99, -1, 1.5,
// "abc"), so the plan refuses an invalid mask before it can ever reach the chain.
//   bit 1=Exclusive  2=Collaborative  4=Competitive  8=BidExclusive  (SET bit = DISABLED).
//   0 = ALL task types enabled; 14 = only Exclusive enabled (the current live value).
function parseDisabledTaskTypeMaskOverride() {
  const raw = (process.env.DISABLED_TASK_TYPE_MASK ?? "").trim();
  if (raw === "") return null;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    die(`DISABLED_TASK_TYPE_MASK='${raw}' is not a non-negative integer. Valid: 0..15 ` +
        `(0=all task types enabled, 14=Exclusive only). Refusing.`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 255) {
    die(`DISABLED_TASK_TYPE_MASK='${raw}' is out of u8 range. Valid: 0..15. Refusing.`);
  }
  if ((n & ~TASK_TYPE_DISABLE_MASK) !== 0) {
    die(`DISABLED_TASK_TYPE_MASK=${n} has bits outside 0b1111 (TASK_TYPE_DISABLE_MASK) — ` +
        `the program's validate_disabled_task_type_mask would reject it on-chain. Valid: 0..15. Refusing.`);
  }
  return n;
}

const connection = new Connection(RPC_URL, "confirmed");
const idl = JSON.parse(readFileSync(path.join(ROOT, "artifacts/anchor/idl/agenc_coordination.json"), "utf8"));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(authority), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);

const [protocolPda] = PublicKey.findProgramAddressSync([Buffer.from("protocol")], PROGRAM_ID);
const [bidMarketplacePda] = PublicKey.findProgramAddressSync([Buffer.from("bid_marketplace")], PROGRAM_ID);
const [zkConfigPda] = PublicKey.findProgramAddressSync([Buffer.from("zk_config")], PROGRAM_ID);
const [moderationPda] = PublicKey.findProgramAddressSync([Buffer.from("moderation_config")], PROGRAM_ID);

async function sendIx(ix, label) {
  const tx = new Transaction().add(ix);
  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(...signerKps);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(sig, "confirmed");
  console.log(`  ✓ ${label} — ${sig}`);
  return sig;
}

// Decode the live ProtocolConfig (handles BOTH the 349B legacy and 351B migrated layouts).
async function readProtocolConfig() {
  const ai = await connection.getAccountInfo(protocolPda);
  if (!ai) die(`ProtocolConfig ${protocolPda.toBase58()} not found — wrong RPC/program?`);
  if (!ai.owner.equals(PROGRAM_ID)) die(`ProtocolConfig owner ${ai.owner.toBase58()} != program.`);
  const d = ai.data, base = 8;
  const authorityPk = new PublicKey(d.subarray(base + 0, base + 32));
  const multisigThreshold = d[base + 132];
  const multisigOwnersLen = d[base + 133];
  const protocolPaused = d[base + 179] !== 0;
  const disabledTaskTypeMask = d[base + 180];
  const owners = [];
  for (let i = 0; i < 5; i++) owners.push(new PublicKey(d.subarray(base + 181 + i * 32, base + 181 + i * 32 + 32)).toBase58());
  const migrated = d.length >= ProtocolConfigSizes.NEW;
  const surfaceRevision = migrated ? d.readUInt16LE(base + 341) : null;
  return { dataLen: d.length, authority: authorityPk, multisigThreshold, multisigOwnersLen,
           protocolPaused, disabledTaskTypeMask, owners: owners.slice(0, multisigOwnersLen), migrated, surfaceRevision };
}
const ProtocolConfigSizes = { OLD: 349, NEW: 351 };

async function main() {
  console.log(`Mode: ${EXECUTE ? "EXECUTE (will send transactions)" : "DRY-RUN (plan only, nothing sent)"}`);
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`Authority: ${authority.publicKey.toBase58()}  | multisig signers passed: ${signerKps.length}\n`);

  const cfg = await readProtocolConfig();
  console.log(`ProtocolConfig ${protocolPda.toBase58()}: dataLen=${cfg.dataLen} ` +
    `(${cfg.migrated ? "MIGRATED 351B" : "LEGACY 349B"}) multisig=${cfg.multisigThreshold}/${cfg.multisigOwnersLen} ` +
    `paused=${cfg.protocolPaused} disabledTaskTypeMask=${cfg.disabledTaskTypeMask} surfaceRevision=${cfg.surfaceRevision}`);
  console.log(`  owners: ${cfg.owners.join(", ")}`);

  // --- Preconditions ----------------------------------------------------------------------
  if (!authority.publicKey.equals(cfg.authority)) {
    die(`AUTHORITY_KEYPAIR (${authority.publicKey.toBase58()}) != ProtocolConfig.authority (${cfg.authority.toBase58()}).`);
  }
  // The surface_revision stamp (step 5) and the bid-marketplace init (step 4) are MULTISIG-gated:
  // they need >= multisigThreshold unique owner-signers. Verify the passed signers can satisfy it.
  const ownerSet = new Set(cfg.owners);
  const eligibleSigners = signerKps.filter((kp) => ownerSet.has(kp.publicKey.toBase58()));
  console.log(`  eligible multisig signers passed: ${eligibleSigners.length} of required ${cfg.multisigThreshold}`);
  const needMultisig = !process.env.SKIP_BID_MARKETPLACE || !process.env.SKIP_STAMP;
  if (needMultisig && eligibleSigners.length < cfg.multisigThreshold) {
    die(`multisig-gated steps need >= ${cfg.multisigThreshold} signers that are ProtocolConfig owners; ` +
        `only ${eligibleSigners.length} of the passed signers are owners. Add COSIGNERS=...`);
  }
  // surface_revision can only be stamped on the MIGRATED layout (update_launch_controls loads a
  // typed Account<ProtocolConfig> which rejects the 349B legacy account).
  if (!process.env.SKIP_STAMP && !cfg.migrated) {
    die("ProtocolConfig is still the LEGACY 349B layout — run the migrate sweep (migrate_protocol) " +
        "BEFORE stamping surface_revision. Re-run after migration, or pass SKIP_STAMP=1.");
  }

  // === Step 4a: initialize_bid_marketplace (MULTISIG-gated) ===============================
  if (process.env.SKIP_BID_MARKETPLACE) {
    console.log("\nStep 4a: skipped (SKIP_BID_MARKETPLACE).");
  } else {
    const existing = await connection.getAccountInfo(bidMarketplacePda);
    if (existing) {
      console.log(`\nStep 4a: BidMarketplaceConfig ${bidMarketplacePda.toBase58()} already EXISTS (len=${existing.data.length}) — skipping init.`);
    } else {
      // Conservative defaults; OVERRIDE via env for the real mainnet policy values.
      const minBidBondLamports = BigInt(process.env.BID_MIN_BOND_LAMPORTS || "1000000");       // 0.001 SOL
      const bidCreationCooldownSecs = BigInt(process.env.BID_CREATION_COOLDOWN_SECS || "60");
      const maxBidsPer24h = Number(process.env.BID_MAX_PER_24H || "50");
      const maxActiveBidsPerTask = Number(process.env.BID_MAX_ACTIVE_PER_TASK || "20");
      const maxBidLifetimeSecs = BigInt(process.env.BID_MAX_LIFETIME_SECS || "604800");          // 7 days
      const acceptedNoShowSlashBps = Number(process.env.BID_NOSHOW_SLASH_BPS || "1000");          // 10%
      console.log(`\nStep 4a: initialize_bid_marketplace (multisig) → ${bidMarketplacePda.toBase58()}`);
      console.log(`   minBidBondLamports=${minBidBondLamports} cooldown=${bidCreationCooldownSecs}s maxPer24h=${maxBidsPer24h} ` +
        `maxActivePerTask=${maxActiveBidsPerTask} maxLifetime=${maxBidLifetimeSecs}s noShowSlashBps=${acceptedNoShowSlashBps}`);
      const ix = await program.methods
        .initializeBidMarketplace(new anchor.BN(minBidBondLamports.toString()), new anchor.BN(bidCreationCooldownSecs.toString()),
          maxBidsPer24h, maxActiveBidsPerTask, new anchor.BN(maxBidLifetimeSecs.toString()), acceptedNoShowSlashBps)
        .accounts({ protocolConfig: protocolPda, bidMarketplace: bidMarketplacePda, authority: authority.publicKey, systemProgram: SystemProgram.programId })
        .remainingAccounts(signerMetas).instruction();
      if (EXECUTE) await sendIx(ix, "initialize_bid_marketplace"); else console.log("   (DRY-RUN: not sent)");
    }
  }

  // === Step 4b: initialize_zk_config (single authority; AUDITED image id REQUIRED) =========
  if (process.env.SKIP_ZK_CONFIG) {
    console.log("\nStep 4b: skipped (SKIP_ZK_CONFIG).");
  } else {
    const imageId = parseZkImageId(); // HARD-FAILS if missing/zero/wrong-length
    const existing = await connection.getAccountInfo(zkConfigPda);
    if (existing) {
      console.log(`\nStep 4b: ZkConfig ${zkConfigPda.toBase58()} already EXISTS (len=${existing.data.length}) — skipping init. ` +
        `(Rotate via update_zk_image_id, which is M-of-N multisig gated — not done here.)`);
    } else {
      console.log(`\nStep 4b: initialize_zk_config → ${zkConfigPda.toBase58()}`);
      console.log(`   active_image_id = ${Buffer.from(imageId).toString("hex")}`);
      const ix = await program.methods
        .initializeZkConfig([...imageId])
        .accounts({ protocolConfig: protocolPda, zkConfig: zkConfigPda, authority: authority.publicKey, systemProgram: SystemProgram.programId })
        .instruction(); // single authority signer — no remaining accounts
      if (EXECUTE) await sendIx(ix, "initialize_zk_config"); else console.log("   (DRY-RUN: not sent)");
    }
  }

  // === Step 4c: configure_task_moderation (single authority; verify/realign) ===============
  if (process.env.SKIP_MODERATION) {
    console.log("\nStep 4c: skipped (SKIP_MODERATION).");
  } else {
    const existing = await connection.getAccountInfo(moderationPda);
    let currentModAuth = null, currentEnabled = null;
    if (existing) {
      currentModAuth = new PublicKey(existing.data.subarray(8 + 32, 8 + 64)).toBase58();
      currentEnabled = existing.data[8 + 64] !== 0;
      console.log(`\nStep 4c: ModerationConfig ${moderationPda.toBase58()} EXISTS — moderation_authority=${currentModAuth} enabled=${currentEnabled}`);
    } else {
      console.log(`\nStep 4c: ModerationConfig ${moderationPda.toBase58()} DOES NOT EXIST.`);
    }
    if (!process.env.MODERATION_AUTHORITY) {
      console.log("   MODERATION_AUTHORITY not set → VERIFY-ONLY (no re-config). Confirm the value above is the intended mainnet attestor; " +
        "to change it, set MODERATION_AUTHORITY=<pubkey> and re-run.");
    } else {
      const modAuth = new PublicKey(process.env.MODERATION_AUTHORITY);
      const enabled = (process.env.MODERATION_ENABLED ?? "true") !== "false";
      if (existing && currentModAuth === modAuth.toBase58() && currentEnabled === enabled) {
        console.log(`   already matches MODERATION_AUTHORITY=${modAuth.toBase58()} enabled=${enabled} — skipping.`);
      } else {
        console.log(`   configure_task_moderation → moderation_authority=${modAuth.toBase58()} enabled=${enabled}`);
        const ix = await program.methods
          .configureTaskModeration(modAuth, enabled)
          .accounts({ protocolConfig: protocolPda, moderationConfig: moderationPda, authority: authority.publicKey, systemProgram: SystemProgram.programId })
          .instruction(); // single authority signer
        if (EXECUTE) await sendIx(ix, "configure_task_moderation"); else console.log("   (DRY-RUN: not sent)");
      }
    }
  }

  // === Step 5: stamp surface_revision = FULL (MULTISIG-gated) — LAST =======================
  if (process.env.SKIP_STAMP) {
    console.log("\nStep 5: skipped (SKIP_STAMP).");
  } else if (cfg.surfaceRevision === SURFACE_REVISION_FULL) {
    console.log(`\nStep 5: surface_revision already = FULL (${SURFACE_REVISION_FULL}) — nothing to stamp.`);
  } else {
    // CRITICAL: update_launch_controls also writes protocol_paused + disabled_task_type_mask.
    // The LIVE mask must always have only known bits — otherwise the live state itself is
    // corrupt and the on-chain validator (validate_disabled_task_type_mask) would reject any
    // re-write. Keep this guard even when overriding (defends against a corrupt live account).
    if ((cfg.disabledTaskTypeMask & ~TASK_TYPE_DISABLE_MASK) !== 0) {
      die(`live disabled_task_type_mask=${cfg.disabledTaskTypeMask} has unknown bits — refusing (would be rejected on-chain).`);
    }
    // DISABLED_TASK_TYPE_MASK override: when set, the stamp WRITES this value (enabling/disabling
    // task types as part of the rollout) instead of preserving the live mask. When unset, the live
    // mask is preserved (legacy behavior). Validate it the same way the program does
    // (validate_disabled_task_type_mask): integer 0..15, no bits outside 0b1111.
    const maskOverride = parseDisabledTaskTypeMaskOverride();
    const maskToWrite = maskOverride === null ? cfg.disabledTaskTypeMask : maskOverride;
    if (maskOverride === null) {
      console.log(`\nStep 5: update_launch_controls → stamp surface_revision=${SURFACE_REVISION_FULL} ` +
        `(preserving protocolPaused=${cfg.protocolPaused}, disabledTaskTypeMask=${cfg.disabledTaskTypeMask})`);
    } else {
      console.log(`\nStep 5: update_launch_controls → stamp surface_revision=${SURFACE_REVISION_FULL} ` +
        `(preserving protocolPaused=${cfg.protocolPaused}, OVERRIDING disabledTaskTypeMask ` +
        `${cfg.disabledTaskTypeMask} -> ${maskToWrite}${maskToWrite === 0 ? " (ALL task types ENABLED)" : ""})`);
    }
    const ix = await program.methods
      .updateLaunchControls(cfg.protocolPaused, maskToWrite, SURFACE_REVISION_FULL)
      .accounts({ protocolConfig: protocolPda, authority: authority.publicKey })
      .remainingAccounts(signerMetas).instruction();
    if (EXECUTE) await sendIx(ix, "update_launch_controls (surface stamp)"); else console.log("   (DRY-RUN: not sent)");
  }

  console.log(`\n${EXECUTE ? "Done." : "Dry-run complete. Re-run with --execute (funded authority + cosigners) to apply."}`);
  if (EXECUTE) console.log("Next: runbook step 6 — publish the on-chain IDL (anchor idl init, see runbook/spec).");
}

main().catch((e) => die(e.stack || e.message || String(e)));
