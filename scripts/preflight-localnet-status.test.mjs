import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LOCALNET_PROGRAM_DESCRIPTOR_PATH,
  LOCALNET_PROGRAM_ID,
  LOCALNET_PROGRAM_LOAD_METHOD,
} from "./localnet-program-binding.mjs";
import { captureLocalnetProgramArtifact } from "./localnet-program-snapshot.mjs";
import {
  assertExpectedLocalnetBidMarketplace,
  assertExpectedLocalnetConfigs,
  assertLocalnetProgramAccountStatus,
  assertLocalnetProgramDataStatus,
  assertLocalnetMarketplaceReady,
  assertLocalnetStatusBinding,
  assertLocalnetStatusProcessIdentity,
  assertLocalnetStatusValidatorArgv,
  parseLocalnetStatusEnvironment,
  parseLocalnetStatusKeypair,
} from "./localnet-status.mjs";

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const CONFIG_ENVELOPE = Object.freeze({
  exists: true,
  executable: false,
  programAddress: LOCALNET_PROGRAM_ID,
  space: 351n,
});

function environment(overrides = {}) {
  return {
    cluster: "localnet",
    rpcUrl: "http://127.0.0.1:8899",
    rpcSubscriptionsUrl: "ws://127.0.0.1:8900",
    programId: LOCALNET_PROGRAM_ID,
    programSha256: "ab".repeat(32),
    programSize: 123,
    attestorUrl: null,
    fixturesPath: path.join(ROOT, ".localnet/fixtures.json"),
    keypairs: {
      authority: path.join(ROOT, ".localnet/keys/authority.json"),
      moderator: path.join(ROOT, ".localnet/keys/moderator.json"),
      seeder: path.join(ROOT, ".localnet/keys/seeder.json"),
    },
    ...overrides,
  };
}

function pidRecord(overrides = {}) {
  return {
    rpcPort: 8899,
    programSha256: "ab".repeat(32),
    programSize: 123,
    programLoadMethod: LOCALNET_PROGRAM_LOAD_METHOD,
    ...overrides,
  };
}

test("status environment parser rejects drift and unknown schema fields", () => {
  assert.equal(
    parseLocalnetStatusEnvironment(JSON.stringify(environment())).programId,
    LOCALNET_PROGRAM_ID,
  );
  for (const malformed of [
    environment({ cluster: "mainnet-beta" }),
    environment({ programId: "11111111111111111111111111111111" }),
    environment({ programSha256: "bogus" }),
    environment({ rpcUrl: 7 }),
    environment({ attestorUrl: "   " }),
    { ...environment(), surprise: true },
  ]) {
    assert.throws(
      () => parseLocalnetStatusEnvironment(JSON.stringify(malformed)),
      /malformed|schema/u,
    );
  }
  const secret = "raw-secret-mistaken-for-an-env-file";
  assert.throws(
    () => parseLocalnetStatusEnvironment(secret),
    (error) =>
      /contains invalid JSON/u.test(error.message) &&
      !error.message.includes(secret),
  );
});

test("status keypair parser never reflects secret input", () => {
  const secret = "raw-secret-key-material-that-must-not-reach-logs";
  assert.throws(
    () => parseLocalnetStatusKeypair(secret, "authority keypair"),
    (error) =>
      /canonical 64-byte Solana keypair/u.test(error.message) &&
      !error.message.includes(secret),
  );
  assert.deepEqual(
    parseLocalnetStatusKeypair(
      JSON.stringify(Array.from({ length: 64 }, (_, i) => i)),
    ),
    Uint8Array.from(Array.from({ length: 64 }, (_, i) => i)),
  );
});

test("status binding requires env, PID, current artifact, endpoint, and load method equality", () => {
  const env = environment();
  const pid = pidRecord();
  const artifact = { sha256: "ab".repeat(32), size: 123 };
  assert.doesNotThrow(() => assertLocalnetStatusBinding(env, pid, artifact));
  for (const [changedEnv, changedPid, changedArtifact] of [
    [environment({ rpcUrl: "http://127.0.0.1:9999" }), pid, artifact],
    [env, pidRecord({ rpcPort: 9999 }), artifact],
    [env, pidRecord({ programLoadMethod: "mutable-path" }), artifact],
    [env, pidRecord({ programSha256: "cd".repeat(32) }), artifact],
    [env, pid, { sha256: "cd".repeat(32), size: 123 }],
    [env, pid, { sha256: "ab".repeat(32), size: 124 }],
  ]) {
    assert.throws(
      () =>
        assertLocalnetStatusBinding(changedEnv, changedPid, changedArtifact),
      /do not describe one stack/u,
    );
  }
});

test("status validator argv requires the canonical private descriptor binding", () => {
  const base = [
    "solana-test-validator",
    "--ledger",
    path.join(ROOT, ".localnet/ledger"),
    "--rpc-port",
    "8899",
    "--upgradeable-program",
    LOCALNET_PROGRAM_ID,
    LOCALNET_PROGRAM_DESCRIPTOR_PATH,
    "authority",
  ];
  assert.doesNotThrow(() =>
    assertLocalnetStatusValidatorArgv(pidRecord(), base),
  );
  for (const replacement of ["/tmp/program.so", "/proc/self/fd/6"]) {
    const changed = [...base];
    changed[changed.indexOf(LOCALNET_PROGRAM_DESCRIPTOR_PATH)] = replacement;
    assert.throws(
      () => assertLocalnetStatusValidatorArgv(pidRecord(), changed),
      /private program descriptor/u,
    );
  }
});

test("status never treats a disappeared recorded validator as healthy", () => {
  assert.throws(
    () =>
      assertLocalnetStatusProcessIdentity({ ...pidRecord(), pid: 42 }, null),
    /exited during status verification/u,
  );
});

test("status program envelope rejects wrong loader ownership and link", () => {
  const programDataAddress = Buffer.alloc(32, 9);
  const programBytes = Buffer.alloc(36);
  programBytes.writeUInt32LE(2, 0);
  programDataAddress.copy(programBytes, 4);
  const valid = {
    executable: true,
    owner: LOADER,
    data: [programBytes.toString("base64"), "base64"],
  };
  assert.doesNotThrow(() =>
    assertLocalnetProgramAccountStatus(valid, programDataAddress),
  );
  assert.throws(
    () =>
      assertLocalnetProgramAccountStatus(
        { ...valid, owner: "11111111111111111111111111111111" },
        programDataAddress,
      ),
    /loader-v3/u,
  );
  const wrongLink = Buffer.alloc(32, 8);
  assert.throws(
    () => assertLocalnetProgramAccountStatus(valid, wrongLink),
    /canonical ProgramData/u,
  );
});

test("status ProgramData requires owner, authority, exact artifact, and zero capacity", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "agenc-status-programdata-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "program.so");
  const executable = Buffer.from("status-artifact");
  await writeFile(source, executable, { mode: 0o700 });
  const artifact = await captureLocalnetProgramArtifact(source);
  const authority = Buffer.alloc(32, 7);
  const header = Buffer.alloc(45);
  header.writeUInt32LE(3, 0);
  header[12] = 1;
  authority.copy(header, 13);
  const account = {
    executable: false,
    owner: LOADER,
    data: [
      Buffer.concat([header, executable, Buffer.alloc(8)]).toString("base64"),
      "base64",
    ],
  };
  assert.doesNotThrow(() =>
    assertLocalnetProgramDataStatus(account, artifact, authority),
  );
  assert.throws(
    () =>
      assertLocalnetProgramDataStatus(
        { ...account, executable: true },
        artifact,
        authority,
      ),
    /ProgramData account/u,
  );
  assert.throws(
    () =>
      assertLocalnetProgramDataStatus(account, artifact, Buffer.alloc(32, 8)),
    /upgrade authority/u,
  );
  const dirty = Buffer.from(account.data[0], "base64");
  dirty[dirty.length - 1] = 1;
  assert.throws(
    () =>
      assertLocalnetProgramDataStatus(
        { ...account, data: [dirty.toString("base64"), "base64"] },
        artifact,
        authority,
      ),
    /nonzero executable bytes/u,
  );
});

test("status config checks match localnet-up convergence values", () => {
  const expected = {
    authority: "authority",
    moderator: "moderator",
    seeder: "seeder",
    protocolBump: 250,
    moderationBump: 251,
  };
  const protocol = {
    ...CONFIG_ENVELOPE,
    data: {
      discriminator: Uint8Array.from([207, 91, 250, 28, 152, 179, 215, 209]),
      bump: 250,
      authority: "authority",
      treasury: "authority",
      disputeThreshold: 60,
      protocolFeeBps: 500,
      minAgentStake: 1_000_000n,
      minStakeForDispute: 1_000_000n,
      multisigThreshold: 2,
      multisigOwnersLen: 3,
      multisigOwners: ["authority", "moderator", "seeder"],
    },
  };
  const moderation = {
    ...CONFIG_ENVELOPE,
    space: 96n,
    data: {
      discriminator: Uint8Array.from([20, 180, 54, 96, 191, 141, 52, 148]),
      authority: "authority",
      moderationAuthority: "moderator",
      enabled: true,
      bump: 251,
    },
  };
  assert.doesNotThrow(() =>
    assertExpectedLocalnetConfigs(protocol, moderation, expected),
  );
  assert.throws(
    () =>
      assertExpectedLocalnetConfigs(
        { ...protocol, space: protocol.space + 1n },
        moderation,
        expected,
      ),
    /wrong-sized/u,
  );
  for (const changed of [
    {
      protocol: { ...protocol, data: { ...protocol.data, protocolFeeBps: 0 } },
      moderation,
    },
    {
      protocol,
      moderation: {
        ...moderation,
        data: { ...moderation.data, enabled: false },
      },
    },
    {
      protocol,
      moderation: {
        ...moderation,
        data: { ...moderation.data, moderationAuthority: "wrong" },
      },
    },
  ]) {
    assert.throws(
      () =>
        assertExpectedLocalnetConfigs(
          changed.protocol,
          changed.moderation,
          expected,
        ),
      /differs from localnet-up/u,
    );
  }
});

test("status requires the exact initialized bid marketplace policy", () => {
  const expected = { authority: "authority", bidMarketplaceBump: 252 };
  const valid = {
    ...CONFIG_ENVELOPE,
    space: 71n,
    data: {
      discriminator: Uint8Array.from([47, 42, 142, 40, 13, 39, 48, 107]),
      bump: 252,
      authority: "authority",
      minBidBondLamports: 1_000_000n,
      bidCreationCooldownSecs: 60n,
      maxBidsPer24h: 50,
      maxActiveBidsPerTask: 20,
      maxBidLifetimeSecs: 604_800n,
      acceptedNoShowSlashBps: 1_000,
    },
  };
  assert.doesNotThrow(() =>
    assertExpectedLocalnetBidMarketplace(valid, expected),
  );
  assert.throws(
    () =>
      assertExpectedLocalnetBidMarketplace(
        { ...valid, space: valid.space + 1n },
        expected,
      ),
    /wrong-sized/u,
  );
  assert.throws(
    () =>
      assertExpectedLocalnetBidMarketplace(
        {
          ...valid,
          data: { ...valid.data, acceptedNoShowSlashBps: 10_001 },
        },
        expected,
      ),
    /differs from localnet-up/u,
  );
  assert.throws(
    () =>
      assertExpectedLocalnetBidMarketplace(
        { ...valid, programAddress: "11111111111111111111111111111111" },
        expected,
      ),
    /not owned/u,
  );
  assert.throws(
    () =>
      assertExpectedLocalnetBidMarketplace(
        { ...valid, data: { ...valid.data, bump: 1 } },
        expected,
      ),
    /differs from localnet-up/u,
  );
});

test("status distinguishes integrity from operational marketplace readiness", () => {
  const ready = {
    ...CONFIG_ENVELOPE,
    data: { protocolPaused: false, surfaceRevision: 5 },
  };
  assert.doesNotThrow(() => assertLocalnetMarketplaceReady(ready, 5));
  for (const protocol of [
    {
      ...CONFIG_ENVELOPE,
      data: { protocolPaused: true, surfaceRevision: 5 },
    },
    {
      ...CONFIG_ENVELOPE,
      data: { protocolPaused: false, surfaceRevision: 0 },
    },
    { exists: false },
  ]) {
    assert.throws(
      () => assertLocalnetMarketplaceReady(protocol, 5),
      /not ready|missing/u,
    );
  }
});
