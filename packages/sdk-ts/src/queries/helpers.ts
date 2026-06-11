// Typed getProgramAccounts query helpers (the trustless gPA read path).
//
// Every helper:
//   - always includes `{ memcmp: { offset: 0, bytes: ACCOUNT_DISCRIMINATOR } }`
//     so only the targeted account type matches;
//   - narrows further with memcmp filters at the offsets in ./offsets.js;
//   - decodes results with the generated decoders and returns
//     `Array<{ address, account }>`.
//
// Filters that CANNOT be expressed as memcmp (bitmask supersets, numeric
// ranges, fields at variable offsets) are refined CLIENT-SIDE after the fetch —
// each helper documents exactly which of its filters are server-side vs
// client-side.
import { getAddressEncoder, type Address } from "@solana/kit";
import {
  HIRE_RECORD_DISCRIMINATOR,
  SERVICE_LISTING_DISCRIMINATOR,
  TASK_BID_DISCRIMINATOR,
  TASK_CLAIM_DISCRIMINATOR,
  TASK_DISCRIMINATOR,
  TASK_JOB_SPEC_DISCRIMINATOR,
  ListingState,
  TaskStatus,
  getHireRecordDecoder,
  getServiceListingDecoder,
  getTaskBidDecoder,
  getTaskClaimDecoder,
  getTaskDecoder,
  getTaskJobSpecDecoder,
  type HireRecord,
  type ServiceListing,
  type Task,
  type TaskBid,
  type TaskClaim,
} from "../generated/index.js";
import {
  HIRE_RECORD_TASK_OFFSET,
  SERVICE_LISTING_CATEGORY_OFFSET,
  SERVICE_LISTING_PROVIDER_AGENT_OFFSET,
  TASK_BID_TASK_OFFSET,
  TASK_CLAIM_WORKER_OFFSET,
  TASK_CREATOR_OFFSET,
  TASK_JOB_SPEC_TASK_OFFSET,
  TASK_STATUS_OFFSET,
} from "./offsets.js";
import {
  resolveProgramAccountsTransport,
  type GpaFilter,
  type ProgramAccountsSource,
} from "./transport.js";

/** A decoded program account paired with its on-chain address. */
export type DecodedProgramAccount<TAccount> = {
  /** The account's address. */
  address: Address;
  /** The decoded account data. */
  account: TAccount;
};

/** Build the discriminator memcmp filter every helper leads with. */
function discriminatorFilter(
  discriminator: Parameters<typeof Uint8Array.from>[0],
): GpaFilter {
  return { memcmp: { offset: 0, bytes: Uint8Array.from(discriminator) } };
}

/** 32 raw bytes of a base58 address, for memcmp filters on Pubkey fields. */
function addressBytes(addr: Address): Uint8Array {
  return new Uint8Array(getAddressEncoder().encode(addr));
}

/** Fetch matching accounts through the transport seam and decode each one. */
async function fetchDecoded<TAccount>(
  source: ProgramAccountsSource,
  filters: GpaFilter[],
  decode: (data: Uint8Array) => TAccount,
): Promise<Array<DecodedProgramAccount<TAccount>>> {
  const transport = resolveProgramAccountsTransport(source);
  const raw = await transport.getProgramAccounts({ filters });
  return raw.map(({ address, data }) => ({ address, account: decode(data) }));
}

/**
 * Lowercase-kebab rule for string categories. Deliberately DUPLICATED from the
 * values module's `LISTING_KEBAB_PATTERN` (keep in lockstep) — the query layer
 * takes no dependency on the values module.
 */
const CATEGORY_KEBAB_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * NUL-pad a category string to the 32-byte on-chain form. (Deliberately inlined
 * here — the query layer takes no dependency on the values module.)
 *
 * String categories are validated against the same lowercase-kebab rule the
 * write path enforces (`facade.createServiceListing` rejects anything else),
 * so a string that could never match a facade-written listing throws loudly
 * instead of silently memcmp-matching nothing. The raw 32-byte form stays
 * unvalidated as the escape hatch for non-standard listings written by raw
 * clients (the program itself does not validate category bytes).
 */
function toCategoryBytes(category: Uint8Array | string): Uint8Array {
  if (typeof category !== "string") {
    if (category.length !== 32) {
      throw new Error(
        `queries: a raw category must be exactly 32 bytes (got ${category.length})`,
      );
    }
    return category;
  }
  if (!CATEGORY_KEBAB_PATTERN.test(category)) {
    throw new TypeError(
      `queries: category ${JSON.stringify(category)} is not lowercase-kebab ` +
        "([a-z0-9]+(-[a-z0-9]+)*) — facade-written listings only ever store " +
        "lowercase-kebab categories, so this string could never match; pass " +
        "the raw 32-byte form to query non-standard listings",
    );
  }
  const utf8 = new TextEncoder().encode(category);
  if (utf8.length > 32) {
    throw new Error(
      `queries: category string encodes to ${utf8.length} bytes (max 32)`,
    );
  }
  const padded = new Uint8Array(32); // NUL-padded
  padded.set(utf8);
  return padded;
}

/** Options for {@link listActiveListings}. */
export type ListActiveListingsOptions = {
  /**
   * The provider's **AgentRegistration PDA** (matches
   * `ServiceListing.providerAgent`), not the provider's wallet authority.
   * Server-side memcmp filter.
   */
  provider?: Address;
  /**
   * Category to match: either the raw 32-byte on-chain form, or a plain string
   * that is NUL-padded to 32 bytes for you. Server-side memcmp filter.
   *
   * Matching is EXACT-BYTES (no prefix/substring semantics). Listings written
   * via the facade always store a canonical lowercase-kebab token (see
   * `LISTING_CATEGORIES` / docs/LISTING_METADATA.md, e.g. `"code-generation"`),
   * so string input is validated against the same lowercase-kebab rule and
   * throws a `TypeError` otherwise — a non-kebab string could only ever match
   * nothing. Use the raw 32-byte form to query non-standard listings written
   * by raw clients.
   */
  category?: Uint8Array | string;
  /**
   * Listing lifecycle state to keep. Defaults to {@link ListingState.Active}.
   * CLIENT-SIDE filter — see the note below.
   */
  state?: ListingState;
};

/**
 * List service listings, filtered by provider/category on the server and by
 * lifecycle state on the client (default: Active).
 *
 * `state` is refined CLIENT-SIDE after the fetch because
 * `ServiceListing.state` sits after the variable-length `specUri` string and
 * the variable-width `priceMint` Option, so it has no fixed byte offset and
 * cannot be memcmp-matched (see src/queries/offsets.ts).
 *
 * @param source - A kit `Rpc<GetProgramAccountsApi>` or a
 * {@link ProgramAccountsTransport} (e.g. the Phase-3 hosted indexer client).
 * @param options - Optional provider / category / state filters.
 * @returns Decoded `ServiceListing`s with their addresses.
 *
 * @example
 * ```ts
 * // Category matching is exact-bytes against the canonical lowercase-kebab
 * // token (no prefix/substring matching — "code" would NOT match this):
 * const codeListings = await listActiveListings(rpc, {
 *   category: "code-generation",
 * });
 * ```
 */
export async function listActiveListings(
  source: ProgramAccountsSource,
  options: ListActiveListingsOptions = {},
): Promise<Array<DecodedProgramAccount<ServiceListing>>> {
  const filters: GpaFilter[] = [
    discriminatorFilter(SERVICE_LISTING_DISCRIMINATOR),
  ];
  if (options.provider !== undefined) {
    filters.push({
      memcmp: {
        offset: SERVICE_LISTING_PROVIDER_AGENT_OFFSET,
        bytes: addressBytes(options.provider),
      },
    });
  }
  if (options.category !== undefined) {
    filters.push({
      memcmp: {
        offset: SERVICE_LISTING_CATEGORY_OFFSET,
        bytes: toCategoryBytes(options.category),
      },
    });
  }
  const decoder = getServiceListingDecoder();
  const all = await fetchDecoded(source, filters, (d) => decoder.decode(d));
  const wantState = options.state ?? ListingState.Active;
  return all.filter(({ account }) => account.state === wantState);
}

/** Options for {@link listOpenTasks}. */
export type ListOpenTasksOptions = {
  /**
   * A worker capability bitmask. Keeps only tasks the worker can claim, i.e.
   * `(task.requiredCapabilities & capabilities) === task.requiredCapabilities`.
   * CLIENT-SIDE filter — bitmask-superset matching cannot be expressed as a
   * memcmp byte comparison.
   */
  capabilities?: bigint;
  /**
   * Keep only tasks with `rewardAmount >= minReward` (lamports).
   * CLIENT-SIDE filter — range comparisons cannot be expressed as memcmp.
   */
  minReward?: bigint;
  /** Task creator wallet (`Task.creator`). Server-side memcmp filter. */
  creator?: Address;
};

/**
 * List Open tasks (status filtered server-side via memcmp at the fixed
 * `Task.status` offset), optionally narrowed by creator (server-side) and by
 * worker capabilities / minimum reward.
 *
 * LOUD NOTE: `capabilities` (bitmask superset) and `minReward` (numeric range)
 * CANNOT be matched with RPC memcmp filters — memcmp only does exact byte
 * equality. They are refined CLIENT-SIDE after the fetch, so the RPC still
 * returns (and you still download) every Open task matching the server-side
 * filters before refinement.
 *
 * @param source - A kit `Rpc<GetProgramAccountsApi>` or a
 * {@link ProgramAccountsTransport} (e.g. the Phase-3 hosted indexer client).
 * @param options - Optional capabilities / minReward / creator filters.
 * @returns Decoded Open `Task`s with their addresses.
 *
 * @example
 * ```ts
 * // Tasks a capability-0b11 worker could claim, paying at least 0.01 SOL:
 * const open = await listOpenTasks(rpc, { capabilities: 0b11n, minReward: 10_000_000n });
 * ```
 */
export async function listOpenTasks(
  source: ProgramAccountsSource,
  options: ListOpenTasksOptions = {},
): Promise<Array<DecodedProgramAccount<Task>>> {
  const filters: GpaFilter[] = [
    discriminatorFilter(TASK_DISCRIMINATOR),
    {
      memcmp: {
        offset: TASK_STATUS_OFFSET,
        bytes: Uint8Array.of(TaskStatus.Open),
      },
    },
  ];
  if (options.creator !== undefined) {
    filters.push({
      memcmp: {
        offset: TASK_CREATOR_OFFSET,
        bytes: addressBytes(options.creator),
      },
    });
  }
  const decoder = getTaskDecoder();
  let tasks = await fetchDecoded(source, filters, (d) => decoder.decode(d));
  if (options.capabilities !== undefined) {
    const caps = options.capabilities;
    tasks = tasks.filter(
      ({ account }) =>
        (account.requiredCapabilities & caps) === account.requiredCapabilities,
    );
  }
  if (options.minReward !== undefined) {
    const min = options.minReward;
    tasks = tasks.filter(({ account }) => account.rewardAmount >= min);
  }
  return tasks;
}

/** True iff a job-spec hash has at least one non-zero byte. */
function isNonZeroHash(hash: { length: number; [index: number]: number }): boolean {
  for (let i = 0; i < hash.length; i += 1) {
    if (hash[i] !== 0) return true;
  }
  return false;
}

/**
 * List the `TaskJobSpec` pointers that are genuinely PINNED — i.e. the exact
 * on-chain precondition `claim_task_with_job_spec` enforces.
 *
 * The program gates a claim on TWO things (see
 * `programs/agenc-coordination/src/instructions/claim_task.rs`): (1) the
 * `["task_job_spec", task]` PDA must EXIST (it is taken as a plain
 * `Account<TaskJobSpec>`; absent ⇒ Anchor `AccountNotInitialized` / 3012), and
 * (2) `validate_job_spec_pointer` requires `job_spec_hash` to have at least one
 * non-zero byte. This helper mirrors both: it gPA-fetches every `TaskJobSpec`
 * account (discriminator filter) and keeps only those whose `jobSpecHash` is
 * non-zero, returning the set of `task` PDAs that are actually claimable.
 *
 * A task being `TaskStatus.Open` is NOT sufficient for a claim to land — a task
 * is minted Open by `create_task` BEFORE any job spec exists (`set_task_job_spec`
 * is a separate, later, moderation-gated tx). Use this set to intersect with
 * {@link listOpenTasks} so you only surface tasks a worker can actually claim.
 *
 * @param source - A kit `Rpc<GetProgramAccountsApi>` or a
 * {@link ProgramAccountsTransport} (e.g. the Phase-3 hosted indexer client).
 * @returns A `Set<Address>` of Task PDAs that have a pinned job spec.
 */
export async function listPinnedJobSpecTasks(
  source: ProgramAccountsSource,
): Promise<Set<Address>> {
  const decoder = getTaskJobSpecDecoder();
  const specs = await fetchDecoded(
    source,
    [discriminatorFilter(TASK_JOB_SPEC_DISCRIMINATOR)],
    (d) => decoder.decode(d),
  );
  const pinned = new Set<Address>();
  for (const { account } of specs) {
    if (isNonZeroHash(account.jobSpecHash)) pinned.add(account.task);
  }
  return pinned;
}

/**
 * Check whether a SINGLE task has a pinned job spec — the exact on-chain
 * precondition `claim_task_with_job_spec` enforces (see
 * {@link listPinnedJobSpecTasks} for the full rationale).
 *
 * Server-side memcmp on `TaskJobSpec.task` narrows the fetch to the one PDA, so
 * this is a cheap targeted lookup (used by the event path, where only a single
 * task is in hand). Returns `true` iff the pointer exists AND its `jobSpecHash`
 * is non-zero.
 *
 * @param source - A kit `Rpc<GetProgramAccountsApi>` or a
 * {@link ProgramAccountsTransport}.
 * @param task - The Task PDA to check.
 * @returns `true` iff the task's job spec is pinned (claimable).
 */
export async function isTaskJobSpecPinned(
  source: ProgramAccountsSource,
  task: Address,
): Promise<boolean> {
  const decoder = getTaskJobSpecDecoder();
  const specs = await fetchDecoded(
    source,
    [
      discriminatorFilter(TASK_JOB_SPEC_DISCRIMINATOR),
      {
        memcmp: {
          offset: TASK_JOB_SPEC_TASK_OFFSET,
          bytes: addressBytes(task),
        },
      },
    ],
    (d) => decoder.decode(d),
  );
  return specs.some(({ account }) => isNonZeroHash(account.jobSpecHash));
}

/**
 * List the task claims held by a worker **agent**.
 *
 * @param source - A kit `Rpc<GetProgramAccountsApi>` or a
 * {@link ProgramAccountsTransport} (e.g. the Phase-3 hosted indexer client).
 * @param workerAgent - The worker's **AgentRegistration PDA** — the on-chain
 * `TaskClaim.worker` field stores the agent PDA, NOT the worker's wallet
 * authority. (Derive it with `findAgentPda({ agentId })` if needed.)
 * @returns Decoded `TaskClaim`s with their addresses.
 */
export async function listClaimsForWorker(
  source: ProgramAccountsSource,
  workerAgent: Address,
): Promise<Array<DecodedProgramAccount<TaskClaim>>> {
  const decoder = getTaskClaimDecoder();
  return fetchDecoded(
    source,
    [
      discriminatorFilter(TASK_CLAIM_DISCRIMINATOR),
      {
        memcmp: {
          offset: TASK_CLAIM_WORKER_OFFSET,
          bytes: addressBytes(workerAgent),
        },
      },
    ],
    (d) => decoder.decode(d),
  );
}

/**
 * List ALL of a provider's service listings, in every lifecycle state
 * (use {@link listActiveListings} with `provider` to keep only Active ones).
 *
 * @param source - A kit `Rpc<GetProgramAccountsApi>` or a
 * {@link ProgramAccountsTransport} (e.g. the Phase-3 hosted indexer client).
 * @param providerAgent - The provider's **AgentRegistration PDA** (matches
 * `ServiceListing.providerAgent`), not the provider's wallet authority.
 * @returns Decoded `ServiceListing`s with their addresses.
 */
export async function listingsByProvider(
  source: ProgramAccountsSource,
  providerAgent: Address,
): Promise<Array<DecodedProgramAccount<ServiceListing>>> {
  const decoder = getServiceListingDecoder();
  return fetchDecoded(
    source,
    [
      discriminatorFilter(SERVICE_LISTING_DISCRIMINATOR),
      {
        memcmp: {
          offset: SERVICE_LISTING_PROVIDER_AGENT_OFFSET,
          bytes: addressBytes(providerAgent),
        },
      },
    ],
    (d) => decoder.decode(d),
  );
}

/**
 * List all bids placed on a task (any bid state).
 *
 * @param source - A kit `Rpc<GetProgramAccountsApi>` or a
 * {@link ProgramAccountsTransport} (e.g. the Phase-3 hosted indexer client).
 * @param task - The Task PDA the bids target (`TaskBid.task`).
 * @returns Decoded `TaskBid`s with their addresses.
 */
export async function bidsByTask(
  source: ProgramAccountsSource,
  task: Address,
): Promise<Array<DecodedProgramAccount<TaskBid>>> {
  const decoder = getTaskBidDecoder();
  return fetchDecoded(
    source,
    [
      discriminatorFilter(TASK_BID_DISCRIMINATOR),
      { memcmp: { offset: TASK_BID_TASK_OFFSET, bytes: addressBytes(task) } },
    ],
    (d) => decoder.decode(d),
  );
}

/**
 * List the hire records for everything a buyer has hired.
 *
 * LOUD NOTE: `HireRecord` stores NO buyer field — the buyer's identity lives on
 * the minted Task (`Task.creator`). This helper therefore makes TWO gPA round
 * trips and joins client-side: (1) fetch the buyer's tasks by `Task.creator`
 * memcmp, (2) fetch all `HireRecord`s by discriminator and keep those whose
 * `task` is one of the buyer's tasks. Over the hosted indexer transport
 * (Phase 3) the same call works unchanged, just faster.
 *
 * @param source - A kit `Rpc<GetProgramAccountsApi>` or a
 * {@link ProgramAccountsTransport} (e.g. the Phase-3 hosted indexer client).
 * @param buyer - The buyer's wallet (the `Task.creator` of the hired tasks).
 * @returns Decoded `HireRecord`s with their addresses.
 */
export async function listHireRecordsForBuyer(
  source: ProgramAccountsSource,
  buyer: Address,
): Promise<Array<DecodedProgramAccount<HireRecord>>> {
  const taskDecoder = getTaskDecoder();
  const buyerTasks = await fetchDecoded(
    source,
    [
      discriminatorFilter(TASK_DISCRIMINATOR),
      { memcmp: { offset: TASK_CREATOR_OFFSET, bytes: addressBytes(buyer) } },
    ],
    (d) => taskDecoder.decode(d),
  );
  const buyerTaskAddresses = new Set<Address>(
    buyerTasks.map(({ address }) => address),
  );
  const hireDecoder = getHireRecordDecoder();
  const hires = await fetchDecoded(
    source,
    [discriminatorFilter(HIRE_RECORD_DISCRIMINATOR)],
    (d) => hireDecoder.decode(d),
  );
  return hires.filter(({ account }) => buyerTaskAddresses.has(account.task));
}
