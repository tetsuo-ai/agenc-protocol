import type { Money } from "./client/types.js";
import { formatWait } from "./client/format.js";
import { agentOffers, type AgentRecord } from "./store.js";
import { amountWords, money } from "./views.js";

/**
 * What Market says about a live service that cannot take a hire it was
 * given: the service, the exact amount its agent needs and one sentence.
 * Nothing when the agent already holds enough (the worker then takes the job
 * by itself) or its balance is unknown.
 */
export function serviceNeedsMoney(
  agent: AgentRecord,
  short: { requiredLamports: bigint } | null,
  balance: bigint | null,
  rate: number | null,
): { needsMoney: { service: string; amount: Money; text: string } } | Record<string, never> {
  if (short === null || balance === null || balance >= short.requiredLamports) return {};
  const live = agentOffers(agent).find((offer) => offer.wanted && offer.status === "live") ?? agentOffers(agent).find((offer) => offer.wanted);
  const service = live?.name ?? agent.name;
  const amount = money(short.requiredLamports - balance, rate);
  return {
    needsMoney: {
      service,
      amount,
      text: `${service} cannot take jobs: ${agent.name} needs ${amountWords(rate).add(short.requiredLamports - balance)} more to start the job it was hired for. Add it and the job starts by itself.`,
    },
  };
}

/**
 * A hire of this wallet's own service that the service could not fund. No
 * claim was made, so nothing of the provider's is held: the buyer can cancel
 * it now, or it is cancelled and the price comes back by itself.
 */
export function providerCannotFundText(refundAt: number | null, now: number): string {
  const back = refundAt === null
    ? "If it does not start, the job is cancelled and the price comes back."
    : `If it does not start, the job is cancelled and the price comes back ${formatWait(refundAt, now)}.`;
  return `The provider cannot start this job yet: it does not have enough money to take it. ${back} You can cancel it now in Jobs to get it back sooner.`;
}
