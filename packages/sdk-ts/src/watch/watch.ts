// Worker-notification convenience: watch for NEW claimable tasks without a
// bespoke poll loop.
//
// `watchClaimableTasks` fuses two read paths the SDK already exposes:
//
//   1. LIVE EVENTS — `subscribeMarketplaceEvents` (the events module). Each
//      `TaskCreated` event is a freshly-minted Open task — but Open is NOT
//      sufficient for a claim to land. `claim_task_with_job_spec` (the only
//      working claim instruction) requires the `["task_job_spec", task]` PDA to
//      already exist with a non-zero hash, and that pointer is set by a
//      SEPARATE, later `set_task_job_spec` tx. So a `TaskCreated` event alone
//      does NOT mean the task is claimable; the event path confirms the
//      job-spec pin (via the catch-up read source) before surfacing.
//   2. CATCH-UP / FALLBACK — `listOpenTasks` (the queries read path) over a
//      `ProgramAccountsSource` (a kit `Rpc`, a `ProgramAccountsTransport`, or
//      the hosted indexer's transport). One initial sweep catches tasks that
//      were created before the watch started, and (when no `rpcSubscriptions`
//      is available) periodic sweeps act as the polling fallback. Each sweep
//      intersects the Open tasks with the set of pinned job specs so only
//      genuinely-claimable tasks are surfaced.
//
// CLAIMABLE PREDICATE: "Open AND job-spec pinned", mirroring the on-chain
// `claim_task_with_job_spec` gate exactly (the `["task_job_spec", task]` PDA
// exists with a non-zero `job_spec_hash`). A worker bot wired to claim inside
// `onTask` therefore never builds a doomed claim against an Open-but-unpinned
// task. Confirming the pin requires a read source, so an event-only watch (a
// bare `rpcSubscriptions` with no `rpc`/`indexer` catch-up source) CANNOT
// confirm the pin and will not surface event-path tasks — provide an `rpc` or
// `indexer` so the pin can be checked.
//
// Both paths feed one de-duped, filtered stream. A task is surfaced AT MOST
// once per re-open generation (keyed by Task PDA + its claim-state marker), so
// a genuinely re-opened task (PendingValidation → Open) re-fires while a
// steady-state task is not re-delivered. The dedupe set is bounded (LRU) so a
// long-running bot does not grow memory without limit.
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
  isTaskJobSpecPinned,
  listOpenTasks,
  listPinnedJobSpecTasks,
  type DecodedProgramAccount,
  type ProgramAccountsSource,
} from "../queries/index.js";

/**
 * The claimable-task filter — the worker's eligibility criteria. Every field
 * is optional; an omitted field imposes no constraint. The same predicate is
 * applied to BOTH the event path and the catch-up/poll path, so the two
 * transports surface an identical set.
 */
export type ClaimableTaskFilter = {
  /**
   * The worker's capability bitmask. Keeps only tasks the worker can satisfy,
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
 * A newly-claimable task surfaced to {@link WatchClaimableTasksOptions.onTask}.
 *
 * The fields common to both transports (`task`, `creator`, `taskId`,
 * `requiredCapabilities`, `rewardAmount`, `rewardMint`) are always present.
 * `account` carries the fully-decoded on-chain {@link Task} and is only
 * populated on the CATCH-UP path (the event path derives everything it needs
 * from the `TaskCreated` payload without an extra account read).
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
   * The fully-decoded on-chain {@link Task} account. Populated only on the
   * `"catch-up"` path (`source === "catch-up"`); `undefined` on the
   * `"event"` path.
   */
  account?: Task;
};

/**
 * Options for {@link watchClaimableTasks}.
 *
 * TRANSPORTS — provide at least one read path:
 * - `rpcSubscriptions` arms the LIVE WebSocket event path (recommended:
 *   sub-second notification of new tasks).
 * - `rpc` serves the initial catch-up sweep AND the polling fallback: it is
 *   the `getProgramAccounts` source for {@link listOpenTasks} and, when
 *   `rpcSubscriptions` is absent/unavailable, the
 *   `subscribeMarketplaceEventsViaPolling` log-scan source. A kit `Rpc`
 *   satisfies both; a bare `ProgramAccountsTransport` serves only the gPA
 *   catch-up.
 * - `indexer` is an explicit catch-up/poll read source (e.g. the hosted
 *   indexer's `ProgramAccountsTransport`) used INSTEAD OF `rpc` for the
 *   `listOpenTasks` sweep when you want the scale read path; it does not carry
 *   the WebSocket event path. When both `rpc` and `indexer` are given,
 *   `indexer` is used for catch-up and `rpc` (if a polling RPC) still arms the
 *   event-polling fallback.
 *
 * At least one of `rpcSubscriptions` / `rpc` / `indexer` MUST be provided.
 *
 * CLAIMABILITY READ SOURCE: surfacing a task as claimable requires confirming
 * its job spec is pinned (the on-chain claim precondition), which needs a
 * `getProgramAccounts` read source. So a catch-up source (`rpc` that serves
 * gPA, or `indexer`) is REQUIRED to surface ANY task — including event-path
 * tasks, whose pin is confirmed against the same read source. A bare
 * `rpcSubscriptions` with no catch-up source arms the live event stream but
 * cannot confirm pins, so it surfaces nothing.
 */
export type WatchClaimableTasksOptions = {
  /** Live event source (kit `RpcSubscriptions` or a structural double). */
  rpcSubscriptions?: MarketplaceEventsRpcSubscriptions | null;
  /**
   * Catch-up/poll read source. A kit `Rpc` doubles as the polling-fallback log
   * scanner and the {@link listOpenTasks} gPA source; a bare
   * {@link ProgramAccountsTransport} serves only the gPA catch-up.
   */
  rpc?: (MarketplaceEventsPollingRpc & ProgramAccountsSource) | ProgramAccountsSource;
  /**
   * Alternate catch-up read source for the {@link listOpenTasks} sweep (e.g.
   * the hosted indexer transport). Used in preference to `rpc` for catch-up.
   */
  indexer?: ProgramAccountsSource;
  /** The worker's eligibility filter. Omit to surface every Open task. */
  filter?: ClaimableTaskFilter;
  /** Invoked once per newly-claimable task. May be async; rejections route to `onError`. */
  onTask: (task: ClaimableTask) => void | Promise<void>;
  /**
   * Invoked for any transport/handler error. If omitted, a transport error
   * stops the watch (it rejects the async iterator / settles `stop()`); an
   * `onTask` handler rejection is swallowed.
   */
  onError?: (error: unknown) => void;
  /** Abort to stop the watch (equivalent to calling {@link ClaimableTaskWatch.stop}). */
  signal?: AbortSignal;
  /**
   * Catch-up/poll sweep interval in milliseconds (default `5000`). The first
   * sweep runs immediately; subsequent sweeps run every `pollIntervalMs`. When
   * only event transports are configured and no catch-up source is given, no
   * sweep runs.
   */
  pollIntervalMs?: number;
  /** Commitment for the underlying reads (default `"confirmed"`). */
  commitment?: Commitment;
  /**
   * Max distinct `(task, claim-state)` entries the de-dupe set retains before
   * evicting the oldest (FIFO/LRU), default `10_000`. Bounds memory on a
   * long-running bot. Eviction can only re-deliver a task that re-surfaces
   * AFTER being evicted (a tradeoff the cap exists to make); set higher to
   * reduce that chance, or lower to cap memory tighter. Must be a positive
   * integer.
   */
  maxSeen?: number;
  /**
   * Cap (ms) on the exponential backoff applied between CONSECUTIVE FAILED
   * catch-up sweeps (default `30_000`), independent of `pollIntervalMs`. A
   * persistently-failing RPC backs off 2×, 4×, … up to this cap instead of
   * retrying tightly every `pollIntervalMs`; the backoff resets to zero after
   * any successful sweep. Set to `pollIntervalMs` to disable extra backoff.
   */
  maxBackoffMs?: number;
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
 * The two are consistent: iterating drains the SAME de-duped stream `onTask`
 * receives, so a task is delivered to BOTH the iterator and `onTask` exactly
 * once.
 */
export interface ClaimableTaskWatch extends AsyncIterable<ClaimableTask> {
  /**
   * Stop the watch: aborts every transport and ends the async iteration.
   * Idempotent. Resolves once the underlying subscriptions/sweeps have torn
   * down.
   */
  stop(): Promise<void>;
}

/** Default catch-up/poll sweep interval (ms). */
const DEFAULT_POLL_INTERVAL_MS = 5000;

/** Default cap on distinct de-dupe entries before FIFO eviction. */
const DEFAULT_MAX_SEEN = 10_000;

/** Default ceiling (ms) on the failed-sweep exponential backoff. */
const DEFAULT_MAX_BACKOFF_MS = 30_000;

/**
 * The de-dupe key for a surfaced task: its PDA plus a claim-state marker, so a
 * genuine re-open (PendingValidation → Open, which resets the claim state)
 * produces a DIFFERENT key and re-fires, while a steady-state re-observation of
 * the same task is suppressed.
 *
 * The marker is `currentWorkers:completions` — both change across a
 * claim/re-open cycle (a fresh task is `0:0`; a claimed-then-reopened task is
 * not). The event path has no decoded account, but a `TaskCreated` event is by
 * construction a fresh task (`currentWorkers == 0`, `completions == 0`), so it
 * uses the `0:0` marker — matching the catch-up key for the same fresh task,
 * which keeps cross-path de-dupe exact.
 */
function dedupeKey(task: Address, currentWorkers: number, completions: number): string {
  return `${task}:${currentWorkers}:${completions}`;
}

/**
 * A bounded insertion-ordered set of string keys. When it exceeds `max`, the
 * oldest-inserted key is evicted (FIFO) so memory stays bounded on a
 * long-running watch. `Map` preserves insertion order, so the first key from
 * its iterator is the oldest.
 */
class BoundedSeenSet {
  readonly #keys = new Map<string, true>();
  readonly #max: number;
  constructor(max: number) {
    this.#max = max;
  }
  /** Returns true if `key` was already present; otherwise records it (evicting the oldest if over cap) and returns false. */
  addIfAbsent(key: string): boolean {
    if (this.#keys.has(key)) return true;
    this.#keys.set(key, true);
    if (this.#keys.size > this.#max) {
      const oldest = this.#keys.keys().next().value;
      if (oldest !== undefined) this.#keys.delete(oldest);
    }
    return false;
  }
}

/** Apply the claimable filter to event/account-derived task facts. */
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
  if (
    filter.minReward !== undefined &&
    facts.rewardAmount < filter.minReward
  ) {
    return false;
  }
  return true;
}

/**
 * Watch for NEW claimable tasks and invoke `onTask` for each one, with no
 * hand-tuned poll loop.
 *
 * Fuses the live {@link subscribeMarketplaceEvents} `TaskCreated` stream (when
 * `rpcSubscriptions` is given) with periodic {@link listOpenTasks} catch-up
 * sweeps (over `indexer` or `rpc`), de-dupes by Task PDA + claim-state marker,
 * applies the {@link ClaimableTaskFilter} (capability superset, `minReward`,
 * `creator`), and delivers each newly-claimable task exactly once. The returned
 * {@link ClaimableTaskWatch} is both async-iterable and stoppable.
 *
 * CLAIMABLE PREDICATE — "Open AND job-spec pinned". A task being `Open` is NOT
 * sufficient for a claim to land: the only working claim instruction
 * (`claim_task_with_job_spec`) requires the `["task_job_spec", task]` PDA to
 * exist with a non-zero hash, and that pointer is set by a SEPARATE, later
 * `set_task_job_spec` tx. Both paths therefore confirm the pin before
 * surfacing: the catch-up sweep intersects Open tasks with the pinned-job-spec
 * set; the event path re-checks the single task's job-spec PDA. So a worker bot
 * that claims inside `onTask` never builds a doomed claim. (Confirming the pin
 * needs a `getProgramAccounts` read source — see the options doc; an event-only
 * watch with no catch-up source surfaces nothing.)
 *
 * NEWLY-CLAIMABLE SEMANTICS: the FIRST catch-up sweep surfaces the pre-existing
 * Open+pinned backlog (the worker's starting work set); thereafter only tasks
 * not seen before are delivered. Delivery is de-duped per re-open generation:
 * a genuine re-open (PendingValidation → Open) carries a different claim-state
 * marker and re-fires, while a steady-state task is delivered at most once. The
 * de-dupe set is bounded (`maxSeen`, FIFO eviction) to bound memory.
 *
 * @param options - Transports, filter, `onTask`/`onError` handlers, abort
 * signal, sweep interval, and commitment. At least one of `rpcSubscriptions` /
 * `rpc` / `indexer` is required.
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
 *     console.log("claimable:", task.task, "reward", task.rewardAmount);
 *     // ...claim it...
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
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  } = options;

  if (rpcSubscriptions == null && rpc === undefined && indexer === undefined) {
    throw new Error(
      "watchClaimableTasks: provide at least one transport — rpcSubscriptions " +
        "(live events), rpc (catch-up + polling fallback), or indexer (catch-up)",
    );
  }
  if (!Number.isInteger(maxSeen) || maxSeen < 1) {
    throw new Error(
      `watchClaimableTasks: maxSeen must be a positive integer (got ${maxSeen})`,
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

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (signal !== undefined) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onOuterAbort, { once: true });
  }

  // De-dupe across both transports by Task PDA + claim-state marker, bounded so
  // a long-running watch cannot grow memory without limit. Keying on the
  // claim-state marker lets a genuine re-open (PendingValidation → Open)
  // re-fire while a steady-state task is not re-delivered.
  const seen = new BoundedSeenSet(maxSeen);

  // Async-iterable plumbing: a queue the generator drains, woken by each
  // producer. `failure` short-circuits the iterator with a transport error
  // when no onError handler swallows it.
  const queue: ClaimableTask[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const failure: { current: { error: unknown } | null } = { current: null };

  const wakeLoop = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };

  // onTask is delivered INDEPENDENTLY of iteration (a worker bot can just
  // register onTask and never iterate), serialized through this chain so
  // handlers run one at a time in arrival order without blocking producers.
  let onTaskChain: Promise<void> = Promise.resolve();

  const reportError = (error: unknown): void => {
    if (onError !== undefined) {
      // A throwing user handler must NOT crash the watch (it would reject a
      // producer pump and, in the fire-and-forget pattern, surface as an
      // unhandled rejection). Swallow its throw — there is nowhere else to
      // route a handler that itself fails.
      try {
        onError(error);
      } catch {
        // ignore: the error handler is the last line; do not re-raise.
      }
      return;
    }
    // No handler: surface through the iterator and stop everything.
    failure.current ??= { error };
    controller.abort();
    wakeLoop();
  };

  const emit = (
    task: ClaimableTask,
    marker: { currentWorkers: number; completions: number },
  ): void => {
    const key = dedupeKey(task.task, marker.currentWorkers, marker.completions);
    if (seen.addIfAbsent(key)) return;
    // Feed the async-iterable consumer.
    queue.push(task);
    wakeLoop();
    // Feed the onTask callback consumer (serialized; errors route to onError).
    onTaskChain = onTaskChain.then(async () => {
      try {
        await onTask(task);
      } catch (error) {
        reportError(error);
      }
    });
  };

  // EVENT PATH: only TaskCreated. A `TaskCreated` event is an Open task at
  // emission, but Open is NOT claimable on its own — the job spec is pinned by
  // a SEPARATE, later tx. So before surfacing, re-check the task's job-spec PDA
  // (via the catch-up read source) and only emit once it is pinned. Without a
  // catch-up source the pin cannot be confirmed, so the event path surfaces
  // nothing (see the options doc).
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
    try {
      for await (const event of subscribeMarketplaceEvents(rpcSubscriptions, {
        events: ["TaskCreated"],
        abortSignal: controller.signal,
        commitment,
        rpc:
          rpc !== undefined &&
          typeof (rpc as Record<string, unknown>).getSignaturesForAddress ===
            "function"
            ? (rpc as MarketplaceEventsPollingRpc)
            : undefined,
      })) {
        if (event.eventName !== "TaskCreated") continue;
        const data = event.data;
        const creator = data.creator;
        const requiredCapabilities = data.requiredCapabilities;
        const rewardAmount = data.rewardAmount;
        if (!matchesFilter(filter, { creator, requiredCapabilities, rewardAmount })) {
          continue;
        }
        const taskId = new Uint8Array(data.taskId);
        const [task] = await findTaskPda({ creator, taskId });
        // Mirror the on-chain claim gate: only surface once the job spec is
        // pinned (the `["task_job_spec", task]` PDA exists with a non-zero
        // hash). A freshly-created task is typically not yet pinned; the
        // catch-up sweep surfaces it once `set_task_job_spec` lands.
        if (!(await isTaskJobSpecPinned(catchUpSource, task))) continue;
        if (controller.signal.aborted) return;
        emit(
          {
            task,
            creator,
            taskId,
            requiredCapabilities,
            rewardAmount,
            rewardMint: isSome(data.rewardMint)
              ? unwrapOption(data.rewardMint)
              : null,
            source: "event",
          },
          // A TaskCreated event is by construction a fresh task: 0 workers, 0
          // completions. This matches the catch-up key for the same fresh task.
          { currentWorkers: 0, completions: 0 },
        );
      }
    } catch (error) {
      if (!controller.signal.aborted) reportError(error);
    }
  })();

  // CATCH-UP / POLL PATH: periodic listOpenTasks sweeps over the read source.
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
        // Mirror the on-chain claim gate: a task is claimable only if it is
        // Open AND its job spec is pinned. Fetch both, then intersect, so an
        // Open-but-unpinned task is never surfaced as a doomed claim.
        const [open, pinned]: [
          Array<DecodedProgramAccount<Task>>,
          Set<Address>,
        ] = await Promise.all([
          listOpenTasks(catchUpSource, {
            capabilities: filter?.capabilities,
            minReward: filter?.minReward,
            creator: filter?.creator,
          }),
          listPinnedJobSpecTasks(catchUpSource),
        ]);
        sweptOk = true;
        for (const { address, account } of open) {
          if (controller.signal.aborted) return;
          if (account.status !== TaskStatus.Open) continue; // defensive
          if (!pinned.has(address)) continue; // Open but job spec not pinned → not claimable
          emit(
            {
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
            },
            // Claim-state marker: a re-open (PendingValidation → Open) changes
            // these, producing a fresh de-dupe key so the re-opened slot
            // re-fires.
            {
              currentWorkers: account.currentWorkers,
              completions: account.completions,
            },
          );
        }
      } catch (error) {
        if (!controller.signal.aborted) reportError(error);
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
        while (queue.length > 0) yield queue.shift()!;
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
      if (signal !== undefined) signal.removeEventListener("abort", onOuterAbort);
      await producers;
    }
  }

  const generator = iterate();

  const watch: ClaimableTaskWatch = {
    [Symbol.asyncIterator]: () => generator,
    async stop() {
      controller.abort();
      wakeLoop();
      await producers;
      // Drain any in-flight onTask deliveries.
      await onTaskChain;
      // Ensure the generator's finally-block runs even if no one iterated.
      await generator.return();
    },
  };
  return watch;
}
