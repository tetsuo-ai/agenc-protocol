// Worker-notification convenience: watch for NEW direct-claim candidates without a
// bespoke poll loop.
//
// `watchClaimableTasks` fuses two read paths the SDK already exposes:
//
//   1. LIVE EVENTS — `subscribeMarketplaceEvents` (the events module). A
//      `TaskCreated` event is only a hint: before delivery the watcher reads the
//      current Task account and applies the same task-state/capacity/deadline
//      predicate as `process_claim`, then confirms the separately-pinned job
//      spec. This avoids surfacing an already-filled or bid-exclusive task from
//      a delayed event.
//   2. CATCH-UP / FALLBACK — `listDirectClaimableTasks` (the queries read path)
//      over a `ProgramAccountsSource` (a kit `Rpc`, a
//      `ProgramAccountsTransport`, or the hosted indexer's transport). One
//      initial sweep catches tasks created before the watch started; periodic
//      sweeps reliably discover capacity-bearing
//      Open/InProgress/manual-review tasks and intersect them with pinned job
//      specs.
//
// TASK-STATE PREDICATE: direct-claim status + remaining effective capacity +
// unexpired deadline + non-BidExclusive type, AND a pinned job spec. This
// mirrors every `process_claim` gate derivable from Task itself; worker-,
// config-, moderation-, dependency-, and hire-specific accounts remain the
// authoritative transaction-time checks. Confirming state and the pin requires
// a read source, so a bare `rpcSubscriptions` is rejected synchronously.
//
// Both paths feed one de-duped, filtered stream. A task is surfaced AT MOST
// once while continuously eligible under the candidate-discovery predicate. It re-fires after a successful sweep
// observes absence, or when a later on-chain claim generation appears in the
// otherwise-indistinguishable Open+0-workers reopen shape. Generation zero
// retains the legacy counter/absent-sweep fallback. The active set is bounded
// without evicting live entries.
import {
  isSome,
  unwrapOption,
  type Address,
  type Commitment,
} from "@solana/kit";
import { findTaskPda, TaskStatus, type Task } from "../generated/index.js";
import {
  subscribeMarketplaceEvents,
  type MarketplaceEventsPollingRpc,
  type MarketplaceEventsRpcSubscriptions,
} from "../events/index.js";
import {
  DEFAULT_DIRECT_CLAIM_DEADLINE_SAFETY_SECONDS,
  isTaskJobSpecPinned,
  isTaskStateDirectlyClaimable,
  listDirectClaimableTasks,
  listPinnedJobSpecTasks,
  type ProgramAccountsSource,
} from "../queries/index.js";

/**
 * Local discovery criteria for claim candidates. These fields do not establish
 * worker eligibility or claim success; transaction-time task, worker, config,
 * and protocol gates remain authoritative. Every field is optional; an omitted
 * field imposes no constraint. The same predicate is applied to BOTH the event
 * path and the catch-up/poll path, so the two transports surface an identical set.
 */
export type ClaimableTaskFilter = {
  /**
   * The worker's capability bitmask. Keeps capability-compatible tasks,
   * i.e. `(task.requiredCapabilities & capabilities) === task.requiredCapabilities`
   * (the worker's capabilities must be a SUPERSET of the task's requirement).
   */
  capabilities?: bigint;
  /** Keep only tasks whose `rewardAmount >= minReward` (lamports / token base units). */
  minReward?: bigint;
  /** Keep only tasks created by this wallet (`Task.creator`). */
  creator?: Address;
};

/**
 * A direct-claim candidate surfaced to {@link WatchClaimableTasksOptions.onTask}.
 * The public type name is historical API terminology, not a claim-success
 * guarantee; the transaction re-evaluates every authoritative gate.
 *
 * The fields common to both transports (`task`, `creator`, `taskId`,
 * `requiredCapabilities`, `rewardAmount`, `rewardMint`) are always present.
 * `account` carries the fully-decoded current on-chain {@link Task}. It is
 * populated on both paths because even a live event is revalidated against
 * current task state before delivery.
 */
export type ClaimableTask = {
  /** The Task PDA (derived from `creator` + `taskId`) — the de-dupe key. */
  task: Address;
  /** Task creator (paying party). */
  creator: Address;
  /** The 32-byte task id seed. */
  taskId: Uint8Array;
  /** The task's required-capability bitmask. */
  requiredCapabilities: bigint;
  /** Reward amount (lamports for SOL, token base units otherwise). */
  rewardAmount: bigint;
  /** Reward mint, or `null` for SOL-denominated rewards. */
  rewardMint: Address | null;
  /** Which read path first surfaced this task. */
  source: "event" | "catch-up";
  /**
   * The fully-decoded current on-chain {@link Task} account.
   */
  account?: Task;
};

/**
 * Options for {@link watchClaimableTasks}.
 *
 * TRANSPORTS — provide one required read path and optionally live hints:
 * - `rpcSubscriptions` arms the LIVE WebSocket event path (recommended:
 *   sub-second notification of new tasks).
 * - `rpc` serves the initial catch-up sweep AND the polling fallback: it is
 *   the `getProgramAccounts` source for {@link listDirectClaimableTasks} and,
 *   when `rpcSubscriptions` is absent/unavailable, the
 *   `subscribeMarketplaceEventsViaPolling` log-scan source. A kit `Rpc`
 *   satisfies both; a bare `ProgramAccountsTransport` serves only the gPA
 *   catch-up.
 * - `indexer` is an explicit catch-up/poll read source (e.g. the hosted
 *   indexer's `ProgramAccountsTransport`) used INSTEAD OF `rpc` for the
 *   `listDirectClaimableTasks` sweep when you want the scale read path; it does
 *   not carry the WebSocket event path. When both `rpc` and `indexer` are
 *   given, `indexer` is used for catch-up and `rpc` (if a polling RPC) still
 *   arms the event-polling fallback.
 *
 * A getProgramAccounts-capable `rpc` or `indexer` MUST be provided.
 * `rpcSubscriptions` is an optional low-latency hint source.
 *
 * CANDIDATE READ SOURCE: surfacing a task requires confirming its current task
 * state and job-spec pin, which needs a `getProgramAccounts`
 * read source. A catch-up source (`rpc` that serves gPA, or `indexer`) is
 * REQUIRED for every mode — including event-path tasks. A bare subscription is
 * rejected synchronously instead of silently dropping every event.
 */
export type WatchClaimableTasksOptions = {
  /** Live event source (kit `RpcSubscriptions` or a structural double). */
  rpcSubscriptions?: MarketplaceEventsRpcSubscriptions | null;
  /**
   * Catch-up/poll read source. A kit `Rpc` doubles as the polling-fallback log
   * scanner and the {@link listDirectClaimableTasks} gPA source; a bare
   * {@link ProgramAccountsTransport} serves only the gPA catch-up.
   */
  rpc?:
    | (MarketplaceEventsPollingRpc & ProgramAccountsSource)
    | ProgramAccountsSource;
  /**
   * Alternate catch-up read source for the
   * {@link listDirectClaimableTasks} sweep (e.g. the hosted indexer transport).
   * Used in preference to `rpc` for catch-up.
   */
  indexer?: ProgramAccountsSource;
  /** Local discovery filter. Omit to surface every task-state candidate. */
  filter?: ClaimableTaskFilter;
  /**
   * Invoked once per newly discovered claim candidate. May be async; rejections route to
   * `onError`. The signal aborts when the watch stops so cooperative handlers
   * can cancel their own I/O. `stop()` does not wait indefinitely for a
   * handler that ignores the signal.
   */
  onTask: (task: ClaimableTask, signal: AbortSignal) => void | Promise<void>;
  /**
   * Invoked for any transport or `onTask` handler error. If omitted, either
   * kind of error stops the watch (the async iterator rejects and `stop()`
   * settles). Errors thrown or rejected by `onError` itself are swallowed.
   */
  onError?: (error: unknown) => unknown;
  /** Abort to stop the watch (equivalent to calling {@link ClaimableTaskWatch.stop}). */
  signal?: AbortSignal;
  /**
   * Catch-up/poll sweep interval in milliseconds (default `5000`). The first
   * sweep runs immediately; subsequent sweeps run every `pollIntervalMs`.
   */
  pollIntervalMs?: number;
  /** Commitment for the underlying reads (default `"confirmed"`). */
  commitment?: Commitment;
  /**
   * Maximum concurrently eligible candidates tracked for de-duplication (default
   * `10_000`). At capacity, additional tasks are deferred until a complete
   * successful sweep shows a tracked task no longer matches the candidate predicate. Active
   * entries are never evicted within a sweep, preventing repeated delivery of
   * an oversized steady-state backlog. Must be a positive safe integer.
   */
  maxSeen?: number;
  /**
   * Maximum tasks buffered for an attached async iterator (default `1000`).
   * Producers apply backpressure when the iterator is slower than this bound.
   * Callback-only watches allocate no iterator queue.
   */
  maxQueue?: number;
  /**
   * Cap (ms) on the exponential backoff applied between CONSECUTIVE FAILED
   * catch-up sweeps (default `30_000`), independent of `pollIntervalMs`. A
   * persistently-failing RPC backs off 2×, 4×, … up to this cap instead of
   * retrying tightly every `pollIntervalMs`; the backoff resets to zero after
   * any successful sweep. Set to `pollIntervalMs` to disable extra backoff.
   */
  maxBackoffMs?: number;
  /**
   * Timeout for an entire serialized task-state + job-spec read sequence
   * (default `30_000` ms). A timeout is terminal: the watch reports it once and
   * aborts, because starting another request while a non-cancellable transport
   * remains pending would violate the transport's non-reentrancy contract.
   * Teardown does not await that underlying promise. Idle subscription reads
   * are not timed out; they are still aborted by `signal`/`stop()`.
   */
  operationTimeoutMs?: number;
  /**
   * Seconds added to local wall time before the strict deadline comparison
   * (default `30n`). The read-source seam cannot fetch Solana's Clock sysvar
   * atomically with task accounts, so this conservatively withholds work near
   * its deadline. Clock skew beyond this margin can still produce a stale
   * candidate; the on-chain clock remains authoritative. Must be non-negative.
   */
  deadlineSafetySeconds?: bigint;
};

/**
 * Handle returned by {@link watchClaimableTasks}: an async-iterable of
 * {@link ClaimableTask}s AND an explicit {@link ClaimableTaskWatch.stop}.
 *
 * Consume it either way:
 * - `for await (const task of watch) { ... }` — the loop ends when `stop()` is
 *   called, the `signal` aborts, or every transport completes.
 * - register `onTask` and call `await watch.stop()` when done (the async
 *   iterator then completes too).
 *
 * Iteration has no replay buffer before it is attached: tasks emitted before
 * `[Symbol.asyncIterator]()` is called are delivered only to `onTask`. Once
 * attached, it drains the SAME de-duped stream, so subsequent tasks are
 * delivered to both consumers exactly once.
 */
export interface ClaimableTaskWatch extends AsyncIterable<ClaimableTask> {
  /**
   * Stop the watch: aborts every transport and ends the async iteration.
   * Idempotent. Resolves once the underlying subscriptions/sweeps have torn
   * down. In-flight `onTask` handlers receive an aborted signal, but teardown
   * does not wait indefinitely for a handler that ignores it.
   */
  stop(): Promise<void>;
}

/** Default catch-up/poll sweep interval (ms). */
const DEFAULT_POLL_INTERVAL_MS = 5000;

/** Default cap on concurrently eligible candidate de-dupe entries. */
const DEFAULT_MAX_SEEN = 10_000;

/** Default async-iterator backlog before producer backpressure. */
const DEFAULT_MAX_QUEUE = 1_000;

/** Default ceiling (ms) on the failed-sweep exponential backoff. */
const DEFAULT_MAX_BACKOFF_MS = 30_000;

/** Default timeout for an entire serialized task-state + job-spec read sequence. */
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;

/** Node/browser timers do not reliably represent delays above signed i32. */
const MAX_TIMER_MS = 2_147_483_647;

class WatchAbortedError extends Error {
  constructor() {
    super("watchClaimableTasks: watch stopped");
    this.name = "AbortError";
  }
}

class WatchOperationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `watchClaimableTasks: transport operation timed out after ${timeoutMs}ms`,
    );
    this.name = "TimeoutError";
  }
}

/**
 * Detach a producer from an operation whose transport ignores cancellation.
 * The operation keeps its own rejection handler, so a late rejection cannot
 * become unhandled after the watch has stopped.
 */
function raceWithAbort<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
  timeoutMs?: number,
): Promise<T> {
  const observed = Promise.resolve(operation);
  if (signal.aborted) {
    // `operation` may already be a queued mutex promise that rejects on its
    // abort check. Observe it even though the caller receives AbortError now.
    void observed.catch(() => {});
    return Promise.reject(new WatchAbortedError());
  }

  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (timer !== undefined) clearTimeout(timer);
      callback();
    };
    const onAbort = () => finish(() => reject(new WatchAbortedError()));

    signal.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs !== undefined) {
      timer = setTimeout(
        () => finish(() => reject(new WatchOperationTimeoutError(timeoutMs))),
        timeoutMs,
      );
    }
    observed.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

/**
 * Read the layout-preserving little-endian u64 carved into Task.reserved[3..11].
 * Zero means the task predates generation tracking or has never been claimed.
 */
function claimGeneration(task: Pick<Task, "reserved">): bigint {
  const bytes = task.reserved;
  let generation = 0n;
  for (let index = 10; index >= 3; index -= 1) {
    generation = (generation << 8n) | BigInt(bytes[index] ?? 0);
  }
  return generation;
}

/**
 * Encode the task's remembered claim state. `BoundedSeenSet` decides whether a
 * changed key is deliverable: nonzero generations normally advance silently
 * while a task stays candidate-eligible, and only prove a hidden reopen in the
 * Open+zero-workers shape. Generation zero uses the legacy counters.
 */
function dedupeKey(
  task: Address,
  currentWorkers: number,
  completions: number,
  generation: bigint,
): string {
  return generation === 0n
    ? `${task}:legacy:${currentWorkers}:${completions}`
    : `${task}:generation:${generation}`;
}

/**
 * A bounded set of active task/claim-state keys. Capacity is released only
 * after a complete successful sweep observes that a tracked task is absent.
 */
class BoundedSeenSet {
  readonly #keys = new Map<
    Address,
    { key: string; generation: bigint; lastObservedSweep: number }
  >();
  readonly #max: number;
  constructor(max: number) {
    this.#max = max;
  }
  /**
   * Admit a new task/claim state without evicting a still-eligible candidate.
   * Returning false at capacity is deliberate: a later successful sweep can
   * admit it after an inactive entry is removed, without eviction churn and
   * repeated delivery of the same oversized backlog.
   */
  addIfAbsent(
    task: Address,
    key: string,
    generation: bigint,
    isZeroWorkerOpen: boolean,
    observedSweep: number,
  ): boolean {
    const prior = this.#keys.get(task);
    // A delayed TaskCreated event (generation 0) or stale RPC snapshot must not
    // roll an authoritative monotonic marker backward and re-open dedupe.
    if (prior !== undefined && generation < prior.generation) {
      prior.lastObservedSweep = Math.max(
        prior.lastObservedSweep,
        observedSweep,
      );
      return false;
    }
    if (prior !== undefined && generation > 0n) {
      const provesHiddenReopen =
        isZeroWorkerOpen && generation > prior.generation;
      // Claims on collaborative/contest tasks increment generation while the
      // task remains continuously candidate-eligible. Record that monotonic progress,
      // but do not re-deliver a task this watcher already surfaced. The one
      // otherwise-indistinguishable close/reopen shape is Open+0 workers.
      this.#keys.set(task, {
        key,
        generation,
        lastObservedSweep: Math.max(prior.lastObservedSweep, observedSweep),
      });
      return provesHiddenReopen;
    }
    if (prior?.key === key) {
      prior.lastObservedSweep = Math.max(
        prior.lastObservedSweep,
        observedSweep,
      );
      return false;
    }
    if (prior === undefined && this.#keys.size >= this.#max) return false;
    this.#keys.set(task, { key, generation, lastObservedSweep: observedSweep });
    return true;
  }
  /** Forget tasks absent from a complete successful candidate sweep. */
  retainTasks(tasks: ReadonlySet<Address>, sweep: number): void {
    for (const [task, state] of this.#keys) {
      // An event may have been admitted concurrently with the snapshot read.
      // Its next-sweep marker protects it until a later complete sweep can
      // authoritatively show that it no longer matches the candidate predicate.
      if (!tasks.has(task) && state.lastObservedSweep < sweep) {
        this.#keys.delete(task);
      }
    }
  }
}

/** Apply local discovery filters to event/account-derived task facts. */
function matchesFilter(
  filter: ClaimableTaskFilter | undefined,
  facts: {
    creator: Address;
    requiredCapabilities: bigint;
    rewardAmount: bigint;
  },
): boolean {
  if (filter === undefined) return true;
  if (filter.creator !== undefined && facts.creator !== filter.creator) {
    return false;
  }
  if (
    filter.capabilities !== undefined &&
    (facts.requiredCapabilities & filter.capabilities) !==
      facts.requiredCapabilities
  ) {
    return false;
  }
  if (filter.minReward !== undefined && facts.rewardAmount < filter.minReward) {
    return false;
  }
  return true;
}

/**
 * Watch for NEW direct-claim candidates and invoke `onTask` for each one, with no
 * hand-tuned poll loop.
 *
 * Fuses the live {@link subscribeMarketplaceEvents} `TaskCreated` stream (when
 * `rpcSubscriptions` is given) with periodic
 * {@link listDirectClaimableTasks} catch-up sweeps (over `indexer` or `rpc`),
 * de-dupes by Task PDA + claim-state marker, applies the
 * {@link ClaimableTaskFilter} (capability superset, `minReward`, `creator`), and
 * delivers each newly discovered candidate exactly once. The returned
 * {@link ClaimableTaskWatch} is both async-iterable and stoppable.
 *
 * CANDIDATE-DISCOVERY PREDICATE — every direct-claim gate derivable from the current Task
 * account (Open/InProgress/manual-review PendingValidation status, remaining
 * `min(maxWorkers, 4)` capacity, unexpired deadline, non-BidExclusive type),
 * plus a pinned nonzero job-spec pointer. Worker identity/stake/reputation,
 * protocol launch controls, dependencies, hire designation, and current
 * moderation state require other accounts and remain authoritative at claim
 * time. A bare event stream cannot prove the account predicates and is rejected
 * without a catch-up read source. Deadline filtering uses local wall time plus
 * a conservative 30-second margin because this transport seam cannot read the
 * chain clock atomically; the transaction-time on-chain clock is authoritative.
 *
 * NEW-CANDIDATE SEMANTICS: the FIRST catch-up sweep surfaces the pre-existing
 * task-state-eligible+pinned backlog (the worker's starting discovery set);
 * thereafter only tasks not seen before are delivered. Delivery is de-duped
 * while a task remains continuously candidate-eligible; a complete absent sweep followed by a re-open
 * re-fires, while a steady-state task is delivered at most once. The active
 * de-dupe set is bounded (`maxSeen`) without live-entry eviction.
 *
 * @param options - Transports, filter, `onTask`/`onError` handlers, abort
 * signal, sweep interval, and commitment. A getProgramAccounts-capable `rpc`
 * or `indexer` is required.
 * @returns A {@link ClaimableTaskWatch} (async-iterable + `stop()`).
 *
 * @example
 * ```ts
 * import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
 * import { watchClaimableTasks } from "@tetsuo-ai/marketplace-sdk";
 *
 * const rpc = createSolanaRpc("https://your-rpc");
 * const rpcSubscriptions = createSolanaRpcSubscriptions("wss://your-rpc");
 *
 * const watch = watchClaimableTasks({
 *   rpcSubscriptions,
 *   rpc, // catch-up sweep + automatic polling fallback
 *   filter: { capabilities: 0b11n, minReward: 10_000_000n },
 *   onTask: async (task) => {
 *     console.log("claim candidate:", task.task, "reward", task.rewardAmount);
 *     // ...attempt the claim and handle transaction-time rejection...
 *   },
 *   onError: (err) => console.error("watch error", err),
 * });
 *
 * // ...later...
 * await watch.stop();
 * ```
 */
export function watchClaimableTasks(
  options: WatchClaimableTasksOptions,
): ClaimableTaskWatch {
  const {
    rpcSubscriptions,
    rpc,
    indexer,
    filter,
    onTask,
    onError,
    signal,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    commitment = "confirmed",
    maxSeen = DEFAULT_MAX_SEEN,
    maxQueue = DEFAULT_MAX_QUEUE,
    maxBackoffMs: configuredMaxBackoffMs,
    operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
    deadlineSafetySeconds,
  } = options;
  const maxBackoffMs =
    configuredMaxBackoffMs ?? Math.max(DEFAULT_MAX_BACKOFF_MS, pollIntervalMs);
  const effectiveDeadlineSafetySeconds =
    deadlineSafetySeconds ?? DEFAULT_DIRECT_CLAIM_DEADLINE_SAFETY_SECONDS;

  if (rpcSubscriptions == null && rpc === undefined && indexer === undefined) {
    throw new Error(
      "watchClaimableTasks: provide at least one transport — rpcSubscriptions " +
        "(live events), rpc (catch-up + polling fallback), or indexer (catch-up)",
    );
  }
  if (!Number.isSafeInteger(maxSeen) || maxSeen < 1) {
    throw new Error(
      `watchClaimableTasks: maxSeen must be a positive integer within the safe range (got ${maxSeen})`,
    );
  }
  if (!Number.isSafeInteger(maxQueue) || maxQueue < 1) {
    throw new Error(
      `watchClaimableTasks: maxQueue must be a positive safe integer (got ${maxQueue})`,
    );
  }
  if (
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 1 ||
    pollIntervalMs > MAX_TIMER_MS
  ) {
    throw new Error(
      `watchClaimableTasks: pollIntervalMs must be a positive safe timer interval (got ${pollIntervalMs})`,
    );
  }
  if (
    typeof effectiveDeadlineSafetySeconds !== "bigint" ||
    effectiveDeadlineSafetySeconds < 0n
  ) {
    throw new Error(
      `watchClaimableTasks: deadlineSafetySeconds must be a non-negative bigint (got ${String(deadlineSafetySeconds)})`,
    );
  }
  if (
    !Number.isSafeInteger(maxBackoffMs) ||
    maxBackoffMs < pollIntervalMs ||
    maxBackoffMs > MAX_TIMER_MS - pollIntervalMs
  ) {
    throw new Error(
      "watchClaimableTasks: maxBackoffMs must be a safe timer interval " +
        `between pollIntervalMs and ${MAX_TIMER_MS - pollIntervalMs} (got ${maxBackoffMs})`,
    );
  }
  if (
    !Number.isSafeInteger(operationTimeoutMs) ||
    operationTimeoutMs < 1 ||
    operationTimeoutMs > MAX_TIMER_MS
  ) {
    throw new Error(
      "watchClaimableTasks: operationTimeoutMs must be a positive safe timer " +
        `interval no greater than ${MAX_TIMER_MS} (got ${operationTimeoutMs})`,
    );
  }

  // The catch-up read source: prefer an explicit indexer, else the rpc (only
  // when it can serve getProgramAccounts).
  const catchUpSource: ProgramAccountsSource | undefined =
    indexer ??
    (rpc !== undefined &&
    typeof (rpc as Record<string, unknown>).getProgramAccounts === "function"
      ? (rpc as ProgramAccountsSource)
      : undefined);
  if (catchUpSource === undefined) {
    throw new Error(
      "watchClaimableTasks: a getProgramAccounts-capable rpc or indexer " +
        "is required to validate current task state and job-spec pins",
    );
  }

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (signal !== undefined) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onOuterAbort, { once: true });
  }

  // ProgramAccountsTransport does not promise reentrancy. Reserve every
  // watcher read sequence behind one per-watch tail, including event
  // revalidation and periodic catch-up. A queued operation checks abort before
  // touching the transport. The tail remains attached to a timed-out
  // non-cancellable request so no overlapping retry can start.
  let readTail: Promise<void> = Promise.resolve();
  const withReadLock = <T>(operation: () => Promise<T>): Promise<T> => {
    const predecessor = readTail;
    let release!: () => void;
    readTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return (async () => {
      try {
        await predecessor;
        if (controller.signal.aborted) throw new WatchAbortedError();
        return await operation();
      } finally {
        release();
      }
    })();
  };

  // De-dupe across both transports by Task PDA + remembered claim state,
  // bounded so a long-running watch cannot grow memory without limit. A task
  // stays at-most-once while continuously candidate-eligible; an observed absence or a
  // later generation in the Open+zero-workers shape permits re-delivery.
  const seen = new BoundedSeenSet(maxSeen);
  let successfulSweep = 0;

  // Async-iterable plumbing: a queue the generator drains, woken by each
  // producer. `failure` short-circuits the iterator with a transport error
  // when no onError handler swallows it.
  const queue: ClaimableTask[] = [];
  let iteratorAttached = false;
  let iteratorClaimed = false;
  let wake: (() => void) | null = null;
  const spaceWaiters = new Set<() => void>();
  let done = false;
  const failure: { current: { error: unknown } | null } = { current: null };

  const wakeLoop = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };

  const wakeSpaceWaiters = () => {
    for (const resolve of spaceWaiters) resolve();
    spaceWaiters.clear();
  };

  // Iterator enqueue + onTask invocation are one serialized delivery unit.
  // This preserves dual-consumer consistency and gives each unit one fresh
  // deadline check after any prior handler or iterator backpressure wait.
  // Abort still detaches teardown from a handler that ignores its signal.
  let deliveryChain: Promise<void> = Promise.resolve();

  const reportError = (error: unknown): void => {
    if (onError !== undefined) {
      // A throwing user handler must NOT crash the watch (it would reject a
      // producer pump and, in the fire-and-forget pattern, surface as an
      // unhandled rejection). Swallow sync throws and async rejections — there
      // is nowhere else to route a handler that itself fails.
      try {
        void Promise.resolve(onError(error)).catch(() => {});
      } catch {
        // ignore: the error handler is the last line; do not re-raise.
      }
      return;
    }
    // No handler: surface through the iterator and stop everything.
    failure.current ??= { error };
    controller.abort();
    wakeLoop();
    wakeSpaceWaiters();
  };

  const handlePumpError = (error: unknown): void => {
    if (controller.signal.aborted) return;
    reportError(error);
    if (error instanceof WatchOperationTimeoutError) {
      // A transport that ignored cancellation may still be executing. Abort
      // permanently rather than violate its non-reentrancy contract with a
      // retry. Do not await the underlying promise during teardown.
      controller.abort();
      wakeLoop();
      wakeSpaceWaiters();
    }
  };

  const deliver = async (task: ClaimableTask): Promise<void> => {
    deliveryChain = deliveryChain.then(async () => {
      if (controller.signal.aborted) return;

      // Callback-only consumers allocate no iterator backlog. Once iteration
      // is attached, wait for bounded capacity before the final freshness
      // check so an item cannot expire while blocked on queue space.
      if (iteratorAttached) {
        while (queue.length >= maxQueue && !controller.signal.aborted) {
          await new Promise<void>((resolve) => spaceWaiters.add(resolve));
        }
        if (controller.signal.aborted) return;
      }

      const account = task.account;
      if (
        account === undefined ||
        !isTaskStateDirectlyClaimable(
          account,
          BigInt(Math.floor(Date.now() / 1000)) +
            effectiveDeadlineSafetySeconds,
        )
      ) {
        return;
      }

      // Enqueue and invoke the callback in the same serialized unit, after the
      // same freshness decision, so neither consumer sees a task the other
      // skipped as stale.
      if (iteratorAttached) {
        queue.push(task);
        wakeLoop();
      }
      try {
        await onTask(task, controller.signal);
      } catch (error) {
        reportError(error);
      }
    });
    await raceWithAbort(deliveryChain, controller.signal);
  };

  const admit = (
    task: ClaimableTask,
    marker: {
      currentWorkers: number;
      completions: number;
      claimGeneration: bigint;
      isZeroWorkerOpen: boolean;
    },
    observedSweep: number,
  ): boolean => {
    const key = dedupeKey(
      task.task,
      marker.currentWorkers,
      marker.completions,
      marker.claimGeneration,
    );
    return seen.addIfAbsent(
      task.task,
      key,
      marker.claimGeneration,
      marker.isZeroWorkerOpen,
      observedSweep,
    );
  };

  // EVENT PATH: TaskCreated is a wake-up hint, not authoritative task state.
  // Re-read and decode the current account through the same direct-claim query
  // used by catch-up, then confirm the separately-pinned job spec. This closes
  // the delayed-event race where a task filled before its event was consumed.
  const eventPump = (async () => {
    if (rpcSubscriptions == null && rpc === undefined) return; // no event source
    // Confirming the job-spec pin requires a gPA read source. If none exists,
    // the event path cannot prove a task is claimable, so it stays silent.
    if (catchUpSource === undefined) return;
    // subscribeMarketplaceEvents accepts a null subscriptions client when an
    // rpc polling handle is provided (it falls back to log polling).
    if (
      rpcSubscriptions == null &&
      !(
        rpc !== undefined &&
        typeof (rpc as Record<string, unknown>).getSignaturesForAddress ===
          "function"
      )
    ) {
      return; // rpc cannot serve the polling fallback (bare gPA transport)
    }
    const events = subscribeMarketplaceEvents(rpcSubscriptions, {
      events: ["TaskCreated"],
      abortSignal: controller.signal,
      commitment,
      rpc:
        rpc !== undefined &&
        typeof (rpc as Record<string, unknown>).getSignaturesForAddress ===
          "function"
          ? (rpc as MarketplaceEventsPollingRpc)
          : undefined,
    });
    const eventIterator = events[Symbol.asyncIterator]();
    try {
      for (;;) {
        // Some structural transports ignore abortSignal while an iterator
        // `next()` is pending. Race the read so stop() can still tear down.
        const next = await raceWithAbort(
          eventIterator.next(),
          controller.signal,
        );
        if (next.done) break;
        const event = next.value;
        if (event.eventName !== "TaskCreated") continue;
        const data = event.data;
        const creator = data.creator;
        const requiredCapabilities = data.requiredCapabilities;
        const rewardAmount = data.rewardAmount;
        if (
          !matchesFilter(filter, {
            creator,
            requiredCapabilities,
            rewardAmount,
          })
        ) {
          continue;
        }
        const taskId = new Uint8Array(data.taskId);
        const [task] = await findTaskPda({ creator, taskId });
        const current = await raceWithAbort(
          withReadLock(async () => {
            const candidate = (
              await listDirectClaimableTasks(catchUpSource, {
                capabilities: filter?.capabilities,
                minReward: filter?.minReward,
                creator: filter?.creator ?? creator,
                deadlineSafetySeconds: effectiveDeadlineSafetySeconds,
              })
            ).find(({ address }) => address === task);
            if (candidate === undefined) return undefined;
            return (await isTaskJobSpecPinned(catchUpSource, task))
              ? candidate
              : undefined;
          }),
          controller.signal,
          operationTimeoutMs,
        );
        if (current === undefined) continue;
        if (controller.signal.aborted) return;
        const account = current.account;
        // Reads may be slow even when they finish inside the timeout. Re-check
        // the strict deadline immediately before admission; local wall time +
        // the configured safety margin is conservative relative to Clock.
        if (
          !isTaskStateDirectlyClaimable(
            account,
            BigInt(Math.floor(Date.now() / 1000)) +
              effectiveDeadlineSafetySeconds,
          )
        ) {
          continue;
        }
        const claimable: ClaimableTask = {
          task,
          creator: account.creator,
          taskId: new Uint8Array(account.taskId),
          requiredCapabilities: account.requiredCapabilities,
          rewardAmount: account.rewardAmount,
          rewardMint: isSome(account.rewardMint)
            ? unwrapOption(account.rewardMint)
            : null,
          source: "event",
          account,
        };
        if (
          admit(
            claimable,
            {
              currentWorkers: account.currentWorkers,
              completions: account.completions,
              claimGeneration: claimGeneration(account),
              isZeroWorkerOpen:
                account.status === TaskStatus.Open &&
                account.currentWorkers === 0,
            },
            successfulSweep + 1,
          )
        ) {
          await deliver(claimable);
        }
      }
    } catch (error) {
      handlePumpError(error);
    } finally {
      // Request cooperative iterator cleanup, but never make stop() depend on
      // a third-party iterator implementing return() correctly.
      if (eventIterator.return !== undefined) {
        void Promise.resolve(eventIterator.return()).catch((error: unknown) => {
          if (!controller.signal.aborted) reportError(error);
        });
      }
    }
  })();

  // CATCH-UP / POLL PATH: periodic direct-claim-candidate sweeps over the read source.
  // A persistently-failing sweep backs off exponentially (capped) rather than
  // hammering the RPC every `pollIntervalMs`; the backoff resets after a
  // successful sweep.
  const catchUpPump = (async () => {
    if (catchUpSource === undefined) return;
    // Backoff added ON TOP OF pollIntervalMs after consecutive failures.
    let failBackoffMs = 0;
    while (!controller.signal.aborted) {
      let sweptOk = false;
      try {
        // Mirror every task-local direct-claim gate, then intersect with pinned
        // job specs so no Open-but-unpinned task is surfaced.
        const [candidates, pinned] = await raceWithAbort(
          withReadLock(async () => {
            const taskStateCandidates = await listDirectClaimableTasks(
              catchUpSource,
              {
                capabilities: filter?.capabilities,
                minReward: filter?.minReward,
                creator: filter?.creator,
                deadlineSafetySeconds: effectiveDeadlineSafetySeconds,
              },
            );
            // Keep this second read in the same serialized, aggregate-timeout
            // operation. ProgramAccountsTransport has no reentrancy guarantee.
            const pinnedTasks = await listPinnedJobSpecTasks(catchUpSource);
            return [taskStateCandidates, pinnedTasks] as const;
          }),
          controller.signal,
          operationTimeoutMs,
        );
        sweptOk = true;
        successfulSweep += 1;
        const candidateAddresses = new Set<Address>();
        const deliveries: Array<{
          claimable: ClaimableTask;
          marker: {
            currentWorkers: number;
            completions: number;
            claimGeneration: bigint;
            isZeroWorkerOpen: boolean;
          };
        }> = [];
        for (const { address, account } of candidates) {
          if (controller.signal.aborted) return;
          // Retain every task-state candidate, even if the following serialized
          // indexer/RPC job-spec snapshot temporarily lags. A transient
          // cross-account pin omission must not retire a previously-delivered
          // task and duplicate it when the pin reappears next sweep.
          candidateAddresses.add(address);
          if (!pinned.has(address)) continue;
          const claimable: ClaimableTask = {
            task: address,
            creator: account.creator,
            taskId: new Uint8Array(account.taskId),
            requiredCapabilities: account.requiredCapabilities,
            rewardAmount: account.rewardAmount,
            rewardMint: isSome(account.rewardMint)
              ? unwrapOption(account.rewardMint)
              : null,
            source: "catch-up",
            account,
          };
          deliveries.push({
            claimable,
            // Nonzero generations advance silently unless a later one is
            // observed at Open+zero workers (the hidden sole-slot reopen
            // shape). Generation-zero tasks retain legacy counter behavior.
            marker: {
              currentWorkers: account.currentWorkers,
              completions: account.completions,
              claimGeneration: claimGeneration(account),
              isZeroWorkerOpen:
                account.status === TaskStatus.Open &&
                account.currentWorkers === 0,
            },
          });
        }
        // Release capacity only from a complete successful snapshot. Never
        // evict active entries within a sweep: that caused oversized backlogs
        // to be delivered again on every poll.
        seen.retainTasks(candidateAddresses, successfulSweep);
        for (const { claimable, marker } of deliveries) {
          if (controller.signal.aborted) return;
          const account = claimable.account;
          if (
            account === undefined ||
            !isTaskStateDirectlyClaimable(
              account,
              BigInt(Math.floor(Date.now() / 1000)) +
                effectiveDeadlineSafetySeconds,
            )
          ) {
            continue;
          }
          if (admit(claimable, marker, successfulSweep)) {
            await deliver(claimable);
          }
        }
      } catch (error) {
        handlePumpError(error);
      }
      // A clean sweep clears the failure backoff; a failure grows it (capped).
      if (sweptOk) {
        failBackoffMs = 0;
      } else {
        failBackoffMs =
          failBackoffMs === 0
            ? pollIntervalMs
            : Math.min(failBackoffMs * 2, maxBackoffMs);
      }
      // Sleep between sweeps (pollIntervalMs + any failure backoff), resolving
      // early on abort.
      const sleepMs = pollIntervalMs + failBackoffMs;
      await new Promise<void>((resolve) => {
        if (controller.signal.aborted) return resolve();
        const onSweepAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          controller.signal.removeEventListener("abort", onSweepAbort);
          resolve();
        }, sleepMs);
        controller.signal.addEventListener("abort", onSweepAbort, {
          once: true,
        });
      });
    }
  })();

  const producers = Promise.all([eventPump, catchUpPump]).then(
    () => {
      done = true;
      wakeLoop();
    },
    // Defence in depth: the pumps already funnel errors through reportError, so
    // this rejection branch should be unreachable — but a never-awaited
    // `producers` (the fire-and-forget onTask-only pattern) must never surface
    // as an unhandled rejection, so swallow anything that slips through and end
    // the watch cleanly.
    (error) => {
      reportError(error);
      done = true;
      wakeLoop();
    },
  );

  async function* iterate(): AsyncGenerator<ClaimableTask, void, void> {
    try {
      for (;;) {
        // onTask delivery happens in emit(); the iterator just yields.
        while (queue.length > 0) {
          const task = queue.shift()!;
          wakeSpaceWaiters();
          yield task;
        }
        if (failure.current !== null) {
          const error = failure.current.error;
          failure.current = null;
          throw error;
        }
        if (done || controller.signal.aborted) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      controller.abort();
      wakeSpaceWaiters();
      if (signal !== undefined)
        signal.removeEventListener("abort", onOuterAbort);
      await producers;
    }
  }

  const generator = iterate();

  const watch: ClaimableTaskWatch = {
    [Symbol.asyncIterator]: () => {
      if (iteratorClaimed) {
        throw new Error(
          "watchClaimableTasks: the async iterator can only be consumed once",
        );
      }
      iteratorClaimed = true;
      iteratorAttached = true;
      return generator;
    },
    async stop() {
      controller.abort();
      wakeLoop();
      wakeSpaceWaiters();
      await producers;
      // Ensure the generator's finally-block runs even if no one iterated.
      await generator.return();
      if (signal !== undefined)
        signal.removeEventListener("abort", onOuterAbort);
    },
  };
  return watch;
}
