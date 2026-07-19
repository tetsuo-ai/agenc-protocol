#!/usr/bin/env node
// Mainnet ReputationStake custody inventory for the revision-5 cutover.
//
// ReputationStake is the only current 74-byte program account. Enumerating by
// exact size (rather than discriminator) makes a corrupted discriminator visible
// and fail-closed. Every decoded account is checked independently for canonical
// PDA/agent identity and rent-plus-principal backing; aggregate surplus can never
// conceal one underbacked stake.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodeAgentBinding } from "./preflight-dispute-scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "tests-integration", "package.json"));
const { Connection, PublicKey, SystemProgram } = require("@solana/web3.js");

export const PROGRAM_ID = new PublicKey(
  "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK",
);
export const MAINNET_GENESIS =
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const REPUTATION_STAKE_SIZE = 74;
export const REPUTATION_STAKE_LOCK_SECS = 604_800n;

const REPUTATION_STAKE_DISCRIMINATOR = createHash("sha256")
  .update("account:ReputationStake")
  .digest()
  .subarray(0, 8);
const ZERO_PUBKEY = PublicKey.default;

function detail(error) {
  return error instanceof Error ? error.message : String(error);
}

function asSafeLamports(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field}: expected non-negative safe-integer lamports`);
  }
  return BigInt(value);
}

function isExactAbsentPda(account) {
  return (
    account !== null &&
    account.owner.equals(SystemProgram.programId) &&
    !account.executable &&
    Buffer.from(account.data).length === 0
  );
}

/** Decode the exact deployed/candidate ReputationStake Borsh layout. */
export function decodeReputationStake(dataLike) {
  const data = Buffer.from(dataLike);
  if (data.length !== REPUTATION_STAKE_SIZE) {
    throw new Error(
      `ReputationStake: unexpected account size ${data.length}; expected exactly ${REPUTATION_STAKE_SIZE}`,
    );
  }
  if (!data.subarray(0, 8).equals(REPUTATION_STAKE_DISCRIMINATOR)) {
    throw new Error("ReputationStake: discriminator mismatch");
  }

  const agent = new PublicKey(data.subarray(8, 40));
  if (agent.equals(ZERO_PUBKEY)) {
    throw new Error("ReputationStake.agent: default pubkey");
  }
  const stakedAmount = data.readBigUInt64LE(40);
  const lockedUntil = data.readBigInt64LE(48);
  const slashCount = data[56];
  const createdAt = data.readBigInt64LE(57);
  const bump = data[65];
  const reserved = data.subarray(66, 74);

  if (createdAt <= 0n) {
    throw new Error(
      `ReputationStake.created_at: invalid timestamp ${createdAt}`,
    );
  }
  const minimumLock = createdAt + REPUTATION_STAKE_LOCK_SECS;
  if (lockedUntil < minimumLock) {
    throw new Error(
      `ReputationStake.locked_until ${lockedUntil} precedes created_at + cooldown ${minimumLock}`,
    );
  }
  if (!reserved.equals(Buffer.alloc(8))) {
    throw new Error("ReputationStake: reserved bytes are non-zero");
  }

  return {
    agent,
    stakedAmount,
    lockedUntil,
    slashCount,
    createdAt,
    bump,
  };
}

export function redactRpcText(value) {
  return String(value).replace(
    /(?:https?|wss?):\/\/\S+/giu,
    "<redacted-rpc>",
  );
}

export async function scanReputationStakes(connection) {
  const genesisHash = await connection.getGenesisHash();
  if (genesisHash !== MAINNET_GENESIS) {
    throw new Error(
      `wrong cluster genesis ${genesisHash}; expected mainnet-beta ${MAINNET_GENESIS}`,
    );
  }

  const rentMinimumNumber = await connection.getMinimumBalanceForRentExemption(
    REPUTATION_STAKE_SIZE,
    "confirmed",
  );
  const rentMinimumLamports = asSafeLamports(
    rentMinimumNumber,
    "ReputationStake rent minimum",
  );

  // Size enumeration is deliberate. A discriminator memcmp would silently omit
  // a canonical-sized account whose discriminator was corrupted.
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ dataSize: REPUTATION_STAKE_SIZE }],
  });

  const records = [];
  const blockers = [];
  let trackedStakedAmount = 0n;
  let actualLamports = 0n;
  let requiredRentLamports = 0n;
  let requiredBackingLamports = 0n;
  let backingDeficitLamports = 0n;
  let backingSurplusLamports = 0n;
  let underbackedAccountCount = 0;
  let liveAgentCount = 0;
  let retiredAgentCount = 0;
  let absentAgentCount = 0;
  let invalidAgentCount = 0;
  let principalWithoutAgentCount = 0;
  let principalWithoutAgentLamports = 0n;

  for (const { pubkey, account } of accounts) {
    if (
      !account.owner.equals(PROGRAM_ID) ||
      account.executable ||
      Buffer.from(account.data).length !== REPUTATION_STAKE_SIZE
    ) {
      blockers.push({
        kind: "invalid-reputation-stake-account",
        reputationStake: pubkey,
      });
      continue;
    }

    let stake;
    try {
      stake = decodeReputationStake(account.data);
    } catch (error) {
      blockers.push({
        kind: "invalid-reputation-stake-layout",
        reputationStake: pubkey,
        detail: detail(error),
      });
      continue;
    }

    const [expectedStake, expectedBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("reputation_stake"), stake.agent.toBuffer()],
      PROGRAM_ID,
    );
    if (!expectedStake.equals(pubkey) || expectedBump !== stake.bump) {
      blockers.push({
        kind: "invalid-reputation-stake-pda",
        reputationStake: pubkey,
        agent: stake.agent,
      });
      continue;
    }

    let lamports;
    try {
      lamports = asSafeLamports(
        account.lamports,
        `ReputationStake ${pubkey.toBase58()} balance`,
      );
    } catch (error) {
      blockers.push({
        kind: "invalid-reputation-stake-balance",
        reputationStake: pubkey,
        agent: stake.agent,
        detail: detail(error),
      });
      continue;
    }

    const requiredBacking = rentMinimumLamports + stake.stakedAmount;
    const backingDeficit =
      lamports < requiredBacking ? requiredBacking - lamports : 0n;
    const backingSurplus =
      lamports > requiredBacking ? lamports - requiredBacking : 0n;
    if (backingDeficit > 0n) {
      underbackedAccountCount += 1;
      backingDeficitLamports += backingDeficit;
      blockers.push({
        kind: "underbacked-reputation-stake",
        reputationStake: pubkey,
        agent: stake.agent,
        stakedAmount: stake.stakedAmount,
        lamports,
        requiredBacking,
        backingDeficit,
      });
    }

    let agentState = "invalid";
    const agentInfo = await connection.getAccountInfo(stake.agent, "confirmed");
    if (agentInfo === null || isExactAbsentPda(agentInfo)) {
      agentState = "absent";
      absentAgentCount += 1;
      if (stake.stakedAmount > 0n) {
        principalWithoutAgentCount += 1;
        principalWithoutAgentLamports += stake.stakedAmount;
        blockers.push({
          kind: "reputation-stake-principal-without-agent",
          reputationStake: pubkey,
          agent: stake.agent,
          stakedAmount: stake.stakedAmount,
        });
      }
    } else if (
      !agentInfo.owner.equals(PROGRAM_ID) ||
      agentInfo.executable
    ) {
      invalidAgentCount += 1;
      blockers.push({
        kind: "invalid-reputation-stake-agent-account",
        reputationStake: pubkey,
        agent: stake.agent,
      });
    } else {
      try {
        const agent = decodeAgentBinding(agentInfo.data);
        const [expectedAgent, expectedAgentBump] =
          PublicKey.findProgramAddressSync(
            [Buffer.from("agent"), agent.agentId],
            PROGRAM_ID,
          );
        if (
          !expectedAgent.equals(stake.agent) ||
          expectedAgentBump !== agent.bump ||
          agent.authority.equals(ZERO_PUBKEY)
        ) {
          throw new Error("AgentRegistration canonical PDA/bump/authority mismatch");
        }
        agentState = agent.retired ? "retired" : "live";
        if (agent.retired) retiredAgentCount += 1;
        else liveAgentCount += 1;
      } catch (error) {
        invalidAgentCount += 1;
        blockers.push({
          kind: "invalid-reputation-stake-agent-binding",
          reputationStake: pubkey,
          agent: stake.agent,
          detail: detail(error),
        });
      }
    }

    trackedStakedAmount += stake.stakedAmount;
    actualLamports += lamports;
    requiredRentLamports += rentMinimumLamports;
    requiredBackingLamports += requiredBacking;
    backingSurplusLamports += backingSurplus;
    records.push({
      reputationStake: pubkey,
      ...stake,
      agentState,
      lamports,
      rentMinimumLamports,
      requiredBackingLamports: requiredBacking,
      backingDeficitLamports: backingDeficit,
      backingSurplusLamports: backingSurplus,
    });
  }

  return {
    accountCount: accounts.length,
    decodedAccountCount: records.length,
    liveAgentCount,
    retiredAgentCount,
    absentAgentCount,
    invalidAgentCount,
    principalWithoutAgentCount,
    principalWithoutAgentLamports,
    underbackedAccountCount,
    rentMinimumLamports,
    trackedStakedAmount,
    actualLamports,
    requiredRentLamports,
    requiredBackingLamports,
    backingDeficitLamports,
    backingSurplusLamports,
    records,
    blockers,
  };
}

async function main() {
  const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  console.log(
    `Scanning mainnet ReputationStake custody via <redacted-rpc> (program ${PROGRAM_ID.toBase58()})`,
  );
  const connection = new Connection(rpcUrl, "confirmed");
  const result = await scanReputationStakes(connection);
  console.log(`ReputationStake accounts: ${result.accountCount}`);
  console.log(`Decoded canonical accounts: ${result.decodedAccountCount}`);
  console.log(`Tracked staked principal: ${result.trackedStakedAmount}`);
  console.log(`Actual account lamports: ${result.actualLamports}`);
  console.log(`Required rent + principal: ${result.requiredBackingLamports}`);
  console.log(`Per-account backing deficit: ${result.backingDeficitLamports}`);
  console.log(`Per-account backing surplus: ${result.backingSurplusLamports}`);
  console.log(
    `Agent parents: live=${result.liveAgentCount} retired=${result.retiredAgentCount} ` +
      `absent=${result.absentAgentCount} invalid=${result.invalidAgentCount}`,
  );

  for (const blocker of result.blockers) {
    console.error(
      `  BLOCKER ${blocker.kind}: stake=${blocker.reputationStake?.toBase58?.() ?? "unknown"} ` +
        `agent=${blocker.agent?.toBase58?.() ?? "unknown"} detail=${blocker.detail ?? "none"}`,
    );
  }
  if (result.blockers.length > 0) {
    throw new Error(
      `${result.blockers.length} ReputationStake custody blocker(s) found; remediate corruption or underbacking before deployment`,
    );
  }
  console.log(
    "PREFLIGHT OK: every ReputationStake is canonical and independently backed by rent plus tracked principal.",
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
