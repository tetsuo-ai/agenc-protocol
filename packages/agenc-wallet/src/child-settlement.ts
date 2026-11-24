// The payer lock encloses reconciliation, authorization, pre-broadcast journal and dispatch.
import { address } from "@solana/kit";
import type { Chain } from "./chain.js";
import { finishChildReserve } from "./child-publication.js";
import { APPROVAL_FEE_LAMPORTS } from "./approval.js";
import { childForJob, childHolds, type ChildHireRecord } from "./child-hire-store.js";
import { WalletError } from "./errors.js";
import { microcents, remainingJobMicrocents } from "./job-money.js";
import { inTransportScope, type PendingListingSend } from "./transport-scope.js";
import type { JobRecord, StateStore } from "./store.js";

export interface ChildSettlementAttempt extends PendingListingSend {
  maximum: string;
  action: "expiry" | "cancel";
  outcome?: "landed" | "failed" | "expired";
  fee?: string;
  debit?: string;
}
export function remainingChildFees(child: ChildHireRecord) {
  const fees = BigInt(child.view.quote.networkFees?.lamports ?? "0");
  // Earlier quotes reserved three ordinary review fees, alongside record rent.
  const cap = BigInt(
    child.maximumReviewFees ??
      (fees > APPROVAL_FEE_LAMPORTS ? ((fees - APPROVAL_FEE_LAMPORTS) / 4n) * 3n : 0n),
  );
  return cap - BigInt(child.reviewFeesSpent ?? child.reviewSpent ?? "0");
}
export async function reconcileChildSettlement(store: StateStore, chain: Chain, job: JobRecord, now: number) {
  const child = childForJob(store.state, job);
  const pending = child?.settlementAttempts?.find((a) => !a.outcome);
  if (!child || !pending) return;
  const outcome = await chain.reviewSendOutcome?.(pending);
  const paid =
    outcome && outcome !== "expired" && outcome !== "pending"
      ? await chain.reviewDebit?.(pending.signature, address(child.view.payer))
      : null;
  if (!outcome || outcome === "pending" || (outcome !== "expired" && !paid))
    throw new WalletError("NETWORK", "The supplier settlement is awaiting its receipt.");
  store.update((state) => {
    const r = childForJob(state, job)!;
    const entry = r.settlementAttempts!.find((a) => a.signature === pending.signature)!;
    if (entry.outcome) return;
    const fee = paid?.fee ?? 0n;
    const actual = paid && paid.debit > fee && outcome === "landed" ? paid.debit : fee;
    Object.assign(entry, { outcome, debit: String(actual), fee: String(fee) });
    const agent = state.agents[job.agentId]!;
    const holds = childHolds(agent).childHolds!;
    const hold = holds[job.id]!;
    delete hold.pending![entry.signature];
    hold.review = String(BigInt(hold.review) + BigInt(entry.maximum) - actual);
    r.reviewFeesSpent = String(BigInt(r.reviewFeesSpent ?? r.reviewSpent ?? "0") + fee);
    r.reviewSpent = String(BigInt(r.reviewSpent ?? "0") + actual);
    if (actual)
      agent.refills.push({
        id: "review:" + job.id + ":" + entry.signature,
        signature: entry.signature,
        lamports: String(actual),
        usdCents: Number(microcents(actual, hold.rate)) / 1e6,
        ts: now,
      });
    finishChildReserve(state, state.jobs[job.id]!);
  });
}

export async function withChildSettlement<T>(
  store: StateStore,
  chain: Chain,
  job: JobRecord,
  action: ChildSettlementAttempt["action"],
  rent: bigint,
  now: () => number,
  rate: number,
  send: () => Promise<T>,
) {
  await reconcileChildSettlement(store, chain, job, now());
  const fee = chain.transferFeeLamports;
  const cost = rent + fee;
  const check = () => {
    const r = childForJob(store.state, job)!;
    const agent = store.state.agents[job.agentId]!;
    const hold = childHolds(agent).childHolds?.[job.id];
    if (r.settlementAttempts?.some((a) => a.outcome === "landed"))
      throw new WalletError("NOT_ALLOWED", "The settlement already landed. Refresh the escrow.");
    if (
      !hold ||
      cost > BigInt(hold.review) ||
      fee > remainingChildFees(r) ||
      !agent.policy.refill.enabled ||
      microcents(cost, rate) > remainingJobMicrocents(agent, now(), undefined, job.id, rate)
    )
      throw new WalletError("NOT_ALLOWED", "The supplier settlement exceeds the approved fees or allowance.");
  };
  check();
  if ((await chain.getBalance(address(childForJob(store.state, job)!.view.payer))) < cost)
    throw new WalletError("NOT_ENOUGH_MONEY", "Other jobs have reserved this money.");
  try {
    return await inTransportScope(
      {
        signal: AbortSignal.timeout(60_000),
        sending: (receipt) => {
          check();
          store.update((state) => {
            const r = childForJob(state, job)!;
            if (r.settlementAttempts?.some((a) => !a.outcome || a.signature === receipt.signature))
              throw new WalletError("NOT_ALLOWED", "The settlement attempt is already recorded.");
            const hold = childHolds(state.agents[job.agentId]!).childHolds![job.id]!;
            hold.review = String(BigInt(hold.review) - cost);
            (hold.pending ??= {})[receipt.signature] = String(cost);
            (r.settlementAttempts ??= []).push({ ...receipt, action, maximum: String(cost) });
          });
        },
        confirmed() {},
      },
      send,
    );
  } finally {
    await reconcileChildSettlement(store, chain, job, now());
  }
}
