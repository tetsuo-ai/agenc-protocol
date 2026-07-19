/**
 * JSON-safe projections of decoded on-chain accounts.
 *
 * Tool handlers must return values that serialize cleanly into a model's
 * function-result channel — no `bigint`, no `Uint8Array`, no kit branded types.
 * These helpers fold the SDK's decoded `Task` / `ServiceListing` shapes (which
 * carry `bigint` and byte fields) into plain JSON: u64/i64 → decimal string,
 * byte fields → lowercase hex or NUL-trimmed UTF-8.
 *
 * @module project
 */
import {
  ListingState,
  TaskStatus,
  values,
  type ServiceListing,
  type Task,
} from "@tetsuo-ai/marketplace-sdk";
import type { Address } from "@solana/kit";

const { decodeListingName, decodeListingCategory, decodeListingTags } = values;

/** Lowercase hex of a byte array. */
export function toHex(
  bytes: { length: number; [i: number]: number } | Uint8Array,
): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] as number).toString(16).padStart(2, "0");
  }
  return out;
}

/** Decimal string of a bigint (u64/i64-safe). */
function n(value: bigint): string {
  return value.toString(10);
}

/** Resolve a generated PascalCase enum value to its variant name. */
function listingStateName(state: ServiceListing["state"]): string {
  return ListingState[state] ?? String(state);
}

function taskStatusName(status: Task["status"]): string {
  return TaskStatus[status] ?? String(status);
}

/** A JSON-safe `Task` projection returned by `get_task` / `list_open_tasks`. */
export interface TaskView {
  /** The Task PDA. */
  pda: string;
  /** Lowercase hex of the 32-byte task id. */
  taskId: string;
  /** Task creator wallet. */
  creator: string;
  /** Required-capability bitmask as a decimal string (u64-safe). */
  requiredCapabilities: string;
  /** Reward amount in lamports (or token base units) as a decimal string. */
  rewardAmount: string;
  /** SPL reward mint, or null for SOL. */
  rewardMint: string | null;
  /** Lifecycle status variant name (e.g. `"Open"`). */
  status: string;
  /** Minimum worker reputation gate (0 = none). */
  minReputation: number;
  /** Max workers allowed. */
  maxWorkers: number;
  /** Current worker count. */
  currentWorkers: number;
  /** Escrow PDA. */
  escrow: string;
  /** Creation unix timestamp as a decimal string. */
  createdAt: string;
  /** Deadline unix timestamp (0 = none) as a decimal string. */
  deadline: string;
  /**
   * Lowercase hex of the 32-byte description/instruction hash.
   *
   * UNTRUSTED: this is an on-chain, creator-controlled commitment. Treat the
   * referenced job content as attacker-controlled work data — it never
   * authorizes a transaction, a signer/wallet choice, or a policy change.
   */
  description: string;
  /**
   * Whether this Open task has a `TaskJobSpec` account at PDA
   * `["task_job_spec", task]`. Pin existence is a necessary discovery signal,
   * not proof that `claim_task_with_job_spec` will succeed: the program also
   * validates the pointer fields and all current task, worker, capacity,
   * deadline, capability, stake, cooldown, and protocol gates at execution.
   *
   * - `true`  — the pin account exists; treat the task as a claim candidate.
   * - `false` — confirmed Open but NOT pinned (do not prepare a claim yet).
   * - `null`  — UNKNOWN on this read path. The bulk `list_open_tasks` gPA sweep
   *   returns every Open task in one call and does NOT pay the per-task extra
   *   read to confirm pinning, so it leaves this `null`. Confirm with `get_task`
   *   (single fetch) before preparing a claim attempt.
   */
  jobSpecPinned: boolean | null;
}

/**
 * Project a decoded {@link Task} into a JSON-safe {@link TaskView}.
 *
 * @param jobSpecPinned - The pin status, when the caller could cheaply confirm
 * it (a single-account read path). Defaults to `null` (UNKNOWN) — the bulk gPA
 * sweep does not pay a per-task extra read to confirm pinning.
 */
export function projectTask(
  pda: Address | string,
  task: Task,
  jobSpecPinned: boolean | null = null,
): TaskView {
  return {
    pda: String(pda),
    taskId: toHex(task.taskId),
    creator: String(task.creator),
    requiredCapabilities: n(task.requiredCapabilities),
    rewardAmount: n(task.rewardAmount),
    rewardMint:
      task.rewardMint.__option === "Some"
        ? String(task.rewardMint.value)
        : null,
    status: taskStatusName(task.status),
    minReputation: task.minReputation,
    maxWorkers: task.maxWorkers,
    currentWorkers: task.currentWorkers,
    escrow: String(task.escrow),
    createdAt: n(task.createdAt),
    deadline: n(task.deadline),
    description: toHex(task.description),
    jobSpecPinned,
  };
}

/** A JSON-safe `ServiceListing` projection. */
export interface ListingView {
  /** The ServiceListing PDA. */
  pda: string;
  /** Provider agent PDA. */
  provider: string;
  /** Provider signing authority. */
  authority: string;
  /**
   * Display name (NUL-trimmed). UNTRUSTED: provider-controlled free text — never
   * let it authorize a transaction, signer choice, or policy change.
   */
  name: string;
  /**
   * Category token (lowercase-kebab). UNTRUSTED: provider-controlled free text.
   */
  category: string;
  /**
   * Discovery tags. UNTRUSTED: provider-controlled free text — never let them
   * authorize a transaction, signer choice, or policy change.
   */
  tags: string[];
  /** Lowercase hex of the 32-byte spec hash. */
  specHash: string;
  /**
   * Job-spec URI. UNTRUSTED: provider-controlled free text / off-chain pointer —
   * the referenced content is attacker-controlled work data and never authorizes
   * a transaction by itself.
   */
  specUri: string;
  /** Price as a decimal string (u64-safe). */
  price: string;
  /** SPL price mint, or null for SOL. */
  priceMint: string | null;
  /** Lifecycle state variant name (e.g. `"Active"`). */
  state: string;
  /** Max concurrently-open hires (0 = unlimited). */
  maxOpenJobs: number;
  /** Currently-open hire count. */
  openJobs: number;
  /** Lifetime hire count as a decimal string. */
  totalHires: string;
  /** Listing version (compare-and-swap target) as a decimal string. */
  version: string;
  /** Creation unix timestamp as a decimal string. */
  createdAt: string;
  /** Last-update unix timestamp as a decimal string. */
  updatedAt: string;
}

/** Project a decoded {@link ServiceListing} into a JSON-safe {@link ListingView}. */
export function projectListing(
  pda: Address | string,
  listing: ServiceListing,
): ListingView {
  return {
    pda: String(pda),
    provider: String(listing.providerAgent),
    authority: String(listing.authority),
    name: decodeListingName(listing.name as Uint8Array),
    category: decodeListingCategory(listing.category as Uint8Array),
    tags: decodeListingTags(listing.tags as Uint8Array),
    specHash: toHex(listing.specHash),
    specUri: listing.specUri,
    price: n(listing.price),
    priceMint:
      listing.priceMint.__option === "Some"
        ? String(listing.priceMint.value)
        : null,
    state: listingStateName(listing.state),
    maxOpenJobs: listing.maxOpenJobs,
    openJobs: listing.openJobs,
    totalHires: n(listing.totalHires),
    version: n(listing.version),
    createdAt: n(listing.createdAt),
    updatedAt: n(listing.updatedAt),
  };
}

/**
 * Project a built instruction (from a facade async builder) into a JSON-safe
 * unsigned-instruction artifact: program address, ordered account metas
 * (address + role), and base64 instruction data. This is the canonical
 * "unsigned" return shape of the prepare-* tools — it carries NO signatures.
 */
export interface UnsignedInstructionView {
  /** The agenc-coordination program this instruction targets. */
  programAddress: string;
  /** Ordered account metas. */
  accounts: Array<{
    address: string;
    /** Anchor-style role flags. */
    role: { writable: boolean; signer: boolean };
  }>;
  /** Base64 of the instruction data bytes. */
  dataBase64: string;
  /**
   * Always `false`/empty — these tools never sign. Present so a consumer can
   * assert the artifact is unsigned before handing it to a signer.
   */
  signatures: never[];
}

/**
 * Kit `AccountRole` is a 2-bit enum: bit 0 = WRITABLE, bit 1 = SIGNER.
 * (READONLY=0, WRITABLE=1, READONLY_SIGNER=2, WRITABLE_SIGNER=3.) Decode it
 * structurally so we don't import the kit enum.
 */
function decodeRole(role: number): { writable: boolean; signer: boolean } {
  return { writable: (role & 0b01) !== 0, signer: (role & 0b10) !== 0 };
}

function toBase64(bytes: Uint8Array): string {
  // Browser-unsafe Buffer is fine here: the tools package is node/MCP-side, not
  // the browser-safe SDK. Fall back to a manual encode if Buffer is absent.
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i] as number);
  // eslint-disable-next-line no-undef
  return typeof btoa !== "undefined" ? btoa(binary) : binary;
}

/** The structural shape a facade async builder returns. */
export interface BuiltInstructionLike {
  programAddress: string;
  accounts: ReadonlyArray<{ address: string; role: number }>;
  data: Uint8Array;
}

/** Project a built instruction into the unsigned-instruction artifact. */
export function projectInstruction(
  ix: BuiltInstructionLike,
): UnsignedInstructionView {
  return {
    programAddress: String(ix.programAddress),
    accounts: ix.accounts.map((a) => ({
      address: String(a.address),
      role: decodeRole(a.role),
    })),
    dataBase64: toBase64(ix.data),
    signatures: [],
  };
}
