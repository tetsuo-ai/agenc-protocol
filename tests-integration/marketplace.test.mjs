// In-process litesvm integration tests for the embeddable-marketplace instructions.
// Executes the COMPILED program (target/deploy/agenc_coordination.so) end-to-end:
// hire_from_listing -> cancel_task -> close_task, plus capacity + negative cases.
//
// Setup uses the real register_agent + create_service_listing instructions; only
// ProtocolConfig is injected directly (its real initializer requires an upgradeable
// ProgramData account that litesvm doesn't model).
//
// Run:  cd tests-integration && node --test
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
const REPO = path.resolve(__dirname, "..");
const SO = path.join(REPO, "programs/agenc-coordination/target/deploy/agenc_coordination.so");
const IDL = JSON.parse(
  fs.readFileSync(path.join(REPO, "target/idl/agenc_coordination.json"), "utf8"),
);
const PID = new PublicKey(IDL.address);
const coder = new BorshCoder(IDL);

const enc = (s) => Buffer.from(s, "utf8");
const arr = (buf) => Array.from(buf);
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PID);
const id32 = () => crypto.randomBytes(32);

function makeProgram(payer) {
  const provider = new AnchorProvider(
    new Connection("http://127.0.0.1:9999"), // never hit — offline .instruction() only
    new Wallet(payer),
    { commitment: "processed" },
  );
  return new Program(IDL, provider);
}

function send(svm, ix, signers) {
  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  return svm.sendTransaction(tx);
}

// Send several instructions in one transaction (used for SPL-token setup).
function sendMany(svm, ixs, signers) {
  const tx = new Transaction().add(...ixs);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  return svm.sendTransaction(tx);
}

// Read an SPL token account's `amount` (u64 LE at offset 64). 0 if absent/closed.
function tokenAmount(svm, ata) {
  const acct = svm.getAccount(ata);
  if (!acct || acct.data.length < 72) return 0n;
  return Buffer.from(acct.data).readBigUInt64LE(64);
}

function expectOk(res, label) {
  if (res instanceof FailedTransactionMetadata) {
    throw new Error(`${label} unexpectedly FAILED: ${res.err()}\n${res.meta().logs().join("\n")}`);
  }
  return res;
}

function expectFail(res, codeName, label) {
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

function decode(svm, name, address) {
  const acct = svm.getAccount(address);
  if (!acct) return null;
  return coder.accounts.decode(name, Buffer.from(acct.data));
}

// litesvm represents a closed account as zero-lamport/empty-data (not null).
function isClosed(svm, address) {
  const acct = svm.getAccount(address);
  return !acct || Number(acct.lamports) === 0 || acct.data.length === 0;
}

function injectProtocolConfig(svm, admin) {
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
async function setProtocolPaused(svm, paused) {
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

/// Set min_arbiter_stake on the live ProtocolConfig (so arbiter votes carry weight).
async function setMinArbiterStake(svm, amount) {
  const [protocolPda] = pda([enc("protocol")]);
  const acct = svm.getAccount(protocolPda);
  const cfg = coder.accounts.decode("ProtocolConfig", Buffer.from(acct.data));
  cfg.min_arbiter_stake = new BN(amount);
  const data = await coder.accounts.encode("ProtocolConfig", cfg);
  svm.setAccount(protocolPda, { lamports: Number(acct.lamports), data, owner: PID, executable: false, rentEpoch: 0 });
}

/// Set an AgentRegistration's `stake` in place (no real staking instruction needed
/// for tests). Used to give arbiters vote weight and the worker a slashable stake.
async function injectAgentStake(svm, agentPda, stake) {
  const acct = svm.getAccount(agentPda);
  const agent = coder.accounts.decode("AgentRegistration", Buffer.from(acct.data));
  agent.stake = new BN(stake);
  const data = await coder.accounts.encode("AgentRegistration", agent);
  svm.setAccount(agentPda, { lamports: Number(acct.lamports), data, owner: PID, executable: false, rentEpoch: 0 });
}

/// Configure the on-chain multisig in place (owners + threshold) so multisig-gated
/// instructions (migrate_task, migrate_protocol) can be exercised. Owners must sign
/// the tx AND be passed as remaining_accounts.
async function setMultisig(svm, owners, threshold) {
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
async function injectModerationConfig(svm, admin, modAuth, enabled) {
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
async function injectBidMarketplace(svm, admin, { minBond = 100_000 } = {}) {
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
async function freshWorld({ price = 1_000_000, maxOpenJobs = 0, capabilities = 1, moderationEnabled = false, operator = null, operatorFeeBps = 0 } = {}) {
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

/// Build (but don't send) a hire_from_listing instruction for `buyer`.
async function hireIx(w, { taskId, expectedPrice, expectedVersion, asProvider = false, listingModeration = null } = {}) {
  const signer = asProvider ? w.provider : w.buyer;
  const agent = asProvider ? w.providerAgent : w.buyerAgent;
  const prog = asProvider ? w.providerProg : w.buyerProg;
  const tid = taskId ?? id32();
  const [task] = pda([enc("task"), signer.publicKey.toBuffer(), Buffer.from(tid)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [hireRecord] = pda([enc("hire"), task.toBuffer()]);
  const [authorityRateLimit] = pda([enc("authority_rate_limit"), signer.publicKey.toBuffer()]);
  const ix = await prog.methods
    .hireFromListing(arr(tid), new BN(expectedPrice ?? w.price), new BN(expectedVersion ?? 1))
    .accounts({
      task, escrow, hireRecord, listing: w.listing, protocolConfig: w.protocolPda,
      moderationConfig: w.modCfg, listingModeration,
      creatorAgent: agent, authorityRateLimit, authority: signer.publicKey,
      creator: signer.publicKey, systemProgram: SystemProgram.programId,
    })
    .instruction();
  return { ix, signer, task, escrow, hireRecord };
}

test("hire_from_listing: mints task + escrow + hire record, increments capacity", async () => {
  const w = await freshWorld({ price: 2_000_000 });
  const { ix, task, escrow, hireRecord } = await hireIx(w, {});
  expectOk(send(w.svm, ix, [w.buyer]), "hire");

  const t = decode(w.svm, "Task", task);
  assert.equal(t.creator.toBase58(), w.buyer.publicKey.toBase58(), "task.creator == buyer");
  assert.equal(t.reward_amount.toString(), "2000000", "reward snapshotted from listing price");
  assert.equal(t.max_workers, 1, "one-shot exclusive");
  assert.ok(t.status.Open !== undefined, "task starts Open");
  assert.equal(t.escrow.toBase58(), escrow.toBase58(), "task.escrow wired");

  const e = decode(w.svm, "TaskEscrow", escrow);
  assert.equal(e.amount.toString(), "2000000", "escrow.amount == price");
  assert.equal(e.is_closed, false);
  assert.ok(w.svm.getBalance(escrow) >= 2_000_000n, "escrow funded with >= price lamports");

  const h = decode(w.svm, "HireRecord", hireRecord);
  assert.equal(h.task.toBase58(), task.toBase58());
  assert.equal(h.listing.toBase58(), w.listing.toBase58());

  const l = decode(w.svm, "ServiceListing", w.listing);
  assert.equal(l.open_jobs, 1, "open_jobs incremented");
  assert.equal(l.total_hires.toString(), "1", "total_hires incremented");
});

test("hire -> cancel -> close: frees capacity, closes task + hire record", async () => {
  const w = await freshWorld({ price: 1_500_000 });
  const { ix, task, escrow, hireRecord } = await hireIx(w, {});
  expectOk(send(w.svm, ix, [w.buyer]), "hire");
  assert.equal(decode(w.svm, "ServiceListing", w.listing).open_jobs, 1);

  // Cancel the Open task (allowed immediately for Open).
  const cancelIx = await w.buyerProg.methods
    .cancelTask()
    .accounts({
      task, escrow, authority: w.buyer.publicKey, protocolConfig: w.protocolPda,
      systemProgram: SystemProgram.programId,
      // optional SPL-token accounts (default build has spl-token-rewards) — None for SOL
      tokenEscrowAta: null, creatorTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: null, workerCompletionBond: null, workerBondAuthority: null,
    })
    .instruction();
  expectOk(send(w.svm, cancelIx, [w.buyer]), "cancel");
  assert.ok(decode(w.svm, "Task", task).status.Cancelled !== undefined, "task is Cancelled");
  assert.ok(isClosed(w.svm, escrow), "escrow closed by cancel_task");

  // Close the terminal task: reclaim rent + free the listing slot.
  const closeIx = await w.buyerProg.methods
    .closeTask()
    .accounts({ task, taskJobSpec: null, escrow: null, hireRecord, listing: w.listing, authority: w.buyer.publicKey })
    .instruction();
  expectOk(send(w.svm, closeIx, [w.buyer]), "close");

  assert.ok(isClosed(w.svm, task), "task PDA closed");
  assert.ok(isClosed(w.svm, hireRecord), "hire record closed");
  assert.equal(decode(w.svm, "ServiceListing", w.listing).open_jobs, 0, "open_jobs decremented back to 0");
});

test("capacity: hire is rejected when max_open_jobs is reached", async () => {
  const w = await freshWorld({ maxOpenJobs: 1 });
  const first = await hireIx(w, {});
  expectOk(send(w.svm, first.ix, [w.buyer]), "first hire");
  assert.equal(decode(w.svm, "ServiceListing", w.listing).open_jobs, 1);

  const second = await hireIx(w, {}); // different task id
  expectFail(send(w.svm, second.ix, [w.buyer]), "ListingCapacityReached", "second hire over capacity");
});

test("negative: self-hire, price mismatch, and version mismatch are rejected", async () => {
  const w = await freshWorld({ price: 1_000_000 });

  // self-hire: provider hires its own listing (buyer authority == provider authority)
  const self = await hireIx(w, { asProvider: true });
  expectFail(send(w.svm, self.ix, [w.provider]), "SelfTaskNotAllowed", "self-hire");

  // price mismatch (compare-and-swap)
  const badPrice = await hireIx(w, { expectedPrice: 999_999 });
  expectFail(send(w.svm, badPrice.ix, [w.buyer]), "ListingPriceMismatch", "price mismatch");

  // version mismatch (compare-and-swap)
  const badVer = await hireIx(w, { expectedVersion: 2 });
  expectFail(send(w.svm, badVer.ix, [w.buyer]), "ListingVersionMismatch", "version mismatch");
});

test("record_listing_moderation: authority records CLEAN; non-authority rejected", async () => {
  const w = await freshWorld({});
  const modAuth = Keypair.generate();
  w.svm.airdrop(modAuth.publicKey, BigInt(10e9));

  // Inject an enabled ModerationConfig whose authority is modAuth.
  const [modCfg, modBump] = pda([enc("moderation_config")]);
  const cfg = {
    authority: w.admin.publicKey,
    moderation_authority: modAuth.publicKey,
    enabled: true,
    created_at: new BN(0),
    updated_at: new BN(0),
    bump: modBump,
    _reserved: Array(6).fill(0),
  };
  const data = await coder.accounts.encode("ModerationConfig", cfg);
  w.svm.setAccount(modCfg, {
    lamports: Number(w.svm.minimumBalanceForRentExemption(BigInt(data.length))),
    data,
    owner: PID,
    executable: false,
    rentEpoch: 0,
  });

  const [listingMod] = pda([enc("listing_moderation"), w.listing.toBuffer(), Buffer.from(w.specHash)]);
  const recordArgs = (prog, who) =>
    prog.methods
      .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
      .accounts({ moderationConfig: modCfg, listing: w.listing, listingModeration: listingMod, moderator: who, systemProgram: SystemProgram.programId })
      .instruction();

  // Authority records a CLEAN attestation.
  const modProg = makeProgram(modAuth);
  expectOk(send(w.svm, await recordArgs(modProg, modAuth.publicKey), [modAuth]), "record listing moderation");

  const lm = decode(w.svm, "ListingModeration", listingMod);
  assert.equal(lm.listing.toBase58(), w.listing.toBase58());
  assert.equal(lm.status, 0, "status CLEAN");
  assert.equal(
    Buffer.from(lm.job_spec_hash).toString("hex"),
    Buffer.from(w.specHash).toString("hex"),
    "job_spec_hash matches the listing's pinned spec",
  );
  assert.equal(lm.moderator.toBase58(), modAuth.publicKey.toBase58());

  // A non-authority (the buyer) cannot record.
  expectFail(
    send(w.svm, await recordArgs(w.buyerProg, w.buyer.publicKey), [w.buyer]),
    "UnauthorizedTaskModerator",
    "non-authority record",
  );
});

test("hire moderation gate: enabled requires a publishable listing attestation", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const [listingMod] = pda([enc("listing_moderation"), w.listing.toBuffer(), Buffer.from(w.specHash)]);
  const record = async (status, risk, expiresAt) => {
    const modProg = makeProgram(w.modAuth);
    return send(
      w.svm,
      await modProg.methods
        .recordListingModeration(arr(w.specHash), status, risk, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(expiresAt))
        .accounts({ moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod, moderator: w.modAuth.publicKey, systemProgram: SystemProgram.programId })
        .instruction(),
      [w.modAuth],
    );
  };

  // enabled + no attestation supplied → fail-closed
  expectFail(send(w.svm, (await hireIx(w, {})).ix, [w.buyer]), "TaskModerationRequired", "hire with no attestation");

  // record a CLEAN attestation → hire succeeds and occupies a slot
  expectOk(await record(0, 0, 0), "record CLEAN");
  expectOk(send(w.svm, (await hireIx(w, { listingModeration: listingMod })).ix, [w.buyer]), "hire with CLEAN attestation");
  assert.equal(decode(w.svm, "ServiceListing", w.listing).open_jobs, 1);
});

test("hire moderation gate: a BLOCKED attestation is rejected", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const [listingMod] = pda([enc("listing_moderation"), w.listing.toBuffer(), Buffer.from(w.specHash)]);
  const modProg = makeProgram(w.modAuth);
  expectOk(
    send(
      w.svm,
      await modProg.methods
        .recordListingModeration(arr(w.specHash), 2 /* BLOCKED */, 80, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
        .accounts({ moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod, moderator: w.modAuth.publicKey, systemProgram: SystemProgram.programId })
        .instruction(),
      [w.modAuth],
    ),
    "record BLOCKED",
  );
  expectFail(send(w.svm, (await hireIx(w, { listingModeration: listingMod })).ix, [w.buyer]), "TaskModerationRejected", "hire with BLOCKED attestation");
});

// Record a listing-moderation attestation with explicit fields, returning the result.
async function recordListingMod(w, { status = 0, risk = 0, expiresAt = 0 } = {}) {
  const [listingMod] = pda([enc("listing_moderation"), w.listing.toBuffer(), Buffer.from(w.specHash)]);
  const res = send(w.svm, await makeProgram(w.modAuth).methods
    .recordListingModeration(arr(w.specHash), status, risk, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(expiresAt))
    .accounts({ moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod, moderator: w.modAuth.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]);
  return { res, listingMod };
}

test("moderation edges (hire): publishable set is exactly CLEAN + HUMAN_APPROVED", async () => {
  // status -> whether a hire against that attestation is allowed.
  const cases = [
    { status: 1, name: "SUSPICIOUS", ok: false },
    { status: 3, name: "SCANNER_UNAVAILABLE", ok: false },
    { status: 5, name: "HUMAN_REJECTED", ok: false },
    { status: 4, name: "HUMAN_APPROVED", ok: true },
  ];
  for (const c of cases) {
    const w = await freshWorld({ moderationEnabled: true });
    const { res, listingMod } = await recordListingMod(w, { status: c.status });
    expectOk(res, `record ${c.name}`);
    const hire = send(w.svm, (await hireIx(w, { listingModeration: listingMod })).ix, [w.buyer]);
    if (c.ok) expectOk(hire, `hire with ${c.name} (publishable)`);
    else expectFail(hire, "TaskModerationRejected", `hire with ${c.name} (not publishable)`);
  }
});

test("moderation edges (hire): risk-score cap is enforced at the boundary", async () => {
  // risk_score 100 is the max allowed (CLEAN); 101 is rejected at record time.
  const wOk = await freshWorld({ moderationEnabled: true });
  const ok = await recordListingMod(wOk, { status: 0, risk: 100 });
  expectOk(ok.res, "record CLEAN risk=100");
  expectOk(send(wOk.svm, (await hireIx(wOk, { listingModeration: ok.listingMod })).ix, [wOk.buyer]), "hire with risk=100");

  const wBad = await freshWorld({ moderationEnabled: true });
  expectFail((await recordListingMod(wBad, { status: 0, risk: 101 })).res, "InvalidTaskModerationRiskScore", "record risk=101");
});

test("moderation edges (record): disabled config, invalid status, and past expiry are rejected", async () => {
  // moderation disabled -> recording is rejected (fail-closed semantics).
  const wOff = await freshWorld({ moderationEnabled: false });
  expectFail((await recordListingMod(wOff, { status: 0 })).res, "TaskModerationRequired", "record while moderation disabled");

  // invalid status code (not 0..5) -> rejected.
  const wStatus = await freshWorld({ moderationEnabled: true });
  expectFail((await recordListingMod(wStatus, { status: 6 })).res, "InvalidTaskModerationStatus", "record invalid status=6");

  // already-expired attestation (expires_at in the past) -> rejected at record time.
  const wExp = await freshWorld({ moderationEnabled: true });
  const past = Number(wExp.svm.getClock().unixTimestamp) - 100;
  expectFail((await recordListingMod(wExp, { status: 0, expiresAt: past })).res, "TaskModerationExpired", "record past-expiry attestation");
});

test("moderation edges (set_task_job_spec): a non-publishable task moderation cannot be published", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const m = await setupManualTask(w, { mode: 1 }); // a plain Open task to publish against
  const jobHash = id32();
  const [taskMod] = pda([enc("task_moderation"), m.task.toBuffer(), Buffer.from(jobHash)]);
  const [jobSpec] = pda([enc("task_job_spec"), m.task.toBuffer()]);
  // record a BLOCKED task moderation, then try to publish the job spec.
  expectOk(send(w.svm, await makeProgram(w.modAuth).methods
    .recordTaskModeration(arr(jobHash), 2 /* BLOCKED */, 90, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task: m.task, taskModeration: taskMod, moderator: w.modAuth.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "record BLOCKED task moderation");
  expectFail(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/blocked")
    .accounts({ protocolConfig: w.protocolPda, task: m.task, moderationConfig: w.modCfg, taskModeration: taskMod, taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "TaskModerationRejected", "publish against BLOCKED moderation");
  assert.ok(isClosed(w.svm, jobSpec), "no TaskJobSpec created when the gate fails");
});

/// Drive a task through the Auto settlement path (worker completes + is paid via
/// execute_completion_rewards — where bonds + the 3-way split live). Requires a
/// moderation-enabled world (set_task_job_spec is moderation-gated). The freshWorld
/// buyer (agent) is the creator; the provider agent is the worker. Returns handles.
async function runAutoSettlement(w, { pauseBeforeComplete = false } = {}) {
  const taskId = id32();
  const jobHash = id32();
  const reward = 5_000_000;
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const [taskMod] = pda([enc("task_moderation"), task.toBuffer(), Buffer.from(jobHash)]);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  const modProg = makeProgram(w.modAuth);

  // 1) create_task (buyer + buyerAgent), Auto mode (constraint_hash = None)
  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(reward), 1, new BN(now + 3600), 0, null, 0, null)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "settle:create_task");

  // 2) moderator records CLEAN for (task, jobHash)
  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "settle:moderate");

  // 3) creator publishes the job spec (moderation-gated)
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/x")
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "settle:publish");

  // 4) worker (provider agent) claims the published task
  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "settle:claim");

  // Optionally pause the protocol AFTER the claim. Entry paths are now blocked,
  // but settlement must still succeed (exit allow-list, spec §7) so the worker
  // is paid for completed work rather than losing it to a later expiry.
  if (pauseBeforeComplete) await setProtocolPaused(w.svm, true);

  // 5) worker completes -> payout via execute_completion_rewards. hire_record is a
  //    REQUIRED account; an Auto (non-hired) task passes the empty ["hire", task] PDA.
  const [autoHire] = pda([enc("hire"), task.toBuffer()]);
  const workerBalBefore = Number(w.svm.getBalance(w.provider.publicKey));
  const treasuryBalBefore = Number(w.svm.getBalance(w.admin.publicKey));
  expectOk(send(w.svm, await w.providerProg.methods
    .completeTask(arr(id32()), null)
    .accounts({ task, claim, escrow, creator: w.buyer.publicKey, worker: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.provider.publicKey, systemProgram: SystemProgram.programId, tokenEscrowAta: null, workerTokenAccount: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, hireRecord: autoHire, operator: null, creatorCompletionBond: null, workerCompletionBond: null })
    .instruction(), [w.provider]), "settle:complete");

  return { task, escrow, claim, jobSpec, taskMod, workerAuthority: w.provider.publicKey, workerBalBefore, treasuryBalBefore, reward };
}

test("FULL SETTLEMENT (Auto): create -> moderate -> publish -> claim -> complete pays the worker", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await runAutoSettlement(w);

  const t = decode(w.svm, "Task", r.task);
  assert.ok(t.status.Completed !== undefined, `task should be Completed (got ${JSON.stringify(t.status)})`);

  const workerAfter = Number(w.svm.getBalance(r.workerAuthority));
  const treasuryAfter = Number(w.svm.getBalance(w.admin.publicKey));
  assert.ok(workerAfter > r.workerBalBefore, "worker received the reward");
  assert.ok(treasuryAfter >= r.treasuryBalBefore, "treasury received the protocol fee");
  assert.ok(isClosed(w.svm, r.escrow), "escrow closed on completion");
});

/// Drive a HIRED task through full settlement so the HireRecord (operator payee +
/// fee) exists at complete_task time — exercising the §4 3-way split. Mirrors
/// runAutoSettlement but mints the task via hire_from_listing instead of create_task.
/// Requires a moderation-enabled world. Returns balance snapshots + reward.
async function runHireSettlement(w, { pauseBeforeComplete = false, stopBeforeComplete = false } = {}) {
  const modProg = makeProgram(w.modAuth);

  // 0) record a CLEAN ListingModeration so the hire passes the moderation gate.
  // Idempotent: the listing/spec-keyed PDA is shared, so a second call in the same
  // world reuses the existing attestation rather than re-initializing it.
  const [listingMod] = pda([enc("listing_moderation"), w.listing.toBuffer(), Buffer.from(w.specHash)]);
  if (isClosed(w.svm, listingMod)) {
    expectOk(send(w.svm, await modProg.methods
      .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
      .accounts({ moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod, moderator: w.modAuth.publicKey, systemProgram: SystemProgram.programId })
      .instruction(), [w.modAuth]), "hire-settle:record-listing-mod");
  }

  // 1) buyer hires the provider's listing -> Open task + escrow + HireRecord.
  const taskId = id32();
  const { ix: hix, task, escrow, hireRecord } = await hireIx(w, { taskId, listingModeration: listingMod });
  expectOk(send(w.svm, hix, [w.buyer]), "hire-settle:hire");

  // 2) task moderation -> publish job spec -> worker claims.
  const jobHash = id32();
  const [taskMod] = pda([enc("task_moderation"), task.toBuffer(), Buffer.from(jobHash)]);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);

  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "hire-settle:task-mod");

  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/x")
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "hire-settle:publish");

  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "hire-settle:claim");

  // Stop here so callers can drive complete_task themselves (e.g. negative operator tests).
  if (stopBeforeComplete) return { task, escrow, claim, hireRecord, taskMod, jobSpec, reward: w.price };

  if (pauseBeforeComplete) await setProtocolPaused(w.svm, true);

  const workerBalBefore = Number(w.svm.getBalance(w.provider.publicKey));
  const treasuryBalBefore = Number(w.svm.getBalance(w.admin.publicKey));
  const operatorBalBefore = w.operator ? Number(w.svm.getBalance(w.operator)) : 0;

  // 3) worker completes — passes the HireRecord + operator payee so the 3-way
  //    split fires. operator may be null when the listing has no operator fee.
  expectOk(send(w.svm, await w.providerProg.methods
    .completeTask(arr(id32()), null)
    .accounts({ task, claim, escrow, creator: w.buyer.publicKey, worker: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.provider.publicKey, systemProgram: SystemProgram.programId, tokenEscrowAta: null, workerTokenAccount: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, hireRecord, operator: w.operator, creatorCompletionBond: null, workerCompletionBond: null })
    .instruction(), [w.provider]), "hire-settle:complete");

  return { task, escrow, claim, hireRecord, taskMod, jobSpec, workerBalBefore, treasuryBalBefore, operatorBalBefore, reward: w.price };
}

test("operator-fee protection: a hired task cannot be completed without paying the operator", async () => {
  // Regression for the audit finding: hire_record is now a REQUIRED account, and a
  // worker cannot omit/forge the operator to pocket the operator's cut.
  const operatorKp = Keypair.generate();
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000, operator: operatorKp.publicKey, operatorFeeBps: 1000 });
  const r = await runHireSettlement(w, { stopBeforeComplete: true });

  const completeAccounts = (operator) => ({
    task: r.task, claim: r.claim, escrow: r.escrow, creator: w.buyer.publicKey, worker: w.providerAgent,
    protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.provider.publicKey,
    systemProgram: SystemProgram.programId, tokenEscrowAta: null, workerTokenAccount: null,
    treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, hireRecord: r.hireRecord, operator,
    creatorCompletionBond: null, workerCompletionBond: null,
  });

  // (a) omit the operator account on a hired task with a fee -> MissingOperatorAccount
  expectFail(
    send(w.svm, await w.providerProg.methods.completeTask(arr(id32()), null).accounts(completeAccounts(null)).instruction(), [w.provider]),
    "MissingOperatorAccount", "complete hired task with operator omitted",
  );
  // (b) pass a WRONG operator -> InvalidOperatorAccount
  expectFail(
    send(w.svm, await w.providerProg.methods.completeTask(arr(id32()), null).accounts(completeAccounts(Keypair.generate().publicKey)).instruction(), [w.provider]),
    "InvalidOperatorAccount", "complete hired task with mismatched operator",
  );
  // Both reverted: the task is still InProgress and the operator was never bypassed.
  assert.ok(decode(w.svm, "Task", r.task).status.InProgress !== undefined, "task remains InProgress after rejected completes");

  // (c) the correct operator settles successfully and is paid its exact cut.
  expectOk(
    send(w.svm, await w.providerProg.methods.completeTask(arr(id32()), null).accounts(completeAccounts(operatorKp.publicKey)).instruction(), [w.provider]),
    "complete with correct operator",
  );
  assert.equal(Number(w.svm.getBalance(operatorKp.publicKey)) - 1e9, Math.floor((r.reward * 1000) / 10000), "operator paid its exact cut once the correct account is passed");
});

test("operator-fee guard: a listing whose operator is the hiring creator is rejected (no self-deal)", async () => {
  // Batch 2 §4: the operator (embedding site) must not be the task creator, or a
  // creator could pay themselves the operator leg. The listing operator == buyer,
  // and the buyer hires -> creator == operator -> OperatorIsCreator.
  const w = await freshWorld({ price: 2_000_000, operator: "__buyer__", operatorFeeBps: 1000 });
  const { ix } = await hireIx(w, {});
  expectFail(send(w.svm, ix, [w.buyer]), "OperatorIsCreator", "hire rejected when operator == creator");
});

test("migrate_task: reallocs a legacy 382B Task to 432B (multisig-gated, dry-run-safe, idempotent, rent topped up)", async () => {
  const w = await freshWorld({ price: 2_000_000 });
  // A new hire inits the Task at the Batch-2 size (432B).
  const { ix, task } = await hireIx(w, {});
  expectOk(send(w.svm, ix, [w.buyer]), "hire");
  const full = w.svm.getAccount(task);
  assert.equal(full.data.length, 432, "new tasks are created at the Batch-2 size");

  // Simulate a pre-Batch-2 legacy account: drop the trailing 50 zero bytes
  // (operator/fee/_reserved — all zero for a non-operator task) back to 382B, and
  // fund it at only the 382-byte rent so the migration must top up the rent.
  const legacy = Buffer.from(full.data).subarray(0, 382);
  const rent382 = Number(w.svm.minimumBalanceForRentExemption(382n));
  const rent432 = Number(w.svm.minimumBalanceForRentExemption(432n));
  w.svm.setAccount(task, { lamports: rent382, data: legacy, owner: PID, executable: false, rentEpoch: 0 });

  // 2-of-2 multisig gate.
  const owner2 = Keypair.generate();
  w.svm.airdrop(owner2.publicKey, BigInt(10e9));
  await setMultisig(w.svm, [w.admin.publicKey, owner2.publicKey], 2);
  const signerMetas = [
    { pubkey: w.admin.publicKey, isSigner: true, isWritable: false },
    { pubkey: owner2.publicKey, isSigner: true, isWritable: false },
  ];
  const buildMigrate = async (dryRun) =>
    makeProgram(w.admin).methods
      .migrateTask(dryRun)
      .accounts({ protocolConfig: w.protocolPda, task, payer: w.admin.publicKey, authority: w.admin.publicKey, systemProgram: SystemProgram.programId })
      .remainingAccounts(signerMetas)
      .instruction();

  // a single signer cannot pass the 2-of-2 gate.
  expectFail(send(w.svm, await makeProgram(w.admin).methods
    .migrateTask(false)
    .accounts({ protocolConfig: w.protocolPda, task, payer: w.admin.publicKey, authority: w.admin.publicKey, systemProgram: SystemProgram.programId })
    .remainingAccounts([{ pubkey: w.admin.publicKey, isSigner: true, isWritable: false }])
    .instruction(), [w.admin]), "MultisigNotEnoughSigners", "single signer rejected");

  // dry-run validates but does NOT mutate.
  expectOk(send(w.svm, await buildMigrate(true), [w.admin, owner2]), "migrate dry-run");
  assert.equal(w.svm.getAccount(task).data.length, 382, "dry-run left the account at the legacy size");

  // real migration: 382 -> 432, rent topped up, decodes with a zero-filled operator tail.
  expectOk(send(w.svm, await buildMigrate(false), [w.admin, owner2]), "migrate real");
  const migrated = w.svm.getAccount(task);
  assert.equal(migrated.data.length, 432, "task reallocated to the Batch-2 size");
  assert.ok(Number(migrated.lamports) >= rent432, `rent topped up to >= ${rent432} (got ${migrated.lamports})`);
  const t = decode(w.svm, "Task", task);
  assert.equal(t.operator.toBase58(), PublicKey.default.toBase58(), "operator zero-filled by migration");
  assert.equal(t.operator_fee_bps, 0, "operator_fee_bps zero-filled by migration");
  assert.equal(t.status.Open !== undefined, true, "pre-migration status preserved (Open)");

  // idempotent: a second run on the now-432B account is a no-op Ok. Expire the
  // blockhash first so this isn't a byte-identical (deduped) repeat of the real run.
  w.svm.expireBlockhash();
  expectOk(send(w.svm, await buildMigrate(false), [w.admin, owner2]), "migrate idempotent re-run");
  assert.equal(w.svm.getAccount(task).data.length, 432, "still 432 after idempotent re-run");
});

test("completion bond: creator + worker each post a 25% bond into distinct PDAs (dup + self-deal rejected)", async () => {
  const w = await freshWorld({ price: 2_000_000 });
  const { ix, task } = await hireIx(w, {});
  expectOk(send(w.svm, ix, [w.buyer]), "hire"); // Open Exclusive task, creator == buyer

  const bondPda = (party) => pda([enc("completion_bond"), task.toBuffer(), party.toBuffer()])[0];
  const post = async (signer, role) =>
    send(w.svm, await makeProgram(signer).methods
      .postCompletionBond(role)
      .accounts({ task, completionBond: bondPda(signer.publicKey), authority: signer.publicKey, systemProgram: SystemProgram.programId })
      .instruction(), [signer]);

  // creator bond (role 0) posted by the buyer (== task.creator)
  expectOk(await post(w.buyer, 0), "creator posts 25% bond");
  const cb = decode(w.svm, "CompletionBond", bondPda(w.buyer.publicKey));
  assert.equal(cb.role, 0, "creator bond role");
  assert.equal(cb.party.toBase58(), w.buyer.publicKey.toBase58(), "creator bond party == buyer");
  assert.equal(Number(cb.amount), 500_000, "bond is 25% of the 2,000,000 reward");
  assert.equal(cb.bond_mint, null, "SOL bond (no mint) in v1");

  // worker bond (role 1) posted by the provider (a non-creator wallet)
  expectOk(await post(w.provider, 1), "worker posts 25% bond");
  assert.equal(decode(w.svm, "CompletionBond", bondPda(w.provider.publicKey)).role, 1, "worker bond role");

  // dup: posting again on the same (task, party) PDA fails at init (account already
  // exists — a tx-level create_account error, so assert failure without a log match).
  assert.ok(
    (await post(w.buyer, 0)) instanceof FailedTransactionMetadata,
    "duplicate creator bond rejected by init",
  );

  // self-deal: a non-creator posting the CREATOR role is rejected.
  const stranger = Keypair.generate();
  w.svm.airdrop(stranger.publicKey, BigInt(10e9));
  expectFail(await post(stranger, 0), "BondPartyMismatch", "non-creator cannot post the creator bond");
});

test("completion bond: a no-show worker forfeits their bond to the creator on expire_claim", async () => {
  // The load-bearing case: the claim closes to the worker (auto-refunding claim rent),
  // but the bond lives in its own PDA, so a no-show worker does NOT get the bond back —
  // it is forfeited to the creator. Revert-sensitive: drop the forfeit and the creator
  // delta below goes to 0.
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000 });
  const r = await runHireSettlement(w, { stopBeforeComplete: true }); // claimed, InProgress

  // worker posts a 25% completion bond (1,000,000).
  const [workerBond] = pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .postCompletionBond(1)
    .accounts({ task: r.task, completionBond: workerBond, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "worker posts bond");
  assert.equal(Number(decode(w.svm, "CompletionBond", workerBond).amount), 1_000_000, "bond is 25% of reward");

  // warp well past claim expiry + grace so a third party can expire it.
  const clk = w.svm.getClock();
  clk.unixTimestamp = clk.unixTimestamp + 700_000n;
  w.svm.setClock(clk);

  // a neutral caller expires the claim (so the creator's delta is purely the forfeit).
  const cleaner = Keypair.generate();
  w.svm.airdrop(cleaner.publicKey, BigInt(10e9));
  const buyerBefore = Number(w.svm.getBalance(w.buyer.publicKey));

  expectOk(send(w.svm, await makeProgram(cleaner).methods
    .expireClaim()
    .accounts({
      authority: cleaner.publicKey, task: r.task, escrow: r.escrow, claim: r.claim,
      worker: w.providerAgent, protocolConfig: w.protocolPda, taskValidationConfig: null,
      taskSubmission: null, rentRecipient: w.provider.publicKey,
      workerCompletionBond: workerBond, bondCreator: w.buyer.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .instruction(), [cleaner]), "expire_claim with no-show bond forfeit");

  assert.ok(isClosed(w.svm, workerBond), "worker bond PDA closed after forfeit");
  const buyerDelta = Number(w.svm.getBalance(w.buyer.publicKey)) - buyerBefore;
  assert.equal(buyerDelta, 1_000_000, `creator received the forfeited bond principal (got ${buyerDelta})`);
});

test("completion bond: a clean completion refunds BOTH bonds to their posters", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000 });
  const r = await runHireSettlement(w, { stopBeforeComplete: true }); // claimed, InProgress

  const creatorBond = pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0];
  const workerBond = pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()])[0];
  expectOk(send(w.svm, await w.buyerProg.methods.postCompletionBond(0)
    .accounts({ task: r.task, completionBond: creatorBond, authority: w.buyer.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.buyer]), "creator bond");
  expectOk(send(w.svm, await w.providerProg.methods.postCompletionBond(1)
    .accounts({ task: r.task, completionBond: workerBond, authority: w.provider.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.provider]), "worker bond");

  const creatorBondLamports = Number(w.svm.getBalance(creatorBond));
  const buyerBefore = Number(w.svm.getBalance(w.buyer.publicKey));

  expectOk(send(w.svm, await w.providerProg.methods
    .completeTask(arr(id32()), null)
    .accounts({
      task: r.task, claim: r.claim, escrow: r.escrow, creator: w.buyer.publicKey, worker: w.providerAgent,
      protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.provider.publicKey,
      systemProgram: SystemProgram.programId, tokenEscrowAta: null, workerTokenAccount: null,
      treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, hireRecord: r.hireRecord, operator: null,
      creatorCompletionBond: creatorBond, workerCompletionBond: workerBond,
    })
    .instruction(), [w.provider]), "complete with bond refunds");

  assert.ok(decode(w.svm, "Task", r.task).status.Completed !== undefined, "task Completed");
  assert.ok(isClosed(w.svm, creatorBond), "creator bond refunded + closed");
  assert.ok(isClosed(w.svm, workerBond), "worker bond refunded + closed");
  // buyer (not a signer here) gets back the full creator bond (rent + principal), plus escrow rent.
  assert.ok(Number(w.svm.getBalance(w.buyer.publicKey)) - buyerBefore >= creatorBondLamports,
    "creator received their refunded bond");
});

test("completion bond: rejected on a ZK-private task (audit — would strand on complete_task_private)", async () => {
  // A private task (real constraint_hash) settles via complete_task_private, which
  // does NOT settle bonds, so a bond there would be permanently stranded. post must
  // reject it. Revert-sensitive: drop the constraint_hash guard and this posts OK.
  const w = await freshWorld({});
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64); desc.set(crypto.randomBytes(32), 0);
  const constraintHash = crypto.randomBytes(32); // real ZK constraint -> private task
  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(2_000_000), 1, new BN(now + 3600), 0, arr(constraintHash), 0, null)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "create private task");
  const bond = pda([enc("completion_bond"), task.toBuffer(), w.buyer.publicKey.toBuffer()])[0];
  expectFail(send(w.svm, await w.buyerProg.methods.postCompletionBond(0)
    .accounts({ task, completionBond: bond, authority: w.buyer.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.buyer]),
    "BondUnsupportedTaskType", "bond rejected on a ZK-private task");
});

test("completion bond: reclaim_completion_bond recovers a bond stranded by an omitted account on a Completed task", async () => {
  // Audit MEDIUM: a terminal exit can omit the optional bond account and strand it.
  // reclaim_completion_bond lets the poster recover it once the task is Completed.
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000 });
  const r = await runHireSettlement(w, { stopBeforeComplete: true });
  const workerBond = pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()])[0];
  expectOk(send(w.svm, await w.providerProg.methods.postCompletionBond(1)
    .accounts({ task: r.task, completionBond: workerBond, authority: w.provider.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.provider]), "worker bond");

  // complete the task but OMIT the worker bond account -> it is stranded.
  expectOk(send(w.svm, await w.providerProg.methods.completeTask(arr(id32()), null)
    .accounts({ task: r.task, claim: r.claim, escrow: r.escrow, creator: w.buyer.publicKey, worker: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.provider.publicKey, systemProgram: SystemProgram.programId, tokenEscrowAta: null, workerTokenAccount: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, hireRecord: r.hireRecord, operator: null, creatorCompletionBond: null, workerCompletionBond: null })
    .instruction(), [w.provider]), "complete (omitting worker bond)");
  assert.ok(decode(w.svm, "Task", r.task).status.Completed !== undefined, "task Completed");
  assert.ok(!isClosed(w.svm, workerBond), "worker bond stranded (still open) after the omitted-account completion");

  // reclaim recovers it to the poster.
  const providerBefore = Number(w.svm.getBalance(w.provider.publicKey));
  const bondLamports = Number(w.svm.getBalance(workerBond));
  expectOk(send(w.svm, await makeProgram(w.provider).methods.reclaimCompletionBond(1)
    .accounts({ task: r.task, completionBond: workerBond, party: w.provider.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.provider]), "reclaim worker bond");
  assert.ok(isClosed(w.svm, workerBond), "worker bond reclaimed + closed");
  // provider is the fee-payer here, so delta = bond (rent+principal) minus tx fee.
  const providerDelta = Number(w.svm.getBalance(w.provider.publicKey)) - providerBefore;
  assert.ok(providerDelta > bondLamports - 50_000, `poster recovered the bond (delta ${providerDelta}, bond ${bondLamports})`);
});

test("completion bond: cancel refunds the creator bond on an Open task", async () => {
  const w = await freshWorld({ price: 2_000_000 });
  const { ix, task, escrow } = await hireIx(w, {});
  expectOk(send(w.svm, ix, [w.buyer]), "hire"); // Open task, creator == buyer
  const creatorBond = pda([enc("completion_bond"), task.toBuffer(), w.buyer.publicKey.toBuffer()])[0];
  expectOk(send(w.svm, await w.buyerProg.methods.postCompletionBond(0)
    .accounts({ task, completionBond: creatorBond, authority: w.buyer.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.buyer]), "creator bond");

  expectOk(send(w.svm, await w.buyerProg.methods.cancelTask()
    .accounts({ task, escrow, authority: w.buyer.publicKey, protocolConfig: w.protocolPda, systemProgram: SystemProgram.programId,
      tokenEscrowAta: null, creatorTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: creatorBond, workerCompletionBond: null, workerBondAuthority: null })
    .instruction(), [w.buyer]), "cancel with creator bond refund");

  assert.ok(decode(w.svm, "Task", task).status.Cancelled !== undefined, "task Cancelled");
  assert.ok(isClosed(w.svm, creatorBond), "creator bond refunded + closed on cancel");
});

test("3-way split: hire -> settle pays worker (>=60%) + AgenC (treasury) + operator (exact cut)", async () => {
  const operatorKp = Keypair.generate();
  const w = await freshWorld({ moderationEnabled: true, price: 5_000_000, operator: operatorKp.publicKey, operatorFeeBps: 1000 });
  const r = await runHireSettlement(w);

  const t = decode(w.svm, "Task", r.task);
  assert.ok(t.status.Completed !== undefined, `task Completed (got ${JSON.stringify(t.status)})`);
  // Batch 2: operator terms are stamped onto the Task itself (Task-first settlement).
  assert.equal(t.operator.toBase58(), operatorKp.publicKey.toBase58(), "Task.operator stamped at hire");
  assert.equal(t.operator_fee_bps, 1000, "Task.operator_fee_bps stamped at hire");

  // operator leg is exact: base(=reward, exclusive) * operatorFeeBps / 10000.
  const operatorAfter = Number(w.svm.getBalance(operatorKp.publicKey));
  const expectedOperatorFee = Math.floor((r.reward * 1000) / 10000); // 500_000
  assert.equal(operatorAfter - r.operatorBalBefore, expectedOperatorFee, "operator received its exact fee leg");

  // treasury (AgenC) received a non-zero protocol cut.
  const treasuryAfter = Number(w.svm.getBalance(w.admin.publicKey));
  const treasuryDelta = treasuryAfter - r.treasuryBalBefore;
  assert.ok(treasuryDelta > 0, "treasury received the AgenC protocol fee");

  // worker (provider authority, also fee payer) keeps >= 60% of the reward.
  const workerAfter = Number(w.svm.getBalance(w.provider.publicKey));
  const workerDelta = workerAfter - r.workerBalBefore; // worker_reward minus tx fee
  assert.ok(workerDelta >= Math.floor(r.reward * 0.6), `worker keeps >=60% (got ${workerDelta} of ${r.reward})`);

  // conservation: the three legs (+ worker's tx fee) drain exactly the reward.
  assert.ok(expectedOperatorFee + treasuryDelta < r.reward, "operator + AgenC stay below the full reward");
  assert.ok(isClosed(w.svm, r.escrow), "escrow closed on completion");
});

test("3-way split: a listing with no operator fee settles 2-way (operator leg skipped)", async () => {
  // operator=null, operatorFeeBps=0 -> HireRecord.operator=default, fee=0 -> no leg.
  const w = await freshWorld({ moderationEnabled: true, price: 3_000_000 });
  const r = await runHireSettlement(w); // w.operator is null -> complete passes operator: null

  const t = decode(w.svm, "Task", r.task);
  assert.ok(t.status.Completed !== undefined, "task Completed via hire path with no operator leg");
  const workerAfter = Number(w.svm.getBalance(w.provider.publicKey));
  assert.ok(workerAfter > r.workerBalBefore, "worker paid on the 2-way fallback");
  assert.ok(isClosed(w.svm, r.escrow), "escrow closed");
});

test("3-way split: settlement still works while the protocol is paused (exit-safe + operator leg)", async () => {
  const operatorKp = Keypair.generate();
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000, operator: operatorKp.publicKey, operatorFeeBps: 500 });
  const r = await runHireSettlement(w, { pauseBeforeComplete: true });

  const operatorAfter = Number(w.svm.getBalance(operatorKp.publicKey));
  assert.equal(operatorAfter - r.operatorBalBefore, Math.floor((r.reward * 500) / 10000), "operator paid its leg even while paused");
  assert.ok(isClosed(w.svm, r.escrow), "escrow closed while paused");
});

test("exit allow-list (settlement): a worker still completes + is paid while the protocol is paused", async () => {
  // Regression for the iter-5 review finding: forward-settlement (complete_task)
  // must not be frozen by a pause, or a worker who did the work loses it when the
  // claim later expires. Pause is injected AFTER the claim, before completion.
  const w = await freshWorld({ moderationEnabled: true });
  const r = await runAutoSettlement(w, { pauseBeforeComplete: true });

  const t = decode(w.svm, "Task", r.task);
  assert.ok(t.status.Completed !== undefined, `task Completed despite paused protocol (got ${JSON.stringify(t.status)})`);
  assert.ok(Number(w.svm.getBalance(r.workerAuthority)) > r.workerBalBefore, "worker paid while paused");
  assert.ok(isClosed(w.svm, r.escrow), "escrow closed on completion while paused");
});

/// Build a BidExclusive task with an injected bid marketplace, an open bid book,
/// and one active bid from the provider agent — in a moderation-enabled world.
/// When publishJobSpec is true, also record+publish a moderated TaskJobSpec (which
/// accept_bid now requires). Returns handles for accept_bid.
async function setupBidTask(w, { publishJobSpec = true } = {}) {
  const modProg = makeProgram(w.modAuth);
  const taskId = id32();
  const reward = 4_000_000;
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);

  // 1) create a BidExclusive task (task_type = 3).
  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(reward), 1, new BN(now + 3600), 3, null, 0, null) // task_type=3 (BidExclusive)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "bid:create_task");

  // 2) optionally publish a moderated job spec (required by accept_bid, §6).
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  if (publishJobSpec) {
    const jobHash = id32();
    const [taskMod] = pda([enc("task_moderation"), task.toBuffer(), Buffer.from(jobHash)]);
    expectOk(send(w.svm, await modProg.methods
      .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
      .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, systemProgram: SystemProgram.programId })
      .instruction(), [w.modAuth]), "bid:task-mod");
    expectOk(send(w.svm, await w.buyerProg.methods
      .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/bid")
      .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
      .instruction(), [w.buyer]), "bid:publish");
  }

  // 3) inject the bid marketplace, then init the bid book (creator) + a bid (provider).
  const bidMarket = await injectBidMarketplace(w.svm, w.admin, {});
  const [bidBook] = pda([enc("bid_book"), task.toBuffer()]);
  expectOk(send(w.svm, await w.buyerProg.methods
    .initializeBidBook(0, 0, 0, 0, 0) // policy 0 = BestPrice (no weight-sum rule)
    .accounts({ task, bidBook, protocolConfig: w.protocolPda, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "bid:init-book");

  const [bid] = pda([enc("bid"), task.toBuffer(), w.providerAgent.toBuffer()]);
  const [bidderMarket] = pda([enc("bidder_market"), w.providerAgent.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .createBid(new BN(reward), 3600, 5000, arr(Buffer.alloc(32, 4)), arr(Buffer.alloc(32, 5)), new BN(now + 1800))
    .accounts({ protocolConfig: w.protocolPda, bidMarketplace: bidMarket, task, bidBook, bid, bidderMarketState: bidderMarket, bidder: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "bid:create_bid");

  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  return { task, escrow, jobSpec, bidBook, bid, bidderMarket, claim, reward };
}

test("accept_bid moderation gate: succeeds only with a published (moderated) job spec", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const b = await setupBidTask(w, { publishJobSpec: true });

  expectOk(send(w.svm, await w.buyerProg.methods
    .acceptBid()
    .accounts({ task: b.task, claim: b.claim, protocolConfig: w.protocolPda, bidBook: b.bidBook, bid: b.bid, bidderMarketState: b.bidderMarket, bidder: w.providerAgent, taskJobSpec: b.jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "accept_bid with job spec");

  const t = decode(w.svm, "Task", b.task);
  assert.ok(t.status.InProgress !== undefined, `task InProgress after accept_bid (got ${JSON.stringify(t.status)})`);
  const claim = decode(w.svm, "TaskClaim", b.claim);
  assert.equal(claim.worker.toBase58(), w.providerAgent.toBase58(), "claim assigned to the bidder");
});

test("accept_bid moderation gate: rejected when no job spec was published (§6 entry gate)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const b = await setupBidTask(w, { publishJobSpec: false }); // no TaskJobSpec published

  // The required task_job_spec PDA does not exist -> accept_bid cannot assign work.
  const res = send(w.svm, await w.buyerProg.methods
    .acceptBid()
    .accounts({ task: b.task, claim: b.claim, protocolConfig: w.protocolPda, bidBook: b.bidBook, bid: b.bid, bidderMarketState: b.bidderMarket, bidder: w.providerAgent, taskJobSpec: b.jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]);
  expectFail(res, "AccountNotInitialized", "accept_bid without a published job spec");

  // The task must remain Open (no worker assigned) since the gate blocked it.
  const t = decode(w.svm, "Task", b.task);
  assert.ok(t.status.Open !== undefined, `task stays Open when the gate blocks accept_bid (got ${JSON.stringify(t.status)})`);
});

/// Create a plain (non-hired) Auto task and pin it to manual validation (default
/// CreatorReview = 1). Passes the empty ["hire", task] PDA (non-hired), so the
/// hired-task guard lets it through. Returns handles for the manual settlement flow.
async function setupManualTask(w, { mode = 1, reviewWindow = 3600, reward = 2_000_000, capabilities = 1 } = {}) {
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const [validation] = pda([enc("task_validation"), task.toBuffer()]);
  const [attestor] = pda([enc("task_attestor"), task.toBuffer()]);
  const [hireRecord] = pda([enc("hire"), task.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(capabilities), arr(desc), new BN(reward), 1, new BN(now + 3600), 0, null, 0, null)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: null, creatorTokenAccount: null, tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null })
    .instruction(), [w.buyer]), "manual:create_task");
  expectOk(send(w.svm, await w.buyerProg.methods
    .configureTaskValidation(mode, new BN(reviewWindow), 0, null)
    .accounts({ task, taskValidationConfig: validation, taskAttestorConfig: attestor, protocolConfig: w.protocolPda, hireRecord, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "manual:configure");
  return { task, escrow, validation, attestor, reward };
}

test("operator-fee protection: a hired task cannot be re-routed to manual validation", async () => {
  // Regression for the audit finding: configure_task_validation must reject a task
  // that has a live HireRecord (re-routing it to manual settlement would drop the
  // operator's fee, which the manual path is not yet hire-aware about).
  const operatorKp = Keypair.generate();
  const w = await freshWorld({ moderationEnabled: true, price: 3_000_000, operator: operatorKp.publicKey, operatorFeeBps: 1000 });
  const [listingMod] = pda([enc("listing_moderation"), w.listing.toBuffer(), Buffer.from(w.specHash)]);
  expectOk(send(w.svm, await makeProgram(w.modAuth).methods
    .recordListingModeration(arr(w.specHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 7)), arr(Buffer.alloc(32, 9)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, listing: w.listing, listingModeration: listingMod, moderator: w.modAuth.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "record listing mod");
  const { ix: hix, task, hireRecord } = await hireIx(w, { listingModeration: listingMod });
  expectOk(send(w.svm, hix, [w.buyer]), "hire");

  const [validation] = pda([enc("task_validation"), task.toBuffer()]);
  const [attestor] = pda([enc("task_attestor"), task.toBuffer()]);
  const cfgIx = await w.buyerProg.methods
    .configureTaskValidation(1, new BN(3600), 0, null) // CreatorReview
    .accounts({ task, taskValidationConfig: validation, taskAttestorConfig: attestor, protocolConfig: w.protocolPda, hireRecord, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction();
  expectFail(send(w.svm, cfgIx, [w.buyer]), "HiredTaskValidationUnsupported", "configure validation on a hired task");
});

test("configure_task_validation: a non-hired task can still be pinned to manual validation", async () => {
  const w = await freshWorld({});
  const m = await setupManualTask(w, { mode: 1 }); // passes the empty hire PDA, guard lets it through
  const vc = decode(w.svm, "TaskValidationConfig", m.validation);
  assert.ok(
    vc.mode?.CreatorReview !== undefined || vc.mode?.creatorReview !== undefined,
    `non-hired task pinned to CreatorReview (got ${JSON.stringify(vc.mode)})`,
  );
});

/// Drive a manual-validation (V2) task through settlement: create+configure (CreatorReview)
/// -> moderate -> publish -> claim -> submit_task_result -> accept|reject_task_result.
/// Requires a moderation-enabled world. Returns handles + the worker balance snapshot.
async function runManualSettlement(w, { decision = "accept", pauseBeforeSettle = false, postBonds = false } = {}) {
  const modProg = makeProgram(w.modAuth);
  const m = await setupManualTask(w, { mode: 1 }); // CreatorReview, non-hired
  const { task, escrow, validation, reward } = m;

  // moderate + publish a job spec (required to claim)
  const jobHash = id32();
  const [taskMod] = pda([enc("task_moderation"), task.toBuffer(), Buffer.from(jobHash)]);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "manual:task-mod");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/manual")
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "manual:publish");

  // worker claims, then submits a result for review
  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "manual:claim");
  const [submission] = pda([enc("task_submission"), claim.toBuffer()]);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  expectOk(send(w.svm, await w.providerProg.methods
    .submitTaskResult(arr(id32()), arr(desc))
    .accounts({ task, claim, taskValidationConfig: validation, taskSubmission: submission, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "manual:submit");

  // Optional: post creator + worker completion bonds so accept can exercise the refund.
  let creatorBond = null, workerBond = null;
  if (postBonds) {
    creatorBond = pda([enc("completion_bond"), task.toBuffer(), w.buyer.publicKey.toBuffer()])[0];
    workerBond = pda([enc("completion_bond"), task.toBuffer(), w.provider.publicKey.toBuffer()])[0];
    expectOk(send(w.svm, await w.buyerProg.methods.postCompletionBond(0)
      .accounts({ task, completionBond: creatorBond, authority: w.buyer.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.buyer]), "manual:creator-bond");
    expectOk(send(w.svm, await w.providerProg.methods.postCompletionBond(1)
      .accounts({ task, completionBond: workerBond, authority: w.provider.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.provider]), "manual:worker-bond");
  }

  if (pauseBeforeSettle) await setProtocolPaused(w.svm, true);

  // worker_authority (provider) is NOT the signer of accept/reject (creator signs),
  // so its balance delta reflects payout exactly.
  const workerBalBefore = Number(w.svm.getBalance(w.provider.publicKey));
  if (decision === "accept") {
    expectOk(send(w.svm, await w.buyerProg.methods
      .acceptTaskResult()
      .accounts({ task, claim, escrow, taskValidationConfig: validation, taskSubmission: submission, worker: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, creator: w.buyer.publicKey, workerAuthority: w.provider.publicKey, creatorCompletionBond: creatorBond, workerCompletionBond: workerBond, tokenEscrowAta: null, workerTokenAccount: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, systemProgram: SystemProgram.programId })
      .instruction(), [w.buyer]), "manual:accept");
  } else if (decision === "reject") {
    expectOk(send(w.svm, await w.buyerProg.methods
      .rejectTaskResult(arr(id32()))
      .accounts({ task, claim, taskValidationConfig: validation, taskSubmission: submission, worker: w.providerAgent, protocolConfig: w.protocolPda, creator: w.buyer.publicKey, workerAuthority: w.provider.publicKey })
      .instruction(), [w.buyer]), "manual:reject");
  }
  return { task, escrow, claim, validation, submission, jobSpec, workerBalBefore, reward, creatorBond, workerBond };
}

test("manual validation (CreatorReview): submit -> accept pays the worker", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await runManualSettlement(w, { decision: "accept" });
  const t = decode(w.svm, "Task", r.task);
  assert.ok(t.status.Completed !== undefined, `task Completed after accept (got ${JSON.stringify(t.status)})`);
  assert.ok(Number(w.svm.getBalance(w.provider.publicKey)) > r.workerBalBefore, "worker paid on accept");
  assert.ok(isClosed(w.svm, r.escrow), "escrow closed on accept");
});

test("completion bond: accept_task_result refunds BOTH bonds", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await runManualSettlement(w, { decision: "accept", postBonds: true });
  assert.ok(decode(w.svm, "Task", r.task).status.Completed !== undefined, "task Completed after accept");
  assert.ok(isClosed(w.svm, r.creatorBond), "creator bond refunded + closed on accept");
  assert.ok(isClosed(w.svm, r.workerBond), "worker bond refunded + closed on accept");
});

test("manual validation (CreatorReview): reject does NOT pay the worker or settle", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await runManualSettlement(w, { decision: "reject" });
  const t = decode(w.svm, "Task", r.task);
  assert.ok(t.status.Completed === undefined, `task NOT Completed after reject (got ${JSON.stringify(t.status)})`);
  assert.ok(!isClosed(w.svm, r.escrow), "escrow still holds the reward after reject");
});

test("manual validation: accept still settles while the protocol is paused (exit-safe)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await runManualSettlement(w, { decision: "accept", pauseBeforeSettle: true });
  assert.ok(decode(w.svm, "Task", r.task).status.Completed !== undefined, "task Completed despite pause");
  assert.ok(Number(w.svm.getBalance(w.provider.publicKey)) > r.workerBalBefore, "worker paid while paused");
  assert.ok(isClosed(w.svm, r.escrow), "escrow closed while paused");
});

/// Manual (CreatorReview) task driven through moderate -> publish -> claim -> submit,
/// stopping with a pending submission ready for accept / request_changes / reject.
async function setupSubmittedManual(w) {
  const modProg = makeProgram(w.modAuth);
  const m = await setupManualTask(w, { mode: 1 });
  const { task, escrow, validation, reward } = m;
  const jobHash = id32();
  const [taskMod] = pda([enc("task_moderation"), task.toBuffer(), Buffer.from(jobHash)]);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  expectOk(send(w.svm, await modProg.methods.recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.modAuth]), "rc:mod");
  expectOk(send(w.svm, await w.buyerProg.methods.setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/rc")
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.buyer]), "rc:publish");
  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods.claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.provider]), "rc:claim");
  const [submission] = pda([enc("task_submission"), claim.toBuffer()]);
  const desc = Buffer.alloc(64); desc.set(crypto.randomBytes(32), 0);
  const submit = async () => send(w.svm, await w.providerProg.methods.submitTaskResult(arr(id32()), arr(desc))
    .accounts({ task, claim, taskValidationConfig: validation, taskSubmission: submission, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.provider]);
  expectOk(await submit(), "rc:submit");
  return { task, escrow, validation, submission, jobSpec, claim, reward, submit };
}

test("request_changes: non-terminal revision keeps the claim, worker resubmits in place -> accept pays", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await setupSubmittedManual(w);
  expectOk(send(w.svm, await w.buyerProg.methods.requestChanges(arr(Buffer.alloc(32, 9)))
    .accounts({ task: r.task, claim: r.claim, taskValidationConfig: r.validation, taskSubmission: r.submission, protocolConfig: w.protocolPda, creator: w.buyer.publicKey }).instruction(), [w.buyer]), "request_changes");
  assert.ok(decode(w.svm, "Task", r.task).status.InProgress !== undefined, "task back to InProgress after request_changes");
  assert.ok(!isClosed(w.svm, r.claim), "claim retained (worker resubmits in place)");

  w.svm.expireBlockhash();
  expectOk(await r.submit(), "resubmit after changes");
  assert.ok(decode(w.svm, "Task", r.task).status.PendingValidation !== undefined, "resubmit -> PendingValidation");

  expectOk(send(w.svm, await w.buyerProg.methods.acceptTaskResult()
    .accounts({ task: r.task, claim: r.claim, escrow: r.escrow, taskValidationConfig: r.validation, taskSubmission: r.submission, worker: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, creator: w.buyer.publicKey, workerAuthority: w.provider.publicKey, creatorCompletionBond: null, workerCompletionBond: null, tokenEscrowAta: null, workerTokenAccount: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, systemProgram: SystemProgram.programId }).instruction(), [w.buyer]), "accept after revision");
  assert.ok(decode(w.svm, "Task", r.task).status.Completed !== undefined, "task Completed after revision + accept");
});

test("reject_and_freeze: terminal reject freezes the task and retains the claim (no payout)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await setupSubmittedManual(w);
  const workerBefore = Number(w.svm.getBalance(w.provider.publicKey));
  expectOk(send(w.svm, await w.buyerProg.methods.rejectAndFreeze(arr(Buffer.alloc(32, 7)))
    .accounts({ task: r.task, claim: r.claim, taskValidationConfig: r.validation, taskSubmission: r.submission, protocolConfig: w.protocolPda, creator: w.buyer.publicKey }).instruction(), [w.buyer]), "reject_and_freeze");
  assert.ok(decode(w.svm, "Task", r.task).status.RejectFrozen !== undefined, "task RejectFrozen");
  assert.ok(!isClosed(w.svm, r.claim), "claim retained for the frozen exit");
  assert.ok(!isClosed(w.svm, r.escrow), "escrow retained (no payout on freeze)");
  assert.equal(Number(w.svm.getBalance(w.provider.publicKey)), workerBefore, "no worker payout on freeze");
});

/// Drive a manual task all the way to RejectFrozen (optionally with both bonds posted).
async function setupFrozen(w, { postBonds = false } = {}) {
  const r = await setupSubmittedManual(w);
  let creatorBond = null, workerBond = null;
  if (postBonds) {
    creatorBond = pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0];
    workerBond = pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()])[0];
    expectOk(send(w.svm, await w.buyerProg.methods.postCompletionBond(0).accounts({ task: r.task, completionBond: creatorBond, authority: w.buyer.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.buyer]), "frozen:creator-bond");
    expectOk(send(w.svm, await w.providerProg.methods.postCompletionBond(1).accounts({ task: r.task, completionBond: workerBond, authority: w.provider.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.provider]), "frozen:worker-bond");
  }
  expectOk(send(w.svm, await w.buyerProg.methods.rejectAndFreeze(arr(Buffer.alloc(32, 7)))
    .accounts({ task: r.task, claim: r.claim, taskValidationConfig: r.validation, taskSubmission: r.submission, protocolConfig: w.protocolPda, creator: w.buyer.publicKey }).instruction(), [w.buyer]), "frozen:freeze");
  assert.ok(decode(w.svm, "Task", r.task).status.RejectFrozen !== undefined, "task is RejectFrozen");
  return { ...r, creatorBond, workerBond };
}

test("negative: a RejectFrozen task is refused by cancel / accept / request_changes / reject_and_freeze", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const f = await setupFrozen(w);

  // cancel_task: a frozen task is not cancellable (creator can't dodge the review).
  expectFail(send(w.svm, await w.buyerProg.methods.cancelTask()
    .accounts({ task: f.task, escrow: f.escrow, authority: w.buyer.publicKey, protocolConfig: w.protocolPda, systemProgram: SystemProgram.programId,
      tokenEscrowAta: null, creatorTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: null, workerCompletionBond: null, workerBondAuthority: null })
    .instruction(), [w.buyer]), "TaskCannotBeCancelled", "cancel refused on a frozen task");

  // accept_task_result: requires PendingValidation; a frozen task is not.
  expectFail(send(w.svm, await w.buyerProg.methods.acceptTaskResult()
    .accounts({ task: f.task, claim: f.claim, escrow: f.escrow, taskValidationConfig: f.validation, taskSubmission: f.submission, worker: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, creator: w.buyer.publicKey, workerAuthority: w.provider.publicKey, creatorCompletionBond: null, workerCompletionBond: null, tokenEscrowAta: null, workerTokenAccount: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "TaskNotPendingValidation", "accept refused on a frozen task");

  // request_changes + reject_and_freeze: both require PendingValidation.
  expectFail(send(w.svm, await w.buyerProg.methods.requestChanges(arr(Buffer.alloc(32, 9)))
    .accounts({ task: f.task, claim: f.claim, taskValidationConfig: f.validation, taskSubmission: f.submission, protocolConfig: w.protocolPda, creator: w.buyer.publicKey })
    .instruction(), [w.buyer]), "TaskNotPendingValidation", "request_changes refused on a frozen task");
  expectFail(send(w.svm, await w.buyerProg.methods.rejectAndFreeze(arr(Buffer.alloc(32, 9)))
    .accounts({ task: f.task, claim: f.claim, taskValidationConfig: f.validation, taskSubmission: f.submission, protocolConfig: w.protocolPda, creator: w.buyer.publicKey })
    .instruction(), [w.buyer]), "TaskNotPendingValidation", "double-freeze refused");
});

test("dispute mutual-exclusion: a RejectFrozen task cannot be disputed", async () => {
  // The durable-submission path in initiate_dispute bypasses can_transition_to(Disputed),
  // so the freeze is guarded explicitly. Revert-sensitive: drop the guard and this
  // initiate_dispute no longer fails with TaskFrozenCannotDispute.
  const w = await freshWorld({ moderationEnabled: true });
  const f = await setupFrozen(w);
  const taskId = decode(w.svm, "Task", f.task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.provider.publicKey.toBuffer()]);
  expectFail(send(w.svm, await w.providerProg.methods
    .initiateDispute(arr(disputeId), arr(taskId), arr(Buffer.alloc(32, 1)), 0, "evidence")
    .accounts({ dispute, task: f.task, agent: w.providerAgent, authorityRateLimit: rateLimit, protocolConfig: w.protocolPda, initiatorClaim: f.claim, workerAgent: null, workerClaim: null, taskSubmission: null, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]),
    "TaskFrozenCannotDispute", "a frozen task is refused a dispute");
});

test("resolve_reject_frozen (approve): pays the worker, refunds worker bond, forfeits creator bond (2-of-2 multisig)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const owner2 = Keypair.generate(); w.svm.airdrop(owner2.publicKey, BigInt(10e9));
  await setMultisig(w.svm, [w.admin.publicKey, owner2.publicKey], 2);
  const f = await setupFrozen(w, { postBonds: true });
  const signerMetas = [{ pubkey: w.admin.publicKey, isSigner: true, isWritable: false }, { pubkey: owner2.publicKey, isSigner: true, isWritable: false }];
  const accts = { task: f.task, claim: f.claim, escrow: f.escrow, taskSubmission: f.submission, worker: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, creator: w.buyer.publicKey, workerAuthority: w.provider.publicKey, authority: w.admin.publicKey, creatorCompletionBond: f.creatorBond, workerCompletionBond: f.workerBond, bondTreasury: w.admin.publicKey, systemProgram: SystemProgram.programId };

  // a single signer cannot pass the 2-of-2 gate.
  expectFail(send(w.svm, await makeProgram(w.admin).methods.resolveRejectFrozen(true).accounts(accts).remainingAccounts([signerMetas[0]]).instruction(), [w.admin]), "MultisigNotEnoughSigners", "single signer rejected");

  const workerBefore = Number(w.svm.getBalance(w.provider.publicKey));
  expectOk(send(w.svm, await makeProgram(w.admin).methods.resolveRejectFrozen(true).accounts(accts).remainingAccounts(signerMetas).instruction(), [w.admin, owner2]), "resolve approve");
  assert.ok(decode(w.svm, "Task", f.task).status.Completed !== undefined, "task Completed (worker vindicated)");
  assert.ok(Number(w.svm.getBalance(w.provider.publicKey)) > workerBefore, "worker paid");
  assert.ok(isClosed(w.svm, f.workerBond), "worker bond refunded + closed");
  assert.ok(isClosed(w.svm, f.creatorBond), "creator bond forfeited + closed");
  assert.ok(isClosed(w.svm, f.escrow), "escrow settled");
});

test("resolve_reject_frozen (reject): refunds the creator, forfeits worker bond, refunds creator bond (multisig)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const owner2 = Keypair.generate(); w.svm.airdrop(owner2.publicKey, BigInt(10e9));
  await setMultisig(w.svm, [w.admin.publicKey, owner2.publicKey], 2);
  const f = await setupFrozen(w, { postBonds: true });
  const signerMetas = [{ pubkey: w.admin.publicKey, isSigner: true, isWritable: false }, { pubkey: owner2.publicKey, isSigner: true, isWritable: false }];
  const buyerBefore = Number(w.svm.getBalance(w.buyer.publicKey));
  expectOk(send(w.svm, await makeProgram(w.admin).methods.resolveRejectFrozen(false)
    .accounts({ task: f.task, claim: f.claim, escrow: f.escrow, taskSubmission: f.submission, worker: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, creator: w.buyer.publicKey, workerAuthority: w.provider.publicKey, authority: w.admin.publicKey, creatorCompletionBond: f.creatorBond, workerCompletionBond: f.workerBond, bondTreasury: w.admin.publicKey, systemProgram: SystemProgram.programId })
    .remainingAccounts(signerMetas).instruction(), [w.admin, owner2]), "resolve reject");
  assert.ok(decode(w.svm, "Task", f.task).status.Cancelled !== undefined, "task Cancelled (rejection upheld)");
  assert.ok(isClosed(w.svm, f.escrow), "escrow refunded + closed");
  assert.ok(Number(w.svm.getBalance(w.buyer.publicKey)) - buyerBefore >= f.reward, "creator refunded the reward");
  assert.ok(isClosed(w.svm, f.workerBond), "worker bond forfeited + closed");
  assert.ok(isClosed(w.svm, f.creatorBond), "creator bond refunded + closed");
});

test("expire_reject_frozen: after the review window defaults to the worker + refunds both bonds (permissionless, exit-safe)", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const f = await setupFrozen(w, { postBonds: true });
  const cleaner = Keypair.generate(); w.svm.airdrop(cleaner.publicKey, BigInt(10e9));
  const expireIx = async () => makeProgram(cleaner).methods.expireRejectFrozen()
    .accounts({ task: f.task, claim: f.claim, escrow: f.escrow, taskSubmission: f.submission, worker: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, creator: w.buyer.publicKey, workerAuthority: w.provider.publicKey, authority: cleaner.publicKey, creatorCompletionBond: f.creatorBond, workerCompletionBond: f.workerBond, systemProgram: SystemProgram.programId }).instruction();

  // before the review window lapses -> rejected.
  expectFail(send(w.svm, await expireIx(), [cleaner]), "RejectFrozenTimeoutNotElapsed", "expire too early");

  // warp past the review window (3600s) + pause to prove exit-safety.
  const clk = w.svm.getClock(); clk.unixTimestamp = clk.unixTimestamp + 4000n; w.svm.setClock(clk);
  await setProtocolPaused(w.svm, true);
  const workerBefore = Number(w.svm.getBalance(w.provider.publicKey));
  w.svm.expireBlockhash();
  expectOk(send(w.svm, await expireIx(), [cleaner]), "expire after window while paused");
  assert.ok(decode(w.svm, "Task", f.task).status.Completed !== undefined, "task defaults to worker (Completed)");
  assert.ok(Number(w.svm.getBalance(w.provider.publicKey)) > workerBefore, "worker paid on timeout");
  assert.ok(isClosed(w.svm, f.workerBond) && isClosed(w.svm, f.creatorBond), "both bonds refunded on no-fault timeout");
});

test("3-way split: max operator fee (20%) settles with the worker still above the 60% floor", async () => {
  const operatorKp = Keypair.generate();
  const w = await freshWorld({ moderationEnabled: true, price: 5_000_000, operator: operatorKp.publicKey, operatorFeeBps: 2000 });
  const r = await runHireSettlement(w);
  const operatorDelta = Number(w.svm.getBalance(operatorKp.publicKey)) - r.operatorBalBefore;
  assert.equal(operatorDelta, Math.floor((r.reward * 2000) / 10000), "operator gets exactly 20% at the cap"); // 1_000_000
  const workerDelta = Number(w.svm.getBalance(w.provider.publicKey)) - r.workerBalBefore;
  assert.ok(workerDelta >= Math.floor(r.reward * 0.6), `worker keeps >=60% at the cap (got ${workerDelta} of ${r.reward})`);
  assert.ok(isClosed(w.svm, r.escrow), "escrow closed");
});

test("close_task children: a program-owned non-child remaining account is rejected", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 2_000_000 });
  const r = await runHireSettlement(w); // Completed -> task closable; jobSpec + live hireRecord remain
  // Pass the ServiceListing (program-owned, but NOT one of the three task-child types)
  // as a remaining account: it must be rejected, not closed.
  const closeIx = await w.buyerProg.methods
    .closeTask()
    .accounts({ task: r.task, taskJobSpec: r.jobSpec, escrow: null, hireRecord: r.hireRecord, listing: w.listing, authority: w.buyer.publicKey })
    .remainingAccounts([{ pubkey: w.listing, isSigner: false, isWritable: true }])
    .instruction();
  expectFail(send(w.svm, closeIx, [w.buyer]), "InvalidInput", "close_task rejects a non-child remaining account");
  assert.ok(!isClosed(w.svm, r.task), "task NOT closed (tx reverted)");
});

test("dispute: initiate -> expire settles the escrow while the protocol is paused (exit-safe)", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 3_000_000 });
  const r = await runHireSettlement(w, { stopBeforeComplete: true }); // claimed task, InProgress

  // worker initiates a dispute on their claimed task
  const taskId = decode(w.svm, "Task", r.task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.provider.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .initiateDispute(arr(disputeId), arr(taskId), arr(Buffer.alloc(32, 1)), 0, "evidence")
    .accounts({ dispute, task: r.task, agent: w.providerAgent, authorityRateLimit: rateLimit, protocolConfig: w.protocolPda, initiatorClaim: r.claim, workerAgent: null, workerClaim: null, taskSubmission: null, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "initiate_dispute");
  assert.ok(decode(w.svm, "Task", r.task).status.Disputed !== undefined, "task is Disputed");
  assert.ok(decode(w.svm, "Dispute", dispute).status.Active !== undefined, "dispute is Active");

  // warp past max_dispute_duration, pause, then expire (permissionless last-resort exit).
  const clk = w.svm.getClock();
  clk.unixTimestamp = clk.unixTimestamp + 604800n + 100n;
  w.svm.setClock(clk);
  await setProtocolPaused(w.svm, true);

  expectOk(send(w.svm, await w.providerProg.methods
    .expireDispute()
    .accounts({ dispute, task: r.task, escrow: r.escrow, protocolConfig: w.protocolPda, creator: w.buyer.publicKey, authority: w.provider.publicKey, workerClaim: r.claim, worker: w.providerAgent, workerWallet: w.provider.publicKey, hireRecord: r.hireRecord, disputeOperator: null, tokenEscrowAta: null, creatorTokenAccount: null, workerTokenAccountAta: null, rewardMint: null, tokenProgram: null, creatorCompletionBond: null, workerCompletionBond: null })
    .instruction(), [w.provider]), "expire_dispute while paused");

  // exit-safe: the escrow is settled (closed) and the dispute is no longer Active,
  // despite the protocol being paused (money never locks).
  assert.ok(isClosed(w.svm, r.escrow), "escrow settled by expire_dispute while paused");
  assert.ok(decode(w.svm, "Dispute", dispute).status.Active === undefined, "dispute no longer Active");
});

/// Drive an SPL-token task through Auto settlement: mint a token, fund the buyer,
/// create_task(reward_mint) (which CPI-creates + funds the token escrow ATA), moderate
/// -> publish -> claim -> complete_task with token accounts. Returns the token ATAs.
async function runTokenSettlement(w, { reward = 5_000_000 } = {}) {
  const modProg = makeProgram(w.modAuth);

  // 1) create + init the mint (admin is the mint authority, 0 decimals).
  const mint = Keypair.generate();
  const rent = Number(w.svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE)));
  expectOk(sendMany(w.svm, [
    SystemProgram.createAccount({ fromPubkey: w.admin.publicKey, newAccountPubkey: mint.publicKey, lamports: rent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeMintInstruction(mint.publicKey, 0, w.admin.publicKey, null),
  ], [w.admin, mint]), "token:mint");

  // 2) buyer (creator) ATA funded with the reward; treasury + worker ATAs (must pre-exist).
  const buyerAta = getAssociatedTokenAddressSync(mint.publicKey, w.buyer.publicKey);
  const treasuryAta = getAssociatedTokenAddressSync(mint.publicKey, w.admin.publicKey);
  const workerAta = getAssociatedTokenAddressSync(mint.publicKey, w.provider.publicKey);
  expectOk(sendMany(w.svm, [
    createAssociatedTokenAccountInstruction(w.admin.publicKey, buyerAta, w.buyer.publicKey, mint.publicKey),
    createAssociatedTokenAccountInstruction(w.admin.publicKey, treasuryAta, w.admin.publicKey, mint.publicKey),
    createAssociatedTokenAccountInstruction(w.admin.publicKey, workerAta, w.provider.publicKey, mint.publicKey),
    createMintToInstruction(mint.publicKey, buyerAta, w.admin.publicKey, reward),
  ], [w.admin]), "token:atas+fund");

  // 3) create_task with reward_mint (create_task CPI-creates + funds the escrow ATA).
  const taskId = id32();
  const [task] = pda([enc("task"), w.buyer.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  const escrowAta = getAssociatedTokenAddressSync(mint.publicKey, escrow, true);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0);
  expectOk(send(w.svm, await w.buyerProg.methods
    .createTask(arr(taskId), new BN(1), arr(desc), new BN(reward), 1, new BN(now + 3600), 0, null, 0, mint.publicKey)
    .accounts({ task, escrow, protocolConfig: w.protocolPda, creatorAgent: w.buyerAgent, authorityRateLimit: rateLimit, authority: w.buyer.publicKey, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId, rewardMint: mint.publicKey, creatorTokenAccount: buyerAta, tokenEscrowAta: escrowAta, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID })
    .instruction(), [w.buyer]), "token:create_task");

  // 4) moderate -> publish -> claim
  const jobHash = id32();
  const [taskMod] = pda([enc("task_moderation"), task.toBuffer(), Buffer.from(jobHash)]);
  const [jobSpec] = pda([enc("task_job_spec"), task.toBuffer()]);
  expectOk(send(w.svm, await modProg.methods
    .recordTaskModeration(arr(jobHash), 0, 0, new BN(0), arr(Buffer.alloc(32, 1)), arr(Buffer.alloc(32, 2)), new BN(0))
    .accounts({ moderationConfig: w.modCfg, task, taskModeration: taskMod, moderator: w.modAuth.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.modAuth]), "token:task-mod");
  expectOk(send(w.svm, await w.buyerProg.methods
    .setTaskJobSpec(arr(jobHash), "agenc://job-spec/sha256/token")
    .accounts({ protocolConfig: w.protocolPda, task, moderationConfig: w.modCfg, taskModeration: taskMod, taskJobSpec: jobSpec, creator: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "token:publish");
  const [claim] = pda([enc("claim"), task.toBuffer(), w.providerAgent.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .claimTaskWithJobSpec()
    .accounts({ task, taskJobSpec: jobSpec, claim, protocolConfig: w.protocolPda, worker: w.providerAgent, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "token:claim");

  // 5) complete_task with token accounts (operator leg is SOL-only -> none here).
  const [hireRecord] = pda([enc("hire"), task.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .completeTask(arr(id32()), null)
    .accounts({ task, claim, escrow, creator: w.buyer.publicKey, worker: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.provider.publicKey, systemProgram: SystemProgram.programId, tokenEscrowAta: escrowAta, workerTokenAccount: workerAta, treasuryTokenAccount: treasuryAta, rewardMint: mint.publicKey, tokenProgram: TOKEN_PROGRAM_ID, hireRecord, operator: null, creatorCompletionBond: null, workerCompletionBond: null })
    .instruction(), [w.provider]), "token:complete");

  return { task, escrow, mint: mint.publicKey, buyerAta, treasuryAta, workerAta, escrowAta, reward };
}

test("SPL-token settlement: complete pays worker + treasury in tokens (conservation), closes token escrow", async () => {
  const w = await freshWorld({ moderationEnabled: true });
  const r = await runTokenSettlement(w, { reward: 5_000_000 });

  const t = decode(w.svm, "Task", r.task);
  assert.ok(t.status.Completed !== undefined, `task Completed (got ${JSON.stringify(t.status)})`);
  const workerTok = tokenAmount(w.svm, r.workerAta);
  const treasuryTok = tokenAmount(w.svm, r.treasuryAta);
  assert.ok(workerTok > 0n, "worker received reward tokens");
  assert.ok(treasuryTok > 0n, "treasury received the protocol fee in tokens");
  assert.equal(workerTok + treasuryTok, BigInt(r.reward), "worker + treasury == reward (token conservation)");
  assert.ok(isClosed(w.svm, r.escrowAta), "token escrow ATA closed on completion");
  assert.ok(isClosed(w.svm, r.escrow), "escrow PDA closed on completion");
});

test("dispute: resolve via arbiter quorum settles while the protocol is paused (exit-safe)", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 3_000_000 });
  const r = await runHireSettlement(w, { stopBeforeComplete: true }); // claimed task, InProgress

  // worker opens a dispute
  const taskId = decode(w.svm, "Task", r.task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [initRate] = pda([enc("authority_rate_limit"), w.provider.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .initiateDispute(arr(disputeId), arr(taskId), arr(Buffer.alloc(32, 1)), 0, "evidence")
    .accounts({ dispute, task: r.task, agent: w.providerAgent, authorityRateLimit: initRate, protocolConfig: w.protocolPda, initiatorClaim: r.claim, workerAgent: null, workerClaim: null, taskSubmission: null, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "resolve:initiate");

  // 3 distinct arbiters (ARBITER capability = 1<<7) register + vote -> reach quorum.
  // resolve_dispute needs the (vote, arbiter) pairs passed as remaining_accounts.
  const arbiterRemaining = [];
  for (let i = 0; i < 3; i++) {
    const arb = Keypair.generate();
    w.svm.airdrop(arb.publicKey, BigInt(10e9));
    const arbProg = makeProgram(arb);
    const arbId = id32();
    const [arbAgent] = pda([enc("agent"), arbId]);
    expectOk(send(w.svm, await arbProg.methods
      .registerAgent(arr(arbId), new BN(128), "http://arb.test", null, new BN(0))
      .accounts({ agent: arbAgent, protocolConfig: w.protocolPda, authority: arb.publicKey, systemProgram: SystemProgram.programId })
      .instruction(), [arb]), `resolve:register-arb${i}`);
    const [vote] = pda([enc("vote"), dispute.toBuffer(), arbAgent.toBuffer()]);
    const [authVote] = pda([enc("authority_vote"), dispute.toBuffer(), arb.publicKey.toBuffer()]);
    expectOk(send(w.svm, await arbProg.methods
      .voteDispute(true)
      .accounts({ dispute, task: r.task, workerClaim: null, defendantAgent: null, vote, authorityVote: authVote, arbiter: arbAgent, protocolConfig: w.protocolPda, authority: arb.publicKey, systemProgram: SystemProgram.programId })
      .instruction(), [arb]), `resolve:vote${i}`);
    arbiterRemaining.push({ pubkey: vote, isSigner: false, isWritable: true });
    arbiterRemaining.push({ pubkey: arbAgent, isSigner: false, isWritable: true });
  }

  // resolve while paused — exit-safe (money never locks).
  // warp past the voting period (86400s) but before the dispute expiry (604800s),
  // then resolve while paused, signed by the protocol authority (admin) — exit-safe.
  const clk = w.svm.getClock();
  clk.unixTimestamp = clk.unixTimestamp + 86400n + 100n;
  w.svm.setClock(clk);
  await setProtocolPaused(w.svm, true);
  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .resolveDispute()
    .accounts({ dispute, task: r.task, escrow: r.escrow, protocolConfig: w.protocolPda, authority: w.admin.publicKey, creator: w.buyer.publicKey, workerClaim: r.claim, worker: w.providerAgent, workerWallet: w.provider.publicKey, hireRecord: r.hireRecord, disputeOperator: null, systemProgram: SystemProgram.programId, tokenEscrowAta: null, creatorTokenAccount: null, workerTokenAccountAta: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, creatorCompletionBond: null, workerCompletionBond: null, bondTreasury: null })
    .remainingAccounts(arbiterRemaining)
    .instruction(), [w.admin]), "resolve_dispute while paused");

  assert.ok(decode(w.svm, "Dispute", dispute).status.Active === undefined, "dispute resolved (no longer Active) while paused");
  assert.ok(decode(w.svm, "Task", r.task).status.Disputed === undefined, "task left Disputed after resolve");
});

test("operator-fee protection: resolve_dispute Complete pays the operator its cut (dispute can't bypass the §4 split)", async () => {
  // Audit regression: resolve_dispute / expire_dispute paid the worker directly,
  // bypassing the operator leg that complete_task enforces. A hired task settled via
  // a Complete dispute must still carve the operator fee. Revert-sensitive: drop the
  // operator carve in resolve_dispute and the two equalities below go red.
  const operatorKp = Keypair.generate();
  const w = await freshWorld({ moderationEnabled: true, price: 3_000_000, operator: operatorKp.publicKey, operatorFeeBps: 1000 });
  await setMinArbiterStake(w.svm, 1_000_000); // arbiter votes must carry weight to reach approval
  const r = await runHireSettlement(w, { stopBeforeComplete: true }); // claimed, InProgress, live hire w/ 10% operator fee

  // worker opens a Complete dispute (resolution_type 1 = Complete -> worker is paid).
  const taskId = decode(w.svm, "Task", r.task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [initRate] = pda([enc("authority_rate_limit"), w.provider.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .initiateDispute(arr(disputeId), arr(taskId), arr(Buffer.alloc(32, 1)), 1, "evidence")
    .accounts({ dispute, task: r.task, agent: w.providerAgent, authorityRateLimit: initRate, protocolConfig: w.protocolPda, initiatorClaim: r.claim, workerAgent: null, workerClaim: null, taskSubmission: null, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "op-resolve:initiate Complete");

  // 3 arbiters approve (vote for) -> quorum -> Complete executes.
  const arbiterRemaining = [];
  for (let i = 0; i < 3; i++) {
    const arb = Keypair.generate();
    w.svm.airdrop(arb.publicKey, BigInt(10e9));
    const arbProg = makeProgram(arb);
    const arbId = id32();
    const [arbAgent] = pda([enc("agent"), arbId]);
    expectOk(send(w.svm, await arbProg.methods
      .registerAgent(arr(arbId), new BN(128), "http://arb.test", null, new BN(0))
      .accounts({ agent: arbAgent, protocolConfig: w.protocolPda, authority: arb.publicKey, systemProgram: SystemProgram.programId })
      .instruction(), [arb]), `op-resolve:register-arb${i}`);
    await injectAgentStake(w.svm, arbAgent, 1_000_000); // vote weight
    const [vote] = pda([enc("vote"), dispute.toBuffer(), arbAgent.toBuffer()]);
    const [authVote] = pda([enc("authority_vote"), dispute.toBuffer(), arb.publicKey.toBuffer()]);
    expectOk(send(w.svm, await arbProg.methods
      .voteDispute(true)
      .accounts({ dispute, task: r.task, workerClaim: null, defendantAgent: null, vote, authorityVote: authVote, arbiter: arbAgent, protocolConfig: w.protocolPda, authority: arb.publicKey, systemProgram: SystemProgram.programId })
      .instruction(), [arb]), `op-resolve:vote${i}`);
    arbiterRemaining.push({ pubkey: vote, isSigner: false, isWritable: true });
    arbiterRemaining.push({ pubkey: arbAgent, isSigner: false, isWritable: true });
  }

  // warp past the voting period and resolve as the protocol authority.
  const clk = w.svm.getClock();
  clk.unixTimestamp = clk.unixTimestamp + 86400n + 100n;
  w.svm.setClock(clk);

  const workerBalBefore = Number(w.svm.getBalance(w.provider.publicKey));
  const operatorBalBefore = Number(w.svm.getBalance(operatorKp.publicKey));
  // resolve_dispute also closes the worker_claim and refunds its rent to the worker
  // wallet, so the worker delta = worker_net + claim rent. Capture the rent for an exact check.
  const claimRentBefore = Number(w.svm.getBalance(r.claim));

  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .resolveDispute()
    .accounts({ dispute, task: r.task, escrow: r.escrow, protocolConfig: w.protocolPda, authority: w.admin.publicKey, creator: w.buyer.publicKey, workerClaim: r.claim, worker: w.providerAgent, workerWallet: w.provider.publicKey, hireRecord: r.hireRecord, disputeOperator: operatorKp.publicKey, systemProgram: SystemProgram.programId, tokenEscrowAta: null, creatorTokenAccount: null, workerTokenAccountAta: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, creatorCompletionBond: null, workerCompletionBond: null, bondTreasury: null })
    .remainingAccounts(arbiterRemaining)
    .instruction(), [w.admin]), "op-resolve:resolve Complete");

  assert.ok(decode(w.svm, "Task", r.task).status.Completed !== undefined, "task Completed via dispute");

  // §4 split: operator fee = reward * 1000bps = 10%; worker gets the rest. Neither
  // the worker wallet nor the operator signed this tx, so the deltas are exact.
  const expectedOpFee = Math.floor(r.reward / 10);          // 3_000_000 * 1000 / 10000
  const expectedWorkerNet = r.reward - expectedOpFee;       // 2_700_000
  const operatorDelta = Number(w.svm.getBalance(operatorKp.publicKey)) - operatorBalBefore;
  const workerDelta = Number(w.svm.getBalance(w.provider.publicKey)) - workerBalBefore;
  assert.equal(operatorDelta, expectedOpFee, `operator paid its cut on dispute Complete (got ${operatorDelta})`);
  assert.equal(workerDelta, expectedWorkerNet + claimRentBefore, `worker paid reward minus operator fee plus claim rent (got ${workerDelta})`);
});

test("completion bond: resolve_dispute Complete refunds the worker bond + forfeits the creator bond to treasury", async () => {
  // Worker wins (Complete) -> worker bond refunded, creator (loser) bond forfeited to
  // treasury. Revert-sensitive: without the disposition both bonds stay open.
  const w = await freshWorld({ moderationEnabled: true, price: 4_000_000 });
  await setMinArbiterStake(w.svm, 1_000_000);
  const r = await runHireSettlement(w, { stopBeforeComplete: true });

  const creatorBond = pda([enc("completion_bond"), r.task.toBuffer(), w.buyer.publicKey.toBuffer()])[0];
  const workerBond = pda([enc("completion_bond"), r.task.toBuffer(), w.provider.publicKey.toBuffer()])[0];
  expectOk(send(w.svm, await w.buyerProg.methods.postCompletionBond(0)
    .accounts({ task: r.task, completionBond: creatorBond, authority: w.buyer.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.buyer]), "creator bond");
  expectOk(send(w.svm, await w.providerProg.methods.postCompletionBond(1)
    .accounts({ task: r.task, completionBond: workerBond, authority: w.provider.publicKey, systemProgram: SystemProgram.programId }).instruction(), [w.provider]), "worker bond");
  const bondPrincipal = Math.floor(r.reward / 4); // 25% = 1,000,000

  // worker opens a Complete dispute; 3 staked arbiters approve.
  const taskId = decode(w.svm, "Task", r.task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [initRate] = pda([enc("authority_rate_limit"), w.provider.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.providerProg.methods
    .initiateDispute(arr(disputeId), arr(taskId), arr(Buffer.alloc(32, 1)), 1, "evidence")
    .accounts({ dispute, task: r.task, agent: w.providerAgent, authorityRateLimit: initRate, protocolConfig: w.protocolPda, initiatorClaim: r.claim, workerAgent: null, workerClaim: null, taskSubmission: null, authority: w.provider.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.provider]), "bond-resolve:initiate");
  const arbiterRemaining = [];
  for (let i = 0; i < 3; i++) {
    const arb = Keypair.generate();
    w.svm.airdrop(arb.publicKey, BigInt(10e9));
    const arbId = id32();
    const [arbAgent] = pda([enc("agent"), arbId]);
    expectOk(send(w.svm, await makeProgram(arb).methods.registerAgent(arr(arbId), new BN(128), "http://arb.test", null, new BN(0))
      .accounts({ agent: arbAgent, protocolConfig: w.protocolPda, authority: arb.publicKey, systemProgram: SystemProgram.programId }).instruction(), [arb]), `bond-resolve:reg${i}`);
    await injectAgentStake(w.svm, arbAgent, 1_000_000);
    const [vote] = pda([enc("vote"), dispute.toBuffer(), arbAgent.toBuffer()]);
    const [authVote] = pda([enc("authority_vote"), dispute.toBuffer(), arb.publicKey.toBuffer()]);
    expectOk(send(w.svm, await makeProgram(arb).methods.voteDispute(true)
      .accounts({ dispute, task: r.task, workerClaim: null, defendantAgent: null, vote, authorityVote: authVote, arbiter: arbAgent, protocolConfig: w.protocolPda, authority: arb.publicKey, systemProgram: SystemProgram.programId }).instruction(), [arb]), `bond-resolve:vote${i}`);
    arbiterRemaining.push({ pubkey: vote, isSigner: false, isWritable: true }, { pubkey: arbAgent, isSigner: false, isWritable: true });
  }
  const clk = w.svm.getClock();
  clk.unixTimestamp = clk.unixTimestamp + 86400n + 100n;
  w.svm.setClock(clk);

  const treasuryBefore = Number(w.svm.getBalance(w.admin.publicKey));
  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .resolveDispute()
    .accounts({ dispute, task: r.task, escrow: r.escrow, protocolConfig: w.protocolPda, authority: w.admin.publicKey, creator: w.buyer.publicKey, workerClaim: r.claim, worker: w.providerAgent, workerWallet: w.provider.publicKey, hireRecord: r.hireRecord, disputeOperator: null, systemProgram: SystemProgram.programId, tokenEscrowAta: null, creatorTokenAccount: null, workerTokenAccountAta: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, creatorCompletionBond: creatorBond, workerCompletionBond: workerBond, bondTreasury: w.admin.publicKey })
    .remainingAccounts(arbiterRemaining)
    .instruction(), [w.admin]), "bond-resolve:resolve Complete");

  assert.ok(decode(w.svm, "Task", r.task).status.Completed !== undefined, "task Completed");
  assert.ok(isClosed(w.svm, creatorBond), "creator (loser) bond closed");
  assert.ok(isClosed(w.svm, workerBond), "worker (winner) bond closed");
  // treasury (admin) is also the resolver/fee-payer, so its delta is the forfeited
  // creator-bond principal minus the tx fee — well within 50k of the principal.
  const treasuryDelta = Number(w.svm.getBalance(w.admin.publicKey)) - treasuryBefore;
  assert.ok(treasuryDelta > bondPrincipal - 50_000 && treasuryDelta <= bondPrincipal,
    `creator bond forfeited to treasury (delta ${treasuryDelta}, principal ${bondPrincipal})`);
});

test("dispute: apply_dispute_slash slashes the losing worker while the protocol is paused (exit-safe)", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 3_000_000 });
  await setMinArbiterStake(w.svm, 1_000_000); // arbiter votes carry weight
  const r = await runHireSettlement(w, { stopBeforeComplete: true }); // claimed task, InProgress
  await injectAgentStake(w.svm, w.providerAgent, 2_000_000); // worker has a slashable stake

  // CREATOR opens a Refund dispute against the worker (resolution_type 0 = Refund).
  const taskId = decode(w.svm, "Task", r.task).task_id;
  const disputeId = id32();
  const [dispute] = pda([enc("dispute"), Buffer.from(disputeId)]);
  const [buyerRate] = pda([enc("authority_rate_limit"), w.buyer.publicKey.toBuffer()]);
  expectOk(send(w.svm, await w.buyerProg.methods
    .initiateDispute(arr(disputeId), arr(taskId), arr(Buffer.alloc(32, 1)), 0, "bad work")
    .accounts({ dispute, task: r.task, agent: w.buyerAgent, authorityRateLimit: buyerRate, protocolConfig: w.protocolPda, initiatorClaim: null, workerAgent: w.providerAgent, workerClaim: r.claim, taskSubmission: null, authority: w.buyer.publicKey, systemProgram: SystemProgram.programId })
    .instruction(), [w.buyer]), "slash:initiate");

  // 3 staked arbiters approve (worker loses).
  const arbiterRemaining = [];
  for (let i = 0; i < 3; i++) {
    const arb = Keypair.generate();
    w.svm.airdrop(arb.publicKey, BigInt(10e9));
    const arbProg = makeProgram(arb);
    const arbId = id32();
    const [arbAgent] = pda([enc("agent"), arbId]);
    expectOk(send(w.svm, await arbProg.methods
      .registerAgent(arr(arbId), new BN(128), "http://arb.test", null, new BN(0))
      .accounts({ agent: arbAgent, protocolConfig: w.protocolPda, authority: arb.publicKey, systemProgram: SystemProgram.programId })
      .instruction(), [arb]), `slash:register-arb${i}`);
    await injectAgentStake(w.svm, arbAgent, 1_000_000); // vote weight
    const [vote] = pda([enc("vote"), dispute.toBuffer(), arbAgent.toBuffer()]);
    const [authVote] = pda([enc("authority_vote"), dispute.toBuffer(), arb.publicKey.toBuffer()]);
    expectOk(send(w.svm, await arbProg.methods
      .voteDispute(true)
      .accounts({ dispute, task: r.task, workerClaim: r.claim, defendantAgent: w.providerAgent, vote, authorityVote: authVote, arbiter: arbAgent, protocolConfig: w.protocolPda, authority: arb.publicKey, systemProgram: SystemProgram.programId })
      .instruction(), [arb]), `slash:vote${i}`);
    arbiterRemaining.push({ pubkey: vote, isSigner: false, isWritable: true });
    arbiterRemaining.push({ pubkey: arbAgent, isSigner: false, isWritable: true });
  }

  // warp past the voting period, resolve (worker loses, slash deferred).
  const clk = w.svm.getClock();
  clk.unixTimestamp = clk.unixTimestamp + 86400n + 100n;
  w.svm.setClock(clk);
  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .resolveDispute()
    .accounts({ dispute, task: r.task, escrow: r.escrow, protocolConfig: w.protocolPda, authority: w.admin.publicKey, creator: w.buyer.publicKey, workerClaim: r.claim, worker: w.providerAgent, workerWallet: w.provider.publicKey, hireRecord: r.hireRecord, disputeOperator: null, systemProgram: SystemProgram.programId, tokenEscrowAta: null, creatorTokenAccount: null, workerTokenAccountAta: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, creatorCompletionBond: null, workerCompletionBond: null, bondTreasury: null })
    .remainingAccounts(arbiterRemaining)
    .instruction(), [w.admin]), "slash:resolve");
  assert.ok(decode(w.svm, "Dispute", dispute).status.Resolved !== undefined, "dispute Resolved (worker lost)");
  const stakeBefore = Number(decode(w.svm, "AgentRegistration", w.providerAgent).stake);

  // apply the stake slash WHILE PAUSED — the finalizer that has no alternative unwind.
  await setProtocolPaused(w.svm, true);
  expectOk(send(w.svm, await makeProgram(w.admin).methods
    .applyDisputeSlash()
    .accounts({ dispute, task: r.task, workerClaim: r.claim, workerAgent: w.providerAgent, protocolConfig: w.protocolPda, treasury: w.admin.publicKey, authority: w.admin.publicKey, escrow: null, tokenEscrowAta: null, treasuryTokenAccount: null, rewardMint: null, tokenProgram: null, creatorCompletionBond: null, workerCompletionBond: null, bondTreasury: null })
    .instruction(), [w.admin]), "slash:apply_dispute_slash while paused");

  const stakeAfter = Number(decode(w.svm, "AgentRegistration", w.providerAgent).stake);
  assert.ok(stakeAfter < stakeBefore, `worker stake slashed while paused (${stakeBefore} -> ${stakeAfter})`);
});

test("create_task_humanless: a wallet with no agent posts a task pinned to CreatorReview", async () => {
  const w = await freshWorld({});
  const human = Keypair.generate(); // NO AgentRegistration
  w.svm.airdrop(human.publicKey, BigInt(100e9));
  const humanProg = makeProgram(human);

  const taskId = id32();
  const [task] = pda([enc("task"), human.publicKey.toBuffer(), Buffer.from(taskId)]);
  const [escrow] = pda([enc("escrow"), task.toBuffer()]);
  const [validation] = pda([enc("task_validation"), task.toBuffer()]);
  const [rateLimit] = pda([enc("authority_rate_limit"), human.publicKey.toBuffer()]);
  const now = Number(w.svm.getClock().unixTimestamp);
  const desc = Buffer.alloc(64);
  desc.set(crypto.randomBytes(32), 0); // hash-shaped commitment (32 + zero tail)

  const ix = await humanProg.methods
    .createTaskHumanless(arr(taskId), new BN(1), arr(desc), new BN(2_000_000), new BN(now + 3600), 0, new BN(3600))
    .accounts({ task, escrow, taskValidationConfig: validation, protocolConfig: w.protocolPda, authorityRateLimit: rateLimit, creator: human.publicKey, systemProgram: SystemProgram.programId })
    .instruction();
  expectOk(send(w.svm, ix, [human]), "humanless create");

  const t = decode(w.svm, "Task", task);
  assert.equal(t.creator.toBase58(), human.publicKey.toBase58(), "human wallet is the creator");
  assert.ok(t.status.Open !== undefined, "task starts Open");
  assert.equal(t.reward_amount.toString(), "2000000");
  assert.equal(decode(w.svm, "TaskEscrow", escrow).amount.toString(), "2000000", "escrow funded");

  const vc = decode(w.svm, "TaskValidationConfig", validation);
  assert.ok(vc.CreatorReview !== undefined || vc.mode?.creatorReview !== undefined || vc.mode?.CreatorReview !== undefined, `validation mode is CreatorReview (got ${JSON.stringify(vc.mode)})`);
});

test("exit allow-list: a paused protocol blocks new hires but still lets a hired task be cancelled", async () => {
  const w = await freshWorld({ price: 1_500_000 });
  const { ix, task, escrow } = await hireIx(w, {});
  expectOk(send(w.svm, ix, [w.buyer]), "hire (before pause)");

  // Pause the protocol AFTER the task is escrowed.
  await setProtocolPaused(w.svm, true);

  // Sanity: the pause is real — a NEW hire (entry path) is rejected. This proves
  // the cancel-succeeds assertion below isn't passing vacuously.
  const blocked = await hireIx(w, {}); // fresh task id
  expectFail(send(w.svm, blocked.ix, [w.buyer]), "ProtocolPaused", "entry blocked while paused");

  // Exit path: cancelling the escrowed task must still succeed while paused —
  // money never locks (spec §7, exit allow-list). Without the exit variant this
  // would fail with ProtocolPaused.
  const cancelIx = await w.buyerProg.methods
    .cancelTask()
    .accounts({
      task, escrow, authority: w.buyer.publicKey, protocolConfig: w.protocolPda,
      systemProgram: SystemProgram.programId,
      tokenEscrowAta: null, creatorTokenAccount: null, rewardMint: null, tokenProgram: null,
      creatorCompletionBond: null, workerCompletionBond: null, workerBondAuthority: null,
    })
    .instruction();
  expectOk(send(w.svm, cancelIx, [w.buyer]), "cancel under paused protocol");
  assert.ok(decode(w.svm, "Task", task).status.Cancelled !== undefined, "task is Cancelled even while paused");
  assert.ok(isClosed(w.svm, escrow), "escrow refunded/closed while paused");
});

test("close_task children: reclaims rent from a task_moderation child via remaining_accounts", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 2_000_000 });
  const r = await runHireSettlement(w); // Completed; leaves task, job spec, task_moderation, live hire_record
  assert.ok(!isClosed(w.svm, r.taskMod), "task_moderation present before close");
  assert.ok(!isClosed(w.svm, r.jobSpec), "task_job_spec present before close");

  const closeIx = await w.buyerProg.methods
    .closeTask()
    .accounts({ task: r.task, taskJobSpec: r.jobSpec, escrow: null, hireRecord: r.hireRecord, listing: w.listing, authority: w.buyer.publicKey })
    .remainingAccounts([{ pubkey: r.taskMod, isSigner: false, isWritable: true }])
    .instruction();
  expectOk(send(w.svm, closeIx, [w.buyer]), "close_task with moderation child");

  assert.ok(isClosed(w.svm, r.task), "task closed");
  assert.ok(isClosed(w.svm, r.jobSpec), "task_job_spec rent reclaimed");
  assert.ok(isClosed(w.svm, r.taskMod), "task_moderation rent reclaimed");
  assert.equal(decode(w.svm, "ServiceListing", w.listing).open_jobs, 0, "listing capacity freed");
});

test("close_task children: rejects a child PDA bound to a different task (anti-griefing)", async () => {
  const w = await freshWorld({ moderationEnabled: true, price: 2_000_000 });
  const a = await runHireSettlement(w); // task A + its task_moderation
  const b = await runHireSettlement(w); // task B + its task_moderation (same world)

  // Try to close task A while passing task B's moderation as a remaining account.
  const closeIx = await w.buyerProg.methods
    .closeTask()
    .accounts({ task: a.task, taskJobSpec: a.jobSpec, escrow: null, hireRecord: a.hireRecord, listing: w.listing, authority: w.buyer.publicKey })
    .remainingAccounts([{ pubkey: b.taskMod, isSigner: false, isWritable: true }])
    .instruction();
  expectFail(send(w.svm, closeIx, [w.buyer]), "InvalidInput", "close_task rejects another task's moderation child");

  // The whole tx reverted: task A is untouched and task B's moderation survives.
  assert.ok(!isClosed(w.svm, a.task), "task A NOT closed (tx reverted)");
  assert.ok(!isClosed(w.svm, b.taskMod), "task B moderation untouched");
});

test("negative: close_task rejects a non-terminal (Open) task", async () => {
  const w = await freshWorld({});
  const { ix, task, hireRecord } = await hireIx(w, {});
  expectOk(send(w.svm, ix, [w.buyer]), "hire");

  const closeIx = await w.buyerProg.methods
    .closeTask()
    .accounts({ task, taskJobSpec: null, escrow: null, hireRecord, listing: w.listing, authority: w.buyer.publicKey })
    .instruction();
  expectFail(send(w.svm, closeIx, [w.buyer]), "TaskNotClosable", "close Open task");
});
