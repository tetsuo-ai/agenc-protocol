import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { MAINNET_GENESIS, PROGRAM_ID } from "./preflight-dispute-scan.mjs";
import {
  decodeCompletionBond,
  scanTaskDependencies,
} from "./preflight-task-dependency-scan.mjs";

const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const { PublicKey } = require("@solana/web3.js");

function disc(name) {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

function taskFixture({
  marker,
  status = 0,
  currentWorkers = 0,
  parent = null,
  dependencyType = parent ? 1 : 0,
} = {}) {
  const taskId = Buffer.alloc(32, marker);
  const creator = new PublicKey(Buffer.alloc(32, marker + 1));
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("task"), creator.toBuffer(), taskId],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(382);
  disc("Task").copy(data);
  taskId.copy(data, 8);
  creator.toBuffer().copy(data, 40);
  data.writeBigUInt64LE(10_000n, 176);
  data[184] = 1;
  data[185] = currentWorkers;
  data[186] = status;
  data[187] = 0;
  data[310] = bump;
  if (parent) {
    data[313] = 1;
    parent.toBuffer().copy(data, 314);
    data[346] = dependencyType;
    data.writeUInt16LE(0, 347);
    data[349] = 0;
  } else {
    data[313] = 0;
    data[314] = dependencyType;
    data.writeUInt16LE(0, 315);
    data[317] = 0;
  }
  return { address, data };
}

function bondFixture(task, marker = 160, amount = 2_500n) {
  const party = new PublicKey(Buffer.alloc(32, marker));
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("completion_bond"), task.toBuffer(), party.toBuffer()],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(139);
  disc("CompletionBond").copy(data);
  task.toBuffer().copy(data, 8);
  party.toBuffer().copy(data, 40);
  data[72] = 1;
  data.writeBigUInt64LE(amount, 73);
  data[81] = 0;
  data.writeBigInt64LE(100n, 82);
  data[90] = bump;
  return { address, data, lamports: Number(amount + 2_000_000n) };
}

function connectionFor(tasks, bonds = [], genesis = MAINNET_GENESIS) {
  const taskMap = new Map(
    tasks.map((task) => [task.address.toBase58(), {
      owner: PROGRAM_ID,
      executable: false,
      lamports: 3_000_000,
      data: task.data,
    }]),
  );
  return {
    getGenesisHash: async () => genesis,
    getProgramAccounts: async (_program, options) => {
      const wanted = Buffer.from(options.filters[0].memcmp.bytes, "base64");
      if (wanted.equals(disc("Task"))) {
        return tasks.map((task) => ({
          pubkey: task.address,
          account: taskMap.get(task.address.toBase58()),
        }));
      }
      if (wanted.equals(disc("CompletionBond"))) {
        return bonds.map((bond) => ({
          pubkey: bond.address,
          account: {
            owner: PROGRAM_ID,
            executable: false,
            lamports: bond.lamports,
            data: bond.data,
          },
        }));
      }
      return [];
    },
    getMultipleAccountsInfo: async (addresses) =>
      addresses.map((address) => taskMap.get(address.toBase58()) ?? null),
  };
}

test("accepts an assigned child only when its canonical parent is Completed", async () => {
  const parent = taskFixture({ marker: 131, status: 3 });
  const child = taskFixture({
    marker: 133,
    status: 1,
    currentWorkers: 1,
    parent: parent.address,
    dependencyType: 2,
  });
  const result = await scanTaskDependencies(connectionFor([parent, child]));
  assert.equal(result.dependentCount, 1);
  assert.equal(result.nonterminalDependentCount, 1);
  assert.deepEqual(result.nonterminalDependencyTypeCounts, {
    data: 0,
    ordering: 1,
    proof: 0,
  });
  assert.equal(result.parentCompletedCount, 1);
  assert.deepEqual(result.blockers, []);
});

test("inventories an unassigned legacy child with an unsafe parent", async () => {
  const missingParent = new PublicKey(Buffer.alloc(32, 140));
  const child = taskFixture({
    marker: 141,
    parent: missingParent,
    dependencyType: 1,
  });
  const result = await scanTaskDependencies(connectionFor([child]));
  assert.equal(result.unsafeParentCount, 1);
  assert.equal(result.unsafeUnassignedCount, 1);
  assert.equal(result.unsafeObligatedCount, 0);
  assert.deepEqual(result.nonterminalDependencyTypeCounts, {
    data: 1,
    ordering: 0,
    proof: 0,
  });
  assert.deepEqual(result.blockers, []);
});

test("empty nonterminal dependency set is an explicit stable cutover aggregate", async () => {
  const terminalParent = taskFixture({ marker: 142, status: 3 });
  const terminalChild = taskFixture({
    marker: 143,
    status: 3,
    parent: terminalParent.address,
    dependencyType: 3,
  });
  const result = await scanTaskDependencies(
    connectionFor([terminalParent, terminalChild]),
  );
  assert.equal(result.nonterminalDependentCount, 0);
  assert.deepEqual(result.nonterminalDependencyTypeCounts, {
    data: 0,
    ordering: 0,
    proof: 0,
  });
  assert.deepEqual(result.blockers, []);
});

test("blocks an assigned child whose parent is missing or non-Completed", async () => {
  const missingParent = new PublicKey(Buffer.alloc(32, 144));
  let child = taskFixture({
    marker: 145,
    status: 1,
    currentWorkers: 1,
    parent: missingParent,
    dependencyType: 3,
  });
  let result = await scanTaskDependencies(connectionFor([child]));
  assert.ok(
    result.blockers.some((item) => item.kind === "unsafe-dependent-obligation"),
  );

  const parent = taskFixture({ marker: 147, status: 4 });
  child = taskFixture({
    marker: 149,
    status: 2,
    currentWorkers: 0,
    parent: parent.address,
    dependencyType: 1,
  });
  result = await scanTaskDependencies(connectionFor([parent, child]));
  assert.ok(
    result.blockers.some((item) => item.kind === "unsafe-dependent-obligation"),
  );
});

test("counts bonded principal as an unsafe obligation before assignment", async () => {
  const missingParent = new PublicKey(Buffer.alloc(32, 152));
  const child = taskFixture({
    marker: 153,
    parent: missingParent,
    dependencyType: 2,
  });
  const bond = bondFixture(child.address, 155, 2_500n);
  assert.equal(decodeCompletionBond(bond.data).amount, 2_500n);
  const result = await scanTaskDependencies(connectionFor([child], [bond]));
  assert.equal(result.unsafeCompletionBondCount, 1);
  assert.equal(result.unsafeCompletionBondPrincipal, 2_500n);
  assert.ok(
    result.blockers.some((item) => item.kind === "unsafe-dependent-obligation"),
  );
});

test("fails closed on inconsistent dependency encoding and malformed bond state", async () => {
  const malformedTask = taskFixture({ marker: 158, dependencyType: 1 });
  let result = await scanTaskDependencies(connectionFor([malformedTask]));
  assert.ok(
    result.blockers.some((item) => item.kind === "invalid-dependency-task-layout"),
  );

  const child = taskFixture({ marker: 160 });
  const malformedBond = bondFixture(child.address, 162);
  malformedBond.data[91] = 1;
  result = await scanTaskDependencies(connectionFor([child], [malformedBond]));
  assert.ok(
    result.blockers.some((item) => item.kind === "invalid-dependency-bond-layout"),
  );
});

test("refuses non-mainnet before account enumeration", async () => {
  let enumerated = false;
  await assert.rejects(
    scanTaskDependencies({
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
