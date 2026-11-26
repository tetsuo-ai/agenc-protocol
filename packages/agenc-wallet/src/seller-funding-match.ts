// Whether the person's yes still matches the quote they read. A quote's dollar
// figures come from a rate cached for a minute, so a tick between quote and yes
// changes them while no lamport moves. Only lamports and fixed terms count.
import type { EarnFundingQuote } from "./client/types.js";

type Rows = NonNullable<EarnFundingQuote["sellerFunding"]>;
type Admission = NonNullable<EarnFundingQuote["serviceAdmission"]>;

/** Every row the person approved, by lamports. The price row is set after the quote and is bound by the action. */
export function sameFundingLamports(approved: Rows, fresh: Rows): boolean {
  const keys = (rows: Rows) => Object.keys(rows).filter((key) => key !== "price").sort();
  const names = keys(approved);
  if (JSON.stringify(names) !== JSON.stringify(keys(fresh))) return false;
  return names.every((key) => {
    const a = (approved as unknown as Record<string, { lamports?: unknown } | undefined>)[key];
    const b = (fresh as unknown as Record<string, { lamports?: unknown } | undefined>)[key];
    return typeof a?.lamports === "string" && a.lamports === b?.lamports;
  });
}

/**
 * The service's fixed terms. `minimumPriceLamports` and `modelBudgetCents` are
 * the one-cent floor and the budget at the current rate; the fresh admission
 * already refused a price below the floor, and the worker sets the budget
 * again at claim.
 */
export function sameServiceAdmission(fresh: Admission, approved: Admission): boolean {
  return fresh.capabilities === approved.capabilities;
}
