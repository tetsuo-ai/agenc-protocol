import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { MAINNET_GENESIS, PROGRAM_ID } from "./preflight-dispute-scan.mjs";
import { decodeHireRecordProvider } from "./preflight-hire-provider-scan.mjs";
import {
  inspectTaskSettlementRecord,
  isRevision4BondPostEligible,
  scanTaskSettlementSafety,
} from "./preflight-task-settlement-scan.mjs";
import { MANUAL_VALIDATION_SENTINEL } from "./preflight-private-task-scan.mjs";

const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const { PublicKey } = require("@solana/web3.js");

function discriminator(name) {
  return createHash("sha256")
    .update(`account:${name}`)
    .digest()
    .subarray(0, 8);
}

function taskFixture({
  rewardAmount = 4n,
  requiredCompletions = 4,
  taskType = 1,
  status = 0,
  rewardMint = null,
  constraintHash = Buffer.alloc(32),
  operatorAlias = null,
  operator = new PublicKey(Buffer.alloc(32, 41)),
  operatorFeeBps = 0,
  referrerAlias = null,
  referrer = new PublicKey(Buffer.alloc(32, 42)),
  referrerFeeBps = 0,
} = {}) {
  const taskId = Buffer.alloc(32, 31);
  const creator = new PublicKey(Buffer.alloc(32, 32));
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("task"), creator.toBuffer(), taskId],
    PROGRAM_ID,
  );
  const [escrow] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), address.toBuffer()],
    PROGRAM_ID,
  );
  const aliases = { task: address, escrow, creator };
  const resolvedOperator = operatorAlias ? aliases[operatorAlias] : operator;
  const resolvedReferrer = referrerAlias ? aliases[referrerAlias] : referrer;

  const data = Buffer.alloc(466);
  discriminator("Task").copy(data);
  taskId.copy(data, 8);
  creator.toBuffer().copy(data, 40);
  constraintHash.copy(data, 144);
  data.writeBigUInt64LE(rewardAmount, 176);
  data[184] = taskType === 1 ? requiredCompletions : 1;
  data[185] = 0;
  data[186] = status;
  data[187] = taskType;
  escrow.toBuffer().copy(data, 212);
  data[308] = 0;
  data[309] = requiredCompletions;
  data[310] = bump;
  data.writeUInt16LE(100, 311);
  data[313] = 0; // depends_on=None
  data[314] = 0; // DependencyType::None
  data.writeUInt16LE(0, 315);
  let appendOffset;
  if (rewardMint) {
    data[317] = 1;
    rewardMint.toBuffer().copy(data, 318);
    appendOffset = 350;
  } else {
    data[317] = 0;
    appendOffset = 318;
  }
  resolvedOperator.toBuffer().copy(data, appendOffset);
  data.writeUInt16LE(operatorFeeBps, appendOffset + 32);
  resolvedReferrer.toBuffer().copy(data, appendOffset + 50);
  data.writeUInt16LE(referrerFeeBps, appendOffset + 82);
  return { address, escrow, creator, data };
}

function hireFixture(task, {
  operator,
  operatorFeeBps = 0,
  referrer = PublicKey.default,
  referrerFeeBps = 0,
} = {}) {
  const data = Buffer.alloc(173);
  discriminator("HireRecord").copy(data);
  task.toBuffer().copy(data, 8);
  new PublicKey(Buffer.alloc(32, 51)).toBuffer().copy(data, 40);
  (operator ?? PublicKey.default).toBuffer().copy(data, 72);
  data.writeUInt16LE(operatorFeeBps, 104);
  const [, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("hire"), task.toBuffer()],
    PROGRAM_ID,
  );
  data[106] = bump;
  new PublicKey(Buffer.alloc(32, 52)).toBuffer().copy(data, 107);
  referrer.toBuffer().copy(data, 139);
  data.writeUInt16LE(referrerFeeBps, 171);
  return decodeHireRecordProvider(data);
}

test("accepts the exact collaborative funding boundary for SOL and SPL units", () => {
  for (const rewardMint of [null, new PublicKey(Buffer.alloc(32, 61))]) {
    const exact = taskFixture({ rewardAmount: 4n, rewardMint });
    const exactResult = inspectTaskSettlementRecord(exact.address, exact.data);
    assert.equal(exactResult.underfundedCollaborative, false);
    assert.deepEqual(exactResult.blockers, []);

    const over = taskFixture({ rewardAmount: 5n, rewardMint });
    assert.deepEqual(
      inspectTaskSettlementRecord(over.address, over.data).blockers,
      [],
    );
  }
});

test("blocks a nonterminal collaborative task one unit below its exact floor", () => {
  for (const rewardMint of [null, new PublicKey(Buffer.alloc(32, 62))]) {
    const value = taskFixture({ rewardAmount: 3n, rewardMint });
    const result = inspectTaskSettlementRecord(value.address, value.data);
    assert.equal(result.underfundedCollaborative, true);
    assert.equal(result.blockers[0].kind, "underfunded-collaborative-task");
  }
});

test("blocks active Task-stamped operator and referrer aliases", () => {
  for (const alias of ["task", "escrow", "creator"]) {
    const operator = taskFixture({
      operatorAlias: alias,
      operatorFeeBps: 100,
      referrer: PublicKey.default,
    });
    assert.equal(
      inspectTaskSettlementRecord(operator.address, operator.data).blockers[0]
        .kind,
      "operator-payee-alias",
    );

    const referrer = taskFixture({
      operator: PublicKey.default,
      referrerAlias: alias,
      referrerFeeBps: 100,
    });
    assert.equal(
      inspectTaskSettlementRecord(referrer.address, referrer.data).blockers[0]
        .kind,
      "referrer-payee-alias",
    );
  }
});

test("applies canonical legacy HireRecord fee terms when Task terms are empty", () => {
  const value = taskFixture({
    operator: PublicKey.default,
    referrer: PublicKey.default,
  });
  const hire = hireFixture(value.address, {
    operator: value.escrow,
    operatorFeeBps: 100,
  });
  const result = inspectTaskSettlementRecord(value.address, value.data, hire);
  assert.equal(result.feeTermsSource, "hire-record");
  assert.equal(result.blockers[0].kind, "operator-payee-alias");
});

test("terminal hazards remain inventory and cannot strand an upgrade", () => {
  const value = taskFixture({
    rewardAmount: 3n,
    status: 3,
    referrerAlias: "escrow",
    referrerFeeBps: 100,
  });
  const result = inspectTaskSettlementRecord(value.address, value.data);
  assert.equal(result.inventory.length, 2);
  assert.deepEqual(result.blockers, []);
});

test("matches every deployed revision-4 completion-bond post eligibility term", () => {
  for (const status of [0, 1, 2]) {
    for (const constraintHash of [Buffer.alloc(32), MANUAL_VALIDATION_SENTINEL]) {
      const value = taskFixture({
        taskType: 0,
        status,
        requiredCompletions: 1,
        constraintHash,
      });
      const record = inspectTaskSettlementRecord(value.address, value.data);
      assert.equal(record.revision4BondPostEligible, true);
    }
  }

  for (const value of [
    taskFixture({ taskType: 0, status: 3, requiredCompletions: 1 }),
    taskFixture({ taskType: 1 }),
    taskFixture({
      taskType: 0,
      requiredCompletions: 1,
      rewardMint: new PublicKey(Buffer.alloc(32, 91)),
    }),
    taskFixture({
      taskType: 0,
      requiredCompletions: 1,
      constraintHash: Buffer.alloc(32, 92),
    }),
  ]) {
    const task = inspectTaskSettlementRecord(value.address, value.data);
    assert.equal(task.revision4BondPostEligible, false);
  }

  assert.equal(
    isRevision4BondPostEligible({
      taskType: 0,
      status: 0,
      rewardMint: null,
      constraintHash: Buffer.alloc(32),
    }),
    true,
  );
});

test("zero-fee aliases and shared active operator/referrer wallets are safe", () => {
  const inactive = taskFixture({
    operatorAlias: "escrow",
    operatorFeeBps: 0,
    referrer: PublicKey.default,
  });
  assert.deepEqual(
    inspectTaskSettlementRecord(inactive.address, inactive.data).blockers,
    [],
  );

  const shared = new PublicKey(Buffer.alloc(32, 71));
  const active = taskFixture({
    operator: shared,
    operatorFeeBps: 100,
    referrer: shared,
    referrerFeeBps: 50,
  });
  const result = inspectTaskSettlementRecord(active.address, active.data);
  assert.equal(result.sharedOperatorReferrer, true);
  assert.deepEqual(result.blockers, []);
});

test("fails closed on noncanonical Task/escrow bindings and malformed cardinality", () => {
  const value = taskFixture();
  const wrongEscrow = Buffer.from(value.data);
  new PublicKey(Buffer.alloc(32, 81)).toBuffer().copy(wrongEscrow, 212);
  assert.throws(
    () => inspectTaskSettlementRecord(value.address, wrongEscrow),
    /not canonical/,
  );

  const wrongRequired = Buffer.from(value.data);
  wrongRequired[309] = 3;
  assert.throws(
    () => inspectTaskSettlementRecord(value.address, wrongRequired),
    /required_completions=3; expected 4/,
  );
});

test("full scanner requires the exact mainnet genesis", async () => {
  await assert.rejects(
    () => scanTaskSettlementSafety({
      getGenesisHash: async () => "not-mainnet",
    }),
    /wrong cluster genesis/,
  );

  const empty = await scanTaskSettlementSafety({
    getGenesisHash: async () => MAINNET_GENESIS,
    getProgramAccounts: async () => [],
  });
  assert.equal(empty.taskCount, 0);
  assert.equal(empty.revision4BondPostEligibleTaskCount, 0);
  assert.deepEqual(empty.revision4BondPostEligibleTasks, []);
  assert.deepEqual(empty.blockers, []);
});

test("scanner emits the exact revision-4 bond-post-eligible Task aggregate", async () => {
  const eligible = taskFixture({
    taskType: 0,
    status: 2,
    requiredCompletions: 1,
    constraintHash: MANUAL_VALIDATION_SENTINEL,
  });
  const result = await scanTaskSettlementSafety({
    getGenesisHash: async () => MAINNET_GENESIS,
    getProgramAccounts: async (_program, options) => {
      const wanted = Buffer.from(options.filters[0].memcmp.bytes, "base64");
      if (!wanted.equals(discriminator("Task"))) return [];
      return [{
        pubkey: eligible.address,
        account: {
          owner: PROGRAM_ID,
          executable: false,
          data: eligible.data,
          lamports: 5_000_000,
        },
      }];
    },
  });

  assert.equal(result.revision4BondPostEligibleTaskCount, 1);
  assert.deepEqual(result.revision4BondPostEligibleTasks, [
    eligible.address.toBase58(),
  ]);
});
