// Poll a Task account until it reaches a target TaskStatus.
import type { Address, Commitment } from "@solana/kit";
import {
  getTaskDecoder,
  TaskStatus,
  type Task,
} from "../generated/index.js";
import { base64ToBytes, sleep } from "./internal.js";

/**
 * Minimal structural slice of a kit `Rpc` client used by
 * {@link waitForTaskStatus}: `getAccountInfo` with base64 encoding.
 */
export type WaitForTaskStatusRpc = {
  getAccountInfo(
    address: Address,
    config?: { readonly commitment?: Commitment; readonly encoding?: "base64" },
  ): {
    send(options?: { readonly abortSignal?: AbortSignal }): Promise<{
      readonly value: { readonly data: readonly [string, string] } | null;
    }>;
  };
};

/** Options for {@link waitForTaskStatus}. */
export type WaitForTaskStatusOptions = {
  /** Give up (reject) after this many milliseconds (default `30000`). */
  timeoutMs?: number;
  /** Delay between polls in milliseconds (default `500`). */
  pollIntervalMs?: number;
  /** Commitment for `getAccountInfo` (default `"confirmed"`). */
  commitment?: Commitment;
};

/**
 * Polls a Task account with `getAccountInfo` (base64) until it decodes to the
 * requested {@link TaskStatus}, then resolves with the decoded {@link Task}.
 *
 * Rejects with a descriptive error when `timeoutMs` elapses first, including
 * the last observed status (or "account not found" if the task never
 * appeared).
 *
 * @param rpc - A kit `Rpc` client (or any object with a
 * structurally-compatible `getAccountInfo` method).
 * @param taskPda - The Task account address to watch.
 * @param status - The {@link TaskStatus} to wait for.
 * @param options - Timeout, poll interval, and commitment.
 * @returns The decoded {@link Task} once it reaches `status`.
 *
 * @example
 * ```ts
 * const task = await waitForTaskStatus(rpc, taskPda, TaskStatus.Completed, {
 *   timeoutMs: 60_000,
 * });
 * console.log(task.completedAt);
 * ```
 */
export async function waitForTaskStatus(
  rpc: WaitForTaskStatusRpc,
  taskPda: Address,
  status: TaskStatus,
  options: WaitForTaskStatusOptions = {},
): Promise<Task> {
  const {
    timeoutMs = 30_000,
    pollIntervalMs = 500,
    commitment = "confirmed",
  } = options;
  const deadline = Date.now() + timeoutMs;
  let lastObserved = "account not found";

  for (;;) {
    const { value } = await rpc
      .getAccountInfo(taskPda, { commitment, encoding: "base64" })
      .send();
    if (value !== null) {
      const bytes = base64ToBytes(value.data[0]);
      if (bytes === null) {
        lastObserved = "undecodable account data (bad base64)";
      } else {
        const task = getTaskDecoder().decode(bytes);
        if (task.status === status) return task;
        lastObserved = TaskStatus[task.status] ?? `status ${task.status}`;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }

  throw new Error(
    `waitForTaskStatus timed out after ${timeoutMs}ms: task ${taskPda} never ` +
      `reached status ${TaskStatus[status] ?? status} (last observed: ${lastObserved})`,
  );
}
