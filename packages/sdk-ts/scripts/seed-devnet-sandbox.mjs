#!/usr/bin/env node
// Seed the devnet sandbox (PLAN.md P2.4): register ~10 provider agents,
// create one Active ServiceListing each (categories spread across the
// LISTING_METADATA v1 taxonomy), attest every listing CLEAN, then REWRITE
// src/sandbox/fixtures.json with the real addresses (seeded: true).
//
// RUN THIS ONLY AFTER THE DEVNET FULL-SURFACE REDEPLOY (PLAN.md P2.2).
// As of 2026-06-09 the devnet program is ~3 weeks stale (pre-Batch-2/3), so
// running it now would fail or seed against the wrong surface. The script is
// committed ahead of the redeploy so the human/agent who deploys can seed in
// one command.
//
// Usage:
//   node scripts/seed-devnet-sandbox.mjs --keypair <funding+provider-authority.json>
//        [--rpc <url>]                    default https://api.devnet.solana.com
//        [--attestor-url <url>]           P2.3 auto-attestor (POST {kind,address,specHash})
//        [--moderator-keypair <path>]     fallback: record CLEAN moderation directly
//        [--env-file <path>]              .localnet/env.json convention; CLI flags
//                                         still override every env-file value
//        [--help]
//
// One of --attestor-url / --moderator-keypair is required (listings must be
// attested CLEAN or the fail-closed moderation gate blocks every hire); with
// --env-file those can come from the file's attestorUrl / keypairs.moderator,
// and --keypair from keypairs.seeder. When no --env-file is passed but the
// canonical <repo>/.localnet/env.json exists, it is picked up automatically.
//
// LOCALNET RULE: when the (env-file) cluster is "localnet", fixtures are
// written to the env file's fixturesPath (e.g. .localnet/fixtures.json) —
// src/sandbox/fixtures.json is RESERVED for the shipped public devnet
// fixtures and the script refuses to write it for a localnet run. Cluster
// "mainnet" is always refused.
//
// Idempotent: provider agent ids and listing ids are derived
// deterministically from the blueprint names, so a re-run detects existing
// PDAs, VERIFIES them against the blueprint + runner keypair (decoding the
// on-chain accounts and failing loudly on any drift — wrong authority,
// price, category, spec hash, or a non-Active listing), and only then skips
// the corresponding registrations/creations. Fixture values on skip paths
// are recorded FROM CHAIN, never assumed from the blueprint.
//
// Requires the built SDK: run `npm run build` in packages/sdk-ts first (the
// script imports ../dist/index.js so it needs no TS loader).
import { readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = path.resolve(SCRIPT_DIR, "../src/sandbox/fixtures.json");
const DIST_ENTRY = path.resolve(SCRIPT_DIR, "../dist/index.js");
const DEFAULT_RPC = "https://api.devnet.solana.com";
/** Canonical env-file location (repo root): picked up when it exists and no
 * --env-file was passed. */
const DEFAULT_ENV_FILE_PATH = path.resolve(
  SCRIPT_DIR,
  "../../../.localnet/env.json",
);
const ENV_FILE_CLUSTERS = ["localnet", "devnet", "mainnet"];

/**
 * The 10 sandbox providers. Names are stable identifiers: agent ids and
 * listing ids derive from them (sha256), which is what makes re-runs
 * idempotent. Categories deliberately spread across the LISTING_METADATA v1
 * taxonomy (validated against the SDK's LISTING_CATEGORIES at runtime).
 */
export const SANDBOX_PROVIDER_BLUEPRINTS = [
  { name: "Sandbox Codegen Co", category: "code-generation", tags: ["sandbox", "typescript"], priceLamports: 1_000_000, description: "Devnet sandbox provider: generates small code snippets." },
  { name: "Sandbox Translate", category: "translation", tags: ["sandbox", "en-fr"], priceLamports: 800_000, description: "Devnet sandbox provider: short EN<->FR translations." },
  { name: "Sandbox Labeler", category: "data-labeling", tags: ["sandbox", "images"], priceLamports: 500_000, description: "Devnet sandbox provider: labels tiny image batches." },
  { name: "Sandbox Research", category: "research", tags: ["sandbox", "summaries"], priceLamports: 1_500_000, description: "Devnet sandbox provider: one-page research summaries." },
  { name: "Sandbox Imagegen", category: "image-gen", tags: ["sandbox", "icons"], priceLamports: 1_200_000, description: "Devnet sandbox provider: generates placeholder icons." },
  { name: "Sandbox Analyst", category: "data-analysis", tags: ["sandbox", "csv"], priceLamports: 1_000_000, description: "Devnet sandbox provider: quick CSV breakdowns." },
  { name: "Sandbox Scraper", category: "scraping", tags: ["sandbox", "html"], priceLamports: 700_000, description: "Devnet sandbox provider: scrapes a single public page." },
  { name: "Sandbox Designer", category: "design", tags: ["sandbox", "logos"], priceLamports: 2_000_000, description: "Devnet sandbox provider: rough logo drafts." },
  { name: "Sandbox Writer", category: "writing", tags: ["sandbox", "blurbs"], priceLamports: 600_000, description: "Devnet sandbox provider: 100-word product blurbs." },
  { name: "Sandbox Automation", category: "automation", tags: ["sandbox", "workflows"], priceLamports: 1_800_000, description: "Devnet sandbox provider: tiny workflow scripts." },
];

/** Usage text for --help (and argument errors). */
export function usage() {
  return [
    "seed-devnet-sandbox — seed devnet (or a localnet stack) with the P2.4 sandbox fixtures",
    "",
    "USAGE",
    "  node scripts/seed-devnet-sandbox.mjs --keypair <path> [options]",
    "  node scripts/seed-devnet-sandbox.mjs --env-file <repo>/.localnet/env.json",
    "",
    "OPTIONS",
    "  --keypair <path>            Funding + provider authority keypair JSON",
    "                              (required unless the env file has keypairs.seeder)",
    `  --rpc <url>                 RPC endpoint (default ${DEFAULT_RPC},`,
    "                              or the env file's rpcUrl)",
    "  --attestor-url <url>        P2.3 sandbox auto-attestor endpoint",
    "  --moderator-keypair <path>  Moderation-authority keypair (fallback",
    "                              when no attestor is deployed yet)",
    "  --env-file <path>           JSON environment file (the .localnet/env.json",
    "                              convention: cluster/rpcUrl/attestorUrl/",
    "                              fixturesPath/keypairs). CLI flags override",
    "                              every env-file value. When omitted, the",
    "                              canonical <repo>/.localnet/env.json is picked",
    "                              up automatically if it exists. Relative paths",
    "                              inside the file resolve against the cwd.",
    "  --help                      Show this help and exit",
    "",
    "One of --attestor-url / --moderator-keypair (or the env file's attestorUrl /",
    "keypairs.moderator) is required for a real run. Run AFTER the program is",
    "deployed + config-initialized on the target cluster, and after",
    "`npm run build` (the script imports the built dist/).",
    "",
    "FIXTURES OUTPUT",
    "  cluster devnet (default): REWRITES src/sandbox/fixtures.json",
    "    (seeded: true) with the real devnet addresses; commit that file and",
    "    ship a release so SANDBOX_FIXTURES picks it up.",
    "  cluster localnet: writes the env file's fixturesPath (e.g.",
    "    .localnet/fixtures.json) instead — src/sandbox/fixtures.json is",
    "    RESERVED for the shipped public devnet fixtures and is refused.",
    "    Consume via AGENC_SANDBOX_FIXTURES=<fixturesPath>.",
    "  cluster mainnet: always refused.",
  ].join("\n");
}

/**
 * Pure argv parser (exported for unit tests). Returns collected errors
 * instead of throwing so --help can always win.
 *
 * `--rpc` defaults to null here; {@link mergeEnvFileConfig} applies the
 * env-file value and then DEFAULT_RPC, so an explicit flag always wins.
 * Required-argument errors are skipped when an env file is in play
 * (`--env-file` given, or `hasDefaultEnvFile` because the canonical
 * .localnet/env.json exists) — the merged config is validated by
 * {@link validateSeedConfig} instead.
 */
export function parseSeedArgs(argv, { hasDefaultEnvFile = false } = {}) {
  const args = {
    help: false,
    keypair: null,
    rpc: null,
    attestorUrl: null,
    moderatorKeypair: null,
    envFile: null,
    errors: [],
  };
  const takesValue = new Map([
    ["--keypair", "keypair"],
    ["--rpc", "rpc"],
    ["--attestor-url", "attestorUrl"],
    ["--moderator-keypair", "moderatorKeypair"],
    ["--env-file", "envFile"],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    const key = takesValue.get(arg);
    if (key === undefined) {
      args.errors.push(`unknown argument: ${arg}`);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      args.errors.push(`${arg} requires a value`);
      continue;
    }
    args[key] = value;
    i += 1;
  }
  if (!args.help && args.envFile === null && !hasDefaultEnvFile) {
    if (args.keypair === null) args.errors.push("--keypair is required");
    if (args.attestorUrl === null && args.moderatorKeypair === null) {
      args.errors.push(
        "one of --attestor-url / --moderator-keypair is required",
      );
    }
  }
  return args;
}

/**
 * Pure env-file parser (exported for unit tests): validates the
 * .localnet/env.json convention — { cluster, rpcUrl, rpcSubscriptionsUrl,
 * programId, attestorUrl, fixturesPath, keypairs: { authority, moderator,
 * seeder } | null }. Keypair PATHS only, never key material. Throws one
 * error listing every problem; never echoes unexpected values that could be
 * key bytes.
 */
export function parseEnvFile(raw, filePath) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`invalid env file ${filePath}: not valid JSON`);
  }
  const problems = [];
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    problems.push("not a JSON object");
  } else {
    if (!ENV_FILE_CLUSTERS.includes(parsed.cluster)) {
      problems.push(`cluster must be one of ${ENV_FILE_CLUSTERS.join(" | ")}`);
    }
    if (typeof parsed.rpcUrl !== "string" || parsed.rpcUrl === "") {
      problems.push("rpcUrl must be a non-empty string");
    }
    for (const key of ["attestorUrl", "fixturesPath"]) {
      const value = parsed[key];
      if (value !== null && value !== undefined && typeof value !== "string") {
        problems.push(`${key} must be a string or null`);
      }
    }
    const keypairs = parsed.keypairs;
    if (keypairs !== null && keypairs !== undefined) {
      if (typeof keypairs !== "object" || Array.isArray(keypairs)) {
        problems.push("keypairs must be an object of file paths or null");
      } else {
        for (const role of ["authority", "moderator", "seeder"]) {
          const value = keypairs[role];
          if (value !== undefined && typeof value !== "string") {
            problems.push(
              `keypairs.${role} must be a file path string (PATHS only, never key material)`,
            );
          }
        }
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `invalid env file ${filePath}: ${problems.join("; ")}`,
    );
  }
  return parsed;
}

/**
 * Pure config merge (exported for unit tests): CLI flags > env-file values >
 * defaults. `envFile` may be null (no env file in play).
 */
export function mergeEnvFileConfig({ args, envFile }) {
  const keypairs = envFile?.keypairs ?? null;
  return {
    cluster: envFile?.cluster ?? "devnet",
    rpc: args.rpc ?? envFile?.rpcUrl ?? DEFAULT_RPC,
    attestorUrl: args.attestorUrl ?? envFile?.attestorUrl ?? null,
    keypair: args.keypair ?? keypairs?.seeder ?? null,
    moderatorKeypair: args.moderatorKeypair ?? keypairs?.moderator ?? null,
    fixturesPath: envFile?.fixturesPath ?? null,
  };
}

/**
 * Pure merged-config validation (exported for unit tests). Mirrors the
 * argv-only required checks once env-file values are folded in, and enforces
 * the cluster rules: mainnet seeding is always refused, and a localnet run
 * must say where its fixtures go (never the shipped file).
 */
export function validateSeedConfig(config) {
  const errors = [];
  if (config.cluster === "mainnet") {
    errors.push(
      "refusing to seed cluster mainnet: the sandbox seeder is devnet/localnet-only",
    );
  }
  if (config.keypair === null) {
    errors.push(
      "a funding keypair is required: pass --keypair or set keypairs.seeder in the env file",
    );
  }
  if (config.attestorUrl === null && config.moderatorKeypair === null) {
    errors.push(
      "one of --attestor-url / --moderator-keypair is required (or attestorUrl / keypairs.moderator in the env file)",
    );
  }
  if (config.cluster === "localnet" && config.fixturesPath === null) {
    errors.push(
      "env cluster is localnet but fixturesPath is not set: localnet fixtures must go to e.g. .localnet/fixtures.json (src/sandbox/fixtures.json is reserved for the shipped public devnet fixtures)",
    );
  }
  return errors;
}

/**
 * Pure fixtures-output resolver (exported for unit tests): devnet writes the
 * shipped src/sandbox/fixtures.json (unless the env file points elsewhere);
 * localnet MUST write its own fixturesPath and is REFUSED the shipped path.
 * Returns an absolute path (relative inputs resolve against the cwd).
 */
export function resolveFixturesOutPath({
  cluster,
  fixturesPath,
  shippedPath = FIXTURES_PATH,
}) {
  if (cluster === "localnet") {
    if (fixturesPath === null || fixturesPath === undefined) {
      throw new Error(
        "env cluster is localnet but fixturesPath is not set — refusing to guess",
      );
    }
    const resolved = path.resolve(fixturesPath);
    if (resolved === path.resolve(shippedPath)) {
      throw new Error(
        `refusing to write ${shippedPath} for a localnet run: that file is ` +
          `reserved for the SHIPPED public devnet fixtures. Point fixturesPath ` +
          `at e.g. .localnet/fixtures.json instead.`,
      );
    }
    return resolved;
  }
  return path.resolve(fixturesPath ?? shippedPath);
}

/**
 * Pure fixtures-file shaper (exported for unit tests): turns seeded entries
 * into the exact JSON object written to the fixtures file (the shipped
 * src/sandbox/fixtures.json for devnet, the env file's fixturesPath for
 * localnet). Entries are sorted by name so re-runs produce byte-stable
 * output.
 */
export function buildFixturesFile({
  programId,
  seededAtSlot,
  entries,
  cluster = "devnet",
}) {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  return {
    seeded: true,
    cluster,
    programId,
    seededAtSlot,
    providers: sorted.map((e) => ({
      authority: e.authority,
      agent: e.agent,
      name: e.name,
    })),
    listings: sorted.map((e) => ({
      address: e.listing,
      provider: e.agent,
      name: e.name,
      category: e.category,
      priceLamports: e.priceLamports,
    })),
  };
}

/** Deterministic 32-byte id from a stable label (idempotency anchor). */
function deriveId32(label) {
  return new Uint8Array(createHash("sha256").update(label, "utf8").digest());
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Fixed keypair-file error: NEVER include parse-error text — V8's JSON.parse
 * message embeds a snippet of the input, which would leak leading secret-key
 * characters into console/CI logs if someone points --keypair at a raw
 * base58 private-key export. */
const KEYPAIR_FORMAT_ERROR =
  "expected a solana-keygen JSON array of 64 bytes";

/**
 * Pure keypair-file parser (exported for unit tests). Throws a fixed message
 * with NO echo of the file contents on any malformed input.
 */
export function parseKeypairBytes(raw, filePath) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`invalid keypair file ${filePath}: ${KEYPAIR_FORMAT_ERROR}`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    !parsed.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)
  ) {
    throw new Error(`invalid keypair file ${filePath}: ${KEYPAIR_FORMAT_ERROR}`);
  }
  return Uint8Array.from(parsed);
}

async function loadKeypairSigner(kit, filePath) {
  const bytes = parseKeypairBytes(await readFile(filePath, "utf8"), filePath);
  try {
    return await kit.createKeyPairSignerFromBytes(bytes);
  } catch {
    // Same fixed message: never propagate library error text for key material.
    throw new Error(`invalid keypair file ${filePath}: ${KEYPAIR_FORMAT_ERROR}`);
  }
}

/**
 * Atomic JSON write (exported for unit tests): write `${filePath}.tmp` then
 * rename() over the target, so an interrupt mid-write can never leave a
 * truncated fixtures.json (which is imported at SDK build time).
 */
export async function writeJsonAtomic(
  filePath,
  value,
  fsImpl = { writeFile, rename },
) {
  const tmpPath = `${filePath}.tmp`;
  await fsImpl.writeFile(tmpPath, JSON.stringify(value, null, 2) + "\n");
  await fsImpl.rename(tmpPath, filePath);
}

/**
 * Pure skip-path guard (exported for unit tests): an agent PDA that already
 * exists must belong to the runner keypair, otherwise re-running with a
 * different --keypair would publish fixtures whose `authority` does not match
 * the on-chain AgentRegistration. Returns the ON-CHAIN authority (the value
 * recorded in fixtures).
 */
export function verifyExistingAgent({
  name,
  agent,
  onChainAuthority,
  runnerAuthority,
}) {
  if (onChainAuthority !== runnerAuthority) {
    throw new Error(
      `agent for "${name}" (${agent}) already exists with a different ` +
        `authority: on-chain ${onChainAuthority}, runner keypair ` +
        `${runnerAuthority}. Re-run with the original provider-authority ` +
        `keypair, or change the blueprint name to derive fresh PDAs. ` +
        `Refusing to publish fixtures that misstate the on-chain authority.`,
    );
  }
  return onChainAuthority;
}

/**
 * Pure skip-path guard (exported for unit tests): a listing PDA that already
 * exists must match the blueprint (authority, price, Active state, category,
 * spec hash) or the published fixtures would advertise values the chain does
 * not hold (e.g. `expectedPrice` mismatches failing every hire, or a CLEAN
 * attestation recorded for a hash that is not the listing's spec_hash).
 * Returns the fixture fields FROM CHAIN.
 */
export function verifyExistingListing({ name, listing, onChain, expected }) {
  const mismatches = [];
  if (onChain.authority !== expected.authority) {
    mismatches.push(
      `authority: on-chain ${onChain.authority} != expected ${expected.authority}`,
    );
  }
  if (onChain.price !== BigInt(expected.priceLamports)) {
    mismatches.push(
      `price: on-chain ${onChain.price} lamports != blueprint ${expected.priceLamports}`,
    );
  }
  if (onChain.state !== expected.activeState) {
    mismatches.push(
      `state: on-chain ${onChain.state} is not Active (${expected.activeState})`,
    );
  }
  if (onChain.category !== expected.category) {
    mismatches.push(
      `category: on-chain "${onChain.category}" != blueprint "${expected.category}"`,
    );
  }
  if (onChain.specHashHex !== expected.specHashHex) {
    mismatches.push(
      `spec_hash: on-chain ${onChain.specHashHex} != derived ${expected.specHashHex}`,
    );
  }
  if (mismatches.length > 0) {
    throw new Error(
      `existing listing for "${name}" (${listing}) does not match the ` +
        `blueprint — refusing to publish fixtures:\n  ${mismatches.join("\n  ")}`,
    );
  }
  return {
    authority: onChain.authority,
    priceLamports: Number(onChain.price),
    category: onChain.category,
  };
}

/** task_moderation_status CLEAN (the only status the hire gate passes). */
const MODERATION_STATUS_CLEAN = 0;

/**
 * Pure skip-path guard (exported for unit tests): an existing
 * ListingModeration must be CLEAN, otherwise the listing stays blocked by the
 * fail-closed hire gate while the seed run reports success.
 */
export function verifyExistingModeration({ name, listing, onChainStatus }) {
  if (onChainStatus !== MODERATION_STATUS_CLEAN) {
    throw new Error(
      `existing ListingModeration for "${name}" (${listing}) has status ` +
        `${onChainStatus}, not CLEAN (${MODERATION_STATUS_CLEAN}) — the ` +
        `fail-closed hire gate would block this listing. Resolve the ` +
        `moderation record before seeding fixtures.`,
    );
  }
}

async function accountExists(rpc, address) {
  const { value } = await rpc
    .getAccountInfo(address, { commitment: "confirmed", encoding: "base64" })
    .send();
  return value !== null;
}

async function waitForAccount(rpc, address, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await accountExists(rpc, address)) return;
    if (Date.now() >= deadline) {
      throw new Error(`${what} (${address}) did not appear within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
}

async function main() {
  const args = parseSeedArgs(process.argv.slice(2), {
    hasDefaultEnvFile: existsSync(DEFAULT_ENV_FILE_PATH),
  });
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.errors.length > 0) {
    console.error(args.errors.map((e) => `error: ${e}`).join("\n"));
    console.error("\n" + usage());
    process.exitCode = 1;
    return;
  }

  // Env-file seam: --env-file wins; otherwise the canonical
  // <repo>/.localnet/env.json is picked up when it exists. CLI flags still
  // override every env-file value (mergeEnvFileConfig).
  let envFilePath = args.envFile;
  if (envFilePath === null && existsSync(DEFAULT_ENV_FILE_PATH)) {
    envFilePath = DEFAULT_ENV_FILE_PATH;
  }
  let envFile = null;
  if (envFilePath !== null) {
    envFile = parseEnvFile(await readFile(envFilePath, "utf8"), envFilePath);
    console.log(`env file: ${envFilePath} (cluster ${envFile.cluster})`);
  }
  const config = mergeEnvFileConfig({ args, envFile });
  const configErrors = validateSeedConfig(config);
  if (configErrors.length > 0) {
    console.error(configErrors.map((e) => `error: ${e}`).join("\n"));
    console.error("\n" + usage());
    process.exitCode = 1;
    return;
  }
  const fixturesOutPath = resolveFixturesOutPath({
    cluster: config.cluster,
    fixturesPath: config.fixturesPath,
  });

  // The SDK build + kit are imported lazily so `--help` works with no build.
  let sdk;
  try {
    sdk = await import(pathToFileURL(DIST_ENTRY).href);
  } catch (cause) {
    throw new Error(
      `could not import the built SDK at ${DIST_ENTRY} — run \`npm run build\` ` +
        `in packages/sdk-ts first`,
      { cause },
    );
  }
  const kit = await import("@solana/kit");
  const sandbox = await import(
    pathToFileURL(path.resolve(SCRIPT_DIR, "../dist/sandbox/index.js")).href
  );

  // Validate blueprint categories against the published taxonomy up front.
  for (const blueprint of SANDBOX_PROVIDER_BLUEPRINTS) {
    if (!sdk.values.isListingCategory(blueprint.category)) {
      throw new Error(
        `blueprint "${blueprint.name}" has non-canonical category ` +
          `"${blueprint.category}" (expected one of LISTING_CATEGORIES)`,
      );
    }
  }

  const rpc = kit.createSolanaRpc(config.rpc);
  const authority = await loadKeypairSigner(kit, config.keypair);
  const client = sdk.createMarketplaceClient({
    rpcUrl: config.rpc,
    signer: authority,
    // Single facade instructions consume ~15-35k CU; keep fees honest.
    computeUnitLimit: 200_000,
  });
  const moderator = config.moderatorKeypair
    ? await loadKeypairSigner(kit, config.moderatorKeypair)
    : null;
  const moderatorClient = moderator
    ? sdk.createMarketplaceClient({
        rpcUrl: config.rpc,
        signer: moderator,
        computeUnitLimit: 200_000,
      })
    : null;

  console.log(`seeding ${config.cluster} sandbox via ${config.rpc}`);
  console.log(`authority: ${authority.address}`);

  // register_agent enforces stake_amount >= ProtocolConfig.min_agent_stake
  // (InsufficientStake otherwise). The program floor in initialize_protocol is
  // 0.001 SOL, so a hard-coded 0n stake fails on any properly initialized
  // cluster — read the real minimum from chain and stake exactly that.
  const [protocolConfigPda] = await sdk.findProtocolConfigPda();
  const protocolConfig = await sdk.fetchMaybeProtocolConfig(
    rpc,
    protocolConfigPda,
    { commitment: "confirmed" },
  );
  if (!protocolConfig.exists) {
    throw new Error(
      `ProtocolConfig ${protocolConfigPda} not found via ${config.rpc} — the ` +
        `program is not initialized on this cluster. Localnet: run ` +
        `\`node scripts/localnet-up.mjs\` at the repo root first; devnet: ` +
        `follow scripts/devnet-deploy.md.`,
    );
  }
  const stakeAmount = protocolConfig.data.minAgentStake;
  console.log(`provider stake: ${stakeAmount} lamports (ProtocolConfig.min_agent_stake)`);

  // P1.2: moderation records are moderator-keyed. Both attestation paths
  // (HTTP attestor / direct moderator keypair) record as the GLOBAL
  // moderation authority, so read it once from the on-chain ModerationConfig
  // and derive the record PDAs with it.
  const [moderationConfigPda] = await sdk.findModerationConfigPda();
  const moderationConfig = await sdk.fetchMaybeModerationConfig(
    rpc,
    moderationConfigPda,
    { commitment: "confirmed" },
  );
  if (!moderationConfig.exists) {
    throw new Error(
      `ModerationConfig ${moderationConfigPda} not found via ${config.rpc} — ` +
        `the moderation gate is not configured on this cluster (localnet: ` +
        `re-run \`node scripts/localnet-up.mjs\`; devnet: follow ` +
        `scripts/devnet-deploy.md).`,
    );
  }
  const moderationAuthority = moderationConfig.data.moderationAuthority;
  if (moderator && moderator.address !== moderationAuthority) {
    throw new Error(
      `moderator keypair ${moderator.address} is not the on-chain global ` +
        `moderation authority (${moderationAuthority}) — its attestations ` +
        `would not pass the fail-closed hire gate. Use the right key ` +
        `(localnet: .localnet/keys/moderator.json).`,
    );
  }
  console.log(`moderation authority: ${moderationAuthority}`);

  const entries = [];
  for (const blueprint of SANDBOX_PROVIDER_BLUEPRINTS) {
    const agentId = deriveId32(`agenc-sandbox-provider:${blueprint.name}`);
    const listingId = deriveId32(`agenc-sandbox-listing:${blueprint.name}`);
    const [agent] = await sdk.findAgentPda({ agentId });

    const agentAccount = await sdk.fetchMaybeAgentRegistration(rpc, agent, {
      commitment: "confirmed",
    });
    let providerAuthority;
    if (agentAccount.exists) {
      // Skip path: record the ON-CHAIN authority, never the runner's (#4 —
      // a re-run with a different --keypair must not publish wrong fixtures).
      providerAuthority = verifyExistingAgent({
        name: blueprint.name,
        agent,
        onChainAuthority: agentAccount.data.authority,
        runnerAuthority: authority.address,
      });
      console.log(
        `agent exists, authority verified, skipping registration: ${blueprint.name} (${agent})`,
      );
    } else {
      await client.registerAgent({
        authority,
        agentId,
        capabilities: 1n,
        // RFC 2606 placeholder: sandbox providers are operator-driven and
        // have no live callback endpoint (never a dead real-looking host).
        endpoint: "https://example.invalid/sandbox/providers",
        metadataUri: null,
        stakeAmount,
      });
      providerAuthority = authority.address;
      console.log(`registered agent: ${blueprint.name} (${agent})`);
    }

    const [listing] = await sdk.facade.findListingPda({
      providerAgent: agent,
      listingId,
    });
    const specHash = deriveId32(`agenc-sandbox-spec:${blueprint.description}`);
    const listingAccount = await sdk.fetchMaybeServiceListing(rpc, listing, {
      commitment: "confirmed",
    });
    let fixtureFields;
    if (listingAccount.exists) {
      // Skip path: decode the existing listing and assert it matches the
      // blueprint (#8 — never publish blueprint values the chain doesn't
      // hold). Fixture fields come FROM CHAIN.
      fixtureFields = verifyExistingListing({
        name: blueprint.name,
        listing,
        onChain: {
          authority: listingAccount.data.authority,
          price: listingAccount.data.price,
          state: listingAccount.data.state,
          category: sdk.values.decodeListingCategory(
            Uint8Array.from(listingAccount.data.category),
          ),
          specHashHex: hex(listingAccount.data.specHash),
        },
        expected: {
          authority: providerAuthority,
          priceLamports: blueprint.priceLamports,
          activeState: sdk.ListingState.Active,
          category: blueprint.category,
          specHashHex: hex(specHash),
        },
      });
      console.log(
        `listing exists, verified against blueprint, skipping creation: ${blueprint.name} (${listing})`,
      );
    } else {
      await client.createServiceListing({
        providerAgent: agent,
        authority,
        listingId,
        name: blueprint.name.slice(0, 32),
        category: blueprint.category,
        tags: blueprint.tags,
        specHash,
        specUri: `agenc://job-spec/sha256/${hex(specHash)}`,
        price: BigInt(blueprint.priceLamports),
        priceMint: null,
        requiredCapabilities: 1n,
        defaultDeadlineSecs: 3600n,
        maxOpenJobs: 0,
        operator: null,
        operatorFeeBps: 0,
      });
      fixtureFields = {
        authority: providerAuthority,
        priceLamports: blueprint.priceLamports,
        category: blueprint.category,
      };
      console.log(`created listing: ${blueprint.name} (${listing})`);
    }

    // CLEAN moderation so the fail-closed hire gate passes. P1.2: the v2
    // record PDA is moderator-keyed — derive it with the global moderation
    // authority both attestation paths record as.
    const [listingModeration] = await sdk.facade.findListingModerationPda({
      listing,
      jobSpecHash: specHash,
      moderator: moderationAuthority,
    });
    const moderationAccount = await sdk.fetchMaybeListingModeration(
      rpc,
      listingModeration,
      { commitment: "confirmed" },
    );
    if (moderationAccount.exists) {
      // Skip path: an existing attestation must actually be CLEAN (#8 —
      // otherwise the listing is unhireable while the script reports success).
      verifyExistingModeration({
        name: blueprint.name,
        listing,
        onChainStatus: moderationAccount.data.status,
      });
      console.log(`listing already attested CLEAN: ${blueprint.name}`);
    } else if (config.attestorUrl) {
      await sandbox.requestSandboxAttestation({
        kind: "listing",
        address: listing,
        specHash,
        endpoint: config.attestorUrl,
      });
      await waitForAccount(rpc, listingModeration, "ListingModeration");
      console.log(`attested via attestor: ${blueprint.name}`);
    } else {
      await moderatorClient.send([
        await sdk.facade.recordListingModeration({
          moderator,
          listing,
          jobSpecHash: specHash,
          status: 0, // CLEAN
          riskScore: 0,
          categoryMask: 0n,
          policyHash: new Uint8Array(32),
          scannerHash: new Uint8Array(32),
          expiresAt: 0n,
        }),
      ]);
      console.log(`attested via moderator keypair: ${blueprint.name}`);
    }

    entries.push({
      name: blueprint.name,
      category: fixtureFields.category,
      priceLamports: fixtureFields.priceLamports,
      authority: fixtureFields.authority,
      agent,
      listing,
    });
  }

  const seededAtSlot = Number(await rpc.getSlot({ commitment: "confirmed" }).send());
  const fixtures = buildFixturesFile({
    programId: sdk.AGENC_COORDINATION_PROGRAM_ADDRESS,
    seededAtSlot,
    entries,
    cluster: config.cluster,
  });
  await writeJsonAtomic(fixturesOutPath, fixtures);

  console.log("");
  console.log(`wrote ${fixturesOutPath} (seeded: true, cluster ${config.cluster}, slot ${seededAtSlot})`);
  console.log(`seeded ${entries.length} providers + listings:`);
  for (const entry of entries) {
    console.log(`  ${entry.name.padEnd(24)} ${entry.category.padEnd(16)} listing ${entry.listing}`);
  }
  console.log("");
  if (config.cluster === "localnet") {
    console.log("next: export AGENC_SANDBOX_FIXTURES=" + fixturesOutPath);
    console.log("(plus the other AGENC_SANDBOX_* variables from the env file)");
    console.log("so the SDK environment seam picks up the localnet fixtures.");
  } else {
    console.log("next: commit src/sandbox/fixtures.json and ship an SDK release");
    console.log("so SANDBOX_FIXTURES picks up the seeded addresses.");
  }
}

// Run only when executed directly (the pure helpers above are unit-tested).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
