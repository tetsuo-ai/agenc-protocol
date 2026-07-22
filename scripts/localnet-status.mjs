#!/usr/bin/env node
// localnet-status.mjs — fail-closed health report for the local AgenC stack.
//
// HEALTHY means one coherent stack was verified end to end: the strict local
// environment, the exact managed validator process, its private fd-bound
// program artifact, the RPC endpoint, loader-v3 Program/ProgramData accounts,
// and the configuration values localnet-up converges to.
//
// Usage:
//   node scripts/localnet-status.mjs [--env-file <path>]
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertRecordedProcessIdentity,
  observeLinuxProcess,
  readProcessIdentityFile,
} from "./localnet-process-identity.mjs";
import { openLinuxProcessReference } from "./localnet-process-signal.mjs";
import {
  LOCALNET_BID_MARKETPLACE_PARAMS,
  LOCALNET_PROTOCOL_PARAMS,
} from "./localnet-marketplace-policy.mjs";
import {
  LOCALNET_PROGRAM_DESCRIPTOR_PATH,
  LOCALNET_PROGRAM_ID,
  LOCALNET_PROGRAM_LOAD_METHOD,
} from "./localnet-program-binding.mjs";
import {
  assertLocalnetProgramAccountLinksProgramData,
  assertLocalnetProgramDataMatchesArtifact,
  captureLocalnetProgramArtifact,
} from "./localnet-program-snapshot.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const STATE_DIR = path.join(ROOT, ".localnet");
const LEDGER_DIR = path.join(STATE_DIR, "ledger");
const KEYS_DIR = path.join(STATE_DIR, "keys");
const DEFAULT_ENV_FILE = path.join(STATE_DIR, "env.json");
const PID_FILE = path.join(STATE_DIR, "validator.pid");
const FIXTURES_PATH = path.join(STATE_DIR, "fixtures.json");
const SO_PATH = path.join(
  ROOT,
  "programs/agenc-coordination/target/deploy/agenc_coordination.so",
);
const SDK_DIST = path.join(ROOT, "packages/sdk-ts/dist/index.js");
const BPF_LOADER_UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";
const MAX_PROGRAM_BYTES = 32 * 1024 * 1024;
const PROTOCOL_PARAMS = LOCALNET_PROTOCOL_PARAMS;
const BID_MARKETPLACE_PARAMS = LOCALNET_BID_MARKETPLACE_PARAMS;
const PROTOCOL_CONFIG_DISCRIMINATOR = Buffer.from([
  207, 91, 250, 28, 152, 179, 215, 209,
]);
const MODERATION_CONFIG_DISCRIMINATOR = Buffer.from([
  20, 180, 54, 96, 191, 141, 52, 148,
]);
const BID_MARKETPLACE_CONFIG_DISCRIMINATOR = Buffer.from([
  47, 42, 142, 40, 13, 39, 48, 107,
]);
// Solana Kit represents RPC account `space` as a bigint. Keep these constants
// in the same domain so exact-size checks exercise the real fetch shape.
const PROTOCOL_CONFIG_SIZE = 351n;
const MODERATION_CONFIG_SIZE = 96n;
const BID_MARKETPLACE_CONFIG_SIZE = 71n;

const OK = "OK  ";
const BAD = "FAIL";

function fail(message) {
  throw new Error(message);
}

function fixedBytesHex(value, expectedLength) {
  try {
    const bytes = Buffer.from(value);
    return bytes.length === expectedLength
      ? bytes.toString("hex")
      : "<invalid>";
  } catch {
    return "<invalid>";
  }
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify([...expected].sort())
  ) {
    fail(`${label} has an invalid or unsupported schema`);
  }
}

export function parseLocalnetStatusEnvironment(body, label = "env file") {
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    fail(`${label} contains invalid JSON`);
  }
  exactKeys(
    value,
    [
      "cluster",
      "rpcUrl",
      "rpcSubscriptionsUrl",
      "programId",
      "programSha256",
      "programSize",
      "attestorUrl",
      "fixturesPath",
      "keypairs",
    ],
    label,
  );
  exactKeys(
    value.keypairs,
    ["authority", "moderator", "seeder"],
    `${label}.keypairs`,
  );
  if (
    value.cluster !== "localnet" ||
    typeof value.rpcUrl !== "string" ||
    typeof value.rpcSubscriptionsUrl !== "string" ||
    value.programId !== LOCALNET_PROGRAM_ID ||
    !/^[0-9a-f]{64}$/u.test(value.programSha256 ?? "") ||
    !Number.isSafeInteger(value.programSize) ||
    value.programSize < 1 ||
    value.programSize > MAX_PROGRAM_BYTES ||
    !(
      value.attestorUrl === null ||
      (typeof value.attestorUrl === "string" &&
        value.attestorUrl.length > 0 &&
        value.attestorUrl === value.attestorUrl.trim())
    ) ||
    typeof value.fixturesPath !== "string" ||
    !path.isAbsolute(value.fixturesPath) ||
    Object.values(value.keypairs).some(
      (keypairPath) =>
        typeof keypairPath !== "string" || !path.isAbsolute(keypairPath),
    )
  ) {
    fail(`${label} contains malformed or non-local environment fields`);
  }
  return Object.freeze({
    ...value,
    keypairs: Object.freeze({ ...value.keypairs }),
  });
}

/** Parse key material without ever reflecting it through JSON.parse errors. */
export function parseLocalnetStatusKeypair(body, label = "keypair") {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    fail(`${label} does not contain a canonical 64-byte Solana keypair`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    parsed.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  ) {
    fail(`${label} does not contain a canonical 64-byte Solana keypair`);
  }
  return Uint8Array.from(parsed);
}

/** Bind every mutable status input to one localnet-up lifecycle record. */
export function assertLocalnetStatusBinding(env, pidInfo, artifact) {
  const expectedRpcUrl = `http://127.0.0.1:${pidInfo.rpcPort}`;
  const expectedSubscriptionsUrl = `ws://127.0.0.1:${pidInfo.rpcPort + 1}`;
  const expectedKeypairs = {
    authority: path.join(KEYS_DIR, "authority.json"),
    moderator: path.join(KEYS_DIR, "moderator.json"),
    seeder: path.join(KEYS_DIR, "seeder.json"),
  };
  if (
    pidInfo.rpcPort > 65_432 ||
    env.rpcUrl !== expectedRpcUrl ||
    env.rpcSubscriptionsUrl !== expectedSubscriptionsUrl ||
    env.programId !== LOCALNET_PROGRAM_ID ||
    env.programSha256 !== pidInfo.programSha256 ||
    env.programSize !== pidInfo.programSize ||
    env.programSha256 !== artifact.sha256 ||
    env.programSize !== artifact.size ||
    pidInfo.programLoadMethod !== LOCALNET_PROGRAM_LOAD_METHOD ||
    path.resolve(env.fixturesPath) !== FIXTURES_PATH ||
    Object.entries(expectedKeypairs).some(
      ([name, expected]) => path.resolve(env.keypairs[name]) !== expected,
    )
  ) {
    fail(
      "environment, validator identity, current program artifact, and canonical local endpoint do not describe one stack",
    );
  }
}

export function assertLocalnetStatusValidatorArgv(pidInfo, argv) {
  const argument = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const upgrade = argv.indexOf("--upgradeable-program");
  if (
    path.resolve(argument("--ledger") ?? "") !== LEDGER_DIR ||
    argument("--rpc-port") !== String(pidInfo.rpcPort) ||
    upgrade < 0 ||
    argv[upgrade + 1] !== LOCALNET_PROGRAM_ID ||
    argv[upgrade + 2] !== LOCALNET_PROGRAM_DESCRIPTOR_PATH
  ) {
    fail(
      "validator argv does not bind this repo ledger, RPC port, canonical program, and private program descriptor",
    );
  }
}

export function assertLocalnetStatusProcessIdentity(pidInfo, observed) {
  const matches = assertRecordedProcessIdentity(pidInfo, observed, {
    executableBasename: "solana-test-validator",
    cwd: STATE_DIR,
    assertArgv: (argv) => assertLocalnetStatusValidatorArgv(pidInfo, argv),
  });
  if (matches !== true) {
    fail(`validator pid ${pidInfo.pid} exited during status verification`);
  }
}

export function decodeCanonicalBase64AccountData(value, label) {
  const encoded = value?.data;
  if (
    !Array.isArray(encoded) ||
    encoded.length !== 2 ||
    encoded[1] !== "base64" ||
    typeof encoded[0] !== "string"
  ) {
    fail(`${label} RPC response did not contain canonical base64 account data`);
  }
  const bytes = Buffer.from(encoded[0], "base64");
  if (bytes.toString("base64") !== encoded[0]) {
    fail(`${label} RPC response contained malformed base64 account data`);
  }
  return bytes;
}

export function assertLocalnetProgramAccountStatus(
  value,
  expectedProgramDataAddressBytes,
) {
  if (
    !value ||
    value.executable !== true ||
    String(value.owner) !== BPF_LOADER_UPGRADEABLE
  ) {
    fail(
      "program account is missing, non-executable, or not owned by loader-v3",
    );
  }
  assertLocalnetProgramAccountLinksProgramData(
    decodeCanonicalBase64AccountData(value, "Program"),
    expectedProgramDataAddressBytes,
  );
}

export function assertLocalnetProgramDataStatus(
  value,
  artifact,
  expectedUpgradeAuthorityBytes,
) {
  if (
    !value ||
    value.executable !== false ||
    String(value.owner) !== BPF_LOADER_UPGRADEABLE
  ) {
    fail(
      "ProgramData account is missing, executable, or not owned by loader-v3",
    );
  }
  assertLocalnetProgramDataMatchesArtifact(
    artifact,
    decodeCanonicalBase64AccountData(value, "ProgramData"),
    expectedUpgradeAuthorityBytes,
  );
}

function assertLocalnetConfigAccountEnvelope(account, label, expectedSize) {
  if (
    !account.exists ||
    account.executable !== false ||
    String(account.programAddress) !== LOCALNET_PROGRAM_ID ||
    account.space !== expectedSize
  ) {
    fail(
      `${label} is missing, executable, wrong-sized, or not owned by the AgenC program`,
    );
  }
}

export function assertExpectedLocalnetConfigs(protocol, moderation, expected) {
  assertLocalnetConfigAccountEnvelope(
    protocol,
    "ProtocolConfig",
    PROTOCOL_CONFIG_SIZE,
  );
  assertLocalnetConfigAccountEnvelope(
    moderation,
    "ModerationConfig",
    MODERATION_CONFIG_SIZE,
  );
  const p = protocol.data;
  const m = moderation.data;
  const owners = p.multisigOwners.slice(0, p.multisigOwnersLen).map(String);
  const expectedOwners = [
    expected.authority,
    expected.moderator,
    expected.seeder,
  ];
  const mismatches = [
    [
      "protocolDiscriminator",
      fixedBytesHex(p.discriminator, 8),
      PROTOCOL_CONFIG_DISCRIMINATOR.toString("hex"),
    ],
    ["protocolBump", String(p.bump), String(expected.protocolBump)],
    ["authority", String(p.authority), expected.authority],
    ["treasury", String(p.treasury), expected.authority],
    [
      "disputeThreshold",
      String(p.disputeThreshold),
      String(PROTOCOL_PARAMS.disputeThreshold),
    ],
    [
      "protocolFeeBps",
      String(p.protocolFeeBps),
      String(PROTOCOL_PARAMS.protocolFeeBps),
    ],
    [
      "minAgentStake",
      String(p.minAgentStake),
      String(PROTOCOL_PARAMS.minStake),
    ],
    [
      "minStakeForDispute",
      String(p.minStakeForDispute),
      String(PROTOCOL_PARAMS.minStakeForDispute),
    ],
    [
      "multisigThreshold",
      String(p.multisigThreshold),
      String(PROTOCOL_PARAMS.multisigThreshold),
    ],
    ["multisigOwners", owners.join("|"), expectedOwners.join("|")],
    [
      "moderationDiscriminator",
      fixedBytesHex(m.discriminator, 8),
      MODERATION_CONFIG_DISCRIMINATOR.toString("hex"),
    ],
    ["moderationBump", String(m.bump), String(expected.moderationBump)],
    ["moderationConfigAuthority", String(m.authority), expected.authority],
    ["moderationAuthority", String(m.moderationAuthority), expected.moderator],
    ["moderationEnabled", String(m.enabled), "true"],
  ].filter(([, actual, wanted]) => actual !== wanted);
  if (mismatches.length > 0) {
    fail(
      `localnet configuration differs from localnet-up: ${mismatches
        .map(
          ([field, actual, wanted]) =>
            `${field}=${actual} (expected ${wanted})`,
        )
        .join(", ")}`,
    );
  }
}

export function assertExpectedLocalnetBidMarketplace(bidMarketplace, expected) {
  assertLocalnetConfigAccountEnvelope(
    bidMarketplace,
    "BidMarketplaceConfig",
    BID_MARKETPLACE_CONFIG_SIZE,
  );
  const b = bidMarketplace.data;
  const mismatches = [
    [
      "discriminator",
      fixedBytesHex(b.discriminator, 8),
      BID_MARKETPLACE_CONFIG_DISCRIMINATOR.toString("hex"),
    ],
    ["bump", String(b.bump), String(expected.bidMarketplaceBump)],
    ["authority", String(b.authority), expected.authority],
    [
      "minBidBondLamports",
      String(b.minBidBondLamports),
      String(BID_MARKETPLACE_PARAMS.minBidBondLamports),
    ],
    [
      "bidCreationCooldownSecs",
      String(b.bidCreationCooldownSecs),
      String(BID_MARKETPLACE_PARAMS.bidCreationCooldownSecs),
    ],
    [
      "maxBidsPer24h",
      String(b.maxBidsPer24h),
      String(BID_MARKETPLACE_PARAMS.maxBidsPer24h),
    ],
    [
      "maxActiveBidsPerTask",
      String(b.maxActiveBidsPerTask),
      String(BID_MARKETPLACE_PARAMS.maxActiveBidsPerTask),
    ],
    [
      "maxBidLifetimeSecs",
      String(b.maxBidLifetimeSecs),
      String(BID_MARKETPLACE_PARAMS.maxBidLifetimeSecs),
    ],
    [
      "acceptedNoShowSlashBps",
      String(b.acceptedNoShowSlashBps),
      String(BID_MARKETPLACE_PARAMS.acceptedNoShowSlashBps),
    ],
  ].filter(([, actual, wanted]) => actual !== wanted);
  if (mismatches.length > 0) {
    fail(
      `BidMarketplaceConfig differs from localnet-up: ${mismatches
        .map(
          ([field, actual, wanted]) =>
            `${field}=${actual} (expected ${wanted})`,
        )
        .join(", ")}`,
    );
  }
}

export function assertLocalnetMarketplaceReady(
  protocol,
  expectedSurfaceRevision,
) {
  assertLocalnetConfigAccountEnvelope(
    protocol,
    "ProtocolConfig",
    PROTOCOL_CONFIG_SIZE,
  );
  if (
    protocol.data.protocolPaused !== false ||
    protocol.data.surfaceRevision !== expectedSurfaceRevision
  ) {
    fail(
      `marketplace is not ready for new work: paused=${protocol.data.protocolPaused} ` +
        `surfaceRevision=${protocol.data.surfaceRevision} ` +
        `(expected paused=false surfaceRevision=${expectedSurfaceRevision}); ` +
        "start a fresh disposable developer stack with localnet-up --dev-ready",
    );
  }
}

function parseArgs(argv) {
  const args = { envFile: DEFAULT_ENV_FILE };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--env-file") {
      if (!argv[i + 1]) throw new Error("--env-file requires a path");
      args.envFile = path.resolve(argv[i + 1]);
      i += 1;
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(
        "Usage: node scripts/localnet-status.mjs [--env-file <path>]",
      );
      return null;
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

async function loadExpectedAddresses(kit, keypairs) {
  const entries = await Promise.all(
    Object.entries(keypairs).map(async ([name, keypairPath]) => {
      const bytes = parseLocalnetStatusKeypair(
        await readFile(keypairPath, "utf8"),
        `${name} keypair`,
      );
      let signer;
      try {
        signer = await kit.createKeyPairSignerFromBytes(bytes);
      } catch {
        fail(`${name} keypair does not contain a valid Solana keypair`);
      }
      return [name, String(signer.address)];
    }),
  );
  return Object.freeze(Object.fromEntries(entries));
}

export async function runLocalnetStatus(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args === null) return true;
  let healthy = true;
  const report = (ok, label, detail = "") => {
    if (!ok) healthy = false;
    console.log(`[${ok ? OK : BAD}] ${label}${detail ? `: ${detail}` : ""}`);
  };
  const conclude = (result = healthy) => {
    console.log(`\nstatus: ${result ? "HEALTHY" : "UNHEALTHY"}`);
    return result;
  };

  let env;
  try {
    env = parseLocalnetStatusEnvironment(
      await readFile(args.envFile, "utf8"),
      args.envFile,
    );
    report(true, "environment", args.envFile);
  } catch (error) {
    report(false, "environment", `${args.envFile} (${error.message})`);
    return conclude(false);
  }

  let artifact;
  let pidInfo;
  try {
    [artifact, pidInfo] = await Promise.all([
      captureLocalnetProgramArtifact(SO_PATH),
      readProcessIdentityFile(PID_FILE, "validator"),
    ]);
    if (pidInfo === null) fail(`no validator identity at ${PID_FILE}`);
    assertLocalnetStatusBinding(env, pidInfo, artifact);
    report(
      true,
      "stack binding",
      `rpc=${env.rpcUrl} sha256=${artifact.sha256} size=${artifact.size} method=${pidInfo.programLoadMethod}`,
    );
  } catch (error) {
    report(false, "stack binding", error.message);
    return conclude(false);
  }

  let processReference;
  try {
    processReference = openLinuxProcessReference(pidInfo.pid);
    if (processReference === null)
      fail(`validator pid ${pidInfo.pid} is not live`);
    const observed = await observeLinuxProcess(pidInfo.pid, {
      processReference,
    });
    assertLocalnetStatusProcessIdentity(pidInfo, observed);
    report(
      true,
      "validator process",
      `pid ${pidInfo.pid} (recorded ${pidInfo.recordedAt})`,
    );
  } catch (error) {
    processReference?.close();
    report(false, "validator process", error.message);
    return conclude(false);
  }

  try {
    const kit = await import("@solana/kit");
    let sdk;
    try {
      await stat(SDK_DIST);
      sdk = await import(pathToFileURL(SDK_DIST).href);
      if (sdk.AGENC_COORDINATION_PROGRAM_ADDRESS !== LOCALNET_PROGRAM_ID) {
        fail(
          "built SDK program ID does not match the canonical localnet program ID",
        );
      }
      report(true, "sdk dist", SDK_DIST);
    } catch (error) {
      report(false, "sdk dist", `${SDK_DIST} (${error.message})`);
      return conclude(false);
    }

    let expected;
    try {
      expected = await loadExpectedAddresses(kit, env.keypairs);
      report(
        true,
        "local identities",
        `authority=${expected.authority} moderator=${expected.moderator} seeder=${expected.seeder}`,
      );
    } catch (error) {
      report(false, "local identities", error.message);
      return conclude(false);
    }

    const rpc = kit.createSolanaRpc(env.rpcUrl);
    let rpcUp = false;
    try {
      const [health, slot, version] = await Promise.all([
        rpc.getHealth().send(),
        rpc.getSlot().send(),
        rpc.getVersion().send(),
      ]);
      rpcUp = health === "ok";
      report(
        rpcUp,
        "rpc health",
        `${env.rpcUrl} health=${health} slot=${slot} solana=${version["solana-core"]}`,
      );
    } catch (error) {
      report(
        false,
        "rpc health",
        `${env.rpcUrl} unreachable (${error.message})`,
      );
    }
    if (!rpcUp) return conclude(false);

    const [protocolPda, protocolBump] = await sdk.findProtocolConfigPda();
    const [moderationPda, moderationBump] = await sdk.findModerationConfigPda();
    const [bidMarketplacePda, bidMarketplaceBump] =
      await sdk.findBidMarketplacePda();
    const expectedConfigs = {
      ...expected,
      protocolBump,
      moderationBump,
      bidMarketplaceBump,
    };
    const [programDataPda] = await kit.getProgramDerivedAddress({
      programAddress: kit.address(BPF_LOADER_UPGRADEABLE),
      seeds: [kit.getAddressEncoder().encode(kit.address(LOCALNET_PROGRAM_ID))],
    });
    const [protocol, moderation, bidMarketplace, programInfo, programDataInfo] =
      await Promise.all([
        sdk.fetchMaybeProtocolConfig(rpc, protocolPda),
        sdk.fetchMaybeModerationConfig(rpc, moderationPda),
        sdk.fetchMaybeBidMarketplaceConfig(rpc, bidMarketplacePda),
        rpc
          .getAccountInfo(kit.address(LOCALNET_PROGRAM_ID), {
            encoding: "base64",
          })
          .send(),
        rpc.getAccountInfo(programDataPda, { encoding: "base64" }).send(),
      ]);

    try {
      assertLocalnetProgramAccountStatus(
        programInfo.value,
        kit.getAddressEncoder().encode(programDataPda),
      );
      report(
        true,
        "program account",
        `${LOCALNET_PROGRAM_ID} owner=${programInfo.value.owner} links=${programDataPda}`,
      );
    } catch (error) {
      report(false, "program account", error.message);
    }
    try {
      assertLocalnetProgramDataStatus(
        programDataInfo.value,
        artifact,
        kit.getAddressEncoder().encode(kit.address(expected.authority)),
      );
      report(
        true,
        "ProgramData",
        `${programDataPda} exact executable and authority verified`,
      );
    } catch (error) {
      report(false, "ProgramData", error.message);
    }

    try {
      assertExpectedLocalnetConfigs(protocol, moderation, expectedConfigs);
      const d = protocol.data;
      report(
        true,
        "ProtocolConfig",
        `${protocolPda} authority=${d.authority} treasury=${d.treasury} ` +
          `disputeThreshold=${d.disputeThreshold} protocolFeeBps=${d.protocolFeeBps} ` +
          `minAgentStake=${d.minAgentStake} minStakeForDispute=${d.minStakeForDispute} ` +
          `multisig=${d.multisigThreshold}/${d.multisigOwnersLen} ` +
          `version=${d.protocolVersion} paused=${d.protocolPaused}`,
      );
      const m = moderation.data;
      report(
        true,
        "ModerationConfig",
        `${moderationPda} moderationAuthority=${m.moderationAuthority} enabled=${m.enabled}`,
      );
    } catch (error) {
      report(false, "local configuration", error.message);
    }
    try {
      assertExpectedLocalnetBidMarketplace(bidMarketplace, expectedConfigs);
      const b = bidMarketplace.data;
      report(
        true,
        "BidMarketplaceConfig",
        `${bidMarketplacePda} authority=${b.authority} ` +
          `minBidBondLamports=${b.minBidBondLamports} ` +
          `cooldown=${b.bidCreationCooldownSecs}s maxPer24h=${b.maxBidsPer24h} ` +
          `maxActivePerTask=${b.maxActiveBidsPerTask} ` +
          `maxLifetime=${b.maxBidLifetimeSecs}s noShowSlashBps=${b.acceptedNoShowSlashBps}`,
      );
    } catch (error) {
      report(false, "BidMarketplaceConfig", error.message);
    }
    try {
      assertLocalnetMarketplaceReady(protocol, sdk.SURFACE_REVISION_CURRENT);
      report(
        true,
        "marketplace readiness",
        `unpaused at reviewed surface revision ${sdk.SURFACE_REVISION_CURRENT}`,
      );
    } catch (error) {
      report(false, "marketplace readiness", error.message);
    }

    // This endpoint is a POST-only business API, not a defined unauthenticated
    // health protocol. A GET/404 proves neither attestor identity nor readiness.
    if (typeof env.attestorUrl === "string") {
      console.log(
        `[ -- ] attestor: configured at ${env.attestorUrl}; no read-only authenticated health contract`,
      );
    } else {
      console.log("[ -- ] attestor: not configured (attestorUrl=null)");
    }

    try {
      const fixtures = JSON.parse(await readFile(env.fixturesPath, "utf8"));
      console.log(
        `[ -- ] fixtures: ${env.fixturesPath} (seeded=${fixtures.seeded ?? "?"}, ` +
          `listings=${Array.isArray(fixtures.listings) ? fixtures.listings.length : "?"})`,
      );
    } catch {
      console.log(
        `[ -- ] fixtures: ${env.fixturesPath} not present yet (run the seeder)`,
      );
    }

    try {
      const finalObserved = await observeLinuxProcess(pidInfo.pid, {
        processReference,
      });
      assertLocalnetStatusProcessIdentity(pidInfo, finalObserved);
      report(
        true,
        "validator stability",
        "exact process remained live through all RPC checks",
      );
    } catch (error) {
      report(false, "validator stability", error.message);
    }

    return conclude();
  } finally {
    processReference.close();
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runLocalnetStatus()
    .then((healthy) => {
      process.exitCode = healthy ? 0 : 1;
    })
    .catch((error) => {
      console.error(`localnet-status: ERROR: ${error?.stack ?? error}`);
      process.exitCode = 1;
    });
}
