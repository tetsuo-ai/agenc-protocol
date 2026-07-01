// Embeddable AgenC marketplace — end-to-end instruction-building walkthrough.
//
// This file is a REAL, COMPILING example: it type-checks against the published
// facade + generated builders (see `examples:check`). It assembles every
// instruction in the embeddable flow but never touches an RPC — signers are
// `createNoopSigner(...)` and every other account is an `address(...)`
// placeholder, exactly like the structural tests in tests/*.test.ts.
//
// To actually broadcast, you would swap the noop signers for real
// `TransactionSigner`s (e.g. a keypair or wallet adapter), pre-derive the PDAs
// you need to read, and feed each instruction into a transaction message built
// with @solana/kit (`createTransactionMessage`, `appendTransactionMessageInstructions`,
// `signAndSendTransaction`, ...). Instruction shapes do not change.
//
// Flow covered:
//   1. register a provider agent and a buyer agent
//   2. provider creates a standing service listing
//   3. buyer hires from the listing  (mints task + escrow in one instruction)
//   4. worker claims the task
//   5. both sides post a completion bond
//   6a. HAPPY PATH:  worker submits result -> creator accepts (settles escrow)
//   6b. DISPUTE PATH: creator rejects-and-freezes -> initiate dispute ->
//       resolve dispute with bond forfeiture -> reclaim the surviving bond
//
// Everything below comes from the package's public entry point
// (`@tetsuo-ai/marketplace-sdk`); in-repo it resolves through `../src/index.js`.
import { address, createNoopSigner } from "@solana/kit";
import {
  // facade: ergonomic, named instruction builders
  facade,
  // generated: PDA helpers used to pre-derive the addresses a hire mints
  findTaskPda,
  findEscrowPda,
  findHireRecordPda,
  findClaimPda,
} from "../src/index.js";
// values: domain-value helpers — random 32-byte ids, NFC description hashing,
// LISTING_METADATA v1 field codecs, and the kit-compatible json-stable-v1
// job-spec hash. (In a published integration: the `values` module of
// `@tetsuo-ai/marketplace-sdk`.)
import {
  randomId32,
  sha256,
  descriptionHash,
  canonicalJobSpecHash,
  encodeListingName,
  encodeListingCategory,
  encodeListingTags,
} from "../src/values/index.js";

// ---------------------------------------------------------------------------
// Placeholders. In a live integration these come from real keypairs / wallets
// and on-chain reads; here they are valid base58 addresses + noop signers so the
// builders produce a fully-typed instruction without an RPC.
// ---------------------------------------------------------------------------

// Signers (would be real wallets / keypairs in production).
const providerAuthority = createNoopSigner(
  address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK"),
);
const buyerAuthority = createNoopSigner(
  address("So11111111111111111111111111111111111111112"),
);
const workerAuthority = createNoopSigner(
  address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
);

// Plain (non-signer) account placeholders. In a real flow these are the agent
// PDAs returned by `findAgentPda`, the worker's agent registration, the
// protocol treasury, etc.
const providerAgent = address("4xTpJ4p76bAeggXoYywpCCNKfJspbuRzZ79R7zG6BfQB");
const buyerAgent = address("9Y8Nt5Z3sYTLNm6n5jKj7c5y8C2y2H8gPq4y6t9q1aA");
const workerAgent = address("Stake11111111111111111111111111111111111111");
const treasury = address("SysvarRent111111111111111111111111111111111");
const bondTreasury = address("SysvarC1ock11111111111111111111111111111111");

// 32-byte ids (caller-chosen): fresh CSPRNG output via the values module —
// ids seed PDAs, so they must never collide.
const providerAgentId = randomId32();
const buyerAgentId = randomId32();
const listingId = randomId32();
const taskId = randomId32();
const disputeId = randomId32();

// Fixed-width LISTING_METADATA v1 fields, encoded from plain strings (UTF-8,
// NUL-padded, length-checked — overflow and invalid kebab-case throw).
const listingName = encodeListingName("translation-service");
const listingCategory = encodeListingCategory("translation");
const listingTags = encodeListingTags(["english-to-french", "docs"]);

/**
 * Build every instruction in the embeddable flow and return them. Optionally
 * logs a count. No RPC: the point is that this assembles & type-checks against
 * the real facade API.
 */
export async function main() {
  // -- 0. Content hashes (values module) -----------------------------------
  // The listing's spec hash commits to the off-chain spec document with the
  // kit-compatible json-stable-v1 canonical-JSON hash, so the same payload
  // hashed by the marketplace kit / explorer verifies bit-for-bit.
  const { bytes: specHash } = await canonicalJobSpecHash({
    schemaVersion: 1,
    title: "Translate the API reference to French",
    deliverables: ["French markdown translation"],
  });
  // Free-text / URI commitments use the documented NFC + UTF-8 + SHA-256
  // description-hash convention; generic content (artifact bytes, result
  // payloads) uses plain sha256.
  const proofHash = await sha256("artifact:sha256:translated-docs-bundle-v1");
  const rejectionHash = await descriptionHash(
    "Sections 3-4 are missing from the delivered translation",
  );
  const evidenceHash = await descriptionHash("ipfs://dispute-evidence");

  // -- 1. Register the provider + buyer agents ----------------------------
  // The agent PDA auto-derives from agentId; only `authority` signs. In a live
  // flow you would derive the resulting PDA with `facade.findAgentPda` and read
  // it back, then reuse it as `providerAgent` / `buyerAgent` below.
  const registerProviderIx = await facade.registerAgent({
    authority: providerAuthority,
    agentId: providerAgentId,
    capabilities: 7n,
    endpoint: "https://provider.example/agent",
    metadataUri: null,
    stakeAmount: 0n,
  });

  const registerBuyerIx = await facade.registerAgent({
    authority: buyerAuthority,
    agentId: buyerAgentId,
    capabilities: 0n,
    endpoint: "https://buyer.example/agent",
    metadataUri: null,
    stakeAmount: 0n,
  });

  // -- 2. Provider publishes a standing service listing -------------------
  // The listing PDA (from providerAgent + listingId), protocolConfig, and
  // systemProgram all auto-derive; the caller supplies identity + terms.
  const createListingIx = await facade.createServiceListing({
    providerAgent,
    authority: providerAuthority,
    listingId,
    name: listingName,
    category: listingCategory,
    tags: listingTags,
    specHash,
    specUri: "ipfs://listing-spec",
    price: 1_000_000n, // lamports for a SOL-priced listing
    priceMint: null, // null = native SOL; pass a mint Address for SPL tokens
    requiredCapabilities: 4n,
    defaultDeadlineSecs: 86_400n,
    maxOpenJobs: 10,
    operator: null,
    operatorFeeBps: 0,
  });

  // The listing PDA the buyer will hire from (derived from provider + listingId).
  const [listing] = await facade.findListingPda({ providerAgent, listingId });

  // -- 3. Registered buyer hires from the listing -------------------------
  // hire_from_listing is the registered-agent buyer path: it mints the task +
  // escrow + hire-record in ONE instruction. Use hire_from_listing_humanless
  // for plain-wallet storefront checkout. Pass `listingSpecHash` so the
  // facade derives the moderation attestation PDA (fail-closed gate); omit it
  // only when the gate is disabled. `authority` must equal `creator` (#375).
  const hireIx = await facade.hireFromListing({
    listing,
    creatorAgent: buyerAgent,
    authority: buyerAuthority,
    creator: buyerAuthority,
    taskId,
    expectedPrice: 1_000_000n,
    expectedVersion: 1n,
    listingSpecHash: specHash,
  });

  // The hire mints a task whose PDA is seeded by (creator wallet, taskId). The
  // escrow and hire-record derive from that task; pre-derive them so the later
  // settlement instructions can reference the right accounts.
  const [task] = await findTaskPda({ creator: buyerAuthority.address, taskId });
  const [escrow] = await findEscrowPda({ task });
  const [hireRecord] = await findHireRecordPda({ task });
  // The worker's claim PDA (seeded by task + the worker's *agent* account).
  const [claim] = await findClaimPda({ task, bidder: workerAgent });
  void escrow; // escrow/protocolConfig auto-derive inside the settle builders.

  // -- 4. Worker claims the task ------------------------------------------
  // claim_task_with_job_spec pins the job-spec pointer (plain claim_task is
  // fail-closed). taskJobSpec, claim, and protocolConfig auto-derive.
  const claimIx = await facade.claimTaskWithJobSpec({
    task,
    worker: workerAgent,
    authority: workerAuthority,
  });

  // -- 5. Both parties post a completion bond -----------------------------
  // The bond PDA is keyed by the SIGNING wallet, so each side gets a distinct
  // PDA. `role` identifies the party (worker vs creator) per the program enum.
  const WORKER_ROLE = 0;
  const CREATOR_ROLE = 1;
  const workerBondIx = await facade.postCompletionBond({
    task,
    authority: workerAuthority,
    role: WORKER_ROLE,
  });
  const creatorBondIx = await facade.postCompletionBond({
    task,
    authority: buyerAuthority,
    role: CREATOR_ROLE,
  });

  // === 6a. HAPPY PATH: submit -> accept ==================================
  // Worker submits a result (proof hash + optional result blob). Claim,
  // validation config, submission, and protocol config auto-derive.
  const submitIx = await facade.submitTaskResult({
    task,
    worker: workerAgent,
    authority: workerAuthority,
    proofHash,
    resultData: null,
  });

  // Creator accepts the result and settles the escrow to the worker. Caller
  // supplies the settlement parties; claim/escrow/submission/protocol PDAs
  // auto-derive. (For an SPL-token task you'd also pass the token accounts.)
  const acceptIx = await facade.acceptTaskResult({
    task,
    worker: workerAgent,
    treasury,
    creator: buyerAuthority,
    workerAuthority: workerAuthority.address,
  });

  // === 6b. DISPUTE PATH: reject-and-freeze -> dispute -> resolve -> reclaim
  // (Mutually exclusive with the happy path on a live chain — shown here so the
  // example demonstrates assembling both branches.)
  //
  // Creator rejects-and-freezes the submission pending dispute. Validation
  // config, submission, and protocol config auto-derive from task/claim.
  const rejectAndFreezeIx = await facade.rejectAndFreeze({
    task,
    claim,
    creator: buyerAuthority,
    rejectionHash,
  });

  // The frozen task is escalated to a dispute. The dispute, rate-limit,
  // protocol-config, and initiator-claim PDAs auto-derive. Here the creator is
  // the initiator, so they name the worker agent + claim being disputed.
  const initiateDisputeIx = await facade.initiateDispute({
    task,
    agent: buyerAgent,
    authority: buyerAuthority,
    disputeId,
    taskId,
    evidenceHash,
    resolutionType: 1,
    evidence: "ipfs://dispute-evidence",
    workerAgent,
    workerClaim: claim,
  });
  const [dispute] = await facade.findDisputePda({ disputeId });

  // Resolve the dispute. `approve` is the resolver's decision (the protocol
  // authority, or an assigned dispute resolver, signs as `authority`): `true`
  // upholds the initiator's requested resolution_type, `false` refunds the creator.
  // The facade derives BOTH completion-bond PDAs (seeded by [task, creator] and
  // [task, worker-authority]) so the bond forfeit cannot be bypassed; the bond
  // treasury that receives forfeited bonds is explicit.
  const resolveDisputeIx = await facade.resolveDispute({
    dispute,
    task,
    authority: buyerAuthority,
    approve: true,
    // P6.4 accountable rulings: a reasoned ruling is required — `rationaleHash` is a
    // 32-byte content hash of the off-chain rationale; `rationaleUri` points at it
    // (empty string is allowed when the hash stands alone).
    rationaleHash: new Uint8Array(32).fill(7),
    rationaleUri: "agenc://ruling/sha256/example",
    creator: buyerAuthority.address,
    worker: workerAgent,
    workerWallet: workerAuthority.address,
    workerClaim: claim,
    hireRecord,
    bondTreasury,
  });

  // After resolution the prevailing party reclaims their surviving completion
  // bond. The reclaim flow derives its bond PDA from (task, party).
  const reclaimWorkerBondIx = await facade.reclaimCompletionBond({
    task,
    party: workerAuthority.address,
    role: WORKER_ROLE,
  });

  const instructions = [
    registerProviderIx,
    registerBuyerIx,
    createListingIx,
    hireIx,
    claimIx,
    workerBondIx,
    creatorBondIx,
    // happy path
    submitIx,
    acceptIx,
    // dispute path
    rejectAndFreezeIx,
    initiateDisputeIx,
    resolveDisputeIx,
    reclaimWorkerBondIx,
  ];

  // eslint-disable-next-line no-console
  console.log(`embeddable-marketplace: assembled ${instructions.length} instructions`);
  return instructions;
}

// Run when invoked directly (e.g. `tsx examples/embeddable-marketplace.ts`).
// Guarded so importing this module for its `main` export does not auto-run it.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  });
}
