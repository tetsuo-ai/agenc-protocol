import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import {
  MAINNET_GENESIS,
  PROGRAM_ID,
} from "./preflight-dispute-scan.mjs";
import {
  MANUAL_VALIDATION_SENTINEL,
  decodePrivateTaskClaim,
  decodeZkConfig,
  scanPrivateTaskCutover,
} from "./preflight-private-task-scan.mjs";
import { assertPrivateTaskReleaseDisabled } from "./private-task-release-policy.mjs";

const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const { PublicKey } = require("@solana/web3.js");

function disc(name) {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

function taskFixture({ marker, status = 0, constraintHash = Buffer.alloc(32) }) {
  const taskId = Buffer.alloc(32, marker);
  const creator = new PublicKey(Buffer.alloc(32, marker + 1));
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("task"), creator.toBuffer(), taskId],
    PROGRAM_ID,
  );
  const [escrow] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), address.toBuffer()],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(382);
  disc("Task").copy(data);
  taskId.copy(data, 8);
  creator.toBuffer().copy(data, 40);
  constraintHash.copy(data, 144);
  data.writeBigUInt64LE(10_000n, 176);
  data[184] = 1;
  data[185] = status === 0 ? 0 : 1;
  data[186] = status;
  escrow.toBuffer().copy(data, 212);
  data[310] = bump;
  data[313] = 0;
  data[314] = 0;
  data[317] = 0;
  return { address, escrow, data };
}

function escrowFixture(task, amount = 10_000n) {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), task.toBuffer()],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(58);
  disc("TaskEscrow").copy(data);
  task.toBuffer().copy(data, 8);
  data.writeBigUInt64LE(amount, 40);
  data[57] = bump;
  return { address, data };
}

function claimFixture(task, marker = 91) {
  const worker = new PublicKey(Buffer.alloc(32, marker));
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("claim"), task.toBuffer(), worker.toBuffer()],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(203);
  disc("TaskClaim").copy(data);
  task.toBuffer().copy(data, 8);
  worker.toBuffer().copy(data, 40);
  data.writeBigInt64LE(100n, 72);
  data.writeBigInt64LE(200n, 80);
  data[202] = bump;
  return { address, data };
}

function zkFixture() {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("zk_config")],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(72);
  disc("ZkConfig").copy(data);
  Buffer.alloc(32, 77).copy(data, 8);
  data[40] = bump;
  return { address, data };
}

function owned(value) {
  return {
    pubkey: value.address,
    account: {
      owner: PROGRAM_ID,
      executable: false,
      lamports: 2_000_000,
      data: value.data,
    },
  };
}

function connectionFor({ tasks = [], claims = [], escrows = [], zk = null } = {}) {
  const escrowMap = new Map(
    escrows.map((value) => [value.address.toBase58(), owned(value).account]),
  );
  return {
    getGenesisHash: async () => MAINNET_GENESIS,
    getProgramAccounts: async (_program, options) => {
      const wanted = Buffer.from(options.filters[0].memcmp.bytes, "base64");
      if (wanted.equals(disc("Task"))) return tasks.map((value) => owned(value));
      if (wanted.equals(disc("TaskClaim"))) return claims.map((value) => owned(value));
      return [];
    },
    getAccountInfo: async (address) =>
      zk && address.equals(zk.address) ? owned(zk).account : null,
    getMultipleAccountsInfo: async (addresses) =>
      addresses.map((address) => escrowMap.get(address.toBase58()) ?? null),
  };
}

test("private-task cutover distinguishes manual review, proves exits, and forbids readiness", async () => {
  assert.deepEqual(assertPrivateTaskReleaseDisabled(), {
    releaseState: "disabled",
    activationAllowed: false,
  });
  assert.throws(
    () => assertPrivateTaskReleaseDisabled({ zkImageId: "reviewed-looking-id" }),
    /readiness is forbidden/,
  );
  const manual = taskFixture({
    marker: 71,
    constraintHash: MANUAL_VALIDATION_SENTINEL,
  });
  const ordinary = taskFixture({ marker: 73 });
  let result = await scanPrivateTaskCutover(connectionFor({
    tasks: [manual, ordinary],
  }));
  assert.equal(result.manualValidationSentinelCount, 1);
  assert.equal(result.privateTaskCount, 0);
  assert.equal(result.zkConfigState, "absent-disabled");
  assert.deepEqual(result.blockers, []);

  const privateTask = taskFixture({
    marker: 75,
    status: 1,
    constraintHash: Buffer.alloc(32, 76),
  });
  const escrow = escrowFixture(privateTask.address);
  const claim = claimFixture(privateTask.address);
  const zk = zkFixture();
  assert.equal(decodePrivateTaskClaim(claim.data).task.toBase58(), privateTask.address.toBase58());
  assert.equal(decodeZkConfig(zk.data).activeImageId.equals(Buffer.alloc(32, 77)), true);
  result = await scanPrivateTaskCutover(connectionFor({
    tasks: [privateTask],
    claims: [claim],
    escrows: [escrow],
    zk,
  }));
  assert.equal(result.zkConfigState, "present-disabled-legacy");
  assert.equal(result.records[0].claimCount, 1);
  assert.equal(result.records[0].escrowRemaining, 10_000n);
  assert.ok(result.blockers.some(
    (item) => item.kind === "nonterminal-private-task-release-blocker",
  ));

  result = await scanPrivateTaskCutover(connectionFor({ tasks: [ordinary] }), {
    targetClaimsPrivateReadiness: true,
  });
  assert.ok(result.blockers.some(
    (item) => item.kind === "private-task-readiness-claim-forbidden",
  ));

  await assert.rejects(
    scanPrivateTaskCutover({ getGenesisHash: async () => "devnet" }),
    /wrong cluster genesis/,
  );
});
