/** Revision 9 uses the landing clock, including the final second of the grace period. */
export function chosenReleaseWindow(releaseBy: number, now: number) {
  if (!Number.isSafeInteger(now)) throw new Error("The marketplace clock is unavailable.");
  const pauseAt = releaseBy - 10 * 60;
  const resumeAt = releaseBy + 1;
  const phase = now < pauseAt ? "early" : now < resumeAt ? "paused" : "late";
  return { phase, pauseAt, resumeAt } as const;
}

export function releasePauseNotice(resumeAt: number) {
  return `Giving back this claim is paused. Check again at ${new Date(resumeAt * 1000).toISOString()}.`;
}
