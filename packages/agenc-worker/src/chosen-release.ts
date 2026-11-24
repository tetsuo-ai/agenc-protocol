/** Revision 9 uses the landing clock, including the final second of the grace period. */
export function chosenReleaseWindow(releaseBy: number, now: number) {
  if (!Number.isSafeInteger(now)) throw new Error("The marketplace clock is unavailable.");
  const resumeAt = releaseBy + 1;
  const phase = now < resumeAt ? "early" : "late";
  return { phase, pauseAt: resumeAt, resumeAt } as const;
}

export function releasePauseNotice(resumeAt: number) {
  return `Giving back this claim is paused. Check again at ${new Date(resumeAt * 1000).toISOString()}.`;
}

/** Time a correction leaves for uploading and landing the submission. */
export const CORRECTION_SUBMIT_MARGIN_SECS = 5 * 60;
/** Time a correction leaves before the early release pause, so the claim can still be given back. */
export const CORRECTION_RELEASE_MARGIN_SECS = 2 * 60;
/** A correction shorter than this is refused rather than started. */
export const CORRECTION_MIN_RUN_SECS = 60;

/**
 * When a correction must stop: before the claim expires or the job deadline,
 * less time to submit, and before the early release pause while giving the
 * claim back is still open. Null when nothing bounds it.
 */
export function correctionCutoff(held: {
  expiresAt: number;
  deadline: number;
  releaseWindow: { phase: "early" | "paused" | "late"; pauseAt: number } | null;
}): number | null {
  const limits = [
    held.expiresAt > 0 ? held.expiresAt - CORRECTION_SUBMIT_MARGIN_SECS : Infinity,
    held.deadline > 0 ? held.deadline - CORRECTION_SUBMIT_MARGIN_SECS : Infinity,
    held.releaseWindow?.phase === "early" ? held.releaseWindow.pauseAt - CORRECTION_RELEASE_MARGIN_SECS : Infinity,
  ];
  const end = Math.min(...limits);
  return Number.isFinite(end) ? end : null;
}

/** Seconds a correction may run now, or null when too little time is left. */
export function correctionRunSeconds(cutoff: number | null, now: number, maxSecs: number): number | null {
  if (cutoff !== null && cutoff - now < CORRECTION_MIN_RUN_SECS) return null;
  const left = cutoff === null ? maxSecs : Math.min(maxSecs, cutoff - now);
  return left > 0 ? left : null;
}
