import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MAINNET_GENESIS,
  PROGRAM_ID,
  decodeAgentBinding,
  decodeClaimBinding,
  decodeDispute,
  decodeTaskBinding,
  isResolvedUnappliedWorkerLoss,
  scanDisputes,
} from "./preflight-dispute-scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(
  path.join(ROOT, "tests-integration", "package.json"),
);
const { PublicKey } = require("@solana/web3.js");

function discriminator(name) {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

function disputeFixture({
  disputeId = Buffer.alloc(32, 7),
  task,
  initiator,
  initiatorAuthority,
  defendant,
  resolutionType = 0,
  status = 1,
  votesFor = 1n,
  votesAgainst = 0n,
  totalVoters = 0,
  slashApplied = false,
  initiatorSlashApplied = false,
  resolvedAt = 100n,
  votingDeadline = 1_000n,
  expiresAt = 2_000n,
  bump,
  legacy = false,
  preChunk = false,
  rationaleUri = "",
  peerWorkersTotal = 0,
  peerWorkersSettled = 0,
  pendingTerminalStatus = 0,
}) {
  const data = Buffer.alloc(legacy ? 263 : preChunk ? 587 : 590);
  discriminator("Dispute").copy(data, 0);
  disputeId.copy(data, 8);
  task.toBuffer().copy(data, 40);
  initiator.toBuffer().copy(data, 72);
  initiatorAuthority.toBuffer().copy(data, 104);
  data[168] = resolutionType;
  data[169] = status;
  data.writeBigInt64LE(resolvedAt, 178);
  data.writeBigUInt64LE(votesFor, 186);
  data.writeBigUInt64LE(votesAgainst, 194);
  data[202] = totalVoters;
  data.writeBigInt64LE(votingDeadline, 203);
  data.writeBigInt64LE(expiresAt, 211);
  data[219] = Number(slashApplied);
  data[220] = Number(initiatorSlashApplied);
  data[230] = bump;
  defendant.toBuffer().copy(data, 231);
  if (!legacy) {
    const uri = Buffer.from(rationaleUri);
    data.writeUInt32LE(uri.length, 295);
    uri.copy(data, 299);
    if (!preChunk) {
      data[331 + uri.length] = peerWorkersTotal;
      data[332 + uri.length] = peerWorkersSettled;
      data[333 + uri.length] = pendingTerminalStatus;
    }
  }
  return data;
}

function taskFixture({
  taskId,
  creator,
  currentWorkers = 1,
  pending = false,
  bump,
}) {
  const data = Buffer.alloc(466);
  discriminator("Task").copy(data, 0);
  taskId.copy(data, 8);
  creator.toBuffer().copy(data, 40);
  data[185] = currentWorkers;
  data[310] = bump;
  // None depends_on at 313; dependency_type+min_reputation at 314..316;
  // None reward_mint at 317; operator(32)+fee(2), then reserved at 352.
  data[313] = 0;
  data[314] = 0;
  data[317] = 0;
  data[354] = Number(pending);
  return data;
}

function claimFixture({ task, worker, bump }) {
  const data = Buffer.alloc(203);
  discriminator("TaskClaim").copy(data, 0);
  task.toBuffer().copy(data, 8);
  worker.toBuffer().copy(data, 40);
  data[202] = bump;
  return data;
}

function agentFixture({
  agentId,
  authority,
  bump,
  reputation = 7_500,
  stake = 90_000n,
  lastVoteTimestamp = 75n,
  pendingInitiatorOutcomes = 0,
  disputesAsDefendant = 0,
}) {
  const data = Buffer.alloc(566);
  discriminator("AgentRegistration").copy(data, 0);
  agentId.copy(data, 8);
  authority.toBuffer().copy(data, 40);
  data[80] = 1;
  // Empty endpoint + metadata strings. The remaining fixed fields follow their
  // actual Borsh encodings; bump is 44 bytes after registered_at.
  data.writeUInt32LE(0, 81);
  data.writeUInt32LE(0, 85);
  data.writeBigInt64LE(50n, 89);
  data.writeUInt16LE(reputation, 121);
  data.writeBigUInt64LE(stake, 125);
  data[133] = bump;
  data[160] = pendingInitiatorOutcomes;
  data.writeBigInt64LE(lastVoteTimestamp, 161);
  data[177] = disputesAsDefendant;
  return data;
}

function scenario({
  pending,
  missingClaim = false,
  status = 1,
  slashApplied = false,
  currentWorkers = 1,
  legacy = false,
  preChunk = false,
  rationaleUri,
  peerWorkersTotal,
  peerWorkersSettled,
  pendingTerminalStatus,
  votesFor,
  votesAgainst,
  totalVoters = 0,
  initiatorSlashApplied = true,
  resolvedAt = 100n,
  missingInitiator = false,
  pendingInitiatorOutcomes = 0,
  disputesAsDefendant = 0,
}) {
  const taskId = Buffer.alloc(32, 9);
  const creator = new PublicKey(Buffer.alloc(32, 10));
  const defendant = new PublicKey(Buffer.alloc(32, 11));
  const initiatorAgentId = Buffer.alloc(32, 13);
  const initiatorAuthority = new PublicKey(Buffer.alloc(32, 14));
  const [initiator, initiatorBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), initiatorAgentId],
    PROGRAM_ID,
  );
  const [task, taskBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("task"), creator.toBuffer(), taskId],
    PROGRAM_ID,
  );
  const [claim, claimBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("claim"), task.toBuffer(), defendant.toBuffer()],
    PROGRAM_ID,
  );
  const disputeId = Buffer.alloc(32, 12);
  const [dispute, disputeBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("dispute"), disputeId],
    PROGRAM_ID,
  );
  const disputeData = disputeFixture({
    disputeId,
    task,
    initiator,
    initiatorAuthority,
    defendant,
    status,
    votesFor: votesFor ?? (status === 1 ? 1n : 0n),
    votesAgainst: votesAgainst ?? 0n,
    totalVoters,
    slashApplied,
    initiatorSlashApplied,
    resolvedAt,
    bump: disputeBump,
    legacy,
    preChunk,
    rationaleUri,
    peerWorkersTotal,
    peerWorkersSettled,
    pendingTerminalStatus,
  });
  const taskData = taskFixture({
    taskId,
    creator,
    currentWorkers,
    pending,
    bump: taskBump,
  });
  const claimData = claimFixture({ task, worker: defendant, bump: claimBump });
  const initiatorData = agentFixture({
    agentId: initiatorAgentId,
    authority: initiatorAuthority,
    bump: initiatorBump,
    pendingInitiatorOutcomes,
    disputesAsDefendant,
  });
  return {
    pubkey: dispute,
    account: { owner: PROGRAM_ID, data: disputeData },
    agentPubkey: initiator,
    agentAccount: { owner: PROGRAM_ID, data: initiatorData },
    getMultipleAccountsInfo: async ([taskAddress, claimAddress]) => {
      assert.equal(taskAddress.toBase58(), task.toBase58());
      assert.equal(claimAddress.toBase58(), claim.toBase58());
      return [
        { owner: PROGRAM_ID, data: taskData, lamports: 1 },
        missingClaim
          ? null
          : { owner: PROGRAM_ID, data: claimData, lamports: 1 },
      ];
    },
    getAccountInfo: async (address) => {
      assert.equal(address.toBase58(), initiator.toBase58());
      return missingInitiator
        ? null
        : { owner: PROGRAM_ID, data: initiatorData, lamports: 1 };
    },
  };
}

function connectionFor(value) {
  return {
    getGenesisHash: async () => MAINNET_GENESIS,
    getProgramAccounts: async (_programId, options) => {
      const discriminatorBytes = options?.filters?.[0]?.memcmp?.bytes;
      if (
        discriminatorBytes ===
        discriminator("AgentRegistration").toString("base64")
      ) {
        return [{ pubkey: value.agentPubkey, account: value.agentAccount }];
      }
      assert.equal(
        discriminatorBytes,
        discriminator("Dispute").toString("base64"),
      );
      return [value];
    },
    getMultipleAccountsInfo: value.getMultipleAccountsInfo,
    getAccountInfo: value.getAccountInfo,
  };
}

test("decodes the frozen dispute prefix and worker-loss predicate", () => {
  const value = scenario({ pending: false });
  const decoded = decodeDispute(value.account.data);
  assert.equal(decoded.status, 1);
  assert.equal(decoded.slashApplied, false);
  assert.equal(isResolvedUnappliedWorkerLoss(decoded), true);
});

test("decodes Task reserved[2] and canonical TaskClaim binding fields", () => {
  const taskId = Buffer.alloc(32, 1);
  const creator = new PublicKey(Buffer.alloc(32, 2));
  const task = decodeTaskBinding(
    taskFixture({ taskId, creator, pending: true, bump: 3 }),
  );
  assert.equal(task.workerSlashPending, true);
  const claim = decodeClaimBinding(
    claimFixture({ task: creator, worker: creator, bump: 4 }),
  );
  assert.equal(claim.bump, 4);
});

test("decodes the exact fixed AgentRegistration allocation and dynamic Borsh bump", () => {
  const agentId = Buffer.alloc(32, 21);
  const authority = new PublicKey(Buffer.alloc(32, 22));
  const decoded = decodeAgentBinding(
    agentFixture({ agentId, authority, bump: 23 }),
  );
  assert.deepEqual(decoded.agentId, agentId);
  assert.equal(decoded.authority.toBase58(), authority.toBase58());
  assert.equal(decoded.reputation, 7_500);
  assert.equal(decoded.stake, 90_000n);
  assert.equal(decoded.pendingInitiatorOutcomes, 0);
  assert.equal(decoded.lastVoteTimestamp, 75n);
  assert.equal(decoded.disputesAsDefendant, 0);
  assert.equal(decoded.bump, 23);
});

test("fails closed on a legacy resolved/unapplied worker loss with pending flag zero", async () => {
  const value = scenario({ pending: false });
  const result = await scanDisputes(connectionFor(value), {
    nowUnixTimestamp: 100n,
  });
  assert.ok(
    result.blockers.some(
      (item) => item.kind === "legacy-worker-slash-flag-missing",
    ),
  );
});

test("accepts a resolved worker loss only when pending flag and claim binding are live", async () => {
  const value = scenario({ pending: true });
  const result = await scanDisputes(connectionFor(value), {
    nowUnixTimestamp: 100n,
  });
  assert.deepEqual(result.blockers, []);
  assert.equal(result.statusCounts.resolved, 1);
});

test("requires a canonical live claim for Active disputes", async () => {
  const value = scenario({ pending: false, missingClaim: true, status: 0 });
  const result = await scanDisputes(connectionFor(value), {
    nowUnixTimestamp: 100n,
  });
  assert.ok(
    result.blockers.some((item) => item.kind === "missing-defendant-claim"),
  );
});

test("accepts a settled zero-monetary legacy ruling with no claim and no worker slot", async () => {
  const value = scenario({
    pending: false,
    missingClaim: true,
    currentWorkers: 0,
  });
  const result = await scanDisputes(connectionFor(value), {
    nowUnixTimestamp: 100n,
  });
  assert.deepEqual(result.blockers, []);
});

test("fails closed on one-sided resolved claim/worker-count state", async () => {
  for (const fixture of [
    { missingClaim: true, currentWorkers: 1 },
    { missingClaim: false, currentWorkers: 0 },
  ]) {
    const value = scenario({ pending: false, ...fixture });
    const result = await scanDisputes(connectionFor(value), {
      nowUnixTimestamp: 100n,
    });
    assert.ok(
      result.blockers.some(
        (item) => item.kind === "inconsistent-resolved-worker-state",
      ),
    );
  }
});

test("blocks legacy Dispute layouts that still need an active or finalizer exit", async () => {
  for (const fixture of [
    { status: 0, pending: false },
    { status: 1, pending: true },
  ]) {
    const value = scenario({ ...fixture, legacy: true });
    const result = await scanDisputes(connectionFor(value), {
      nowUnixTimestamp: 100n,
    });
    assert.ok(
      result.blockers.some(
        (item) =>
          item.kind === "legacy-active-dispute-layout" ||
          item.kind === "legacy-resolved-dispute-needs-finalizer",
      ),
    );
  }
});

test("legacy no-fault outcomes own no counter, while every loss or tagged outcome blocks", async () => {
  for (const fixture of [
    { status: 1, votesFor: 1n, votesAgainst: 0n },
    { status: 2, votesFor: 0n, votesAgainst: 0n },
  ]) {
    const safeLegacy = scenario({
      ...fixture,
      pending: false,
      legacy: true,
      resolvedAt: 100n,
      slashApplied: true,
      initiatorSlashApplied: false,
      missingClaim: true,
      currentWorkers: 0,
    });
    const safeResult = await scanDisputes(connectionFor(safeLegacy), {
      nowUnixTimestamp: 200n,
    });
    assert.deepEqual(safeResult.blockers, []);
  }

  for (const fixture of [
    { status: 1, votesFor: 0n, votesAgainst: 1n },
    { status: 3, votesFor: 0n, votesAgainst: 0n },
  ]) {
    const value = scenario({
      ...fixture,
      pending: false,
      legacy: true,
      resolvedAt: 100n,
      slashApplied: true,
      initiatorSlashApplied: false,
    });
    const result = await scanDisputes(connectionFor(value), {
      nowUnixTimestamp: 200n,
    });
    assert.ok(
      result.blockers.some(
        (item) =>
          item.kind === "actionable-legacy-initiator-liability-unapplied",
      ),
    );
  }

  for (const fixture of [
    { status: 1, votesFor: 1n, votesAgainst: 0n },
    { status: 2, votesFor: 0n, votesAgainst: 0n },
  ]) {
    const tracked = scenario({
      ...fixture,
      pending: false,
      totalVoters: 0xff,
      resolvedAt: 100n,
      slashApplied: true,
      initiatorSlashApplied: false,
    });
    const trackedResult = await scanDisputes(connectionFor(tracked), {
      nowUnixTimestamp: 200n,
    });
    assert.ok(
      trackedResult.blockers.some(
        (item) => item.kind === "tracked-initiator-outcome-unapplied",
      ),
    );
  }

  const missing = scenario({
    pending: false,
    status: 0,
    missingInitiator: true,
  });
  const missingResult = await scanDisputes(connectionFor(missing), {
    nowUnixTimestamp: 200n,
  });
  assert.ok(
    missingResult.blockers.some(
      (item) => item.kind === "missing-dispute-initiator",
    ),
  );
});

test("preserves the legacy slash deadline while tagged outcomes never age out", async () => {
  const applied = scenario({
    pending: false,
    status: 1,
    votesFor: 0n,
    votesAgainst: 1n,
    legacy: true,
    resolvedAt: 100n,
    initiatorSlashApplied: true,
    missingClaim: true,
    currentWorkers: 0,
  });
  const appliedResult = await scanDisputes(connectionFor(applied), {
    nowUnixTimestamp: 604_901n,
  });
  assert.deepEqual(appliedResult.blockers, []);

  const elapsedUnapplied = scenario({
    pending: false,
    status: 3,
    votesFor: 0n,
    votesAgainst: 0n,
    legacy: false,
    resolvedAt: 100n,
    initiatorSlashApplied: false,
    missingClaim: true,
    currentWorkers: 0,
  });
  const elapsedResult = await scanDisputes(connectionFor(elapsedUnapplied), {
    nowUnixTimestamp: 604_901n,
  });
  assert.deepEqual(elapsedResult.blockers, []);
  assert.equal(elapsedResult.expiredLegacyInitiatorLiabilityCount, 1);

  const taggedUnapplied = scenario({
    pending: false,
    status: 3,
    votesFor: 0n,
    votesAgainst: 0n,
    totalVoters: 0xff,
    resolvedAt: 100n,
    initiatorSlashApplied: false,
    missingClaim: true,
    currentWorkers: 0,
  });
  const taggedResult = await scanDisputes(connectionFor(taggedUnapplied), {
    nowUnixTimestamp: 604_901n,
  });
  assert.ok(
    taggedResult.blockers.some(
      (item) => item.kind === "tracked-initiator-outcome-unapplied",
    ),
    "provenance-tagged outcome cannot age out",
  );
});

test("rejects malformed Active and terminal resolution timestamps before policy classification", async () => {
  for (const fixture of [
    { status: 0, resolvedAt: 1n },
    { status: 3, resolvedAt: 0n },
  ]) {
    const value = scenario({
      ...fixture,
      pending: false,
      initiatorSlashApplied: true,
    });
    const result = await scanDisputes(connectionFor(value), {
      nowUnixTimestamp: 604_901n,
    });
    assert.ok(
      result.blockers.some(
        (item) => item.kind === "invalid-dispute-resolution-timestamp",
      ),
    );
  }
});

test("accepts only zero or the current counter-provenance sentinel in retired voter state", async () => {
  const marked = scenario({
    pending: false,
    totalVoters: 0xff,
    initiatorSlashApplied: true,
    slashApplied: true,
    missingClaim: true,
    currentWorkers: 0,
  });
  const markedResult = await scanDisputes(connectionFor(marked), {
    nowUnixTimestamp: 100n,
  });
  assert.deepEqual(markedResult.blockers, []);

  const legacyVote = scenario({
    pending: false,
    totalVoters: 1,
    initiatorSlashApplied: true,
    slashApplied: true,
    missingClaim: true,
    currentWorkers: 0,
  });
  const legacyResult = await scanDisputes(connectionFor(legacyVote), {
    nowUnixTimestamp: 100n,
  });
  assert.ok(
    legacyResult.blockers.some((item) => item.kind === "legacy-arbiter-voters"),
  );
});

test("blocks any non-zero legacy agent byte before repurposing it", async () => {
  const value = scenario({
    pending: false,
    initiatorSlashApplied: true,
    pendingInitiatorOutcomes: 2,
  });
  const result = await scanDisputes(connectionFor(value), {
    nowUnixTimestamp: 100n,
  });
  const blocker = result.blockers.find(
    (item) => item.kind === "legacy-agent-initiator-counter-nonzero",
  );
  assert.ok(blocker);
  assert.match(blocker.detail, /active_dispute_votes=2/);
});

test("blocks a non-zero defendant counter before removing its timestamp bypass", async () => {
  const value = scenario({
    pending: false,
    initiatorSlashApplied: true,
    disputesAsDefendant: 1,
  });
  const result = await scanDisputes(connectionFor(value), {
    nowUnixTimestamp: 100n,
  });
  const blocker = result.blockers.find(
    (item) => item.kind === "legacy-agent-defendant-counter-nonzero",
  );
  assert.ok(blocker);
  assert.match(blocker.detail, /disputes_as_defendant=1/);
});

test("refuses non-mainnet before enumerating disputes", async () => {
  let enumerated = false;
  await assert.rejects(
    scanDisputes({
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

test("requires zero Active disputes regardless of their current deadline position", async () => {
  for (const nowUnixTimestamp of [100n, 1_120n, 5_001n]) {
    const value = scenario({ pending: false, status: 0 });
    value.account.data.writeBigInt64LE(1_000n, 203);
    value.account.data.writeBigInt64LE(5_000n, 211);
    const result = await scanDisputes(connectionFor(value), {
      nowUnixTimestamp,
    });
    const active = result.blockers.find(
      (item) => item.kind === "active-dispute-cutover",
    );
    assert.ok(active);
    assert.match(active.detail, /voting_deadline=1000/);
  }
});

for (const pendingTerminalStatus of [1, 2]) {
  test(`AGNC-01: pending peers block cutover for terminal status ${pendingTerminalStatus}, even with no liability counters or defendant claim`, async () => {
    const value = scenario({
      status: 4,
      missingClaim: true,
      currentWorkers: 2,
      pending: false,
      peerWorkersTotal: 3,
      peerWorkersSettled: 1,
      pendingTerminalStatus,
      votesFor: pendingTerminalStatus === 1 ? 1n : 0n,
      rationaleUri: "x".repeat(256),
    });
    const decoded = decodeDispute(value.account.data);
    assert.equal(decoded.peerWorkersTotal, 3);
    assert.equal(decoded.peerWorkersSettled, 1);
    assert.equal(decoded.pendingTerminalStatus, pendingTerminalStatus);
    const result = await scanDisputes(connectionFor(value), {
      nowUnixTimestamp: 100n,
    });
    assert.equal(result.statusCounts.settlementPending, 1);
    assert.ok(
      result.blockers.some((b) => b.kind === "pending-peer-settlement-cutover"),
    );
    assert.ok(
      !result.blockers.some((b) => b.kind === "invalid-dispute-layout"),
    );
  });
}

test("AGNC-01: completed peer settlement can pass the cutover scan", async () => {
  const value = scenario({
    status: 2,
    missingClaim: true,
    currentWorkers: 0,
    peerWorkersTotal: 3,
    peerWorkersSettled: 3,
    pendingTerminalStatus: 2,
  });
  const result = await scanDisputes(connectionFor(value), {
    nowUnixTimestamp: 100n,
  });
  assert.deepEqual(result.blockers, []);
  assert.equal(result.statusCounts.expired, 1);
});

test("AGNC-01: ambiguous/corrupt peer layouts fail closed", () => {
  for (const fields of [
    { preChunk: true },
    { legacy: true },
    { peerWorkersTotal: 0 },
    { peerWorkersSettled: 1 },
    { peerWorkersSettled: 2 },
    { pendingTerminalStatus: 0 },
    { pendingTerminalStatus: 3 },
    { rationaleUri: "x".repeat(257) },
    { status: 2 },
  ]) {
    const value = scenario({
      status: 4,
      peerWorkersTotal: 1,
      peerWorkersSettled: 0,
      pendingTerminalStatus: 2,
      ...fields,
    });
    assert.throws(() => decodeDispute(value.account.data), /Dispute/);
  }
  const historical = scenario({ preChunk: true });
  assert.equal(decodeDispute(historical.account.data).legacyLayout, true);
});

test("AGNC-01: Task peer reservation is a separate canonical bool", () => {
  const value = taskFixture({
    taskId: Buffer.alloc(32, 1),
    creator: new PublicKey(Buffer.alloc(32, 2)),
    pending: false,
    bump: 3,
  });
  assert.equal(decodeTaskBinding(value).peerSettlementPending, false);
  value[363] = 1; // actual Borsh reserved base (352) + peer flag (11)
  assert.equal(decodeTaskBinding(value).peerSettlementPending, true);
  assert.equal(decodeTaskBinding(value).workerSlashPending, false);
  value[363] = 2;
  assert.throws(
    () => decodeTaskBinding(value),
    /peer_settlement_pending: invalid bool/,
  );
});

for (const [name, fields, count, expected] of [
  [
    "historical two active disputes",
    { status: 0, resolvedAt: 0n, pendingInitiatorOutcomes: 1 },
    2,
    2,
  ],
  [
    "after expiry and one finalization",
    { status: 2, finalizeSibling: true },
    2,
    1,
  ],
  ["matching counters", { status: 2, pendingInitiatorOutcomes: 2 }, 2, 0],
  [
    "pending peer settlement",
    { status: 4, peerWorkersTotal: 1, pendingTerminalStatus: 2 },
    1,
    1,
  ],
  ["legacy zero marker", { status: 2, totalVoters: 0 }, 2, 0],
  [
    "finalized tracked outcomes",
    { status: 2, initiatorSlashApplied: true },
    2,
    0,
  ],
]) {
  test(`initiator deficit: ${name}`, async () => {
    const value = scenario({
      totalVoters: 0xff,
      initiatorSlashApplied: false,
      ...fields,
    });
    const connection = connectionFor(value);
    const original = connection.getProgramAccounts;
    const disputes = Array.from({ length: count }, (_, i) => {
      const data = Buffer.from(value.account.data);
      const id = Buffer.alloc(32, 30 + i);
      const [pubkey, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from("dispute"), id],
        PROGRAM_ID,
      );
      id.copy(data, 8);
      data[230] = bump;
      if (fields.finalizeSibling && i === 1) data[220] = 1;
      return { pubkey, account: { ...value.account, data } };
    });
    connection.getProgramAccounts = async (program, options) =>
      options.filters[0].memcmp.bytes ===
      discriminator("Dispute").toString("base64")
        ? disputes
        : original(program, options);
    const result = await scanDisputes(connection, { nowUnixTimestamp: 100n });
    assert.equal(typeof result.agentCount, "number");
    assert.equal(result.initiatorCounterDeficits.length, expected ? 1 : 0);
    const blockers = result.blockers.filter(
      (b) => b.kind === "tracked-initiator-counter-deficit",
    );
    assert.equal(blockers.length, expected ? 1 : 0);
    if (expected) {
      const deficit = result.initiatorCounterDeficits[0];
      assert.equal(deficit.unfinalizedTrackedDisputes, expected);
      assert.ok(deficit.initiator.equals(value.agentPubkey));
      assert.ok(blockers[0].dispute.equals(value.agentPubkey));
      assert.deepEqual(
        deficit.disputes.map(String),
        disputes
          .filter((d) => d.account.data[220] === 0)
          .map((d) => String(d.pubkey))
          .sort(),
      );
      assert.equal(
        blockers[0].detail,
        `pending_initiator_outcomes=${fields.pendingInitiatorOutcomes ?? 0} unfinalized_tracked_disputes=${expected} disputes=${deficit.disputes.join(",")}`,
      );
    }
  });
}

test("missing or undecodable enumerated agents do not create a speculative deficit", async () => {
  for (const invalid of [false, true]) {
    const value = scenario({
      status: 2,
      totalVoters: 255,
      initiatorSlashApplied: false,
    });
    const connection = connectionFor(value);
    const original = connection.getProgramAccounts;
    connection.getProgramAccounts = async (program, options) => {
      if (
        options.filters[0].memcmp.bytes ===
        discriminator("AgentRegistration").toString("base64")
      ) {
        return invalid
          ? [
              {
                pubkey: value.agentPubkey,
                account: { ...value.agentAccount, data: Buffer.alloc(1) },
              },
            ]
          : [];
      }
      return original(program, options);
    };
    connection.getAccountInfo = async () =>
      invalid
        ? { ...value.agentAccount, lamports: 1, data: Buffer.alloc(1) }
        : null;
    const result = await scanDisputes(connection, { nowUnixTimestamp: 100n });
    assert.deepEqual(result.initiatorCounterDeficits, []);
    assert.ok(
      result.blockers.some(
        (b) =>
          b.kind ===
          (invalid ? "invalid-agent-layout" : "missing-dispute-initiator"),
      ),
    );
  }
});
