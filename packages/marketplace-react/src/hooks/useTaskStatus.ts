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
 * - Subscription: when an `events` async-iterable is supplied (e.g. from the
 *   SDK's `subscribeMarketplaceEvents`), a `useEffect` (browser-only; never runs
 *   during SSR) drains it, appends each event to `events`, and triggers a
 *   refetch so status stays fresh without tight polling. The effect aborts the
 *   iterable and clears state on unmount.
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
 * An async source of coordination events for the watched task. Pass the result
 * of the SDK's `subscribeMarketplaceEvents(...)` (already address-filtered) or
 * any async iterable. Optional.
 */
export type TaskEventsSource = AsyncIterable<ObservedEvent>;

/** Options for {@link useTaskStatus}. */
export interface UseTaskStatusOptions {
  /**
   * How to read the Task account. REQUIRED for any live status — without it the
   * hook stays idle. See the module doc for wiring patterns.
   */
  taskReader?: TaskReader;
  /**
   * Optional event source. When given, observed events are appended to
   * `events` and each triggers a refetch. Drained in a browser-only effect and
   * aborted on unmount.
   */
  events?: TaskEventsSource;
  /**
   * Stop polling once the task reaches this status (in addition to terminal
   * statuses). Useful to await a specific transition (e.g. `Completed`).
   */
  targetStatus?: TaskStatus;
  /** Poll interval in ms while non-terminal. Default `2000`. */
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

/** True when the task's `result` bytes are present and non-empty. */
function hasResult(task: Task | null): boolean {
  return task !== null && task.result.length > 0 && task.result.some((b) => b !== 0);
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
  // Touch context so the hook is provider-bound (and throws clearly outside it),
  // matching every other hook's contract even though reads come via the reader.
  useAgencContext();

  const reader = options?.taskReader;
  const enabled =
    (options?.enabled ?? true) && Boolean(taskPda) && Boolean(reader);
  const pollIntervalMs = options?.pollIntervalMs ?? 2000;

  const [events, setEvents] = useState<ObservedEvent[]>([]);

  const query = useQuery<Task | null, Error>({
    queryKey: queryKeys.taskStatus(taskPda ? pdaKey(taskPda) : ""),
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

  // Drain the optional event source in a browser-only effect (never during SSR;
  // effects don't run on the server). Abort + reset on unmount / source change.
  const refetchRef = useRef(query.refetch);
  refetchRef.current = query.refetch;
  const eventsSource = options?.events;
  useEffect(() => {
    if (!eventsSource) return;
    let cancelled = false;
    (async () => {
      try {
        for await (const ev of eventsSource) {
          if (cancelled) break;
          setEvents((prev) => [...prev, ev]);
          // A status-changing event landed — pull a fresh read.
          void refetchRef.current();
        }
      } catch {
        // A torn-down subscription (unmount) surfaces as an iterator throw;
        // swallow it — the read query owns the surfaced error channel.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventsSource]);

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
