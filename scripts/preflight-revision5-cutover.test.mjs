import assert from "node:assert/strict";
import test from "node:test";
import {
  assertIdlMatchesProgramInstructions,
  anchorIdlStoragePlan,
  assertDeployBufferSnapshotUnchanged,
  assertPinnedAnchorCliVersion,
  assertPinnedSolanaCliVersion,
  assertProductionCargoFeaturePolicy,
  assertProgramDataCapacityUnchanged,
  assertProgramSurfaceReleasePolicy,
  assertRevision5CutoverResults,
  assertRevision5Paused,
  assertSafeSelectedSteps,
  assertTreasuryAccountBoundary,
  assessProgramDataCapacity,
  captureConfirmedContextSlot,
  calculateUpgradeFunding,
  createContextPinnedConnection,
  deriveFullProgramInstructionNames,
  deriveProgramInstructionNames,
  decodeClockUnixTimestamp,
  decodeReviewedDeployBufferAccount,
  loaderRentDataLengths,
  parseSelectedSteps,
  rentLamports,
  scanStableRevision5CompletionBondCutover,
  withPinnedRevision5CutoverContext,
} from "./mainnet-upgrade.mjs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const { PublicKey } = require("@solana/web3.js");

const PROGRAM_ID = new PublicKey(
  "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK",
);
const TEST_ADDRESS = new PublicKey(
  "4tA32m8FRM1mVKTasuiEvbRksBJTGBvwF9jsT4WLM84n",
);

test("IDL content measurement defers first-init capacity rejection until account state is known", () => {
  const opaque = [];
  let measured = null;
  for (let index = 0; index < 2_000; index++) {
    opaque.push(createHash("sha256").update(`idl-growth-${index}`).digest("hex"));
    if (index % 25 !== 0) continue;
    measured = anchorIdlStoragePlan({ opaque });
    if (measured.compressedLength > 29_956) break;
  }
  assert.ok(measured.compressedLength > 29_956);
  assert.ok(measured.compressedLength <= 32_665);
  assert.equal(measured.initFeasible, false);
  assert.ok(measured.conservativeCompressedBound <= 65_330);
});

test("resumable deploy Buffer accepts only exact reviewed allocation and bytes", () => {
  const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const binary = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 9, 8, 7, 6]);
  const data = Buffer.alloc(37 + binary.length);
  data.writeUInt32LE(1, 0);
  data[4] = 1;
  TEST_ADDRESS.toBuffer().copy(data, 5);
  binary.subarray(0, 4).copy(data, 37);
  const account = {
    data,
    executable: false,
    lamports: 10_000,
    owner: loader,
  };
  const options = {
    expectedAuthority: TEST_ADDRESS,
    loaderProgramId: loader,
    reviewedBinary: binary,
    requiredFundingLamports: 9_000n,
  };
  const decoded = decodeReviewedDeployBufferAccount(account, options);
  assert.equal(decoded.exists, true);
  assert.equal(decoded.dataLength, 37 + binary.length);
  assert.equal(
    decodeReviewedDeployBufferAccount(null, options).exists,
    false,
  );

  assert.throws(
    () =>
      decodeReviewedDeployBufferAccount(
        { ...account, data: Buffer.concat([data, Buffer.from([1])]) },
        options,
      ),
    /data length .* exact reviewed allocation/,
  );
  const foreign = Buffer.from(data);
  foreign[37 + 5] = 0xff;
  assert.throws(
    () =>
      decodeReviewedDeployBufferAccount(
        { ...account, data: foreign },
        options,
      ),
    /neither zero nor the reviewed SBF byte/,
  );
  assert.throws(
    () =>
      decodeReviewedDeployBufferAccount(
        { ...account, lamports: 8_999 },
        options,
      ),
    /below the reviewed CLI funding floor/,
  );

  const initial = {
    ...decoded,
    address: TEST_ADDRESS.toBase58(),
    contextSlot: 100,
  };
  assert.doesNotThrow(() =>
    assertDeployBufferSnapshotUnchanged(initial, {
      ...initial,
      contextSlot: 101,
    }),
  );
  assert.throws(
    () =>
      assertDeployBufferSnapshotUnchanged(initial, {
        ...initial,
        accountDataSha256: "00".repeat(32),
        contextSlot: 101,
      }),
    /accountDataSha256 changed/,
  );
});

function protocolConfigAccount({ paused = true, mask = 14 } = {}) {
  const data = Buffer.alloc(351);
  createHash("sha256")
    .update("account:ProtocolConfig")
    .digest()
    .subarray(0, 8)
    .copy(data, 0);
  TEST_ADDRESS.toBuffer().copy(data, 8);
  TEST_ADDRESS.toBuffer().copy(data, 40);
  data[8 + 132] = 2;
  data[8 + 133] = 0;
  data[8 + 179] = paused ? 1 : 0;
  data[8 + 180] = mask;
  data.writeUInt16LE(5, 8 + 341);
  return {
    data,
    executable: false,
    lamports: 1_000_000,
    owner: PROGRAM_ID,
    rentEpoch: 0,
  };
}

test("execute-mode step safety rejects a deploy-only frozen-window sequence", () => {
  const pending = {
    deploy: { needed: true, done: false },
    sweep: { needed: true, done: false },
  };

  assert.throws(
    () => assertSafeSelectedSteps(["deploy"], pending, { execute: true }),
    /UNSAFE STEP SUBSET.*sweep.*immediately follows.*deploy/s,
  );
  assert.throws(
    () =>
      assertSafeSelectedSteps(["deploy", "init", "sweep"], pending, {
        execute: true,
      }),
    /UNSAFE STEP SUBSET/,
    "a non-adjacent sweep must not normalize an unsafe execution order",
  );
});

test("execute-mode step safety accepts the immediate deploy-to-sweep sequence", () => {
  const pending = {
    deploy: { needed: true, done: false },
    sweep: { needed: true, done: false },
  };

  assert.doesNotThrow(() =>
    assertSafeSelectedSteps(["deploy", "sweep"], pending, { execute: true }),
  );
  assert.doesNotThrow(() =>
    assertSafeSelectedSteps(
      ["deploy", "sweep", "init", "idl", "stamp"],
      pending,
      { execute: true },
    ),
  );
});

test("selected steps reject empty input and canonicalize the release order", () => {
  assert.deepEqual(parseSelectedSteps(undefined), [
    "deploy",
    "sweep",
    "init",
    "idl",
    "stamp",
  ]);
  assert.deepEqual(parseSelectedSteps("stamp, idl,idl"), ["idl", "stamp"]);
  assert.throws(() => parseSelectedSteps(", ,"), /at least one step/);
  assert.throws(() => parseSelectedSteps("deploy,nope"), /unknown step 'nope'/);
});

test("selected-step safety preserves safe resume and plan-only cases", () => {
  const pending = {
    deploy: { needed: true, done: false },
    sweep: { needed: true, done: false },
  };
  assert.doesNotThrow(() =>
    assertSafeSelectedSteps(["deploy"], pending, { execute: false }),
  );
  assert.doesNotThrow(
    () =>
      assertSafeSelectedSteps(
        ["deploy"],
        {
          deploy: { needed: false, done: true },
          sweep: { needed: true, done: false },
        },
        { execute: true },
      ),
    "an already-live approved binary cannot open a new frozen window",
  );
  assert.doesNotThrow(
    () =>
      assertSafeSelectedSteps(
        ["deploy"],
        {
          deploy: { needed: true, done: false },
          sweep: { needed: false, done: true },
        },
        { execute: true },
      ),
    "a completed migration has no legacy typed-account freeze to close",
  );
});

test("program upgrade preflight fails closed on insufficient loader capacity", () => {
  assert.deepEqual(assessProgramDataCapacity(2_237_432, 2_183_224), {
    binaryBytes: 2_237_432,
    capacityBytes: 2_183_224,
    shortfallBytes: 54_208,
    extensionBytes: 54_208,
    maximumProgramBytes: 10 * 1024 * 1024 - 45,
  });
  assert.equal(
    assessProgramDataCapacity(2_183_225, 2_183_224).extensionBytes,
    10 * 1024,
  );
  assert.equal(
    assessProgramDataCapacity(2_183_224, 2_183_224).shortfallBytes,
    0,
  );
  assert.throws(
    () => assessProgramDataCapacity(-1, 0),
    /binaryBytes must be a non-negative safe integer/,
  );
  assert.throws(
    () => assessProgramDataCapacity(10 * 1024 * 1024, 0),
    /exceeds loader maximum/,
  );
  const maximumProgramBytes = 10 * 1024 * 1024 - 45;
  assert.equal(
    assessProgramDataCapacity(maximumProgramBytes, maximumProgramBytes - 1)
      .extensionBytes,
    1,
  );
  assert.deepEqual(
    assessProgramDataCapacity(
      maximumProgramBytes - 4_000,
      maximumProgramBytes - 5_000,
    ),
    {
      binaryBytes: maximumProgramBytes - 4_000,
      capacityBytes: maximumProgramBytes - 5_000,
      shortfallBytes: 1_000,
      extensionBytes: 5_000,
      maximumProgramBytes,
    },
    "a sub-10-KiB extension near the account limit must consume all headroom",
  );
  assert.throws(
    () => assessProgramDataCapacity(1, maximumProgramBytes + 1),
    /capacity .* exceeds loader maximum/,
  );

  const upgradeSource = readFileSync(
    new URL("./mainnet-upgrade.mjs", import.meta.url),
    "utf8",
  );
  assert.match(upgradeSource, /refuses implicit auto-extension/);
  assert.equal(
    upgradeSource.match(/--no-auto-extend/g)?.length,
    2,
    "printed and executed direct-deploy commands must both disable auto-extension",
  );
  assert.match(
    upgradeSource,
    /plan\.deploy\.needed && !pf\.canDirectDeploy/,
    "a Squads PDA authority must never fall through to the direct CLI deploy",
  );
});

test("pins reviewed CLI semantics and obtains rent from the genesis-checked RPC", async () => {
  assert.equal(
    assertPinnedSolanaCliVersion(
      "solana-cli 3.0.13 (src:90098d26; feat:3604001754, client:Agave)",
    ),
    "3.0.13",
  );
  assert.throws(
    () => assertPinnedSolanaCliVersion("solana-cli 3.1.13 (src:437252f)"),
    /3\.1\.13 != reviewed 3\.0\.13/,
  );
  assert.throws(
    () => assertPinnedSolanaCliVersion("not-solana 3.0.13"),
    /could not parse/,
  );
  assert.equal(assertPinnedAnchorCliVersion("anchor-cli 0.32.1"), "0.32.1");
  assert.throws(
    () => assertPinnedAnchorCliVersion("anchor-cli 0.31.1"),
    /0\.31\.1 != reviewed 0\.32\.1/,
  );
  assert.throws(
    () => assertPinnedAnchorCliVersion("anchor 0.32.1"),
    /could not parse/,
  );
  assert.throws(
    () => assertPinnedAnchorCliVersion("anchor-cli 0.32.1 unexpected"),
    /could not parse/,
  );

  const calls = [];
  const connection = {
    async getMinimumBalanceForRentExemption(bytes) {
      calls.push(bytes);
      return 1_234_567;
    },
  };
  assert.equal(await rentLamports(connection, 45), 1_234_567n);
  assert.deepEqual(calls, [45]);
  await assert.rejects(() => rentLamports(connection, -1), /non-negative/);

  assert.deepEqual(loaderRentDataLengths(2_237_432, 2_300_000), {
    programData: 2_300_045,
    bufferAllocation: 2_237_469,
    cliBufferFunding: 2_237_477,
  });
});

test("peak funding includes temporary IDL and permanent singleton/IDL rent", () => {
  assert.deepEqual(
    calculateUpgradeFunding({
      deployBufferRent: 10n,
      migrateRent: 20n,
      releaseSingletonRent: 30n,
      idlTemporaryBufferRent: 40n,
      idlPermanentRent: 50n,
      feeBudget: 60n,
      programDataTopUp: 70n,
    }),
    {
      peakLamports: 210n,
      netPermanentLamports: 230n,
    },
  );
  assert.throws(
    () =>
      calculateUpgradeFunding({
        deployBufferRent: -1n,
        migrateRent: 0n,
        releaseSingletonRent: 0n,
        idlTemporaryBufferRent: 0n,
        idlPermanentRent: 0n,
        feeBudget: 0n,
        programDataTopUp: 0n,
      }),
    /deployBufferRent must be a non-negative bigint/,
  );
});

test("Clock freshness input requires the exact non-executable sysvar account", () => {
  const sysvarOwner = new PublicKey(
    "Sysvar1111111111111111111111111111111111111",
  );
  const data = Buffer.alloc(40);
  data.writeBigInt64LE(1_234n, 32);
  const account = { data, executable: false, owner: sysvarOwner };
  assert.equal(decodeClockUnixTimestamp(account), 1_234n);
  assert.throws(
    () => decodeClockUnixTimestamp({ ...account, data: Buffer.alloc(41) }),
    /length 41 != 40/,
  );
  assert.throws(
    () => decodeClockUnixTimestamp({ ...account, owner: PublicKey.default }),
    /Clock sysvar owner/,
  );
  assert.throws(
    () => decodeClockUnixTimestamp({ ...account, executable: true }),
    /must not be executable/,
  );
});

test("context-pinned scanner reads propagate and ratchet minContextSlot", async () => {
  const calls = [];
  const rpc = {
    async getAccountInfoAndContext(_key, config) {
      calls.push(["account", config]);
      return { context: { slot: 101 }, value: { kind: "account" } };
    },
    async getProgramAccounts(_program, config) {
      calls.push(["program", config]);
      return { context: { slot: 103 }, value: [] };
    },
    async getMultipleAccountsInfoAndContext(_keys, config) {
      calls.push(["multiple", config]);
      return { context: { slot: 105 }, value: [] };
    },
    async getSlot(config) {
      calls.push(["slot", config]);
      return 107;
    },
  };
  const pinned = createContextPinnedConnection(rpc, 100, "test scan");

  assert.deepEqual(
    await pinned.connection.getAccountInfo(TEST_ADDRESS, "confirmed"),
    { kind: "account" },
  );
  assert.deepEqual(
    await pinned.connection.getProgramAccounts(PROGRAM_ID, {
      filters: [{ dataSize: 8 }],
    }),
    [],
  );
  assert.deepEqual(
    await pinned.connection.getMultipleAccountsInfo([], {
      commitment: "finalized",
      minContextSlot: 104,
    }),
    [],
  );
  assert.equal(await pinned.connection.getSlot("confirmed"), 107);
  assert.equal(pinned.getMinContextSlot(), 107);

  assert.deepEqual(calls[0], [
    "account",
    { commitment: "confirmed", minContextSlot: 100 },
  ]);
  assert.deepEqual(calls[1], [
    "program",
    {
      filters: [{ dataSize: 8 }],
      commitment: "confirmed",
      minContextSlot: 101,
      withContext: true,
    },
  ]);
  assert.deepEqual(calls[2], [
    "multiple",
    { commitment: "finalized", minContextSlot: 104 },
  ]);
  assert.deepEqual(calls[3], [
    "slot",
    { commitment: "confirmed", minContextSlot: 105 },
  ]);
});

test("context-pinned scanner reads serialize concurrent inventory calls", async () => {
  const floors = [];
  let responseSlot = 110;
  const rpc = {
    async getAccountInfoAndContext(_key, config) {
      floors.push(config.minContextSlot);
      const slot = responseSlot;
      responseSlot += 1;
      return { context: { slot }, value: null };
    },
  };
  const pinned = createContextPinnedConnection(rpc, 100, "ordered scan");
  await Promise.all([
    pinned.connection.getAccountInfo(TEST_ADDRESS),
    pinned.connection.getAccountInfo(PROGRAM_ID),
  ]);
  assert.deepEqual(floors, [100, 110]);
  assert.equal(pinned.getMinContextSlot(), 111);
});

test("context-pinned reads reject lagging and malformed RPC contexts", async () => {
  const lagging = createContextPinnedConnection(
    {
      async getProgramAccounts() {
        return { context: { slot: 99 }, value: [] };
      },
    },
    100,
    "lagging scan",
  );
  await assert.rejects(
    () => lagging.connection.getProgramAccounts(PROGRAM_ID),
    /context slot 99.*required minContextSlot 100/,
  );

  const malformed = createContextPinnedConnection(
    {
      async getAccountInfoAndContext() {
        return { context: { slot: "100" }, value: null };
      },
    },
    100,
    "malformed scan",
  );
  await assert.rejects(
    () => malformed.connection.getAccountInfo(TEST_ADDRESS),
    /response context is malformed/,
  );
});

test("confirmed context capture rejects a lagging or malformed RPC", async () => {
  const calls = [];
  const good = {
    async getLatestBlockhashAndContext(config) {
      calls.push(config);
      return {
        context: { slot: 125 },
        value: { blockhash: "unused", lastValidBlockHeight: 1 },
      };
    },
  };
  assert.equal(
    await captureConfirmedContextSlot(good, 120, "postdeploy floor"),
    125,
  );
  assert.deepEqual(calls, [{ commitment: "confirmed", minContextSlot: 120 }]);

  await assert.rejects(
    () =>
      captureConfirmedContextSlot(
        {
          async getLatestBlockhashAndContext() {
            return { context: { slot: 119 }, value: {} };
          },
        },
        120,
        "postdeploy floor",
      ),
    /context slot 119.*required minContextSlot 120/,
  );
  await assert.rejects(
    () =>
      captureConfirmedContextSlot(
        {
          async getLatestBlockhashAndContext() {
            return { value: {} };
          },
        },
        120,
        "postdeploy floor",
      ),
    /response context is malformed/,
  );
});

test("postdeploy cutover pins scans to the loader context and rechecks config", async () => {
  const protocolPda = TEST_ADDRESS;
  const account = protocolConfigAccount();
  const calls = [];
  const accountSlots = [480, 506, 509];
  const rpc = {
    async getAccountInfoAndContext(_key, config) {
      calls.push(["config", config]);
      return {
        context: { slot: accountSlots.shift() },
        value: account,
      };
    },
    async getLatestBlockhashAndContext(config) {
      calls.push(["capture", config]);
      return {
        context: { slot: 505 },
        value: { blockhash: "unused", lastValidBlockHeight: 1 },
      };
    },
    async getProgramAccounts(_program, config) {
      calls.push(["scan", config]);
      return { context: { slot: 507 }, value: [] };
    },
  };

  const pinned = await withPinnedRevision5CutoverContext(
    rpc,
    protocolPda,
    "Postdeploy/prestamp rescan",
    async (connection) => {
      assert.deepEqual(await connection.getProgramAccounts(PROGRAM_ID), []);
      return "safe";
    },
    { minContextSlot: 500 },
  );

  assert.equal(pinned.result, "safe");
  assert.equal(pinned.finalizedPauseContextSlot, 480);
  assert.equal(pinned.contextSlot, 509);
  assert.deepEqual(calls, [
    ["config", { commitment: "finalized", minContextSlot: 0 }],
    ["capture", { commitment: "confirmed", minContextSlot: 500 }],
    ["config", { commitment: "confirmed", minContextSlot: 505 }],
    [
      "scan",
      {
        commitment: "confirmed",
        minContextSlot: 506,
        withContext: true,
      },
    ],
    ["config", { commitment: "confirmed", minContextSlot: 507 }],
  ]);
});

test("postdeploy cutover rejects final pause or config drift", async () => {
  const makeRpc = (finalAccount) => {
    const account = protocolConfigAccount();
    const accountResponses = [account, account, finalAccount];
    let slot = 600;
    return {
      async getAccountInfoAndContext() {
        const value = accountResponses.shift();
        slot += 1;
        return { context: { slot }, value };
      },
      async getLatestBlockhashAndContext() {
        slot += 1;
        return { context: { slot }, value: {} };
      },
    };
  };

  await assert.rejects(
    () =>
      withPinnedRevision5CutoverContext(
        makeRpc(protocolConfigAccount({ paused: false })),
        TEST_ADDRESS,
        "Postdeploy/prestamp rescan",
        async () => null,
      ),
    /pinned final proof.*protocol_paused=false/,
  );
  await assert.rejects(
    () =>
      withPinnedRevision5CutoverContext(
        makeRpc(protocolConfigAccount({ mask: 13 })),
        TEST_ADDRESS,
        "Postdeploy/prestamp rescan",
        async () => null,
      ),
    /ProtocolConfig changed during the cutover scan/,
  );
});

test("execute wiring anchors postdeploy scans between verified loader snapshots", () => {
  const source = readFileSync(
    new URL("./mainnet-upgrade.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /"Postdeploy\/prestamp rescan",\s*\{ minContextSlot: prestampLoaderBefore\.contextSlot \}/,
  );
  assert.match(
    source,
    /readVerifiedLoaderSnapshot\(\s*connection,\s*pf,\s*prestampCutover\.contextSlot,\s*\)/,
  );
  assert.match(
    source,
    /assertImmediatePreUpgradeSnapshot\(\s*prestampLoaderBefore,\s*prestampLoaderAfter,\s*\)/,
  );
});

test("IDL publish is fetched and verified before upgrade completion", () => {
  const source = readFileSync(
    new URL("./mainnet-upgrade.mjs", import.meta.url),
    "utf8",
  );
  const runIdlStart = source.indexOf("async function runIdl(");
  const mainStart = source.indexOf(
    "// ------------------------------------------------------------------ main",
  );
  const runIdlSource = source.slice(runIdlStart, mainStart);
  const publishAt = runIdlSource.indexOf('spawnSync("anchor", argv');
  const fetchAt = runIdlSource.indexOf('"fetch"');
  const verifyAt = runIdlSource.indexOf("assertFetchedIdlMatchesApproved");
  assert.ok(runIdlStart >= 0 && mainStart > runIdlStart);
  assert.ok(publishAt >= 0 && fetchAt > publishAt && verifyAt > fetchAt);

  const invokeAt = source.lastIndexOf(
    "await runIdl(pf, args, plan.idl, connection)",
  );
  const stampAt = source.lastIndexOf("runStamp(");
  const completeAt = source.lastIndexOf('banner("UPGRADE COMPLETE")');
  assert.ok(
    invokeAt >= 0 && stampAt > invokeAt && completeAt > stampAt,
    "IDL publish/fetch verification must precede the final surface stamp and completion banner",
  );
  assert.match(
    source,
    /stamp:\s*\{\s*needed: true,\s*done: false,/,
    "the selected final stamp must be reasserted even when the revision is already current",
  );
  assert.match(
    source,
    /RUN_STAMP: "1",\s*FORCE_STAMP: "1"/,
    "the parent must explicitly scope a forced idempotent write to its stamp-only child phase",
  );
  assert.doesNotMatch(
    source,
    /Step 6 STAMP: surface_revision already .* skipping/,
    "the parent must not describe its mandatory final boundary assertion as skippable",
  );
  assert.match(
    source,
    /SKIP_BID_MARKETPLACE=1 SKIP_MODERATION=1 RUN_STAMP=1 FORCE_STAMP=1/,
    "the printed reviewed command must show the same two-key stamp controls as execution",
  );
  assert.match(source, /banner\("SELECTED STEPS COMPLETE"\)/);
  assert.match(source, /Full upgrade completion is NOT claimed/);
});

test("deploy and IDL runners consume immutable preflight byte snapshots", () => {
  const source = readFileSync(
    new URL("./mainnet-upgrade.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /const reviewedSoBytes = readFileSync\(soAbs\)/);
  assert.match(source, /pf\.soBytes = Buffer\.from\(reviewedSoBytes\)/);
  assert.match(source, /pf\.idlBytes = Buffer\.from\(idlBytes\)/);
  assert.match(
    source,
    /writeFileSync\(reviewedSoPath, reviewedBytes, \{ flag: "wx", mode: 0o600 \}\)/,
  );
  assert.match(
    source,
    /writeFileSync\(reviewedPath, reviewedBytes, \{ flag: "wx", mode: 0o600 \}\)/,
  );
  assert.doesNotMatch(source, /pf\.soBytes = soBytes/);
});

test("direct deploy rejects a concurrent ProgramData capacity change", () => {
  assert.equal(
    assertProgramDataCapacityUnchanged(
      { payload: Buffer.alloc(2_183_224) },
      { payload: Buffer.alloc(2_183_224) },
    ),
    2_183_224,
  );
  assert.throws(
    () =>
      assertProgramDataCapacityUnchanged(
        { payload: Buffer.alloc(2_183_224) },
        { payload: Buffer.alloc(2_193_464) },
      ),
    /capacity changed during direct deploy/,
  );
});

test("derives the full instruction surface from Rust and rejects stale IDL inventories", () => {
  const source = readFileSync(
    new URL("../programs/agenc-coordination/src/lib.rs", import.meta.url),
    "utf8",
  );
  const names = deriveFullProgramInstructionNames(source);
  assert.equal(names.length, 101);
  assert.ok(names.includes("reclaim_orphan_task_child"));
  assert.ok(names.includes("promote_bid"));
  assert.ok(names.includes("demote_ineligible_best"));
  assert.ok(names.includes("settle_dispute_claim"));
  assert.ok(!names.includes("complete_task_private"));
  assert.equal(new Set(names).size, names.length);

  const privateNames = deriveProgramInstructionNames(source, {
    privateZk: true,
  });
  assert.equal(privateNames.length, 104);
  assert.ok(privateNames.includes("complete_task_private"));
  assert.equal(
    deriveProgramInstructionNames(source, { mainnetCanary: true }).length,
    25,
  );

  const cargo = readFileSync(
    new URL("../programs/agenc-coordination/Cargo.toml", import.meta.url),
    "utf8",
  );
  assert.deepEqual(assertProductionCargoFeaturePolicy(cargo), {
    defaultFeatures: ["spl-token-rewards"],
    privateZk: false,
  });
  const surfaces = assertProgramSurfaceReleasePolicy(source, cargo);
  assert.deepEqual(surfaces.privateOnly, [
    "complete_task_private",
    "initialize_zk_config",
    "update_zk_image_id",
  ]);
  assert.throws(
    () =>
      assertProductionCargoFeaturePolicy(
        cargo.replace(
          'default = ["spl-token-rewards"]',
          'default = ["private-zk", "spl-token-rewards"]',
        ),
      ),
    /must be exactly \[spl-token-rewards\]/,
  );

  assert.deepEqual(
    assertIdlMatchesProgramInstructions(
      [{ name: "firstIx" }, { name: "second_ix" }],
      ["first_ix", "second_ix"],
    ),
    { sourceCount: 2, idlCount: 2 },
  );
  assert.throws(
    () =>
      assertIdlMatchesProgramInstructions(
        [{ name: "firstIx" }],
        ["first_ix", "second_ix"],
      ),
    /missing_in_idl=\[second_ix\]/,
  );
});

function safeSnapshot() {
  return {
    delegation: { accountCount: 0, blockers: [] },
    skillRating: {
      accountCount: 0,
      skillCount: 0,
      purchaseCount: 0,
      ratingCount: 0,
      decodedSkillCount: 0,
      decodedPurchaseCount: 0,
      decodedRatingCount: 0,
      blockers: [],
    },
    reputationStakes: {
      accountCount: 1,
      decodedAccountCount: 1,
      liveAgentCount: 1,
      retiredAgentCount: 0,
      absentAgentCount: 0,
      invalidAgentCount: 0,
      principalWithoutAgentCount: 0,
      underbackedAccountCount: 0,
      rentMinimumLamports: 1_000_000n,
      trackedStakedAmount: 50_000n,
      actualLamports: 1_050_000n,
      requiredRentLamports: 1_000_000n,
      requiredBackingLamports: 1_050_000n,
      backingDeficitLamports: 0n,
      backingSurplusLamports: 0n,
      principalWithoutAgentLamports: 0n,
      blockers: [],
    },
    disputes: { statusCounts: { active: 0 }, blockers: [] },
    validation: {
      modeCounts: { validatorQuorum: 0 },
      blockers: [],
    },
    governance: { statusCounts: { active: 0 }, blockers: [] },
    taskChildren: {
      liveCompletionBondCount: 0,
      liveCompletionBondPrincipal: 0n,
      blockers: [],
    },
    tokenTasks: { blockers: [] },
    privateTasks: { blockers: [] },
    hireProviders: { blockers: [] },
    jobSpecBlocks: { blockers: [] },
    dependencies: {
      dependentCount: 0,
      nonterminalDependentCount: 0,
      nonterminalDependencyTypeCounts: {
        data: 0,
        ordering: 0,
        proof: 0,
      },
      blockers: [],
    },
    rejectFrozen: { blockers: [] },
    bidContracts: {
      openBidCount: 0,
      openBidBondPrincipal: 0n,
      blockers: [],
    },
    taskSettlement: {
      revision4BondPostEligibleTaskCount: 0,
      blockers: [],
    },
  };
}

test("revision-5 cutover fails before scans unless protocol is explicitly paused", () => {
  assert.throws(
    () => assertRevision5Paused({ protocolPaused: false }, "predeploy"),
    /protocol_paused=false/,
  );
  assert.doesNotThrow(() =>
    assertRevision5Paused({ protocolPaused: true }, "predeploy"),
  );
});

test("stable bond cutover rejects an old-entry source before scanning bond accounts", async () => {
  const calls = [];
  const adversarialState = {
    eligibleTaskCount: 1,
    detachedBondCount: 0,
    detachedBondPrincipal: 0n,
  };
  await assert.rejects(
    () =>
      scanStableRevision5CompletionBondCutover(
        null,
        { statusCounts: { active: 0 }, blockers: [] },
        "predeploy",
        {
          scanTaskSettlement: async () => {
            calls.push("bond-entry-eligibility");
            return {
              revision4BondPostEligibleTaskCount:
                adversarialState.eligibleTaskCount,
              blockers: [],
            };
          },
          scanTaskChildren: async () => {
            calls.push("completion-bond-inventory");
            // If this scanner is ever moved first, it captures zero and then
            // models the deployed race: post from a second wallet, cancel with
            // another empty bond PDA, and old-close the Task while omitting the
            // real bond. The later eligibility scan would also see zero, so the
            // stale pair would incorrectly pass.
            const staleSnapshot = {
              liveCompletionBondCount: adversarialState.detachedBondCount,
              liveCompletionBondPrincipal:
                adversarialState.detachedBondPrincipal,
              blockers: [],
            };
            adversarialState.detachedBondCount = 1;
            adversarialState.detachedBondPrincipal = 25_000n;
            adversarialState.eligibleTaskCount = 0;
            return {
              ...staleSnapshot,
            };
          },
        },
      ),
    /zero Tasks eligible for deployed revision-4 post_completion_bond/,
  );
  assert.deepEqual(
    calls,
    ["bond-entry-eligibility"],
    "an eligible old Task aborts before an attacker can exploit a children-first RPC gap",
  );
});

test("stable bond cutover performs the final all-account inventory after entry closure", async () => {
  const calls = [];
  await assert.rejects(
    () =>
      scanStableRevision5CompletionBondCutover(
        null,
        { statusCounts: { active: 0 }, blockers: [] },
        "predeploy",
        {
          scanTaskSettlement: async () => {
            calls.push("bond-entry-eligibility");
            return {
              revision4BondPostEligibleTaskCount: 0,
              blockers: [],
            };
          },
          scanTaskChildren: async () => {
            calls.push("completion-bond-inventory");
            return {
              // Models principal already detached from a now-closed Task. The
              // final size-enumerated scan must still see and block it.
              liveCompletionBondCount: 1,
              liveCompletionBondPrincipal: 25_000n,
              blockers: [{ kind: "orphaned-active-or-principal-child" }],
            };
          },
        },
      ),
    /task-child inventory.*orphaned-active-or-principal-child/,
  );
  assert.deepEqual(calls, [
    "bond-entry-eligibility",
    "completion-bond-inventory",
  ]);
});

test("treasury boundary accepts only a live non-executable zero-data system account", () => {
  const treasury = "4tA32m8FRM1mVKTasuiEvbRksBJTGBvwF9jsT4WLM84n";
  const system = new PublicKey("11111111111111111111111111111111");
  assert.doesNotThrow(() =>
    assertTreasuryAccountBoundary(treasury, {
      owner: system,
      executable: false,
      data: Buffer.alloc(0),
    }),
  );
  assert.throws(
    () =>
      assertTreasuryAccountBoundary(treasury, {
        owner: new PublicKey("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK"),
        executable: false,
        data: Buffer.alloc(8),
      }),
    /System Program account/,
  );
  assert.throws(
    () => assertTreasuryAccountBoundary(PublicKey.default.toBase58(), null),
    /default pubkey/,
  );
});

test("revision-5 cutover requires zero delegation accounts", () => {
  const snapshot = safeSnapshot();
  snapshot.delegation = {
    accountCount: 1,
    blockers: [{ kind: "live-delegation-cutover" }],
  };
  assert.throws(
    () => assertRevision5CutoverResults(snapshot, "postdeploy/prestamp"),
    /exactly zero accounts/,
  );
});

test("revision-5 cutover requires an empty stable skill-rating surface", () => {
  for (const [field, label] of [
    ["skillCount", "skills"],
    ["purchaseCount", "purchases"],
    ["ratingCount", "ratings"],
  ]) {
    const snapshot = safeSnapshot();
    snapshot.skillRating[field] = 1;
    snapshot.skillRating.accountCount = 1;
    const decodedField = {
      skillCount: "decodedSkillCount",
      purchaseCount: "decodedPurchaseCount",
      ratingCount: "decodedRatingCount",
    }[field];
    snapshot.skillRating[decodedField] = 1;
    assert.throws(
      () => assertRevision5CutoverResults(snapshot, "predeploy"),
      new RegExp(`skill-rating cutover.*${label}=1`),
      field,
    );
  }
});

test("revision-5 skill-rating aggregate fails closed when missing or malformed", () => {
  const missing = safeSnapshot();
  delete missing.skillRating.purchaseCount;
  assert.throws(
    () => assertRevision5CutoverResults(missing, "predeploy"),
    /skill-rating cutover.*scanner aggregate invariant failure/,
  );

  const malformed = safeSnapshot();
  malformed.skillRating.blockers.push({
    kind: "invalid-purchase-record-layout-or-pda",
  });
  assert.throws(
    () => assertRevision5CutoverResults(malformed, "predeploy"),
    /invalid-purchase-record-layout-or-pda/,
  );
});

test("revision-5 cutover permits fully backed nonzero ReputationStake principal", () => {
  assert.doesNotThrow(() =>
    assertRevision5CutoverResults(safeSnapshot(), "predeploy"),
  );
});

test("revision-5 cutover blocks underbacked ReputationStake principal", () => {
  const snapshot = safeSnapshot();
  snapshot.reputationStakes.actualLamports = 1_040_000n;
  snapshot.reputationStakes.backingDeficitLamports = 10_000n;
  snapshot.reputationStakes.underbackedAccountCount = 1;
  snapshot.reputationStakes.blockers.push({
    kind: "underbacked-reputation-stake",
  });
  assert.throws(
    () => assertRevision5CutoverResults(snapshot, "predeploy"),
    /ReputationStake custody inventory.*deficit=10000/,
  );
});

test("revision-5 cutover fails closed on missing ReputationStake aggregates", () => {
  const snapshot = safeSnapshot();
  delete snapshot.reputationStakes.requiredBackingLamports;
  assert.throws(
    () => assertRevision5CutoverResults(snapshot, "predeploy"),
    /ReputationStake custody inventory.*scanner aggregate invariant failure/,
  );
});

test("revision-5 cutover requires zero Active disputes and zero quorum configs", () => {
  const active = safeSnapshot();
  active.disputes.statusCounts.active = 1;
  assert.throws(
    () => assertRevision5CutoverResults(active, "predeploy"),
    /zero Active/,
  );

  const quorum = safeSnapshot();
  quorum.validation.modeCounts.validatorQuorum = 1;
  assert.throws(
    () => assertRevision5CutoverResults(quorum, "predeploy"),
    /task-validation cutover/,
  );
});

test("revision-5 cutover requires zero Active governance proposals", () => {
  const snapshot = safeSnapshot();
  snapshot.governance.statusCounts.active = 1;
  assert.throws(
    () => assertRevision5CutoverResults(snapshot, "predeploy"),
    /zero Active proposals/,
  );
});

test("revision-5 cutover blocks active/principal or malformed task children", () => {
  const snapshot = safeSnapshot();
  snapshot.taskChildren.blockers.push({
    kind: "orphaned-active-or-principal-child",
  });
  assert.throws(
    () => assertRevision5CutoverResults(snapshot, "predeploy"),
    /task-child inventory/,
  );
});

test("revision-5 cutover blocks live CompletionBond principal with a live parent", () => {
  const snapshot = safeSnapshot();
  snapshot.taskChildren.liveCompletionBondCount = 1;
  snapshot.taskChildren.liveCompletionBondPrincipal = 7_000n;
  assert.throws(
    () => assertRevision5CutoverResults(snapshot, "predeploy"),
    /zero live CompletionBond principal.*count=1 principal=7000/,
  );
});

test("revision-5 cutover blocks unsafe live token-task escrow", () => {
  const snapshot = safeSnapshot();
  snapshot.tokenTasks.blockers.push({
    kind: "insufficient-token-escrow-principal",
  });
  assert.throws(
    () => assertRevision5CutoverResults(snapshot, "predeploy"),
    /token-task escrow scan/,
  );

  const privateState = safeSnapshot();
  privateState.privateTasks.blockers.push({
    kind: "nonterminal-private-task-release-blocker",
  });
  assert.throws(
    () => assertRevision5CutoverResults(privateState, "predeploy"),
    /private-task release scan/,
  );
});

test("revision-5 cutover blocks malformed provider and job-spec moderation state", () => {
  const provider = safeSnapshot();
  provider.hireProviders.blockers.push({
    kind: "mismatched-hire-designated-provider",
  });
  assert.throws(
    () => assertRevision5CutoverResults(provider, "predeploy"),
    /hired-task provider scan/,
  );

  const moderation = safeSnapshot();
  moderation.jobSpecBlocks.blockers.push({
    kind: "invalid-active-moderation-block-layout",
  });
  assert.throws(
    () => assertRevision5CutoverResults(moderation, "predeploy"),
    /active job-spec moderation scan/,
  );
});

test("valid moderation BLOCKs and legacy provider fallbacks are inventory, not blockers", () => {
  const snapshot = safeSnapshot();
  snapshot.hireProviders.backfillCount = 16;
  snapshot.jobSpecBlocks.blockedCount = 2;
  snapshot.jobSpecBlocks.blockedUnassignedCount = 1;
  snapshot.jobSpecBlocks.blockedWithWorkersCount = 1;
  assert.doesNotThrow(() =>
    assertRevision5CutoverResults(snapshot, "postdeploy/prestamp"),
  );
});

test("revision-5 cutover blocks an unsafe dependent worker or bond obligation", () => {
  const snapshot = safeSnapshot();
  snapshot.dependencies.blockers.push({
    kind: "unsafe-dependent-obligation",
  });
  assert.throws(
    () => assertRevision5CutoverResults(snapshot, "predeploy"),
    /task-dependency scan/,
  );
});

test("revision-5 cutover requires stable zero nonterminal dependent Tasks", () => {
  for (const type of ["data", "ordering", "proof"]) {
    const snapshot = safeSnapshot();
    snapshot.dependencies.dependentCount = 1;
    snapshot.dependencies.nonterminalDependentCount = 1;
    snapshot.dependencies.nonterminalDependencyTypeCounts[type] = 1;
    assert.throws(
      () => assertRevision5CutoverResults(snapshot, "predeploy"),
      /zero nonterminal dependent Tasks.*count=1/,
      type,
    );
  }
});

test("revision-5 dependency aggregate fails closed when missing", () => {
  const snapshot = safeSnapshot();
  delete snapshot.dependencies.nonterminalDependencyTypeCounts.ordering;
  assert.throws(
    () => assertRevision5CutoverResults(snapshot, "predeploy"),
    /task-dependency scan.*scanner aggregate invariant failure/,
  );
});

test("revision-5 cutover blocks ambiguous RejectFrozen fee or principal state", () => {
  const snapshot = safeSnapshot();
  snapshot.rejectFrozen.blockers.push({
    kind: "invalid-reject-frozen-fee-terms",
  });
  assert.throws(
    () => assertRevision5CutoverResults(snapshot, "predeploy"),
    /RejectFrozen fee\/principal scan/,
  );
});

test("revision-5 cutover blocks an accepted or structurally unsafe bid contract", () => {
  const snapshot = safeSnapshot();
  snapshot.bidContracts.blockers.push({
    kind: "accepted-bid-compatibility-review-required",
  });
  assert.throws(
    () => assertRevision5CutoverResults(snapshot, "predeploy"),
    /bid-contract scan/,
  );
});

test("revision-5 cutover blocks every open Active or BoundActive bid", () => {
  for (const state of ["Active", "BoundActive"]) {
    const snapshot = safeSnapshot();
    snapshot.bidContracts.openBidCount = 1;
    snapshot.bidContracts.openBidBondPrincipal = 5_000n;
    assert.throws(
      () => assertRevision5CutoverResults(snapshot, "predeploy"),
      /zero open TaskBid accounts.*count=1 bond_principal=5000/,
      state,
    );
  }
});

test("revision-5 cutover fails closed when cutover aggregate fields are absent", () => {
  const missingBondAggregate = safeSnapshot();
  delete missingBondAggregate.taskChildren.liveCompletionBondCount;
  assert.throws(
    () => assertRevision5CutoverResults(missingBondAggregate, "predeploy"),
    /zero live CompletionBond principal/,
  );

  const missingBidAggregate = safeSnapshot();
  delete missingBidAggregate.bidContracts.openBidBondPrincipal;
  assert.throws(
    () => assertRevision5CutoverResults(missingBidAggregate, "predeploy"),
    /zero open TaskBid accounts/,
  );

  const missingBondEligibilityAggregate = safeSnapshot();
  delete missingBondEligibilityAggregate.taskSettlement
    .revision4BondPostEligibleTaskCount;
  assert.throws(
    () =>
      assertRevision5CutoverResults(
        missingBondEligibilityAggregate,
        "predeploy",
      ),
    /zero Tasks eligible for deployed revision-4 post_completion_bond/,
  );
});

test("revision-5 cutover blocks insolvent or aliased task settlement state", () => {
  const snapshot = safeSnapshot();
  snapshot.taskSettlement.blockers.push({
    kind: "underfunded-collaborative-task",
  });
  assert.throws(
    () => assertRevision5CutoverResults(snapshot, "predeploy"),
    /task settlement scan/,
  );
});

test("revision-5 cutover blocks the deployed unpaused bond-post surface", () => {
  const snapshot = safeSnapshot();
  snapshot.taskSettlement.revision4BondPostEligibleTaskCount = 1;
  assert.throws(
    () => assertRevision5CutoverResults(snapshot, "predeploy"),
    /zero Tasks eligible for deployed revision-4 post_completion_bond.*count=1/,
  );
});

test("revision-5 cutover accepts only a fully empty/canonical snapshot", () => {
  assert.doesNotThrow(() =>
    assertRevision5CutoverResults(safeSnapshot(), "postdeploy/prestamp"),
  );
});
