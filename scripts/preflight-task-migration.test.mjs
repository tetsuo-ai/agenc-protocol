import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  DISPUTE_SAFE_MAX_WORKERS,
  inspectTaskMigrationCompatibility,
  sampleTaskSizes,
} from "./mainnet-upgrade.mjs";
import { PROGRAM_ID } from "./preflight-dispute-scan.mjs";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const { PublicKey } = require("@solana/web3.js");

function taskFixture({
  size = 382,
  taskType = 0,
  status = 0,
  maxWorkers = 1,
  currentWorkers = 0,
  dependsOn = null,
  dependencyType = 0,
}) {
  const data = Buffer.alloc(size);
  createHash("sha256").update("account:Task").digest().subarray(0, 8).copy(data);
  data[184] = maxWorkers;
  data[185] = currentWorkers;
  data[186] = status;
  data[187] = taskType;
  if (dependsOn) {
    data[313] = 1;
    dependsOn.toBuffer().copy(data, 314);
    data[346] = dependencyType;
    data[349] = 0;
  } else {
    data[313] = 0;
    data[314] = dependencyType;
    data[317] = 0;
  }
  return data;
}

test("blocks nonterminal Exclusive tasks whose max_workers is not exactly one", () => {
  for (const status of [0, 1, 2, 5, 6]) {
    const result = inspectTaskMigrationCompatibility(
      taskFixture({ status, maxWorkers: 2 }),
    );
    assert.equal(result.incompatibleExclusive, true);
  }
});

test("allows terminal historical or valid single-worker Exclusive tasks", () => {
  for (const status of [3, 4]) {
    assert.equal(
      inspectTaskMigrationCompatibility(
        taskFixture({ status, maxWorkers: 2 }),
      ).incompatibleExclusive,
      false,
    );
  }
  assert.equal(
    inspectTaskMigrationCompatibility(
      taskFixture({ status: 1, maxWorkers: 1 }),
    ).incompatibleExclusive,
    false,
  );
});

test("does not apply the Exclusive invariant to other task types", () => {
  for (const taskType of [1, 2, 3]) {
    assert.equal(
      inspectTaskMigrationCompatibility(
        taskFixture({ taskType, status: 1, maxWorkers: 8 }),
      ).incompatibleExclusive,
      false,
    );
  }
});

test("inventories wide legacy tasks and blocks dispute-unsafe live worker sets", () => {
  assert.equal(DISPUTE_SAFE_MAX_WORKERS, 4);

  const wideButSafe = inspectTaskMigrationCompatibility(
    taskFixture({ taskType: 1, status: 1, maxWorkers: 8, currentWorkers: 4 }),
  );
  assert.equal(wideButSafe.aboveDisputeSafeMaxWorkers, true);
  assert.equal(wideButSafe.disputeUnsafeActiveWorkers, false);

  for (const status of [0, 1, 2, 5, 6]) {
    const unsafe = inspectTaskMigrationCompatibility(
      taskFixture({ taskType: 1, status, maxWorkers: 8, currentWorkers: 5 }),
    );
    assert.equal(unsafe.aboveDisputeSafeMaxWorkers, true);
    assert.equal(unsafe.disputeUnsafeActiveWorkers, true);
  }

  for (const status of [3, 4]) {
    const terminal = inspectTaskMigrationCompatibility(
      taskFixture({ taskType: 1, status, maxWorkers: 8, currentWorkers: 8 }),
    );
    assert.equal(terminal.aboveDisputeSafeMaxWorkers, true);
    assert.equal(terminal.disputeUnsafeActiveWorkers, false);
  }
});

test("decodes every variable Borsh dependency type", () => {
  const parent = new PublicKey(Buffer.alloc(32, 71));
  for (const dependencyType of [1, 2, 3]) {
    const child = inspectTaskMigrationCompatibility(
      taskFixture({
        taskType: 1,
        status: 1,
        currentWorkers: 1,
        dependsOn: parent,
        dependencyType,
      }),
    );
    assert.equal(child.dependsOn.toBase58(), parent.toBase58());
    assert.equal(child.dependencyType, dependencyType);
  }
});

test("fails closed on unsupported size, discriminator, and enums", () => {
  assert.throws(
    () => inspectTaskMigrationCompatibility(taskFixture({ size: 381 })),
    /unsupported migration size/,
  );
  const wrong = taskFixture({});
  wrong[0] ^= 0xff;
  assert.throws(() => inspectTaskMigrationCompatibility(wrong), /discriminator/);
  assert.throws(
    () => inspectTaskMigrationCompatibility(taskFixture({ status: 7 })),
    /Task.status/,
  );
  assert.throws(
    () => inspectTaskMigrationCompatibility(taskFixture({ taskType: 4 })),
    /Task.task_type/,
  );
  assert.throws(
    () => inspectTaskMigrationCompatibility(taskFixture({ dependencyType: 1 })),
    /dependency Option\/type mismatch/,
  );
  assert.throws(
    () => inspectTaskMigrationCompatibility(taskFixture({
      dependsOn: new PublicKey(Buffer.alloc(32, 81)),
      dependencyType: 0,
    })),
    /dependency Option\/type mismatch/,
  );
});

// Revision 9 (C): close_task compacts a closed Task into a 56-byte TaskMarker at
// the same address. The inventory counts one as a closed task, never as invalid.
test("the Task inventory counts compacted markers apart from invalid accounts", async () => {
  const creator = new PublicKey(Buffer.alloc(32, 41));
  const taskId = Buffer.alloc(32, 42);
  const [taskAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from("task"), creator.toBuffer(), taskId],
    PROGRAM_ID,
  );
  const live = taskFixture({ size: 466, status: 3 });
  taskId.copy(live, 8);
  creator.toBuffer().copy(live, 40);
  const marker = Buffer.alloc(56);
  createHash("sha256").update("account:TaskMarker").digest().subarray(0, 8).copy(marker);
  creator.toBuffer().copy(marker, 8);
  marker[40] = 4;
  const malformed = Buffer.from(marker);
  malformed[40] = 1;
  const addresses = [
    taskAddress,
    new PublicKey(Buffer.alloc(32, 43)),
    new PublicKey(Buffer.alloc(32, 44)),
  ];
  const images = [live, marker, malformed];
  const connection = {
    getMultipleAccountsInfo: async (keys) =>
      keys.map((key) => {
        const index = addresses.findIndex((address) => address.equals(key));
        return { owner: PROGRAM_ID, data: images[index], lamports: 1 };
      }),
  };
  const sizes = await sampleTaskSizes(
    connection,
    addresses.map((address) => ({ pubkey: address.toBase58() })),
  );
  assert.equal(sizes.new, 1);
  assert.equal(sizes.markers, 1);
  assert.equal(sizes.other, 1);
  assert.equal(sizes.inspected, 3);
});
