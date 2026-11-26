import type { Address } from "@solana/kit";
import type { Chain } from "./chain.js";
import { findHireRatingPda, getHireRatingDecoder, getHireRatingDiscriminatorBytes } from "@tetsuo-ai/marketplace-sdk";
import { landedRating, readProgramAccount, readTask } from "./market.js";
import { WalletError } from "./errors.js";
import type { JobRecord, WalletState } from "./store.js";

/**
 * The stars a buyer gave a hire this wallet's agent served (rt5 A 2: the
 * seller's job view showed none). The receipt must match the task, its
 * buyer (the task's creator) and the agent's own listing, as for the buyer.
 *
 * rt6 A 1: the buyer's tidy at payment closes the task in the same second,
 * so the seller usually finds no task to name the buyer. The receipt then
 * stands alone: it lives at the address the task fixes ("hire_rating" and
 * the task), only the marketplace program can write there, and its
 * rate_hire wrote it only for the task's creator while the task was
 * completed and hired from the receipt's listing. So a receipt read there
 * that names this task and the agent's own listing is this job's buyer's.
 */
export async function servedHireRating(chain: Chain, task: Address, listing: Address): Promise<number | null> {
  const row = await readTask(chain, task);
  if (row) return landedRating(chain, task, row.creator as Address, listing);
  return closedTaskRating(chain, task, listing);
}

async function closedTaskRating(chain: Chain, task: Address, listing: Address): Promise<number | null> {
  const [pda] = await findHireRatingPda({ task });
  const receipt = await readProgramAccount(chain, pda, getHireRatingDiscriminatorBytes(), bytes => getHireRatingDecoder().decode(bytes));
  if (receipt === null) return null;
  if (receipt.task !== task || receipt.listing !== listing || receipt.score < 1 || receipt.score > 5)
    throw new WalletError("NOT_ALLOWED", "The rating receipt does not match this hire.");
  return receipt.score;
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
