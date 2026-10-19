import type { PurchaseRecord, Task } from "../generated/index.js";

/** Revision-8 fee floor; SOL lamports actually paid, never listing price. */
export const MIN_RATING_PROTOCOL_FEE_LAMPORTS = 100_000n;

/** Fee evidence only. Buyer/status/one-rating guards still apply on chain. */
export function isHireRatingFeeQualified(
  task: Pick<Task, "reserved">,
): boolean {
  const r = task.reserved;
  return (
    r.length === 16 &&
    r[2]! <= 1 &&
    r[11]! <= 1 &&
    r[12] === 1 &&
    r.slice(13).every((value) => value === 0)
  );
}

/** Legacy, SPL and malformed purchase records are ineligible for new ratings. */
export function isSkillRatingFeeQualified(
  purchase: Pick<PurchaseRecord, "reserved">,
): boolean {
  const r = purchase.reserved;
  return r.length === 4 && r[1] === 1 && r[2] === 0 && r[3] === 0;
}
