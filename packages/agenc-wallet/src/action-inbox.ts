import { createHash } from "node:crypto";
import type { JobAction } from "./client/business.js";
import type { JobRecord } from "./store.js";
import { jobStatus } from "./views.js";

export interface SavedAction extends JobAction {
  dismissed?: true;
}
const REMIND_BEFORE = 60 * 60 * 1000;

function action(
  job: JobRecord,
  event: JobAction["event"],
  dueAt: number | null,
  now: number,
  deadlineKey: unknown = dueAt,
): JobAction {
  const id = createHash("sha256")
    .update(
      JSON.stringify([
        job.id,
        job.role,
        event,
        deadlineKey,
        job.deliveryPointer?.hash ?? job.result?.hash ?? null,
      ]),
    )
    .digest("hex");
  const stage =
    dueAt === null || now < dueAt - REMIND_BEFORE
      ? "new"
      : now < dueAt
        ? "soon"
        : "due";
  return {
    id,
    agentId: job.agentId,
    jobId: job.id,
    role: job.role,
    event,
    stage,
    dueAt,
    title: job.title,
  };
}

export function pendingJobAction(
  job: JobRecord,
  now: number,
): JobAction | null {
  const status = jobStatus(job);
  if (status === "delivered" && job.role === "buying") {
    const due = job.terms?.contest?.releaseAt ?? job.reviewDeadlineAt;
    return action(job, "review", due == null ? null : due * 1000, now);
  }
  if (status === "in_review" && job.turnDown?.disputable) {
    if (
      job.role === "working" &&
      job.turnDown.rulingUntil == null &&
      !job.turnDown.providerSuspended
    )
      return action(job, "dispute", job.turnDown.disputeUntil * 1000, now);
    if (job.role === "buying")
      return action(
        job,
        "refund",
        (job.turnDown.rulingUntil ?? job.turnDown.disputeUntil) * 1000,
        now,
      );
  }
  if (job.role === "buying" && status === "waiting" && job.autoRefundAt != null)
    return action(job, "refund", job.autoRefundAt, now, [
      job.deadline,
      job.autoRefundTimeoutAt ?? null,
    ]);
  return null;
}

/** Recompute only the live event for each job. A new submission gets a new id.
 * Missing several reminder thresholds produces just the latest reminder. */
export function projectInbox(
  jobs: JobRecord[],
  saved: SavedAction[],
  now: number,
  additional: JobAction[] = [],
): SavedAction[] {
  const dismissed = new Set(saved.filter((a) => a.dismissed).map((a) => a.id));
  const knownJobs = new Set(jobs.map((job) => job.id));
  const live = jobs
    .flatMap((job) => pendingJobAction(job, now) ?? [])
    .concat(additional);
  const actions: SavedAction[] = live.map((row) => ({
    ...row,
    ...(dismissed.has(row.id) && { dismissed: true as const }),
  }));
  // A worker ledger can be temporarily unavailable during room restart.
  // Preserve its dismissal until we actually observe the next job state.
  const visible = new Set(live.map((row) => row.id));
  actions.push(
    ...saved.filter(
      (row) =>
        row.dismissed && !visible.has(row.id) && !knownJobs.has(row.jobId),
    ),
  );
  return actions.sort(
    (a, b) =>
      (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || a.id.localeCompare(b.id),
  );
}
