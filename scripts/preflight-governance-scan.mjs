#!/usr/bin/env node
// Revision-5 governance cutover scanner.
//
// Legacy vote_agent.last_vote_timestamp recorded vote time, while revision 5
// records the proposal deadline. Deploying with an Active legacy Proposal would
// leave a stake-recycling window for votes already cast under the old rule. The
// cutover therefore requires zero schema-0 Active Proposal accounts and fails
// closed on every owner/layout/PDA/bump ambiguity. Schema-1 Active proposals are
// assessed against their immutable election-rule snapshots. The same account
// inventory also guards the assignment-stake cutover: an Active registration
// must already satisfy the configured floor before the upgraded claim and bid
// entry points start enforcing it.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MAINNET_GENESIS,
  PROGRAM_ID,
  decodeAgentBinding,
  redactRpcText,
} from "./preflight-dispute-scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "tests-integration", "package.json"));
const { Connection, PublicKey } = require("@solana/web3.js");

const PROPOSAL_DISCRIMINATOR = createHash("sha256")
  .update("account:Proposal")
  .digest()
  .subarray(0, 8);
const PROPOSAL_SIZE = 333;
const GOVERNANCE_CONFIG_SIZE = 141;
const GOVERNANCE_VOTE_SIZE = 98;
const PROTOCOL_CONFIG_SIZES = new Set([349, 351]);
const MAX_VOTING_PERIOD = 604_800n;
const MAX_EXECUTION_DELAY = 604_800n;
const MAX_PROTOCOL_FEE_BPS = 2_000;
const MAX_COOLDOWN = 604_800n;
const MIN_DISPUTE_STAKE = 1_000n;
const MAX_DISPUTE_STAKE = 1_000_000_000n;
const MAX_REPUTATION = 10_000n;
const MIN_GOVERNANCE_VOTER_STAKE = 10_000_000n;
const MIN_GOVERNANCE_VOTER_REPUTATION = 5_000;
const MIN_GOVERNANCE_DISTINCT_VOTERS = 3;
const MIN_GOVERNANCE_QUORUM_WEIGHT = 100_000_000n;
const GOVERNANCE_VOTE_WEIGHT_CAP_MULTIPLIER = 10n;
const GOVERNANCE_RULES_SCHEMA_V1 = 1;
const U64_MAX = (1n << 64n) - 1n;
const ACTIVE_AGENT_STATUS = 1;
const STATUS_NAMES = ["Active", "Executed", "Defeated", "Cancelled"];
const GOVERNANCE_CONFIG_DISCRIMINATOR = createHash("sha256")
  .update("account:GovernanceConfig")
  .digest()
  .subarray(0, 8);
const GOVERNANCE_VOTE_DISCRIMINATOR = createHash("sha256")
  .update("account:GovernanceVote")
  .digest()
  .subarray(0, 8);
const AGENT_DISCRIMINATOR = createHash("sha256")
  .update("account:AgentRegistration")
  .digest()
  .subarray(0, 8);
const PROTOCOL_CONFIG_DISCRIMINATOR = createHash("sha256")
  .update("account:ProtocolConfig")
  .digest()
  .subarray(0, 8);

export function decodeProposal(dataLike) {
  const data = Buffer.from(dataLike);
  if (data.length !== PROPOSAL_SIZE) {
    throw new Error(
      `Proposal: unexpected account size ${data.length}; expected ${PROPOSAL_SIZE}`,
    );
  }
  if (!data.subarray(0, 8).equals(PROPOSAL_DISCRIMINATOR)) {
    throw new Error("Proposal: discriminator mismatch");
  }
  const proposalType = data[80];
  const status = data[209];
  if (proposalType > 3) {
    throw new Error(`Proposal.proposal_type: invalid enum variant ${proposalType}`);
  }
  if (status > 3) {
    throw new Error(`Proposal.status: invalid enum variant ${status}`);
  }
  const reserved = data.subarray(269, 333);
  let rulesVersion = 0;
  let rules = null;
  if (!reserved.equals(Buffer.alloc(64))) {
    rulesVersion = reserved[0];
    if (rulesVersion !== GOVERNANCE_RULES_SCHEMA_V1) {
      throw new Error(`Proposal: unknown governance rules schema ${rulesVersion}`);
    }
    if (!reserved.subarray(23).equals(Buffer.alloc(41))) {
      throw new Error("Proposal: governance rules trailing bytes are nonzero");
    }
    rules = {
      minVoterStake: reserved.readBigUInt64LE(1),
      minVoterReputation: reserved.readUInt16LE(9),
      maxVoteWeight: reserved.readBigUInt64LE(11),
      minDistinctVoters: reserved.readUInt16LE(19),
      approvalThresholdBps: reserved.readUInt16LE(21),
    };
    if (
      rules.minVoterStake < MIN_GOVERNANCE_VOTER_STAKE ||
      rules.minVoterReputation < MIN_GOVERNANCE_VOTER_REPUTATION ||
      rules.minVoterReputation > Number(MAX_REPUTATION) ||
      rules.maxVoteWeight < rules.minVoterStake ||
      rules.minDistinctVoters < MIN_GOVERNANCE_DISTINCT_VOTERS ||
      rules.approvalThresholdBps < 1 ||
      rules.approvalThresholdBps >= 10_000
    ) {
      throw new Error("Proposal: invalid governance rules snapshot");
    }
  }
  return {
    proposer: new PublicKey(data.subarray(8, 40)),
    proposerAuthority: new PublicKey(data.subarray(40, 72)),
    nonce: data.readBigUInt64LE(72),
    proposalType,
    payload: Buffer.from(data.subarray(145, 209)),
    status,
    createdAt: data.readBigInt64LE(210),
    votingDeadline: data.readBigInt64LE(218),
    executionAfter: data.readBigInt64LE(226),
    executedAt: data.readBigInt64LE(234),
    votesFor: data.readBigUInt64LE(242),
    votesAgainst: data.readBigUInt64LE(250),
    totalVoters: data.readUInt16LE(258),
    quorum: data.readBigUInt64LE(260),
    bump: data[268],
    rulesVersion,
    rules,
  };
}

export function decodeGovernanceConfig(dataLike) {
  const data = Buffer.from(dataLike);
  if (data.length !== GOVERNANCE_CONFIG_SIZE) {
    throw new Error(
      `GovernanceConfig: unexpected account size ${data.length}; expected ${GOVERNANCE_CONFIG_SIZE}`,
    );
  }
  if (!data.subarray(0, 8).equals(GOVERNANCE_CONFIG_DISCRIMINATOR)) {
    throw new Error("GovernanceConfig: discriminator mismatch");
  }
  if (!data.subarray(77, 141).equals(Buffer.alloc(64))) {
    throw new Error("GovernanceConfig: reserved bytes are nonzero");
  }
  return {
    authority: new PublicKey(data.subarray(8, 40)),
    minProposalStake: data.readBigUInt64LE(40),
    votingPeriod: data.readBigInt64LE(48),
    executionDelay: data.readBigInt64LE(56),
    quorumBps: data.readUInt16LE(64),
    approvalThresholdBps: data.readUInt16LE(66),
    totalProposals: data.readBigUInt64LE(68),
    bump: data[76],
  };
}

export function decodeProtocolGovernanceInputs(dataLike) {
  const data = Buffer.from(dataLike);
  if (!PROTOCOL_CONFIG_SIZES.has(data.length)) {
    throw new Error(
      `ProtocolConfig: unexpected account size ${data.length}; expected 349 or 351`,
    );
  }
  if (!data.subarray(0, 8).equals(PROTOCOL_CONFIG_DISCRIMINATOR)) {
    throw new Error("ProtocolConfig: discriminator mismatch");
  }
  return {
    authority: new PublicKey(data.subarray(8, 40)),
    treasury: new PublicKey(data.subarray(40, 72)),
    minArbiterStake: data.readBigUInt64LE(75),
    minAgentStake: data.readBigUInt64LE(83),
    totalAgents: data.readBigUInt64LE(107),
    bump: data[139],
    dataLen: data.length,
  };
}

export function decodeGovernanceVote(dataLike) {
  const data = Buffer.from(dataLike);
  if (data.length !== GOVERNANCE_VOTE_SIZE) {
    throw new Error(
      `GovernanceVote: unexpected account size ${data.length}; expected ${GOVERNANCE_VOTE_SIZE}`,
    );
  }
  if (!data.subarray(0, 8).equals(GOVERNANCE_VOTE_DISCRIMINATOR)) {
    throw new Error("GovernanceVote: discriminator mismatch");
  }
  const approved = data[72];
  if (approved > 1) {
    throw new Error(`GovernanceVote.approved: invalid bool ${approved}`);
  }
  if (!data.subarray(90, 98).equals(Buffer.alloc(8))) {
    throw new Error("GovernanceVote: reserved bytes are nonzero");
  }
  const votedAt = data.readBigInt64LE(73);
  if (votedAt <= 0n) {
    throw new Error(`GovernanceVote.voted_at: invalid ${votedAt}`);
  }
  return {
    proposal: new PublicKey(data.subarray(8, 40)),
    voter: new PublicKey(data.subarray(40, 72)),
    approved: approved === 1,
    votedAt,
    voteWeight: data.readBigUInt64LE(81),
    bump: data[89],
  };
}

function checkedU64Product(left, right, field) {
  const value = left * right;
  if (value > U64_MAX) throw new Error(`${field}: u64 multiplication overflow`);
  return value;
}

export function calculateFreshProposalQuorum(governance, protocol) {
  if (governance.quorumBps < 1 || governance.quorumBps > 10_000) {
    throw new Error(`quorum_bps=${governance.quorumBps} valid=1..10000`);
  }
  const maxVoteWeight = checkedU64Product(
    protocol.minArbiterStake,
    GOVERNANCE_VOTE_WEIGHT_CAP_MULTIPLIER,
    "ProtocolConfig.min_arbiter_stake vote cap",
  );
  const minVoterStake = governance.minProposalStake > MIN_GOVERNANCE_VOTER_STAKE
    ? governance.minProposalStake
    : MIN_GOVERNANCE_VOTER_STAKE;
  if (
    governance.minProposalStake === 0n ||
    minVoterStake > maxVoteWeight
  ) {
    throw new Error(
      `min_proposal_stake=${governance.minProposalStake} ` +
        `min_voter_stake=${minVoterStake} per_voter_stake_cap=${maxVoteWeight}`,
    );
  }
  if (
    governance.approvalThresholdBps < 1 ||
    governance.approvalThresholdBps >= 10_000
  ) {
    throw new Error(
      `approval_threshold_bps=${governance.approvalThresholdBps} valid=1..9999`,
    );
  }
  const minimumElectorateCapacity = checkedU64Product(
    maxVoteWeight,
    BigInt(MIN_GOVERNANCE_DISTINCT_VOTERS),
    "minimum governance electorate capacity",
  );
  if (minimumElectorateCapacity < MIN_GOVERNANCE_QUORUM_WEIGHT) {
    throw new Error(
      `minimum electorate capacity ${minimumElectorateCapacity} cannot attain ` +
        `hard quorum ${MIN_GOVERNANCE_QUORUM_WEIGHT}`,
    );
  }
  const minimumStakeQuorum = checkedU64Product(
    minVoterStake,
    BigInt(MIN_GOVERNANCE_DISTINCT_VOTERS),
    "minimum voter stake quorum",
  );
  const percentageQuorum =
    (minimumElectorateCapacity * BigInt(governance.quorumBps) + 9_999n) / 10_000n;
  const freshQuorum = [
    MIN_GOVERNANCE_QUORUM_WEIGHT,
    minimumStakeQuorum,
    percentageQuorum,
  ].reduce((maximum, value) => value > maximum ? value : maximum, 0n);
  if (freshQuorum > minimumElectorateCapacity || freshQuorum > U64_MAX) {
    throw new Error(
      `fresh quorum ${freshQuorum} exceeds minimum electorate capacity ` +
        `${minimumElectorateCapacity}`,
    );
  }
  return {
    maxVoteWeight,
    minVoterStake,
    minimumElectorateCapacity,
    minimumStakeQuorum,
    percentageQuorum,
    freshQuorum,
    rules: {
      minVoterStake,
      minVoterReputation: MIN_GOVERNANCE_VOTER_REPUTATION,
      maxVoteWeight,
      minDistinctVoters: MIN_GOVERNANCE_DISTINCT_VOTERS,
      approvalThresholdBps: governance.approvalThresholdBps,
    },
  };
}

export function calculateGovernanceVoteWeight(agent, maxVoteWeight) {
  const stakeWeight = agent.stake < maxVoteWeight ? agent.stake : maxVoteWeight;
  if (stakeWeight === 0n) return 0n;
  const weighted = (stakeWeight * BigInt(agent.reputation)) / MAX_REPUTATION;
  return weighted > 0n ? weighted : 1n;
}

export function inspectProposalPayload(proposal, protocol = null) {
  const payload = proposal.payload;
  if (!Buffer.isBuffer(payload) || payload.length !== 64) {
    return { valid: false, detail: "payload is not exactly 64 bytes" };
  }
  if (proposal.proposalType === 0) {
    return { valid: true, kind: "protocol-upgrade-signal" };
  }
  if (proposal.proposalType === 1) {
    const feeBps = payload.readUInt16LE(0);
    return feeBps <= MAX_PROTOCOL_FEE_BPS
      ? { valid: true, kind: "fee-change", feeBps }
      : { valid: false, detail: `fee_bps=${feeBps} exceeds ${MAX_PROTOCOL_FEE_BPS}` };
  }
  if (proposal.proposalType === 2) {
    const recipient = new PublicKey(payload.subarray(0, 32));
    const amount = payload.readBigUInt64LE(32);
    if (recipient.equals(PublicKey.default) || amount === 0n) {
      return {
        valid: false,
        detail: `treasury recipient_default=${recipient.equals(PublicKey.default)} amount=${amount}`,
      };
    }
    return { valid: true, kind: "treasury-spend", recipient, amount };
  }
  const taskCreationCooldown = payload.readBigInt64LE(0);
  const maxTasksPer24h = payload[8];
  const disputeInitiationCooldown = payload.readBigInt64LE(9);
  const maxDisputesPer24h = payload[17];
  const minStakeForDispute = payload.readBigUInt64LE(18);
  if (
    taskCreationCooldown < 1n ||
    taskCreationCooldown > MAX_COOLDOWN ||
    disputeInitiationCooldown < 1n ||
    disputeInitiationCooldown > MAX_COOLDOWN ||
    maxTasksPer24h < 1 ||
    maxDisputesPer24h < 1 ||
    minStakeForDispute < MIN_DISPUTE_STAKE ||
    minStakeForDispute > MAX_DISPUTE_STAKE ||
    protocol === null ||
    minStakeForDispute > protocol.minAgentStake
  ) {
    return {
      valid: false,
      detail:
        `rate-limit payload cooldowns=${taskCreationCooldown}/${disputeInitiationCooldown} ` +
        `max24h=${maxTasksPer24h}/${maxDisputesPer24h} ` +
        `min_dispute_stake=${minStakeForDispute} ` +
        `absolute_max=${MAX_DISPUTE_STAKE} ` +
        `min_agent_stake=${protocol?.minAgentStake ?? "unavailable"}`,
    };
  }
  return {
    valid: true,
    kind: "rate-limit-change",
    taskCreationCooldown,
    maxTasksPer24h,
    disputeInitiationCooldown,
    maxDisputesPer24h,
    minStakeForDispute,
  };
}

export function inspectActiveProposalTiming(proposal, governance) {
  const issues = [];
  if (proposal.createdAt <= 0n) issues.push("created_at must be positive");
  if (proposal.votingDeadline <= proposal.createdAt) {
    issues.push("voting_deadline must be after created_at");
  }
  const votingPeriod = proposal.votingDeadline - proposal.createdAt;
  if (votingPeriod > MAX_VOTING_PERIOD) {
    issues.push(`voting period ${votingPeriod} exceeds ${MAX_VOTING_PERIOD}`);
  }
  if (governance && votingPeriod < governance.votingPeriod) {
    issues.push(
      `voting period ${votingPeriod} is below governance floor ${governance.votingPeriod}`,
    );
  }
  if (proposal.executionAfter < proposal.votingDeadline) {
    issues.push("execution_after precedes voting_deadline");
  }
  if (governance) {
    const expectedExecutionAfter = proposal.votingDeadline + governance.executionDelay;
    if (expectedExecutionAfter > ((1n << 63n) - 1n)) {
      issues.push("execution_after calculation overflows i64");
    } else if (proposal.executionAfter !== expectedExecutionAfter) {
      issues.push(
        `execution_after=${proposal.executionAfter} expected=${expectedExecutionAfter}`,
      );
    }
  }
  if (proposal.executedAt !== 0n) issues.push("Active proposal has nonzero executed_at");
  if (proposal.quorum === 0n) issues.push("stored quorum is zero");
  return { valid: issues.length === 0, issues, votingPeriod };
}

function blocker(kind, address, detail, extra = {}) {
  return { kind, address, detail, ...extra };
}

function discriminatorFilter(discriminator) {
  return [{
    memcmp: {
      offset: 0,
      bytes: discriminator.toString("base64"),
      encoding: "base64",
    },
  }];
}

export function inspectGovernanceConfigReachability(governance, protocol) {
  const issues = [];
  if (governance.authority.equals(PublicKey.default)) {
    issues.push({ kind: "invalid-governance-authority", detail: "authority is default" });
  }
  if (!governance.authority.equals(protocol.authority)) {
    issues.push({
      kind: "governance-authority-mismatch",
      detail:
        `governance=${governance.authority.toBase58()} ` +
        `protocol=${protocol.authority.toBase58()}`,
    });
  }
  if (governance.votingPeriod < 1n || governance.votingPeriod > MAX_VOTING_PERIOD) {
    issues.push({
      kind: "invalid-governance-voting-period",
      detail: `voting_period=${governance.votingPeriod} valid=1..${MAX_VOTING_PERIOD}`,
    });
  }
  if (
    governance.executionDelay < 0n ||
    governance.executionDelay > MAX_EXECUTION_DELAY
  ) {
    issues.push({
      kind: "invalid-governance-execution-delay",
      detail: `execution_delay=${governance.executionDelay} valid=0..${MAX_EXECUTION_DELAY}`,
    });
  }
  if (governance.quorumBps < 1 || governance.quorumBps > 10_000) {
    issues.push({
      kind: "invalid-governance-quorum-bps",
      detail: `quorum_bps=${governance.quorumBps} valid=1..10000`,
    });
  }
  if (
    governance.approvalThresholdBps < 1 ||
    governance.approvalThresholdBps >= 10_000
  ) {
    issues.push({
      kind: "unreachable-governance-approval-threshold",
      detail:
        `approval_threshold_bps=${governance.approvalThresholdBps}; ` +
        "strict approval requires 1..9999",
    });
  }

  let maxVoteWeight = null;
  let minVoterStake = null;
  let minimumElectorateCapacity = null;
  let minimumStakeQuorum = null;
  let percentageQuorum = null;
  let freshQuorum = null;
  let rules = null;
  const parameterShapeIsValid =
    governance.quorumBps >= 1 &&
    governance.quorumBps <= 10_000 &&
    governance.approvalThresholdBps >= 1 &&
    governance.approvalThresholdBps < 10_000;
  if (parameterShapeIsValid) {
    try {
      const calculated = calculateFreshProposalQuorum(governance, protocol);
      maxVoteWeight = calculated.maxVoteWeight;
      minVoterStake = calculated.minVoterStake;
      minimumElectorateCapacity = calculated.minimumElectorateCapacity;
      minimumStakeQuorum = calculated.minimumStakeQuorum;
      percentageQuorum = calculated.percentageQuorum;
      freshQuorum = calculated.freshQuorum;
      rules = calculated.rules;
    } catch (error) {
      issues.push({
        kind: "unreachable-governance-hard-quorum",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    issues,
    maxVoteWeight,
    minVoterStake,
    minimumElectorateCapacity,
    minimumStakeQuorum,
    percentageQuorum,
    freshQuorum,
    rules,
  };
}

function buildEligibleAuthorityInventory(agents, rules) {
  const byAuthority = new Map();
  if (!rules) return [];
  for (const agent of agents) {
    if (agent.status !== ACTIVE_AGENT_STATUS || agent.retired) continue;
    if (
      agent.stake < rules.minVoterStake ||
      agent.reputation < rules.minVoterReputation ||
      BigInt(agent.reputation) > MAX_REPUTATION
    ) {
      continue;
    }
    const voteWeight = calculateGovernanceVoteWeight(agent, rules.maxVoteWeight);
    if (voteWeight === 0n) continue;
    const authority = agent.authority.toBase58();
    const prior = byAuthority.get(authority);
    if (!prior || voteWeight > prior.voteWeight) {
      byAuthority.set(authority, {
        authority: agent.authority,
        agent: agent.address,
        stake: agent.stake,
        reputation: agent.reputation,
        voteWeight,
        canPropose: true,
      });
    }
  }
  return [...byAuthority.values()];
}

export async function scanGovernanceProposals(connection) {
  const genesis = await connection.getGenesisHash();
  if (genesis !== MAINNET_GENESIS) {
    throw new Error(
      `wrong cluster genesis ${genesis}; expected mainnet-beta ${MAINNET_GENESIS}`,
    );
  }

  const [governanceAddress, governanceBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("governance")],
    PROGRAM_ID,
  );
  const [protocolAddress, protocolBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    PROGRAM_ID,
  );
  const [
    governanceAccount,
    protocolAccount,
    proposalAccounts,
    voteAccounts,
    agentAccounts,
  ] = await Promise.all([
    connection.getAccountInfo(governanceAddress, "confirmed"),
    connection.getAccountInfo(protocolAddress, "confirmed"),
    connection.getProgramAccounts(PROGRAM_ID, {
      filters: discriminatorFilter(PROPOSAL_DISCRIMINATOR),
    }),
    connection.getProgramAccounts(PROGRAM_ID, {
      filters: discriminatorFilter(GOVERNANCE_VOTE_DISCRIMINATOR),
    }),
    connection.getProgramAccounts(PROGRAM_ID, {
      filters: discriminatorFilter(AGENT_DISCRIMINATOR),
    }),
  ]);

  const blockers = [];
  let governance = null;
  if (!governanceAccount || governanceAccount.lamports === 0) {
    blockers.push(blocker(
      "missing-governance-config",
      governanceAddress,
      "canonical GovernanceConfig account is absent",
    ));
  } else if (
    !governanceAccount.owner.equals(PROGRAM_ID) ||
    governanceAccount.executable === true
  ) {
    blockers.push(blocker(
      "invalid-governance-config-owner",
      governanceAddress,
      `owner=${governanceAccount.owner.toBase58()} executable=${governanceAccount.executable === true}`,
    ));
  } else {
    try {
      governance = decodeGovernanceConfig(governanceAccount.data);
      if (governance.bump !== governanceBump) {
        throw new Error(
          `GovernanceConfig.bump=${governance.bump} canonical=${governanceBump}`,
        );
      }
    } catch (error) {
      blockers.push(blocker(
        "invalid-governance-config-layout",
        governanceAddress,
        error instanceof Error ? error.message : String(error),
      ));
      governance = null;
    }
  }

  let protocol = null;
  if (!protocolAccount || protocolAccount.lamports === 0) {
    blockers.push(blocker(
      "missing-governance-protocol-config",
      protocolAddress,
      "canonical ProtocolConfig account is absent",
    ));
  } else if (
    !protocolAccount.owner.equals(PROGRAM_ID) ||
    protocolAccount.executable === true
  ) {
    blockers.push(blocker(
      "invalid-governance-protocol-owner",
      protocolAddress,
      `owner=${protocolAccount.owner.toBase58()} executable=${protocolAccount.executable === true}`,
    ));
  } else {
    try {
      protocol = decodeProtocolGovernanceInputs(protocolAccount.data);
      if (protocol.bump !== protocolBump) {
        throw new Error(`ProtocolConfig.bump=${protocol.bump} canonical=${protocolBump}`);
      }
    } catch (error) {
      blockers.push(blocker(
        "invalid-governance-protocol-layout",
        protocolAddress,
        error instanceof Error ? error.message : String(error),
      ));
      protocol = null;
    }
  }

  let configReachability = {
    issues: [],
    maxVoteWeight: null,
    minVoterStake: null,
    minimumElectorateCapacity: null,
    minimumStakeQuorum: null,
    percentageQuorum: null,
    freshQuorum: null,
    rules: null,
  };
  if (governance && protocol) {
    configReachability = inspectGovernanceConfigReachability(governance, protocol);
    for (const issue of configReachability.issues) {
      blockers.push(blocker(issue.kind, governanceAddress, issue.detail));
    }
  }

  const agents = [];
  for (const { pubkey: address, account } of agentAccounts) {
    if (!account.owner.equals(PROGRAM_ID) || account.executable === true) {
      blockers.push(blocker(
        "invalid-governance-voter-owner",
        address,
        `owner=${account.owner.toBase58()} executable=${account.executable === true}`,
      ));
      continue;
    }
    try {
      const agent = decodeAgentBinding(account.data);
      const [expected, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent"), agent.agentId],
        PROGRAM_ID,
      );
      if (!expected.equals(address) || agent.bump !== bump) {
        throw new Error("canonical AgentRegistration PDA/bump mismatch");
      }
      if (agent.authority.equals(PublicKey.default)) {
        throw new Error("AgentRegistration.authority is default");
      }
      if (
        protocol &&
        agent.status === ACTIVE_AGENT_STATUS &&
        !agent.retired &&
        agent.stake < protocol.minAgentStake
      ) {
        blockers.push(blocker(
          "active-agent-below-assignment-stake-floor",
          address,
          `stake=${agent.stake} min_agent_stake=${protocol.minAgentStake} ` +
            `active_tasks=${agent.activeTasks}`,
        ));
      }
      agents.push({ address, ...agent });
    } catch (error) {
      blockers.push(blocker(
        "invalid-governance-voter-layout",
        address,
        error instanceof Error ? error.message : String(error),
      ));
    }
  }
  const agentMap = new Map(agents.map((agent) => [agent.address.toBase58(), agent]));
  const eligibleAuthorities = buildEligibleAuthorityInventory(
    agents,
    configReachability.rules,
  );
  const attainableVoteWeight = eligibleAuthorities.reduce(
    (sum, voter) => sum + voter.voteWeight,
    0n,
  );
  const proposerAuthorityCount = eligibleAuthorities.filter(
    (voter) => voter.canPropose,
  ).length;

  if (governance && protocol && configReachability.issues.length === 0) {
    if (proposerAuthorityCount === 0) {
      blockers.push(blocker(
        "unreachable-fresh-governance-proposer",
        governanceAddress,
        `zero active authority meets stake=${configReachability.minVoterStake} ` +
          `and reputation=${MIN_GOVERNANCE_VOTER_REPUTATION}`,
      ));
    }
    if (eligibleAuthorities.length < MIN_GOVERNANCE_DISTINCT_VOTERS) {
      blockers.push(blocker(
        "unreachable-fresh-governance-distinct-voters",
        governanceAddress,
        `eligible_distinct_authorities=${eligibleAuthorities.length} ` +
          `required=${MIN_GOVERNANCE_DISTINCT_VOTERS}`,
      ));
    }
    if (
      configReachability.freshQuorum !== null &&
      attainableVoteWeight < configReachability.freshQuorum
    ) {
      blockers.push(blocker(
        "unreachable-fresh-governance-quorum",
        governanceAddress,
        `attainable_weight=${attainableVoteWeight} ` +
          `fresh_quorum=${configReachability.freshQuorum}`,
      ));
    }
  }

  const statusCounts = { active: 0, executed: 0, defeated: 0, cancelled: 0 };
  const proposals = [];
  for (const { pubkey: address, account } of proposalAccounts) {
    if (!account.owner.equals(PROGRAM_ID) || account.executable === true) {
      blockers.push(blocker(
        "invalid-proposal-owner",
        address,
        `owner=${account.owner.toBase58()} executable=${account.executable === true}`,
        { proposal: address },
      ));
      continue;
    }
    try {
      const proposal = decodeProposal(account.data);
      const [expected, expectedBump] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("proposal"),
          proposal.proposer.toBuffer(),
          Buffer.from(account.data.subarray(72, 80)),
        ],
        PROGRAM_ID,
      );
      if (!expected.equals(address) || proposal.bump !== expectedBump) {
        throw new Error(
          `Proposal PDA/bump mismatch stored=${proposal.bump} canonical=${expectedBump}`,
        );
      }
      const proposer = agentMap.get(proposal.proposer.toBase58());
      if (!proposer) {
        throw new Error("stored proposer AgentRegistration is unavailable");
      }
      if (!proposer.authority.equals(proposal.proposerAuthority)) {
        throw new Error(
          "stored proposer authority does not match AgentRegistration authority",
        );
      }
      statusCounts[STATUS_NAMES[proposal.status].toLowerCase()]++;
      proposals.push({ address, ...proposal });
    } catch (error) {
      blockers.push(blocker(
        "invalid-proposal-layout",
        address,
        error instanceof Error ? error.message : String(error),
        { proposal: address },
      ));
    }
  }
  const proposalMap = new Map(
    proposals.map((proposal) => [proposal.address.toBase58(), proposal]),
  );

  const votes = [];
  for (const { pubkey: address, account } of voteAccounts) {
    if (!account.owner.equals(PROGRAM_ID) || account.executable === true) {
      blockers.push(blocker(
        "invalid-governance-vote-owner",
        address,
        `owner=${account.owner.toBase58()} executable=${account.executable === true}`,
      ));
      continue;
    }
    try {
      const vote = decodeGovernanceVote(account.data);
      const voter = agentMap.get(vote.voter.toBase58());
      if (!voter) throw new Error("stored voter AgentRegistration is unavailable");
      const proposal = proposalMap.get(vote.proposal.toBase58());
      if (!proposal) throw new Error("stored Proposal is unavailable");
      const [expected, bump] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("governance_vote"),
          vote.proposal.toBuffer(),
          voter.authority.toBuffer(),
        ],
        PROGRAM_ID,
      );
      if (!expected.equals(address) || vote.bump !== bump) {
        throw new Error("canonical GovernanceVote PDA/bump mismatch");
      }
      if (vote.votedAt < proposal.createdAt || vote.votedAt >= proposal.votingDeadline) {
        throw new Error(
          `voted_at=${vote.votedAt} outside [${proposal.createdAt}, ${proposal.votingDeadline})`,
        );
      }
      if (vote.voteWeight === 0n) {
        throw new Error("vote_weight must be positive");
      }
      if (proposal.rules && vote.voteWeight > proposal.rules.maxVoteWeight) {
        throw new Error(
          `vote_weight=${vote.voteWeight} exceeds proposal cap=` +
            `${proposal.rules.maxVoteWeight}`,
        );
      }
      votes.push({ address, voterAuthority: voter.authority, ...vote });
    } catch (error) {
      blockers.push(blocker(
        "invalid-governance-vote-layout",
        address,
        error instanceof Error ? error.message : String(error),
      ));
    }
  }

  const activeReachability = [];
  for (const proposal of proposals) {
    const linkedVotes = votes.filter((vote) => vote.proposal.equals(proposal.address));
    const decodedVotesFor = linkedVotes
      .filter((vote) => vote.approved)
      .reduce((sum, vote) => sum + vote.voteWeight, 0n);
    const decodedVotesAgainst = linkedVotes
      .filter((vote) => !vote.approved)
      .reduce((sum, vote) => sum + vote.voteWeight, 0n);
    const distinctVotedAuthorities = new Set(
      linkedVotes.map((vote) => vote.voterAuthority.toBase58()),
    );
    const tallyMatches =
      decodedVotesFor === proposal.votesFor &&
      decodedVotesAgainst === proposal.votesAgainst &&
      distinctVotedAuthorities.size === proposal.totalVoters &&
      linkedVotes.length === proposal.totalVoters;
    if (!tallyMatches) {
      blockers.push(blocker(
        "proposal-vote-tally-mismatch",
        proposal.address,
        `stored=${proposal.votesFor}/${proposal.votesAgainst}/${proposal.totalVoters} ` +
          `decoded=${decodedVotesFor}/${decodedVotesAgainst}/${linkedVotes.length} ` +
          `distinct=${distinctVotedAuthorities.size}`,
          { proposal: proposal.address },
      ));
    }
    const storedTotalVotes = proposal.votesFor + proposal.votesAgainst;
    const totalVotesFitU64 = storedTotalVotes <= U64_MAX;
    if (!totalVotesFitU64) {
      blockers.push(blocker(
        "proposal-vote-total-overflow",
        proposal.address,
        `votes_for=${proposal.votesFor} votes_against=${proposal.votesAgainst}`,
        { proposal: proposal.address },
      ));
    }

    if (proposal.status !== 0) continue;
    const payload = inspectProposalPayload(proposal, protocol);
    if (!payload.valid) {
      blockers.push(blocker(
        "active-proposal-invalid-payload",
        proposal.address,
        payload.detail,
        { proposal: proposal.address },
      ));
    }
    const timing = inspectActiveProposalTiming(proposal, governance);
    if (!timing.valid) {
      blockers.push(blocker(
        "active-proposal-invalid-timing",
        proposal.address,
        timing.issues.join("; "),
        { proposal: proposal.address },
      ));
    }

    if (proposal.rulesVersion === 0 || proposal.rules === null) {
      activeReachability.push({
        proposal: proposal.address,
        rulesVersion: proposal.rulesVersion,
        payloadValid: payload.valid,
        timingValid: timing.valid,
        decodedVoteCount: linkedVotes.length,
        remainingEligibleAuthorityCount: 0,
        remainingVoteWeight: 0n,
        attainableDistinctAuthorities: distinctVotedAuthorities.size,
        attainableFinalWeight: storedTotalVotes,
        quorumReachable: false,
        approvalReachable: false,
      });
      blockers.push(blocker(
        "active-legacy-governance-proposal-cutover",
        proposal.address,
        `schema=0 voting_deadline=${proposal.votingDeadline}; ` +
          "legacy Active proposals cannot vote or execute under revision 5",
        { proposal: proposal.address },
      ));
      continue;
    }

    const expectedRules = configReachability.rules;
    const rulesCanonical = expectedRules !== null &&
      proposal.rules.minVoterStake === expectedRules.minVoterStake &&
      proposal.rules.minVoterReputation === expectedRules.minVoterReputation &&
      proposal.rules.maxVoteWeight === expectedRules.maxVoteWeight &&
      proposal.rules.minDistinctVoters === expectedRules.minDistinctVoters &&
      proposal.rules.approvalThresholdBps === expectedRules.approvalThresholdBps &&
      proposal.quorum === configReachability.freshQuorum;
    if (!rulesCanonical) {
      blockers.push(blocker(
        "active-proposal-noncanonical-governance-snapshot",
        proposal.address,
        `stored_quorum=${proposal.quorum} expected_quorum=` +
          `${configReachability.freshQuorum ?? "unavailable"}`,
        { proposal: proposal.address },
      ));
    }

    const proposalEligibleAuthorities = buildEligibleAuthorityInventory(
      agents,
      proposal.rules,
    );
    const remainingVoters = proposalEligibleAuthorities.filter(
      (voter) => !distinctVotedAuthorities.has(voter.authority.toBase58()),
    );
    const remainingWeight = remainingVoters.reduce(
      (sum, voter) => sum + voter.voteWeight,
      0n,
    );
    const capacity = totalVotesFitU64 ? U64_MAX - storedTotalVotes : 0n;
    const addableWeight = remainingWeight < capacity ? remainingWeight : capacity;
    const attainableFinalWeight = storedTotalVotes + addableWeight;
    const attainableDistinctAuthorities =
      distinctVotedAuthorities.size + remainingVoters.length;
    let quorumReachable = rulesCanonical && tallyMatches && totalVotesFitU64 &&
      attainableDistinctAuthorities >= proposal.rules.minDistinctVoters &&
      attainableFinalWeight >= proposal.quorum;
    let approvalReachable = false;
    if (
      quorumReachable &&
      proposal.rules.approvalThresholdBps >= 1 &&
      proposal.rules.approvalThresholdBps < 10_000
    ) {
      const maximumVotesFor = proposal.votesFor + addableWeight;
      approvalReachable =
        maximumVotesFor * 10_000n >
        attainableFinalWeight * BigInt(proposal.rules.approvalThresholdBps);
    }
    if (!quorumReachable) {
      blockers.push(blocker(
        "active-proposal-quorum-unreachable",
        proposal.address,
        `attainable_weight=${attainableFinalWeight} quorum=${proposal.quorum} ` +
          `attainable_distinct=${attainableDistinctAuthorities}`,
        { proposal: proposal.address },
      ));
    } else if (!approvalReachable) {
      blockers.push(blocker(
        "active-proposal-approval-unreachable",
        proposal.address,
          `votes_for=${proposal.votesFor} votes_against=${proposal.votesAgainst} ` +
          `remaining_weight=${addableWeight} ` +
          `threshold_bps=${proposal.rules.approvalThresholdBps}`,
        { proposal: proposal.address },
      ));
    }
    activeReachability.push({
      proposal: proposal.address,
      rulesVersion: proposal.rulesVersion,
      payloadValid: payload.valid,
      timingValid: timing.valid,
      decodedVoteCount: linkedVotes.length,
      remainingEligibleAuthorityCount: remainingVoters.length,
      remainingVoteWeight: remainingWeight,
      attainableDistinctAuthorities,
      attainableFinalWeight,
      quorumReachable,
      approvalReachable,
    });
  }

  if (governance && governance.totalProposals < BigInt(proposals.length)) {
    blockers.push(blocker(
      "governance-proposal-counter-underflow",
      governanceAddress,
      `total_proposals=${governance.totalProposals} decoded=${proposals.length}`,
    ));
  }

  return {
    accountCount: proposalAccounts.length,
    decodedProposalCount: proposals.length,
    governanceVoteCount: voteAccounts.length,
    decodedGovernanceVoteCount: votes.length,
    agentAccountCount: agentAccounts.length,
    decodedAgentCount: agents.length,
    statusCounts,
    governanceAddress,
    protocolAddress,
    governance,
    protocol,
    voterReachability: {
      maxVoteWeight: configReachability.maxVoteWeight,
      minVoterStake: configReachability.minVoterStake,
      minimumElectorateCapacity: configReachability.minimumElectorateCapacity,
      minimumStakeQuorum: configReachability.minimumStakeQuorum,
      percentageQuorum: configReachability.percentageQuorum,
      eligibleDistinctAuthorityCount: eligibleAuthorities.length,
      eligibleProposerAuthorityCount: proposerAuthorityCount,
      attainableVoteWeight,
      freshQuorum: configReachability.freshQuorum,
      freshProposalReachable:
        configReachability.issues.length === 0 &&
        proposerAuthorityCount > 0 &&
        eligibleAuthorities.length >= MIN_GOVERNANCE_DISTINCT_VOTERS &&
        configReachability.freshQuorum !== null &&
        attainableVoteWeight >= configReachability.freshQuorum,
      eligibleAuthorities,
    },
    activeReachability,
    blockers,
  };
}

async function main() {
  const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  console.log(
    `Scanning mainnet Proposal accounts via <redacted-rpc> (program ${PROGRAM_ID.toBase58()})`,
  );
  const result = await scanGovernanceProposals(
    new Connection(rpcUrl, "confirmed"),
  );
  console.log(
    `Proposal: ${result.accountCount} (active=${result.statusCounts.active}, ` +
      `executed=${result.statusCounts.executed}, defeated=${result.statusCounts.defeated}, ` +
      `cancelled=${result.statusCounts.cancelled}); votes=${result.governanceVoteCount}`,
  );
  if (result.governance && result.protocol) {
    console.log(
      `GovernanceConfig: min_proposal_stake=${result.governance.minProposalStake} ` +
        `voting_period=${result.governance.votingPeriod} ` +
        `execution_delay=${result.governance.executionDelay} ` +
        `quorum_bps=${result.governance.quorumBps} ` +
        `approval_threshold_bps=${result.governance.approvalThresholdBps} ` +
        `min_arbiter_stake=${result.protocol.minArbiterStake} ` +
        `min_agent_stake=${result.protocol.minAgentStake} ` +
        `total_agents=${result.protocol.totalAgents}`,
    );
  }
  console.log(
    `Governance reachability: eligible_distinct_authorities=` +
      `${result.voterReachability.eligibleDistinctAuthorityCount} ` +
      `eligible_proposers=${result.voterReachability.eligibleProposerAuthorityCount} ` +
      `min_voter_stake=${result.voterReachability.minVoterStake ?? "unavailable"} ` +
      `per_voter_cap=${result.voterReachability.maxVoteWeight ?? "unavailable"} ` +
      `minimum_electorate_capacity=` +
      `${result.voterReachability.minimumElectorateCapacity ?? "unavailable"} ` +
      `attainable_weight=${result.voterReachability.attainableVoteWeight} ` +
      `fresh_quorum=${result.voterReachability.freshQuorum ?? "unavailable"} ` +
      `fresh_reachable=${result.voterReachability.freshProposalReachable}`,
  );
  for (const item of result.blockers) {
    const target = item.proposal ?? item.address;
    console.error(
      `  BLOCKER ${item.kind}: address=${target.toBase58()}` +
        `${item.detail ? ` detail=${item.detail}` : ""}`,
    );
  }
  if (result.blockers.length > 0) {
    throw new Error(
      `${result.blockers.length} governance cutover blocker(s) found; resolve every reported invariant before deployment`,
    );
  }
  console.log(
    "PREFLIGHT OK: governance configuration and the current distinct-authority electorate are reachable; all Proposal/Vote accounts are canonical and no legacy proposal is Active.",
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(
      `PREFLIGHT FAIL: ${redactRpcText(error instanceof Error ? error.message : error)}`,
    );
    process.exitCode = 1;
  });
}
