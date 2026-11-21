import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MAINNET_GENESIS,
  PROGRAM_ID,
} from "./preflight-dispute-scan.mjs";
import {
  decodeTaskValidationConfig,
  legacyAttestationTaskBlock,
  scanTaskValidationConfigs,
} from "./preflight-task-validation-scan.mjs";
import { assertRevision5CutoverResults } from "./mainnet-upgrade.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "tests-integration", "package.json"));
const { PublicKey } = require("@solana/web3.js");

function discriminator(name) {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

function taskFixture({ taskId, creator, status, bump }) {
  const data = Buffer.alloc(466);
  discriminator("Task").copy(data, 0);
  taskId.copy(data, 8);
  creator.toBuffer().copy(data, 40);
  Buffer.from("agenc-manual-validation-v2-seed!").copy(data, 144);
  data[186] = status;
  data[310] = bump;
  // None depends_on, dependency_type 0, min_reputation 0, None reward_mint.
  data[313] = 0;
  data[314] = 0;
  data[317] = 0;
  return data;
}

function configFixture({
  task,
  creator,
  mode,
  bump,
  reviewWindowSecs = mode === 1 ? 86_400n : 0n,
  quorum = mode === 2 ? 2 : 0,
  pendingSubmissionCount = 0,
}) {
  const data = Buffer.alloc(105);
  discriminator("TaskValidationConfig").copy(data, 0);
  task.toBuffer().copy(data, 8);
  creator.toBuffer().copy(data, 40);
  data[72] = mode;
  data.writeBigInt64LE(reviewWindowSecs, 73);
  data.writeBigInt64LE(1_000n, 81);
  data.writeBigInt64LE(1_001n, 89);
  data[97] = bump;
  data[98] = quorum;
  data.writeUInt16LE(pendingSubmissionCount, 99);
  return data;
}

function scenario({
  mode = 1,
  status = 0,
  pendingSubmissionCount = 0,
  configAddressOverride,
  taskCreatorOverride,
} = {}) {
  const taskId = Buffer.alloc(32, 31);
  const creator = new PublicKey(Buffer.alloc(32, 32));
  const taskCreator = taskCreatorOverride ?? creator;
  const [task, taskBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("task"), taskCreator.toBuffer(), taskId],
    PROGRAM_ID,
  );
  const [config, configBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("task_validation"), task.toBuffer()],
    PROGRAM_ID,
  );
  return {
    config: configAddressOverride ?? config,
    task,
    configData: configFixture({
      task,
      creator,
      mode,
      bump: configBump,
      pendingSubmissionCount,
    }),
    taskData: taskFixture({
      taskId,
      creator: taskCreator,
      status,
      bump: taskBump,
    }),
  };
}

function connectionFor(value, accountOverrides = {}) {
  return {
    getGenesisHash: async () => MAINNET_GENESIS,
    getProgramAccounts: async () => [
      {
        pubkey: value.config,
        account: {
          owner: accountOverrides.configOwner ?? PROGRAM_ID,
          data: accountOverrides.configData ?? value.configData,
          lamports: accountOverrides.configLamports ?? 1_500_000,
        },
      },
    ],
    getMultipleAccountsInfo: async ([task]) => {
      assert.equal(task.toBase58(), value.task.toBase58());
      return [
        accountOverrides.missingTask
          ? null
          : {
              owner: accountOverrides.taskOwner ?? PROGRAM_ID,
              data: accountOverrides.taskData ?? value.taskData,
              lamports: 1,
            },
      ];
    },
  };
}

test("decodes the exact TaskValidationConfig Borsh layout", () => {
  const value = scenario({ mode: 2, status: 2, pendingSubmissionCount: 3 });
  const decoded = decodeTaskValidationConfig(value.configData);
  assert.equal(decoded.task.toBase58(), value.task.toBase58());
  assert.equal(decoded.mode, 2);
  assert.equal(decoded.validatorQuorum, 2);
  assert.equal(decoded.pendingSubmissionCount, 3);
  assert.equal(decoded.reviewWindowSecs, 0n);
});

test("accepts a canonical CreatorReview config and Task binding", async () => {
  const value = scenario({ mode: 1, status: 1 });
  const result = await scanTaskValidationConfigs(connectionFor(value));
  assert.deepEqual(result.blockers, []);
  assert.equal(result.modeCounts.creatorReview, 1);
});

test("inventories a missing-parent rent-only config without hiding active orphan state", async () => {
  const rentOnly = scenario({ mode: 1, status: 3 });
  let result = await scanTaskValidationConfigs(
    connectionFor(rentOnly, { missingTask: true }),
  );
  assert.equal(result.orphanCount, 1);
  assert.equal(result.orphans[0].risk, "rent-only");
  assert.deepEqual(result.blockers, []);

  const active = scenario({
    mode: 2,
    status: 2,
    pendingSubmissionCount: 1,
  });
  result = await scanTaskValidationConfigs(
    connectionFor(active, { missingTask: true }),
  );
  assert.ok(
    result.blockers.some(
      (item) => item.kind === "orphaned-active-validation-config",
    ),
  );
});

test("blocks every ValidatorQuorum config and distinguishes cutover risk", async () => {
  const cases = [
    [2, "validator-quorum-pending-validation"],
    [0, "validator-quorum-future-entry-risk"],
    [1, "validator-quorum-future-entry-risk"],
    [3, "validator-quorum-terminal-config"],
  ];
  for (const [status, kind] of cases) {
    const value = scenario({
      mode: 2,
      status,
      pendingSubmissionCount: status === 2 ? 1 : 0,
    });
    const result = await scanTaskValidationConfigs(connectionFor(value));
    const found = result.blockers.find((item) => item.kind === kind);
    assert.ok(found);
    assert.equal(found.config.toBase58(), value.config.toBase58());
    assert.equal(found.task.toBase58(), value.task.toBase58());
    assert.match(found.detail, new RegExp(`status=${["Open", "InProgress", "PendingValidation", "Completed"][status]}`));
  }
});

test("fails closed on config layout, PDA, owner, and Task-binding ambiguity", async () => {
  const malformed = scenario({ mode: 1 });
  const short = Buffer.from(malformed.configData.subarray(0, 104));
  let result = await scanTaskValidationConfigs(
    connectionFor(malformed, { configData: short }),
  );
  assert.ok(result.blockers.some((item) => item.kind === "invalid-validation-config-layout"));

  result = await scanTaskValidationConfigs(
    connectionFor(malformed, {
      configOwner: new PublicKey(Buffer.alloc(32, 88)),
    }),
  );
  assert.ok(result.blockers.some((item) => item.kind === "invalid-validation-config-owner"));

  const wrongPda = scenario({
    mode: 1,
    configAddressOverride: new PublicKey(Buffer.alloc(32, 77)),
  });
  result = await scanTaskValidationConfigs(connectionFor(wrongPda));
  assert.ok(result.blockers.some((item) => item.kind === "invalid-validation-config-pda"));

  const wrongCreator = new PublicKey(Buffer.alloc(32, 44));
  result = await scanTaskValidationConfigs(
    connectionFor(malformed, {
      taskData: taskFixture({
        taskId: Buffer.alloc(32, 31),
        creator: wrongCreator,
        status: 0,
        bump: 1,
      }),
    }),
  );
  assert.ok(result.blockers.some((item) => item.kind === "invalid-validation-task-binding"));
});

test("refuses non-mainnet before enumerating validation configs", async () => {
  let enumerated = false;
  await assert.rejects(
    scanTaskValidationConfigs({
      getGenesisHash: async () => "devnet",
      getProgramAccounts: async () => {
        enumerated = true;
        return [];
      },
    }),
    /wrong cluster genesis/,
  );
  assert.equal(enumerated, false);
});


test("AGNC-03 review debt is valid across pending, completed and orphaned configs", async () => {
  for (const debt of [1, 0x01020304, 0xffffffff, 0]) {
    for (const status of [2, 3]) {
      const value = scenario({ mode: 1, status });
      value.configData.writeUInt32LE(debt, 101);
      const result = await scanTaskValidationConfigs(connectionFor(value));
      assert.deepEqual(result.blockers, []);
      assert.equal(decodeTaskValidationConfig(value.configData).reviewDebtSecs, debt);
      if (status === 3) {
        const orphan = await scanTaskValidationConfigs(connectionFor(value, { missingTask: true }));
        assert.deepEqual(orphan.blockers, []);
        assert.equal(orphan.orphans[0].risk, "rent-only");
      }
    }
  }
});

// Item 34: a task compacted by revision 9's close_task is a 56-byte TaskMarker,
// a closed task. Its leftover config is an orphan child, never a Task layout
// error; a pending-count orphan still blocks.
function markerFixture({ creator, status = 3 }) {
  const data = Buffer.alloc(56);
  Buffer.from("c10bc0c833d06cff", "hex").copy(data, 0);
  creator.toBuffer().copy(data, 8);
  data[40] = status;
  data.writeBigInt64LE(1_700_000_000n, 42);
  return data;
}

test("a config whose task was compacted is a closed-task orphan, not a layout error (item 34)", async () => {
  const creator = new PublicKey(Buffer.alloc(32, 32));
  const rentOnly = scenario({ mode: 1, status: 3 });
  let result = await scanTaskValidationConfigs(
    connectionFor(rentOnly, { taskData: markerFixture({ creator }) }),
  );
  assert.deepEqual(result.blockers, []);
  assert.equal(result.orphanCount, 1);
  assert.equal(result.orphans[0].taskState, "closed");
  assert.equal(result.orphans[0].risk, "rent-only");

  const pending = scenario({ mode: 1, status: 2, pendingSubmissionCount: 1 });
  result = await scanTaskValidationConfigs(
    connectionFor(pending, { taskData: markerFixture({ creator, status: 4 }) }),
  );
  assert.ok(
    result.blockers.some((item) => item.kind === "orphaned-active-validation-config"),
  );
  assert.ok(!result.blockers.some((item) => item.kind === "invalid-validation-task-layout"));

  const quorum = scenario({ mode: 2, status: 3 });
  result = await scanTaskValidationConfigs(
    connectionFor(quorum, { taskData: markerFixture({ creator }) }),
  );
  assert.ok(
    result.blockers.some((item) => item.kind === "validator-quorum-terminal-config"),
    "a quorum config on a closed task is a terminal config",
  );

  const foreign = scenario({ mode: 1, status: 3 });
  result = await scanTaskValidationConfigs(
    connectionFor(foreign, {
      taskData: markerFixture({ creator: new PublicKey(Buffer.alloc(32, 99)) }),
    }),
  );
  assert.ok(result.blockers.some((item) => item.kind === "invalid-validation-task-binding"));

  const malformed = markerFixture({ creator });
  malformed[40] = 0;
  result = await scanTaskValidationConfigs(
    connectionFor(foreign, { taskData: malformed }),
  );
  assert.ok(result.blockers.some((item) => item.kind === "invalid-validation-task-layout"));
});

// Review R2-5: revision 9 refuses a dispute on every single-worker manual task,
// so a legacy ExternalAttestation task that can still be claimed, or whose work
// is in flight or waits for the attestor, could lock its escrow. The cutover
// blocks it; a terminal task, or an Open one past its deadline (the live
// mainnet shape), does not.
const NOW = 1_800_000_000n;
function attestationTask({ status, workers = 0, maxWorkers = 1, deadline = 0n }) {
  return { status, currentWorkers: workers, maxWorkers, deadline };
}

test("R2-5: which legacy ExternalAttestation tasks are claimable or pending", () => {
  const cases = [
    [attestationTask({ status: 0, deadline: 0n }), 0, "claimable"],
    [attestationTask({ status: 0, deadline: NOW + 1n }), 0, "claimable"],
    [attestationTask({ status: 0, deadline: NOW }), 0, null],
    [attestationTask({ status: 0, deadline: NOW - 1n }), 0, null],
    [attestationTask({ status: 0, workers: 1, deadline: 0n }), 0, null],
    [attestationTask({ status: 0, deadline: NOW - 1n }), 1, "pending"],
    [attestationTask({ status: 1, workers: 1, deadline: NOW - 1n }), 0, "pending"],
    [attestationTask({ status: 2, workers: 1 }), 1, "pending"],
    [attestationTask({ status: 3 }), 1, null],
    [attestationTask({ status: 4 }), 1, null],
    [attestationTask({ status: 5, workers: 1 }), 0, null],
    [attestationTask({ status: 6, workers: 1 }), 0, null],
    [attestationTask({ status: 5, workers: 1 }), 1, "pending"],
  ];
  for (const [task, pending, expected] of cases) {
    assert.equal(
      legacyAttestationTaskBlock(task, pending, NOW),
      expected,
      `status=${task.status} workers=${task.currentWorkers} deadline=${task.deadline} pending=${pending}`,
    );
  }
});

function attestationScenario({ status, workers = 0, deadline = 0n, pendingSubmissionCount = 0 }) {
  const value = scenario({ mode: 3, status, pendingSubmissionCount });
  value.taskData[184] = 1;
  value.taskData[185] = workers;
  value.taskData.writeBigInt64LE(deadline, 196);
  return value;
}

test("R2-5: the scan blocks claimable and pending ExternalAttestation tasks and passes dead ones", async () => {
  const cases = [
    [{ status: 0, deadline: NOW + 3_600n }, "external-attestation-claimable"],
    [{ status: 0, deadline: 0n }, "external-attestation-claimable"],
    [{ status: 1, workers: 1, deadline: NOW + 3_600n }, "external-attestation-pending"],
    [{ status: 2, workers: 1, pendingSubmissionCount: 1 }, "external-attestation-pending"],
    [{ status: 0, deadline: NOW - 86_400n }, null],
    [{ status: 3 }, null],
  ];
  for (const [fixture, kind] of cases) {
    const value = attestationScenario(fixture);
    const result = await scanTaskValidationConfigs(connectionFor(value), {
      nowUnixTimestamp: NOW,
    });
    assert.equal(result.modeCounts.externalAttestation, 1);
    if (kind) {
      const found = result.blockers.find((item) => item.kind === kind);
      assert.ok(found, `${JSON.stringify(fixture, (_, v) => (typeof v === "bigint" ? `${v}` : v))}: ${kind}`);
      assert.equal(found.task.toBase58(), value.task.toBase58());
      assert.equal(result.liveAttestationTaskCount, 1);
      assert.throws(
        () => assertRevision5CutoverResults(cutoverSnapshot(result), "Predeploy cutover snapshot"),
        new RegExp(`task-validation cutover.*${kind}.*R2-5`),
        "the scan result stops the cutover",
      );
    } else {
      assert.deepEqual(result.blockers, []);
      assert.equal(result.liveAttestationTaskCount, 0);
    }
  }
});

test("R2-5: the cluster clock is read only when an Open attestation task has a deadline", async () => {
  const value = attestationScenario({ status: 0, deadline: NOW - 1n });
  let clockReads = 0;
  const connection = {
    ...connectionFor(value),
    getSlot: async () => {
      clockReads++;
      return 123;
    },
    getBlockTime: async (slot) => {
      assert.equal(slot, 123);
      return Number(NOW);
    },
  };
  const result = await scanTaskValidationConfigs(connection);
  assert.equal(clockReads, 1);
  assert.deepEqual(result.blockers, []);

  const pending = attestationScenario({ status: 2, workers: 1, pendingSubmissionCount: 1 });
  const noClock = await scanTaskValidationConfigs(connectionFor(pending));
  assert.ok(noClock.blockers.some((item) => item.kind === "external-attestation-pending"));
});

// The smallest cutover snapshot that passes every other gate, with this
// validation scan result in it.
function cutoverSnapshot(validation) {
  return {
    delegation: { accountCount: 0, blockers: [] },
    skillRating: {
      accountCount: 0, skillCount: 0, purchaseCount: 0, ratingCount: 0,
      decodedSkillCount: 0, decodedPurchaseCount: 0, decodedRatingCount: 0, blockers: [],
    },
    reputationStakes: {
      accountCount: 0, decodedAccountCount: 0, liveAgentCount: 0, retiredAgentCount: 0,
      absentAgentCount: 0, invalidAgentCount: 0, principalWithoutAgentCount: 0,
      underbackedAccountCount: 0, rentMinimumLamports: 0n, trackedStakedAmount: 0n,
      actualLamports: 0n, requiredRentLamports: 0n, requiredBackingLamports: 0n,
      backingDeficitLamports: 0n, backingSurplusLamports: 0n, principalWithoutAgentLamports: 0n,
      blockers: [],
    },
    disputes: { statusCounts: { active: 0 }, blockers: [] },
    validation,
  };
}
