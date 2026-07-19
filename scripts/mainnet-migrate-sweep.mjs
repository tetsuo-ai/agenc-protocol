#!/usr/bin/env node
// Mainnet migration sweep for the full-surface upgrade (runbook steps 2–3).
//
// Safety contract:
// - pinned AgenC program id + exact mainnet genesis (no override);
// - independently approved IDL hash, shared with mainnet-upgrade.mjs;
// - exact live ProtocolConfig authority/multisig verification;
// - exact expected Task count plus owner/discriminator/PDA/layout validation;
// - PLAN mode really simulates every still-needed migration on-chain;
// - EXECUTE verifies every post-image and the final account set.
//
// Usage:
//   RPC_URL=https://your-mainnet-rpc \
//   AUTHORITY_KEYPAIR=/path/to/protocol-authority.json \
//   COSIGNERS=/path/cosigner2.json,/path/cosigner3.json \
//   EXPECTED_TASKS=<count-from-reviewed-plan> \
//   IDL_PATH=target/idl/agenc_coordination.json \
//   EXPECTED_IDL_SHA256=<reviewed-64-hex-digest> \
//   node scripts/mainnet-migrate-sweep.mjs [--execute] [--skip-protocol]

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "tests-integration", "package.json"));
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} = require("@solana/web3.js");
const anchor = require("@coral-xyz/anchor");
const bs58 = require("bs58").default ?? require("bs58");

const PROGRAM_ID_STR = "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK";
const PROGRAM_ID = new PublicKey(PROGRAM_ID_STR);
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const SIZES = {
  CONFIG_LEGACY: 349,
  CONFIG_CURRENT: 351,
  TASK_LEGACY: 382,
  TASK_BATCH2: 432,
  TASK_CURRENT: 466,
};
const RPC_URL = process.env.RPC_URL;
const EXECUTE = process.argv.includes("--execute");
const SKIP_PROTOCOL = process.argv.includes("--skip-protocol");

function redactRpc(value) {
  return String(value).replace(
    /(?:https?|wss?):\/\/[^\s"']+/giu,
    "<redacted-rpc>",
  );
}

function die(message) {
  console.error(`ERROR: ${redactRpc(message)}`);
  process.exit(1);
}

function expandHome(filePath) {
  return filePath.replace(/^~(?=$|\/)/, process.env.HOME);
}

function loadKeypair(filePath) {
  const absolute = expandHome(filePath);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    die(`cannot read keypair ${absolute}: ${error instanceof Error ? error.message : error}`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    parsed.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  ) {
    die(`keypair ${absolute} must be a plain 64-byte JSON array; encrypted vault/object inputs are refused.`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

function parseExpectedTasks() {
  const raw = String(process.env.EXPECTED_TASKS ?? "").trim();
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    die("EXPECTED_TASKS is required and must be the exact non-negative count from the reviewed plan.");
  }
  const count = Number(raw);
  if (!Number.isSafeInteger(count)) {
    die(`EXPECTED_TASKS=${raw} exceeds JavaScript's safe integer range.`);
  }
  return count;
}

function loadApprovedIdl() {
  const rawPath = process.env.IDL_PATH || "target/idl/agenc_coordination.json";
  const idlPath = path.isAbsolute(rawPath) ? rawPath : path.join(ROOT, rawPath);
  if (!existsSync(idlPath)) die(`IDL_PATH does not exist: ${idlPath}`);
  const expectedHash = String(process.env.EXPECTED_IDL_SHA256 ?? "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) {
    die("EXPECTED_IDL_SHA256 is required and must be an independently reviewed 64-hex digest.");
  }
  const bytes = readFileSync(idlPath);
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== expectedHash) {
    die(`IDL sha256 ${actualHash} != approved ${expectedHash}. Refusing.`);
  }
  let idl;
  try {
    idl = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    die(`approved IDL is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (idl.address !== PROGRAM_ID_STR || !Array.isArray(idl.instructions)) {
    die(`approved IDL is not for AgenC program ${PROGRAM_ID_STR}.`);
  }
  const names = new Set(idl.instructions.map((instruction) => instruction.name));
  for (const required of ["migrate_protocol", "migrate_task"]) {
    if (!names.has(required)) die(`approved IDL is missing required instruction ${required}.`);
  }
  return { idl, idlPath, actualHash };
}

if (!RPC_URL) die("RPC_URL is required (a mainnet RPC that allows getProgramAccounts).");
if (process.env.PROGRAM_ID && process.env.PROGRAM_ID !== PROGRAM_ID_STR) {
  die(`PROGRAM_ID overrides are forbidden: this mainnet rail is pinned to ${PROGRAM_ID_STR}.`);
}
if (!process.env.AUTHORITY_KEYPAIR) {
  die("AUTHORITY_KEYPAIR is required and must equal ProtocolConfig.authority.");
}

const EXPECTED_TASKS = parseExpectedTasks();
const approvedIdl = loadApprovedIdl();
const authority = loadKeypair(process.env.AUTHORITY_KEYPAIR);
const cosigners = String(process.env.COSIGNERS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map(loadKeypair);
const signerKps = [authority, ...cosigners].filter(
  (keypair, index, all) =>
    all.findIndex((candidate) => candidate.publicKey.equals(keypair.publicKey)) ===
    index,
);
const signerMetas = signerKps.map((keypair) => ({
  pubkey: keypair.publicKey,
  isSigner: true,
  isWritable: false,
}));

const connection = new Connection(RPC_URL, "confirmed");
const provider = new anchor.AnchorProvider(
  connection,
  new anchor.Wallet(authority),
  { commitment: "confirmed" },
);
const program = new anchor.Program(approvedIdl.idl, provider);
const [protocolPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("protocol")],
  PROGRAM_ID,
);
const CONFIG_DISCRIMINATOR = createHash("sha256")
  .update("account:ProtocolConfig")
  .digest()
  .subarray(0, 8);
const TASK_DISCRIMINATOR = createHash("sha256")
  .update("account:Task")
  .digest()
  .subarray(0, 8);

async function readAndValidateProtocolConfig() {
  const account = await connection.getAccountInfo(protocolPda, "confirmed");
  if (!account) die(`ProtocolConfig ${protocolPda.toBase58()} does not exist.`);
  if (!account.owner.equals(PROGRAM_ID)) die("ProtocolConfig has the wrong owner.");
  if (
    account.data.length !== SIZES.CONFIG_LEGACY &&
    account.data.length !== SIZES.CONFIG_CURRENT
  ) {
    die(`ProtocolConfig size ${account.data.length} is neither ${SIZES.CONFIG_LEGACY} nor ${SIZES.CONFIG_CURRENT}.`);
  }
  if (!account.data.subarray(0, 8).equals(CONFIG_DISCRIMINATOR)) {
    die("ProtocolConfig discriminator mismatch.");
  }
  const base = 8;
  const configAuthority = new PublicKey(account.data.subarray(base, base + 32));
  const threshold = account.data[base + 132];
  const ownersLength = account.data[base + 133];
  if (ownersLength < 2 || ownersLength > 5 || threshold < 2 || threshold >= ownersLength) {
    die(`ProtocolConfig multisig metadata is invalid (${threshold}-of-${ownersLength}).`);
  }
  const owners = [];
  for (let index = 0; index < ownersLength; index++) {
    const start = base + 181 + index * 32;
    owners.push(new PublicKey(account.data.subarray(start, start + 32)).toBase58());
  }
  if (!configAuthority.equals(authority.publicKey)) {
    die(`AUTHORITY_KEYPAIR ${authority.publicKey.toBase58()} != ProtocolConfig.authority ${configAuthority.toBase58()}.`);
  }
  const ownerSet = new Set(owners);
  const eligible = signerKps.filter((keypair) =>
    ownerSet.has(keypair.publicKey.toBase58()),
  );
  if (eligible.length < threshold) {
    die(`only ${eligible.length} supplied unique signer(s) are ProtocolConfig owners; ${threshold} required.`);
  }
  return {
    dataLength: account.data.length,
    threshold,
    ownersLength,
    owners,
  };
}

function validateTaskAccount(pubkey, account) {
  if (!account.owner.equals(PROGRAM_ID)) {
    die(`Task ${pubkey.toBase58()} has the wrong owner.`);
  }
  if (!account.data.subarray(0, 8).equals(TASK_DISCRIMINATOR)) {
    die(`Task ${pubkey.toBase58()} has a discriminator mismatch.`);
  }
  if (
    account.data.length !== SIZES.TASK_LEGACY &&
    account.data.length !== SIZES.TASK_BATCH2 &&
    account.data.length !== SIZES.TASK_CURRENT
  ) {
    die(`Task ${pubkey.toBase58()} has unsupported size ${account.data.length}.`);
  }
  const taskId = account.data.subarray(8, 40);
  const creator = account.data.subarray(40, 72);
  const [expected] = PublicKey.findProgramAddressSync(
    [Buffer.from("task"), creator, taskId],
    PROGRAM_ID,
  );
  if (!expected.equals(pubkey)) {
    die(`Task ${pubkey.toBase58()} is not its canonical [task, creator, task_id] PDA.`);
  }
  return { pubkey, dataLength: account.data.length };
}

async function enumerateAndValidateTasks() {
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    commitment: "confirmed",
    filters: [
      { memcmp: { offset: 0, bytes: bs58.encode(TASK_DISCRIMINATOR) } },
    ],
  });
  if (accounts.length !== EXPECTED_TASKS) {
    die(`EXPECTED_TASKS=${EXPECTED_TASKS}, but mainnet currently has ${accounts.length}; account set changed or RPC/program is wrong.`);
  }
  return accounts
    .map(({ pubkey, account }) => validateTaskAccount(pubkey, account))
    .sort((left, right) =>
      left.pubkey.toBase58().localeCompare(right.pubkey.toBase58()),
    );
}

async function signedTransaction(instruction) {
  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: authority.publicKey,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }).add(instruction);
  transaction.sign(...signerKps);
  return { transaction, latest };
}

async function simulateInstruction(instruction, label) {
  const { transaction } = await signedTransaction(instruction);
  const result = await connection.simulateTransaction(transaction, {
    commitment: "confirmed",
    sigVerify: true,
  });
  if (result.value.err) {
    const logs = (result.value.logs ?? []).slice(-12).join(" | ");
    throw new Error(`${label} simulation failed: ${JSON.stringify(result.value.err)}${logs ? `; ${logs}` : ""}`);
  }
  console.log(`  ✓ ${label} — simulated successfully (no state committed)`);
}

async function sendInstruction(instruction, label) {
  const { transaction, latest } = await signedTransaction(instruction);
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
  });
  const confirmation = await connection.confirmTransaction(
    { signature, ...latest },
    "confirmed",
  );
  if (confirmation.value.err) {
    throw new Error(`${label} confirmation failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  console.log(`  ✓ ${label} — ${signature}`);
  return signature;
}

async function processInstruction(instruction, label) {
  if (EXECUTE) return sendInstruction(instruction, label);
  return simulateInstruction(instruction, label);
}

async function verifyTaskPostImage(task) {
  const account = await connection.getAccountInfo(task, "confirmed");
  if (!account) die(`post-migration Task ${task.toBase58()} disappeared.`);
  validateTaskAccount(task, account);
  if (account.data.length !== SIZES.TASK_CURRENT) {
    die(`post-migration Task ${task.toBase58()} is ${account.data.length}B, expected ${SIZES.TASK_CURRENT}B.`);
  }
}

async function main() {
  console.log(
    `Mode: ${EXECUTE ? "EXECUTE (will send transactions)" : "PLAN (simulates on-chain; commits nothing)"}`,
  );
  console.log(`Program: ${PROGRAM_ID_STR}`);
  console.log(
    `Approved IDL: ${approvedIdl.idlPath} | sha256=${approvedIdl.actualHash} | instructions=${approvedIdl.idl.instructions.length}`,
  );
  console.log(
    `Authority: ${authority.publicKey.toBase58()} | unique supplied signers: ${signerKps.length}`,
  );

  const genesis = await connection.getGenesisHash();
  if (genesis !== MAINNET_GENESIS) {
    die(`RPC genesis ${genesis} is not mainnet-beta ${MAINNET_GENESIS}; refusing every migration.`);
  }
  console.log(`Cluster genesis: ${genesis} (mainnet-beta)`);

  let config = await readAndValidateProtocolConfig();
  console.log(
    `ProtocolConfig ${protocolPda.toBase58()}: ${config.dataLength}B, multisig ${config.threshold}-of-${config.ownersLength}`,
  );
  const tasks = await enumerateAndValidateTasks();
  const counts = tasks.reduce(
    (result, task) => {
      result[task.dataLength] = (result[task.dataLength] ?? 0) + 1;
      return result;
    },
    {},
  );
  console.log(
    `Tasks: ${tasks.length} exact/canonical (${SIZES.TASK_LEGACY}B=${counts[SIZES.TASK_LEGACY] ?? 0}, ` +
      `${SIZES.TASK_BATCH2}B=${counts[SIZES.TASK_BATCH2] ?? 0}, ${SIZES.TASK_CURRENT}B=${counts[SIZES.TASK_CURRENT] ?? 0})`,
  );

  if (SKIP_PROTOCOL && config.dataLength !== SIZES.CONFIG_CURRENT) {
    die("--skip-protocol was supplied, but ProtocolConfig is not yet migrated.");
  }
  if (!SKIP_PROTOCOL && config.dataLength === SIZES.CONFIG_LEGACY) {
    console.log("\nStep 2: migrate_protocol(1)");
    const instruction = await program.methods
      .migrateProtocol(1)
      .accounts({
        protocolConfig: protocolPda,
        payer: authority.publicKey,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(signerMetas)
      .instruction();
    await processInstruction(instruction, "migrate_protocol");
    if (EXECUTE) {
      config = await readAndValidateProtocolConfig();
      if (config.dataLength !== SIZES.CONFIG_CURRENT) {
        die(`post-migration ProtocolConfig is ${config.dataLength}B, expected ${SIZES.CONFIG_CURRENT}B.`);
      }
    }
  } else {
    console.log(
      `\nStep 2: ${SKIP_PROTOCOL ? "explicitly skipped" : "already migrated"} (${config.dataLength}B).`,
    );
  }

  console.log("\nStep 3: migrate every legacy/intermediate Task");
  let processed = 0;
  let alreadyCurrent = 0;
  const failures = [];
  for (let index = 0; index < tasks.length; index++) {
    const task = tasks[index];
    const label = `migrate_task [${index + 1}/${tasks.length}] ${task.pubkey.toBase58()}`;
    if (task.dataLength === SIZES.TASK_CURRENT) {
      alreadyCurrent++;
      continue;
    }
    try {
      // PLAN uses RPC simulation of the REAL mutation (`dry_run=false`), so it
      // exercises realloc + rent transfer without committing the simulated state.
      const instruction = await program.methods
        .migrateTask(false)
        .accounts({
          protocolConfig: protocolPda,
          task: task.pubkey,
          payer: authority.publicKey,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(signerMetas)
        .instruction();
      await processInstruction(instruction, label);
      if (EXECUTE) await verifyTaskPostImage(task.pubkey);
      processed++;
    } catch (error) {
      const detail = redactRpc(error instanceof Error ? error.message : error);
      failures.push(`${task.pubkey.toBase58()}: ${detail}`);
      console.error(`  ✗ ${label} — ${detail}`);
    }
  }

  console.log(
    `\nSummary: ${processed} ${EXECUTE ? "migrated+verified" : "simulated"}, ${alreadyCurrent} already current, ${failures.length} failed.`,
  );
  if (failures.length > 0) {
    die(`${failures.length} Task migration(s) failed; fix and rerun (the sweep is idempotent).`);
  }

  if (EXECUTE) {
    const finalConfig = await readAndValidateProtocolConfig();
    const finalTasks = await enumerateAndValidateTasks();
    if (
      finalConfig.dataLength !== SIZES.CONFIG_CURRENT ||
      finalTasks.some((task) => task.dataLength !== SIZES.TASK_CURRENT)
    ) {
      die("final post-sweep verification found a legacy-sized config or Task; do not stamp the surface.");
    }
    console.log(
      `POST-SWEEP VERIFIED: config=${SIZES.CONFIG_CURRENT}B and all ${finalTasks.length} Tasks=${SIZES.TASK_CURRENT}B.`,
    );
  } else {
    console.log("PLAN VERIFIED: every required migration simulated successfully; no state was committed.");
  }
}

main().catch((error) =>
  die(error instanceof Error ? error.stack || error.message : String(error)),
);
