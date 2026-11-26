// Plain words for a hire that is held up (owner real test 3, bug 7): the
// provider gave it back, or the service is at its limit of open jobs. Each
// says what happened and when the price comes back, from the times this
// wallet already keeps for its own refund of the job.

import { formatWait } from "./client/format.js";
import type { JobRecord } from "./store.js";

/** Seconds after a claimed job's deadline before this wallet cancels a job nobody delivered (wallet.ts NO_SHOW_GRACE_SECS). */
export const HIRE_NO_SHOW_GRACE_SECS = 120;

/**
 * When this wallet gets the price of an open hire back by itself, in ms, or
 * null when it does not know: the start window for a job nobody started,
 * the deadline plus its grace for a started one.
 */
export function hireRefundAt(job: Pick<JobRecord, "chainStatus" | "autoRefundAt" | "deadline">): number | null {
  if (job.chainStatus === "open" || job.chainStatus === null) return job.autoRefundAt;
  if (job.chainStatus === "in_progress" && job.deadline !== null && job.deadline > 0) {
    return (job.deadline + HIRE_NO_SHOW_GRACE_SECS) * 1000;
  }
  return null;
}

/** A hire whose provider took it and gave it back: what happened and when the price comes back. */
export function givenBackHireText(refundAt: number | null, now: number): string {
  const back = refundAt === null
    ? "The price comes back when the job is cancelled."
    : `The price comes back ${formatWait(refundAt, now)}, when the job is cancelled.`;
  return `The provider took this job and gave it back without doing it. ${back} You can cancel it now in Jobs to get it back sooner.`;
}

/** A started hire: the provider has it, and when the price comes back if nothing is delivered. */
export function workingHireText(deadline: number | null, now: number): string {
  if (deadline === null || deadline <= 0) return "The provider is working on it.";
  const refundAt = (deadline + HIRE_NO_SHOW_GRACE_SECS) * 1000;
  return `The provider is working on it. If nothing is delivered in time, the job is cancelled and the price comes back ${formatWait(refundAt, now)}.`;
}

/**
 * Why a service refuses a new hire at its limit of open jobs. With the
 * buyer's own unfinished hire of it, that hire is named with the time its
 * price comes back, which is when the service is free again at the latest.
 */
export function busyServiceText(maxOpenJobs: number, own: { title: string; refundAt: number | null; canCancel: boolean } | null, now: number): string {
  const limit = maxOpenJobs === 1 ? "one job at a time" : `${maxOpenJobs} jobs at a time`;
  if (own !== null) {
    const until = own.refundAt === null
      ? "until that job is delivered or cancelled"
      : `until that job is delivered or cancelled, ${formatWait(own.refundAt, now)} at the latest`;
    return `That service takes ${limit}, and your earlier hire of it (${own.title}) is not finished. It is busy ${until}.${own.canCancel ? " You can cancel that job in Jobs." : ""}`;
  }
  return `That service takes ${limit} and is doing that many now. It takes new jobs again when one is delivered or cancelled. Try again later.`;
}
