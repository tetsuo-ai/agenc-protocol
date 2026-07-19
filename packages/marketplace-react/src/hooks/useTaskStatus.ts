/**
 * `useTaskStatus(taskPda)` — live task status with a poll fallback.
 *
 * Tracks a Task account's {@link TaskStatus} (and optionally its submission and
 * the coordination events seen for it) after a hire. It is built to satisfy the
 * PLAN_2 A2 contract `{ task, status, submission, events }` while staying SSR-
 * and transport-agnostic.
 *
 * ## How it reads (the seam)
 *
 * The unified read transport intentionally has NO raw account fetch, and the
 * litesvm e2e harness has no RPC — so a task read cannot be assumed from
 * context. `useTaskStatus` therefore takes a **`taskReader`**: an async
 * `(pda) => Promise<Task | null>`. Callers wire it from whatever they have:
 * - a kit RPC: `(pda) => getTaskDecoder().decode(...)` over `getAccountInfo`
 *   (the SDK's `waitForTaskStatus` uses exactly this `getAccountInfo` shape);
 * - litesvm e2e: `(pda) => decode(svm.getAccount(pda))`.
 * A reader-less call returns the idle state (and a clear `error` if `poll` was
 * requested) rather than guessing a transport.
 *
 * ## Polling vs. subscription (SSR-safe, cleaned up)
 *
 * - Polling: TanStack Query `refetchInterval` re-runs `taskReader` until the
 *   task reaches a terminal status (`Completed`/`Cancelled`/`RejectFrozen`) or
 *   the optional `targetStatus` — then stops.
 * - Subscription: `events` prefers an abort-aware source factory, while still
 *   accepting the original `AsyncIterable` API for compatibility. A browser-
 *   only effect owns its `AbortController`, drains the iterable, retains a
 *   bounded tail, and triggers a refetch. Cleanup races blocked legacy
 *   `next()` calls against abort and requests iterator return; factories can
 *   additionally release their transport cooperatively through the signal.
 *
 * @module hooks/useTaskStatus
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { TaskStatus, type Task } from "@tetsuo-ai/marketplace-sdk";
import { useAgencContext } from "../provider/context.js";
import type { Address } from "../types.js";
import { pdaKey, queryKeys } from "./internal.js";

/** Reads a Task account, returning the decoded {@link Task} or null if absent. */
export type TaskReader = (pda: Address | string) => Promise<Task | null>;

/**
 * A single coordination event observed for the watched task. Kept loosely typed
 * (the SDK's `AgencEvent` union) so this hook does not pin the event schema.
 */
export type ObservedEvent = unknown;

/**
 * Original coordination-event stream API.
 *
 * @deprecated Prefer {@link TaskEventsSourceFactory}. A pre-created iterable
 * cannot pass this hook's abort signal into its subscription transport. Legacy
 * streams remain cancellation-safe at the iterator boundary through an abort
 * race and best-effort `iterator.return()` cleanup.
 */
export type TaskEventsSource = AsyncIterable<ObservedEvent>;

/**
 * Abort-aware coordination-event factory. Implementations should pass the
 * signal to their subscription transport. The task identity lets a factory
 * construct an address-filtered stream. This form is preferred over the
 * deprecated pre-created {@link TaskEventsSource}.
 */
export type TaskEventsSourceFactory = (options: {
  signal: AbortSignal;
  taskPda: Address | string;
}) => AsyncIterable<ObservedEvent>;

/** Options for {@link useTaskStatus}. */
export interface UseTaskStatusOptions {
  /**
   * How to read the Task account. REQUIRED for any live status — without it the
   * hook stays idle. See the module doc for wiring patterns.
   */
  taskReader?: TaskReader;
  /**
   * Optional event stream. Prefer an abort-aware factory; the deprecated
   * pre-created AsyncIterable form remains supported for compatibility. Each
   * event triggers a refetch.
   */
  events?: TaskEventsSourceFactory | TaskEventsSource;
  /** Maximum recent events retained in memory (default `256`). */
  maxEvents?: number;
  /**
   * Stop polling once the task reaches this status (in addition to terminal
   * statuses). Useful to await a specific transition (e.g. `Completed`).
   */
  targetStatus?: TaskStatus;
  /**
   * Poll interval in ms while non-terminal. Default `2000`.
   *
   * Must be a non-negative integer no greater than `2_147_483_647`, the
   * maximum portable JavaScript timer delay; invalid values throw RangeError.
   */
  pollIntervalMs?: number;
  /** Disable the hook entirely. Default `true` when `taskPda` + reader exist. */
  enabled?: boolean;
}

/** Return value of {@link useTaskStatus}. */
export interface UseTaskStatusResult {
  /** The decoded Task, or null until first read. */
  task: Task | null;
  /** The task status, or null until first read. */
  status: TaskStatus | null;
  /**
   * The submission projection. v1 surfaces the task's on-chain `result` bytes
   * (the worker's submitted result) once present; a richer submission read
   * lands with the indexer projection. `null` until a result exists.
   */
  submission: Uint8Array | null;
  /** Coordination events observed for this task (chronological). */
  events: ObservedEvent[];
  /** True while the first read is in flight. */
  isLoading: boolean;
  /** The read error, or null. */
  error: Error | null;
  /** Force a refetch. */
  refetch: () => void;
}

/** Statuses after which no further transition is possible (stop polling). */
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  TaskStatus.Completed,
  TaskStatus.Cancelled,
  TaskStatus.RejectFrozen,
]);
const DEFAULT_MAX_EVENTS = 256;
const MAX_POLL_INTERVAL_MS = 2_147_483_647;

/** True when the task's `result` bytes are present and non-empty. */
function hasResult(task: Task | null): boolean {
  return (
    task !== null && task.result.length > 0 && task.result.some((b) => b !== 0)
  );
}

/**
 * Watch a task's status.
 *
 * @param taskPda - The Task PDA to watch (falsy disables the hook).
 * @param options - Reader, event source, target status, poll interval.
 * @returns {@link UseTaskStatusResult}.
 */
export function useTaskStatus(
  taskPda: Address | string | undefined | null,
  options?: UseTaskStatusOptions,
): UseTaskStatusResult {
  // Bind custom readers to the provider's deployment cache namespace.
  const ctx = useAgencContext();

  const reader = options?.taskReader;
  const enabled =
    (options?.enabled ?? true) && Boolean(taskPda) && Boolean(reader);
  const pollIntervalMs = options?.pollIntervalMs ?? 2000;
  const maxEvents = options?.maxEvents ?? DEFAULT_MAX_EVENTS;
  if (
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 0 ||
    pollIntervalMs > MAX_POLL_INTERVAL_MS
  ) {
    throw new RangeError(
      `useTaskStatus: pollIntervalMs must be a non-negative integer no greater than ${MAX_POLL_INTERVAL_MS} (got ${pollIntervalMs})`,
    );
  }
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 0) {
    throw new RangeError(
      `useTaskStatus: maxEvents must be a non-negative safe integer (got ${maxEvents})`,
    );
  }
  const taskIdentity = taskPda ? pdaKey(taskPda) : "";

  const [eventState, setEventState] = useState<{
    taskIdentity: string;
    events: ObservedEvent[];
  }>(() => ({ taskIdentity, events: [] }));
  // Effects run after render, so derive an empty list synchronously when the
  // task changes rather than exposing task A's history for one task-B frame.
  const events =
    eventState.taskIdentity === taskIdentity ? eventState.events : [];

  const query = useQuery<Task | null, Error>({
    queryKey: queryKeys.taskStatus(taskIdentity, ctx.cacheNamespace),
    enabled,
    queryFn: () => reader!(taskPda as Address | string),
    // Poll until terminal / target reached; then stop (return `false`).
    refetchInterval: (q) => {
      const task = q.state.data ?? null;
      if (task === null) return pollIntervalMs;
      if (TERMINAL_STATUSES.has(task.status)) return false;
      if (
        options?.targetStatus !== undefined &&
        task.status === options.targetStatus
      ) {
        return false;
      }
      return pollIntervalMs;
    },
  });

  // Own the optional event iterator so cleanup can release a subscription that
  // is blocked in next(). Event history is scoped to the current task.
  const refetchRef = useRef(query.refetch);
  refetchRef.current = query.refetch;
  const eventsSource = options?.events;
  useEffect(() => {
    setEventState({ taskIdentity, events: [] });
    if (!enabled || !eventsSource || !taskPda) return;

    const controller = new AbortController();
    const aborted = Symbol("aborted");
    const abortPromise = new Promise<typeof aborted>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(aborted), {
        once: true,
      });
    });
    let iterator: AsyncIterator<ObservedEvent> | null = null;
    let cancelled = false;
    let finished = false;
    void (async () => {
      try {
        // A callable value wins even if it also implements AsyncIterable: the
        // factory form is the only one able to propagate cooperative abort
        // into the underlying subscription transport.
        const iterable =
          typeof eventsSource === "function"
            ? eventsSource({ signal: controller.signal, taskPda })
            : eventsSource;
        iterator = iterable[Symbol.asyncIterator]();
        while (!cancelled) {
          const next = await Promise.race([iterator.next(), abortPromise]);
          if (next === aborted) break;
          if (cancelled) break;
          if (next.done) {
            finished = true;
            break;
          }
          setEventState((prev) => ({
            taskIdentity,
            events:
              prev.taskIdentity === taskIdentity
                ? maxEvents === 0
                  ? []
                  : [...prev.events, next.value].slice(-maxEvents)
                : maxEvents === 0
                  ? []
                  : [next.value],
          }));
          // A status-changing event landed — pull a fresh read.
          void refetchRef.current();
        }
      } catch {
        // A torn-down subscription (unmount) surfaces as an iterator throw;
        // swallow it — the read query owns the surfaced error channel.
      } finally {
        finished = true;
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      if (!finished && iterator?.return) {
        try {
          // React cleanup cannot await. Start closing immediately and consume
          // either a synchronous throw or asynchronous rejection locally.
          void Promise.resolve(iterator.return()).catch(() => undefined);
        } catch {
          // Best-effort teardown; the query owns the visible error channel.
        }
      }
    };
  }, [enabled, eventsSource, maxEvents, taskIdentity, taskPda]);

  const task = query.data ?? null;
  return {
    task,
    status: task?.status ?? null,
    submission: hasResult(task) ? Uint8Array.from(task!.result) : null,
    events,
    isLoading: query.isLoading,
    error: query.error ?? null,
    refetch: () => void query.refetch(),
  };
}
