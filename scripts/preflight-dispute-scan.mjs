#!/usr/bin/env node
// Audit F-12 preflight: scan the on-chain Dispute set for two unexitable shapes:
//
// 1. total_voters > 0 — a pre-P6.3 (arbiter-vote-era) dispute. Those are
//    unexitable on every path (dispute_helpers.rs validates total_voters == 0
//    and cancel_dispute requires 0), so any hit must be handled by an admin
//    resolution path BEFORE a deploy that would touch the dispute lifecycle.
// 2. An ACTIVE dispute whose defendant claim PDA (["claim", task, defendant])
//    is closed/missing (audit swarm D12) — e.g. a dispute initiated against a
//    durable submission on a task whose claim was already closed. The
//    resolution paths all key on the claim, so this shape needs manual review
//    before any dispute-lifecycle deploy.
//
// Expected result on mainnet today: ZERO of both (disputes only ever existed
// on the post-P6.3 single-resolver surface; arbiter voting never shipped
// there, and the 2026-07-18 scan found no closed-claim shapes either).
//
// Usage:
//   RPC_URL=https://your-mainnet-rpc node scripts/preflight-dispute-scan.mjs
//   RPC_URL=http://127.0.0.1:8899 node scripts/preflight-dispute-scan.mjs
//
// Exit code 0 = no flagged disputes found. Exit 1 = flagged disputes (or RPC
// failure) — inspect the printed accounts before deploying.

import { Connection, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";

const PROGRAM_ID = new PublicKey("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";

// Dispute account layout (state.rs), after the 8-byte discriminator:
// dispute_id[32]@8 task[32]@40 initiator[32]@72 initiator_authority[32]@104
// evidence_hash[32]@136 resolution_type(u8)@168 status(u8)@169 created_at(i64)@170
// resolved_at(i64)@178 votes_for(u64)@186 votes_against(u64)@194 total_voters(u8)@202
// voting_deadline(i64)@203 expires_at(i64)@211 slash_applied(bool)@219
// initiator_slash_applied(bool)@220 worker_stake_at_dispute(u64)@221
// initiated_by_creator(bool)@229 bump(u8)@230 defendant[32]@231
const TASK_OFFSET = 40;
const STATUS_OFFSET = 169;
const TOTAL_VOTERS_OFFSET = 202;
const DEFENDANT_OFFSET = 231;
const MIN_DISPUTE_LEN = DEFENDANT_OFFSET + 32;
const STATUS_ACTIVE = 0;

const discriminator = createHash("sha256").update("account:Dispute").digest().subarray(0, 8);

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  console.log(`Scanning Dispute accounts on ${RPC_URL.replace(/\/\/.*@/, "//***@")} (program ${PROGRAM_ID.toBase58()})`);

  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: discriminator.toString("base64"), encoding: "base64" } }],
    dataSlice: { offset: 0, length: MIN_DISPUTE_LEN },
  });

  let legacy = 0;
  const activeDisputes = [];
  for (const { pubkey, account } of accounts) {
    const data = Buffer.from(account.data);
    if (data.length >= TOTAL_VOTERS_OFFSET + 1 && data[TOTAL_VOTERS_OFFSET] > 0) {
      legacy += 1;
      console.log(`LEGACY DISPUTE: ${pubkey.toBase58()} total_voters=${data[TOTAL_VOTERS_OFFSET]}`);
    }
    if (data.length >= MIN_DISPUTE_LEN && data[STATUS_OFFSET] === STATUS_ACTIVE) {
      activeDisputes.push({
        pubkey,
        task: new PublicKey(data.subarray(TASK_OFFSET, TASK_OFFSET + 32)),
        defendant: new PublicKey(data.subarray(DEFENDANT_OFFSET, DEFENDANT_OFFSET + 32)),
      });
    }
  }
  console.log(`Scanned ${accounts.length} Dispute account(s); total_voters > 0: ${legacy}`);

  // D12: for every ACTIVE dispute, the defendant claim PDA must exist — the
  // resolve/expire paths key on it. Batch-fetch and flag any that are missing.
  let closedClaim = 0;
  if (activeDisputes.length > 0) {
    const claimPdas = activeDisputes.map(({ task, defendant }) =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("claim"), task.toBuffer(), defendant.toBuffer()],
        PROGRAM_ID,
      )[0],
    );
    const claimAccounts = await connection.getMultipleAccountsInfo(claimPdas, "confirmed");
    claimAccounts.forEach((info, i) => {
      const closed = info === null || info.lamports === 0 || !info.owner.equals(PROGRAM_ID);
      if (closed) {
        closedClaim += 1;
        console.log(`CLOSED-CLAIM ACTIVE DISPUTE: ${activeDisputes[i].pubkey.toBase58()} claim=${claimPdas[i].toBase58()}`);
      }
    });
    console.log(`Active disputes: ${activeDisputes.length}; with a closed/missing defendant claim: ${closedClaim}`);
  }

  if (legacy > 0 || closedClaim > 0) {
    console.error("\nPREFLIGHT FAIL: unexitable dispute shape(s) found — resolve them via an admin path BEFORE deploying.");
    process.exit(1);
  }
  console.log("PREFLIGHT OK: no pre-P6.3 (arbiter-vote-era) or closed-claim active disputes on-chain.");
}

main().catch((e) => {
  console.error(`scan failed: ${e?.message ?? e}`);
  process.exit(1);
});
