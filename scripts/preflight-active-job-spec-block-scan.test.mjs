import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { MAINNET_GENESIS, PROGRAM_ID } from "./preflight-dispute-scan.mjs";
import {
  decodeCanonicalTaskJobSpec,
  decodeModerationBlock,
  scanActiveJobSpecBlocks,
} from "./preflight-active-job-spec-block-scan.mjs";

const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const { PublicKey } = require("@solana/web3.js");

function disc(name) {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

function account(data, owner = PROGRAM_ID, overrides = {}) {
  return {
    owner,
    data,
    lamports: 2_000_000,
    executable: false,
    ...overrides,
  };
}

function taskFixture({ currentWorkers = 0, status = 0, marker = 101 } = {}) {
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
  data.writeBigUInt64LE(1_000n, 176);
  data[184] = 1;
  data[185] = currentWorkers;
  data[186] = status;
  data[187] = 0;
  data[310] = bump;
  data[313] = 0; // depends_on=None
  data[314] = 0; // dependency_type=None
  data.writeUInt16LE(0, 315);
  data[317] = 0; // reward_mint=None
  return { address, creator, data };
}

function jobSpecFixture(task, { bidLocked = false, marker = 111 } = {}) {
  const hash = Buffer.alloc(32, marker);
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("task_job_spec"), task.address.toBuffer()],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(388);
  disc("TaskJobSpec").copy(data);
  task.address.toBuffer().copy(data, 8);
  task.creator.toBuffer().copy(data, 40);
  hash.copy(data, 72);
  const uri = Buffer.from(`agenc://job-spec/${marker}`, "utf8");
  data.writeUInt32LE(uri.length, 104);
  uri.copy(data, 108);
  const end = 108 + uri.length;
  data.writeBigInt64LE(100n, end);
  data.writeBigInt64LE(101n, end + 8);
  data[end + 16] = bump;
  data[end + 17] = bidLocked ? 1 : 0;
  return { address, data, hash };
}

function blockFixture(jobSpec, { status = 1, marker = 121 } = {}) {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("moderation_block"), jobSpec.hash],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(398);
  disc("ModerationBlock").copy(data);
  jobSpec.hash.copy(data, 8);
  data[40] = status;
  Buffer.alloc(32, marker).copy(data, 41);
  const uri = Buffer.from(`agenc://moderation/${marker}`, "utf8");
  data.writeUInt32LE(uri.length, 73);
  uri.copy(data, 77);
  const end = 77 + uri.length;
  data.writeBigInt64LE(100n, end);
  data.writeBigInt64LE(101n, end + 8);
  new PublicKey(Buffer.alloc(32, marker + 1)).toBuffer().copy(data, end + 16);
  data[end + 48] = bump;
  return { address, data };
}

function connectionFor(tasks, records = new Map(), genesis = MAINNET_GENESIS) {
  return {
    getGenesisHash: async () => genesis,
    getProgramAccounts: async () =>
      tasks.map((task) => ({ pubkey: task.address, account: account(task.data) })),
    getMultipleAccountsInfo: async (addresses) =>
      addresses.map((address) => records.get(address.toBase58()) ?? null),
  };
}

test("exact-decodes canonical job specs, bid locks, and moderation blocks", () => {
  const task = taskFixture();
  const spec = jobSpecFixture(task, { bidLocked: true });
  const block = blockFixture(spec);
  assert.equal(decodeCanonicalTaskJobSpec(spec.data).bidLocked, true);
  assert.equal(decodeModerationBlock(block.data).status, 1);

  const invalidLock = Buffer.from(spec.data);
  const uriLength = invalidLock.readUInt32LE(104);
  invalidLock[108 + uriLength + 17] = 2;
  assert.throws(
    () => decodeCanonicalTaskJobSpec(invalidLock),
    /bid_locked: invalid bool/,
  );
});

test("an absent moderation block is a valid unblocked active job spec", async () => {
  const task = taskFixture();
  const spec = jobSpecFixture(task);
  const records = new Map([[spec.address.toBase58(), account(spec.data)]]);
  const result = await scanActiveJobSpecBlocks(connectionFor([task], records));
  assert.equal(result.canonicalJobSpecCount, 1);
  assert.equal(result.blockedCount, 0);
  assert.deepEqual(result.blockers, []);
});

test("legacy active Tasks without a job spec remain explicit compatibility inventory", async () => {
  const unassigned = taskFixture({ currentWorkers: 0, marker: 101 });
  const assigned = taskFixture({ currentWorkers: 1, status: 1, marker: 104 });
  const result = await scanActiveJobSpecBlocks(
    connectionFor([unassigned, assigned]),
  );
  assert.equal(result.missingJobSpecCount, 2);
  assert.equal(result.missingJobSpecUnassignedCount, 1);
  assert.equal(result.missingJobSpecWithWorkersCount, 1);
  assert.deepEqual(result.blockers, []);
});

test("valid BLOCKs are containment inventory split by worker assignment", async () => {
  const unassigned = taskFixture({ currentWorkers: 0, marker: 101 });
  const assigned = taskFixture({ currentWorkers: 1, status: 1, marker: 104 });
  const firstSpec = jobSpecFixture(unassigned, { marker: 111 });
  const secondSpec = jobSpecFixture(assigned, { marker: 112 });
  const firstBlock = blockFixture(firstSpec, { marker: 121 });
  const secondBlock = blockFixture(secondSpec, { marker: 122 });
  const records = new Map([
    [firstSpec.address.toBase58(), account(firstSpec.data)],
    [secondSpec.address.toBase58(), account(secondSpec.data)],
    [firstBlock.address.toBase58(), account(firstBlock.data)],
    [secondBlock.address.toBase58(), account(secondBlock.data)],
  ]);
  const result = await scanActiveJobSpecBlocks(
    connectionFor([unassigned, assigned], records),
  );
  assert.equal(result.blockedCount, 2);
  assert.equal(result.blockedUnassignedCount, 1);
  assert.equal(result.blockedWithWorkersCount, 1);
  assert.deepEqual(result.blockers, []);
});

test("a valid CLEARED block remains audit inventory", async () => {
  const task = taskFixture();
  const spec = jobSpecFixture(task);
  const block = blockFixture(spec, { status: 0 });
  const records = new Map([
    [spec.address.toBase58(), account(spec.data)],
    [block.address.toBase58(), account(block.data)],
  ]);
  const result = await scanActiveJobSpecBlocks(connectionFor([task], records));
  assert.equal(result.clearedCount, 1);
  assert.equal(result.blockedCount, 0);
  assert.deepEqual(result.blockers, []);
});

test("malformed job-spec and mismatched block state are hard blockers", async () => {
  const task = taskFixture();
  const spec = jobSpecFixture(task);
  const malformedSpec = Buffer.from(spec.data);
  malformedSpec[0] ^= 0xff;
  let records = new Map([
    [spec.address.toBase58(), account(malformedSpec)],
  ]);
  let result = await scanActiveJobSpecBlocks(connectionFor([task], records));
  assert.ok(
    result.blockers.some((item) => item.kind === "invalid-active-job-spec-layout"),
  );

  const block = blockFixture(spec);
  const mismatchedBlock = Buffer.from(block.data);
  mismatchedBlock[8] ^= 0xff;
  records = new Map([
    [spec.address.toBase58(), account(spec.data)],
    [block.address.toBase58(), account(mismatchedBlock)],
  ]);
  result = await scanActiveJobSpecBlocks(connectionFor([task], records));
  assert.ok(
    result.blockers.some(
      (item) => item.kind === "invalid-active-moderation-block-layout",
    ),
  );
});

test("refuses non-mainnet before enumerating Tasks", async () => {
  let enumerated = false;
  await assert.rejects(
    scanActiveJobSpecBlocks({
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
