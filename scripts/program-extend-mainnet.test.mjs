import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { address, getAddressEncoder, getBase58Decoder } from "@solana/kit";

import {
  assertCredentialFreeCliRpcUrl,
  assertFinalArtifactBoundExtensionPolicy,
  assertMatchingPreflightStates,
  assertPinnedAgaveCliArchive,
  assertPinnedAgaveCliBinary,
  assertPinnedAgaveCliVersion,
  attachExtensionEvidenceChecksum,
  buildExtensionCliArgs,
  completeExtensionPostflight,
  EXTENSION_EVIDENCE_VERSION,
  EXTENSION_POLICY,
  findExtensionTransactionEvidence,
  getExtensionEvidenceRecordSha256,
  getExtensionPolicySha256,
  getExtensionPreflightSha256,
  getExtensionSignatureHistorySha256,
  main,
  preparePinnedAgaveCliBinary,
  preparePinnedPayerKeypair,
  readEvidenceFile,
  runCli,
  validateExtensionEvidence,
  verifyPostExtensionState,
  verifyPreExtensionState,
  writeEvidenceFile,
} from "./program-extend-mainnet.mjs";

const PAYER = "FhtD3rWu5aFQRLn7FGhzMWd7Xy8KBGpP7qQKJnV4wX7F";
const CREATED_AT = "2026-07-20T15:00:00.000Z";
const CLI_RETURNED_AT = "2026-07-20T15:01:00.000Z";
const COMPLETED_AT = "2026-07-20T15:02:00.000Z";
const TRANSACTION_BLOCK_TIME = Date.parse("2026-07-20T15:00:30.000Z") / 1_000;
const TEST_CANDIDATE_SBF_BYTES = 2_284_496;
const TEST_ADDITIONAL_BYTES =
  TEST_CANDIDATE_SBF_BYTES - EXTENSION_POLICY.previousPayloadCapacity;
const addressEncoder = getAddressEncoder();
const base58Decoder = getBase58Decoder();

const BOUND_TEST_POLICY = Object.freeze({
  ...EXTENSION_POLICY,
  additionalBytes: TEST_ADDITIONAL_BYTES,
  artifactBindingStatus: "reviewed-final-twice-reproduced",
  candidateSbfSha256: "ab".repeat(32),
  candidateSbfSizeBytes: TEST_CANDIDATE_SBF_BYTES,
  requiredPayloadBytes: TEST_CANDIDATE_SBF_BYTES,
});

function payloadSha256(prefixByte, payloadBytes) {
  return createHash("sha256")
    .update(Buffer.alloc(payloadBytes, prefixByte))
    .digest("hex");
}

function policyForPrefix(prefixByte = 0) {
  return Object.freeze({
    ...BOUND_TEST_POLICY,
    previousPayloadSha256: payloadSha256(
      prefixByte,
      EXTENSION_POLICY.previousPayloadCapacity,
    ),
    previousProgramDataSlot: 100,
  });
}

const TEST_POLICY = policyForPrefix();

function signatureFixture(byte) {
  return base58Decoder.decode(Buffer.alloc(64, byte));
}

function signatureHistoryFixture() {
  return Array.from({ length: 25 }, (_, index) => ({
    signature: signatureFixture(index + 1),
    slot: 99 - index,
  }));
}

function encodeAddress(value) {
  return Buffer.from(addressEncoder.encode(address(value)));
}

function upgradeableProgramFixture() {
  const data = Buffer.alloc(36);
  data.writeUInt32LE(2, 0);
  encodeAddress(EXTENSION_POLICY.programData).copy(data, 4);
  return data;
}

function programDataFixture({
  payloadBytes = EXTENSION_POLICY.previousPayloadCapacity,
  authority = EXTENSION_POLICY.upgradeAuthority,
  programDataSlot = 100,
  prefixByte = 0,
} = {}) {
  const data = Buffer.alloc(
    payloadBytes + EXTENSION_POLICY.programDataMetadataBytes,
  );
  data.writeUInt32LE(3, 0);
  data.writeBigUInt64LE(BigInt(programDataSlot), 4);
  data[12] = 1;
  if (authority === null) data[12] = 0;
  else encodeAddress(authority).copy(data, 13);
  data.fill(
    prefixByte,
    EXTENSION_POLICY.programDataMetadataBytes,
    Math.min(
      data.length,
      EXTENSION_POLICY.programDataMetadataBytes +
        EXTENSION_POLICY.previousPayloadCapacity,
    ),
  );
  return data;
}

function activeMinimumExtendFeatureFixture() {
  const data = Buffer.alloc(9);
  data[0] = 1;
  data.writeBigUInt64LE(
    BigInt(EXTENSION_POLICY.minimumExtendActivationSlot),
    1,
  );
  return {
    data: [data.toString("base64"), "base64"],
    executable: false,
    lamports: 953_520,
    owner: EXTENSION_POLICY.featureProgram,
  };
}

function systemPayerFixture(lamports) {
  return {
    data: ["", "base64"],
    executable: false,
    lamports,
    owner: EXTENSION_POLICY.systemProgram,
  };
}

function rpcFixture({
  contextSlot = 434_120_000,
  payloadBytes = EXTENSION_POLICY.previousPayloadCapacity,
  checkedFeature = null,
  payerLamports = 706_000_000,
  programDataLamports = 15_196_443_120,
  targetRentLamports = 15_901_296_240,
  linkedProgramData = true,
  minimumFeature = activeMinimumExtendFeatureFixture(),
  payerAccount,
  programDataSlot = 100,
  prefixByte = 0,
} = {}) {
  return async (_url, method, params) => {
    if (method === "getGenesisHash") return EXTENSION_POLICY.mainnetGenesis;
    if (method === "getMultipleAccounts") {
      const programBytes = upgradeableProgramFixture();
      if (!linkedProgramData) programBytes.fill(0, 4, 36);
      return {
        context: { slot: contextSlot },
        value: [
          {
            data: [programBytes.toString("base64"), "base64"],
            executable: true,
            lamports: 1,
            owner: EXTENSION_POLICY.loader,
          },
          {
            data: [
              programDataFixture({
                payloadBytes,
                prefixByte,
                programDataSlot,
              }).toString("base64"),
              "base64",
            ],
            executable: false,
            lamports: programDataLamports,
            owner: EXTENSION_POLICY.loader,
          },
          checkedFeature,
          minimumFeature,
          ...(params[0].length === 5
            ? [payerAccount ?? systemPayerFixture(payerLamports)]
            : []),
        ],
      };
    }
    if (method === "getMinimumBalanceForRentExemption") {
      return targetRentLamports;
    }
    throw new Error(`unexpected ${method}`);
  };
}

function evidenceFixture({
  policy = TEST_POLICY,
  primaryPreflight,
  secondaryPreflight,
  status = "preflight-complete-no-transaction-sent",
} = {}) {
  const beforeSignatures = signatureHistoryFixture();
  return attachExtensionEvidenceChecksum({
    beforeSignatures,
    beforeSignaturesSha256:
      getExtensionSignatureHistorySha256(beforeSignatures),
    cliReleaseArchiveSha256: policy.requiredLinuxReleaseArchiveSha256,
    cliResult:
      status === "preflight-complete-no-transaction-sent"
        ? null
        : {
            additionalBytes: policy.additionalBytes,
            programId: policy.program,
          },
    cliReturnedAt:
      status === "preflight-complete-no-transaction-sent"
        ? null
        : CLI_RETURNED_AT,
    cliSha256: policy.requiredLinuxCliSha256,
    completedAt: null,
    createdAt: CREATED_AT,
    evidenceVersion: EXTENSION_EVIDENCE_VERSION,
    payerAddress: PAYER,
    policy,
    policySha256: getExtensionPolicySha256(policy),
    postflight: null,
    preflightSha256: getExtensionPreflightSha256(
      primaryPreflight,
      secondaryPreflight,
    ),
    primaryPreflight,
    primaryRpcUrl: "https://primary.invalid/",
    secondaryPreflight,
    secondaryRpcUrl: "https://secondary.invalid/",
    status,
    version: policy.requiredCliVersionOutput,
  });
}

function reviewedPreflightFixture(rpcUrl) {
  const targetRentLamports = 15_901_296_240;
  const currentLamports = 15_196_443_120;
  const requiredTopUpLamports = targetRentLamports - currentLamports;
  return {
    appendedBytes: 0,
    appendedBytesAllZero: true,
    authority: EXTENSION_POLICY.upgradeAuthority,
    checkedExtendFeatureAbsent: true,
    contextSlot: 434_120_000,
    currentAccountBytes:
      EXTENSION_POLICY.previousPayloadCapacity +
      EXTENSION_POLICY.programDataMetadataBytes,
    currentLamports,
    excessLamports: 0,
    genesisHash: EXTENSION_POLICY.mainnetGenesis,
    minimumExtendActivationSlot: EXTENSION_POLICY.minimumExtendActivationSlot,
    originalPrefixSha256: EXTENSION_POLICY.previousPayloadSha256,
    payerLamports: 706_000_000,
    payloadBytes: EXTENSION_POLICY.previousPayloadCapacity,
    payloadSha256: EXTENSION_POLICY.previousPayloadSha256,
    programDataSlot: EXTENSION_POLICY.previousProgramDataSlot,
    requiredPayerLamports:
      requiredTopUpLamports + EXTENSION_POLICY.minimumFeeReserveLamports,
    requiredTopUpLamports,
    rpcUrl,
    targetAccountBytes:
      BOUND_TEST_POLICY.requiredPayloadBytes +
      EXTENSION_POLICY.programDataMetadataBytes,
    targetRentLamports,
  };
}

function reviewedEvidenceFixture(
  status = "preflight-complete-no-transaction-sent",
) {
  return evidenceFixture({
    policy: BOUND_TEST_POLICY,
    primaryPreflight: reviewedPreflightFixture("https://primary.invalid/"),
    secondaryPreflight: reviewedPreflightFixture("https://secondary.invalid/"),
    status,
  });
}

function reviewedPostflightFixture() {
  const createState = (rpcUrl) => ({
    appendedBytes: BOUND_TEST_POLICY.additionalBytes,
    appendedBytesAllZero: true,
    authority: EXTENSION_POLICY.upgradeAuthority,
    checkedExtendFeatureAbsent: true,
    contextSlot: 434_120_100,
    currentAccountBytes:
      BOUND_TEST_POLICY.requiredPayloadBytes +
      EXTENSION_POLICY.programDataMetadataBytes,
    currentLamports: 15_901_296_240,
    excessLamports: 0,
    genesisHash: EXTENSION_POLICY.mainnetGenesis,
    minimumExtendActivationSlot: EXTENSION_POLICY.minimumExtendActivationSlot,
    originalPrefixSha256: EXTENSION_POLICY.previousPayloadSha256,
    payerLamports: null,
    payloadBytes: BOUND_TEST_POLICY.requiredPayloadBytes,
    payloadSha256: "ab".repeat(32),
    programDataSlot: 434_120_050,
    requiredTopUpLamports: 0,
    rpcUrl,
    targetAccountBytes:
      BOUND_TEST_POLICY.requiredPayloadBytes +
      EXTENSION_POLICY.programDataMetadataBytes,
    targetRentLamports: 15_901_296_240,
  });
  return {
    primary: createState("https://primary.invalid/"),
    secondary: createState("https://secondary.invalid/"),
    transaction: {
      primary: {
        blockTime: TRANSACTION_BLOCK_TIME,
        signature: signatureFixture(90),
        slot: 434_120_050,
      },
      secondary: {
        blockTime: TRANSACTION_BLOCK_TIME,
        signature: signatureFixture(90),
        slot: 434_120_050,
      },
    },
  };
}

const EVIDENCE_FS_OPS = Object.freeze({
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

function writeReviewedEvidenceFile(path, evidence, options = {}) {
  return writeEvidenceFile(path, evidence, {
    ...options,
    policy: BOUND_TEST_POLICY,
  });
}

function readReviewedEvidenceFile(path) {
  return readEvidenceFile(path, BOUND_TEST_POLICY);
}

test("preflight binds mainnet program linkage, inactive checked feature, rent, and payer", async () => {
  const baseRpc = rpcFixture();
  let rentParams;
  const state = await verifyPreExtensionState(
    "https://rpc.invalid",
    PAYER,
    TEST_POLICY,
    async (url, method, params) => {
      if (method === "getMinimumBalanceForRentExemption") rentParams = params;
      return baseRpc(url, method, params);
    },
  );
  assert.equal(state.payloadBytes, EXTENSION_POLICY.previousPayloadCapacity);
  assert.equal(state.requiredTopUpLamports, 704_853_120);
  assert.equal(state.requiredPayerLamports, 705_853_120);
  assert.equal(state.checkedExtendFeatureAbsent, true);
  assert.deepEqual(rentParams, [
    TEST_POLICY.requiredPayloadBytes + TEST_POLICY.programDataMetadataBytes,
    { commitment: "finalized" },
  ]);
  assert.equal("minContextSlot" in rentParams[1], false);

  const prefunded = await verifyPreExtensionState(
    "https://rpc.invalid",
    PAYER,
    TEST_POLICY,
    rpcFixture({
      programDataLamports: 15_901_296_241,
      payerLamports: EXTENSION_POLICY.minimumFeeReserveLamports,
    }),
  );
  assert.equal(prefunded.requiredTopUpLamports, 0);
  assert.equal(prefunded.excessLamports, 1);
  assert.equal(
    prefunded.requiredPayerLamports,
    EXTENSION_POLICY.minimumFeeReserveLamports,
  );
});

test("preflight refuses a checked-feature activation or wrong ProgramData linkage", async () => {
  await assert.rejects(
    verifyPreExtensionState(
      "https://rpc.invalid",
      PAYER,
      TEST_POLICY,
      rpcFixture({ checkedFeature: { data: ["", "base64"] } }),
    ),
    /unexpectedly exists/,
  );
  await assert.rejects(
    verifyPreExtensionState(
      "https://rpc.invalid",
      PAYER,
      TEST_POLICY,
      rpcFixture({ linkedProgramData: false }),
    ),
    /links to ProgramData/,
  );
  await assert.rejects(
    verifyPreExtensionState(
      "https://rpc.invalid",
      PAYER,
      TEST_POLICY,
      rpcFixture({ minimumFeature: null }),
    ),
    /minimum-extend feature RPC state|not active/,
  );
  await assert.rejects(
    verifyPreExtensionState(
      "https://rpc.invalid",
      PAYER,
      TEST_POLICY,
      rpcFixture({
        payerAccount: {
          ...systemPayerFixture(706_000_000),
          owner: EXTENSION_POLICY.loader,
        },
      }),
    ),
    /payer must be a non-executable, zero-data System account/,
  );
});

test("preflight refuses duplicate extension and insufficient payer funding", async () => {
  await assert.rejects(
    verifyPreExtensionState(
      "https://rpc.invalid",
      PAYER,
      TEST_POLICY,
      rpcFixture({ payloadBytes: BOUND_TEST_POLICY.requiredPayloadBytes }),
    ),
    /duplicate or stale extension/,
  );
  await assert.rejects(
    verifyPreExtensionState(
      "https://rpc.invalid",
      PAYER,
      TEST_POLICY,
      rpcFixture({ payerLamports: 705_853_119 }),
    ),
    /payer needs at least 705853120 lamports/,
  );
});

test("postflight requires target capacity and at least the fresh rent floor", async () => {
  const policy = policyForPrefix(7);
  const preExtension = await verifyPreExtensionState(
    "https://rpc.invalid",
    PAYER,
    policy,
    rpcFixture({ prefixByte: 7, programDataSlot: 100 }),
  );
  const state = await verifyPostExtensionState(
    "https://rpc.invalid",
    preExtension,
    policy,
    rpcFixture({
      contextSlot: 434_120_100,
      payloadBytes: BOUND_TEST_POLICY.requiredPayloadBytes,
      programDataLamports: 15_901_296_240,
      prefixByte: 7,
      programDataSlot: 434_120_001,
    }),
  );
  assert.equal(state.payloadBytes, BOUND_TEST_POLICY.requiredPayloadBytes);
  assert.equal(state.appendedBytes, BOUND_TEST_POLICY.additionalBytes);
  assert.equal(state.appendedBytesAllZero, true);
  assert.equal(state.excessLamports, 0);

  // ProgramData is permissionlessly dustable. A surplus is recorded and must
  // agree across providers, but cannot make a correct irreversible extension
  // unrecoverable.
  const dusted = await verifyPostExtensionState(
    "https://rpc.invalid",
    preExtension,
    policy,
    rpcFixture({
      contextSlot: 434_120_100,
      payloadBytes: BOUND_TEST_POLICY.requiredPayloadBytes,
      programDataLamports: 15_901_296_241,
      prefixByte: 7,
      programDataSlot: 434_120_001,
    }),
  );
  assert.equal(dusted.currentLamports, 15_901_296_241);
  assert.equal(dusted.excessLamports, 1);
  await assert.rejects(
    verifyPostExtensionState(
      "https://rpc.invalid",
      preExtension,
      policy,
      rpcFixture(),
    ),
    /post-extension payload/,
  );
  await assert.rejects(
    verifyPostExtensionState(
      "https://rpc.invalid",
      preExtension,
      policy,
      rpcFixture({
        contextSlot: 434_120_100,
        payloadBytes: BOUND_TEST_POLICY.requiredPayloadBytes,
        programDataLamports: 15_901_296_240,
        prefixByte: 8,
        programDataSlot: 434_120_001,
      }),
    ),
    /changed the pre-existing.*prefix/,
  );
  await assert.rejects(
    verifyPostExtensionState(
      "https://rpc.invalid",
      preExtension,
      policy,
      rpcFixture({
        payloadBytes: BOUND_TEST_POLICY.requiredPayloadBytes,
        programDataLamports: 15_901_296_240,
        prefixByte: 7,
        programDataSlot: 100,
      }),
    ),
    /slot did not advance/,
  );
  await assert.rejects(
    verifyPostExtensionState(
      "https://rpc.invalid",
      preExtension,
      policy,
      rpcFixture({
        payloadBytes: BOUND_TEST_POLICY.requiredPayloadBytes,
        programDataLamports: 15_901_296_240,
        prefixByte: 7,
        programDataSlot: preExtension.contextSlot,
      }),
    ),
    /beyond the saved pre-extension context/,
  );
  await assert.rejects(
    verifyPostExtensionState(
      "https://rpc.invalid",
      preExtension,
      policy,
      rpcFixture({
        contextSlot: 434_120_100,
        payloadBytes: BOUND_TEST_POLICY.requiredPayloadBytes,
        programDataLamports: 15_900_516_721,
        prefixByte: 7,
        programDataSlot: 434_120_001,
      }),
    ),
    /below the freshly queried finalized rent floor/,
  );
});

test("pins the official Agave 4.1.0 CLI source", () => {
  assert.equal(
    assertPinnedAgaveCliVersion(EXTENSION_POLICY.requiredCliVersionOutput),
    EXTENSION_POLICY.requiredCliVersionOutput,
  );
  for (const output of [
    "solana-cli 3.0.13 (src:90098d26; feat:1, client:Agave)",
    "solana-cli 4.1.0 (src:deadbeef; feat:1, client:Agave)",
    "solana-cli 4.1.0 (src:d3f1f55c; feat:1, client:SolanaLabs)",
    "solana-cli 4.1.0 (src:d3f1f55c; feat:wrong, client:Agave)",
  ]) {
    assert.throws(
      () => assertPinnedAgaveCliVersion(output),
      /requires official Agave/,
    );
  }
});

test("pins executable bytes in addition to self-reported CLI version", () => {
  const digest = createHash("sha256")
    .update(readFileSync(process.execPath))
    .digest("hex");
  if (process.platform !== "linux" || process.arch !== "x64") {
    assert.throws(
      () =>
        assertPinnedAgaveCliBinary(process.execPath, {
          ...EXTENSION_POLICY,
          requiredLinuxCliSha256: digest,
        }),
      /pinned only for x86_64 Linux/,
    );
    return;
  }
  assert.equal(
    assertPinnedAgaveCliBinary(process.execPath, {
      ...EXTENSION_POLICY,
      requiredLinuxCliSha256: digest,
    }),
    digest,
  );
  assert.throws(
    () =>
      assertPinnedAgaveCliBinary(process.execPath, {
        ...EXTENSION_POLICY,
        requiredLinuxCliSha256: "0".repeat(64),
      }),
    /differs from reviewed/,
  );
});

test("measures the supplied release archive instead of copying a policy digest", () => {
  const directory = mkdtempSync(join(tmpdir(), "agenc-cli-archive-"));
  const archivePath = join(directory, "agave-release.tar.bz2");
  try {
    const archiveBytes = Buffer.from("reviewed archive fixture", "utf8");
    writeFileSync(archivePath, archiveBytes, { mode: 0o600 });
    const digest = createHash("sha256").update(archiveBytes).digest("hex");
    const policy = {
      ...EXTENSION_POLICY,
      requiredLinuxReleaseArchiveSha256: digest,
    };
    assert.equal(assertPinnedAgaveCliArchive(archivePath, policy), digest);
    writeFileSync(archivePath, "substituted archive", { mode: 0o600 });
    assert.throws(
      () => assertPinnedAgaveCliArchive(archivePath, policy),
      /differs from reviewed/,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("executes the private hash-pinned CLI inode after the supplied path changes", () => {
  if (process.platform !== "linux" || process.arch !== "x64") {
    assert.throws(
      () => preparePinnedAgaveCliBinary(process.execPath),
      /pinned only for x86_64 Linux/,
    );
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "agenc-cli-source-"));
  const sourcePath = join(directory, "solana");
  const digest = createHash("sha256")
    .update(readFileSync(process.execPath))
    .digest("hex");
  copyFileSync(process.execPath, sourcePath);
  const prepared = preparePinnedAgaveCliBinary(sourcePath, {
    ...EXTENSION_POLICY,
    requiredLinuxCliSha256: digest,
  });
  try {
    writeFileSync(sourcePath, "substituted executable", { mode: 0o700 });
    assert.equal(
      createHash("sha256")
        .update(readFileSync(prepared.executablePath))
        .digest("hex"),
      digest,
    );
    assert.equal(runCli(prepared, ["--version"]), process.version);
  } finally {
    prepared.cleanup();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("uses one unlinked payer inode after source replacement and in-place mutation", () => {
  if (process.platform !== "linux") {
    const directory = mkdtempSync(join(tmpdir(), "agenc-payer-source-"));
    const sourcePath = join(directory, "payer.json");
    try {
      writeFileSync(sourcePath, "private keypair fixture", { mode: 0o600 });
      assert.throws(
        () => preparePinnedPayerKeypair(sourcePath),
        /requires Linux \/proc/,
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "agenc-payer-source-"));
  const sourcePath = join(directory, "payer.json");
  const original = "[1,2,3,4,5,6,7,8]";
  const replacement = "[8,7,6,5,4,3,2,1]";
  writeFileSync(sourcePath, original, { mode: 0o600 });
  const prepared = preparePinnedPayerKeypair(sourcePath);
  try {
    assert.equal(prepared.childPath, "/proc/self/fd/4");

    // Mutating the original inode after preparation cannot affect the private
    // copy used by either child invocation.
    writeFileSync(sourcePath, replacement, { mode: 0o600 });
    const readPinned = [
      "-e",
      'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))',
      prepared.childPath,
    ];
    assert.equal(
      runCli(process.execPath, readPinned, undefined, prepared),
      original,
    );

    // Replacing the source pathname also cannot change the signer snapshot.
    unlinkSync(sourcePath);
    writeFileSync(sourcePath, "[9,9,9,9,9,9,9,9]", { mode: 0o600 });
    assert.equal(
      runCli(process.execPath, readPinned, undefined, prepared),
      original,
    );
  } finally {
    prepared.cleanup();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("payer pinning rejects links, broad permissions, and oversized secrets", () => {
  if (process.platform !== "linux") return;
  const directory = mkdtempSync(join(tmpdir(), "agenc-payer-policy-"));
  const sourcePath = join(directory, "payer.json");
  const linkPath = join(directory, "payer-link.json");
  try {
    writeFileSync(sourcePath, "[1,2,3]", { mode: 0o644 });
    assert.throws(
      () => preparePinnedPayerKeypair(sourcePath),
      /must not grant group or other permissions/,
    );
    chmodSync(sourcePath, 0o600);
    linkSync(sourcePath, linkPath);
    assert.throws(
      () => preparePinnedPayerKeypair(linkPath),
      /single-link regular file/,
    );
    unlinkSync(linkPath);
    writeFileSync(sourcePath, Buffer.alloc(16 * 1024 + 1), { mode: 0o600 });
    assert.throws(
      () => preparePinnedPayerKeypair(sourcePath),
      /bounded non-empty single-link regular file/,
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("execute mode derives and spends from the same pinned payer descriptor", async () => {
  if (process.platform !== "linux" || process.arch !== "x64") return;
  const directory = mkdtempSync(join(tmpdir(), "agenc-payer-main-flow-"));
  const payerPath = join(directory, "payer.json");
  const archivePath = join(directory, "agave-release.tar.bz2");
  const evidencePath = join(directory, "evidence.json");
  const originalPayerBytes = Buffer.from("[1,2,3,4,5,6,7,8]", "utf8");
  const archiveBytes = Buffer.from("reviewed archive fixture", "utf8");
  writeFileSync(payerPath, originalPayerBytes, { mode: 0o600 });
  writeFileSync(archivePath, archiveBytes, { mode: 0o600 });
  const policy = Object.freeze({
    ...TEST_POLICY,
    requiredLinuxCliSha256: createHash("sha256")
      .update(readFileSync(process.execPath))
      .digest("hex"),
    requiredLinuxReleaseArchiveSha256: createHash("sha256")
      .update(archiveBytes)
      .digest("hex"),
  });
  const baseRpc = rpcFixture();
  const rpc = async (url, method, params) => {
    if (method === "getSignaturesForAddress") return signatureHistoryFixture();
    return baseRpc(url, method, params);
  };
  let pinnedDescriptor;
  let addressCalls = 0;
  let extensionCalls = 0;
  const readDescriptor = (descriptor) => {
    const bytes = Buffer.alloc(originalPayerBytes.length);
    assert.equal(readSync(descriptor, bytes, 0, bytes.length, 0), bytes.length);
    return bytes;
  };
  const spawn = (_executable, args, options) => {
    if (args.length === 1 && args[0] === "--version") {
      return { status: 0, stdout: policy.requiredCliVersionOutput, stderr: "" };
    }
    const descriptor = options.stdio[4];
    assert.equal(Number.isInteger(descriptor), true);
    assert.deepEqual(readDescriptor(descriptor), originalPayerBytes);
    assert.equal(options.stdio[3] === "ignore", false);
    if (args.at(-1) === "address") {
      addressCalls += 1;
      pinnedDescriptor = descriptor;
      assert.deepEqual(args.slice(-3), [
        "--keypair",
        "/proc/self/fd/4",
        "address",
      ]);
      // Attack both the original inode and pathname after address derivation.
      writeFileSync(payerPath, "[8,7,6,5,4,3,2,1]", { mode: 0o600 });
      unlinkSync(payerPath);
      writeFileSync(payerPath, "[9,9,9,9,9,9,9,9]", { mode: 0o600 });
      return { status: 0, stdout: PAYER, stderr: "" };
    }
    extensionCalls += 1;
    assert.equal(descriptor, pinnedDescriptor);
    const keypairIndexes = args.flatMap((arg, index) =>
      arg === "--keypair" || arg === "--payer" ? [index + 1] : [],
    );
    assert.deepEqual(
      keypairIndexes.map((index) => args[index]),
      ["/proc/self/fd/4", "/proc/self/fd/4"],
    );
    return {
      status: 0,
      stdout: JSON.stringify({
        additionalBytes: policy.additionalBytes,
        programId: policy.program,
      }),
      stderr: "",
    };
  };
  const postflight = reviewedPostflightFixture();
  postflight.primary.rpcUrl = `${policy.primaryRpcUrl}/`;
  postflight.secondary.rpcUrl = `${policy.secondaryRpcUrl}/`;
  postflight.primary.originalPrefixSha256 = policy.previousPayloadSha256;
  postflight.secondary.originalPrefixSha256 = policy.previousPayloadSha256;
  postflight.transaction.primary.blockTime = null;
  postflight.transaction.secondary.blockTime = null;
  const originalLog = console.log;
  console.log = () => {};
  try {
    assert.equal(
      await main(
        [
          "--execute",
          "--payer-keypair",
          payerPath,
          "--solana-cli",
          process.execPath,
          "--solana-cli-archive",
          archivePath,
          "--evidence-file",
          evidencePath,
        ],
        {
          completeExtensionPostflight: async () => postflight,
          policy,
          rpc,
          spawn,
        },
      ),
      0,
    );
    assert.equal(addressCalls, 1);
    assert.equal(extensionCalls, 1);
    assert.equal(
      readEvidenceFile(evidencePath, policy).status,
      "finalized-and-verified",
    );
  } finally {
    console.log = originalLog;
    rmSync(directory, { force: true, recursive: true });
  }
});

test("default ceremony policy is bound to the twice-reproduced final artifact", async () => {
  assert.equal(
    assertFinalArtifactBoundExtensionPolicy(EXTENSION_POLICY),
    EXTENSION_POLICY,
  );
  assert.equal(EXTENSION_POLICY.candidateSbfSizeBytes, 2_303_608);
  assert.equal(EXTENSION_POLICY.additionalBytes, 120_384);
  assert.equal(
    EXTENSION_POLICY.candidateSbfSha256,
    "049a66e30da166c1e02ee379993425c32386f774fd9ff8861153e21900b496f2",
  );
  assert.throws(
    () =>
      assertFinalArtifactBoundExtensionPolicy({
        ...BOUND_TEST_POLICY,
        candidateSbfSizeBytes: BOUND_TEST_POLICY.candidateSbfSizeBytes + 1,
      }),
    /hash\/size\/capacity binding is malformed/,
  );
  const originalLog = console.log;
  console.log = () => {};
  try {
    await assert.rejects(
      main([
        "--execute",
        "--payer-keypair",
        process.execPath,
        "--solana-cli",
        process.execPath,
        "--evidence-file",
        join(tmpdir(), "unused-extension-evidence.json"),
      ]),
      /requires --solana-cli-archive/,
    );
  } finally {
    console.log = originalLog;
  }
});

test("an unbound execute policy fails before file or RPC work", async () => {
  const originalLog = console.log;
  console.log = () => {};
  try {
    await assert.rejects(
      main(
        [
          "--execute",
          "--payer-keypair",
          process.execPath,
          "--solana-cli",
          process.execPath,
          "--evidence-file",
          join(tmpdir(), "unused-extension-evidence.json"),
        ],
        {
          policy: {
            ...BOUND_TEST_POLICY,
            additionalBytes: null,
            artifactBindingStatus: "unbound-final-artifact-required",
            candidateSbfSha256: null,
            candidateSbfSizeBytes: null,
            requiredPayloadBytes: null,
          },
        },
      ),
      /disabled until a final production SBF is reproduced twice/,
    );
  } finally {
    console.log = originalLog;
  }
});

test("builds only the reviewed top-level extension command", () => {
  const args = buildExtensionCliArgs(
    {
      payerKeypair: "/reviewed/payer.json",
      rpcUrl: EXTENSION_POLICY.primaryRpcUrl,
    },
    BOUND_TEST_POLICY,
  );
  assert.deepEqual(args, [
    "--url",
    EXTENSION_POLICY.primaryRpcUrl,
    "--commitment",
    "finalized",
    "--output",
    "json",
    "--keypair",
    "/reviewed/payer.json",
    "program",
    "extend",
    EXTENSION_POLICY.program,
    String(TEST_ADDITIONAL_BYTES),
    "--payer",
    "/reviewed/payer.json",
  ]);
  assert.equal(args.includes("--skip-preflight"), false);
});

test("requires credential-free independent RPC endpoints and matching snapshots", () => {
  assert.equal(
    assertCredentialFreeCliRpcUrl("https://api.mainnet-beta.solana.com"),
    "https://api.mainnet-beta.solana.com/",
  );
  for (const value of [
    "http://rpc.example",
    "https://user:secret@rpc.example",
    "https://rpc.example/key",
    "https://rpc.example/?key=secret",
  ]) {
    assert.throws(
      () => assertCredentialFreeCliRpcUrl(value),
      /credential-free HTTPS/,
    );
  }
  const state = {
    authority: "authority",
    checkedExtendFeatureAbsent: true,
    currentAccountBytes: 1,
    currentLamports: 2,
    payloadBytes: 3,
    payloadSha256: "aa".repeat(32),
    requiredTopUpLamports: 4,
    targetAccountBytes: 5,
    targetRentLamports: 6,
  };
  assert.doesNotThrow(() => assertMatchingPreflightStates(state, { ...state }));
  assert.throws(
    () => assertMatchingPreflightStates(state, { ...state, payloadBytes: 4 }),
    /independent RPCs disagree/,
  );
  assert.throws(
    () =>
      assertMatchingPreflightStates(state, {
        ...state,
        payloadSha256: "bb".repeat(32),
      }),
    /independent RPCs disagree on payloadSha256/,
  );
});

test("recovers the exact finalized top-level loader transaction signature", async () => {
  const extensionData = Buffer.alloc(8);
  extensionData.writeUInt32LE(6, 0);
  extensionData.writeUInt32LE(BOUND_TEST_POLICY.additionalBytes, 4);
  const signature = signatureFixture(90);
  const oldSignature = signatureFixture(91);
  const accountKeys = [
    PAYER,
    EXTENSION_POLICY.programData,
    EXTENSION_POLICY.program,
    EXTENSION_POLICY.systemProgram,
    EXTENSION_POLICY.loader,
  ];
  const rpc = async (_url, method) => {
    if (method === "getSignaturesForAddress") {
      return [
        {
          blockTime: 1_700_000_000,
          err: null,
          signature,
          slot: 434_120_500,
        },
        {
          blockTime: 1_699_999_999,
          err: null,
          signature: oldSignature,
          slot: 434_120_499,
        },
      ];
    }
    if (method === "getTransaction") {
      return {
        blockTime: 1_700_000_000,
        meta: { err: null },
        slot: 434_120_500,
        transaction: {
          message: {
            accountKeys,
            instructions: [
              {
                accounts: [1, 2, 3, 0],
                data: base58Decoder.decode(extensionData),
                programIdIndex: 4,
              },
            ],
          },
          signatures: [signature],
        },
      };
    }
    throw new Error(`unexpected ${method}`);
  };
  const evidence = await findExtensionTransactionEvidence(
    "https://rpc.invalid",
    [{ signature: oldSignature, slot: 434_120_499 }],
    PAYER,
    BOUND_TEST_POLICY,
    rpc,
  );
  assert.deepEqual(evidence, {
    blockTime: 1_700_000_000,
    signature,
    slot: 434_120_500,
  });
});

test("paginates past more than 25 newer mentions until the durable preflight anchor", async () => {
  const extensionData = Buffer.alloc(8);
  extensionData.writeUInt32LE(6, 0);
  extensionData.writeUInt32LE(BOUND_TEST_POLICY.additionalBytes, 4);
  const extensionSignature = signatureFixture(90);
  const historyAnchor = signatureFixture(200);
  const entries = Array.from({ length: 31 }, (_, index) => ({
    err: { InstructionError: [0, "fixture"] },
    signature: signatureFixture(100 + index),
    slot: 500 - index,
  }));
  entries[28] = {
    blockTime: TRANSACTION_BLOCK_TIME,
    err: null,
    signature: extensionSignature,
    slot: 472,
  };
  entries[30] = { err: null, signature: historyAnchor, slot: 470 };
  const policy = {
    ...BOUND_TEST_POLICY,
    signatureHistoryMaxPages: 3,
    signatureHistoryPageSize: 25,
  };
  let historyCalls = 0;
  const rpc = async (_url, method, params) => {
    if (method === "getSignaturesForAddress") {
      historyCalls += 1;
      const options = params[1];
      const start = options.before
        ? entries.findIndex((entry) => entry.signature === options.before) + 1
        : 0;
      return entries.slice(start, start + options.limit);
    }
    if (method === "getTransaction") {
      assert.equal(params[0], extensionSignature);
      return {
        blockTime: TRANSACTION_BLOCK_TIME,
        meta: { err: null },
        slot: 472,
        transaction: {
          message: {
            accountKeys: [
              PAYER,
              EXTENSION_POLICY.programData,
              EXTENSION_POLICY.program,
              EXTENSION_POLICY.systemProgram,
              EXTENSION_POLICY.loader,
            ],
            instructions: [
              {
                accounts: [1, 2, 3, 0],
                data: base58Decoder.decode(extensionData),
                programIdIndex: 4,
              },
            ],
          },
          signatures: [extensionSignature],
        },
      };
    }
    throw new Error(`unexpected ${method}`);
  };
  const result = await findExtensionTransactionEvidence(
    "https://rpc.invalid",
    [{ signature: historyAnchor, slot: 470 }],
    PAYER,
    policy,
    rpc,
  );
  assert.equal(result.signature, extensionSignature);
  assert.equal(historyCalls, 2);
});

test("fails closed at the bounded pagination limit when the saved anchor is absent", async () => {
  const entries = Array.from({ length: 4 }, (_, index) => ({
    err: { InstructionError: [0, "fixture"] },
    signature: signatureFixture(100 + index),
    slot: 500 - index,
  }));
  const policy = {
    ...BOUND_TEST_POLICY,
    signatureHistoryMaxPages: 2,
    signatureHistoryPageSize: 2,
  };
  await assert.rejects(
    findExtensionTransactionEvidence(
      "https://rpc.invalid",
      [{ signature: signatureFixture(200), slot: 470 }],
      PAYER,
      policy,
      async (_url, method, params) => {
        assert.equal(method, "getSignaturesForAddress");
        const options = params[1];
        const start = options.before
          ? entries.findIndex((entry) => entry.signature === options.before) + 1
          : 0;
        return entries.slice(start, start + options.limit);
      },
    ),
    /saved pre-extension signature anchor was not reached/,
  );
});

test("postflight recovery verifies both RPCs and binds signature to ProgramData slot", async () => {
  const policy = policyForPrefix(7);
  const preRpc = rpcFixture({ prefixByte: 7, programDataSlot: 100 });
  const [primaryPreflight, secondaryPreflight] = await Promise.all([
    verifyPreExtensionState("https://primary.invalid", PAYER, policy, preRpc),
    verifyPreExtensionState("https://secondary.invalid", PAYER, policy, preRpc),
  ]);
  const signature = signatureFixture(90);
  const extensionData = Buffer.alloc(8);
  extensionData.writeUInt32LE(6, 0);
  extensionData.writeUInt32LE(BOUND_TEST_POLICY.additionalBytes, 4);
  const postSlot = 434_120_050;
  const historyAnchor = signatureFixture(1);
  const transactionRpcUrls = new Set();
  const postStateRpc = rpcFixture({
    contextSlot: 434_120_100,
    payloadBytes: BOUND_TEST_POLICY.requiredPayloadBytes,
    prefixByte: 7,
    programDataLamports: 15_901_296_240,
    programDataSlot: postSlot,
  });
  const rpc = async (url, method, params) => {
    if (method === "getSignaturesForAddress") {
      return [
        {
          blockTime: TRANSACTION_BLOCK_TIME,
          err: null,
          signature,
          slot: postSlot,
        },
        { err: null, signature: historyAnchor, slot: 99 },
      ];
    }
    if (method === "getTransaction") {
      transactionRpcUrls.add(url);
      return {
        blockTime: TRANSACTION_BLOCK_TIME,
        meta: { err: null },
        slot: postSlot,
        transaction: {
          message: {
            accountKeys: [
              PAYER,
              EXTENSION_POLICY.programData,
              EXTENSION_POLICY.program,
              EXTENSION_POLICY.systemProgram,
              EXTENSION_POLICY.loader,
            ],
            instructions: [
              {
                accounts: [1, 2, 3, 0],
                data: base58Decoder.decode(extensionData),
                programIdIndex: 4,
              },
            ],
          },
          signatures: [signature],
        },
      };
    }
    return postStateRpc(url, method, params);
  };
  const savedEvidence = evidenceFixture({
    policy,
    primaryPreflight,
    secondaryPreflight,
  });
  const result = await completeExtensionPostflight(
    savedEvidence,
    rpc,
    { attempts: 1, delayMs: 0 },
    policy,
  );
  assert.equal(result.primary.programDataSlot, postSlot);
  assert.equal(result.secondary.programDataSlot, postSlot);
  assert.equal(result.transaction.primary.signature, signature);
  assert.equal(result.transaction.secondary.signature, signature);
  assert.deepEqual(
    transactionRpcUrls,
    new Set(["https://primary.invalid/", "https://secondary.invalid/"]),
  );
  const independentlyDusted = await completeExtensionPostflight(
    savedEvidence,
    async (url, method, params) => {
      const result = await rpc(url, method, params);
      if (url !== "https://secondary.invalid/") return result;
      if (method === "getMultipleAccounts") {
        const changed = structuredClone(result);
        changed.value[1].lamports += 1;
        return changed;
      }
      if (method === "getSignaturesForAddress") {
        return result.map((entry, index) =>
          index === 0 ? { ...entry, blockTime: null } : entry,
        );
      }
      if (method === "getTransaction") {
        return { ...result, blockTime: null };
      }
      return result;
    },
    { attempts: 1, delayMs: 0 },
    policy,
  );
  assert.equal(independentlyDusted.primary.excessLamports, 0);
  assert.equal(independentlyDusted.secondary.excessLamports, 1);
  assert.equal(
    independentlyDusted.transaction.primary.blockTime,
    TRANSACTION_BLOCK_TIME,
  );
  assert.equal(independentlyDusted.transaction.secondary.blockTime, null);

  const otherSignature = signatureFixture(89);
  await assert.rejects(
    completeExtensionPostflight(
      savedEvidence,
      async (url, method, params) => {
        const result = await rpc(url, method, params);
        if (url !== "https://secondary.invalid/") return result;
        if (method === "getSignaturesForAddress") {
          return result.map((entry, index) =>
            index === 0 ? { ...entry, signature: otherSignature } : entry,
          );
        }
        if (method === "getTransaction") {
          return {
            ...result,
            transaction: {
              ...result.transaction,
              signatures: [otherSignature],
            },
          };
        }
        return result;
      },
      { attempts: 1, delayMs: 0 },
      policy,
    ),
    /disagree on extension transaction signature or slot/,
  );
});

test("resume evidence rejects missing, null, malformed, and hand-crafted fields", () => {
  const baseline = reviewedEvidenceFixture();
  assert.doesNotThrow(() =>
    validateExtensionEvidence(baseline, BOUND_TEST_POLICY),
  );

  const adversarialCases = [
    {
      label: "missing schema field",
      mutate(evidence) {
        delete evidence.cliSha256;
      },
    },
    {
      label: "null policy",
      mutate(evidence) {
        evidence.policy = null;
      },
    },
    {
      label: "null preflight snapshot",
      mutate(evidence) {
        evidence.primaryPreflight = null;
        evidence.preflightSha256 = getExtensionPreflightSha256(
          evidence.primaryPreflight,
          evidence.secondaryPreflight,
        );
      },
    },
    {
      label: "missing preflight snapshot field",
      mutate(evidence) {
        delete evidence.primaryPreflight.targetRentLamports;
        evidence.preflightSha256 = getExtensionPreflightSha256(
          evidence.primaryPreflight,
          evidence.secondaryPreflight,
        );
      },
    },
    {
      label: "wrong schema version",
      mutate(evidence) {
        evidence.evidenceVersion = EXTENSION_EVIDENCE_VERSION + 1;
      },
    },
    {
      label: "unpinned CLI bytes",
      mutate(evidence) {
        evidence.cliSha256 = "00".repeat(32);
      },
    },
    {
      label: "unpinned CLI archive",
      mutate(evidence) {
        evidence.cliReleaseArchiveSha256 = "00".repeat(32);
      },
    },
    {
      label: "unpinned CLI identity",
      mutate(evidence) {
        evidence.version =
          "solana-cli 4.1.0 (src:d3f1f55c; feat:forged, client:Agave)";
      },
    },
    {
      label: "malformed payer",
      mutate(evidence) {
        evidence.payerAddress = "not-a-pubkey";
      },
    },
    {
      label: "malformed timestamp",
      mutate(evidence) {
        evidence.createdAt = "2026-07-20";
      },
    },
    {
      label: "non-independent RPCs",
      mutate(evidence) {
        evidence.secondaryRpcUrl = evidence.primaryRpcUrl;
        evidence.secondaryPreflight.rpcUrl = evidence.primaryRpcUrl;
        evidence.preflightSha256 = getExtensionPreflightSha256(
          evidence.primaryPreflight,
          evidence.secondaryPreflight,
        );
      },
    },
    {
      label: "inconsistent pending status",
      mutate(evidence) {
        evidence.status = "cli-returned-postflight-pending";
      },
    },
    {
      label: "malformed signature",
      mutate(evidence) {
        evidence.beforeSignatures[0].signature = "parseable-but-not-signature";
        evidence.beforeSignaturesSha256 = getExtensionSignatureHistorySha256(
          evidence.beforeSignatures,
        );
      },
    },
    {
      label: "null signature history",
      mutate(evidence) {
        evidence.beforeSignatures = null;
        evidence.beforeSignaturesSha256 =
          getExtensionSignatureHistorySha256(null);
      },
    },
    {
      label: "duplicate signature",
      mutate(evidence) {
        evidence.beforeSignatures[1].signature =
          evidence.beforeSignatures[0].signature;
        evidence.beforeSignaturesSha256 = getExtensionSignatureHistorySha256(
          evidence.beforeSignatures,
        );
      },
    },
    {
      label: "tampered genesis",
      mutate(evidence) {
        evidence.primaryPreflight.genesisHash = "not-mainnet";
        evidence.preflightSha256 = getExtensionPreflightSha256(
          evidence.primaryPreflight,
          evidence.secondaryPreflight,
        );
      },
    },
    {
      label: "reduced prior slot cannot bypass advancement",
      mutate(evidence) {
        evidence.primaryPreflight.programDataSlot = 1;
        evidence.secondaryPreflight.programDataSlot = 1;
        evidence.preflightSha256 = getExtensionPreflightSha256(
          evidence.primaryPreflight,
          evidence.secondaryPreflight,
        );
      },
    },
    {
      label: "tampered prior payload hash",
      mutate(evidence) {
        evidence.primaryPreflight.payloadSha256 = "cd".repeat(32);
        evidence.primaryPreflight.originalPrefixSha256 = "cd".repeat(32);
        evidence.secondaryPreflight.payloadSha256 = "cd".repeat(32);
        evidence.secondaryPreflight.originalPrefixSha256 = "cd".repeat(32);
        evidence.preflightSha256 = getExtensionPreflightSha256(
          evidence.primaryPreflight,
          evidence.secondaryPreflight,
        );
      },
    },
    {
      label: "tampered rent arithmetic",
      mutate(evidence) {
        evidence.primaryPreflight.requiredTopUpLamports += 1;
        evidence.secondaryPreflight.requiredTopUpLamports += 1;
        evidence.primaryPreflight.requiredPayerLamports += 1;
        evidence.secondaryPreflight.requiredPayerLamports += 1;
        evidence.preflightSha256 = getExtensionPreflightSha256(
          evidence.primaryPreflight,
          evidence.secondaryPreflight,
        );
      },
    },
    {
      label: "internally rehashed policy still differs from reviewed source",
      mutate(evidence) {
        evidence.policy = {
          ...evidence.policy,
          previousProgramDataSlot: evidence.policy.previousProgramDataSlot - 1,
        };
        evidence.policySha256 = getExtensionPolicySha256(evidence.policy);
      },
    },
  ];

  for (const { label, mutate } of adversarialCases) {
    const evidence = structuredClone(baseline);
    mutate(evidence);
    const rechecksummed = attachExtensionEvidenceChecksum(evidence);
    assert.throws(
      () => validateExtensionEvidence(rechecksummed, BOUND_TEST_POLICY),
      undefined,
      label,
    );
  }

  const digestTamper = structuredClone(baseline);
  digestTamper.createdAt = "2026-07-20T15:00:01.000Z";
  assert.throws(
    () => validateExtensionEvidence(digestTamper, BOUND_TEST_POLICY),
    /record digest/,
  );
  assert.equal(
    baseline.recordSha256,
    getExtensionEvidenceRecordSha256(baseline),
  );
});

test("completed evidence binds timestamps, snapshots, and transaction", () => {
  const preflight = reviewedEvidenceFixture("cli-returned-postflight-pending");
  const postflight = reviewedPostflightFixture();
  const completed = attachExtensionEvidenceChecksum({
    ...preflight,
    completedAt: COMPLETED_AT,
    postflight,
    status: "finalized-and-verified",
  });
  assert.doesNotThrow(() =>
    validateExtensionEvidence(completed, BOUND_TEST_POLICY),
  );

  // Both Solana RPC methods canonically permit a null blockTime. Slot,
  // signature, anchored history, and identical two-provider transaction bytes
  // still provide the required ordering/attribution proof.
  const nullTimePostflight = structuredClone(postflight);
  nullTimePostflight.transaction.primary.blockTime = null;
  nullTimePostflight.transaction.secondary.blockTime = null;
  const nullTimeCompleted = attachExtensionEvidenceChecksum({
    ...preflight,
    completedAt: COMPLETED_AT,
    postflight: nullTimePostflight,
    status: "finalized-and-verified",
  });
  assert.doesNotThrow(() =>
    validateExtensionEvidence(nullTimeCompleted, BOUND_TEST_POLICY),
  );
  const mixedTimePostflight = structuredClone(postflight);
  mixedTimePostflight.transaction.primary.blockTime = null;
  const mixedTimeCompleted = attachExtensionEvidenceChecksum({
    ...preflight,
    completedAt: COMPLETED_AT,
    postflight: mixedTimePostflight,
    status: "finalized-and-verified",
  });
  assert.doesNotThrow(() =>
    validateExtensionEvidence(mixedTimeCompleted, BOUND_TEST_POLICY),
  );
  const independentlyDustedPostflight = structuredClone(postflight);
  independentlyDustedPostflight.secondary.currentLamports += 1;
  independentlyDustedPostflight.secondary.excessLamports += 1;
  const independentlyDustedCompleted = attachExtensionEvidenceChecksum({
    ...preflight,
    completedAt: COMPLETED_AT,
    postflight: independentlyDustedPostflight,
    status: "finalized-and-verified",
  });
  assert.doesNotThrow(() =>
    validateExtensionEvidence(independentlyDustedCompleted, BOUND_TEST_POLICY),
  );

  for (const mutate of [
    (evidence) => {
      evidence.completedAt = "2026-07-20T14:59:00.000Z";
    },
    (evidence) => {
      evidence.postflight.primary.programDataSlot =
        EXTENSION_POLICY.previousProgramDataSlot;
    },
    (evidence) => {
      evidence.postflight.secondary.excessLamports += 1;
    },
    (evidence) => {
      evidence.postflight.transaction.primary.slot += 1;
    },
    (evidence) => {
      evidence.postflight.transaction.primary.signature =
        evidence.beforeSignatures[0].signature;
    },
    (evidence) => {
      const staleSlot = evidence.primaryPreflight.contextSlot;
      evidence.postflight.primary.programDataSlot = staleSlot;
      evidence.postflight.secondary.programDataSlot = staleSlot;
      evidence.postflight.transaction.primary.slot = staleSlot;
      evidence.postflight.transaction.secondary.slot = staleSlot;
    },
    (evidence) => {
      evidence.postflight.transaction.secondary.signature =
        signatureFixture(89);
    },
    (evidence) => {
      evidence.postflight.transaction.primary.blockTime =
        Date.parse("2026-07-20T14:00:00.000Z") / 1_000;
      evidence.postflight.transaction.secondary.blockTime =
        evidence.postflight.transaction.primary.blockTime;
    },
  ]) {
    const evidence = structuredClone(completed);
    mutate(evidence);
    assert.throws(() =>
      validateExtensionEvidence(
        attachExtensionEvidenceChecksum(evidence),
        BOUND_TEST_POLICY,
      ),
    );
  }
});

test("rejects a write newer than only the lower of unequal preflight contexts", () => {
  const pending = structuredClone(
    reviewedEvidenceFixture("cli-returned-postflight-pending"),
  );
  pending.secondaryPreflight.contextSlot = 434_120_060;
  pending.preflightSha256 = getExtensionPreflightSha256(
    pending.primaryPreflight,
    pending.secondaryPreflight,
  );
  const completed = attachExtensionEvidenceChecksum({
    ...pending,
    completedAt: COMPLETED_AT,
    postflight: reviewedPostflightFixture(),
    status: "finalized-and-verified",
  });
  assert.ok(
    completed.postflight.transaction.primary.slot >
      completed.primaryPreflight.contextSlot,
  );
  assert.ok(
    completed.postflight.transaction.primary.slot <=
      completed.secondaryPreflight.contextSlot,
  );
  assert.throws(
    () => validateExtensionEvidence(completed, BOUND_TEST_POLICY),
    /does not advance beyond both preflight RPC contexts/,
  );
});

test("evidence timestamps reject future records and impossible transaction chronology", () => {
  const nowMs = Date.parse("2026-07-20T16:00:00.000Z");
  const baseline = reviewedEvidenceFixture();
  const future = attachExtensionEvidenceChecksum({
    ...baseline,
    createdAt: "2026-07-20T16:05:00.001Z",
  });
  assert.throws(
    () => validateExtensionEvidence(future, BOUND_TEST_POLICY, { nowMs }),
    /unreasonably far in the future/,
  );

  const pending = reviewedEvidenceFixture("cli-returned-postflight-pending");
  const postflight = reviewedPostflightFixture();
  for (const blockTime of [
    Date.parse("2026-07-20T14:54:59.000Z") / 1_000,
    Date.parse("2026-07-20T15:07:01.000Z") / 1_000,
  ]) {
    const changed = structuredClone(postflight);
    changed.transaction.primary.blockTime = blockTime;
    changed.transaction.secondary.blockTime = blockTime;
    const completed = attachExtensionEvidenceChecksum({
      ...pending,
      completedAt: COMPLETED_AT,
      postflight: changed,
      status: "finalized-and-verified",
    });
    assert.throws(
      () => validateExtensionEvidence(completed, BOUND_TEST_POLICY, { nowMs }),
      /inconsistent with the saved evidence timeline/,
    );
  }
});

test("postflight validates saved evidence before issuing any RPC", async () => {
  const evidence = structuredClone(reviewedEvidenceFixture());
  evidence.primaryPreflight.programDataSlot = 1;
  evidence.secondaryPreflight.programDataSlot = 1;
  evidence.preflightSha256 = getExtensionPreflightSha256(
    evidence.primaryPreflight,
    evidence.secondaryPreflight,
  );
  const forged = attachExtensionEvidenceChecksum(evidence);
  let rpcCalls = 0;
  await assert.rejects(
    completeExtensionPostflight(
      forged,
      async () => {
        rpcCalls += 1;
        throw new Error("RPC must not be reached");
      },
      { attempts: 1, delayMs: 0 },
      BOUND_TEST_POLICY,
    ),
    /reviewed pre-extension baseline/,
  );
  assert.equal(rpcCalls, 0);
});

test("evidence persistence is durable, mode-safe, atomic, and non-destructive", () => {
  const directory = mkdtempSync(join(tmpdir(), "agenc-extension-evidence-"));
  const evidencePath = join(directory, "evidence.json");
  try {
    const initial = reviewedEvidenceFixture();
    const interruptedInitialPath = join(directory, "interrupted.json");
    assert.throws(
      () =>
        writeReviewedEvidenceFile(interruptedInitialPath, initial, {
          exclusive: true,
          fs: {
            ...EVIDENCE_FS_OPS,
            linkSync() {
              throw new Error("simulated interruption before publication");
            },
          },
        }),
      /simulated interruption/,
    );
    assert.deepEqual(readdirSync(directory), []);

    let fsyncCalls = 0;
    writeReviewedEvidenceFile(evidencePath, initial, {
      exclusive: true,
      fs: {
        ...EVIDENCE_FS_OPS,
        fsyncSync(descriptor) {
          fsyncCalls += 1;
          fsyncSync(descriptor);
        },
      },
    });
    assert.ok(fsyncCalls >= 2, "file and directory must both be fsynced");
    assert.equal(statSync(evidencePath).mode & 0o777, 0o600);
    assert.deepEqual(readReviewedEvidenceFile(evidencePath), initial);

    const originalBytes = readFileSync(evidencePath);
    assert.throws(
      () =>
        writeReviewedEvidenceFile(evidencePath, initial, { exclusive: true }),
      /EEXIST/,
    );
    assert.deepEqual(readFileSync(evidencePath), originalBytes);

    const pending = reviewedEvidenceFixture("cli-returned-postflight-pending");
    assert.throws(
      () =>
        writeReviewedEvidenceFile(evidencePath, pending, {
          expectedPreviousEvidence: initial,
          fs: {
            ...EVIDENCE_FS_OPS,
            renameSync() {
              throw new Error("simulated interruption before atomic rename");
            },
          },
        }),
      /simulated interruption/,
    );
    assert.deepEqual(readFileSync(evidencePath), originalBytes);
    assert.deepEqual(readdirSync(directory), ["evidence.json"]);

    const competingPending = attachExtensionEvidenceChecksum({
      ...pending,
      cliReturnedAt: "2026-07-20T15:01:30.000Z",
    });
    let competingError;
    writeReviewedEvidenceFile(evidencePath, pending, {
      expectedPreviousEvidence: initial,
      fs: {
        ...EVIDENCE_FS_OPS,
        renameSync(from, to) {
          try {
            writeReviewedEvidenceFile(evidencePath, competingPending, {
              expectedPreviousEvidence: initial,
            });
          } catch (error) {
            competingError = error;
          }
          renameSync(from, to);
        },
      },
    });
    assert.match(
      String(competingError?.message),
      /transition lock already exists/,
    );
    assert.deepEqual(readReviewedEvidenceFile(evidencePath), pending);
    assert.throws(
      () =>
        writeReviewedEvidenceFile(evidencePath, competingPending, {
          expectedPreviousEvidence: initial,
        }),
      /changed since it was read/,
    );
    assert.throws(
      () =>
        writeReviewedEvidenceFile(evidencePath, initial, {
          expectedPreviousEvidence: pending,
        }),
      /invalid extension evidence transition/,
    );

    chmodSync(evidencePath, 0o644);
    assert.throws(() => readReviewedEvidenceFile(evidencePath), /mode 0600/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("postflight-only recovery atomically advances valid saved evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agenc-extension-recovery-"));
  const evidencePath = join(directory, "evidence.json");
  const initial = reviewedEvidenceFixture();
  const postflight = reviewedPostflightFixture();
  try {
    writeReviewedEvidenceFile(evidencePath, initial, { exclusive: true });
    const originalLog = console.log;
    console.log = () => {};
    try {
      await main(["--postflight-only", "--evidence-file", evidencePath], {
        completeExtensionPostflight: async (evidence) => {
          assert.deepEqual(evidence, initial);
          return postflight;
        },
        policy: BOUND_TEST_POLICY,
      });
    } finally {
      console.log = originalLog;
    }
    const completed = readReviewedEvidenceFile(evidencePath);
    assert.equal(completed.status, "finalized-and-verified");
    assert.deepEqual(completed.postflight, postflight);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
