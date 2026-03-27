#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const knownSharedProgramId = "6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab";
const libRsPath = path.join(rootDir, "programs", "agenc-coordination", "src", "lib.rs");
const anchorTomlPath = path.join(rootDir, "Anchor.toml");
const sharedGeneratedIdlPath = path.join(
  rootDir,
  "packages",
  "protocol",
  "src",
  "generated",
  "agenc_coordination.json",
);
const defaultHarnessConfigPath = path.join(rootDir, "scripts", "marketplace-devnet.config.example.json");
const base58PublicKeyPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function usage() {
  console.log(
    [
      "Validation deployment preflight",
      "",
      "Usage:",
      "  node scripts/validation-deploy-preflight.mjs [options]",
      "",
      "Options:",
      "  --program-id <pubkey>         Intended validation program ID",
      "  --program-keypair <path>      Keypair file to derive the intended validation program ID from",
      "  --config <path>               Harness config to validate",
      "  --idl-path <path>             Validation IDL file to validate",
      "  --help                        Show this message",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const name = token.slice(2);
    if (name === "help") {
      options.help = true;
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }

    options[name] = value;
    index += 1;
  }

  return options;
}

function resolvePath(candidatePath) {
  return path.isAbsolute(candidatePath) ? candidatePath : path.join(rootDir, candidatePath);
}

async function exists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readUtf8(filePath) {
  return readFile(filePath, "utf8");
}

async function deriveProgramIdFromKeypair(programKeypairPath) {
  const resolvedKeypairPath = resolvePath(programKeypairPath);
  const { stdout } = await execFileAsync("solana", ["address", "-k", resolvedKeypairPath], {
    cwd: rootDir,
  });
  return {
    programId: stdout.trim(),
    resolvedKeypairPath,
  };
}

function extractDeclareId(source) {
  const match = source.match(/declare_id!\("([^"]+)"\);/);
  if (!match) {
    throw new Error(`Unable to find declare_id! in ${libRsPath}`);
  }
  return match[1];
}

function extractAnchorProgramId(anchorToml) {
  const match = anchorToml.match(
    /\[programs\.devnet\][\s\S]*?agenc_coordination\s*=\s*"([^"]+)"/,
  );
  if (!match) {
    throw new Error(`Unable to find [programs.devnet].agenc_coordination in ${anchorTomlPath}`);
  }
  return match[1];
}

function summarizeStatus(label, ok, detail) {
  console.log(`${ok ? "OK " : "ERR"} ${label}: ${detail}`);
}

function buildStepLines(intendedProgramId, programKeypairPath, idlPath, configPath) {
  const keypairArg = programKeypairPath ? ` --program-keypair ${programKeypairPath}` : "";
  const idlLine = idlPath
    ? `  5. Point the harness at ${idlPath} and program ID ${intendedProgramId}.`
    : "  5. Produce a validation IDL copy and point the harness at it.";
  const configLine = configPath
    ? `  6. Update ${configPath} so programId=${intendedProgramId}.`
    : "  6. Update the harness config with the validation program ID and IDL path.";

  return [
    "Safe deployment sequence after this preflight passes:",
    "  1. Update declare_id! and Anchor.toml together on an isolated validation branch/worktree.",
    "  2. Build the validation binary: anchor build -- --features validation-timings",
    "  3. Refresh artifacts only for the validation branch/worktree if you need a matching IDL copy.",
    `  4. Deploy with: anchor deploy -p agenc_coordination --provider.cluster devnet${keypairArg}`,
    idlLine,
    configLine,
    "  7. Initialize protocol, marketplace, and zk config with the validation spec values.",
    "  8. Only then run the Marketplace V2 readiness scenarios against the dedicated deployment.",
  ];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const [libRsSource, anchorTomlSource, sharedGeneratedIdl] = await Promise.all([
    readUtf8(libRsPath),
    readUtf8(anchorTomlPath),
    readJson(sharedGeneratedIdlPath),
  ]);

  const currentState = {
    declareId: extractDeclareId(libRsSource),
    anchorDevnetProgramId: extractAnchorProgramId(anchorTomlSource),
    sharedGeneratedIdlAddress: sharedGeneratedIdl.address ?? null,
  };

  const consistencyOk =
    currentState.declareId === currentState.anchorDevnetProgramId &&
    currentState.declareId === currentState.sharedGeneratedIdlAddress;

  console.log("Current worktree deployment surfaces");
  summarizeStatus("declare_id!", true, currentState.declareId);
  summarizeStatus("Anchor.toml devnet program", true, currentState.anchorDevnetProgramId);
  summarizeStatus("shared generated IDL address", true, currentState.sharedGeneratedIdlAddress);
  summarizeStatus(
    "shared surfaces aligned",
    consistencyOk,
    consistencyOk ? "all shared surfaces match" : "shared surfaces are already inconsistent",
  );
  console.log("");

  let intendedProgramId = options["program-id"] ?? null;
  let resolvedProgramKeypairPath = null;

  if (!intendedProgramId && options["program-keypair"]) {
    const derived = await deriveProgramIdFromKeypair(options["program-keypair"]);
    intendedProgramId = derived.programId;
    resolvedProgramKeypairPath = derived.resolvedKeypairPath;
  } else if (options["program-keypair"]) {
    resolvedProgramKeypairPath = resolvePath(options["program-keypair"]);
  }

  if (intendedProgramId && !base58PublicKeyPattern.test(intendedProgramId)) {
    throw new Error(`Invalid intended program ID: ${intendedProgramId}`);
  }

  const configPath = options.config ? resolvePath(options.config) : defaultHarnessConfigPath;
  const configExists = await exists(configPath);
  const harnessConfig = configExists ? await readJson(configPath) : null;
  const configuredProgramId = harnessConfig?.programId ?? null;
  const configuredIdlPath = harnessConfig?.idlPath ? resolvePath(harnessConfig.idlPath) : null;

  const explicitIdlPath = options["idl-path"] ? resolvePath(options["idl-path"]) : null;
  const validationIdlPath = explicitIdlPath ?? configuredIdlPath;
  let validationIdlAddress = null;
  if (validationIdlPath && (await exists(validationIdlPath))) {
    validationIdlAddress = (await readJson(validationIdlPath)).address ?? null;
  }

  if (!intendedProgramId) {
    console.log("No intended validation program ID provided.");
    console.log("Pass --program-id <pubkey> or --program-keypair <path> to activate blocking checks.");
    if (configExists) {
      summarizeStatus(
        "harness config",
        true,
        `${path.relative(rootDir, configPath)}${configuredProgramId ? ` (programId=${configuredProgramId})` : ""}`,
      );
    }
    return;
  }

  console.log("Validation target");
  summarizeStatus("intended validation program ID", true, intendedProgramId);
  if (resolvedProgramKeypairPath) {
    summarizeStatus("program keypair", true, resolvedProgramKeypairPath);
  }
  console.log("");

  const blockers = [];

  if (intendedProgramId === knownSharedProgramId) {
    blockers.push(
      `The intended validation program ID still matches the known shared program ID (${knownSharedProgramId}). Choose a new dedicated devnet program ID first.`,
    );
  }

  if (currentState.declareId !== intendedProgramId) {
    blockers.push(
      `declare_id! still points at ${currentState.declareId}. Update ${path.relative(
        rootDir,
        libRsPath,
      )} before any validation deploy.`,
    );
  }

  if (currentState.anchorDevnetProgramId !== intendedProgramId) {
    blockers.push(
      `Anchor.toml devnet program still points at ${currentState.anchorDevnetProgramId}. Update ${path.relative(
        rootDir,
        anchorTomlPath,
      )} before any validation deploy.`,
    );
  }

  if (!configExists) {
    blockers.push(`Harness config not found: ${configPath}`);
  } else if (configuredProgramId !== intendedProgramId) {
    blockers.push(
      `Harness config programId is ${configuredProgramId ?? "missing"}, expected ${intendedProgramId}.`,
    );
  }

  if (!validationIdlPath) {
    blockers.push("No validation IDL path provided via --idl-path or harness config idlPath.");
  } else if (!(await exists(validationIdlPath))) {
    blockers.push(`Validation IDL file does not exist: ${validationIdlPath}`);
  } else if (validationIdlAddress !== intendedProgramId) {
    blockers.push(
      `Validation IDL address is ${validationIdlAddress ?? "missing"}, expected ${intendedProgramId}.`,
    );
  }

  summarizeStatus(
    "shared declare_id moved",
    currentState.declareId === intendedProgramId,
    currentState.declareId,
  );
  summarizeStatus(
    "Anchor.toml devnet moved",
    currentState.anchorDevnetProgramId === intendedProgramId,
    currentState.anchorDevnetProgramId,
  );
  summarizeStatus(
    "harness config aligned",
    configExists && configuredProgramId === intendedProgramId,
    configExists
      ? `${path.relative(rootDir, configPath)} -> ${configuredProgramId ?? "missing"}`
      : `${path.relative(rootDir, configPath)} missing`,
  );
  summarizeStatus(
    "validation IDL aligned",
    Boolean(validationIdlPath) && validationIdlAddress === intendedProgramId,
    validationIdlPath
      ? `${path.relative(rootDir, validationIdlPath)} -> ${validationIdlAddress ?? "missing"}`
      : "missing",
  );
  console.log("");

  if (blockers.length > 0) {
    console.log("Preflight blocked. This is the safe outcome until all deployment surfaces agree.");
    for (const blocker of blockers) {
      console.log(`- ${blocker}`);
    }
    console.log("");
    for (const line of buildStepLines(
      intendedProgramId,
      resolvedProgramKeypairPath,
      validationIdlPath ? path.relative(rootDir, validationIdlPath) : null,
      configExists ? path.relative(rootDir, configPath) : null,
    )) {
      console.log(line);
    }
    process.exitCode = 1;
    return;
  }

  console.log("Preflight passed. The repo and harness are aligned for a dedicated validation deployment.");
  for (const line of buildStepLines(
    intendedProgramId,
    resolvedProgramKeypairPath,
    path.relative(rootDir, validationIdlPath),
    path.relative(rootDir, configPath),
  )) {
    console.log(line);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
