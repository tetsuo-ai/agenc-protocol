#!/usr/bin/env node
// Mainnet protocol-fee change via on-chain governance (FeeChange proposal).
//
// TWO PATHS exist to change protocol_fee_bps; this script drives the second:
//
//   A. Direct `update_protocol_fee` — requires the on-chain multisig
//      configured in ProtocolConfig (threshold >= 2 enforced in
//      utils/multisig.rs:require_multisig_threshold; it hard-fails when no
//      owners are configured). Live mainnet decode 2026-07-02:
//      multisig_owners_len=3, threshold=2 — so this path IS operable with
//      2-of-3 signatures. Not what this script does.
//
//   B. The governance FeeChange pipeline (this script; field-proven — the
//      live 100→500 bps change ran through it, total_proposals=1 on-chain) —
//
//   0. initialize_governance   (ONE-TIME; signed by ProtocolConfig.authority.
//                               PARAMETERS ARE PERMANENT — there is no
//                               update_governance instruction.)
//   1. create_proposal          (FeeChange payload; proposer = a REGISTERED agent
//                               with stake >= min_proposal_stake; its wallet signs)
//   2. vote_proposal            (each voting agent's wallet signs; weight =
//                               min(stake, 10*min_arbiter_stake) * reputation / 10000)
//   3. execute_proposal         (after voting_deadline + execution_delay; a passed
//                               FeeChange also needs the CURRENT ProtocolConfig
//                               M-of-N multisig in remaining accounts)
//
// Existing tasks keep the fee snapshotted at their creation; only NEW tasks pick
// up the changed fee.
//
// SAFE BY DEFAULT: read-only plan unless --execute is passed. Plan mode decodes
// live state, computes the quorum arithmetic, and SENDS NOTHING.
//
// THIS SCRIPT NEVER READS, DECRYPTS, OR EMBEDS A KEY. It takes keypair FILE
// PATHS via env vars and loads them only inside the web3 keypair loader
// (mainnet-init-and-stamp.mjs convention). Plain keypair JSON only.
//
// USAGE (deps resolve from tests-integration/node_modules):
//
//   Plan (read-only, no keys needed):
//     RPC_URL=https://your-mainnet-rpc node scripts/mainnet-fee-change.mjs
//
//   Step 0 — initialize governance (authority signs; PARAMETERS ARE PERMANENT):
//     RPC_URL=... AUTHORITY_KEYPAIR=/path/authority.json \
//     [VOTING_PERIOD_SECS=86400] [EXECUTION_DELAY_SECS=3600] \
//     [QUORUM_BPS=300] [APPROVAL_THRESHOLD_BPS=5000] [MIN_PROPOSAL_STAKE_LAMPORTS=10000000] \
//     node scripts/mainnet-fee-change.mjs --init-governance [--execute]
//
//   Step 1 — create the FeeChange proposal (proposer wallet signs):
//     RPC_URL=... PROPOSER_KEYPAIR=/path/wallet-with-registered-agent.json \
//     NEW_FEE_BPS=500 [PROPOSAL_VOTING_PERIOD_SECS=86400] \
//     node scripts/mainnet-fee-change.mjs --propose [--execute]
//
//   Step 2 — vote (repeat per voting wallet; each wallet must own a registered agent):
//     RPC_URL=... VOTER_KEYPAIR=/path/voter.json PROPOSAL=<proposalPda> \
//     node scripts/mainnet-fee-change.mjs --vote [--execute]
//
//   Step 3 — execute after deadlines (executor + current multisig owners sign):
//     RPC_URL=... AUTHORITY_KEYPAIR=/path/executor.json \
//     MULTISIG_OWNER_KEYPAIRS=/path/owner1.json,/path/owner2.json \
//     PROPOSAL=<proposalPda> \
//     node scripts/mainnet-fee-change.mjs --finalize [--execute]

import { createRequire } from "module";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { createHash } from "crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "tests-integration", "package.json"));
const anchor = require("@coral-xyz/anchor");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");

const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const EXECUTE = process.argv.includes("--execute");
const MODE = process.argv.includes("--init-governance")
  ? "init-governance"
  : process.argv.includes("--propose")
    ? "propose"
    : process.argv.includes("--vote")
      ? "vote"
      : process.argv.includes("--finalize")
        ? "finalize"
        : "plan";

function die(msg) { console.error(`ERROR: ${msg}`); process.exit(1); }
function loadKeypair(p) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p.replace(/^~/, process.env.HOME), "utf8"))));
}
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const v = Number.parseInt(raw, 10);
  if (!Number.isFinite(v)) die(`${name} must be an integer`);
  return v;
}
const fmt = (n) => Number(n).toLocaleString("en-US");

// Wallet: real signer for the acting mode, throwaway for read-only plan.
const signerPath =
  MODE === "propose" ? process.env.PROPOSER_KEYPAIR
  : MODE === "vote" ? process.env.VOTER_KEYPAIR
  : MODE === "init-governance" || MODE === "finalize" ? process.env.AUTHORITY_KEYPAIR
  : null;
if (MODE !== "plan" && !signerPath) {
  die(`${MODE} needs ${MODE === "propose" ? "PROPOSER_KEYPAIR" : MODE === "vote" ? "VOTER_KEYPAIR" : "AUTHORITY_KEYPAIR"}`);
}
const signer = signerPath ? loadKeypair(signerPath) : Keypair.generate();

const connection = new Connection(RPC_URL, "confirmed");
const idl = JSON.parse(readFileSync(path.join(ROOT, "artifacts/anchor/idl/agenc_coordination.json"), "utf8"));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(signer), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);

const [protocolPda] = PublicKey.findProgramAddressSync([Buffer.from("protocol")], PROGRAM_ID);
const [governancePda] = PublicKey.findProgramAddressSync([Buffer.from("governance")], PROGRAM_ID);

const MAX_REPUTATION = 10_000n;
const U64_MAX = (1n << 64n) - 1n;
const MIN_GOVERNANCE_VOTER_STAKE = 10_000_000n;
const MIN_GOVERNANCE_VOTER_REPUTATION = 5_000;
const MIN_GOVERNANCE_DISTINCT_VOTERS = 3n;
const MIN_GOVERNANCE_QUORUM_WEIGHT = 100_000_000n;
const GOVERNANCE_VOTE_WEIGHT_CAP_MULTIPLIER = 10n;

const asBigInt = (value) => BigInt(value.toString());

function voteWeight(stake, reputation, cap) {
  const normalizedStake = asBigInt(stake);
  const stakeWeight = normalizedStake < cap ? normalizedStake : cap;
  const weight = (stakeWeight * BigInt(reputation)) / MAX_REPUTATION;
  return stakeWeight > 0n && weight === 0n ? 1n : weight;
}

function freshProposalRequirements(
  minProposalStake,
  minArbiterStake,
  quorumBps,
  approvalThresholdBps,
) {
  if (!Number.isInteger(quorumBps) || quorumBps < 1 || quorumBps > 10_000) {
    throw new Error(`quorum_bps=${quorumBps} must be in 1..10000`);
  }
  if (
    !Number.isInteger(approvalThresholdBps) ||
    approvalThresholdBps < 1 ||
    approvalThresholdBps >= 10_000
  ) {
    throw new Error(
      `approval_threshold_bps=${approvalThresholdBps} must be in 1..9999`,
    );
  }
  const configuredMinimum = asBigInt(minProposalStake);
  const minVoterStake = configuredMinimum > MIN_GOVERNANCE_VOTER_STAKE
    ? configuredMinimum
    : MIN_GOVERNANCE_VOTER_STAKE;
  const maxVoteWeight = asBigInt(minArbiterStake) *
    GOVERNANCE_VOTE_WEIGHT_CAP_MULTIPLIER;
  if (maxVoteWeight > U64_MAX) {
    throw new Error(`per-voter cap=${maxVoteWeight} exceeds u64`);
  }
  if (configuredMinimum < 1n || minVoterStake > maxVoteWeight) {
    throw new Error(
      `min_proposal_stake=${configuredMinimum} min_voter_stake=${minVoterStake} ` +
        `exceeds per-voter cap=${maxVoteWeight}`,
    );
  }
  const minimumElectorateCapacity = maxVoteWeight *
    MIN_GOVERNANCE_DISTINCT_VOTERS;
  if (minimumElectorateCapacity > U64_MAX) {
    throw new Error(
      `minimum electorate capacity=${minimumElectorateCapacity} exceeds u64`,
    );
  }
  if (minimumElectorateCapacity < MIN_GOVERNANCE_QUORUM_WEIGHT) {
    throw new Error(
      `minimum electorate capacity=${minimumElectorateCapacity} cannot attain ` +
        `hard quorum=${MIN_GOVERNANCE_QUORUM_WEIGHT}`,
    );
  }
  const minimumStakeQuorum = minVoterStake * MIN_GOVERNANCE_DISTINCT_VOTERS;
  const percentageQuorum =
    (minimumElectorateCapacity * BigInt(quorumBps) + 9_999n) / 10_000n;
  const quorum = [
    MIN_GOVERNANCE_QUORUM_WEIGHT,
    minimumStakeQuorum,
    percentageQuorum,
  ].reduce((maximum, value) => value > maximum ? value : maximum, 0n);
  if (quorum > minimumElectorateCapacity) {
    throw new Error(
      `quorum=${quorum} exceeds minimum electorate capacity=` +
        `${minimumElectorateCapacity}`,
    );
  }
  return {
    minVoterStake,
    minVoterReputation: MIN_GOVERNANCE_VOTER_REPUTATION,
    maxVoteWeight,
    minDistinctVoters: Number(MIN_GOVERNANCE_DISTINCT_VOTERS),
    approvalThresholdBps,
    minimumElectorateCapacity,
    minimumStakeQuorum,
    percentageQuorum,
    quorum,
  };
}

function decodeProposalRules(proposal) {
  const reserved = Buffer.from(proposal._reserved);
  if (reserved.length !== 64 || reserved[0] !== 1) {
    throw new Error("proposal has no revision-5 governance rules snapshot");
  }
  if (!reserved.subarray(23).equals(Buffer.alloc(41))) {
    throw new Error("proposal governance rules snapshot has nonzero trailing bytes");
  }
  return {
    minVoterStake: reserved.readBigUInt64LE(1),
    minVoterReputation: reserved.readUInt16LE(9),
    maxVoteWeight: reserved.readBigUInt64LE(11),
    minDistinctVoters: reserved.readUInt16LE(19),
    approvalThresholdBps: reserved.readUInt16LE(21),
  };
}

function isActiveAgent(agent) {
  const variant = Object.keys(agent.status ?? {})[0]?.toLowerCase();
  return variant === "active" && agent.retired !== true;
}

async function agentsOwnedBy(authorityPk) {
  const all = await program.account.agentRegistration.all();
  return all.filter((a) => a.account.authority.equals(authorityPk));
}

async function sendIx(builder, label) {
  if (!EXECUTE) {
    console.log(`DRY-RUN: would send ${label} (pass --execute to send)`);
    return null;
  }
  const sig = await builder.rpc();
  console.log(`SENT ${label}: ${sig}`);
  return sig;
}

async function main() {
  console.log(`mode=${MODE} execute=${EXECUTE} rpc=${RPC_URL}`);
  console.log(`program=${PROGRAM_ID.toBase58()}`);

  const config = await program.account.protocolConfig.fetch(protocolPda);
  console.log(`\nProtocolConfig: authority=${config.authority.toBase58()}`);
  console.log(`  protocol_fee_bps=${config.protocolFeeBps} (current)`);
  console.log(`  total_agents=${config.totalAgents} min_arbiter_stake=${fmt(config.minArbiterStake)}`);

  const govInfo = await connection.getAccountInfo(governancePda);
  let governance = null;
  if (govInfo) {
    governance = await program.account.governanceConfig.fetch(governancePda);
    console.log(`\nGovernanceConfig: INITIALIZED`);
    console.log(`  voting_period=${governance.votingPeriod}s execution_delay=${governance.executionDelay}s`);
    console.log(`  quorum_bps=${governance.quorumBps} approval_threshold_bps=${governance.approvalThresholdBps}`);
    console.log(`  min_proposal_stake=${fmt(governance.minProposalStake)} total_proposals=${governance.totalProposals}`);
  } else {
    console.log(`\nGovernanceConfig: NOT INITIALIZED (["governance"] PDA empty) — run --init-governance first.`);
  }

  /* ----------------------------- init-governance ----------------------------- */
  if (MODE === "init-governance") {
    if (govInfo) die("governance is already initialized — parameters are PERMANENT and cannot be re-set.");
    if (!signer.publicKey.equals(config.authority)) {
      die(`AUTHORITY_KEYPAIR pubkey ${signer.publicKey.toBase58()} != ProtocolConfig.authority ${config.authority.toBase58()}`);
    }
    const votingPeriod = envInt("VOTING_PERIOD_SECS", 86_400);
    const executionDelay = envInt("EXECUTION_DELAY_SECS", 3_600);
    const quorumBps = envInt("QUORUM_BPS", 300);
    const approvalBps = envInt("APPROVAL_THRESHOLD_BPS", 5_000);
    const minProposalStake = envInt("MIN_PROPOSAL_STAKE_LAMPORTS", 10_000_000);

    const requirements = freshProposalRequirements(
      minProposalStake,
      config.minArbiterStake,
      quorumBps,
      approvalBps,
    );
    console.log(`\nPLAN initialize_governance (PERMANENT):`);
    console.log(`  voting_period=${votingPeriod}s (${(votingPeriod / 3600).toFixed(1)}h)`);
    console.log(`  execution_delay=${executionDelay}s quorum_bps=${quorumBps} approval=${approvalBps}`);
    console.log(`  min_proposal_stake=${fmt(minProposalStake)} lamports`);
    console.log(
      `  -> hard quorum=${fmt(requirements.quorum)} ` +
        `min_distinct_voters=${requirements.minDistinctVoters} ` +
        `min_voter_stake=${fmt(requirements.minVoterStake)} ` +
        `min_voter_reputation=${requirements.minVoterReputation}`,
    );

    await sendIx(
      program.methods
        .initializeGovernance(
          new anchor.BN(votingPeriod),
          new anchor.BN(executionDelay),
          quorumBps,
          approvalBps,
          new anchor.BN(minProposalStake),
        )
        .accounts({
          governanceConfig: governancePda,
          protocolConfig: protocolPda,
          authority: signer.publicKey,
        }),
      "initialize_governance",
    );
    return;
  }

  /* --------------------------------- propose --------------------------------- */
  if (MODE === "propose") {
    if (!governance) die("governance not initialized — run --init-governance first.");
    const newFeeBps = envInt("NEW_FEE_BPS", NaN);
    if (!Number.isFinite(newFeeBps) || newFeeBps < 0 || newFeeBps > 2000) die("NEW_FEE_BPS required (0..2000).");

    const agents = await agentsOwnedBy(signer.publicKey);
    const requirements = freshProposalRequirements(
      governance.minProposalStake,
      config.minArbiterStake,
      governance.quorumBps,
      governance.approvalThresholdBps,
    );
    const proposerAgent = agents.find((a) =>
      isActiveAgent(a.account) &&
      asBigInt(a.account.stake) >= requirements.minVoterStake &&
      a.account.reputation >= requirements.minVoterReputation
    );
    if (!proposerAgent) {
      die(
        `wallet ${signer.publicKey.toBase58()} owns no Active agent with ` +
          `stake >= ${requirements.minVoterStake} and reputation >= ` +
          `${requirements.minVoterReputation} (owned: ${agents.length})`,
      );
    }
    const nonce = new anchor.BN(Date.now());
    const [proposalPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("proposal"), proposerAgent.publicKey.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)],
      PROGRAM_ID,
    );
    const title = `Set protocol_fee_bps to ${newFeeBps}`;
    const description = `Change protocol_fee_bps from ${config.protocolFeeBps} to ${newFeeBps}. New tasks snapshot the new fee; existing tasks keep their locked fee.`;
    const payload = Buffer.alloc(64);
    payload.writeUInt16LE(newFeeBps, 0);
    const votingPeriod = envInt("PROPOSAL_VOTING_PERIOD_SECS", Number(governance.votingPeriod));

    console.log(`\nPLAN create_proposal (FeeChange):`);
    console.log(`  proposer agent=${proposerAgent.publicKey.toBase58()} (stake=${fmt(proposerAgent.account.stake)})`);
    console.log(`  proposal PDA=${proposalPda.toBase58()} nonce=${nonce.toString()}`);
    console.log(`  ${config.protocolFeeBps} bps -> ${newFeeBps} bps | voting_period=${votingPeriod}s`);
    console.log(`  title="${title}"`);

    await sendIx(
      program.methods
        .createProposal(
          nonce,
          1, // ProposalType::FeeChange
          [...createHash("sha256").update(title).digest()],
          [...createHash("sha256").update(description).digest()],
          [...payload],
          new anchor.BN(votingPeriod),
        )
        .accounts({
          proposal: proposalPda,
          proposer: proposerAgent.publicKey,
          protocolConfig: protocolPda,
          governanceConfig: governancePda,
          authority: signer.publicKey,
        }),
      "create_proposal",
    );
    console.log(`\nKEEP THE TITLE + DESCRIPTION TEXT — only their sha-256 goes on-chain:\n  title: ${title}\n  description: ${description}`);
    if (EXECUTE) console.log(`\nNext: vote with PROPOSAL=${proposalPda.toBase58()}`);
    return;
  }

  /* ----------------------------------- vote ---------------------------------- */
  if (MODE === "vote") {
    if (!governance) die("governance not initialized.");
    const proposalPda = new PublicKey(process.env.PROPOSAL || die("PROPOSAL=<pda> required"));
    const proposal = await program.account.proposal.fetch(proposalPda);
    const rules = decodeProposalRules(proposal);
    const agents = await agentsOwnedBy(signer.publicKey);
    const eligible = agents.filter((a) =>
      isActiveAgent(a.account) &&
      asBigInt(a.account.stake) >= rules.minVoterStake &&
      a.account.reputation >= rules.minVoterReputation &&
      a.account.reputation <= Number(MAX_REPUTATION)
    );
    if (!eligible.length) {
      die(
        `wallet ${signer.publicKey.toBase58()} owns no Active agent eligible ` +
          `under this proposal's immutable rules`,
      );
    }
    const voter = eligible.sort((a, b) =>
      asBigInt(b.account.stake) > asBigInt(a.account.stake) ? 1 : -1
    )[0];
    const weight = voteWeight(
      voter.account.stake,
      voter.account.reputation,
      rules.maxVoteWeight,
    );
    const [votePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("governance_vote"), proposalPda.toBuffer(), signer.publicKey.toBuffer()],
      PROGRAM_ID,
    );
    console.log(`\nPLAN vote_proposal(approve=true):`);
    console.log(`  proposal=${proposalPda.toBase58()} deadline=${new Date(Number(proposal.votingDeadline) * 1000).toISOString()}`);
    console.log(`  votes_for=${fmt(proposal.votesFor)} votes_against=${fmt(proposal.votesAgainst)} quorum=${fmt(proposal.quorum)}`);
    console.log(`  voting agent=${voter.publicKey.toBase58()} weight=${fmt(weight)}`);

    await sendIx(
      program.methods.voteProposal(true).accounts({
        proposal: proposalPda,
        vote: votePda,
        voter: voter.publicKey,
        protocolConfig: protocolPda,
        authority: signer.publicKey,
      }),
      "vote_proposal",
    );
    return;
  }

  /* --------------------------------- finalize -------------------------------- */
  if (MODE === "finalize") {
    if (!governance) die("governance not initialized.");
    const proposalPda = new PublicKey(process.env.PROPOSAL || die("PROPOSAL=<pda> required"));
    const proposal = await program.account.proposal.fetch(proposalPda);
    const now = Math.floor(Date.now() / 1000);
    const deadline = Number(proposal.votingDeadline);
    const execAfter = deadline + Number(governance.executionDelay);
    console.log(`\nPLAN execute_proposal:`);
    console.log(`  votes_for=${fmt(proposal.votesFor)} votes_against=${fmt(proposal.votesAgainst)} quorum=${fmt(proposal.quorum)}`);
    console.log(`  voting ends ${new Date(deadline * 1000).toISOString()} | executable after ${new Date(execAfter * 1000).toISOString()}`);
    if (now < execAfter) console.log(`  NOT YET EXECUTABLE (${fmt(execAfter - now)}s remaining)`);

    const configuredOwners = config.multisigOwners
      .slice(0, config.multisigOwnersLen)
      .map((owner) => owner.toBase58());
    const ownerPaths = (process.env.MULTISIG_OWNER_KEYPAIRS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const ownerKeypairs = ownerPaths.map(loadKeypair);
    const availableByKey = new Map(
      [signer, ...ownerKeypairs]
        .filter((keypair) => configuredOwners.includes(keypair.publicKey.toBase58()))
        .map((keypair) => [keypair.publicKey.toBase58(), keypair]),
    );
    const availableOwners = [...availableByKey.values()];
    console.log(
      `  current multisig threshold=${config.multisigThreshold}/` +
        `${config.multisigOwnersLen} supplied_unique_owners=${availableOwners.length}`,
    );
    if (EXECUTE && availableOwners.length < config.multisigThreshold) {
      die(
        `finalize needs ${config.multisigThreshold} unique current owner keys; ` +
          `${availableOwners.length} supplied`,
      );
    }
    const ownerMetas = availableOwners.map((keypair) => ({
      pubkey: keypair.publicKey,
      isSigner: true,
      isWritable: false,
    }));
    const additionalSigners = availableOwners.filter(
      (keypair) => !keypair.publicKey.equals(signer.publicKey),
    );

    await sendIx(
      program.methods.executeProposal().accounts({
        proposal: proposalPda,
        protocolConfig: protocolPda,
        governanceConfig: governancePda,
        authority: signer.publicKey,
        treasury: null,
        recipient: null,
      })
        .remainingAccounts(ownerMetas)
        .signers(additionalSigners),
      "execute_proposal",
    );
    if (EXECUTE) {
      const after = await program.account.protocolConfig.fetch(protocolPda);
      console.log(`\nprotocol_fee_bps now: ${after.protocolFeeBps}`);
    }
    return;
  }

  /* ----------------------------------- plan ---------------------------------- */
  if (governance) {
    const requirements = freshProposalRequirements(
      governance.minProposalStake,
      config.minArbiterStake,
      governance.quorumBps,
      governance.approvalThresholdBps,
    );
    console.log(
      `\nNew-proposal quorum: ${fmt(requirements.quorum)} vote-weight ` +
        `(hard floor, ${requirements.minDistinctVoters} distinct mature voters minimum)`,
    );
  }
  console.log(`\nNext step: ${govInfo ? "--propose with PROPOSER_KEYPAIR + NEW_FEE_BPS=500" : "--init-governance with AUTHORITY_KEYPAIR"}`);
}

main().catch((e) => die(e.message ?? String(e)));
