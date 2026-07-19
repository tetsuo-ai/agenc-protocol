import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import {
  MAINNET_GENESIS,
  PROGRAM_ID,
  REPUTATION_STAKE_LOCK_SECS,
  REPUTATION_STAKE_SIZE,
  decodeReputationStake,
  scanReputationStakes,
} from "./preflight-reputation-stake-scan.mjs";

const require = createRequire(
  new URL("../tests-integration/package.json", import.meta.url),
);
const { PublicKey, SystemProgram } = require("@solana/web3.js");

function discriminator(name) {
  return createHash("sha256")
    .update(`account:${name}`)
    .digest()
    .subarray(0, 8);
}

function agentFixture(marker, { retired = false, malformed = false } = {}) {
  const agentId = Buffer.alloc(32, marker);
  const authority = new PublicKey(Buffer.alloc(32, marker + 1));
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), agentId],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(566);
  discriminator("AgentRegistration").copy(data);
  agentId.copy(data, 8);
  authority.toBuffer().copy(data, 40);
  data[80] = 1;
  data.writeUInt32LE(0, 81);
  data.writeUInt32LE(0, 85);
  data.writeBigInt64LE(100n, 89);
  data[133] = bump;
  if (retired) Buffer.from("RETD", "ascii").copy(data, 178);
  if (malformed) data[178] = 0x7f;
  return { address, data };
}

function stakeFixture(
  agent,
  {
    amount = 50_000n,
    rent = 1_000_000n,
    lamports = rent + amount,
    createdAt = 1_000n,
    lockedUntil = createdAt + REPUTATION_STAKE_LOCK_SECS,
    corruptDiscriminator = false,
    nonzeroReserved = false,
  } = {},
) {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("reputation_stake"), agent.toBuffer()],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(REPUTATION_STAKE_SIZE);
  discriminator("ReputationStake").copy(data);
  agent.toBuffer().copy(data, 8);
  data.writeBigUInt64LE(amount, 40);
  data.writeBigInt64LE(lockedUntil, 48);
  data[56] = 3;
  data.writeBigInt64LE(createdAt, 57);
  data[65] = bump;
  if (corruptDiscriminator) data[0] ^= 0xff;
  if (nonzeroReserved) data[73] = 1;
  return { address, data, lamports: Number(lamports) };
}

function accountInfo(item, overrides = {}) {
  return {
    owner: overrides.owner ?? PROGRAM_ID,
    executable: overrides.executable ?? false,
    data: overrides.data ?? item.data,
    lamports: overrides.lamports ?? item.lamports ?? 1_000_000,
  };
}

function connectionWith(
  stakes,
  agents = new Map(),
  { genesis = MAINNET_GENESIS, rent = 1_000_000 } = {},
) {
  return {
    getGenesisHash: async () => genesis,
    getMinimumBalanceForRentExemption: async (size, commitment) => {
      assert.equal(size, REPUTATION_STAKE_SIZE);
      assert.equal(commitment, "confirmed");
      return rent;
    },
    getProgramAccounts: async (program, options) => {
      assert.ok(program.equals(PROGRAM_ID));
      assert.deepEqual(options.filters, [{ dataSize: REPUTATION_STAKE_SIZE }]);
      return stakes.map((item) => ({
        pubkey: item.address,
        account: accountInfo(item, item.accountOverrides),
      }));
    },
    getAccountInfo: async (address, commitment) => {
      assert.equal(commitment, "confirmed");
      return agents.get(address.toBase58()) ?? null;
    },
  };
}

test("decodes only the exact ReputationStake layout and invariants", () => {
  const agent = agentFixture(11);
  const fixture = stakeFixture(agent.address);
  assert.deepEqual(decodeReputationStake(fixture.data), {
    agent: agent.address,
    stakedAmount: 50_000n,
    lockedUntil: 605_800n,
    slashCount: 3,
    createdAt: 1_000n,
    bump: fixture.data[65],
  });

  assert.throws(
    () => decodeReputationStake(fixture.data.subarray(0, 73)),
    /expected exactly 74/,
  );
  assert.throws(
    () =>
      decodeReputationStake(
        stakeFixture(agent.address, { corruptDiscriminator: true }).data,
      ),
    /discriminator mismatch/,
  );
  assert.throws(
    () =>
      decodeReputationStake(
        stakeFixture(agent.address, { nonzeroReserved: true }).data,
      ),
    /reserved bytes are non-zero/,
  );
  assert.throws(
    () =>
      decodeReputationStake(
        stakeFixture(agent.address, { lockedUntil: 605_799n }).data,
      ),
    /precedes created_at \+ cooldown/,
  );
});

test("accepts fully backed nonzero principal for live and retired agents", async () => {
  const live = agentFixture(21);
  const retired = agentFixture(31, { retired: true });
  const stakes = [
    stakeFixture(live.address, { amount: 40_000n, lamports: 1_050_000n }),
    stakeFixture(retired.address, { amount: 60_000n, lamports: 1_060_000n }),
  ];
  const agents = new Map([
    [live.address.toBase58(), accountInfo(live)],
    [retired.address.toBase58(), accountInfo(retired)],
  ]);

  const result = await scanReputationStakes(connectionWith(stakes, agents));
  assert.equal(result.accountCount, 2);
  assert.equal(result.decodedAccountCount, 2);
  assert.equal(result.liveAgentCount, 1);
  assert.equal(result.retiredAgentCount, 1);
  assert.equal(result.trackedStakedAmount, 100_000n);
  assert.equal(result.actualLamports, 2_110_000n);
  assert.equal(result.requiredRentLamports, 2_000_000n);
  assert.equal(result.requiredBackingLamports, 2_100_000n);
  assert.equal(result.backingDeficitLamports, 0n);
  assert.equal(result.backingSurplusLamports, 10_000n);
  assert.deepEqual(result.blockers, []);
});

test("per-account deficit is not masked by another account's surplus", async () => {
  const first = agentFixture(41);
  const second = agentFixture(51);
  const stakes = [
    stakeFixture(first.address, {
      amount: 50_000n,
      lamports: 1_040_000n,
    }),
    stakeFixture(second.address, {
      amount: 50_000n,
      lamports: 1_070_000n,
    }),
  ];
  const agents = new Map([
    [first.address.toBase58(), accountInfo(first)],
    [second.address.toBase58(), accountInfo(second)],
  ]);

  const result = await scanReputationStakes(connectionWith(stakes, agents));
  assert.equal(result.actualLamports, result.requiredBackingLamports + 10_000n);
  assert.equal(result.underbackedAccountCount, 1);
  assert.equal(result.backingDeficitLamports, 10_000n);
  assert.equal(result.backingSurplusLamports, 20_000n);
  assert.ok(
    result.blockers.some(
      (item) => item.kind === "underbacked-reputation-stake",
    ),
  );
});

test("allows an empty historical stake without an agent but blocks orphan principal", async () => {
  const emptyAgent = agentFixture(61);
  const fundedAgent = agentFixture(71);
  const stakes = [
    stakeFixture(emptyAgent.address, { amount: 0n }),
    stakeFixture(fundedAgent.address, { amount: 9_000n }),
  ];
  const systemEmpty = {
    owner: SystemProgram.programId,
    executable: false,
    data: Buffer.alloc(0),
    lamports: 0,
  };
  const agents = new Map([
    [emptyAgent.address.toBase58(), systemEmpty],
    [fundedAgent.address.toBase58(), systemEmpty],
  ]);

  const result = await scanReputationStakes(connectionWith(stakes, agents));
  assert.equal(result.absentAgentCount, 2);
  assert.equal(result.principalWithoutAgentCount, 1);
  assert.equal(result.principalWithoutAgentLamports, 9_000n);
  assert.equal(
    result.blockers.filter(
      (item) => item.kind === "reputation-stake-principal-without-agent",
    ).length,
    1,
  );
});

test("size enumeration catches a corrupt discriminator", async () => {
  const agent = agentFixture(81);
  const stake = stakeFixture(agent.address, { corruptDiscriminator: true });
  const result = await scanReputationStakes(connectionWith([stake]));
  assert.equal(result.accountCount, 1);
  assert.equal(result.decodedAccountCount, 0);
  assert.match(result.blockers[0].detail, /discriminator mismatch/);
});

test("blocks invalid stake ownership, PDA identity, and agent layout", async () => {
  const wrongOwnerAgent = agentFixture(91);
  const wrongOwnerStake = stakeFixture(wrongOwnerAgent.address);
  wrongOwnerStake.accountOverrides = { owner: SystemProgram.programId };

  const wrongPdaAgent = agentFixture(101);
  const wrongPdaStake = stakeFixture(wrongPdaAgent.address);
  wrongPdaStake.address = new PublicKey(Buffer.alloc(32, 103));

  const malformedAgent = agentFixture(111, { malformed: true });
  const malformedStake = stakeFixture(malformedAgent.address);
  const agents = new Map([
    [malformedAgent.address.toBase58(), accountInfo(malformedAgent)],
  ]);

  const result = await scanReputationStakes(
    connectionWith(
      [wrongOwnerStake, wrongPdaStake, malformedStake],
      agents,
    ),
  );
  assert.deepEqual(
    new Set(result.blockers.map((item) => item.kind)),
    new Set([
      "invalid-reputation-stake-account",
      "invalid-reputation-stake-pda",
      "invalid-reputation-stake-agent-binding",
    ]),
  );
});

test("fails closed on wrong genesis and invalid rent", async () => {
  await assert.rejects(
    () =>
      scanReputationStakes(
        connectionWith([], new Map(), { genesis: "devnet" }),
      ),
    /wrong cluster genesis/,
  );
  await assert.rejects(
    () =>
      scanReputationStakes(
        connectionWith([], new Map(), { rent: Number.NaN }),
      ),
    /non-negative safe-integer lamports/,
  );
});
