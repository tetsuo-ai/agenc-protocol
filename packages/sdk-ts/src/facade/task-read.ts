// Facade: read a task by its address on revision 9.
//
// `close_task` compacts a finished Task in place: the 466-byte Task at
// `["task", creator, task_id]` becomes a 56-byte `TaskMarker` that keeps the
// creator, the final status, two flags and the time it was closed. The rest of
// the Task's rent goes back to the creator. A client that reads a task by
// address must therefore expect a marker there and show the task as closed.
// The marker is decoded with the generated coder from the IDL.
import type { Address, ReadonlyUint8Array } from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  getTaskDecoder,
  getTaskDiscriminatorBytes,
  getTaskMarkerDecoder,
  getTaskMarkerDiscriminatorBytes,
  getTaskMarkerSize,
  TaskStatus,
  type Task,
  type TaskMarker,
  type TaskModeration,
} from "../generated/index.js";
import type {
  ProgramAccountSnapshot,
  ReadAccountSnapshot,
} from "./turn-downs.js";

/** `TaskMarker.flags` bit 0: the close ended a live hire record. */
export const TASK_MARKER_FLAG_ENDED_LIVE_HIRE = 1;
/** `TaskMarker.flags` bit 1: the task completed with the minimum protocol fee. */
export const TASK_MARKER_FLAG_FEE_QUALIFIED = 2;

/** How a closed task ended. */
export type ClosedTaskStatus = "completed" | "cancelled";

/** What the account at a task's address holds. */
export type TaskAccountRead =
  | { readonly kind: "task"; readonly task: Task }
  | {
      readonly kind: "closed";
      readonly marker: TaskMarker;
      /** The task's final status. */
      readonly status: ClosedTaskStatus;
      /** The close ended a live hire record (flag bit 0). */
      readonly endedLiveHire: boolean;
      /** The task completed with the minimum protocol fee (flag bit 1). */
      readonly feeQualified: boolean;
    }
  | { readonly kind: "missing" };

const MISSING: TaskAccountRead = Object.freeze({ kind: "missing" });

function startsWith(
  data: Uint8Array | ReadonlyUint8Array,
  prefix: ReadonlyUint8Array,
): boolean {
  if (data.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (data[index] !== prefix[index]) return false;
  }
  return true;
}

/** True when the bytes start with the `TaskMarker` discriminator. */
export function isTaskMarkerData(
  data: Uint8Array | ReadonlyUint8Array,
): boolean {
  return (
    data.length >= getTaskMarkerSize() &&
    startsWith(data, getTaskMarkerDiscriminatorBytes())
  );
}

/**
 * Decode the account at a task's address.
 *
 * - `missing`: no account, an empty one, or one the program does not own
 *   (anyone can send lamports to an address, so a system-owned account is
 *   never a task).
 * - `task`: a live or finished Task that was not closed yet.
 * - `closed`: a `TaskMarker` left by `close_task`.
 *
 * Throws for a program account that is neither, and for a marker whose status
 * is not Completed or Cancelled (the program writes no other).
 */
export function decodeTaskAccount(
  account: ProgramAccountSnapshot | null,
): TaskAccountRead {
  if (account === null) return MISSING;
  if (account.owner !== AGENC_COORDINATION_PROGRAM_ADDRESS) return MISSING;
  if (account.data.length === 0) return MISSING;
  const data = new Uint8Array(account.data);
  if (startsWith(data, getTaskDiscriminatorBytes())) {
    return { kind: "task", task: getTaskDecoder().decode(data) };
  }
  if (isTaskMarkerData(data)) {
    const marker = getTaskMarkerDecoder().decode(data);
    let status: ClosedTaskStatus;
    if (marker.status === TaskStatus.Completed) status = "completed";
    else if (marker.status === TaskStatus.Cancelled) status = "cancelled";
    else {
      throw new Error(
        `TaskMarker: status ${marker.status} is not Completed or Cancelled`,
      );
    }
    return {
      kind: "closed",
      marker,
      status,
      endedLiveHire: (marker.flags & TASK_MARKER_FLAG_ENDED_LIVE_HIRE) !== 0,
      feeQualified: (marker.flags & TASK_MARKER_FLAG_FEE_QUALIFIED) !== 0,
    };
  }
  throw new Error(
    "Task: a program account at this address is neither a Task nor a TaskMarker",
  );
}

/**
 * Read a task by address: the Task, `closed` for a compacted task, or
 * `missing`.
 *
 * @param read - an owner-aware account reader ({@link accountSnapshotReader}).
 */
export async function readTask(
  read: ReadAccountSnapshot,
  task: Address,
): Promise<TaskAccountRead> {
  return decodeTaskAccount(await read(task));
}

/**
 * Where a `TaskModeration` record's rent goes when it is closed: to the task's
 * creator when the creator paid it (`_reserved[0] == 1`, revision 9's
 * `rent_payer`), else to the moderator. Records made before revision 9 hold 0
 * and go to the moderator, as they always did.
 */
export function taskModerationRentRecipient(
  record: Pick<TaskModeration, "creator" | "moderator" | "reserved">,
): Address {
  return record.reserved[0] === 1 ? record.creator : record.moderator;
}
