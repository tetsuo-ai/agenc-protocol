import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { MAINNET_GENESIS, PROGRAM_ID } from "./preflight-dispute-scan.mjs";
import {
  decodeTaskEscrowPrincipal,
  scanRejectFrozenFees,
} from "./preflight-reject-frozen-fee-scan.mjs";

const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const { PublicKey } = require("@solana/web3.js");

function disc(name) {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

function taskFixture({
  marker = 171,
  status = 6,
  operator = PublicKey.default,
  operatorFeeBps = 0,
  referrer = PublicKey.default,
  referrerFeeBps = 0,
} = {}) {
  const taskId = Buffer.alloc(32, marker);
  const creator = new PublicKey(Buffer.alloc(32, marker + 1));
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("task"), creator.toBuffer(), taskId],
    PROGRAM_ID,
  );
  const [escrow, escrowBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), address.toBuffer()],
    PROGRAM_ID,
  );
  const stamped =
    !operator.equals(PublicKey.default) ||
    !referrer.equals(PublicKey.default) ||
    operatorFeeBps !== 0 ||
    referrerFeeBps !== 0;
  const data = Buffer.alloc(stamped ? 466 : 382);
  disc("Task").copy(data);
  taskId.copy(data, 8);
  creator.toBuffer().copy(data, 40);
  data.writeBigUInt64LE(10_000n, 176);
  data[184] = 1;
  data[185] = status === 6 ? 1 : 0;
  data[186] = status;
  data[187] = 0;
  escrow.toBuffer().copy(data, 212);
  data[310] = bump;
  data.writeUInt16LE(100, 311);
  data[313] = 0;
  data[314] = 0;
  data.writeUInt16LE(0, 315);
  data[317] = 0;
  if (stamped) {
    operator.toBuffer().copy(data, 318);
    data.writeUInt16LE(operatorFeeBps, 350);
    referrer.toBuffer().copy(data, 368);
    data.writeUInt16LE(referrerFeeBps, 400);
  }
  return { address, creator, escrow, escrowBump, data };
}

function escrowFixture(task, amount = 10_000n, distributed = 0n) {
  const data = Buffer.alloc(58);
  disc("TaskEscrow").copy(data);
  task.address.toBuffer().copy(data, 8);
  data.writeBigUInt64LE(amount, 40);
  data.writeBigUInt64LE(distributed, 48);
  data[56] = 0;
  data[57] = task.escrowBump;
  return { address: task.escrow, data, lamports: Number(amount + 2_000_000n) };
}

function hireFixture(task, { operator, operatorFeeBps, referrer, referrerFeeBps }) {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("hire"), task.address.toBuffer()],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(173);
  disc("HireRecord").copy(data);
  task.address.toBuffer().copy(data, 8);
  new PublicKey(Buffer.alloc(32, 181)).toBuffer().copy(data, 40);
  operator.toBuffer().copy(data, 72);
  data.writeUInt16LE(operatorFeeBps, 104);
  data[106] = bump;
  referrer.toBuffer().copy(data, 139);
  data.writeUInt16LE(referrerFeeBps, 171);
  return { address, data, lamports: 2_000_000 };
}

function connectionFor(tasks, extras = [], genesis = MAINNET_GENESIS) {
  const records = new Map(
    extras.map((item) => [item.address.toBase58(), {
      owner: item.owner ?? PROGRAM_ID,
      executable: false,
      data: item.data,
      lamports: item.lamports,
    }]),
  );
  return {
    getGenesisHash: async () => genesis,
    getProgramAccounts: async (_program, options) => {
      const wanted = Buffer.from(options.filters[0].memcmp.bytes, "base64");
      if (wanted.equals(disc("Task"))) {
        return tasks.map((task) => ({
          pubkey: task.address,
          account: {
            owner: PROGRAM_ID,
            executable: false,
            data: task.data,
            lamports: 4_000_000,
          },
        }));
      }
      return [];
    },
    getMultipleAccountsInfo: async (addresses) =>
      addresses.map((address) => records.get(address.toBase58()) ?? null),
  };
}

test("decodes exact open escrow principal", () => {
  const task = taskFixture();
  const escrow = escrowFixture(task, 10_000n, 2_000n);
  assert.equal(decodeTaskEscrowPrincipal(escrow.data).remaining, 8_000n);
});

test("inventories a direct RejectFrozen task with canonical escrow", async () => {
  const task = taskFixture();
  const escrow = escrowFixture(task);
  const result = await scanRejectFrozenFees(connectionFor([task], [escrow]));
  assert.equal(result.rejectFrozenCount, 1);
  assert.equal(result.noMarketplaceFeeCount, 1);
  assert.equal(result.escrowPrincipal, 10_000n);
  assert.deepEqual(result.blockers, []);
});

test("resolves legacy HireRecord operator/referrer terms", async () => {
  const task = taskFixture();
  const escrow = escrowFixture(task);
  const operator = new PublicKey(Buffer.alloc(32, 182));
  const referrer = new PublicKey(Buffer.alloc(32, 183));
  const hire = hireFixture(task, {
    operator,
    operatorFeeBps: 500,
    referrer,
    referrerFeeBps: 400,
  });
  const result = await scanRejectFrozenFees(
    connectionFor([task], [escrow, hire]),
  );
  assert.equal(result.legacyHireFeeCount, 1);
  assert.equal(result.records[0].operator.toBase58(), operator.toBase58());
  assert.equal(result.records[0].referrer.toBase58(), referrer.toBase58());
  assert.deepEqual(result.blockers, []);
});

test("task-stamped terms take precedence over a legacy HireRecord", async () => {
  const taskOperator = new PublicKey(Buffer.alloc(32, 184));
  const task = taskFixture({ operator: taskOperator, operatorFeeBps: 600 });
  const escrow = escrowFixture(task);
  const hire = hireFixture(task, {
    operator: new PublicKey(Buffer.alloc(32, 185)),
    operatorFeeBps: 500,
    referrer: PublicKey.default,
    referrerFeeBps: 0,
  });
  const result = await scanRejectFrozenFees(
    connectionFor([task], [escrow, hire]),
  );
  assert.equal(result.taskStampedFeeCount, 1);
  assert.equal(result.records[0].operator.toBase58(), taskOperator.toBase58());
  assert.deepEqual(result.blockers, []);
});

test("blocks missing escrow and malformed fee/payee state", async () => {
  let task = taskFixture();
  let result = await scanRejectFrozenFees(connectionFor([task]));
  assert.ok(
    result.blockers.some(
      (item) => item.kind === "missing-or-invalid-reject-frozen-escrow",
    ),
  );

  task = taskFixture({ operator: PublicKey.default, operatorFeeBps: 500 });
  const escrow = escrowFixture(task);
  result = await scanRejectFrozenFees(connectionFor([task], [escrow]));
  assert.ok(
    result.blockers.some(
      (item) => item.kind === "invalid-reject-frozen-fee-terms",
    ),
  );
});

test("refuses non-mainnet before enumeration", async () => {
  let enumerated = false;
  await assert.rejects(
    scanRejectFrozenFees({
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
