// Embeddable AgenC marketplace — first-run instruction-building walkthrough.
//
// This file is a REAL, COMPILING example: it type-checks against the public
// facade + generated builders (see `examples:check`). It assembles the normal
// marketplace lifecycle but never touches an RPC — signers are
// `createNoopSigner(...)` and every other account is an `address(...)`
// placeholder, exactly like the structural tests in tests/*.test.ts.
//
// To actually broadcast, swap the noop signers for real `TransactionSigner`s
// (a keypair, wallet adapter, or signer service), pre-derive or read any PDAs
// you need to display, and feed each instruction into a transaction message
// built with @solana/kit. Instruction shapes do not change.
//
// Flow covered:
//   1. provider registers the worker agent
//   2. provider creates a standing service listing
//   3. human buyer hires the listing (mints task + escrow + HireRecord)
//   4. buyer activates the task by pinning a moderated job spec
//   5. provider agent claims with claim_task_with_job_spec
//   6. worker submits an artifact proof
//   7. buyer accepts, rates the hire, and closes the task to free capacity
//
// Advanced registered-agent hire, bonds, disputes, bids, governance, and ZK
// are available elsewhere in the facade/generated surface. They are not the
// first-run storefront path shown here.
//
// Everything below comes from the package's public entry point
// (`@tetsuo-ai/marketplace-sdk`); in-repo it resolves through `../src/index.js`.
import { address, createNoopSigner } from "@solana/kit";
import {
  // facade: ergonomic, named instruction builders
  facade,
  // generated: PDA helpers used to pre-derive addresses the flow mints/uses
  findCreatorCompletionBondPda,
  findHireRecordPda,
  findModerationBlockPda,
  findTaskPda,
} from "../src/index.js";
// values: domain-value helpers — random 32-byte ids, NFC description hashing,
// LISTING_METADATA v1 field codecs, and the kit-compatible json-stable-v1
// job-spec hash. (In a published integration: the `values` module of
// `@tetsuo-ai/marketplace-sdk`.)
import {
  canonicalJobSpecHash,
  descriptionHash,
  encodeListingCategory,
  encodeListingName,
  encodeListingTags,
  randomId32,
  sha256,
} from "../src/values/index.js";

// ---------------------------------------------------------------------------
// Placeholders. In a live integration these come from real keypairs / wallets
// and on-chain reads; here they are valid base58 addresses + noop signers so the
// builders produce fully-typed instructions without an RPC.
// ---------------------------------------------------------------------------

// Signers (would be real wallets / keypairs in production).
const providerAuthority = createNoopSigner(
  address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK"),
);
const buyerAuthority = createNoopSigner(
  address("So11111111111111111111111111111111111111112"),
);

// Plain (non-signer) account placeholders. In a real flow this is the
// AgentRegistration PDA returned by `findAgentPda`; the provider agent is also
// the worker that claims and submits the hired task.
const providerAgent = address("4xTpJ4p76bAeggXoYywpCCNKfJspbuRzZ79R7zG6BfQB");
const treasury = address("SysvarRent111111111111111111111111111111111");
// P1.2: the moderator whose attestations the hire/publish gates consume. In a
// live flow read `ModerationConfig.moderationAuthority` from chain (the global
// authority path), or use a registered attestor's pubkey with
// `moderatorIsAttestor: true`.
const moderationAuthority = address(
  "9Y8Nt5Z3sYTLNm6n5jKj7c5y8C2y2H8gPq4y6t9q1aA",
);

// 32-byte ids (caller-chosen): fresh CSPRNG output via the values module.
// ids seed PDAs, so they must never collide.
const providerAgentId = randomId32();
const listingId = randomId32();
const taskId = randomId32();

// Fixed-width LISTING_METADATA v1 fields, encoded from plain strings (UTF-8,
// NUL-padded, length-checked — overflow and invalid kebab-case throw).
const listingName = encodeListingName("translation-service");
const listingCategory = encodeListingCategory("translation");
const listingTags = encodeListingTags(["english-to-french", "docs"]);

/**
 * Build every instruction in the first-run marketplace flow and return them.
 * Optionally logs a count. No RPC: the point is that this assembles and
 * type-checks against the real facade API.
 */
export async function main() {
  // -- 0. Content hashes (values module) -----------------------------------
  // The listing's spec hash commits to the off-chain service document with the
  // kit-compatible json-stable-v1 canonical-JSON hash. The marketplace must
  // moderate this listing spec before a hire can pass the fail-closed gate.
  const { bytes: listingSpecHash } = await canonicalJobSpecHash({
    schemaVersion: 1,
    title: "Translate technical documentation",
    deliverables: ["French markdown translation"],
  });

  // The buyer's per-hire job spec is pinned only after escrow funding. The
  // marketplace/operator hosts it, moderates it, and records TaskModeration
  // before the buyer signs set_task_job_spec.
  const { bytes: jobSpecHash } = await canonicalJobSpecHash({
    schemaVersion: 1,
    title: "Translate the API reference to French",
    deliverables: ["French markdown translation", "Glossary of key terms"],
    acceptanceCriteria: ["All sections translated", "Markdown links preserved"],
  });

  // Generic content commitments use plain sha256; written review text uses the
  // documented description-hash convention.
  const proofHash = await sha256("artifact:sha256:translated-docs-bundle-v1");
  const reviewHash = await descriptionHash(
    "Great translation; links preserved.",
  );

  // -- 1. Provider registers the worker agent ------------------------------
  // The agent PDA auto-derives from agentId; only `authority` signs. In a live
  // flow you would derive the resulting PDA with `facade.findAgentPda` and read
  // it back, then reuse it as `providerAgent` below.
  const registerProviderIx = await facade.registerAgent({
    authority: providerAuthority,
    agentId: providerAgentId,
    capabilities: 7n,
    endpoint: "https://provider.example/agent",
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
    specHash: listingSpecHash,
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

  // -- 3. Human buyer hires from the listing -------------------------------
  // hire_from_listing_humanless is the plain-wallet storefront checkout path:
  // it mints the task + escrow + hire-record and forces CreatorReview so the
  // buyer reviews before funds release. Escrow funding alone does not clear the
  // job-spec gate; the next signed action pins the spec and activates discovery,
  // while transaction-time gates remain authoritative.
  const hireIx = await facade.hireFromListingHumanless({
    listing,
    providerAgent,
    creator: buyerAuthority,
    taskId,
    expectedPrice: 1_000_000n,
    expectedVersion: 1n,
    reviewWindowSecs: 86_400n,
    listingSpecHash,
    // P1.2: name the attestation author; the facade derives the v2
    // listing-moderation record and the required BLOCK-floor PDA from
    // listingSpecHash + moderator.
    moderator: moderationAuthority,
  });

  // The hire mints a task whose PDA is seeded by (buyer wallet, taskId). The
  // hire-record links the task back to the listing; close_task uses it to
  // release listing capacity after terminal settlement.
  const [task] = await findTaskPda({ creator: buyerAuthority.address, taskId });
  const [hireRecord] = await findHireRecordPda({ task });
  const [creatorCompletionBond] = await findCreatorCompletionBondPda({
    task,
    creator: buyerAuthority.address,
  });

  // -- 4. Buyer activates by pinning the moderated job spec ----------------
  // The task-moderation record must already exist for (task, jobSpecHash,
  // moderator) — P1.2 v2 records are moderator-keyed. The facade derives
  // taskJobSpec, the v2 taskModeration record, and the required BLOCK-floor
  // PDA from task/hash/moderator.
  const activateIx = await facade.setTaskJobSpec({
    task,
    creator: buyerAuthority,
    jobSpecHash,
    jobSpecUri: "agenc://job-spec/sha256/example",
    moderator: moderationAuthority,
  });

  // -- 5. Provider claims the activated task -------------------------------
  // claim_task_with_job_spec ties the claim to the pinned job-spec pointer
  // (plain claim_task is fail-closed).
  const [moderationBlock] = await findModerationBlockPda({
    contentHash: jobSpecHash,
  });
  const claimIx = await facade.claimTaskWithJobSpec({
    task,
    worker: providerAgent,
    authority: providerAuthority,
    moderationBlock,
    jobSpecHash,
  });

  // -- 6. Worker submits an artifact proof --------------------------------
  // The proof hash is required and non-zero. `resultData` can carry a compact
  // pointer such as ag://a/<base64url-32B>; null is accepted by the program but
  // gives the buyer nothing to fetch.
  const submitIx = await facade.submitTaskResult({
    task,
    worker: providerAgent,
    authority: providerAuthority,
    proofHash,
    resultData: null,
  });

  // -- 7. Buyer reviews, accepts, rates, and closes ------------------------
  // accept_task_result settles escrow to the worker authority. The required
  // bond PDAs are auto-derived by the generated builder even when no bonds were
  // posted.
  const acceptIx = await facade.acceptTaskResult({
    task,
    worker: providerAgent,
    treasury,
    creator: buyerAuthority,
    workerAuthority: providerAuthority.address,
    hireRecord,
  });

  const rateIx = await facade.rateHire({
    task,
    listing,
    buyer: buyerAuthority,
    score: 5,
    reviewHash,
    reviewUri: "agenc://review/sha256/example",
  });

  // close_task closes the supplied children, decrements listing open_jobs, and
  // retains the terminal Task as the durable liveness anchor for any child not
  // enumerable here. Pass `listing` for hired tasks and
  // `creatorCompletionBond` even when no creator bond was posted; the program
  // seeds-checks that PDA.
  const closeIx = await facade.closeTask({
    task,
    hireRecord,
    listing,
    creatorCompletionBond,
    workerCompletionBond: null,
    authority: buyerAuthority,
  });

  const instructions = [
    registerProviderIx,
    createListingIx,
    hireIx,
    activateIx,
    claimIx,
    submitIx,
    acceptIx,
    rateIx,
    closeIx,
  ];

  // eslint-disable-next-line no-console
  console.log(
    `embeddable-marketplace: assembled ${instructions.length} instructions`,
  );
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
