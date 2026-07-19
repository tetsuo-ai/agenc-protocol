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
  COMPLETION_BOND_DISCRIMINATOR,
  HIRE_RECORD_DISCRIMINATOR,
  SERVICE_LISTING_DISCRIMINATOR,
  TASK_BID_DISCRIMINATOR,
  TASK_CLAIM_DISCRIMINATOR,
  TASK_DISCRIMINATOR,
  TASK_JOB_SPEC_DISCRIMINATOR,
  ListingState,
  TaskStatus,
  TaskType,
  getCompletionBondDecoder,
  getHireRecordDecoder,
  getServiceListingDecoder,
  getTaskBidDecoder,
  getTaskClaimDecoder,
  getTaskDecoder,
  getTaskJobSpecDecoder,
  type CompletionBond,
  type HireRecord,
  type ServiceListing,
  type Task,
  type TaskBid,
  type TaskClaim,
  type TaskJobSpec,
} from "../generated/index.js";
import {
  COMPLETION_BOND_TASK_OFFSET,
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
   * A worker capability bitmask. Keeps capability-compatible candidates, i.e.
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

/** Options for {@link listDirectClaimableTasks}. */
export type ListDirectClaimableTasksOptions = ListOpenTasksOptions & {
  /**
   * Unix timestamp used for the strict deadline gate. When omitted, local wall
   * time is sampled after all status reads, immediately before filtering.
   * Supply a chain-derived timestamp with `deadlineSafetySeconds: 0n` for the
   * exact on-chain Task deadline predicate.
   */
  nowUnixTimestamp?: bigint;
  /**
   * Safety added to the wall-clock deadline check (default 30 seconds). The
   * gPA/indexer transport cannot read Solana's Clock sysvar atomically with the
   * task snapshot, so near-deadline tasks are conservatively withheld. Set to
   * `0n` only when `nowUnixTimestamp` came from a chain clock.
   */
  deadlineSafetySeconds?: bigint;
};

/** The monolithic dispute unwind supports at most four simultaneous workers. */
const DISPUTE_SAFE_MAX_WORKERS = 4;

/** Bound ordinary client/validator clock skew without surfacing doomed work. */
export const DEFAULT_DIRECT_CLAIM_DEADLINE_SAFETY_SECONDS = 30n;

/** Exact 32-byte sentinel written for Task Validation V2 review tasks. */
const MANUAL_VALIDATION_SENTINEL = "agenc-manual-validation-v2-seed!";

function isManualValidationTask(task: Pick<Task, "constraintHash">): boolean {
  if (task.constraintHash.length !== MANUAL_VALIDATION_SENTINEL.length) {
    return false;
  }
  for (let index = 0; index < MANUAL_VALIDATION_SENTINEL.length; index += 1) {
    if (
      task.constraintHash[index] !==
      MANUAL_VALIDATION_SENTINEL.charCodeAt(index)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Evaluate every direct-claim gate derivable from the `Task` account at the
 * caller-supplied timestamp.
 *
 * This is deliberately narrower than "this worker's transaction will land":
 * job-spec/moderation/dependency/hire/config accounts and worker identity,
 * stake, reputation, active-task count, and prior-claim state require other
 * accounts. Callers still need those checks (the watcher separately requires a
 * pinned job spec).
 */
export function isTaskStateDirectlyClaimable(
  task: Task,
  nowUnixTimestamp: bigint,
): boolean {
  if (task.taskType === TaskType.BidExclusive) return false;

  const contest =
    (task.reserved[0] ?? 0) >= 1 && task.taskType === TaskType.Competitive;
  const claimableDuringPendingValidation =
    task.status === TaskStatus.PendingValidation &&
    (task.taskType === TaskType.Collaborative || contest) &&
    isManualValidationTask(task);
  const statusAllowsDirectClaim =
    task.status === TaskStatus.Open ||
    task.status === TaskStatus.InProgress ||
    claimableDuringPendingValidation;
  if (!statusAllowsDirectClaim) return false;

  if (task.deadline > 0n && nowUnixTimestamp >= task.deadline) return false;

  const effectiveMaxWorkers = Math.min(
    task.maxWorkers,
    DISPUTE_SAFE_MAX_WORKERS,
  );
  return task.currentWorkers < effectiveMaxWorkers;
}

/**
 * List tasks whose decoded task-state is eligible for the ordinary
 * `claim_task_with_job_spec` path.
 *
 * The program accepts capacity-bearing `Open` and `InProgress` tasks, plus
 * manual-review collaborative tasks and schema-1 contests during
 * `PendingValidation`. It rejects bid-exclusive tasks, expired tasks, and
 * tasks at `min(maxWorkers, 4)` live claims. Three status-filtered gPA reads
 * keep terminal accounts out of the response; the remaining gates and the
 * capability/reward refinements are applied client-side.
 *
 * By default this helper is conservative: it samples local time after the
 * serialized reads and adds a 30-second safety margin. Pass a chain-derived
 * `nowUnixTimestamp` with `deadlineSafetySeconds: 0n` to evaluate the exact
 * task-account portion of `process_claim`. It still does not prove that a job
 * spec is pinned or evaluate worker/config/related-account gates; see
 * {@link isTaskStateDirectlyClaimable}.
 */
export async function listDirectClaimableTasks(
  source: ProgramAccountsSource,
  options: ListDirectClaimableTasksOptions = {},
): Promise<Array<DecodedProgramAccount<Task>>> {
  const deadlineSafetySeconds =
    options.deadlineSafetySeconds ??
    DEFAULT_DIRECT_CLAIM_DEADLINE_SAFETY_SECONDS;
  if (typeof deadlineSafetySeconds !== "bigint" || deadlineSafetySeconds < 0n) {
    throw new RangeError("deadlineSafetySeconds must be non-negative");
  }
  if (
    options.nowUnixTimestamp !== undefined &&
    typeof options.nowUnixTimestamp !== "bigint"
  ) {
    throw new TypeError("nowUnixTimestamp must be a bigint");
  }

  const baseFilters: GpaFilter[] = [discriminatorFilter(TASK_DISCRIMINATOR)];
  if (options.creator !== undefined) {
    baseFilters.push({
      memcmp: {
        offset: TASK_CREATOR_OFFSET,
        bytes: addressBytes(options.creator),
      },
    });
  }

  const decoder = getTaskDecoder();
  const statuses = [
    TaskStatus.Open,
    TaskStatus.InProgress,
    TaskStatus.PendingValidation,
  ] as const;
  // ProgramAccountsTransport does not promise reentrancy. Keep the three
  // status scans serialized so custom indexer/embedded transports remain safe.
  const groups: Array<Array<DecodedProgramAccount<Task>>> = [];
  for (const status of statuses) {
    groups.push(
      await fetchDecoded(
        source,
        [
          ...baseFilters,
          {
            memcmp: {
              offset: TASK_STATUS_OFFSET,
              bytes: Uint8Array.of(status),
            },
          },
        ],
        (data) => decoder.decode(data),
      ),
    );
  }

  // A default wall-clock value captured before slow reads can be expired by
  // the time results arrive. Explicit timestamps remain fixed by design.
  const nowUnixTimestamp =
    options.nowUnixTimestamp ?? BigInt(Math.floor(Date.now() / 1000));
  const conservativeNow = nowUnixTimestamp + deadlineSafetySeconds;

  // Non-atomic status scans can straddle Open -> InProgress and return the
  // same PDA twice. Statuses are queried in lifecycle order, so later snapshots
  // replace earlier ones and the public result contains each address once.
  const latestByAddress = new Map<Address, DecodedProgramAccount<Task>>();
  for (const group of groups) {
    for (const task of group) latestByAddress.set(task.address, task);
  }

  let tasks = [...latestByAddress.values()].filter(({ account }) =>
    isTaskStateDirectlyClaimable(account, conservativeNow),
  );
  if (options.capabilities !== undefined) {
    const capabilities = options.capabilities;
    tasks = tasks.filter(
      ({ account }) =>
        (account.requiredCapabilities & capabilities) ===
        account.requiredCapabilities,
    );
  }
  if (options.minReward !== undefined) {
    const minReward = options.minReward;
    tasks = tasks.filter(({ account }) => account.rewardAmount >= minReward);
  }
  return tasks;
}

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
 * // Open discovery candidates compatible with capability 0b11 and paying at least 0.01 SOL:
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
function isNonZeroHash(hash: {
  length: number;
  [index: number]: number;
}): boolean {
  for (let i = 0; i < hash.length; i += 1) {
    if (hash[i] !== 0) return true;
  }
  return false;
}

/**
 * Unicode White_Space code points used by Rust `str::trim()` / `char::is_whitespace`.
 *
 * JavaScript `String.prototype.trim()` is deliberately not used here: JS trims
 * U+FEFF but not U+0085, while the on-chain Rust predicate does the opposite.
 */
const RUST_WHITESPACE_ONLY_PATTERN =
  /^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;

function isNonBlankJobSpecUri(uri: string): boolean {
  return !RUST_WHITESPACE_ONLY_PATTERN.test(uri);
}

async function fetchTaskJobSpecsForPinValidation(
  source: ProgramAccountsSource,
  filters: GpaFilter[],
): Promise<TaskJobSpec[]> {
  const transport = resolveProgramAccountsTransport(source);
  const decoder = getTaskJobSpecDecoder();
  const rows = await transport.getProgramAccounts({ filters });
  return rows.map(({ data }) => decoder.decode(data));
}

/**
 * List `TaskJobSpec` pointers whose value fields pass the pin checks this read
 * helper can evaluate.
 *
 * The pointer-value checks cover three things (see
 * `programs/agenc-coordination/src/instructions/claim_task.rs`): (1) a
 * `["task_job_spec", task]` PDA must EXIST (it is taken as a plain
 * `Account<TaskJobSpec>`; absent ⇒ Anchor `AccountNotInitialized` / 3012), and
 * (2) `validate_job_spec_pointer` requires `job_spec_hash` to have at least one
 * non-zero byte, and (3) Rust `job_spec_uri.trim()` must be non-empty. This
 * helper mirrors those three (including Rust's exact Unicode-whitespace set): it
 * gPA-fetches every `TaskJobSpec` account (discriminator filter) and keeps only
 * valid pointer values, returning their declared task PDAs. The claim
 * transaction additionally enforces the canonical `["task_job_spec", task]`
 * address and binds `TaskJobSpec.task`/`creator` to the supplied Task; this
 * account scan cannot establish those cross-account constraints by itself.
 *
 * A task being `TaskStatus.Open` is NOT sufficient for a claim to land — a task
 * is minted Open by `create_task` BEFORE any job spec exists (`set_task_job_spec`
 * is a separate, later, moderation-gated tx). Use this set to intersect with
 * {@link listDirectClaimableTasks} so you only surface task-state candidates
 * with valid immutable job-spec pointers.
 *
 * @param source - A kit `Rpc<GetProgramAccountsApi>` or a
 * {@link ProgramAccountsTransport} (e.g. the Phase-3 hosted indexer client).
 * @returns A `Set<Address>` of Task PDAs that have a pinned job spec.
 */
export async function listPinnedJobSpecTasks(
  source: ProgramAccountsSource,
): Promise<Set<Address>> {
  const specs = await fetchTaskJobSpecsForPinValidation(source, [
    discriminatorFilter(TASK_JOB_SPEC_DISCRIMINATOR),
  ]);
  const pinned = new Set<Address>();
  for (const account of specs) {
    if (
      isNonZeroHash(account.jobSpecHash) &&
      isNonBlankJobSpecUri(account.jobSpecUri)
    ) {
      pinned.add(account.task);
    }
  }
  return pinned;
}

/**
 * Check whether a SINGLE task has a job-spec pointer whose value fields pass
 * the pin checks this read helper evaluates (see {@link listPinnedJobSpecTasks}
 * for the full rationale).
 *
 * Server-side memcmp on `TaskJobSpec.task` narrows the fetch to the one PDA, so
 * this is a cheap targeted lookup (used by the event path, where only a single
 * task is in hand). Returns `true` iff the pointer exists, its `jobSpecHash` is
 * non-zero, and its URI is non-empty after Rust-compatible trimming.
 *
 * @param source - A kit `Rpc<GetProgramAccountsApi>` or a
 * {@link ProgramAccountsTransport}.
 * @param task - The Task PDA to check.
 * @returns `true` iff the task's job-spec pointer passes pin validation. This
 * does not establish the canonical task/creator account constraints or that a
 * claim will pass the remaining task/worker gates.
 */
export async function isTaskJobSpecPinned(
  source: ProgramAccountsSource,
  task: Address,
): Promise<boolean> {
  const specs = await fetchTaskJobSpecsForPinValidation(source, [
    discriminatorFilter(TASK_JOB_SPEC_DISCRIMINATOR),
    {
      memcmp: {
        offset: TASK_JOB_SPEC_TASK_OFFSET,
        bytes: addressBytes(task),
      },
    },
  ]);
  return specs.some(
    (account) =>
      isNonZeroHash(account.jobSpecHash) &&
      isNonBlankJobSpecUri(account.jobSpecUri),
  );
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

/** `CompletionBond.role` byte for the creator-posted bond. */
export const COMPLETION_BOND_ROLE_CREATOR = 0;
/** `CompletionBond.role` byte for the worker-posted bond. */
export const COMPLETION_BOND_ROLE_WORKER = 1;

/**
 * A task's completion-bond ("Guaranteed Hire") state — see
 * {@link fetchTaskGuarantee}.
 */
export type TaskGuarantee = {
  /**
   * `true` iff the WORKER bond is live (posted and not yet settled): the
   * worker has 25% of the reward at stake behind their result.
   */
  guaranteed: boolean;
  /** The live worker bond (role 1), or `null` when none is posted/unsettled. */
  workerBond: DecodedProgramAccount<CompletionBond> | null;
  /** The live creator bond (role 0), or `null` when none is posted/unsettled. */
  creatorBond: DecodedProgramAccount<CompletionBond> | null;
};

/**
 * Fetch a task's completion-bond state — the read side of **Guaranteed Hire**:
 * a worker who posts a completion bond stakes 25% of the reward on passing
 * review, and forfeits it if the result is rejected or they lose a dispute.
 *
 * One gPA round trip: server-side memcmp on `CompletionBond.task` narrows to
 * the task's (at most two) bonds, split client-side by `role`. A bond PDA is
 * refunded-or-forfeited AND CLOSED by every settlement exit (accept /
 * complete / cancel / dispute / reject-frozen / reclaim), so a bond account
 * existing on-chain means exactly "posted and unresolved" — `guaranteed` is
 * `true` iff the worker bond is live.
 *
 * HONEST BOUNDARY (do not overclaim in UI copy): in the live phase-1 program a
 * FORFEITED bond pays the protocol **treasury**, not the harmed party. The
 * buyer's protection today is the escrow refund on a failed review PLUS the
 * worker's 25% skin in the game — the buyer does not receive the bond itself.
 * Phase 2 (batch-2 program work) redirects forfeiture to the harmed party.
 *
 * @param source - A kit `Rpc<GetProgramAccountsApi>` or a
 * {@link ProgramAccountsTransport} (e.g. the Phase-3 hosted indexer client).
 * @param task - The Task PDA to inspect.
 * @returns The {@link TaskGuarantee}: live worker/creator bonds + `guaranteed`.
 *
 * @example
 * ```ts
 * const { guaranteed, workerBond } = await fetchTaskGuarantee(rpc, taskPda);
 * if (guaranteed) console.log(`worker staked ${workerBond!.account.amount}`);
 * ```
 */
export async function fetchTaskGuarantee(
  source: ProgramAccountsSource,
  task: Address,
): Promise<TaskGuarantee> {
  const decoder = getCompletionBondDecoder();
  const bonds = await fetchDecoded(
    source,
    [
      discriminatorFilter(COMPLETION_BOND_DISCRIMINATOR),
      {
        memcmp: {
          offset: COMPLETION_BOND_TASK_OFFSET,
          bytes: addressBytes(task),
        },
      },
    ],
    (d) => decoder.decode(d),
  );
  const workerBond =
    bonds.find(({ account }) => account.role === COMPLETION_BOND_ROLE_WORKER) ??
    null;
  const creatorBond =
    bonds.find(
      ({ account }) => account.role === COMPLETION_BOND_ROLE_CREATOR,
    ) ?? null;
  return { guaranteed: workerBond !== null, workerBond, creatorBond };
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
