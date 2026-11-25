/**
 * Money a live service keeps for the jobs it takes. While an agent earns with
 * a service on offer, its own purchases (hires, posts, contests) may not spend
 * the lamports its worker needs to claim and deliver the next hire. A purchase
 * that would dip into them is paid from the main balance with the person's
 * yes instead, and one already approved from the agent's money stops before
 * anything is sent.
 */
export const SERVICE_HOLD_REFUSAL =
  "Paying this from the agent's own money would leave its service on offer unable to take jobs. Nothing was spent.";

export const SERVICE_HOLD_APPROVAL =
  "Paying this from the agent's own money would leave its service on offer unable to take jobs. Add money to the agent or ask again so it is paid from your main balance.";

/** The largest first-job reserve among live services, or zero when the agent is not earning with one. */
export async function serviceHoldLamports(
  earning: boolean,
  livePrices: bigint[],
  jobReserve: (priceLamports?: bigint) => Promise<bigint>,
): Promise<bigint> {
  if (!earning || livePrices.length === 0) return 0n;
  let hold = 0n;
  for (const price of livePrices) {
    const reserve = await jobReserve(price);
    if (reserve > hold) hold = reserve;
  }
  return hold;
}

export const SERVICE_HOLD_RATING =
  "Rating from the agent's own money would leave its service on offer unable to take jobs. Add money to the agent first.";
