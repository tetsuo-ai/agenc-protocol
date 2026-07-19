#!/usr/bin/env node
// Revision-5 mainnet cutover scan for ReputationDelegation accounts.
//
//   delegator.registered_at < delegation.created_at
//
// Revision 5 disables new delegation and makes retirement permissionless and
// reputation-neutral. The cutover still requires ZERO delegation accounts: even
// a canonical/continuous record is a blocker until retired. For every canonical
// record this scanner emits the continuity, recorded authority, rent route, and
// exact identity keys needed to construct that cleanup without sending it. The
// scan is mainnet-only and fails closed on owner/layout/PDA/identity ambiguity.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "tests-integration", "package.json"));
const { Connection, PublicKey, SystemProgram } = require("@solana/web3.js");

export const PROGRAM_ID = new PublicKey(
  "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK",
);
export const MAINNET_GENESIS =
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

const AGENT_DISCRIMINATOR = createHash("sha256")
  .update("account:AgentRegistration")
  .digest()
  .subarray(0, 8);
const DELEGATION_DISCRIMINATOR = createHash("sha256")
  .update("account:ReputationDelegation")
  .digest()
  .subarray(0, 8);

// ReputationDelegation, including Anchor's discriminator:
// delegator@8, delegatee@40, amount@72, expires_at@74, created_at@82.
const DELEGATION_SIZE = 99;
const AGENT_SIZE = 566;
const CREATED_AT_OFFSET = 82;
const DELEGATION_BUMP_OFFSET = 90;
const MAX_REPUTATION = 10_000;

function requireBytes(data, offset, length, field) {
  if (!Buffer.isBuffer(data)) throw new Error(`${field}: expected Buffer`);
  if (offset < 0 || length < 0 || offset + length > data.length) {
    throw new Error(
      `${field}: truncated account (${data.length} bytes; need ${offset + length})`,
    );
  }
}

function assertDiscriminator(data, expected, accountType) {
  requireBytes(data, 0, 8, `${accountType} discriminator`);
  if (!data.subarray(0, 8).equals(expected)) {
    throw new Error(`${accountType}: discriminator mismatch`);
  }
}

function readBorshStringEnd(data, offset, field, maxLength) {
  requireBytes(data, offset, 4, `${field} length`);
  const length = data.readUInt32LE(offset);
  if (length > maxLength) {
    throw new Error(`${field}: encoded length ${length} exceeds maximum ${maxLength}`);
  }
  const end = offset + 4 + length;
  requireBytes(data, offset + 4, length, field);
  return end;
}

/** Decode the identity fields needed from the actual state.rs Borsh order. */
export function decodeAgentRegistration(dataLike) {
  const data = Buffer.from(dataLike);
  if (data.length !== AGENT_SIZE) {
    throw new Error(
      `AgentRegistration: unexpected account size ${data.length}; expected exactly ${AGENT_SIZE}`,
    );
  }
  assertDiscriminator(data, AGENT_DISCRIMINATOR, "AgentRegistration");

  requireBytes(data, 8, 32, "AgentRegistration.agent_id");
  const agentId = Buffer.from(data.subarray(8, 40));
  const authority = new PublicKey(data.subarray(40, 72));
  if (authority.equals(PublicKey.default)) {
    throw new Error("AgentRegistration.authority: default pubkey");
  }

  // discriminator(8) + agent_id(32) + authority(32) + capabilities(u64)
  // + status(unit enum/u8) = endpoint String prefix at byte 81.
  const status = data[80];
  if (status > 3) {
    throw new Error(`AgentRegistration.status: invalid enum variant ${status}`);
  }

  let offset = 81;
  offset = readBorshStringEnd(data, offset, "AgentRegistration.endpoint", 256);
  offset = readBorshStringEnd(
    data,
    offset,
    "AgentRegistration.metadata_uri",
    128,
  );
  requireBytes(data, offset, 8, "AgentRegistration.registered_at");
  const registeredAt = data.readBigInt64LE(offset);
  if (registeredAt <= 0n) {
    throw new Error(
      `AgentRegistration.registered_at: invalid timestamp ${registeredAt}`,
    );
  }
  requireBytes(data, offset, 93, "AgentRegistration fixed tail");
  const bump = data[offset + 44];
  const identityMarker = data.subarray(offset + 89, offset + 93);
  const retired = identityMarker.equals(Buffer.from("RETD", "ascii"));
  if (!retired && !identityMarker.equals(Buffer.alloc(4))) {
    throw new Error("AgentRegistration: invalid reserved identity marker");
  }
  return { agentId, authority, registeredAt, bump, retired };
}

export function decodeDelegation(dataLike) {
  const data = Buffer.from(dataLike);
  if (data.length !== DELEGATION_SIZE) {
    throw new Error(
      `ReputationDelegation: unexpected account size ${data.length}; expected exactly ${DELEGATION_SIZE}`,
    );
  }
  assertDiscriminator(data, DELEGATION_DISCRIMINATOR, "ReputationDelegation");
  const delegator = new PublicKey(data.subarray(8, 40));
  const delegatee = new PublicKey(data.subarray(40, 72));
  const amount = data.readUInt16LE(72);
  const expiresAt = data.readBigInt64LE(74);
  const createdAt = data.readBigInt64LE(CREATED_AT_OFFSET);
  if (
    delegator.equals(PublicKey.default) ||
    delegatee.equals(PublicKey.default) ||
    delegator.equals(delegatee)
  ) {
    throw new Error("ReputationDelegation: invalid delegator/delegatee identity");
  }
  if (amount === 0 || amount > MAX_REPUTATION) {
    throw new Error(`ReputationDelegation.amount: invalid ${amount}`);
  }
  if (createdAt <= 0n) {
    throw new Error(
      `ReputationDelegation.created_at: invalid timestamp ${createdAt}`,
    );
  }
  if (expiresAt !== 0n && expiresAt <= createdAt) {
    throw new Error(
      `ReputationDelegation.expires_at ${expiresAt} is not zero or after created_at ${createdAt}`,
    );
  }
  if (!data.subarray(91, 99).equals(Buffer.alloc(8))) {
    throw new Error("ReputationDelegation: reserved bytes are non-zero");
  }
  return {
    delegator,
    delegatee,
    amount,
    expiresAt,
    createdAt,
    bump: data[DELEGATION_BUMP_OFFSET],
  };
}

export function classifyContinuity(registeredAt, createdAt) {
  if (registeredAt < createdAt) return "safe";
  if (registeredAt === createdAt) return "same-second";
  return "clone";
}

export function redactRpcText(value) {
  // RPC endpoints routinely carry secrets in hostnames, paths, query strings, or
  // userinfo. Do not attempt partial masking: never emit any part of the URL.
  const text = String(value);
  return text.replace(/(?:https?|wss?):\/\/\S+/giu, "<redacted-rpc>");
}

export async function scanDelegations(connection) {
  const genesisHash = await connection.getGenesisHash();
  if (genesisHash !== MAINNET_GENESIS) {
    throw new Error(
      `wrong cluster genesis ${genesisHash}; expected mainnet-beta ${MAINNET_GENESIS}`,
    );
  }

  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: DELEGATION_DISCRIMINATOR.toString("base64"),
          encoding: "base64",
        },
      },
    ],
  });

  const blockers = [];
  const records = [];
  for (const { pubkey, account } of accounts) {
    if (!account.owner.equals(PROGRAM_ID)) {
      blockers.push({ kind: "invalid-owner", delegation: pubkey });
      continue;
    }

    let delegation;
    try {
      delegation = decodeDelegation(account.data);
    } catch (error) {
      blockers.push({
        kind: "decode-error",
        delegation: pubkey,
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const [expectedDelegation, expectedBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("reputation_delegation"),
        delegation.delegator.toBuffer(),
        delegation.delegatee.toBuffer(),
      ],
      PROGRAM_ID,
    );
    if (
      !expectedDelegation.equals(pubkey) ||
      expectedBump !== delegation.bump
    ) {
      blockers.push({
        kind: "invalid-delegation-pda",
        delegation: pubkey,
        ...delegation,
      });
      continue;
    }

    const agentInfo = await connection.getAccountInfo(
      delegation.delegator,
      "confirmed",
    );
    if (
      !agentInfo ||
      (agentInfo.owner.equals(SystemProgram.programId) &&
        !agentInfo.executable &&
        Buffer.from(agentInfo.data).length === 0)
    ) {
      const record = {
        delegation: pubkey,
        ...delegation,
        continuity: "absent",
        authority: null,
        retired: false,
        cleanupRoute: "treasury",
        remainingAccountsRequired: true,
      };
      records.push(record);
      blockers.push({ kind: "orphaned", ...record });
      continue;
    }
    if (!agentInfo.owner.equals(PROGRAM_ID) || agentInfo.executable) {
      blockers.push({
        kind: "invalid-agent-owner",
        delegation: pubkey,
        ...delegation,
      });
      continue;
    }

    try {
      const agent = decodeAgentRegistration(agentInfo.data);
      const [expectedAgent, expectedAgentBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent"), agent.agentId],
        PROGRAM_ID,
      );
      if (
        !expectedAgent.equals(delegation.delegator) ||
        expectedAgentBump !== agent.bump
      ) {
        blockers.push({
          kind: "invalid-agent-pda",
          delegation: pubkey,
          ...delegation,
        });
        continue;
      }
      const kind = classifyContinuity(agent.registeredAt, delegation.createdAt);
      const record = {
        delegation: pubkey,
        ...delegation,
        continuity: kind === "safe" ? "continuous" : kind,
        authority: agent.authority,
        registeredAt: agent.registeredAt,
        retired: agent.retired,
        cleanupRoute: kind === "safe" ? "authority" : "treasury",
        remainingAccountsRequired: kind !== "safe",
      };
      records.push(record);
      if (kind !== "safe") {
        blockers.push({
          kind,
          ...record,
        });
      } else {
        blockers.push({
          kind: "live-delegation-cutover",
          ...record,
        });
      }
    } catch (error) {
      blockers.push({
        kind: "decode-error",
        delegation: pubkey,
        ...delegation,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { accountCount: accounts.length, records, blockers };
}

async function main() {
  const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  console.log(
    `Scanning mainnet ReputationDelegation accounts via <redacted-rpc> (program ${PROGRAM_ID.toBase58()})`,
  );
  const connection = new Connection(rpcUrl, "confirmed");
  const result = await scanDelegations(connection);
  console.log(`ReputationDelegation accounts: ${result.accountCount}`);

  for (const record of result.records) {
    console.log(
      `  CLEANUP delegation=${record.delegation.toBase58()} ` +
        `delegator=${record.delegator.toBase58()} ` +
        `delegatee=${record.delegatee.toBase58()} ` +
        `continuity=${record.continuity} ` +
        `authority=${record.authority?.toBase58() ?? "none"} ` +
        `route=${record.cleanupRoute} ` +
        `remaining_accounts=${record.remainingAccountsRequired ? "protocol,treasury" : "none"}`,
    );
  }

  for (const blocker of result.blockers) {
    const delegation = blocker.delegation.toBase58();
    const created = blocker.createdAt?.toString() ?? "unknown";
    const registered = blocker.registeredAt?.toString() ?? "unknown";
    console.error(
      `  BLOCKER ${blocker.kind}: delegation=${delegation} created_at=${created} registered_at=${registered}`,
    );
  }

  if (result.blockers.length > 0) {
    throw new Error(
      `${result.blockers.length} delegation cutover blocker(s) found; retire every delegation and remediate ambiguity before deployment`,
    );
  }
  console.log(
    "PREFLIGHT OK: no ReputationDelegation account exists.",
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
