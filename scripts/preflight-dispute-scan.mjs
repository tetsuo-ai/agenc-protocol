#!/usr/bin/env node
// Audit F-12 preflight: scan the on-chain Dispute set for any account with
// total_voters > 0 — a pre-P6.3 (arbiter-vote-era) dispute. Those are
// unexitable on every path (dispute_helpers.rs validates total_voters == 0 and
// cancel_dispute requires 0), so any hit must be handled by an admin resolution
// path BEFORE a deploy that would touch the dispute lifecycle.
//
// Expected result on mainnet today: ZERO (disputes only ever existed on the
// post-P6.3 single-resolver surface; arbiter voting never shipped there).
//
// Usage:
//   RPC_URL=https://your-mainnet-rpc node scripts/preflight-dispute-scan.mjs
//   RPC_URL=http://127.0.0.1:8899 node scripts/preflight-dispute-scan.mjs
//
// Exit code 0 = no legacy disputes found. Exit 1 = legacy disputes found (or RPC
// failure) — inspect the printed accounts before deploying.

import { Connection, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";

const PROGRAM_ID = new PublicKey("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";

// Dispute account layout (state.rs): after the 8-byte discriminator:
// dispute_id[32] task[32] initiator[32] initiator_authority[32] evidence_hash[32]
// resolution_type(u8) status(u8) created_at(i64) resolved_at(i64) votes_for(u64)
// votes_against(u64) -> total_voters(u8) at offset 202.
const TOTAL_VOTERS_OFFSET = 202;

const discriminator = createHash("sha256").update("account:Dispute").digest().subarray(0, 8);

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  console.log(`Scanning Dispute accounts on ${RPC_URL.replace(/\/\/.*@/, "//***@")} (program ${PROGRAM_ID.toBase58()})`);

  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: discriminator.toString("base64"), encoding: "base64" } }],
    dataSlice: { offset: TOTAL_VOTERS_OFFSET, length: 1 },
  });

  let legacy = 0;
  for (const { pubkey, account } of accounts) {
    const totalVoters = account.data.length >= 1 ? account.data[0] : 0;
    if (totalVoters > 0) {
      legacy += 1;
      console.log(`LEGACY DISPUTE: ${pubkey.toBase58()} total_voters=${totalVoters}`);
    }
  }
  console.log(`Scanned ${accounts.length} Dispute account(s); total_voters > 0: ${legacy}`);

  if (legacy > 0) {
    console.error("\nPREFLIGHT FAIL: pre-P6.3 disputes exist and are unexitable on every path — resolve them via an admin path BEFORE deploying.");
    process.exit(1);
  }
  console.log("PREFLIGHT OK: no pre-P6.3 (arbiter-vote-era) disputes on-chain.");
}

main().catch((e) => {
  console.error(`scan failed: ${e?.message ?? e}`);
  process.exit(1);
});
