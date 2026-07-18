#!/usr/bin/env node
// Audit (2026-07 swarm, C6 re-open) preflight: revoke_delegation now requires
// STRICT identity continuity (delegator.registered_at < delegation.created_at)
// after delegate_reputation gained a registration-age gate. Equality
// (registered_at == created_at) is the attacker's single-slot
// [delegate, deregister, register] clone — but it is ALSO the shape of an
// honest legacy delegation created in the same second as its registration
// (before the delegate-time gate existed). Those legacy delegations become
// unrevocable under the strict check, so any hit must be handled (e.g. by
// having the delegator NOT deregister and revoking before the upgrade ships)
// BEFORE deploying the upgrade.
//
// Expected result on mainnet today: ZERO delegations at all (the feature is
// young), so zero same-second delegations.
//
// Usage:
//   RPC_URL=https://your-mainnet-rpc node scripts/preflight-delegation-scan.mjs
//
// Exit code 0 = no same-second delegations. Exit 1 = hits found (or RPC failure).

import { Connection, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";

const PROGRAM_ID = new PublicKey("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";

// ReputationDelegation layout (state.rs), after the 8-byte discriminator:
// delegator[32]@8 delegatee[32]@40 amount(u16)@72 expires_at(i64)@74
// created_at(i64)@82 bump(u8)@90
const CREATED_AT_OFFSET = 82;

// AgentRegistration layout (state.rs), after the 8-byte discriminator:
// agent_id[32]@8 authority[32]@40 endpoint(String: u32 len @72, bytes @76)
// capabilities(u64) reputation(u16) status(u8) completed_tasks(u32)
// total_earnings(u64) active_tasks(u8) disputes_as_defendant(u8)
// disputes_as_initiator(u8) active_dispute_votes(u8) last_active(i64)
// registered_at(i64)  <- parsed by walking the variable-length endpoint string.
function agentRegisteredAt(data) {
  const endpointLen = data.readUInt32LE(72);
  let off = 76 + endpointLen;
  off += 8; // capabilities
  off += 2; // reputation
  off += 1; // status
  off += 4; // completed_tasks
  off += 8; // total_earnings
  off += 1; // active_tasks
  off += 1; // disputes_as_defendant
  off += 1; // disputes_as_initiator
  off += 1; // active_dispute_votes
  off += 8; // last_active
  return Number(data.readBigInt64LE(off));
}

const discriminator = createHash("sha256").update("account:ReputationDelegation").digest().subarray(0, 8);

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  console.log(`Scanning ReputationDelegation accounts on ${RPC_URL.replace(/\/\/.*@/, "//***@")} (program ${PROGRAM_ID.toBase58()})`);

  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: discriminator.toString("base64"), encoding: "base64" } }],
  });
  console.log(`ReputationDelegation accounts: ${accounts.length}`);

  let sameSecond = 0;
  let orphaned = 0;
  for (const { pubkey, account } of accounts) {
    const data = Buffer.from(account.data);
    const delegator = new PublicKey(data.subarray(8, 40));
    const createdAt = Number(data.readBigInt64LE(CREATED_AT_OFFSET));
    const agentInfo = await connection.getAccountInfo(delegator, "confirmed");
    if (!agentInfo || !agentInfo.owner.equals(PROGRAM_ID)) {
      orphaned += 1;
      console.log(`  ORPHANED (delegator closed): ${pubkey.toBase58()} created_at=${createdAt}`);
      continue;
    }
    const registeredAt = agentRegisteredAt(Buffer.from(agentInfo.data));
    if (registeredAt === createdAt) {
      sameSecond += 1;
      console.log(`  SAME-SECOND: ${pubkey.toBase58()} delegator=${delegator.toBase58()} t=${createdAt}`);
    } else if (registeredAt > createdAt) {
      console.log(`  CLONE (registered_at > created_at): ${pubkey.toBase58()} delegator=${delegator.toBase58()} registered=${registeredAt} created=${createdAt}`);
    }
  }
  console.log(`same-second delegations: ${sameSecond}; orphaned (delegator closed): ${orphaned}`);

  if (sameSecond > 0) {
    console.error("\nPREFLIGHT FAIL: legacy same-second delegations exist — they become unrevocable under the strict identity check. Revoke them BEFORE deploying.");
    process.exit(1);
  }
  console.log("PREFLIGHT OK: no same-second delegations on-chain; the strict identity check is free to ship.");
}

main().catch((e) => {
  console.error(`scan failed: ${e?.message ?? e}`);
  process.exit(1);
});
