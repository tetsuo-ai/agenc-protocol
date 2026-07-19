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
  scanTaskValidationConfigs,
} from "./preflight-task-validation-scan.mjs";

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
