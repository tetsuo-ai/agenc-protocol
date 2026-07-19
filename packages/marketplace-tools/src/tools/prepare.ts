/**
 * Mutation-PREPARE tools.
 *
 * Each of these BUILDS an unsigned instruction via the SDK facade and returns
 * the unsigned artifact ({@link UnsignedInstructionView}). They NEVER hold a
 * key, NEVER sign, and NEVER broadcast — the signer accounts are filled with a
 * kit `createNoopSigner` (carries the address only). The consumer (the MCP
 * server, an agent runtime) is responsible for swapping in a real signer behind
 * its own policy gate, signing, and sending.
 *
 * Clean-room: built FRESH on the public `@tetsuo-ai/marketplace-sdk` facade
 * (`facade.hireFromListing*`, `facade.setTaskJobSpec`, `facade.claimTaskWithJobSpec`,
 * `facade.submitTaskResult`, and review/cleanup helpers). No EULA kit source is used.
 *
 * @module tools/prepare
 */
import { createNoopSigner, none, some, type Address } from "@solana/kit";
import { facade, findCreatorCompletionBondPda, values } from "@tetsuo-ai/marketplace-sdk";
import {
  MarketplaceToolError,
  defineTool,
  type MarketplaceTool,
} from "../types.js";
import {
  projectInstruction,
  type BuiltInstructionLike,
  type UnsignedInstructionView,
} from "../project.js";

/** Parse a 64-hex-char string into a 32-byte `Uint8Array`. */
function hex32(value: string, field: string, tool: string): Uint8Array {
  const clean = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new MarketplaceToolError(
      "BAD_HEX32",
      `${tool}: ${field} must be exactly 64 hex chars (32 bytes), got ${clean.length}`,
      tool,
    );
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const MAX_FEE_BPS = 2_000;
const MAX_U16 = 65_535;

function assertFeeBps(value: number | undefined, field: string, tool: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 0 || value > MAX_FEE_BPS) {
    throw new MarketplaceToolError(
      "BAD_FEE_BPS",
      `${tool}: ${field} must be an integer from 0 to ${MAX_FEE_BPS}`,
      tool,
    );
  }
}

function assertU16(value: number, field: string, tool: string): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_U16) {
    throw new MarketplaceToolError(
      "BAD_U16",
      `${tool}: ${field} must be an integer from 0 to ${MAX_U16}`,
      tool,
    );
  }
}

function assertPayeeForFee(
  payee: string | undefined,
  feeBps: number | undefined,
  payeeField: string,
  feeField: string,
  tool: string,
): void {
  assertFeeBps(feeBps, feeField, tool);
  if (feeBps !== undefined && feeBps > 0 && payee === undefined) {
    throw new MarketplaceToolError(
      "MISSING_FEE_PAYEE",
      `${tool}: ${feeField} is non-zero, so ${payeeField} must be provided`,
      tool,
    );
  }
}

// ===========================================================================
// prepare_create_service_listing
// ===========================================================================

interface PrepareCreateServiceListingArgs {
  providerAgent: string;
  authority: string;
  listingId: string;
  name: string;
  category: string;
  tags: string[];
  specHash: string;
  specUri: string;
  price: string;
  priceMint?: string;
  requiredCapabilities: string;
  defaultDeadlineSecs: string;
  maxOpenJobs: number;
  operator?: string;
  operatorFeeBps?: number;
}

const prepareCreateServiceListing = defineTool<
  PrepareCreateServiceListingArgs,
  UnsignedInstructionView
>({
  name: "prepare_create_service_listing",
  kind: "prepare",
  description:
    "Build an UNSIGNED create_service_listing instruction for a provider storefront. " +
    "It publishes listing supply only; buyers still hire through the separate hire " +
    "tools. The returned instruction is NOT signed and NOT sent.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: [
      "providerAgent",
      "authority",
      "listingId",
      "name",
      "category",
      "tags",
      "specHash",
      "specUri",
      "price",
      "requiredCapabilities",
      "defaultDeadlineSecs",
      "maxOpenJobs",
    ],
    properties: {
      providerAgent: { type: "string", description: "Provider AgentRegistration PDA." },
      authority: { type: "string", description: "Provider wallet that signs listing creation." },
      listingId: { type: "string", description: "32-byte listing id as 64 hex chars." },
      name: { type: "string", description: "Listing display name, encoded by LISTING_METADATA v1." },
      category: {
        type: "string",
        description: "Canonical LISTING_METADATA v1 category.",
        enum: values.LISTING_CATEGORIES,
      },
      tags: {
        type: "array",
        description: "Lowercase-kebab LISTING_METADATA v1 tag tokens.",
        items: { type: "string", description: "One lowercase-kebab tag." },
      },
      specHash: { type: "string", description: "Listing spec hash as 64 hex chars." },
      specUri: { type: "string", description: "Hosted listing spec URI." },
      price: { type: "string", description: "Listing price in lamports as a decimal u64 string." },
      priceMint: {
        type: "string",
        description: "Optional SPL token mint. Omit for SOL listings.",
      },
      requiredCapabilities: {
        type: "string",
        description: "Capability bitmask as a decimal u64 string.",
      },
      defaultDeadlineSecs: {
        type: "string",
        description: "Default deadline in seconds as a decimal i64 string.",
      },
      maxOpenJobs: {
        type: "integer",
        description: "Maximum concurrent open hired jobs. Use 0 for uncapped.",
        minimum: 0,
        maximum: MAX_U16,
      },
      operator: { type: "string", description: "Optional operator payout wallet." },
      operatorFeeBps: {
        type: "integer",
        description: "Optional operator fee bps. Non-zero requires operator.",
        minimum: 0,
        maximum: MAX_FEE_BPS,
        default: 0,
      },
    },
  },
  async handler(args) {
    if (!values.isListingCategory(args.category)) {
      throw new MarketplaceToolError(
        "BAD_CATEGORY",
        "prepare_create_service_listing: category must be a canonical LISTING_METADATA v1 category",
        "prepare_create_service_listing",
      );
    }
    assertU16(args.maxOpenJobs, "maxOpenJobs", "prepare_create_service_listing");
    assertPayeeForFee(
      args.operator,
      args.operatorFeeBps,
      "operator",
      "operatorFeeBps",
      "prepare_create_service_listing",
    );
    const ix = await facade.createServiceListing({
      providerAgent: args.providerAgent as Address,
      authority: createNoopSigner(args.authority as Address),
      listingId: hex32(args.listingId, "listingId", "prepare_create_service_listing"),
      name: args.name,
      category: args.category,
      tags: args.tags,
      specHash: hex32(args.specHash, "specHash", "prepare_create_service_listing"),
      specUri: args.specUri,
      price: BigInt(args.price),
      priceMint: args.priceMint ? (args.priceMint as Address) : null,
      requiredCapabilities: BigInt(args.requiredCapabilities),
      defaultDeadlineSecs: BigInt(args.defaultDeadlineSecs),
      maxOpenJobs: args.maxOpenJobs,
      operator: args.operator ? (args.operator as Address) : null,
      operatorFeeBps: args.operatorFeeBps ?? 0,
    });
    return projectInstruction(ix as unknown as BuiltInstructionLike);
  },
});

// ===========================================================================
// prepare_hire
// ===========================================================================

interface PrepareHireArgs {
  listing: string;
  providerAgent: string;
  buyer: string;
  creatorAgent: string;
  taskId: string;
  expectedPrice: string;
  expectedVersion: string;
  moderator: string;
  listingSpecHash: string;
  moderatorIsAttestor?: boolean;
  listingModeration?: string;
  referrer?: string;
  referrerFeeBps?: number;
}

const prepareHire = defineTool<PrepareHireArgs, UnsignedInstructionView>({
  name: "prepare_hire",
  kind: "prepare",
  description:
    "Build an UNSIGNED registered-agent hire_from_listing instruction (the buyer hires an agent from a " +
    "standing listing, funding an escrowed task). Returns the unsigned instruction " +
    "(program id, account metas, base64 data) — it is NOT signed and NOT sent. The " +
    "caller must sign with the buyer wallet behind their own policy gate and broadcast " +
    "it. Pass expectedPrice/expectedVersion from the listing as compare-and-swap guards.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: [
      "listing",
      "providerAgent",
      "buyer",
      "creatorAgent",
      "taskId",
      "expectedPrice",
      "expectedVersion",
      "moderator",
      "listingSpecHash",
    ],
    properties: {
      listing: { type: "string", description: "ServiceListing PDA to hire from (base58)." },
      providerAgent: {
        type: "string",
        description: "Provider AgentRegistration PDA pinned by the listing (base58).",
      },
      buyer: {
        type: "string",
        description:
          "Buyer wallet (base58) — fee payer + authority + creator of the hired task.",
      },
      creatorAgent: {
        type: "string",
        description: "The buyer's creator AgentRegistration PDA (base58).",
      },
      taskId: {
        type: "string",
        description: "32-byte task id as 64 hex chars (caller-chosen, unique).",
      },
      expectedPrice: {
        type: "string",
        description: "Expected listing price in lamports (decimal u64 string) — CAS guard.",
      },
      expectedVersion: {
        type: "string",
        description: "Expected listing version (decimal u64 string) — CAS guard.",
      },
      moderator: {
        type: "string",
        description:
          "Pubkey (base58) whose listing-moderation attestation this hire consumes " +
          "(the P1.2 moderator instruction arg). Get it from your attestation " +
          "service's signer pubkey — e.g. the `moderator` field of attest.agenc.ag " +
          "GET /v1/info.",
      },
      listingSpecHash: {
        type: "string",
        description:
          "Listing's pinned spec hash as 64 hex chars. The facade derives the " +
          "REQUIRED moderation-block (BLOCK-floor) PDA from it, plus the v2 " +
          "moderator-keyed moderation record PDA unless listingModeration is passed.",
      },
      moderatorIsAttestor: {
        type: "boolean",
        description:
          "Set true when moderator is a REGISTERED roster attestor: the facade " +
          "derives and attaches the [\"moderation_attestor\", moderator] roster PDA " +
          "the hire gate requires. Omit/false for the global-moderation-authority " +
          "path — the roster slot is then the None placeholder.",
      },
      listingModeration: {
        type: "string",
        description:
          "Explicit listing-moderation record PDA (base58) override. Legacy " +
          "grace-window escape hatch for pre-upgrade records at the old seeds " +
          "(derive via facade.findLegacyListingModerationPda); defaults to the v2 " +
          "moderator-keyed PDA derived from listingSpecHash.",
      },
      referrer: { type: "string", description: "Optional referrer wallet." },
      referrerFeeBps: {
        type: "integer",
        description: "Optional referrer fee bps. Non-zero requires referrer.",
        minimum: 0,
        maximum: MAX_FEE_BPS,
      },
    },
  },
  async handler(args) {
    assertPayeeForFee(args.referrer, args.referrerFeeBps, "referrer", "referrerFeeBps", "prepare_hire");
    const buyer = createNoopSigner(args.buyer as Address);
    const input: Parameters<typeof facade.hireFromListing>[0] = {
      listing: args.listing as Address,
      providerAgent: args.providerAgent as Address,
      creatorAgent: args.creatorAgent as Address,
      authority: buyer,
      creator: buyer,
      taskId: hex32(args.taskId, "taskId", "prepare_hire"),
      expectedPrice: BigInt(args.expectedPrice),
      expectedVersion: BigInt(args.expectedVersion),
      moderator: args.moderator as Address,
      listingSpecHash: hex32(args.listingSpecHash, "listingSpecHash", "prepare_hire"),
    };
    if (args.moderatorIsAttestor !== undefined) {
      input.moderatorIsAttestor = args.moderatorIsAttestor;
    }
    if (args.listingModeration !== undefined) {
      input.listingModeration = args.listingModeration as Address;
    }
    if (args.referrer !== undefined) input.referrer = args.referrer as Address;
    if (args.referrerFeeBps !== undefined) input.referrerFeeBps = args.referrerFeeBps;
    const ix = await facade.hireFromListing(input);
    return projectInstruction(ix as unknown as BuiltInstructionLike);
  },
});

// ===========================================================================
// prepare_hire_humanless
// ===========================================================================

interface PrepareHireHumanlessArgs {
  listing: string;
  providerAgent: string;
  buyer: string;
  taskId: string;
  expectedPrice: string;
  expectedVersion: string;
  moderator: string;
  listingSpecHash: string;
  moderatorIsAttestor?: boolean;
  listingModeration?: string;
  reviewWindowSecs?: string;
  referrer?: string;
  referrerFeeBps?: number;
}

const prepareHireHumanless = defineTool<PrepareHireHumanlessArgs, UnsignedInstructionView>({
  name: "prepare_hire_humanless",
  kind: "prepare",
  description:
    "Build an UNSIGNED hire_from_listing_humanless instruction for a plain-wallet buyer. " +
    "This is the storefront visitor checkout path: it funds escrow and creates a task " +
    "that still requires set_task_job_spec activation before a worker can claim. The " +
    "returned instruction is NOT signed and NOT sent.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: [
      "listing",
      "providerAgent",
      "buyer",
      "taskId",
      "expectedPrice",
      "expectedVersion",
      "moderator",
      "listingSpecHash",
    ],
    properties: {
      listing: { type: "string", description: "ServiceListing PDA to hire from (base58)." },
      providerAgent: {
        type: "string",
        description: "Provider AgentRegistration PDA pinned by the listing (base58).",
      },
      buyer: { type: "string", description: "Plain buyer wallet that signs and funds escrow." },
      taskId: { type: "string", description: "32-byte task id as 64 hex chars." },
      expectedPrice: { type: "string", description: "Expected listing price in lamports." },
      expectedVersion: { type: "string", description: "Expected listing version." },
      moderator: {
        type: "string",
        description:
          "Pubkey (base58) whose listing-moderation attestation this hire consumes " +
          "(the P1.2 moderator instruction arg). Get it from your attestation " +
          "service's signer pubkey — e.g. the `moderator` field of attest.agenc.ag " +
          "GET /v1/info.",
      },
      listingSpecHash: {
        type: "string",
        description:
          "Listing spec hash as 64 hex chars. Derives the REQUIRED moderation-block " +
          "PDA plus the v2 moderation record PDA unless listingModeration is passed.",
      },
      moderatorIsAttestor: {
        type: "boolean",
        description:
          "Set true when moderator is a REGISTERED roster attestor: the facade " +
          "derives and attaches its [\"moderation_attestor\", moderator] roster PDA. " +
          "Omit/false for the global-moderation-authority path (None placeholder).",
      },
      listingModeration: {
        type: "string",
        description:
          "Explicit listing-moderation record PDA (base58) override — the legacy " +
          "grace-window escape hatch (facade.findLegacyListingModerationPda).",
      },
      reviewWindowSecs: { type: "string", description: "CreatorReview window in seconds." },
      referrer: { type: "string", description: "Optional referrer wallet." },
      referrerFeeBps: {
        type: "integer",
        description: "Optional referrer fee bps. Non-zero requires referrer.",
        minimum: 0,
        maximum: MAX_FEE_BPS,
      },
    },
  },
  async handler(args) {
    assertPayeeForFee(
      args.referrer,
      args.referrerFeeBps,
      "referrer",
      "referrerFeeBps",
      "prepare_hire_humanless",
    );
    const buyer = createNoopSigner(args.buyer as Address);
    const input: Parameters<typeof facade.hireFromListingHumanless>[0] = {
      listing: args.listing as Address,
      providerAgent: args.providerAgent as Address,
      creator: buyer,
      taskId: hex32(args.taskId, "taskId", "prepare_hire_humanless"),
      expectedPrice: BigInt(args.expectedPrice),
      expectedVersion: BigInt(args.expectedVersion),
      reviewWindowSecs: args.reviewWindowSecs ? BigInt(args.reviewWindowSecs) : 86_400n,
      moderator: args.moderator as Address,
      listingSpecHash: hex32(
        args.listingSpecHash,
        "listingSpecHash",
        "prepare_hire_humanless",
      ),
    };
    if (args.moderatorIsAttestor !== undefined) {
      input.moderatorIsAttestor = args.moderatorIsAttestor;
    }
    if (args.listingModeration !== undefined) {
      input.listingModeration = args.listingModeration as Address;
    }
    if (args.referrer !== undefined) input.referrer = args.referrer as Address;
    if (args.referrerFeeBps !== undefined) input.referrerFeeBps = args.referrerFeeBps;
    const ix = await facade.hireFromListingHumanless(input);
    return projectInstruction(ix as unknown as BuiltInstructionLike);
  },
});

// ===========================================================================
// prepare_set_task_job_spec
// ===========================================================================

interface PrepareSetTaskJobSpecArgs {
  task: string;
  creator: string;
  jobSpecHash: string;
  jobSpecUri: string;
  moderator: string;
  moderatorIsAttestor?: boolean;
  taskModeration?: string;
}

const prepareSetTaskJobSpec = defineTool<PrepareSetTaskJobSpecArgs, UnsignedInstructionView>({
  name: "prepare_set_task_job_spec",
  kind: "prepare",
  description:
    "Build an UNSIGNED set_task_job_spec instruction. This is the activation step after " +
    "humanless hire: the buyer pins a moderated job spec so the task becomes claimable.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["task", "creator", "jobSpecHash", "jobSpecUri", "moderator"],
    properties: {
      task: { type: "string", description: "Task PDA to activate." },
      creator: { type: "string", description: "Task creator/buyer wallet that signs." },
      jobSpecHash: { type: "string", description: "Moderated job spec hash as 64 hex chars." },
      jobSpecUri: { type: "string", description: "Hosted job spec URI." },
      moderator: {
        type: "string",
        description:
          "Pubkey (base58) whose moderation attestation the publish gate consumes " +
          "(the P1.2 moderator instruction arg). Get it from your attestation " +
          "service's signer pubkey — e.g. the `moderator` field of attest.agenc.ag " +
          "GET /v1/info.",
      },
      moderatorIsAttestor: {
        type: "boolean",
        description:
          "Set true when moderator is a REGISTERED roster attestor: the facade " +
          "derives and attaches its [\"moderation_attestor\", moderator] roster PDA. " +
          "Omit/false for the global-moderation-authority path — the roster slot is " +
          "then the None placeholder.",
      },
      taskModeration: {
        type: "string",
        description:
          "Explicit task-moderation record PDA (base58) override. Legacy " +
          "grace-window escape hatch for pre-upgrade records at the old seeds " +
          "(derive via facade.findLegacyTaskModerationPda); defaults to the v2 " +
          "moderator-keyed PDA derived from task + jobSpecHash + moderator.",
      },
    },
  },
  async handler(args) {
    const input: Parameters<typeof facade.setTaskJobSpec>[0] = {
      task: args.task as Address,
      creator: createNoopSigner(args.creator as Address),
      jobSpecHash: hex32(args.jobSpecHash, "jobSpecHash", "prepare_set_task_job_spec"),
      jobSpecUri: args.jobSpecUri,
      moderator: args.moderator as Address,
    };
    if (args.moderatorIsAttestor !== undefined) {
      input.moderatorIsAttestor = args.moderatorIsAttestor;
    }
    if (args.taskModeration !== undefined) {
      input.taskModeration = args.taskModeration as Address;
    }
    const ix = await facade.setTaskJobSpec(input);
    return projectInstruction(ix as unknown as BuiltInstructionLike);
  },
});

// ===========================================================================
// prepare_claim
// ===========================================================================

interface PrepareClaimArgs {
  task: string;
  worker: string;
  workerAuthority: string;
  jobSpecHash: string;
}

const prepareClaim = defineTool<PrepareClaimArgs, UnsignedInstructionView>({
  name: "prepare_claim",
  kind: "prepare",
  description:
    "Build an UNSIGNED claim_task_with_job_spec instruction (a worker agent claims an " +
    "Open task, pinning its job-spec pointer). Returns the unsigned instruction — NOT " +
    "signed, NOT sent. The caller signs with the worker's authority wallet behind their " +
    "own policy gate and broadcasts it.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["task", "worker", "workerAuthority", "jobSpecHash"],
    properties: {
      task: { type: "string", description: "The Task PDA to claim (base58)." },
      worker: {
        type: "string",
        description: "The worker's AgentRegistration PDA (base58).",
      },
      workerAuthority: {
        type: "string",
        description: "The wallet authority that owns the worker agent (signs the claim).",
      },
      jobSpecHash: {
        type: "string",
        description: "The task's pinned job-spec hash as 64 hex chars (BLOCK-gate binding).",
      },
    },
  },
  async handler(args) {
    const authority = createNoopSigner(args.workerAuthority as Address);
    const ix = await facade.claimTaskWithJobSpec({
      task: args.task as Address,
      worker: args.worker as Address,
      authority,
      jobSpecHash: hex32(args.jobSpecHash, "jobSpecHash", "prepare_claim"),
    });
    return projectInstruction(ix as unknown as BuiltInstructionLike);
  },
});

// ===========================================================================
// prepare_submit
// ===========================================================================

interface PrepareSubmitArgs {
  task: string;
  worker: string;
  workerAuthority: string;
  proofHash: string;
  resultData?: string;
}

const prepareSubmit = defineTool<PrepareSubmitArgs, UnsignedInstructionView>({
  name: "prepare_submit",
  kind: "prepare",
  description:
    "Build an UNSIGNED submit_task_result instruction (a worker submits the result of a " +
    "claimed task for creator review). Returns the unsigned instruction — NOT signed, " +
    "NOT sent. proofHash is the fixed 32-byte (64-hex-char) result/proof hash; resultData " +
    "is an OPTIONAL fixed 64-byte (128-hex-char) inline commitment — it is rejected (never " +
    "truncated or zero-padded) if it is any other length, so the committed bytes always " +
    "match what you pass. The caller signs with the worker authority and broadcasts.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["task", "worker", "workerAuthority", "proofHash"],
    properties: {
      task: { type: "string", description: "The claimed Task PDA (base58)." },
      worker: {
        type: "string",
        description: "The worker's AgentRegistration PDA (base58).",
      },
      workerAuthority: {
        type: "string",
        description: "The wallet authority that owns the worker agent (signs the submission).",
      },
      proofHash: {
        type: "string",
        description: "32-byte result/proof hash as exactly 64 hex chars.",
      },
      resultData: {
        type: "string",
        description:
          "Optional inline result data/commitment as exactly 128 hex chars (the " +
          "protocol's fixed 64-byte resultData field). Pre-hash/pad to the full 64 " +
          "bytes yourself — the tool does NOT silently truncate or zero-pad, so the " +
          "committed bytes always equal what you supply. Omit for none.",
      },
    },
  },
  async handler(args) {
    const authority = createNoopSigner(args.workerAuthority as Address);
    const resultData =
      args.resultData !== undefined
        ? some<Uint8Array>(
            hexFixed(
              args.resultData,
              RESULT_DATA_BYTES,
              "resultData",
              "prepare_submit",
              "BAD_RESULTDATA_LEN",
            ),
          )
        : none<Uint8Array>();
    const ix = await facade.submitTaskResult({
      task: args.task as Address,
      worker: args.worker as Address,
      authority,
      proofHash: hex32(args.proofHash, "proofHash", "prepare_submit"),
      resultData,
    });
    return projectInstruction(ix as unknown as BuiltInstructionLike);
  },
});

// ===========================================================================
// review / cleanup / rating prepare tools
// ===========================================================================

interface PrepareAcceptArgs {
  task: string;
  worker: string;
  workerAuthority: string;
  treasury: string;
  creator: string;
  operator?: string;
  referrer?: string;
}

const prepareAccept = defineTool<PrepareAcceptArgs, UnsignedInstructionView>({
  name: "prepare_accept_task_result",
  kind: "prepare",
  description: "Build an UNSIGNED accept_task_result instruction for CreatorReview settlement.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["task", "worker", "workerAuthority", "treasury", "creator"],
    properties: {
      task: { type: "string", description: "Task PDA in creator review." },
      worker: { type: "string", description: "Worker agent PDA." },
      workerAuthority: { type: "string", description: "Worker payout authority wallet." },
      treasury: { type: "string", description: "Protocol treasury account." },
      creator: { type: "string", description: "Task creator wallet that signs." },
      operator: { type: "string", description: "Optional operator payee." },
      referrer: { type: "string", description: "Optional referrer payee." },
    },
  },
  async handler(args) {
    const ix = await facade.acceptTaskResult({
      task: args.task as Address,
      worker: args.worker as Address,
      workerAuthority: args.workerAuthority as Address,
      treasury: args.treasury as Address,
      creator: createNoopSigner(args.creator as Address),
      ...(args.operator ? { operator: args.operator as Address } : {}),
      ...(args.referrer ? { referrer: args.referrer as Address } : {}),
    });
    return projectInstruction(ix as unknown as BuiltInstructionLike);
  },
});

interface PrepareRejectArgs {
  task: string;
  claim: string;
  worker: string;
  workerAuthority: string;
  creator: string;
  rejectionHash: string;
}

const prepareReject = defineTool<PrepareRejectArgs, UnsignedInstructionView>({
  name: "prepare_reject_task_result",
  kind: "prepare",
  description: "Build an UNSIGNED reject_task_result instruction for CreatorReview rejection.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["task", "claim", "worker", "workerAuthority", "creator", "rejectionHash"],
    properties: {
      task: { type: "string", description: "Task PDA in creator review." },
      claim: { type: "string", description: "TaskClaim PDA for this task/worker." },
      worker: { type: "string", description: "Worker agent PDA." },
      workerAuthority: { type: "string", description: "Worker authority wallet." },
      creator: { type: "string", description: "Task creator wallet that signs." },
      rejectionHash: { type: "string", description: "32-byte rejection reason hash." },
    },
  },
  async handler(args) {
    const ix = await facade.rejectTaskResult({
      task: args.task as Address,
      claim: args.claim as Address,
      worker: args.worker as Address,
      workerAuthority: args.workerAuthority as Address,
      creator: createNoopSigner(args.creator as Address),
      rejectionHash: hex32(args.rejectionHash, "rejectionHash", "prepare_reject_task_result"),
    });
    return projectInstruction(ix as unknown as BuiltInstructionLike);
  },
});

interface PrepareAutoAcceptArgs extends Omit<PrepareAcceptArgs, "creator"> {
  creator: string;
  authority: string;
  operator?: string;
  referrer?: string;
}

const prepareAutoAccept = defineTool<PrepareAutoAcceptArgs, UnsignedInstructionView>({
  name: "prepare_auto_accept_task_result",
  kind: "prepare",
  description:
    "Build an UNSIGNED auto_accept_task_result instruction after the CreatorReview window elapses.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["task", "worker", "workerAuthority", "treasury", "creator", "authority"],
    properties: {
      task: { type: "string", description: "Task PDA in creator review." },
      worker: { type: "string", description: "Worker agent PDA." },
      workerAuthority: { type: "string", description: "Worker payout authority wallet." },
      treasury: { type: "string", description: "Protocol treasury account." },
      creator: { type: "string", description: "Task creator wallet." },
      authority: { type: "string", description: "Permissionless caller wallet that signs." },
      operator: { type: "string", description: "Optional operator payee." },
      referrer: { type: "string", description: "Optional referrer payee." },
    },
  },
  async handler(args) {
    const ix = await facade.autoAcceptTaskResult({
      task: args.task as Address,
      worker: args.worker as Address,
      workerAuthority: args.workerAuthority as Address,
      treasury: args.treasury as Address,
      creator: args.creator as Address,
      authority: createNoopSigner(args.authority as Address),
      ...(args.operator ? { operator: args.operator as Address } : {}),
      ...(args.referrer ? { referrer: args.referrer as Address } : {}),
    });
    return projectInstruction(ix as unknown as BuiltInstructionLike);
  },
});

interface PrepareCancelArgs {
  task: string;
  authority: string;
  workerBondAuthority?: string;
}

const prepareCancel = defineTool<PrepareCancelArgs, UnsignedInstructionView>({
  name: "prepare_cancel_task",
  kind: "prepare",
  description: "Build an UNSIGNED cancel_task instruction to refund an open/unclaimed task.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["task", "authority"],
    properties: {
      task: { type: "string", description: "Task PDA to cancel." },
      authority: { type: "string", description: "Task creator wallet that signs." },
      workerBondAuthority: {
        type: "string",
        description:
          "Wallet whose worker completion bond PDA is settled (refunded, or forfeited on a no-show cancel — must then be a live claim worker, audit F-1). Defaults to the task PDA, which can never be a bond poster (empty no-op PDA).",
      },
    },
  },
  async handler(args) {
    const ix = await facade.cancelTask({
      task: args.task as Address,
      authority: createNoopSigner(args.authority as Address),
      // audit F5/F12: required bond PDAs are facade-derived; default to the
      // guaranteed bond-free task PDA for the worker side.
      workerBondAuthority: (args.workerBondAuthority ?? args.task) as Address,
    });
    return projectInstruction(ix as unknown as BuiltInstructionLike);
  },
});

interface PrepareCloseArgs {
  task: string;
  authority: string;
  hireRecord?: string;
  listing?: string;
}

const prepareClose = defineTool<PrepareCloseArgs, UnsignedInstructionView>({
  name: "prepare_close_task",
  kind: "prepare",
  description:
    "Build an UNSIGNED close_task instruction for terminal tasks. Pass hireRecord/listing for hired tasks to free listing capacity.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["task", "authority"],
    properties: {
      task: { type: "string", description: "Terminal task PDA to close." },
      authority: { type: "string", description: "Task creator wallet that signs." },
      hireRecord: { type: "string", description: "Optional HireRecord PDA for hired tasks." },
      listing: { type: "string", description: "Optional source listing PDA for hired tasks." },
    },
  },
  async handler(args) {
    const task = args.task as Address;
    const authority = createNoopSigner(args.authority as Address);
    const [creatorCompletionBond] = await findCreatorCompletionBondPda({
      task,
      creator: authority.address,
    });
    const ix = await facade.closeTask({
      task,
      authority,
      creatorCompletionBond,
      ...(args.hireRecord ? { hireRecord: args.hireRecord as Address } : {}),
      ...(args.listing ? { listing: args.listing as Address } : {}),
    });
    return projectInstruction(ix as unknown as BuiltInstructionLike);
  },
});

interface PrepareRateHireArgs {
  task: string;
  listing: string;
  buyer: string;
  score: number;
  reviewHash?: string;
  reviewUri?: string;
}

const prepareRateHire = defineTool<PrepareRateHireArgs, UnsignedInstructionView>({
  name: "prepare_rate_hire",
  kind: "prepare",
  description: "Build an UNSIGNED rate_hire instruction for a completed listing hire.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["task", "listing", "buyer", "score"],
    properties: {
      task: { type: "string", description: "Completed task PDA." },
      listing: { type: "string", description: "Source listing PDA from the HireRecord." },
      buyer: { type: "string", description: "Task creator/buyer wallet that signs." },
      score: { type: "integer", description: "Rating score, 1 through 5." },
      reviewHash: { type: "string", description: "Optional 32-byte review hash." },
      reviewUri: { type: "string", description: "Optional written review URI." },
    },
  },
  async handler(args) {
    const ix = await facade.rateHire({
      task: args.task as Address,
      listing: args.listing as Address,
      buyer: createNoopSigner(args.buyer as Address),
      score: args.score,
      ...(args.reviewHash
        ? { reviewHash: hex32(args.reviewHash, "reviewHash", "prepare_rate_hire") }
        : {}),
      ...(args.reviewUri ? { reviewUri: args.reviewUri } : {}),
    });
    return projectInstruction(ix as unknown as BuiltInstructionLike);
  },
});

// ===========================================================================
// prepare_register_agent
// ===========================================================================

interface PrepareRegisterAgentArgs {
  authority: string;
  agentId: string;
  capabilities: string;
  endpoint: string;
  metadataUri?: string;
  stakeAmount?: string;
}

const prepareRegisterAgent = defineTool<
  PrepareRegisterAgentArgs,
  UnsignedInstructionView
>({
  name: "prepare_register_agent",
  kind: "prepare",
  description:
    "Build an UNSIGNED register_agent instruction. This is the ONE-TIME onboarding step " +
    "an agent needs before it can hire, claim, list, or complete work: it creates the " +
    "AgentRegistration PDA (auto-derived from agentId) owned by the authority wallet. The " +
    "returned instruction is NOT signed and NOT sent — the caller signs with the authority " +
    "wallet behind its own policy gate and broadcasts it.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["authority", "agentId", "capabilities", "endpoint"],
    properties: {
      authority: {
        type: "string",
        description:
          "Agent authority wallet (base58) — fee payer + signer + owner of the new AgentRegistration.",
      },
      agentId: {
        type: "string",
        description:
          "32-byte agent id as 64 hex chars (caller-chosen, unique per authority). The AgentRegistration PDA is derived from it.",
      },
      capabilities: {
        type: "string",
        description:
          "Capability bitmask this agent advertises, as a NON-ZERO decimal u64 string. " +
          "register_agent rejects 0 on-chain (CoordinationError::InvalidCapabilities), so this " +
          "tool rejects it up-front rather than returning a doomed instruction.",
      },
      endpoint: {
        type: "string",
        description: "Agent endpoint URI (e.g. an A2A / agent-card URL) recorded on-chain.",
      },
      metadataUri: {
        type: "string",
        description: "Optional hosted agent metadata URI. Omit for none.",
      },
      stakeAmount: {
        type: "string",
        description:
          "Optional stake in lamports as a decimal u64 string. Omit (defaults to 0) for no stake. " +
          "NOTE: register_agent requires stakeAmount >= the on-chain config.min_agent_stake " +
          "(mainnet default 1_000_000 lamports = 0.001 SOL); the default 0 is rejected at " +
          "broadcast whenever a non-zero minimum stake is configured. This tool cannot read the " +
          "live minimum (keyless prepare-only builder), so it does not guard it — supply a stake " +
          "that meets the deployment's minimum.",
      },
    },
  },
  async handler(args) {
    const capabilities = BigInt(args.capabilities);
    if (capabilities === 0n) {
      // capabilities == 0 is a FIXED protocol invariant (register_agent.rs:
      // `require!(capabilities != 0, CoordinationError::InvalidCapabilities)`),
      // never valid under any config — unlike variable price/stake, so we reject
      // it client-side instead of returning an instruction that only fails at
      // broadcast, wasting a signing+submit round-trip.
      throw new MarketplaceToolError(
        "INVALID_CAPABILITIES",
        "prepare_register_agent: capabilities must be a non-zero decimal u64 bitmask — " +
          "register_agent enforces capabilities != 0 on-chain (CoordinationError::InvalidCapabilities)",
        "prepare_register_agent",
      );
    }
    const ix = await facade.registerAgent({
      authority: createNoopSigner(args.authority as Address),
      agentId: hex32(args.agentId, "agentId", "prepare_register_agent"),
      capabilities,
      endpoint: args.endpoint,
      metadataUri: args.metadataUri ?? null,
      stakeAmount: BigInt(args.stakeAmount ?? "0"),
    });
    return projectInstruction(ix as unknown as BuiltInstructionLike);
  },
});

/**
 * Width (in bytes) of the protocol's fixed `submit_task_result.resultData`
 * field. The generated encoder is
 * `getOptionEncoder(fixEncoderSize(getBytesEncoder(), 64))`
 * (`@tetsuo-ai/marketplace-sdk` generated `submitTaskResult`), so the inner
 * byte array is a FIXED 64 bytes — `fixEncoderSize` silently truncates on
 * overflow and zero-pads on underflow. We reject any other length up-front so
 * the worker can never sign a submission whose on-chain commitment differs from
 * the bytes it supplied.
 */
const RESULT_DATA_BYTES = 64;

/**
 * Parse hex into a `Uint8Array` of EXACTLY `bytes` length. Throws `code` if the
 * input is not strict even-length hex decoding to exactly that many bytes —
 * never silently truncates or pads.
 */
function hexFixed(
  value: string,
  bytes: number,
  field: string,
  tool: string,
  code: string,
): Uint8Array {
  const clean = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new MarketplaceToolError(
      "BAD_HEX",
      `${tool}: ${field} must be an even-length hex string`,
      tool,
    );
  }
  if (clean.length !== bytes * 2) {
    throw new MarketplaceToolError(
      code,
      `${tool}: ${field} must decode to exactly ${bytes} bytes ` +
        `(${bytes * 2} hex chars), got ${clean.length / 2} bytes ` +
        `(${clean.length} hex chars) — the protocol field is a fixed ${bytes}-byte ` +
        `commitment and is never truncated or zero-padded`,
      tool,
    );
  }
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** The prepare tool set, in stable order. */
export const prepareTools: ReadonlyArray<MarketplaceTool> = [
  prepareHire,
  prepareHireHumanless,
  prepareSetTaskJobSpec,
  prepareClaim,
  prepareSubmit,
  prepareAccept,
  prepareReject,
  prepareAutoAccept,
  prepareCancel,
  prepareClose,
  prepareRateHire,
  prepareCreateServiceListing,
  prepareRegisterAgent,
];
