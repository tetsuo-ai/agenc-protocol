#!/usr/bin/env node

/**
 * Explorer metadata ceremony for HJsZ… .
 *
 * Solana Explorer reads two on-chain records the Squads upgrade-authority
 * vault must sign. This script prints (or emits) those two import blobs.
 * Blockhashes expire, so generate them at ceremony time — do not check them in.
 *
 *   node scripts/explorer-metadata.mjs              # operator card
 *   node scripts/explorer-metadata.mjs check        # validate security.json
 *   node scripts/explorer-metadata.mjs status       # live Explorer/OtterSec
 *   node scripts/explorer-metadata.mjs export-all   # print both export commands
 *   node scripts/explorer-metadata.mjs export-verify-pda --apply
 *   node scripts/explorer-metadata.mjs export-security --apply --keypair PATH
 *   node scripts/explorer-metadata.mjs submit-osec --apply
 */

import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

export const PROGRAM_ID = "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK";
export const PROGRAM_DATA = "E5w1ZkgC5ysWWBECHHzqsL4s6dDUoyWBnUMRptm5cEAw";
export const UPGRADE_AUTHORITY_VAULT = "Cj9dWtovMaAsHUkCFqsEeP7GAS86DouqFerh86Qxtnuf";
export const SQUADS_MULTISIG = "7VNP3JwLede86xgfG13pzyTKhTiuZkirJPxULrTce5DY";
export const REPO_URL = "https://github.com/tetsuo-ai/agenc-protocol";
export const REVISION_5_COMMIT = "08a3c87d4729e4a47c3db58cc61f2a8cee8a518d";
export const LIBRARY_NAME = "agenc_coordination";
export const MOUNT_PATH = "programs/agenc-coordination";
export const SECURITY_JSON_REL = "programs/agenc-coordination/security.json";
export const PVR_CONTACT =
  "link:https://github.com/tetsuo-ai/agenc-protocol/security/advisories/new";
export const FORBIDDEN_CONTACT_NEEDLES = Object.freeze([
  "security@agenc.tech",
  "email:security@agenc.tech",
]);
export const OSEC_STATUS_URL = `https://verify.osec.io/status/${PROGRAM_ID}`;
export const EXPLORER_URL = `https://explorer.solana.com/address/${PROGRAM_ID}`;
export const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

export function defaultSecurityJsonPath(root = REPO_ROOT) {
  return path.join(root, SECURITY_JSON_REL);
}

export function parseSecurityJson(raw) {
  const doc = JSON.parse(raw);
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new TypeError("security.json must be a JSON object");
  }
  return doc;
}

export function validateSecurityJson(doc) {
  const errors = [];
  const required = [
    "name",
    "description",
    "project_url",
    "contacts",
    "policy",
    "source_code",
    "source_revision",
    "expiry",
  ];
  for (const key of required) {
    if (doc[key] === undefined || doc[key] === "") {
      errors.push(`missing ${key}`);
    }
  }
  if (!Array.isArray(doc.contacts) || doc.contacts.length === 0) {
    errors.push("contacts must be a non-empty array");
  } else if (!doc.contacts.includes(PVR_CONTACT)) {
    errors.push(`contacts must include the confirmed PVR channel (${PVR_CONTACT})`);
  }

  const blob = JSON.stringify(doc).toLowerCase();
  for (const needle of FORBIDDEN_CONTACT_NEEDLES) {
    if (blob.includes(needle.toLowerCase())) {
      errors.push(
        `must not advertise ${needle} until SECURITY.md §1 mailbox delivery is verified`,
      );
    }
  }

  if (doc.source_revision && doc.source_revision !== REVISION_5_COMMIT) {
    errors.push(
      `source_revision must be the revision-5 candidate ${REVISION_5_COMMIT} (got ${doc.source_revision})`,
    );
  }

  if (errors.length > 0) {
    const err = new Error(`security.json failed checks:\n- ${errors.join("\n- ")}`);
    err.errors = errors;
    throw err;
  }
  return doc;
}

export function buildVerifyPdaExportArgs({
  rpc = DEFAULT_RPC,
  commit = REVISION_5_COMMIT,
} = {}) {
  return [
    "export-pda-tx",
    REPO_URL,
    "--program-id",
    PROGRAM_ID,
    "--uploader",
    UPGRADE_AUTHORITY_VAULT,
    "--commit-hash",
    commit,
    "--library-name",
    LIBRARY_NAME,
    "--mount-path",
    MOUNT_PATH,
    "--encoding",
    "base58",
    "--compute-unit-price",
    "0",
    "-u",
    rpc,
  ];
}

export function buildSubmitOsecArgs() {
  return [
    "remote",
    "submit-job",
    "--program-id",
    PROGRAM_ID,
    "--uploader",
    UPGRADE_AUTHORITY_VAULT,
  ];
}

export function buildSecurityCeremonyCommands({
  rpc = DEFAULT_RPC,
  keypair,
  closeBuffer,
  securityJsonPath = defaultSecurityJsonPath(),
} = {}) {
  const keypairArgs = keypair ? ["--keypair", keypair] : [];
  const rpcArgs = ["--rpc", rpc];
  const rentReturn = closeBuffer ?? "<OPERATOR_PUBKEY>";
  return {
    createBuffer: [
      "npx",
      "--yes",
      "@solana-program/program-metadata@latest",
      "create-buffer",
      securityJsonPath,
      ...rpcArgs,
      ...keypairArgs,
    ],
    setBufferAuthority: (buffer) => [
      "npx",
      "--yes",
      "@solana-program/program-metadata@latest",
      "set-buffer-authority",
      buffer,
      "--new-authority",
      UPGRADE_AUTHORITY_VAULT,
      ...rpcArgs,
      ...keypairArgs,
    ],
    exportWrite: (buffer) => [
      "npx",
      "--yes",
      "@solana-program/program-metadata@latest",
      "write",
      "security",
      PROGRAM_ID,
      "--buffer",
      buffer,
      "--export",
      UPGRADE_AUTHORITY_VAULT,
      "--export-encoding",
      "base58",
      "--close-buffer",
      rentReturn,
      ...rpcArgs,
    ],
    fetch: [
      "npx",
      "--yes",
      "@solana-program/program-metadata@latest",
      "fetch",
      "security",
      PROGRAM_ID,
      ...rpcArgs,
    ],
  };
}

export function renderOperatorCard() {
  const verifyArgs = buildVerifyPdaExportArgs();
  const osecArgs = buildSubmitOsecArgs();
  const security = buildSecurityCeremonyCommands({
    securityJsonPath: SECURITY_JSON_REL,
  });
  return [
    "AgenC Explorer ceremony — two Squads vault approvals, then one unsigned OtterSec submit.",
    "",
    `Program:           ${PROGRAM_ID}`,
    `ProgramData:       ${PROGRAM_DATA}`,
    `Upgrade authority: ${UPGRADE_AUTHORITY_VAULT}  (Squads vault)`,
    `Multisig:          ${SQUADS_MULTISIG}`,
    `Rev-5 commit:      ${REVISION_5_COMMIT}`,
    `Explorer:          ${EXPLORER_URL}`,
    `OtterSec:          ${OSEC_STATUS_URL}`,
    "",
    "This does not upgrade the program. It writes (1) canonical PMP security.txt and",
    "(2) an updated otter-verify PDA, then asks OtterSec to re-hash revision 5.",
    "",
    "0. Merge the PR that adds programs/agenc-coordination/security.json",
    "1. Fund the vault with ~0.01 SOL if it cannot pay otter-PDA rent.",
    "2. Have any funded operator keypair (~0.02 SOL) that is NOT the vault.",
    "",
    "3. Emit the security.txt Squads import (operator key pays the buffer):",
    `   ${security.createBuffer.join(" ")}`,
    "   # copy BUFFER from that output, then:",
    `   ${security.setBufferAuthority("<BUFFER>").join(" ")}`,
    `   ${security.exportWrite("<BUFFER>").join(" ")}`,
    "",
    "4. Emit the verified-build Squads import (no vault key needed):",
    `   solana-verify ${verifyArgs.join(" ")}`,
    "",
    "5. Squads → developers/txBuilder → Import as Base58 → vault index 0.",
    "   Drop any ComputeBudget instruction if vault execute rejects CPI.",
    "   2-of-3 Approve → Execute. Do this for BOTH blobs.",
    "",
    "6. After the verify PDA lands (no vault signature):",
    `   solana-verify ${osecArgs.join(" ")}`,
    "",
    "7. Confirm:",
    "   node scripts/explorer-metadata.mjs status",
    `   ${security.fetch.join(" ")}`,
    "   Hard-refresh Explorer Security + Verified Build tabs.",
    "",
    "Done when status prints securityPresent=true and osec.is_verified=true",
    "against commit 08a3c87… (not 097ded1).",
  ].join("\n");
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = new Map();
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--apply") {
      flags.set("apply", "1");
      continue;
    }
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags.set(key, "1");
      } else {
        flags.set(key, next);
        i += 1;
      }
      continue;
    }
    positionals.push(token);
  }
  return { command: positionals[0] ?? "print", flags };
}

async function loadCheckedSecurityJson(root = REPO_ROOT) {
  const filePath = defaultSecurityJsonPath(root);
  const raw = await readFile(filePath, "utf8");
  return validateSecurityJson(parseSecurityJson(raw));
}

async function runCommand(bin, args, { apply }) {
  const printable = [bin, ...args].join(" ");
  if (!apply) {
    process.stdout.write(`${printable}\n`);
    return { stdout: "", stderr: "" };
  }
  process.stderr.write(`$ ${printable}\n`);
  return execFile(bin, args, { maxBuffer: 10 * 1024 * 1024 });
}

async function fetchOsecStatus() {
  const response = await fetch(OSEC_STATUS_URL, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`OtterSec status HTTP ${response.status}`);
  }
  return response.json();
}

async function status() {
  const osec = await fetchOsecStatus();
  const staleCommit = osec.commit === "097ded12b03d27e8c89d50ad6ed8813493700129";
  const lines = [
    `osec.is_verified=${osec.is_verified}`,
    `osec.message=${osec.message ?? ""}`,
    `osec.commit=${osec.commit ?? ""}`,
    `osec.on_chain_hash=${osec.on_chain_hash ?? ""}`,
    `osec.executable_hash=${osec.executable_hash ?? ""}`,
    `osec.last_verified_at=${osec.last_verified_at ?? ""}`,
    `stale_revision_4_commit=${staleCommit}`,
    `want_commit=${REVISION_5_COMMIT}`,
  ];

  try {
    const { stdout } = await execFile(
      "npx",
      [
        "--yes",
        "@solana-program/program-metadata@latest",
        "fetch",
        "security",
        PROGRAM_ID,
        "--rpc",
        DEFAULT_RPC,
      ],
      { maxBuffer: 2 * 1024 * 1024 },
    );
    lines.push("securityPresent=true");
    lines.push(stdout.trim());
  } catch (error) {
    lines.push("securityPresent=false");
    lines.push(String(error.stderr || error.message || error).trim());
  }

  process.stdout.write(`${lines.join("\n")}\n`);
  return osec;
}

async function main(argv = process.argv) {
  const { command, flags } = parseArgs(argv);
  const apply = flags.get("apply") === "1";
  const rpc = flags.get("rpc") ?? DEFAULT_RPC;
  const keypair = flags.get("keypair");
  const closeBuffer = flags.get("close-buffer");
  const buffer = flags.get("buffer");

  switch (command) {
    case "print":
    case "help":
      process.stdout.write(`${renderOperatorCard()}\n`);
      return;
    case "check":
      await loadCheckedSecurityJson();
      process.stdout.write(`ok ${SECURITY_JSON_REL}\n`);
      return;
    case "status":
      await status();
      return;
    case "export-verify-pda": {
      const args = buildVerifyPdaExportArgs({ rpc });
      const { stdout, stderr } = await runCommand("solana-verify", args, { apply });
      if (apply) {
        if (stderr) process.stderr.write(stderr);
        process.stdout.write(stdout);
      }
      return;
    }
    case "export-security": {
      await loadCheckedSecurityJson();
      const cmds = buildSecurityCeremonyCommands({
        rpc,
        keypair,
        closeBuffer,
      });
      if (!apply) {
        process.stdout.write(`${cmds.createBuffer.join(" ")}\n`);
        process.stdout.write(`${cmds.setBufferAuthority("<BUFFER>").join(" ")}\n`);
        process.stdout.write(`${cmds.exportWrite("<BUFFER>").join(" ")}\n`);
        return;
      }
      if (!keypair) {
        throw new Error("export-security --apply requires --keypair <path>");
      }
      const created = await execFile(cmds.createBuffer[0], cmds.createBuffer.slice(1), {
        maxBuffer: 2 * 1024 * 1024,
      });
      process.stderr.write(created.stderr);
      process.stdout.write(created.stdout);
      const resolvedBuffer = buffer ?? extractBufferAddress(created.stdout + created.stderr);
      if (!resolvedBuffer) {
        throw new Error(
          "create-buffer succeeded but no buffer address was parsed; re-run with --buffer <ADDR>",
        );
      }
      const setAuth = cmds.setBufferAuthority(resolvedBuffer);
      const auth = await execFile(setAuth[0], setAuth.slice(1), {
        maxBuffer: 2 * 1024 * 1024,
      });
      process.stderr.write(auth.stderr);
      process.stdout.write(auth.stdout);
      const write = cmds.exportWrite(resolvedBuffer);
      const exported = await execFile(write[0], write.slice(1), {
        maxBuffer: 2 * 1024 * 1024,
      });
      process.stderr.write(exported.stderr);
      process.stdout.write(exported.stdout);
      return;
    }
    case "export-all":
      process.stdout.write(`${renderOperatorCard()}\n`);
      return;
    case "submit-osec": {
      const args = buildSubmitOsecArgs();
      const { stdout, stderr } = await runCommand("solana-verify", args, { apply });
      if (apply) {
        if (stderr) process.stderr.write(stderr);
        process.stdout.write(stdout);
      }
      return;
    }
    default:
      throw new Error(`unknown command ${command}`);
  }
}

export function extractBufferAddress(text) {
  const match = text.match(/\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/);
  return match?.[1] ?? null;
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  });
}
