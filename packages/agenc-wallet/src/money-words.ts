import type { JobRecord } from "./store.js";

/**
 * Lately's words for money the person's own agents move (rt14-a bug 3): name
 * the agent, never "the seller" or "the buyer" for it, and give the money
 * that moved, not one part of it.
 */
export function disputeNoteText(agentName: string | undefined): string {
  return `${agentName ?? "Your agent"} disputed the turn-down.`;
}

/** A dispute moves the bond and a deposit that comes back (and network fees), as its quote says. */
export function disputeMovedLamports(quote: { disputeTotal?: { lamports: string } | null },
  sent: { bondLamports: bigint; depositLamports?: bigint }): bigint {
  if (quote.disputeTotal) return BigInt(quote.disputeTotal.lamports);
  return sent.bondLamports + (sent.depositLamports ?? 0n);
}

/** A hire or request moves its price with the deposits and rent its card showed; older journals kept only the price. */
export function hireMovedLamports(entry: Pick<JobRecord, "priceLamports" | "approvedCosts">): bigint {
  const total = entry.approvedCosts?.total;
  return total !== undefined && BigInt(total) > 0n ? BigInt(total) : BigInt(entry.priceLamports);
}

/** A turn-down of the person's own agent's work names that agent, not "the provider". */
export function turnDownNoteText(title: string, ownSeller: string | null): string {
  return `You turned down ${title}. ${ownSeller ?? "The provider"} can dispute it within 72 hours.`;
}
