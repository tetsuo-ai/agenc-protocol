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
  calculateFreshProposalQuorum,
  calculateGovernanceVoteWeight,
  decodeGovernanceConfig,
  decodeGovernanceVote,
  decodeProposal,
  decodeProtocolGovernanceInputs,
  inspectGovernanceConfigReachability,
  inspectProposalPayload,
  scanGovernanceProposals,
} from "./preflight-governance-scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "tests-integration", "package.json"));
const { PublicKey } = require("@solana/web3.js");

function disc(name) {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

const authority = new PublicKey(Buffer.alloc(32, 42));
const treasury = new PublicKey(Buffer.alloc(32, 43));

function protocolFixture({
  size = 351,
  minArbiterStake = 10_000_000n,
  minAgentStake = 10_000_000n,
  totalAgents = 44n,
} = {}) {
  const data = Buffer.alloc(size);
  disc("ProtocolConfig").copy(data);
  authority.toBuffer().copy(data, 8);
  treasury.toBuffer().copy(data, 40);
  data.writeBigUInt64LE(minArbiterStake, 75);
  data.writeBigUInt64LE(minAgentStake, 83);
  data.writeBigUInt64LE(totalAgents, 107);
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    PROGRAM_ID,
  );
  data[139] = bump;
  return { address, data };
}

function governanceFixture({
  minProposalStake = 10_000_000n,
  votingPeriod = 100n,
  executionDelay = 50n,
  quorumBps = 300,
  approvalThresholdBps = 5_000,
  totalProposals = 1n,
} = {}) {
  const data = Buffer.alloc(141);
  disc("GovernanceConfig").copy(data);
  authority.toBuffer().copy(data, 8);
  data.writeBigUInt64LE(minProposalStake, 40);
  data.writeBigInt64LE(votingPeriod, 48);
  data.writeBigInt64LE(executionDelay, 56);
  data.writeUInt16LE(quorumBps, 64);
  data.writeUInt16LE(approvalThresholdBps, 66);
  data.writeBigUInt64LE(totalProposals, 68);
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("governance")],
    PROGRAM_ID,
  );
  data[76] = bump;
  return { address, data };
}

function agentFixture({
  marker,
  agentAuthority = new PublicKey(Buffer.alloc(32, marker + 1)),
  status = 1,
  reputation = 5_000,
  activeTasks = 0,
  stake = 10_000_000n,
} = {}) {
  const agentId = Buffer.alloc(32, marker);
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), agentId],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(566);
  disc("AgentRegistration").copy(data);
  agentId.copy(data, 8);
  agentAuthority.toBuffer().copy(data, 40);
  data[80] = status;
  data.writeUInt32LE(0, 81);
  data.writeUInt32LE(0, 85);
  data.writeBigInt64LE(50n, 89);
  data.writeUInt16LE(reputation, 121);
  data.writeUInt16LE(activeTasks, 123);
  data.writeBigUInt64LE(stake, 125);
  data[133] = bump;
  return { address, data, authority: agentAuthority };
}

function governanceRulesFixture({
  minVoterStake = 10_000_000n,
  minVoterReputation = 5_000,
  maxVoteWeight = 100_000_000n,
  minDistinctVoters = 3,
  approvalThresholdBps = 5_000,
} = {}) {
  return {
    minVoterStake,
    minVoterReputation,
    maxVoteWeight,
    minDistinctVoters,
    approvalThresholdBps,
  };
}

function proposalFixture({
  proposer,
  proposerAuthority,
  status = 1,
  proposalType = 1,
  payload = Buffer.alloc(64),
  createdAt = 100n,
  votingDeadline = 200n,
  executionAfter = 250n,
  executedAt = status === 0 ? 0n : 300n,
  votesFor = 0n,
  votesAgainst = 0n,
  totalVoters = 0,
  quorum = 100_000_000n,
  rules = status === 0 ? governanceRulesFixture() : null,
} = {}) {
  const data = Buffer.alloc(333);
  disc("Proposal").copy(data);
  proposer.toBuffer().copy(data, 8);
  proposerAuthority.toBuffer().copy(data, 40);
  data.writeBigUInt64LE(7n, 72);
  data[80] = proposalType;
  payload.copy(data, 145);
  data[209] = status;
  data.writeBigInt64LE(createdAt, 210);
  data.writeBigInt64LE(votingDeadline, 218);
  data.writeBigInt64LE(executionAfter, 226);
  data.writeBigInt64LE(executedAt, 234);
  data.writeBigUInt64LE(votesFor, 242);
  data.writeBigUInt64LE(votesAgainst, 250);
  data.writeUInt16LE(totalVoters, 258);
  data.writeBigUInt64LE(quorum, 260);
  if (rules) {
    const reserved = data.subarray(269, 333);
    reserved[0] = 1;
    reserved.writeBigUInt64LE(rules.minVoterStake, 1);
    reserved.writeUInt16LE(rules.minVoterReputation, 9);
    reserved.writeBigUInt64LE(rules.maxVoteWeight, 11);
    reserved.writeUInt16LE(rules.minDistinctVoters, 19);
    reserved.writeUInt16LE(rules.approvalThresholdBps, 21);
  }
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("proposal"), proposer.toBuffer(), data.subarray(72, 80)],
    PROGRAM_ID,
  );
  data[268] = bump;
  return { address, data };
}

function voteFixture({ proposal, voter, voterAuthority, approved, weight }) {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("governance_vote"),
      proposal.toBuffer(),
      voterAuthority.toBuffer(),
    ],
    PROGRAM_ID,
  );
  const data = Buffer.alloc(98);
  disc("GovernanceVote").copy(data);
  proposal.toBuffer().copy(data, 8);
  voter.toBuffer().copy(data, 40);
  data[72] = Number(approved);
  data.writeBigInt64LE(150n, 73);
  data.writeBigUInt64LE(weight, 81);
  data[89] = bump;
  return { address, data };
}

function owned(value, owner = PROGRAM_ID) {
  return {
    pubkey: value.address,
    account: {
      owner,
      executable: false,
      lamports: 2_000_000,
      data: value.data,
    },
  };
}

function connectionFor({
  protocol = protocolFixture(),
  governance = governanceFixture(),
  proposals = [],
  votes = [],
  agents = [],
} = {}) {
  const singletons = new Map([
    [protocol.address.toBase58(), owned(protocol).account],
    [governance.address.toBase58(), owned(governance).account],
  ]);
  return {
    getGenesisHash: async () => MAINNET_GENESIS,
    getAccountInfo: async (address) => singletons.get(address.toBase58()) ?? null,
    getProgramAccounts: async (_program, options) => {
      const wanted = Buffer.from(options.filters[0].memcmp.bytes, "base64");
      if (wanted.equals(disc("Proposal"))) return proposals.map((value) => owned(value));
      if (wanted.equals(disc("GovernanceVote"))) return votes.map((value) => owned(value));
      if (wanted.equals(disc("AgentRegistration"))) return agents.map((value) => owned(value));
      return [];
    },
  };
}

test("decodes exact governance, legacy protocol, Proposal, Vote, and vote-weight layouts", () => {
  const protocol = decodeProtocolGovernanceInputs(protocolFixture({ size: 349 }).data);
  const governance = decodeGovernanceConfig(governanceFixture().data);
  assert.equal(protocol.dataLen, 349);
  assert.equal(protocol.minArbiterStake, 10_000_000n);
  assert.equal(protocol.minAgentStake, 10_000_000n);
  assert.equal(governance.approvalThresholdBps, 5_000);
  assert.deepEqual(
    inspectGovernanceConfigReachability(governance, protocol).issues,
    [],
  );
  assert.deepEqual(calculateFreshProposalQuorum(governance, protocol), {
    maxVoteWeight: 100_000_000n,
    minVoterStake: 10_000_000n,
    minimumElectorateCapacity: 300_000_000n,
    minimumStakeQuorum: 30_000_000n,
    percentageQuorum: 9_000_000n,
    freshQuorum: 100_000_000n,
    rules: governanceRulesFixture(),
  });

  const voter = agentFixture({ marker: 31, reputation: 7_500, stake: 20_000_000n });
  assert.equal(
    calculateGovernanceVoteWeight(
      { stake: 20_000_000n, reputation: 7_500 },
      100_000_000n,
    ),
    15_000_000n,
  );
  const proposal = proposalFixture({
    proposer: voter.address,
    proposerAuthority: voter.authority,
  });
  const decodedProposal = decodeProposal(proposal.data);
  assert.equal(decodedProposal.votingDeadline, 200n);
  assert.equal(decodedProposal.rulesVersion, 0);
  assert.equal(decodedProposal.rules, null);
  const vote = voteFixture({
    proposal: proposal.address,
    voter: voter.address,
    voterAuthority: voter.authority,
    approved: true,
    weight: 15_000_000n,
  });
  assert.equal(decodeGovernanceVote(vote.data).voteWeight, 15_000_000n);

  const active = proposalFixture({
    proposer: voter.address,
    proposerAuthority: voter.authority,
    status: 0,
  });
  assert.deepEqual(decodeProposal(active.data).rules, governanceRulesFixture());
});

test("accepts schema-1 Active proposals and terminal legacy history but blocks legacy Active proposals", async () => {
  const agents = [51, 53, 55].map((marker) => agentFixture({
    marker,
    stake: 100_000_000n,
  }));
  for (const status of [1, 2, 3]) {
    const proposal = proposalFixture({
      proposer: agents[0].address,
      proposerAuthority: agents[0].authority,
      status,
    });
    const result = await scanGovernanceProposals(connectionFor({
      proposals: [proposal],
      agents,
    }));
    assert.equal(result.voterReachability.eligibleDistinctAuthorityCount, 3);
    assert.equal(result.voterReachability.attainableVoteWeight, 150_000_000n);
    assert.equal(result.voterReachability.freshQuorum, 100_000_000n);
    assert.equal(result.voterReachability.freshProposalReachable, true);
    assert.deepEqual(result.blockers, []);
  }

  const active = proposalFixture({
    proposer: agents[0].address,
    proposerAuthority: agents[0].authority,
    status: 0,
  });
  const result = await scanGovernanceProposals(connectionFor({
    proposals: [active],
    agents,
  }));
  assert.equal(result.activeReachability[0].quorumReachable, true);
  assert.equal(result.activeReachability[0].approvalReachable, true);
  assert.deepEqual(result.blockers, []);

  const legacyActive = proposalFixture({
    proposer: agents[0].address,
    proposerAuthority: agents[0].authority,
    status: 0,
    rules: null,
  });
  const legacyResult = await scanGovernanceProposals(connectionFor({
    proposals: [legacyActive],
    agents,
  }));
  assert.ok(legacyResult.blockers.some(
    (item) => item.kind === "active-legacy-governance-proposal-cutover",
  ));
});

test("fresh quorum is independent of duplicate or ineligible identity count", () => {
  const governance = decodeGovernanceConfig(governanceFixture({
    minProposalStake: 10_000_000n,
    quorumBps: 300,
  }).data);
  const fewIdentities = decodeProtocolGovernanceInputs(protocolFixture({
    minArbiterStake: 10_000_000n,
    totalAgents: 2n,
  }).data);
  const inflatedIdentities = decodeProtocolGovernanceInputs(protocolFixture({
    minArbiterStake: 10_000_000n,
    totalAgents: 1_000_000n,
  }).data);

  const few = calculateFreshProposalQuorum(governance, fewIdentities);
  const inflated = calculateFreshProposalQuorum(governance, inflatedIdentities);
  assert.equal(few.freshQuorum, 100_000_000n);
  assert.equal(inflated.freshQuorum, few.freshQuorum);
  assert.equal(few.minimumElectorateCapacity, 300_000_000n);

  const halfCapacity = calculateFreshProposalQuorum(
    decodeGovernanceConfig(governanceFixture({
      quorumBps: 5_000,
    }).data),
    decodeProtocolGovernanceInputs(protocolFixture({
      minArbiterStake: 10_000_000n,
    }).data),
  );
  assert.equal(halfCapacity.percentageQuorum, 150_000_000n);
  assert.equal(halfCapacity.freshQuorum, 150_000_000n);

  assert.throws(
    () => calculateFreshProposalQuorum(
      decodeGovernanceConfig(governanceFixture().data),
      decodeProtocolGovernanceInputs(protocolFixture({ minArbiterStake: 2_000_000n }).data),
    ),
    /cannot attain hard quorum/,
  );

  assert.throws(
    () => calculateFreshProposalQuorum(
      decodeGovernanceConfig(governanceFixture({
        minProposalStake: 100_000_001n,
      }).data),
      fewIdentities,
    ),
    /per_voter_stake_cap/,
  );
});

test("schema-1 snapshots are canonical and two fresh rep-3000 wallets are ineligible", async () => {
  const mature = agentFixture({ marker: 71, stake: 100_000_000n });
  const active = proposalFixture({
    proposer: mature.address,
    proposerAuthority: mature.authority,
    status: 0,
  });
  const trailingGarbage = Buffer.from(active.data);
  trailingGarbage[332] = 1;
  assert.throws(() => decodeProposal(trailingGarbage), /trailing bytes/);

  const unknownSchema = Buffer.from(active.data);
  unknownSchema[269] = 2;
  assert.throws(() => decodeProposal(unknownSchema), /unknown governance rules schema/);

  const freshAgents = [73, 75].map((marker) => agentFixture({
    marker,
    reputation: 3_000,
    stake: 33_333_334n,
  }));
  const result = await scanGovernanceProposals(connectionFor({ agents: freshAgents }));
  assert.equal(result.voterReachability.eligibleDistinctAuthorityCount, 0);
  assert.equal(result.voterReachability.attainableVoteWeight, 0n);
  assert.equal(result.voterReachability.freshProposalReachable, false);
  assert.ok(result.blockers.some(
    (item) => item.kind === "unreachable-fresh-governance-proposer",
  ));
  assert.ok(result.blockers.some(
    (item) => item.kind === "unreachable-fresh-governance-distinct-voters",
  ));
});

test("blocks an Active registration below the configured assignment stake floor", async () => {
  const agents = [81, 83, 85].map((marker) => agentFixture({
    marker,
    stake: 100_000_000n,
  }));
  agents.push(agentFixture({
    marker: 87,
    activeTasks: 2,
    stake: 9_999_999n,
  }));

  const result = await scanGovernanceProposals(connectionFor({ agents }));
  const assignmentBlocker = result.blockers.find(
    (item) => item.kind === "active-agent-below-assignment-stake-floor",
  );
  assert.ok(assignmentBlocker);
  assert.equal(assignmentBlocker.address.toBase58(), agents[3].address.toBase58());
  assert.match(
    assignmentBlocker.detail,
    /stake=9999999 min_agent_stake=10000000 active_tasks=2/,
  );
});

test("fails closed on unreachable config, malformed state, and Active payload/timing/quorum", async () => {
  const agents = [61, 63, 65].map((marker) => agentFixture({
    marker,
    stake: 100_000_000n,
  }));
  let result = await scanGovernanceProposals(connectionFor({
    governance: governanceFixture({ approvalThresholdBps: 10_000 }),
    agents,
  }));
  assert.ok(result.blockers.some(
    (item) => item.kind === "unreachable-governance-approval-threshold",
  ));

  result = await scanGovernanceProposals(connectionFor({
    governance: governanceFixture({ minProposalStake: 100_000_001n }),
    agents,
  }));
  assert.ok(result.blockers.some(
    (item) => item.kind === "unreachable-governance-hard-quorum",
  ));

  const badPayload = Buffer.alloc(64);
  badPayload.writeUInt16LE(2_001, 0);
  const active = proposalFixture({
    proposer: agents[0].address,
    proposerAuthority: agents[0].authority,
    status: 0,
    payload: badPayload,
    votingDeadline: 100n,
    executionAfter: 99n,
    quorum: 900_000_000n,
  });
  result = await scanGovernanceProposals(connectionFor({
    proposals: [active],
    agents,
  }));
  for (const kind of [
    "active-proposal-invalid-payload",
    "active-proposal-invalid-timing",
    "active-proposal-quorum-unreachable",
  ]) {
    assert.ok(result.blockers.some((item) => item.kind === kind), kind);
  }
  assert.equal(inspectProposalPayload(decodeProposal(active.data)).valid, false);

  const freezingRatePayload = Buffer.alloc(64);
  freezingRatePayload.writeBigInt64LE(1n, 0);
  freezingRatePayload[8] = 1;
  freezingRatePayload.writeBigInt64LE(1n, 9);
  freezingRatePayload[17] = 1;
  freezingRatePayload.writeBigUInt64LE((1n << 64n) - 1n, 18);
  const freezingRateProposal = decodeProposal(proposalFixture({
    proposer: agents[0].address,
    proposerAuthority: agents[0].authority,
    status: 0,
    proposalType: 3,
    payload: freezingRatePayload,
  }).data);
  assert.equal(
    inspectProposalPayload(
      freezingRateProposal,
      decodeProtocolGovernanceInputs(protocolFixture().data),
    ).valid,
    false,
  );

  const terminal = proposalFixture({
    proposer: agents[0].address,
    proposerAuthority: agents[0].authority,
  });
  result = await scanGovernanceProposals({
    ...connectionFor({ proposals: [terminal], agents }),
    getProgramAccounts: async (_program, options) => {
      const wanted = Buffer.from(options.filters[0].memcmp.bytes, "base64");
      if (wanted.equals(disc("Proposal"))) {
        return [owned(terminal, new PublicKey(Buffer.alloc(32, 99)))];
      }
      if (wanted.equals(disc("AgentRegistration"))) {
        return agents.map((value) => owned(value));
      }
      return [];
    },
  });
  assert.ok(result.blockers.some((item) => item.kind === "invalid-proposal-owner"));

  const short = { ...terminal, data: terminal.data.subarray(0, 332) };
  result = await scanGovernanceProposals(connectionFor({ proposals: [short], agents }));
  assert.ok(result.blockers.some((item) => item.kind === "invalid-proposal-layout"));

  result = await scanGovernanceProposals(connectionFor({
    proposals: [{ ...terminal, address: new PublicKey(Buffer.alloc(32, 98)) }],
    agents,
  }));
  assert.ok(result.blockers.some((item) => item.kind === "invalid-proposal-layout"));
});

test("refuses non-mainnet before reading governance state", async () => {
  let read = false;
  await assert.rejects(
    scanGovernanceProposals({
      getGenesisHash: async () => "devnet",
      getAccountInfo: async () => {
        read = true;
        return null;
      },
      getProgramAccounts: async () => {
        read = true;
        return [];
      },
    }),
    /wrong cluster genesis/,
  );
  assert.equal(read, false);
});
