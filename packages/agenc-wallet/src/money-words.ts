import type { Address } from "@solana/kit";
import type { Chain } from "./chain.js";

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

/**
 * What a hire or request moved from its payer (review 0.1.17 money 2, MAJOR 1): the payer's net
 * change in each of its own transactions (create and fund, the safety check, the job spec), read
 * from the chain. Its card's deposits total has no price or reward, so it is no stand-in. Null when
 * a read fails or a step's signature is unknown: no amount is better than a wrong one.
 */
export async function hireMovedLamports(chain: Pick<Chain, "accountChange">, payer: Address,
  signatures: readonly (string | undefined)[]): Promise<bigint | null> {
  if (!chain.accountChange || signatures.some(s => s === undefined)) return null;
  let moved = 0n;
  for (const signature of new Set(signatures as string[])) {
    const change = await chain.accountChange(payer, signature).catch(() => null);
    if (!change) return null;
    moved -= BigInt(change.delta);
  }
  return moved > 0n ? moved : null;
}

/** A turn-down of the person's own agent's work names that agent, not "the provider". */
export function turnDownNoteText(title: string, ownSeller: string | null): string {
  return `You turned down ${title}. ${ownSeller ?? "The provider"} can dispute it within 72 hours.`;
}
