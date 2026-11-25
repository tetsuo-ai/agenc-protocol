import type { Address } from "@solana/kit";
import type { Chain } from "./chain.js";
import { landedRating, readTask } from "./market.js";
import type { JobRecord, WalletState } from "./store.js";

/**
 * The stars a buyer gave a hire this wallet's agent served (rt5 A 2: the
 * seller's job view showed none). The receipt must match the task, its
 * buyer (the task's creator) and the agent's own listing, as for the buyer.
 */
export async function servedHireRating(chain: Chain, task: Address, listing: Address): Promise<number | null> {
  const row = await readTask(chain, task);
  if (!row) return null;
  return landedRating(chain, task, row.creator as Address, listing);
}

/**
 * Count a confirmed listing rating's debit where the job's price was counted
 * (`#recordPaid`): the agent's spending, or the main balance's for a request
 * the person posted. Display only; the debit itself already happened.
 */
export function countRatingSpend(draft: WalletState, job: JobRecord, debitLamports: bigint): void {
  const agent = draft.agents[job.agentId];
  if (agent !== undefined) agent.spentLamports = (BigInt(agent.spentLamports) + debitLamports).toString();
  else if (job.agentId === "") draft.mainSpentLamports = (BigInt(draft.mainSpentLamports ?? "0") + debitLamports).toString();
}
