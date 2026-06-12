#!/usr/bin/env node
// Mainnet migration sweep for the full-surface upgrade (MAINNET_ROLLOUT_RUNBOOK §3 steps 2–3).
//
// Runs `migrate_protocol` (ProtocolConfig 349→351) then `migrate_task` for EVERY live Task
// PDA (382→466), with count verification — the piece the runbook requires "scripted and
// ready to fire" between the binary deploy and the surface_revision stamp.
//
// SAFE BY DEFAULT: dry-run unless you pass --execute. Dry-run enumerates the tasks and
// prints the exact plan WITHOUT sending anything. It is read-only.
//
// Deploy the binary (runbook step 1) and stamp surface_revision + init configs + publish IDL
// (steps 4–6) are NOT done here — those are single commands; see the runbook.
//
// USAGE (resolves deps from tests-integration/node_modules):
//   RPC_URL=https://your-mainnet-rpc \
//   AUTHORITY_KEYPAIR=/path/to/upgrade-authority.json \
//   [COSIGNERS=/path/cosigner2.json,/path/cosigner3.json] \   # in-program multisig co-signers
//   [EXPECTED_TASKS=149] \
//   node scripts/mainnet-migrate-sweep.mjs [--execute] [--skip-protocol]
//
//   --execute        actually send the transactions (otherwise dry-run/plan only)
//   --skip-protocol  skip migrate_protocol (use if it already ran; migrate_task is order-independent)

import { createRequire } from "module";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Resolve @solana/web3.js, @coral-xyz/anchor, bs58 from the tests-integration workspace.
const require = createRequire(path.join(ROOT, "tests-integration", "package.json"));
const { Connection, Keypair, PublicKey, Transaction, SystemProgram } = require("@solana/web3.js");
const anchor = require("@coral-xyz/anchor");
const bs58 = require("bs58").default ?? require("bs58");

const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
const RPC_URL = process.env.RPC_URL;
const EXECUTE = process.argv.includes("--execute");
const SKIP_PROTOCOL = process.argv.includes("--skip-protocol");
const EXPECTED_TASKS = process.env.EXPECTED_TASKS ? Number(process.env.EXPECTED_TASKS) : null;

function die(msg) { console.error(`ERROR: ${msg}`); process.exit(1); }
function loadKeypair(p) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p.replace(/^~/, process.env.HOME), "utf8"))));
}

if (!RPC_URL) die("RPC_URL is required (a mainnet RPC that allows getProgramAccounts).");
if (!process.env.AUTHORITY_KEYPAIR) die("AUTHORITY_KEYPAIR is required.");

const authority = loadKeypair(process.env.AUTHORITY_KEYPAIR);
const cosigners = (process.env.COSIGNERS || "")
  .split(",").map((s) => s.trim()).filter(Boolean).map(loadKeypair);
// All in-program multisig signers (authority + co-signers), deduped, passed as remaining accounts.
const signerKps = [authority, ...cosigners].filter(
  (kp, i, arr) => arr.findIndex((k) => k.publicKey.equals(kp.publicKey)) === i,
);
const signerMetas = signerKps.map((kp) => ({ pubkey: kp.publicKey, isSigner: true, isWritable: false }));

const connection = new Connection(RPC_URL, "confirmed");
const idl = JSON.parse(readFileSync(path.join(ROOT, "artifacts/anchor/idl/agenc_coordination.json"), "utf8"));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(authority), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);

const [protocolPda] = PublicKey.findProgramAddressSync([Buffer.from("protocol")], PROGRAM_ID);

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

async function enumerateTasks() {
  // Anchor account discriminator for "Task" = sha256("account:Task")[0..8] — layout-independent,
  // so it catches 382B legacy tasks (verified == generated TASK_DISCRIMINATOR).
  const disc = createHash("sha256").update("account:Task").digest().subarray(0, 8);
  const accts = await connection.getProgramAccounts(PROGRAM_ID, {
    dataSlice: { offset: 0, length: 0 },
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc) } }],
  });
  return accts.map((a) => a.pubkey);
}

async function main() {
  console.log(`Mode: ${EXECUTE ? "EXECUTE (will send transactions)" : "DRY-RUN (plan only, nothing sent)"}`);
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`Authority: ${authority.publicKey.toBase58()}  | multisig signers: ${signerKps.length}`);
  console.log(`ProtocolConfig: ${protocolPda.toBase58()}\n`);

  const tasks = await enumerateTasks();
  console.log(`Found ${tasks.length} live Task account(s).`);
  if (EXPECTED_TASKS != null && tasks.length !== EXPECTED_TASKS) {
    die(`expected EXPECTED_TASKS=${EXPECTED_TASKS} but found ${tasks.length} — aborting (verify RPC + program).`);
  }

  // Step 2: migrate_protocol (realloc-only path, target_version == 1).
  if (!SKIP_PROTOCOL) {
    if (EXECUTE) {
      console.log("\nStep 2: migrate_protocol(1)…");
      await sendIx(
        await program.methods.migrateProtocol(1)
          .accounts({ protocolConfig: protocolPda, payer: authority.publicKey, authority: authority.publicKey, systemProgram: SystemProgram.programId })
          .remainingAccounts(signerMetas).instruction(),
        "migrate_protocol",
      );
    } else {
      console.log("\nStep 2 (DRY-RUN): would call migrate_protocol(1) on ProtocolConfig.");
    }
  } else {
    console.log("\nStep 2: skipped (--skip-protocol).");
  }

  // Step 3: migrate_task for every task. dry_run=true validates on-chain WITHOUT mutating.
  console.log(`\nStep 3: migrate_task for ${tasks.length} task(s)…`);
  let migrated = 0, failed = 0;
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const tag = `[${i + 1}/${tasks.length}] ${task.toBase58()}`;
    try {
      const ix = await program.methods.migrateTask(!EXECUTE) // dry_run = true unless executing
        .accounts({ protocolConfig: protocolPda, task, payer: authority.publicKey, authority: authority.publicKey, systemProgram: SystemProgram.programId })
        .remainingAccounts(signerMetas).instruction();
      if (EXECUTE) {
        await sendIx(ix, `migrate_task ${tag}`);
      } else {
        console.log(`  · ${tag} — planned (dry_run)`);
      }
      migrated++;
    } catch (e) {
      failed++;
      console.error(`  ✗ ${tag} — ${e.message || e}`);
    }
  }

  console.log(`\nSummary: ${migrated} ok, ${failed} failed, of ${tasks.length} task(s).`);
  if (failed > 0) die(`${failed} task(s) failed — re-run (migrate_task is idempotent) until all succeed.`);
  if (EXECUTE) {
    console.log(`\nVerify count migrated == ${tasks.length}. Then proceed to runbook steps 4–6 (init configs, stamp surface_revision LAST, publish IDL).`);
  } else {
    console.log(`\nDry-run complete. Re-run with --execute (and a funded authority) to perform the migration.`);
  }
}

main().catch((e) => die(e.stack || e.message || String(e)));
