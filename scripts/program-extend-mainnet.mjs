#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  address,
  getAddressDecoder,
  getBase58Decoder,
  getBase58Encoder,
} from "@solana/kit";

/**
 * The extension is intentionally a top-level loader instruction. Agave does
 * not authorize legacy ExtendProgram through CPI, so a Squads vault proposal
 * cannot perform this operation on current mainnet.
 */
export const EXTENSION_POLICY = Object.freeze({
  cluster: "mainnet-beta",
  mainnetGenesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  primaryRpcUrl: "https://api.mainnet-beta.solana.com",
  secondaryRpcUrl: "https://solana-rpc.publicnode.com",
  program: "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK",
  programData: "E5w1ZkgC5ysWWBECHHzqsL4s6dDUoyWBnUMRptm5cEAw",
  upgradeAuthority: "Cj9dWtovMaAsHUkCFqsEeP7GAS86DouqFerh86Qxtnuf",
  loader: "BPFLoaderUpgradeab1e11111111111111111111111",
  systemProgram: "11111111111111111111111111111111",
  featureProgram: "Feature111111111111111111111111111111111111",
  // SIMD-0164 never activated. If this account unexpectedly appears, the
  // legacy instruction's cluster semantics must be re-audited before use.
  checkedExtendFeature: "2oMRZEDWT2tqtYMofhmmfQ8SsjqUFzT6sYXppQDavxwz",
  minimumExtendFeature: "YbbRLkvenrocjGPGyoQE4wjnvYzTgfsk38NFmcYK7a5",
  minimumExtendActivationSlot: 432_864_000,
  // Bound after the 2026-07-20 close-task fix build plus two isolated
  // 2026-07-21 rebuilds reproduced these exact bytes. Supersedes the
  // pre-close-task-fix 2,284,496-byte `79f55a68…` identity.
  artifactBindingStatus: "reviewed-final-twice-reproduced",
  candidateSbfSha256:
    "049a66e30da166c1e02ee379993425c32386f774fd9ff8861153e21900b496f2",
  candidateSbfSizeBytes: 2_303_608,
  additionalBytes: 120_384,
  previousPayloadCapacity: 2_183_224,
  previousPayloadSha256:
    "033bf93ce5887abfdf6ae192a1d81e713f5f52979d3f20d3be95212e8abddf63",
  previousProgramDataSlot: 431_918_664,
  requiredPayloadBytes: 2_303_608,
  programDataMetadataBytes: 45,
  minimumFeeReserveLamports: 1_000_000,
  requiredCliVersion: "4.1.0",
  requiredCliSourcePrefix: "d3f1f55c",
  requiredCliVersionOutput:
    "solana-cli 4.1.0 (src:d3f1f55c; feat:c763ae0a, client:Agave)",
  requiredLinuxCliSha256:
    "6cec29c203643342c4fd6cf9404f413a77e7452ef9205665c98cbf91e083f4c4",
  requiredLinuxReleaseArchiveSha256:
    "9713fcfe4e90107595babd2001c8337fc9647195390c01dc5976039c11ca2da4",
  signatureHistoryPageSize: 1_000,
  signatureHistoryMaxPages: 100,
  maximumEvidenceFutureSkewMs: 5 * 60 * 1_000,
  maximumTransactionClockSkewMs: 5 * 60 * 1_000,
});

export const EXTENSION_EVIDENCE_VERSION = 3;

const addressDecoder = getAddressDecoder();
const base58Decoder = getBase58Decoder();
const base58Encoder = getBase58Encoder();

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertFinalArtifactBoundExtensionPolicy(policy) {
  if (policy.artifactBindingStatus !== "reviewed-final-twice-reproduced") {
    throw new Error(
      "extension policy is disabled until a final production SBF is reproduced twice and deliberately rebound",
    );
  }
  if (
    typeof policy.candidateSbfSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(policy.candidateSbfSha256) ||
    !Number.isSafeInteger(policy.candidateSbfSizeBytes) ||
    policy.candidateSbfSizeBytes <= 0 ||
    !Number.isSafeInteger(policy.additionalBytes) ||
    policy.additionalBytes <= 0 ||
    !Number.isSafeInteger(policy.requiredPayloadBytes) ||
    policy.requiredPayloadBytes <= 0 ||
    policy.candidateSbfSizeBytes !== policy.requiredPayloadBytes ||
    policy.previousPayloadCapacity + policy.additionalBytes !==
      policy.requiredPayloadBytes
  ) {
    throw new Error(
      "extension policy final SBF hash/size/capacity binding is malformed",
    );
  }
  return policy;
}

function hashRegularFile(path, label) {
  let descriptor;
  try {
    descriptor = openSync(
      resolve(path),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error(`${label} must be a non-empty regular file`);
    }
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < stat.size) {
      const count = readSync(
        descriptor,
        chunk,
        0,
        Math.min(chunk.length, stat.size - position),
        position,
      );
      if (count <= 0) throw new Error(`${label} read made no progress`);
      hash.update(chunk.subarray(0, count));
      position += count;
    }
    return { digest: hash.digest("hex"), size: stat.size };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizedRpcUrl(value) {
  return assertCredentialFreeCliRpcUrl(value);
}

function decodeRpcAccount(value, label) {
  if (
    !value ||
    typeof value.owner !== "string" ||
    typeof value.executable !== "boolean" ||
    !Number.isSafeInteger(value.lamports) ||
    value.lamports < 0 ||
    !Array.isArray(value.data) ||
    typeof value.data[0] !== "string" ||
    value.data[1] !== "base64"
  ) {
    throw new Error(`${label} RPC state is missing or malformed`);
  }
  return { ...value, bytes: Buffer.from(value.data[0], "base64") };
}

export function assertCredentialFreeCliRpcUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("RPC URL must be a valid credential-free HTTPS URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    throw new Error(
      "RPC URL must be credential-free HTTPS with no userinfo, path, query, or fragment",
    );
  }
  return parsed.href;
}

async function jsonRpc(rpcUrl, method, params = []) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(`${method} RPC returned HTTP ${response.status}`);
  const document = await response.json();
  if (document.error) {
    throw new Error(
      `${method} RPC failed: ${String(document.error.message ?? "unknown error")}`,
    );
  }
  return document.result;
}

async function readExtensionState(
  rpcUrl,
  payerAddress,
  policy = EXTENSION_POLICY,
  rpc = jsonRpc,
) {
  assertFinalArtifactBoundExtensionPolicy(policy);
  const reviewedRpcUrl = normalizedRpcUrl(rpcUrl);
  const genesis = await rpc(reviewedRpcUrl, "getGenesisHash");
  if (genesis !== policy.mainnetGenesis) {
    throw new Error(
      `RPC genesis ${String(genesis)} is not reviewed mainnet-beta`,
    );
  }

  const requestedAccounts = [
    policy.program,
    policy.programData,
    policy.checkedExtendFeature,
    policy.minimumExtendFeature,
  ];
  if (payerAddress !== null) requestedAccounts.push(payerAddress);
  const accountsResult = await rpc(reviewedRpcUrl, "getMultipleAccounts", [
    requestedAccounts,
    { commitment: "finalized", encoding: "base64" },
  ]);
  const contextSlot = accountsResult?.context?.slot;
  if (
    !Number.isSafeInteger(contextSlot) ||
    contextSlot < 0 ||
    !Array.isArray(accountsResult?.value) ||
    accountsResult.value.length !== requestedAccounts.length
  ) {
    throw new Error("extension account snapshot is missing or malformed");
  }
  const [
    programValue,
    programDataValue,
    checkedFeatureValue,
    minimumFeatureValue,
    payerValue,
  ] = accountsResult.value;
  if (checkedFeatureValue !== null) {
    throw new Error(
      `checked-extend feature ${policy.checkedExtendFeature} unexpectedly exists; re-audit loader semantics before extending`,
    );
  }
  const minimumFeature = decodeRpcAccount(
    minimumFeatureValue,
    "minimum-extend feature",
  );
  if (
    minimumFeature.owner !== policy.featureProgram ||
    minimumFeature.executable !== false ||
    minimumFeature.bytes.length !== 9 ||
    minimumFeature.bytes[0] !== 1
  ) {
    throw new Error("SIMD-0431 minimum-extend feature is not active");
  }
  const minimumExtendActivationSlot = Number(
    minimumFeature.bytes.readBigUInt64LE(1),
  );
  if (
    !Number.isSafeInteger(minimumExtendActivationSlot) ||
    minimumExtendActivationSlot !== policy.minimumExtendActivationSlot ||
    minimumExtendActivationSlot > contextSlot
  ) {
    throw new Error(
      "SIMD-0431 activation slot differs from reviewed mainnet state",
    );
  }

  const program = decodeRpcAccount(programValue, "Program");
  if (
    program.owner !== policy.loader ||
    program.executable !== true ||
    program.bytes.length !== 36 ||
    program.bytes.readUInt32LE(0) !== 2
  ) {
    throw new Error("Program loader state is malformed or is not upgradeable");
  }
  const linkedProgramData = addressDecoder.decode(
    program.bytes.subarray(4, 36),
  );
  if (linkedProgramData !== policy.programData) {
    throw new Error(
      `Program links to ProgramData ${linkedProgramData}, not reviewed ${policy.programData}`,
    );
  }

  const programData = decodeRpcAccount(programDataValue, "ProgramData");
  if (
    programData.owner !== policy.loader ||
    programData.executable !== false ||
    programData.bytes.length < policy.programDataMetadataBytes ||
    programData.bytes.readUInt32LE(0) !== 3 ||
    programData.bytes[12] !== 1
  ) {
    throw new Error("ProgramData loader state is malformed or immutable");
  }
  const authority = addressDecoder.decode(programData.bytes.subarray(13, 45));
  if (authority !== policy.upgradeAuthority) {
    throw new Error(
      `ProgramData authority ${authority} differs from reviewed ${policy.upgradeAuthority}`,
    );
  }
  const programDataSlot = Number(programData.bytes.readBigUInt64LE(4));
  if (
    !Number.isSafeInteger(programDataSlot) ||
    programDataSlot < 0 ||
    programDataSlot > contextSlot
  ) {
    throw new Error(
      "ProgramData deployment slot is malformed or ahead of RPC context",
    );
  }
  const payloadBytes =
    programData.bytes.length - policy.programDataMetadataBytes;
  const payload = programData.bytes.subarray(policy.programDataMetadataBytes);
  const originalPrefix = payload.subarray(
    0,
    Math.min(payload.length, policy.previousPayloadCapacity),
  );
  const appended = payload.subarray(
    Math.min(payload.length, policy.previousPayloadCapacity),
  );
  const targetAccountBytes =
    policy.requiredPayloadBytes + policy.programDataMetadataBytes;
  const targetRentLamports = await rpc(
    reviewedRpcUrl,
    "getMinimumBalanceForRentExemption",
    [targetAccountBytes, { commitment: "finalized" }],
  );
  if (!Number.isSafeInteger(targetRentLamports) || targetRentLamports < 0) {
    throw new Error("target ProgramData rent response is malformed");
  }
  const requiredTopUpLamports = Math.max(
    0,
    targetRentLamports - programData.lamports,
  );
  const excessLamports = Math.max(0, programData.lamports - targetRentLamports);

  let payerLamports = null;
  if (payerAddress !== null) {
    const payer = decodeRpcAccount(payerValue, "payer");
    if (
      payer.owner !== policy.systemProgram ||
      payer.executable !== false ||
      payer.bytes.length !== 0
    ) {
      throw new Error(
        "payer must be a non-executable, zero-data System account",
      );
    }
    payerLamports = payer.lamports;
  }

  return {
    authority,
    checkedExtendFeatureAbsent: true,
    contextSlot,
    currentAccountBytes: programData.bytes.length,
    currentLamports: programData.lamports,
    excessLamports,
    appendedBytes: appended.length,
    appendedBytesAllZero: appended.every((byte) => byte === 0),
    genesisHash: genesis,
    minimumExtendActivationSlot,
    originalPrefixSha256: sha256(originalPrefix),
    payloadBytes,
    payloadSha256: sha256(payload),
    payerLamports,
    programDataSlot,
    requiredTopUpLamports,
    rpcUrl: reviewedRpcUrl,
    targetAccountBytes,
    targetRentLamports,
  };
}

/** Validate the exact live state in which the one-time extension may begin. */
export async function verifyPreExtensionState(
  rpcUrl,
  payerAddress,
  policy = EXTENSION_POLICY,
  rpc = jsonRpc,
) {
  const state = await readExtensionState(rpcUrl, payerAddress, policy, rpc);
  if (
    policy.previousPayloadCapacity + policy.additionalBytes !==
    policy.requiredPayloadBytes
  ) {
    throw new Error("extension policy capacity arithmetic drifted");
  }
  if (state.payloadBytes !== policy.previousPayloadCapacity) {
    throw new Error(
      `ProgramData payload ${state.payloadBytes} differs from pre-extension ${policy.previousPayloadCapacity}; refusing a duplicate or stale extension`,
    );
  }
  if (
    state.programDataSlot !== policy.previousProgramDataSlot ||
    state.payloadSha256 !== policy.previousPayloadSha256
  ) {
    throw new Error(
      "ProgramData slot or payload hash differs from the reviewed pre-extension baseline",
    );
  }
  if (state.payerLamports === null) {
    throw new Error(
      "payer address is required for the extension funding preflight",
    );
  }
  const requiredPayerLamports =
    state.requiredTopUpLamports + policy.minimumFeeReserveLamports;
  if (state.payerLamports < requiredPayerLamports) {
    throw new Error(
      `payer needs at least ${requiredPayerLamports} lamports for rent plus the fee reserve but has ${state.payerLamports}`,
    );
  }
  return { ...state, requiredPayerLamports };
}

/** Validate the exact finalized state after the one-time extension. */
export async function verifyPostExtensionState(
  rpcUrl,
  expectedPreExtension,
  policy = EXTENSION_POLICY,
  rpc = jsonRpc,
) {
  const state = await readExtensionState(rpcUrl, null, policy, rpc);
  if (state.payloadBytes !== policy.requiredPayloadBytes) {
    throw new Error(
      `post-extension payload ${state.payloadBytes} differs from reviewed ${policy.requiredPayloadBytes}`,
    );
  }
  if (state.currentLamports < state.targetRentLamports) {
    throw new Error(
      "extended ProgramData balance is below the freshly queried finalized rent floor",
    );
  }
  if (!expectedPreExtension) {
    throw new Error(
      "post-extension verification requires saved pre-extension evidence",
    );
  }
  if (
    state.programDataSlot <= expectedPreExtension.programDataSlot ||
    state.programDataSlot <= expectedPreExtension.contextSlot
  ) {
    throw new Error(
      "ProgramData slot did not advance beyond the saved pre-extension context",
    );
  }
  if (state.originalPrefixSha256 !== expectedPreExtension.payloadSha256) {
    throw new Error(
      "extension changed the pre-existing ProgramData payload prefix",
    );
  }
  if (
    state.appendedBytes !== policy.additionalBytes ||
    state.appendedBytesAllZero !== true
  ) {
    throw new Error(
      "extension did not append the exact reviewed zero-filled region",
    );
  }
  return state;
}

export function assertMatchingPreflightStates(primary, secondary) {
  for (const field of [
    "authority",
    "checkedExtendFeatureAbsent",
    "currentAccountBytes",
    "currentLamports",
    "excessLamports",
    "appendedBytes",
    "appendedBytesAllZero",
    "genesisHash",
    "minimumExtendActivationSlot",
    "originalPrefixSha256",
    "payerLamports",
    "payloadBytes",
    "payloadSha256",
    "programDataSlot",
    "requiredPayerLamports",
    "requiredTopUpLamports",
    "targetAccountBytes",
    "targetRentLamports",
  ]) {
    if (primary[field] !== secondary[field]) {
      throw new Error(
        `independent RPCs disagree on ${field}: ${String(primary[field])} != ${String(secondary[field])}`,
      );
    }
  }
}

/**
 * Compare only immutable/release-critical postimages across providers.
 * ProgramData is permissionlessly dustable, so finalized providers may observe
 * different safe surpluses while converging. Each snapshot separately proves
 * its own balance >= rent and exact excess arithmetic.
 */
export function assertMatchingPostflightStates(primary, secondary) {
  for (const field of [
    "authority",
    "checkedExtendFeatureAbsent",
    "currentAccountBytes",
    "appendedBytes",
    "appendedBytesAllZero",
    "genesisHash",
    "minimumExtendActivationSlot",
    "originalPrefixSha256",
    "payerLamports",
    "payloadBytes",
    "payloadSha256",
    "programDataSlot",
    "requiredTopUpLamports",
    "targetAccountBytes",
    "targetRentLamports",
  ]) {
    if (primary[field] !== secondary[field]) {
      throw new Error(
        `independent RPC postimages disagree on ${field}: ${String(primary[field])} != ${String(secondary[field])}`,
      );
    }
  }
}

export function assertPinnedAgaveCliVersion(output, policy = EXTENSION_POLICY) {
  const version = String(output).trim();
  if (version !== policy.requiredCliVersionOutput) {
    throw new Error(
      `program extension requires official Agave solana-cli ${policy.requiredCliVersion} from ${policy.requiredCliSourcePrefix}; got ${version || "no version"}`,
    );
  }
  return version;
}

export function assertPinnedAgaveCliBinary(cliPath, policy = EXTENSION_POLICY) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(
      "the reviewed extension binary checksum is pinned only for x86_64 Linux",
    );
  }
  if (!existsSync(cliPath)) throw new Error("--solana-cli does not exist");
  const { digest } = hashRegularFile(cliPath, "Agave CLI");
  if (digest !== policy.requiredLinuxCliSha256) {
    throw new Error(
      `Agave CLI sha256 ${digest} differs from reviewed ${policy.requiredLinuxCliSha256}`,
    );
  }
  return digest;
}

export function assertPinnedAgaveCliArchive(
  archivePath,
  policy = EXTENSION_POLICY,
) {
  if (!existsSync(archivePath)) {
    throw new Error("--solana-cli-archive does not exist");
  }
  const { digest } = hashRegularFile(archivePath, "Agave CLI release archive");
  if (digest !== policy.requiredLinuxReleaseArchiveSha256) {
    throw new Error(
      `Agave CLI release archive sha256 ${digest} differs from reviewed ${policy.requiredLinuxReleaseArchiveSha256}`,
    );
  }
  return digest;
}

/**
 * Copy the reviewed executable through no-follow descriptors into a private
 * mode-0700 directory, hash the destination inode, and keep that exact inode
 * open until every CLI invocation has finished. `runCli` maps the descriptor
 * into the child and executes `/proc/self/fd/3`, so a later replacement of the
 * operator-supplied path cannot change the bytes that run.
 */
export function preparePinnedAgaveCliBinary(
  cliPath,
  policy = EXTENSION_POLICY,
) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(
      "the reviewed extension binary checksum is pinned only for x86_64 Linux",
    );
  }
  const directory = mkdtempSync(join(tmpdir(), "agenc-extension-cli-"));
  chmodSync(directory, 0o700);
  const copiedPath = join(directory, "solana");
  let sourceDescriptor;
  let destinationDescriptor;
  let executableDescriptor;
  try {
    sourceDescriptor = openSync(
      resolve(cliPath),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const sourceStat = fstatSync(sourceDescriptor);
    if (!sourceStat.isFile() || sourceStat.size <= 0) {
      throw new Error("Agave CLI must be a non-empty regular file");
    }
    destinationDescriptor = openSync(
      copiedPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o500,
    );
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < sourceStat.size) {
      const count = readSync(
        sourceDescriptor,
        chunk,
        0,
        Math.min(chunk.length, sourceStat.size - position),
        position,
      );
      if (count <= 0) throw new Error("Agave CLI copy made no read progress");
      hash.update(chunk.subarray(0, count));
      let written = 0;
      while (written < count) {
        const writeCount = writeSync(
          destinationDescriptor,
          chunk,
          written,
          count - written,
        );
        if (writeCount <= 0) {
          throw new Error("Agave CLI copy made no write progress");
        }
        written += writeCount;
      }
      position += count;
    }
    const sourceDigest = hash.digest("hex");
    if (sourceDigest !== policy.requiredLinuxCliSha256) {
      throw new Error(
        `Agave CLI sha256 ${sourceDigest} differs from reviewed ${policy.requiredLinuxCliSha256}`,
      );
    }
    fchmodSync(destinationDescriptor, 0o500);
    fsyncSync(destinationDescriptor);
    closeSync(destinationDescriptor);
    destinationDescriptor = undefined;
    closeSync(sourceDescriptor);
    sourceDescriptor = undefined;

    executableDescriptor = openSync(
      copiedPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const executableStat = fstatSync(executableDescriptor);
    const destinationDigest = hashRegularFile(
      copiedPath,
      "private Agave CLI executable image",
    ).digest;
    if (
      !executableStat.isFile() ||
      executableStat.size !== sourceStat.size ||
      (executableStat.mode & 0o777) !== 0o500 ||
      destinationDigest !== sourceDigest
    ) {
      throw new Error("private Agave CLI executable image changed after copy");
    }
    let cleaned = false;
    return Object.freeze({
      descriptor: executableDescriptor,
      digest: destinationDigest,
      executablePath: copiedPath,
      inode: executableStat.ino,
      device: executableStat.dev,
      size: executableStat.size,
      cleanup() {
        if (cleaned) return;
        cleaned = true;
        closeSync(executableDescriptor);
        rmSync(directory, { force: true, recursive: true });
      },
    });
  } catch (error) {
    if (destinationDescriptor !== undefined) {
      try {
        closeSync(destinationDescriptor);
      } catch {
        // Preserve the primary preparation failure.
      }
    }
    if (sourceDescriptor !== undefined) {
      try {
        closeSync(sourceDescriptor);
      } catch {
        // Preserve the primary preparation failure.
      }
    }
    if (executableDescriptor !== undefined) {
      try {
        closeSync(executableDescriptor);
      } catch {
        // Preserve the primary preparation failure.
      }
    }
    rmSync(directory, { force: true, recursive: true });
    throw error;
  }
}

const MAX_PAYER_KEYPAIR_BYTES = 16 * 1024;
const PINNED_PAYER_CHILD_FD = 4;
const PINNED_PAYER_CHILD_PATH = `/proc/self/fd/${PINNED_PAYER_CHILD_FD}`;

/**
 * Snapshot the payer keypair once through a no-follow descriptor, copy it into
 * a private read-only inode, unlink that inode, and keep its descriptor open for
 * every signer operation. The source pathname is never reopened after this
 * point, so address derivation and the irreversible extension cannot observe
 * different key files. Key material is deliberately never hashed, logged, or
 * serialized into ceremony evidence.
 */
export function preparePinnedPayerKeypair(keypairPath) {
  if (process.platform !== "linux") {
    throw new Error("payer keypair descriptor pinning requires Linux /proc");
  }
  const directory = mkdtempSync(join(tmpdir(), "agenc-extension-payer-"));
  chmodSync(directory, 0o700);
  const copiedPath = join(directory, "payer.json");
  let sourceDescriptor;
  let destinationDescriptor;
  let keypairDescriptor;
  try {
    sourceDescriptor = openSync(
      resolve(keypairPath),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const sourceStat = fstatSync(sourceDescriptor);
    const currentUid = process.getuid?.();
    if (
      !sourceStat.isFile() ||
      sourceStat.size <= 0 ||
      sourceStat.size > MAX_PAYER_KEYPAIR_BYTES ||
      sourceStat.nlink !== 1
    ) {
      throw new Error(
        "payer keypair must be a bounded non-empty single-link regular file",
      );
    }
    if (currentUid !== undefined && sourceStat.uid !== currentUid) {
      throw new Error("payer keypair must be owned by the current user");
    }
    if ((sourceStat.mode & 0o077) !== 0) {
      throw new Error(
        "payer keypair must not grant group or other permissions",
      );
    }

    destinationDescriptor = openSync(
      copiedPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o400,
    );
    const chunk = Buffer.allocUnsafe(Math.min(4_096, sourceStat.size));
    let position = 0;
    while (position < sourceStat.size) {
      const count = readSync(
        sourceDescriptor,
        chunk,
        0,
        Math.min(chunk.length, sourceStat.size - position),
        position,
      );
      if (count <= 0)
        throw new Error("payer keypair copy made no read progress");
      let written = 0;
      while (written < count) {
        const writeCount = writeSync(
          destinationDescriptor,
          chunk,
          written,
          count - written,
        );
        if (writeCount <= 0) {
          throw new Error("payer keypair copy made no write progress");
        }
        written += writeCount;
      }
      position += count;
    }
    fchmodSync(destinationDescriptor, 0o400);
    fsyncSync(destinationDescriptor);
    closeSync(destinationDescriptor);
    destinationDescriptor = undefined;
    closeSync(sourceDescriptor);
    sourceDescriptor = undefined;

    keypairDescriptor = openSync(
      copiedPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const pinnedStat = fstatSync(keypairDescriptor);
    if (
      !pinnedStat.isFile() ||
      pinnedStat.size !== sourceStat.size ||
      (pinnedStat.mode & 0o777) !== 0o400 ||
      (currentUid !== undefined && pinnedStat.uid !== currentUid)
    ) {
      throw new Error("private payer keypair snapshot is malformed");
    }
    unlinkSync(copiedPath);

    let cleaned = false;
    return Object.freeze({
      childPath: PINNED_PAYER_CHILD_PATH,
      descriptor: keypairDescriptor,
      device: pinnedStat.dev,
      inode: pinnedStat.ino,
      size: pinnedStat.size,
      cleanup() {
        if (cleaned) return;
        cleaned = true;
        closeSync(keypairDescriptor);
        rmSync(directory, { force: true, recursive: true });
      },
    });
  } catch (error) {
    if (destinationDescriptor !== undefined) {
      try {
        closeSync(destinationDescriptor);
      } catch {
        // Preserve the primary preparation failure.
      }
    }
    if (sourceDescriptor !== undefined) {
      try {
        closeSync(sourceDescriptor);
      } catch {
        // Preserve the primary preparation failure.
      }
    }
    if (keypairDescriptor !== undefined) {
      try {
        closeSync(keypairDescriptor);
      } catch {
        // Preserve the primary preparation failure.
      }
    }
    rmSync(directory, { force: true, recursive: true });
    throw error;
  }
}

export function buildExtensionCliArgs(options, policy = EXTENSION_POLICY) {
  assertFinalArtifactBoundExtensionPolicy(policy);
  return [
    "--url",
    options.rpcUrl,
    "--commitment",
    "finalized",
    "--output",
    "json",
    "--keypair",
    options.payerKeypair,
    "program",
    "extend",
    policy.program,
    String(policy.additionalBytes),
    "--payer",
    options.payerKeypair,
  ];
}

export function runCli(command, args, spawn = spawnSync, payerKeypair = null) {
  const pinnedCommand =
    typeof command === "string" ? null : assertPinnedCliHandle(command);
  const pinnedPayer =
    payerKeypair === null ? null : assertPinnedPayerKeypairHandle(payerKeypair);
  const executable = pinnedCommand === null ? command : "/proc/self/fd/3";
  const result = spawn(executable, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio:
      pinnedCommand === null && pinnedPayer === null
        ? ["inherit", "pipe", "pipe"]
        : [
            "inherit",
            "pipe",
            "pipe",
            pinnedCommand?.descriptor ?? "ignore",
            pinnedPayer?.descriptor ?? "ignore",
          ],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${pinnedCommand?.executablePath ?? command} ${args[0] ?? ""} failed (${result.status}): ${String(result.stderr).trim()}`,
    );
  }
  return String(result.stdout).trim();
}

function assertPinnedPayerKeypairHandle(keypair) {
  if (
    !keypair ||
    keypair.childPath !== PINNED_PAYER_CHILD_PATH ||
    !Number.isInteger(keypair.descriptor)
  ) {
    throw new Error("pinned payer keypair handle is malformed");
  }
  const stat = fstatSync(keypair.descriptor);
  const currentUid = process.getuid?.();
  if (
    !stat.isFile() ||
    stat.dev !== keypair.device ||
    stat.ino !== keypair.inode ||
    stat.size !== keypair.size ||
    stat.size <= 0 ||
    stat.size > MAX_PAYER_KEYPAIR_BYTES ||
    (stat.mode & 0o777) !== 0o400 ||
    (currentUid !== undefined && stat.uid !== currentUid)
  ) {
    throw new Error("pinned payer keypair inode changed after preparation");
  }
  return keypair;
}

function assertPinnedCliHandle(command) {
  const stat = fstatSync(command.descriptor);
  if (
    !stat.isFile() ||
    stat.dev !== command.device ||
    stat.ino !== command.inode ||
    stat.size !== command.size ||
    (stat.mode & 0o777) !== 0o500
  ) {
    throw new Error("hash-pinned Agave CLI descriptor identity changed");
  }
  return command;
}

export function getExtensionPolicySha256(policy = EXTENSION_POLICY) {
  return sha256(Buffer.from(canonicalJson(policy), "utf8"));
}

export function getExtensionPreflightSha256(primary, secondary) {
  return sha256(Buffer.from(canonicalJson({ primary, secondary }), "utf8"));
}

export function getExtensionSignatureHistorySha256(entries) {
  return sha256(Buffer.from(canonicalJson(entries), "utf8"));
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function assertSignature(value, label) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a canonical 64-byte base58 signature`);
  }
  let bytes;
  try {
    bytes = Buffer.from(base58Encoder.encode(value));
  } catch {
    throw new Error(`${label} must be a canonical 64-byte base58 signature`);
  }
  if (bytes.length !== 64 || base58Decoder.decode(bytes) !== value) {
    throw new Error(`${label} must be a canonical 64-byte base58 signature`);
  }
  return value;
}

function assertSignatureHistory(entries, { exactLength = false } = {}) {
  if (
    !Array.isArray(entries) ||
    entries.length > 25 ||
    (exactLength && entries.length !== 25)
  ) {
    throw new Error(
      `before-signature history must contain ${exactLength ? "exactly" : "at most"} 25 entries`,
    );
  }
  const seen = new Set();
  let priorSlot = Number.MAX_SAFE_INTEGER;
  for (const [index, entry] of entries.entries()) {
    if (
      !entry ||
      Object.getPrototypeOf(entry) !== Object.prototype ||
      Object.keys(entry).sort().join(",") !== "signature,slot" ||
      !Number.isSafeInteger(entry.slot) ||
      entry.slot < 0 ||
      entry.slot > priorSlot
    ) {
      throw new Error(`before-signature history entry ${index} is malformed`);
    }
    assertSignature(entry.signature, `before-signature history entry ${index}`);
    if (seen.has(entry.signature)) {
      throw new Error(
        "before-signature history contains a duplicate signature",
      );
    }
    seen.add(entry.signature);
    priorSlot = entry.slot;
  }
  return entries;
}

export async function getFinalizedProgramDataSignatures(
  rpcUrl,
  policy = EXTENSION_POLICY,
  rpc = jsonRpc,
) {
  const result = await rpc(rpcUrl, "getSignaturesForAddress", [
    policy.programData,
    { commitment: "finalized", limit: 25 },
  ]);
  if (!Array.isArray(result)) {
    throw new Error("ProgramData signature history is malformed");
  }
  const entries = result.map((entry, index) => {
    if (!entry || !Number.isSafeInteger(entry.slot) || entry.slot < 0) {
      throw new Error("ProgramData signature history entry is malformed");
    }
    return {
      signature: assertSignature(
        entry.signature,
        `ProgramData signature history entry ${index}`,
      ),
      slot: entry.slot,
    };
  });
  return assertSignatureHistory(entries);
}

export async function findExtensionTransactionEvidence(
  rpcUrl,
  beforeSignatures,
  payerAddress,
  policy = EXTENSION_POLICY,
  rpc = jsonRpc,
) {
  assertFinalArtifactBoundExtensionPolicy(policy);
  assertSignatureHistory(beforeSignatures);
  address(payerAddress);
  const reviewedRpcUrl = normalizedRpcUrl(rpcUrl);
  const before = new Set(beforeSignatures.map((entry) => entry.signature));
  const historyAnchor = beforeSignatures[0]?.signature;
  if (!historyAnchor) {
    throw new Error("postflight recovery requires a saved history anchor");
  }
  const expectedData = Buffer.alloc(8);
  expectedData.writeUInt32LE(6, 0); // UpgradeableLoaderInstruction::ExtendProgram
  expectedData.writeUInt32LE(policy.additionalBytes, 4);
  const expectedAccounts = [
    policy.programData,
    policy.program,
    policy.systemProgram,
    payerAddress,
  ];
  const seen = new Set();
  const candidates = [];
  let cursor;
  let historyAnchorFound = false;
  let previousSlot = Number.MAX_SAFE_INTEGER;
  for (
    let pageIndex = 0;
    pageIndex < policy.signatureHistoryMaxPages;
    pageIndex += 1
  ) {
    const pageOptions = {
      commitment: "finalized",
      limit: policy.signatureHistoryPageSize,
      ...(cursor === undefined ? {} : { before: cursor }),
    };
    const page = await rpc(reviewedRpcUrl, "getSignaturesForAddress", [
      policy.programData,
      pageOptions,
    ]);
    if (!Array.isArray(page) || page.length > policy.signatureHistoryPageSize) {
      throw new Error("post-extension signature-history page is malformed");
    }
    if (page.length === 0) break;

    for (const [entryIndex, entry] of page.entries()) {
      const label = `post-extension signature history page ${pageIndex} entry ${entryIndex}`;
      if (
        !entry ||
        !Number.isSafeInteger(entry.slot) ||
        entry.slot < 0 ||
        entry.slot > previousSlot
      ) {
        throw new Error(`${label} is malformed`);
      }
      const signature = assertSignature(entry.signature, label);
      if (seen.has(signature)) {
        throw new Error(
          "post-extension signature history repeated an entry or pagination cursor",
        );
      }
      seen.add(signature);
      previousSlot = entry.slot;
      if (signature === historyAnchor) {
        historyAnchorFound = true;
        break;
      }
      if (before.has(signature) || entry.err !== null) continue;

      const transaction = await rpc(reviewedRpcUrl, "getTransaction", [
        signature,
        {
          commitment: "finalized",
          encoding: "json",
          maxSupportedTransactionVersion: 0,
        },
      ]);
      const message = transaction?.transaction?.message;
      const instructions = message?.instructions;
      const accountKeys = message?.accountKeys?.map((key) =>
        typeof key === "string" ? key : key?.pubkey,
      );
      if (
        transaction?.meta?.err !== null ||
        !Number.isSafeInteger(transaction?.slot) ||
        transaction.slot !== entry.slot ||
        !Array.isArray(accountKeys) ||
        accountKeys[0] !== payerAddress ||
        !Array.isArray(instructions) ||
        instructions.length !== 1 ||
        transaction.transaction.signatures?.[0] !== signature
      ) {
        continue;
      }
      const instruction = instructions[0];
      if (
        accountKeys[instruction?.programIdIndex] !== policy.loader ||
        !Array.isArray(instruction?.accounts) ||
        typeof instruction?.data !== "string"
      ) {
        continue;
      }
      const actualAccounts = instruction.accounts.map(
        (index) => accountKeys[index],
      );
      const actualData = Buffer.from(base58Encoder.encode(instruction.data));
      if (
        JSON.stringify(actualAccounts) !== JSON.stringify(expectedAccounts) ||
        !actualData.equals(expectedData)
      ) {
        continue;
      }
      const blockTime = transaction.blockTime ?? entry.blockTime ?? null;
      if (
        blockTime !== null &&
        (!Number.isSafeInteger(blockTime) || blockTime < 0)
      ) {
        throw new Error(`${label} has malformed block time`);
      }
      candidates.push({ blockTime, signature, slot: transaction.slot });
    }
    if (historyAnchorFound) break;
    if (page.length < policy.signatureHistoryPageSize) break;
    const nextCursor = page.at(-1)?.signature;
    if (typeof nextCursor !== "string" || nextCursor === cursor) {
      throw new Error("post-extension signature pagination made no progress");
    }
    cursor = nextCursor;
  }
  if (!historyAnchorFound) {
    throw new Error(
      `saved pre-extension signature anchor was not reached within ${policy.signatureHistoryMaxPages} finalized history pages; refusing unanchored recovery`,
    );
  }
  if (candidates.length !== 1) {
    throw new Error(
      `expected exactly one finalized top-level extension transaction after the saved anchor; found ${candidates.length}`,
    );
  }
  return candidates[0];
}

async function retry(operation, { attempts = 45, delayMs = 1_000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

function assertPlainObject(value, label, exactKeys) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be a plain object`);
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...exactKeys].sort();
  if (!isDeepStrictEqual(actualKeys, expectedKeys)) {
    throw new Error(`${label} fields do not match evidence schema`);
  }
  return value;
}

function assertSafeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function assertCanonicalTimestamp(value, label, nowMs, policy) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a canonical ISO-8601 timestamp`);
  }
  const timestamp = new Date(value);
  if (
    !Number.isFinite(timestamp.getTime()) ||
    timestamp.toISOString() !== value
  ) {
    throw new Error(`${label} must be a canonical ISO-8601 timestamp`);
  }
  if (timestamp.getTime() > nowMs + policy.maximumEvidenceFutureSkewMs) {
    throw new Error(`${label} is unreasonably far in the future`);
  }
  return timestamp.getTime();
}

const EXTENSION_STATE_FIELDS = Object.freeze([
  "appendedBytes",
  "appendedBytesAllZero",
  "authority",
  "checkedExtendFeatureAbsent",
  "contextSlot",
  "currentAccountBytes",
  "currentLamports",
  "excessLamports",
  "genesisHash",
  "minimumExtendActivationSlot",
  "originalPrefixSha256",
  "payerLamports",
  "payloadBytes",
  "payloadSha256",
  "programDataSlot",
  "requiredTopUpLamports",
  "rpcUrl",
  "targetAccountBytes",
  "targetRentLamports",
]);

function assertCommonExtensionState(state, rpcUrl, policy, label) {
  assertPlainObject(state, label, EXTENSION_STATE_FIELDS);
  let authority;
  try {
    authority = address(state.authority);
  } catch {
    throw new Error(`${label}.authority is not a valid address`);
  }
  if (authority !== policy.upgradeAuthority) {
    throw new Error(`${label}.authority differs from policy`);
  }
  if (state.checkedExtendFeatureAbsent !== true) {
    throw new Error(`${label} does not prove the checked feature is absent`);
  }
  const contextSlot = assertSafeInteger(
    state.contextSlot,
    `${label}.contextSlot`,
  );
  const programDataSlot = assertSafeInteger(
    state.programDataSlot,
    `${label}.programDataSlot`,
  );
  if (programDataSlot > contextSlot) {
    throw new Error(`${label}.programDataSlot is ahead of its RPC context`);
  }
  assertSafeInteger(state.currentAccountBytes, `${label}.currentAccountBytes`);
  assertSafeInteger(state.currentLamports, `${label}.currentLamports`);
  assertSafeInteger(state.excessLamports, `${label}.excessLamports`);
  assertSafeInteger(state.appendedBytes, `${label}.appendedBytes`);
  if (typeof state.appendedBytesAllZero !== "boolean") {
    throw new Error(`${label}.appendedBytesAllZero must be boolean`);
  }
  if (state.genesisHash !== policy.mainnetGenesis) {
    throw new Error(`${label}.genesisHash differs from reviewed mainnet`);
  }
  if (
    assertSafeInteger(
      state.minimumExtendActivationSlot,
      `${label}.minimumExtendActivationSlot`,
    ) !== policy.minimumExtendActivationSlot ||
    state.minimumExtendActivationSlot > contextSlot
  ) {
    throw new Error(`${label} does not bind the reviewed feature activation`);
  }
  assertSha256(state.originalPrefixSha256, `${label}.originalPrefixSha256`);
  assertSafeInteger(state.payloadBytes, `${label}.payloadBytes`);
  assertSha256(state.payloadSha256, `${label}.payloadSha256`);
  assertSafeInteger(
    state.requiredTopUpLamports,
    `${label}.requiredTopUpLamports`,
  );
  if (state.rpcUrl !== rpcUrl || normalizedRpcUrl(state.rpcUrl) !== rpcUrl) {
    throw new Error(`${label}.rpcUrl differs from its evidence endpoint`);
  }
  assertSafeInteger(state.targetAccountBytes, `${label}.targetAccountBytes`);
  assertSafeInteger(state.targetRentLamports, `${label}.targetRentLamports`);
  if (
    state.currentAccountBytes !==
      state.payloadBytes + policy.programDataMetadataBytes ||
    state.targetAccountBytes !==
      policy.requiredPayloadBytes + policy.programDataMetadataBytes ||
    state.requiredTopUpLamports !==
      Math.max(0, state.targetRentLamports - state.currentLamports) ||
    state.excessLamports !==
      Math.max(0, state.currentLamports - state.targetRentLamports)
  ) {
    throw new Error(`${label} has inconsistent capacity or rent arithmetic`);
  }
  return state;
}

function assertPreflightSnapshot(state, rpcUrl, policy, label) {
  assertPlainObject(state, label, [
    ...EXTENSION_STATE_FIELDS,
    "requiredPayerLamports",
  ]);
  const commonState = { ...state };
  delete commonState.requiredPayerLamports;
  assertCommonExtensionState(commonState, rpcUrl, policy, label);
  const requiredPayerLamports = assertSafeInteger(
    state.requiredPayerLamports,
    `${label}.requiredPayerLamports`,
  );
  const payerLamports = assertSafeInteger(
    state.payerLamports,
    `${label}.payerLamports`,
  );
  if (
    state.payloadBytes !== policy.previousPayloadCapacity ||
    state.currentAccountBytes !==
      policy.previousPayloadCapacity + policy.programDataMetadataBytes ||
    state.appendedBytes !== 0 ||
    state.appendedBytesAllZero !== true ||
    state.programDataSlot !== policy.previousProgramDataSlot ||
    state.payloadSha256 !== policy.previousPayloadSha256 ||
    state.originalPrefixSha256 !== policy.previousPayloadSha256
  ) {
    throw new Error(
      `${label} differs from the reviewed pre-extension baseline`,
    );
  }
  if (
    requiredPayerLamports !==
      state.requiredTopUpLamports + policy.minimumFeeReserveLamports ||
    payerLamports < requiredPayerLamports
  ) {
    throw new Error(`${label} has inconsistent or insufficient payer funding`);
  }
  return state;
}

function assertPostflightSnapshot(state, rpcUrl, policy, label) {
  assertCommonExtensionState(state, rpcUrl, policy, label);
  if (
    state.payerLamports !== null ||
    state.payloadBytes !== policy.requiredPayloadBytes ||
    state.currentAccountBytes !==
      policy.requiredPayloadBytes + policy.programDataMetadataBytes ||
    state.appendedBytes !== policy.additionalBytes ||
    state.appendedBytesAllZero !== true ||
    state.originalPrefixSha256 !== policy.previousPayloadSha256 ||
    state.programDataSlot <= policy.previousProgramDataSlot ||
    state.currentLamports < state.targetRentLamports ||
    state.excessLamports !== state.currentLamports - state.targetRentLamports
  ) {
    throw new Error(`${label} differs from the reviewed post-extension state`);
  }
  return state;
}

function assertCliResult(cliResult, policy, label = "cliResult") {
  assertPlainObject(cliResult, label, ["additionalBytes", "programId"]);
  if (
    cliResult.programId !== policy.program ||
    cliResult.additionalBytes !== policy.additionalBytes
  ) {
    throw new Error(`${label} does not match the reviewed extension`);
  }
  return cliResult;
}

function assertSavedTransaction(
  transaction,
  label,
  evidence,
  transactionSlot,
  policy,
  { createdAt, cliReturnedAt, completedAt, nowMs },
) {
  assertPlainObject(transaction, label, ["blockTime", "signature", "slot"]);
  assertSignature(transaction.signature, `${label}.signature`);
  const slot = assertSafeInteger(transaction.slot, `${label}.slot`);
  if (slot !== transactionSlot) {
    throw new Error(`${label}.slot does not match the ProgramData write slot`);
  }
  if (
    evidence.beforeSignatures.some(
      (entry) => entry.signature === transaction.signature,
    )
  ) {
    throw new Error(`${label}.signature predates the extension attempt`);
  }
  if (transaction.blockTime !== null) {
    const blockTime = assertSafeInteger(
      transaction.blockTime,
      `${label}.blockTime`,
    );
    if (blockTime > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)) {
      throw new Error(`${label}.blockTime is outside the safe timestamp range`);
    }
    const blockTimeMs = blockTime * 1_000;
    const clockSkew = policy.maximumTransactionClockSkewMs;
    if (
      blockTimeMs < createdAt - clockSkew ||
      blockTimeMs > (cliReturnedAt ?? completedAt) + clockSkew ||
      blockTimeMs > completedAt + clockSkew ||
      blockTimeMs > nowMs + policy.maximumEvidenceFutureSkewMs
    ) {
      throw new Error(
        `${label}.blockTime is inconsistent with the saved evidence timeline`,
      );
    }
  }
  return transaction;
}

function assertSavedPostflight(postflight, evidence, policy, timestamps) {
  assertPlainObject(postflight, "postflight", [
    "primary",
    "secondary",
    "transaction",
  ]);
  assertPostflightSnapshot(
    postflight.primary,
    evidence.primaryRpcUrl,
    policy,
    "postflight.primary",
  );
  assertPostflightSnapshot(
    postflight.secondary,
    evidence.secondaryRpcUrl,
    policy,
    "postflight.secondary",
  );
  assertMatchingPostflightStates(postflight.primary, postflight.secondary);
  assertPlainObject(postflight.transaction, "postflight.transaction", [
    "primary",
    "secondary",
  ]);
  const transactionSlot = postflight.primary.programDataSlot;
  assertSavedTransaction(
    postflight.transaction.primary,
    "postflight.transaction.primary",
    evidence,
    transactionSlot,
    policy,
    timestamps,
  );
  assertSavedTransaction(
    postflight.transaction.secondary,
    "postflight.transaction.secondary",
    evidence,
    transactionSlot,
    policy,
    timestamps,
  );
  if (
    postflight.transaction.primary.signature !==
      postflight.transaction.secondary.signature ||
    postflight.transaction.primary.slot !==
      postflight.transaction.secondary.slot
  ) {
    throw new Error(
      "independent RPCs disagree on extension transaction signature or slot",
    );
  }
  const savedContextFloor = Math.max(
    evidence.primaryPreflight.contextSlot,
    evidence.secondaryPreflight.contextSlot,
  );
  if (
    transactionSlot !== postflight.secondary.programDataSlot ||
    transactionSlot <= savedContextFloor
  ) {
    throw new Error(
      "saved postflight transaction/ProgramData slot does not advance beyond both preflight RPC contexts",
    );
  }
  return postflight;
}

const EXTENSION_EVIDENCE_FIELDS = Object.freeze([
  "beforeSignatures",
  "beforeSignaturesSha256",
  "cliReleaseArchiveSha256",
  "cliResult",
  "cliReturnedAt",
  "cliSha256",
  "completedAt",
  "createdAt",
  "evidenceVersion",
  "payerAddress",
  "policy",
  "policySha256",
  "postflight",
  "preflightSha256",
  "primaryPreflight",
  "primaryRpcUrl",
  "recordSha256",
  "secondaryPreflight",
  "secondaryRpcUrl",
  "status",
  "version",
]);

export function getExtensionEvidenceRecordSha256(evidence) {
  const record = { ...evidence };
  delete record.recordSha256;
  return sha256(Buffer.from(canonicalJson(record), "utf8"));
}

/**
 * Attach an unkeyed corruption/torn-write checksum. This is not a signature,
 * MAC, or authentication boundary: the mode-0600 file and its directory rely
 * on the local operating-system account boundary for integrity and secrecy.
 */
export function attachExtensionEvidenceChecksum(evidence) {
  const record = { ...evidence };
  delete record.recordSha256;
  return {
    ...record,
    recordSha256: getExtensionEvidenceRecordSha256(record),
  };
}

export function validateExtensionEvidence(
  evidence,
  policy = EXTENSION_POLICY,
  { nowMs = Date.now() } = {},
) {
  assertFinalArtifactBoundExtensionPolicy(policy);
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error(
      "evidence validation clock must be a safe Unix millisecond",
    );
  }
  assertPlainObject(evidence, "extension evidence", EXTENSION_EVIDENCE_FIELDS);
  if (evidence.evidenceVersion !== EXTENSION_EVIDENCE_VERSION) {
    throw new Error("extension evidence version is unsupported");
  }
  if (!isDeepStrictEqual(evidence.policy, policy)) {
    throw new Error("extension evidence policy does not match current policy");
  }
  if (
    assertSha256(evidence.policySha256, "policySha256") !==
      getExtensionPolicySha256(policy) ||
    evidence.policySha256 !== getExtensionPolicySha256(evidence.policy)
  ) {
    throw new Error("extension evidence policy hash is invalid");
  }
  if (
    assertSha256(evidence.cliSha256, "cliSha256") !==
      policy.requiredLinuxCliSha256 ||
    assertSha256(
      evidence.cliReleaseArchiveSha256,
      "cliReleaseArchiveSha256",
    ) !== policy.requiredLinuxReleaseArchiveSha256
  ) {
    throw new Error("extension evidence does not bind the pinned CLI hashes");
  }
  if (
    evidence.version !== policy.requiredCliVersionOutput ||
    assertPinnedAgaveCliVersion(evidence.version, policy) !== evidence.version
  ) {
    throw new Error("extension evidence does not bind the pinned CLI identity");
  }
  let payerAddress;
  try {
    payerAddress = address(evidence.payerAddress);
  } catch {
    throw new Error("extension evidence payerAddress is invalid");
  }
  if (payerAddress !== evidence.payerAddress) {
    throw new Error("extension evidence payerAddress is not canonical");
  }
  const primaryRpcUrl = normalizedRpcUrl(evidence.primaryRpcUrl);
  const secondaryRpcUrl = normalizedRpcUrl(evidence.secondaryRpcUrl);
  if (
    primaryRpcUrl !== evidence.primaryRpcUrl ||
    secondaryRpcUrl !== evidence.secondaryRpcUrl ||
    primaryRpcUrl === secondaryRpcUrl
  ) {
    throw new Error(
      "extension evidence does not use normalized independent RPCs",
    );
  }
  assertPreflightSnapshot(
    evidence.primaryPreflight,
    primaryRpcUrl,
    policy,
    "primaryPreflight",
  );
  assertPreflightSnapshot(
    evidence.secondaryPreflight,
    secondaryRpcUrl,
    policy,
    "secondaryPreflight",
  );
  assertMatchingPreflightStates(
    evidence.primaryPreflight,
    evidence.secondaryPreflight,
  );
  const preflightSha256 = getExtensionPreflightSha256(
    evidence.primaryPreflight,
    evidence.secondaryPreflight,
  );
  if (
    assertSha256(evidence.preflightSha256, "preflightSha256") !==
    preflightSha256
  ) {
    throw new Error("extension evidence preflight digest is invalid");
  }
  assertSignatureHistory(evidence.beforeSignatures, { exactLength: true });
  const beforeSignaturesSha256 = getExtensionSignatureHistorySha256(
    evidence.beforeSignatures,
  );
  if (
    assertSha256(evidence.beforeSignaturesSha256, "beforeSignaturesSha256") !==
    beforeSignaturesSha256
  ) {
    throw new Error("extension evidence signature-history digest is invalid");
  }
  const createdAt = assertCanonicalTimestamp(
    evidence.createdAt,
    "createdAt",
    nowMs,
    policy,
  );
  if (
    ![
      "preflight-complete-no-transaction-sent",
      "cli-returned-postflight-pending",
      "finalized-and-verified",
    ].includes(evidence.status)
  ) {
    throw new Error("extension evidence status is invalid");
  }
  let cliReturnedAt = null;
  if ((evidence.cliResult === null) !== (evidence.cliReturnedAt === null)) {
    throw new Error("extension evidence CLI result and timestamp must pair");
  }
  if (evidence.cliResult !== null) {
    assertCliResult(evidence.cliResult, policy);
    cliReturnedAt = assertCanonicalTimestamp(
      evidence.cliReturnedAt,
      "cliReturnedAt",
      nowMs,
      policy,
    );
    if (cliReturnedAt < createdAt) {
      throw new Error("cliReturnedAt precedes createdAt");
    }
  }
  if (evidence.status === "preflight-complete-no-transaction-sent") {
    if (
      evidence.cliResult !== null ||
      evidence.cliReturnedAt !== null ||
      evidence.completedAt !== null ||
      evidence.postflight !== null
    ) {
      throw new Error("preflight evidence contains later-phase fields");
    }
  } else if (evidence.status === "cli-returned-postflight-pending") {
    if (
      evidence.cliResult === null ||
      evidence.completedAt !== null ||
      evidence.postflight !== null
    ) {
      throw new Error("pending evidence has inconsistent phase fields");
    }
  } else {
    const completedAt = assertCanonicalTimestamp(
      evidence.completedAt,
      "completedAt",
      nowMs,
      policy,
    );
    if (completedAt < (cliReturnedAt ?? createdAt)) {
      throw new Error("completedAt precedes the prior evidence phase");
    }
    assertSavedPostflight(evidence.postflight, evidence, policy, {
      cliReturnedAt,
      completedAt,
      createdAt,
      nowMs,
    });
  }
  if (
    assertSha256(evidence.recordSha256, "recordSha256") !==
    getExtensionEvidenceRecordSha256(evidence)
  ) {
    throw new Error("extension evidence record digest is invalid");
  }
  return evidence;
}

export async function completeExtensionPostflight(
  evidence,
  rpc = jsonRpc,
  retryOptions,
  policy = EXTENSION_POLICY,
) {
  validateExtensionEvidence(evidence, policy);
  const [primary, secondary] = await Promise.all([
    retry(
      () =>
        verifyPostExtensionState(
          evidence.primaryRpcUrl,
          evidence.primaryPreflight,
          policy,
          rpc,
        ),
      retryOptions,
    ),
    retry(
      () =>
        verifyPostExtensionState(
          evidence.secondaryRpcUrl,
          evidence.secondaryPreflight,
          policy,
          rpc,
        ),
      retryOptions,
    ),
  ]);
  assertMatchingPostflightStates(primary, secondary);
  const [primaryTransaction, secondaryTransaction] = await Promise.all([
    retry(
      () =>
        findExtensionTransactionEvidence(
          evidence.primaryRpcUrl,
          evidence.beforeSignatures,
          evidence.payerAddress,
          policy,
          rpc,
        ),
      retryOptions,
    ),
    retry(
      () =>
        findExtensionTransactionEvidence(
          evidence.secondaryRpcUrl,
          evidence.beforeSignatures,
          evidence.payerAddress,
          policy,
          rpc,
        ),
      retryOptions,
    ),
  ]);
  if (
    primaryTransaction.signature !== secondaryTransaction.signature ||
    primaryTransaction.slot !== secondaryTransaction.slot
  ) {
    throw new Error(
      "independent RPCs disagree on extension transaction signature or slot",
    );
  }
  const savedContextFloor = Math.max(
    evidence.primaryPreflight.contextSlot,
    evidence.secondaryPreflight.contextSlot,
  );
  if (
    primaryTransaction.slot !== primary.programDataSlot ||
    primaryTransaction.slot !== secondary.programDataSlot ||
    primaryTransaction.slot <= savedContextFloor
  ) {
    throw new Error(
      `extension transaction slot ${primaryTransaction.slot} does not match a ProgramData slot newer than both saved contexts (floor ${savedContextFloor})`,
    );
  }
  return {
    primary,
    secondary,
    transaction: {
      primary: primaryTransaction,
      secondary: secondaryTransaction,
    },
  };
}

const EVIDENCE_FS = Object.freeze({
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
});

function readEvidenceBytes(path, fs = EVIDENCE_FS) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.size <= 0 ||
      stat.size > 1024 * 1024 ||
      (stat.mode & 0o777) !== 0o600
    ) {
      throw new Error(
        "extension evidence must be a non-empty regular file no larger than 1 MiB with mode 0600",
      );
    }
    return Buffer.from(fs.readFileSync(descriptor));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function fsyncEvidenceDirectory(directory, fs = EVIDENCE_FS) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      directory,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY,
    );
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function serializeEvidence(evidence, policy) {
  validateExtensionEvidence(evidence, policy);
  return Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

function assertEvidenceTransition(previous, next) {
  const allowed =
    (previous.status === "preflight-complete-no-transaction-sent" &&
      (next.status === "cli-returned-postflight-pending" ||
        next.status === "finalized-and-verified")) ||
    (previous.status === "cli-returned-postflight-pending" &&
      next.status === "finalized-and-verified");
  if (!allowed) {
    throw new Error(
      `invalid extension evidence transition ${previous.status} -> ${next.status}`,
    );
  }
  const phaseFields = new Set([
    "cliResult",
    "cliReturnedAt",
    "completedAt",
    "postflight",
    "recordSha256",
    "status",
  ]);
  for (const field of EXTENSION_EVIDENCE_FIELDS) {
    if (
      !phaseFields.has(field) &&
      !isDeepStrictEqual(previous[field], next[field])
    ) {
      throw new Error(
        `extension evidence transition changed immutable field ${field}`,
      );
    }
  }
  if (
    previous.status === "cli-returned-postflight-pending" &&
    (!isDeepStrictEqual(previous.cliResult, next.cliResult) ||
      previous.cliReturnedAt !== next.cliReturnedAt)
  ) {
    throw new Error(
      "extension evidence completion changed the saved CLI result or timestamp",
    );
  }
  if (
    previous.status === "preflight-complete-no-transaction-sent" &&
    next.status === "finalized-and-verified" &&
    (next.cliResult !== null || next.cliReturnedAt !== null)
  ) {
    throw new Error(
      "direct postflight recovery cannot invent a missing CLI result",
    );
  }
}

function acquireEvidenceTransitionLock(targetPath, fs) {
  const lockPath = `${targetPath}.lock`;
  let descriptor;
  let lockCreated = false;
  try {
    descriptor = fs.openSync(
      lockPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    lockCreated = true;
    fs.fchmodSync(descriptor, 0o600);
    const owner = Buffer.from(
      `${JSON.stringify({
        createdAt: new Date().toISOString(),
        nonce: randomBytes(16).toString("hex"),
        pid: process.pid,
      })}\n`,
      "utf8",
    );
    let written = 0;
    while (written < owner.length) {
      const count = fs.writeSync(
        descriptor,
        owner,
        written,
        owner.length - written,
      );
      if (count <= 0) throw new Error("evidence lock write made no progress");
      written += count;
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fsyncEvidenceDirectory(dirname(targetPath), fs);
    return lockPath;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the primary locking failure.
      }
    }
    if (lockCreated) {
      try {
        fs.unlinkSync(lockPath);
        fsyncEvidenceDirectory(dirname(targetPath), fs);
      } catch {
        // Preserve the primary locking failure; any survivor fails closed.
      }
    }
    if (error?.code === "EEXIST") {
      throw new Error(
        `extension evidence transition lock already exists at ${lockPath}; confirm no writer is active before manual stale-lock removal`,
      );
    }
    throw error;
  }
}

export function writeEvidenceFile(
  path,
  evidence,
  {
    exclusive = false,
    expectedPreviousEvidence,
    fs = EVIDENCE_FS,
    policy = EXTENSION_POLICY,
  } = {},
) {
  if (!exclusive && expectedPreviousEvidence === undefined) {
    throw new Error(
      "evidence replacement requires the exact expected previous record",
    );
  }
  if (exclusive && expectedPreviousEvidence !== undefined) {
    throw new Error(
      "exclusive evidence creation cannot replace a prior record",
    );
  }
  const bytes = serializeEvidence(evidence, policy);
  const expectedPreviousBytes =
    expectedPreviousEvidence === undefined
      ? null
      : serializeEvidence(expectedPreviousEvidence, policy);
  if (expectedPreviousEvidence !== undefined) {
    assertEvidenceTransition(expectedPreviousEvidence, evidence);
  }
  const targetPath = resolve(path);
  const directory = dirname(targetPath);
  const tempPath = join(
    directory,
    `.${basename(targetPath)}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`,
  );
  let descriptor;
  let tempExists = false;
  let transitionLockPath;
  try {
    if (expectedPreviousBytes !== null) {
      transitionLockPath = acquireEvidenceTransitionLock(targetPath, fs);
      const current = readEvidenceBytes(targetPath, fs);
      if (!current.equals(expectedPreviousBytes)) {
        throw new Error(
          "extension evidence changed since it was read; refusing replacement",
        );
      }
    }
    descriptor = fs.openSync(
      tempPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    tempExists = true;
    fs.fchmodSync(descriptor, 0o600);
    let written = 0;
    while (written < bytes.length) {
      const count = fs.writeSync(
        descriptor,
        bytes,
        written,
        bytes.length - written,
      );
      if (count <= 0) throw new Error("evidence write made no progress");
      written += count;
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;

    if (exclusive) {
      // link(2) publishes without replacing an existing recovery record.
      fs.linkSync(tempPath, targetPath);
      fs.unlinkSync(tempPath);
      tempExists = false;
    } else {
      const current = readEvidenceBytes(targetPath, fs);
      if (!current.equals(expectedPreviousBytes)) {
        throw new Error(
          "extension evidence changed during replacement; refusing overwrite",
        );
      }
      // The temp file is in the same directory, so rename is atomic.
      fs.renameSync(tempPath, targetPath);
      tempExists = false;
    }
    fsyncEvidenceDirectory(directory, fs);
    if (transitionLockPath !== undefined) {
      fs.unlinkSync(transitionLockPath);
      transitionLockPath = undefined;
      fsyncEvidenceDirectory(directory, fs);
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the primary persistence failure.
      }
    }
    if (tempExists) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // A crash can leave only an unpublished 0600 temp; never remove target.
      }
    }
    if (transitionLockPath !== undefined) {
      try {
        fs.unlinkSync(transitionLockPath);
        fsyncEvidenceDirectory(directory, fs);
      } catch {
        // Preserve the primary failure. A surviving lock fails closed and its
        // owner record enables deliberate stale-lock recovery.
      }
    }
    throw error;
  }
}

export function readEvidenceFile(path, policy = EXTENSION_POLICY) {
  let evidence;
  try {
    evidence = JSON.parse(readEvidenceBytes(resolve(path)).toString("utf8"));
  } catch (error) {
    throw new Error(
      `cannot read extension evidence: ${String(error.message ?? error)}`,
    );
  }
  return validateExtensionEvidence(evidence, policy);
}

function usage() {
  return [
    "Usage:",
    "  node scripts/program-extend-mainnet.mjs",
    "  node scripts/program-extend-mainnet.mjs --execute --payer-keypair <payer.json> --solana-cli <binary> --solana-cli-archive <archive> --evidence-file <json> [options]",
    "  node scripts/program-extend-mainnet.mjs --postflight-only --evidence-file <json>",
    "",
    "Options:",
    "  --solana-cli <official-agave-4.1.0-binary>",
    "  --solana-cli-archive <official-agave-4.1.0-release-archive>",
    "  --evidence-file <durable-untracked-json>",
    "  --rpc-url <credential-free-primary-https-url>",
    "  --secondary-rpc-url <credential-free-secondary-https-url>",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    execute: false,
    postflightOnly: false,
    rpcUrl: EXTENSION_POLICY.primaryRpcUrl,
    secondaryRpcUrl: EXTENSION_POLICY.secondaryRpcUrl,
    solanaCli: "solana",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute") options.execute = true;
    else if (arg === "--postflight-only") options.postflightOnly = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (
      arg === "--payer-keypair" ||
      arg === "--evidence-file" ||
      arg === "--rpc-url" ||
      arg === "--secondary-rpc-url" ||
      arg === "--solana-cli" ||
      arg === "--solana-cli-archive"
    ) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--"))
        throw new Error(`${arg} needs a value`);
      index += 1;
      const key = {
        "--payer-keypair": "payerKeypair",
        "--evidence-file": "evidenceFile",
        "--rpc-url": "rpcUrl",
        "--secondary-rpc-url": "secondaryRpcUrl",
        "--solana-cli": "solanaCli",
        "--solana-cli-archive": "solanaCliArchive",
      }[arg];
      options[key] = value;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (options.execute && options.postflightOnly) {
    throw new Error("--execute and --postflight-only are mutually exclusive");
  }
  return options;
}

function parseExtensionOutput(output, policy = EXTENSION_POLICY) {
  let document;
  try {
    document = JSON.parse(output);
  } catch {
    throw new Error("Agave extension CLI did not return JSON");
  }
  return assertCliResult(document, policy, "Agave extension CLI result");
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  const policy = dependencies.policy ?? EXTENSION_POLICY;
  if (options.help) {
    console.log(usage());
    return 0;
  }
  console.log(
    JSON.stringify(
      {
        action: "top-level-upgradeable-loader-extension",
        ...policy,
        reasonTopLevel:
          "current Agave rejects legacy ExtendProgram through CPI; this cannot be a Squads vault transaction",
        executesNow: options.execute,
        postflightOnly: options.postflightOnly,
        irreversibleRaceBoundary:
          "a third party can permissionlessly extend between preflight and inclusion; exact postflight detects but cannot undo over-extension",
      },
      null,
      2,
    ),
  );
  const rpc = dependencies.rpc ?? jsonRpc;
  const completePostflight =
    dependencies.completeExtensionPostflight ?? completeExtensionPostflight;
  if (options.postflightOnly) {
    if (!options.evidenceFile) {
      throw new Error("--postflight-only requires --evidence-file");
    }
    const evidence = readEvidenceFile(options.evidenceFile, policy);
    const postflight = await completePostflight(
      evidence,
      rpc,
      dependencies.retryOptions,
      policy,
    );
    const completed = attachExtensionEvidenceChecksum({
      ...evidence,
      completedAt: new Date().toISOString(),
      postflight,
      status: "finalized-and-verified",
    });
    writeEvidenceFile(options.evidenceFile, completed, {
      expectedPreviousEvidence: evidence,
      policy,
    });
    console.log(JSON.stringify(completed, null, 2));
    return 0;
  }
  if (!options.execute) return 0;
  assertFinalArtifactBoundExtensionPolicy(policy);
  if (!options.payerKeypair)
    throw new Error("--execute requires --payer-keypair");
  if (!options.evidenceFile)
    throw new Error("--execute requires --evidence-file");
  if (options.solanaCli === "solana") {
    throw new Error("--execute requires an explicit --solana-cli path");
  }
  if (!options.solanaCliArchive) {
    throw new Error("--execute requires --solana-cli-archive");
  }
  const primaryRpcUrl = assertCredentialFreeCliRpcUrl(options.rpcUrl);
  const secondaryRpcUrl = assertCredentialFreeCliRpcUrl(
    options.secondaryRpcUrl,
  );
  if (primaryRpcUrl === secondaryRpcUrl) {
    throw new Error("primary and secondary RPC URLs must be independent");
  }
  const spawn = dependencies.spawn ?? spawnSync;
  const cliReleaseArchiveSha256 = assertPinnedAgaveCliArchive(
    options.solanaCliArchive,
    policy,
  );
  const pinnedCli = preparePinnedAgaveCliBinary(options.solanaCli, policy);
  let pinnedPayer;
  try {
    pinnedPayer = preparePinnedPayerKeypair(options.payerKeypair);
    const cliSha256 = pinnedCli.digest;
    const version = assertPinnedAgaveCliVersion(
      runCli(pinnedCli, ["--version"], spawn),
      policy,
    );
    const payerAddress = runCli(
      pinnedCli,
      ["--keypair", pinnedPayer.childPath, "address"],
      spawn,
      pinnedPayer,
    );
    address(payerAddress);

    const [primaryPreflight, secondaryPreflight] = await Promise.all([
      verifyPreExtensionState(primaryRpcUrl, payerAddress, policy, rpc),
      verifyPreExtensionState(secondaryRpcUrl, payerAddress, policy, rpc),
    ]);
    assertMatchingPreflightStates(primaryPreflight, secondaryPreflight);
    const beforeSignatures = await getFinalizedProgramDataSignatures(
      primaryRpcUrl,
      policy,
      rpc,
    );
    const evidence = attachExtensionEvidenceChecksum({
      beforeSignatures,
      beforeSignaturesSha256:
        getExtensionSignatureHistorySha256(beforeSignatures),
      cliReleaseArchiveSha256,
      cliResult: null,
      cliReturnedAt: null,
      cliSha256,
      completedAt: null,
      createdAt: new Date().toISOString(),
      evidenceVersion: EXTENSION_EVIDENCE_VERSION,
      payerAddress,
      policy,
      policySha256: getExtensionPolicySha256(policy),
      postflight: null,
      preflightSha256: getExtensionPreflightSha256(
        primaryPreflight,
        secondaryPreflight,
      ),
      primaryPreflight,
      primaryRpcUrl,
      secondaryPreflight,
      secondaryRpcUrl,
      status: "preflight-complete-no-transaction-sent",
      version,
    });
    writeEvidenceFile(options.evidenceFile, evidence, {
      exclusive: true,
      policy,
    });
    console.log(
      JSON.stringify(
        {
          action: "verified-pre-extension",
          payerAddress,
          primary: primaryPreflight,
          secondary: secondaryPreflight,
          evidenceFileWritten: true,
          cliSha256,
          version,
        },
        null,
        2,
      ),
    );

    const cliResult = parseExtensionOutput(
      runCli(
        pinnedCli,
        buildExtensionCliArgs(
          { payerKeypair: pinnedPayer.childPath, rpcUrl: primaryRpcUrl },
          policy,
        ),
        spawn,
        pinnedPayer,
      ),
      policy,
    );
    const sentEvidence = attachExtensionEvidenceChecksum({
      ...evidence,
      cliResult,
      cliReturnedAt: new Date().toISOString(),
      status: "cli-returned-postflight-pending",
    });
    writeEvidenceFile(options.evidenceFile, sentEvidence, {
      expectedPreviousEvidence: evidence,
      policy,
    });
    const postflight = await completePostflight(
      sentEvidence,
      rpc,
      dependencies.retryOptions,
      policy,
    );
    const completedEvidence = attachExtensionEvidenceChecksum({
      ...sentEvidence,
      completedAt: new Date().toISOString(),
      postflight,
      status: "finalized-and-verified",
    });
    writeEvidenceFile(options.evidenceFile, completedEvidence, {
      expectedPreviousEvidence: sentEvidence,
      policy,
    });
    console.log(
      JSON.stringify(
        {
          action: "extension-finalized-and-two-rpc-verified",
          cliResult,
          primary: postflight.primary,
          secondary: postflight.secondary,
          transaction: postflight.transaction,
        },
        null,
        2,
      ),
    );
    return 0;
  } finally {
    pinnedPayer?.cleanup();
    pinnedCli.cleanup();
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
