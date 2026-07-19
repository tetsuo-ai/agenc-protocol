import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { MAINNET_GENESIS, PROGRAM_ID } from "./preflight-dispute-scan.mjs";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  decodeClassicMint,
  decodeClassicTokenAccount,
  decodeTaskEscrow,
  deriveEscrowAta,
  scanTokenRewardTasks,
} from "./preflight-token-task-scan.mjs";

const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const { PublicKey } = require("@solana/web3.js");

function discriminator(name) {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

function taskFixture({ status = 1, rewardAmount = 1_000n } = {}) {
  const taskId = Buffer.alloc(32, 81);
  const creator = new PublicKey(Buffer.alloc(32, 82));
  const mint = new PublicKey(Buffer.alloc(32, 83));
  const [task, taskBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("task"), creator.toBuffer(), taskId],
    PROGRAM_ID,
  );
  const [escrow, escrowBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), task.toBuffer()],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(382);
  discriminator("Task").copy(data);
  taskId.copy(data, 8);
  creator.toBuffer().copy(data, 40);
  data.writeBigUInt64LE(rewardAmount, 176);
  data[184] = 1;
  data[185] = status === 0 ? 0 : 1;
  data[186] = status;
  data[187] = 0;
  escrow.toBuffer().copy(data, 212);
  data[309] = 1;
  data[310] = taskBump;
  // depends_on=None, dependency_type=None, min_reputation=0.
  data[313] = 0;
  data[314] = 0;
  data.writeUInt16LE(0, 315);
  // reward_mint=Some(mint).
  data[317] = 1;
  mint.toBuffer().copy(data, 318);
  return { task, data, mint, escrow, escrowBump, rewardAmount };
}

function mintFixture({ freezeAuthority = null, initialized = true } = {}) {
  const data = Buffer.alloc(82);
  data.writeUInt32LE(0, 0);
  data.writeBigUInt64LE(10_000n, 36);
  data[44] = 6;
  data[45] = initialized ? 1 : 0;
  if (freezeAuthority) {
    data.writeUInt32LE(1, 46);
    freezeAuthority.toBuffer().copy(data, 50);
  } else {
    data.writeUInt32LE(0, 46);
  }
  return data;
}

function escrowFixture(value, { amount = value.rewardAmount, distributed = 100n } = {}) {
  const data = Buffer.alloc(58);
  discriminator("TaskEscrow").copy(data);
  value.task.toBuffer().copy(data, 8);
  data.writeBigUInt64LE(amount, 40);
  data.writeBigUInt64LE(distributed, 48);
  data[56] = 0;
  data[57] = value.escrowBump;
  return data;
}

function ataFixture(value, { amount = 900n, state = 1, authority = value.escrow } = {}) {
  const data = Buffer.alloc(165);
  value.mint.toBuffer().copy(data, 0);
  authority.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data.writeUInt32LE(0, 72);
  data[108] = state;
  data.writeUInt32LE(0, 109);
  data.writeUInt32LE(0, 129);
  return data;
}

function account(data, owner, overrides = {}) {
  return {
    data,
    owner,
    executable: false,
    lamports: 2_000_000,
    ...overrides,
  };
}

function scenario(options = {}) {
  const value = taskFixture(options);
  const ata = deriveEscrowAta(value.escrow, value.mint);
  assert.equal(
    ata.toBase58(),
    PublicKey.findProgramAddressSync(
      [
        value.escrow.toBuffer(),
        TOKEN_PROGRAM_ID.toBuffer(),
        value.mint.toBuffer(),
      ],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    )[0].toBase58(),
  );
  const records = new Map([
    [value.mint.toBase58(), account(mintFixture(), TOKEN_PROGRAM_ID)],
    [value.escrow.toBase58(), account(escrowFixture(value), PROGRAM_ID)],
    [ata.toBase58(), account(ataFixture(value), TOKEN_PROGRAM_ID)],
  ]);
  return { value, ata, records };
}

function connectionFor(value, records, taskOverrides = {}) {
  return {
    getGenesisHash: async () => MAINNET_GENESIS,
    getProgramAccounts: async () => [
      {
        pubkey: value.task,
        account: account(
          taskOverrides.data ?? value.data,
          taskOverrides.owner ?? PROGRAM_ID,
        ),
      },
    ],
    getMultipleAccountsInfo: async (addresses) =>
      addresses.map((address) => records.get(address.toBase58()) ?? null),
  };
}

test("decodes exact classic Mint, TokenAccount, and TaskEscrow layouts", () => {
  const { value } = scenario();
  const mint = decodeClassicMint(mintFixture());
  assert.equal(mint.initialized, true);
  assert.equal(mint.freezeAuthority, null);
  assert.equal(mint.supply, 10_000n);

  const ata = decodeClassicTokenAccount(ataFixture(value));
  assert.equal(ata.mint.toBase58(), value.mint.toBase58());
  assert.equal(ata.authority.toBase58(), value.escrow.toBase58());
  assert.equal(ata.amount, 900n);
  assert.equal(ata.state, 1);

  const escrow = decodeTaskEscrow(escrowFixture(value));
  assert.equal(escrow.amount, 1_000n);
  assert.equal(escrow.distributed, 100n);
  assert.equal(escrow.closed, false);
});

test("accepts a canonical live token Task with sufficient unfrozen ATA principal", async () => {
  const { value, records } = scenario();
  const result = await scanTokenRewardTasks(connectionFor(value, records));
  assert.equal(result.accountCount, 1);
  assert.equal(result.tokenTaskCount, 1);
  assert.equal(result.liveCount, 1);
  assert.equal(result.terminalCount, 0);
  assert.deepEqual(result.blockers, []);
});

test("inventories terminal token Tasks without requiring already-closed escrow state", async () => {
  const { value } = scenario({ status: 3 });
  const result = await scanTokenRewardTasks(
    connectionFor(value, new Map()),
  );
  assert.equal(result.liveCount, 0);
  assert.equal(result.terminalCount, 1);
  assert.deepEqual(result.blockers, []);
});

test("blocks freezable mints and insufficient live token principal", async () => {
  const { value, ata, records } = scenario();
  records.set(
    value.mint.toBase58(),
    account(
      mintFixture({ freezeAuthority: new PublicKey(Buffer.alloc(32, 84)) }),
      TOKEN_PROGRAM_ID,
    ),
  );
  records.set(
    ata.toBase58(),
    account(ataFixture(value, { amount: 899n }), TOKEN_PROGRAM_ID),
  );
  const result = await scanTokenRewardTasks(connectionFor(value, records));
  assert.ok(result.blockers.some((item) => item.kind === "freezable-token-reward-mint"));
  assert.ok(
    result.blockers.some(
      (item) => item.kind === "insufficient-token-escrow-principal",
    ),
  );
});

test("blocks non-classic mints, frozen/wrong-authority ATAs, and malformed escrow", async () => {
  const { value, ata, records } = scenario();
  records.set(
    value.mint.toBase58(),
    account(mintFixture(), new PublicKey(Buffer.alloc(32, 85))),
  );
  records.set(
    ata.toBase58(),
    account(
      ataFixture(value, {
        state: 2,
        authority: new PublicKey(Buffer.alloc(32, 86)),
      }),
      TOKEN_PROGRAM_ID,
    ),
  );
  const badEscrow = escrowFixture(value);
  badEscrow[56] = 1;
  records.set(value.escrow.toBase58(), account(badEscrow, PROGRAM_ID));

  const result = await scanTokenRewardTasks(connectionFor(value, records));
  assert.ok(
    result.blockers.some((item) => item.kind === "unsafe-token-reward-mint-owner"),
  );
  assert.ok(
    result.blockers.some((item) => item.kind === "invalid-token-task-escrow-layout"),
  );
  assert.ok(
    result.blockers.some((item) => item.kind === "invalid-token-escrow-ata-layout"),
  );
});

test("fails closed on malformed Task binding and refuses non-mainnet", async () => {
  const { value, records } = scenario();
  const badTask = Buffer.from(value.data);
  badTask[0] ^= 0xff;
  let result = await scanTokenRewardTasks(
    connectionFor(value, records, { data: badTask }),
  );
  assert.ok(result.blockers.some((item) => item.kind === "invalid-token-task-layout"));

  let enumerated = false;
  await assert.rejects(
    scanTokenRewardTasks({
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
