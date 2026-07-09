// Shared litesvm integration-test harness for agenc-coordination.
// Extracted verbatim from marketplace.test.mjs (the original, battle-tested setup)
// so per-subsystem test files can reuse the same world, helpers, and constants.
// Executes the COMPILED program (target/deploy/agenc_coordination.so).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import anchorPkg from "@coral-xyz/anchor";
const { Program, AnchorProvider, BN, Wallet, BorshCoder } = anchorPkg;
import { Connection, Keypair, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(__dirname, "..");
export const SO = path.join(REPO, "programs/agenc-coordination/target/deploy/agenc_coordination.so");
export const IDL = JSON.parse(
  fs.readFileSync(path.join(REPO, "target/idl/agenc_coordination.json"), "utf8"),
);
export const PID = new PublicKey(IDL.address);
export const coder = new BorshCoder(IDL);

export const enc = (s) => Buffer.from(s, "utf8");
export const arr = (buf) => Array.from(buf);
export const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PID);
export const id32 = () => crypto.randomBytes(32);

export function makeProgram(payer) {
  const provider = new AnchorProvider(
    new Connection("http://127.0.0.1:9999"), // never hit — offline .instruction() only
    new Wallet(payer),
    { commitment: "processed" },
  );
  return new Program(IDL, provider);
}

export function send(svm, ix, signers) {
  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  return svm.sendTransaction(tx);
}

// Send several instructions in one transaction (used for SPL-token setup).
export function sendMany(svm, ixs, signers) {
  const tx = new Transaction().add(...ixs);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  return svm.sendTransaction(tx);
}

// Read an SPL token account's `amount` (u64 LE at offset 64). 0 if absent/closed.
export function tokenAmount(svm, ata) {
  const acct = svm.getAccount(ata);
  if (!acct || acct.data.length < 72) return 0n;
  return Buffer.from(acct.data).readBigUInt64LE(64);
}

export function expectOk(res, label) {
  if (res instanceof FailedTransactionMetadata) {
    throw new Error(`${label} unexpectedly FAILED: ${res.err()}\n${res.meta().logs().join("\n")}`);
  }
  return res;
}

export function expectFail(res, codeName, label) {
  assert.ok(
    res instanceof FailedTransactionMetadata,
    `${label} should have failed with ${codeName} but succeeded`,
  );
  const logs = res.meta().logs().join("\n");
  assert.ok(
    logs.includes(codeName),
    `${label} should fail with ${codeName}; logs were:\n${logs}`,
  );
}

export function decode(svm, name, address) {
  const acct = svm.getAccount(address);
  if (!acct) return null;
  return coder.accounts.decode(name, Buffer.from(acct.data));
}

// litesvm represents a closed account as zero-lamport/empty-data (not null).
export function isClosed(svm, address) {
  const acct = svm.getAccount(address);
  return !acct || Number(acct.lamports) === 0 || acct.data.length === 0;
}

export function injectProtocolConfig(svm, admin) {
  const [protocolPda, bump] = pda([enc("protocol")]);
  // NOTE: this IDL preserves snake_case field names and anchor's BorshCoder uses
  // them verbatim (no camelCasing), so account-data keys MUST be snake_case.
  const cfg = {
    authority: admin.publicKey,
    treasury: admin.publicKey,
    dispute_threshold: 50,
    protocol_fee_bps: 100,
    min_arbiter_stake: new BN(0),
    min_agent_stake: new BN(0),
    max_claim_duration: new BN(604800),
    max_dispute_duration: new BN(604800),
    total_agents: new BN(0),
    total_tasks: new BN(0),
    completed_tasks: new BN(0),
    total_value_distributed: new BN(0),
    bump,
    multisig_threshold: 0,
    multisig_owners_len: 0,
    task_creation_cooldown: new BN(0), // disable rate limit for tests
    max_tasks_per_24h: 0,
    dispute_initiation_cooldown: new BN(0),
    max_disputes_per_24h: 0,
    min_stake_for_dispute: new BN(0),
    slash_percentage: 50,
    state_update_cooldown: new BN(0),
    voting_period: new BN(86400),
    protocol_version: 1,
    min_supported_version: 1,
    protocol_paused: false,
    disabled_task_type_mask: 0,
    multisig_owners: Array(5).fill(PublicKey.default),
    // P6.5: a fresh full-surface deploy advertises the full surface (1). The
    // migrate_protocol realloc test below builds a legacy (pre-surface_revision)
    // buffer explicitly, so this default only affects already-migrated configs.
    surface_revision: 1,
  };
  return coder.accounts
    .encode("ProtocolConfig", cfg)
    .then((data) => {
      svm.setAccount(protocolPda, {
        lamports: Number(svm.minimumBalanceForRentExemption(BigInt(data.length))),
        data,
        owner: PID,
        executable: false,
        rentEpoch: 0,
      });
      return protocolPda;
    });
}

/// Flip `protocol_paused` on the live ProtocolConfig in place. Decodes the
/// existing account, mutates only the one flag, and re-encodes — so counters and
/// every other field are preserved (unlike a full re-inject).
export async function setProtocolPaused(svm, paused) {
  const [protocolPda] = pda([enc("protocol")]);
  const acct = svm.getAccount(protocolPda);
  if (!acct) throw new Error("ProtocolConfig not present — call injectProtocolConfig first");
  const cfg = coder.accounts.decode("ProtocolConfig", Buffer.from(acct.data));
  cfg.protocol_paused = paused;
  const data = await coder.accounts.encode("ProtocolConfig", cfg);
  svm.setAccount(protocolPda, {
    lamports: Number(acct.lamports),
    data,
    owner: PID,
    executable: false,
    rentEpoch: 0,
  });
}

/// Read `surface_revision` off the live ProtocolConfig (P6.5). Returns the raw u16.
export function getSurfaceRevision(svm) {
  const [protocolPda] = pda([enc("protocol")]);
  const acct = svm.getAccount(protocolPda);
  if (!acct) throw new Error("ProtocolConfig not present — call injectProtocolConfig first");
  const cfg = coder.accounts.decode("ProtocolConfig", Buffer.from(acct.data));
  return cfg.surface_revision;
}

/// Set `surface_revision` on the live ProtocolConfig in place (batch 4: goods
/// require >= 4). Mutates only the one field (mirrors the on-chain
/// all-three-field `update_launch_controls` write — the ceremony must re-pass
/// paused+mask; here we preserve them by decoding first).
export async function setSurfaceRevision(svm, revision) {
  const [protocolPda] = pda([enc("protocol")]);
  const acct = svm.getAccount(protocolPda);
  if (!acct) throw new Error("ProtocolConfig not present — call injectProtocolConfig first");
  const cfg = coder.accounts.decode("ProtocolConfig", Buffer.from(acct.data));
  cfg.surface_revision = revision;
  const data = await coder.accounts.encode("ProtocolConfig", cfg);
  svm.setAccount(protocolPda, { lamports: Number(acct.lamports), data, owner: PID, executable: false, rentEpoch: 0 });
}

/// Set `protocol_fee_bps` on the live ProtocolConfig in place.
export async function setProtocolFeeBps(svm, bps) {
  const [protocolPda] = pda([enc("protocol")]);
  const acct = svm.getAccount(protocolPda);
  if (!acct) throw new Error("ProtocolConfig not present — call injectProtocolConfig first");
  const cfg = coder.accounts.decode("ProtocolConfig", Buffer.from(acct.data));
  cfg.protocol_fee_bps = bps;
  const data = await coder.accounts.encode("ProtocolConfig", cfg);
  svm.setAccount(protocolPda, { lamports: Number(acct.lamports), data, owner: PID, executable: false, rentEpoch: 0 });
}

/// Set min_arbiter_stake on the live ProtocolConfig (so arbiter votes carry weight).
export async function setMinArbiterStake(svm, amount) {
  const [protocolPda] = pda([enc("protocol")]);
  const acct = svm.getAccount(protocolPda);
  const cfg = coder.accounts.decode("ProtocolConfig", Buffer.from(acct.data));
  cfg.min_arbiter_stake = new BN(amount);
  const data = await coder.accounts.encode("ProtocolConfig", cfg);
  svm.setAccount(protocolPda, { lamports: Number(acct.lamports), data, owner: PID, executable: false, rentEpoch: 0 });
}

/// Set an AgentRegistration's `stake` in place (no real staking instruction needed
/// for tests). Used to give arbiters vote weight and the worker a slashable stake.
export async function injectAgentStake(svm, agentPda, stake) {
  const acct = svm.getAccount(agentPda);
  const agent = coder.accounts.decode("AgentRegistration", Buffer.from(acct.data));
  agent.stake = new BN(stake);
  const data = await coder.accounts.encode("AgentRegistration", agent);
  svm.setAccount(agentPda, { lamports: Number(acct.lamports), data, owner: PID, executable: false, rentEpoch: 0 });
}

/// Configure the on-chain multisig in place (owners + threshold) so multisig-gated
/// instructions (migrate_task, migrate_protocol) can be exercised. Owners must sign
/// the tx AND be passed as remaining_accounts.
export async function setMultisig(svm, owners, threshold) {
  const [protocolPda] = pda([enc("protocol")]);
  const acct = svm.getAccount(protocolPda);
  const cfg = coder.accounts.decode("ProtocolConfig", Buffer.from(acct.data));
  const slots = Array(5).fill(PublicKey.default);
  owners.forEach((o, i) => { slots[i] = o; });
  cfg.multisig_owners = slots;
  cfg.multisig_owners_len = owners.length;
  cfg.multisig_threshold = threshold;
  const data = await coder.accounts.encode("ProtocolConfig", cfg);
  svm.setAccount(protocolPda, { lamports: Number(acct.lamports), data, owner: PID, executable: false, rentEpoch: 0 });
}

/// Inject a ModerationConfig at ["moderation_config"]. enabled=false keeps Model-A.
export async function injectModerationConfig(svm, admin, modAuth, enabled) {
  const [pdaKey, bump] = pda([enc("moderation_config")]);
  const cfg = {
    authority: admin.publicKey,
    moderation_authority: modAuth.publicKey,
    enabled,
    created_at: new BN(0),
    updated_at: new BN(0),
    bump,
    _reserved: Array(6).fill(0),
  };
  const data = await coder.accounts.encode("ModerationConfig", cfg);
  svm.setAccount(pdaKey, {
    lamports: Number(svm.minimumBalanceForRentExemption(BigInt(data.length))),
    data,
    owner: PID,
    executable: false,
    rentEpoch: 0,
  });
  return pdaKey;
}

/// Inject a BidMarketplaceConfig at ["bid_marketplace"]. The real initializer is
/// multisig-gated (owners>=2/threshold>=2); injecting it directly lets the bid
/// harness exercise create_bid / accept_bid without standing up a full multisig.
export async function injectBidMarketplace(svm, admin, { minBond = 100_000 } = {}) {
  const [pdaKey, bump] = pda([enc("bid_marketplace")]);
  const cfg = {
    authority: admin.publicKey,
    min_bid_bond_lamports: new BN(minBond),
    bid_creation_cooldown_secs: new BN(0),
    max_bids_per_24h: 100,
    max_active_bids_per_task: 10,
    max_bid_lifetime_secs: new BN(86400),
    accepted_no_show_slash_bps: 0,
    bump,
  };
  const data = await coder.accounts.encode("BidMarketplaceConfig", cfg);
  svm.setAccount(pdaKey, {
    lamports: Number(svm.minimumBalanceForRentExemption(BigInt(data.length))),
    data,
    owner: PID,
    executable: false,
    rentEpoch: 0,
  });
  return pdaKey;
}

/// Build a fully wired world ready to hire: protocol + moderation config + agents + listing.
export async function freshWorld({ price = 1_000_000, maxOpenJobs = 0, capabilities = 1, moderationEnabled = false, operator = null, operatorFeeBps = 0 } = {}) {
  const svm = new LiteSVM();
  svm.addProgramFromFile(PID, SO);

  // litesvm's clock starts at unixTimestamp 0, which makes claim.claimed_at 0 —
  // submit_task_result requires claimed_at > 0. Advance to a realistic timestamp.
  const clock = svm.getClock();
  clock.unixTimestamp = 1_700_000_000n;
  svm.setClock(clock);

  const admin = Keypair.generate();
  const provider = Keypair.generate();
  const buyer = Keypair.generate();
  const modAuth = Keypair.generate();
  for (const kp of [admin, provider, buyer, modAuth]) svm.airdrop(kp.publicKey, BigInt(100e9));
  // Sentinel: set the listing operator to the buyer (who hires) to exercise the
  // §4 operator!=creator self-deal guard.
  if (operator === "__buyer__") operator = buyer.publicKey;
  // Pre-fund the operator payee so it is rent-exempt before receiving its fee leg.
  if (operator) svm.airdrop(operator, BigInt(1e9));

  const protocolPda = await injectProtocolConfig(svm, admin);
  const modCfg = await injectModerationConfig(svm, admin, modAuth, moderationEnabled);

  // Register provider + buyer agents (real instruction).
  const providerProg = makeProgram(provider);
  const buyerProg = makeProgram(buyer);

  const providerAgentId = id32();
  const [providerAgent] = pda([enc("agent"), providerAgentId]);
  expectOk(
    send(
      svm,
      await providerProg.methods
        .registerAgent(arr(providerAgentId), new BN(capabilities), "http://provider.test", null, new BN(0))
        .accounts({ agent: providerAgent, protocolConfig: protocolPda, authority: provider.publicKey, systemProgram: SystemProgram.programId })
        .instruction(),
      [provider],
    ),
    "register provider agent",
  );

  const buyerAgentId = id32();
  const [buyerAgent] = pda([enc("agent"), buyerAgentId]);
  expectOk(
    send(
      svm,
      await buyerProg.methods
        .registerAgent(arr(buyerAgentId), new BN(capabilities), "http://buyer.test", null, new BN(0))
        .accounts({ agent: buyerAgent, protocolConfig: protocolPda, authority: buyer.publicKey, systemProgram: SystemProgram.programId })
        .instruction(),
      [buyer],
    ),
    "register buyer agent",
  );

  // Create the service listing (real instruction), signed by the provider.
  const listingId = id32();
  const [listing] = pda([enc("service_listing"), providerAgent.toBuffer(), Buffer.from(listingId)]);
  const specHash = id32(); // non-zero
  expectOk(
    send(
      svm,
      await providerProg.methods
        .createServiceListing(
          arr(listingId),
          arr(Buffer.alloc(32, 1)), // name
          arr(Buffer.alloc(32, 2)), // category
          arr(Buffer.alloc(64, 3)), // tags
          arr(specHash),
          "agenc://job-spec/sha256/test",
          new BN(price),
          null, // price_mint = SOL
          new BN(capabilities),
          new BN(3600), // default_deadline_secs
          maxOpenJobs,
          operator, // operator payee (Pubkey or null)
          operatorFeeBps,
        )
        .accounts({ listing, providerAgent, protocolConfig: protocolPda, authority: provider.publicKey, systemProgram: SystemProgram.programId })
        .instruction(),
      [provider],
    ),
    "create listing",
  );

  return { svm, admin, provider, buyer, modAuth, buyerProg, providerProg, protocolPda, modCfg, providerAgent, buyerAgent, listing, listingId, price, specHash, operator, operatorFeeBps };
}

// ---------------------------------------------------------------------------
// P1.2 open-roster helpers
// ---------------------------------------------------------------------------

/// v2 MODERATOR-KEYED task-moderation PDA (P1.2 §4.3) — post-upgrade records live here.
export function taskModV2Pda(task, jobHash, moderator) {
  return pda([enc("task_moderation_v2"), task.toBuffer(), Buffer.from(jobHash), moderator.toBuffer()]);
}

/// v2 MODERATOR-KEYED listing-moderation PDA (the listing mirror).
export function listingModV2Pda(listing, specHash, moderator) {
  return pda([enc("listing_moderation_v2"), listing.toBuffer(), Buffer.from(specHash), moderator.toBuffer()]);
}

/// Content-hash-keyed BLOCK-floor PDA (P1.2 §5.2) — required on all three gates.
export function moderationBlockPda(contentHash) {
  return pda([enc("moderation_block"), Buffer.from(contentHash)]);
}

/// Build (but don't send) a hire_from_listing instruction for `buyer`.
/// P6.2: pass `referrer` (PublicKey) + `referrerFeeBps` to attach the demand-side
/// referral leg; both default to no-leg (null / 0).
/// P1.2: `moderator` names the attestor whose record the hire consumes (defaults to
/// the world's global moderation authority); the required `moderationBlock` floor
/// account is derived from the listing's pinned spec hash.
export async function hireIx(w, { taskId, expectedPrice, expectedVersion, asProvider = false, listingModeration = null, moderationAttestor = null, referrer = null, referrerFeeBps = 0, moderator = null } = {}) {
  const signer = asProvider ? w.provider : w.buyer;
  const agent = asProvider ? w.providerAgent : w.buyerAgent;
  const prog = asProvider ? w.providerProg : w.buyerProg;
  const tid = taskId ?? id32();
  const [task] = pda([enc("task"), signer.publicKey.toBuffer(), Buffer.from(tid)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [hireRecord] = pda([enc("hire"), task.toBuffer()]);
  const [authorityRateLimit] = pda([enc("authority_rate_limit"), signer.publicKey.toBuffer()]);
  const [moderationBlock] = moderationBlockPda(w.specHash);
  const ix = await prog.methods
    .hireFromListing(arr(tid), new BN(expectedPrice ?? w.price), new BN(expectedVersion ?? 1), referrer, referrerFeeBps, moderator ?? w.modAuth.publicKey)
    .accounts({
      task, escrow, hireRecord, listing: w.listing, protocolConfig: w.protocolPda,
      moderationConfig: w.modCfg, listingModeration, moderationAttestor, moderationBlock,
      creatorAgent: agent, authorityRateLimit, authority: signer.publicKey,
      creator: signer.publicKey, systemProgram: SystemProgram.programId,
    })
    .instruction();
  return { ix, signer, task, escrow, hireRecord };
}


// Re-export commonly used externals so test files can import them from one place.
export {
  Program, AnchorProvider, BN, Wallet, BorshCoder,
  LiteSVM, FailedTransactionMetadata,
  Connection, Keypair, PublicKey, Transaction, SystemProgram,
  MINT_SIZE, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  createInitializeMintInstruction, createAssociatedTokenAccountInstruction,
  createMintToInstruction, getAssociatedTokenAddressSync,
};
