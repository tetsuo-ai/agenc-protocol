import type { ModelBudget } from "./state.js";

// Hold one fifth for each of the two possible revisions, with one cent for
// each round on small jobs. The initial run keeps the rest.
function perRevision(total: number): number {
  return total >= 3 ? Math.max(1, Math.floor(total / 5)) : 0;
}

export function claimBudget(totalCents: number, reserve: boolean): ModelBudget {
  const slice = reserve ? perRevision(totalCents) : 0;
  return slice ? { totalCents, remainingCents: totalCents - 2 * slice, revisionRound: 0 }
    : { totalCents, remainingCents: totalCents };
}

/** Only a newer confirmed submission count releases the next slice. Retries,
 * restarts and budgets created before this feature cannot acquire more money. */
export function budgetForRevision(budget: ModelBudget | undefined, round: number): ModelBudget | undefined {
  if (budget?.revisionRound === undefined || round <= budget.revisionRound || (round !== 1 && round !== 2)) return budget;
  return { totalCents: budget.totalCents, remainingCents: perRevision(budget.totalCents), revisionRound: round };
}
