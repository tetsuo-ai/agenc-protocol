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

/// Build a fully wired world ready to hire: protocol + provider/buyer agents + a listing.
async function freshWorld({ price = 1_000_000, maxOpenJobs = 0, capabilities = 1 } = {}) {
  const svm = new LiteSVM();
  svm.addProgramFromFile(PID, SO);

  const admin = Keypair.generate();
  const provider = Keypair.generate();
  const buyer = Keypair.generate();
  for (const kp of [admin, provider, buyer]) svm.airdrop(kp.publicKey, BigInt(100e9));

  const protocolPda = await injectProtocolConfig(svm, admin);

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
          null, // operator
          0, // operator_fee_bps
        )
        .accounts({ listing, providerAgent, protocolConfig: protocolPda, authority: provider.publicKey, systemProgram: SystemProgram.programId })
        .instruction(),
      [provider],
    ),
    "create listing",
  );

  return { svm, admin, provider, buyer, buyerProg, providerProg, protocolPda, providerAgent, buyerAgent, listing, listingId, price, specHash };
}

/// Build (but don't send) a hire_from_listing instruction for `buyer`.
async function hireIx(w, { taskId, expectedPrice, expectedVersion, asProvider = false } = {}) {
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
