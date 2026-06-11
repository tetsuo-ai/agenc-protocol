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
 * (`facade.hireFromListing`, `facade.claimTaskWithJobSpec`,
 * `facade.submitTaskResult`). No EULA kit source is used.
 *
 * @module tools/prepare
 */
import { createNoopSigner, none, some, type Address } from "@solana/kit";
import { facade } from "@tetsuo-ai/marketplace-sdk";
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

// ===========================================================================
// prepare_hire
// ===========================================================================

interface PrepareHireArgs {
  listing: string;
  buyer: string;
  creatorAgent: string;
  taskId: string;
  expectedPrice: string;
  expectedVersion: string;
  listingSpecHash?: string;
  listingModeration?: string;
}

const prepareHire = defineTool<PrepareHireArgs, UnsignedInstructionView>({
  name: "prepare_hire",
  kind: "prepare",
  description:
    "Build an UNSIGNED hire_from_listing instruction (the buyer hires an agent from a " +
    "standing listing, funding an escrowed task). Returns the unsigned instruction " +
    "(program id, account metas, base64 data) — it is NOT signed and NOT sent. The " +
    "caller must sign with the buyer wallet behind their own policy gate and broadcast " +
    "it. Pass expectedPrice/expectedVersion from the listing as compare-and-swap guards.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: [
      "listing",
      "buyer",
      "creatorAgent",
      "taskId",
      "expectedPrice",
      "expectedVersion",
    ],
    properties: {
      listing: { type: "string", description: "ServiceListing PDA to hire from (base58)." },
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
      listingSpecHash: {
        type: "string",
        description:
          "Listing's pinned spec hash as 64 hex chars. When given, the facade derives the moderation PDA.",
      },
      listingModeration: {
        type: "string",
        description:
          "Explicit listing-moderation attestation PDA (base58). Alternative to listingSpecHash.",
      },
    },
  },
  async handler(args) {
    const buyer = createNoopSigner(args.buyer as Address);
    const input: Parameters<typeof facade.hireFromListing>[0] = {
      listing: args.listing as Address,
      creatorAgent: args.creatorAgent as Address,
      authority: buyer,
      creator: buyer,
      taskId: hex32(args.taskId, "taskId", "prepare_hire"),
      expectedPrice: BigInt(args.expectedPrice),
      expectedVersion: BigInt(args.expectedVersion),
    };
    if (args.listingSpecHash !== undefined) {
      input.listingSpecHash = hex32(
        args.listingSpecHash,
        "listingSpecHash",
        "prepare_hire",
      );
    }
    if (args.listingModeration !== undefined) {
      input.listingModeration = args.listingModeration as Address;
    }
    const ix = await facade.hireFromListing(input);
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
    required: ["task", "worker", "workerAuthority"],
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
    },
  },
  async handler(args) {
    const authority = createNoopSigner(args.workerAuthority as Address);
    const ix = await facade.claimTaskWithJobSpec({
      task: args.task as Address,
      worker: args.worker as Address,
      authority,
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
  prepareClaim,
  prepareSubmit,
];
