import type { Address } from "@solana/kit";
import { APPROVAL_FEE_LAMPORTS } from "./approval.js";
import type { Chain } from "./chain.js";
import { childForJob, childHolds } from "./child-hire-store.js";
import { WalletError } from "./errors.js";
import type { JobRecord, StateStore, WalletState } from "./store.js";
import { inTransportScope, type PendingListingSend } from "./transport-scope.js";

export type PurchaseStep = "attest" | "activate" | "tidy";
export interface PurchaseSend extends PendingListingSend {
  step: PurchaseStep;
  outcome?: "expired" | "landed" | "failed";
  fee?: string;
  debit?: string;
}

/** A terminal escrow still owns its unconfirmed debits and its quoted cleanup fee. */
export function finishChildReserve(state: WalletState, job: JobRecord) {
  if (!job.outcome) return;
  const r = childForJob(state, job);
  if (!r) return;
  const holds = childHolds(state.agents[job.agentId]!).childHolds;
  const hold = holds?.[job.id];
  if (
    !holds ||
    !hold ||
    Object.keys(hold.pending ?? {}).length ||
    !r.dispatch?.debit ||
    r.purchaseSends?.some((a) => !a.outcome)
  )
    return;
  const tidy = r.purchaseSends?.find(
    (a) => a.step === "tidy" && (a.outcome === "landed" || BigInt(a.fee ?? "0") > 0n),
  );
  if (job.tidied || tidy) delete holds[job.id];
  else {
    hold.review = "0";
    const fees = BigInt(r.view.quote.networkFees?.lamports ?? "0");
    hold.futurePurchase = String(fees > APPROVAL_FEE_LAMPORTS ? (fees - APPROVAL_FEE_LAMPORTS) / 4n : 0n);
  }
}

/** Publication and cleanup each have one fee in the original purchase quote.
 * A lost acknowledgement can be recovered, and verified expiry releases that fee. */
export async function reconcilePurchaseSends(store: StateStore, chain: Chain, job: JobRecord) {
  const child = childForJob(store.state, job);
  if (!child) return;
  for (const entry of child.purchaseSends ?? []) {
    if (entry.outcome) continue;
    const outcome = await chain.reviewSendOutcome?.(entry);
    if (!outcome || outcome === "pending") continue;
    const charge =
      outcome === "expired"
        ? { debit: 0n, fee: 0n }
        : await chain.reviewDebit?.(entry.signature, child.view.payer as Address);
    if (!charge) continue;
    store.update((state) => {
      const r = childForJob(state, job)!;
      const current = r.purchaseSends!.find((row) => row.signature === entry.signature)!;
      if (current.outcome) return;
      const debit = charge.debit > charge.fee ? charge.debit : charge.fee;
      Object.assign(current, { outcome, fee: String(charge.fee), debit: String(debit) });
      const hold = childHolds(state.agents[job.agentId]!).childHolds?.[job.id];
      if (hold?.futurePurchase) {
        const left = BigInt(hold.futurePurchase) - debit;
        hold.futurePurchase = String(left > 0n ? left : 0n);
      }
      finishChildReserve(state, state.jobs[job.id]!);
    });
  }
}

export async function withPurchaseStep<T>(
  store: StateStore,
  chain: Chain,
  job: JobRecord,
  step: PurchaseStep,
  maximumFee: bigint,
  send: () => Promise<T>,
) {
  if (!childForJob(store.state, job)) return send();
  await reconcilePurchaseSends(store, chain, job);
  const check = () => {
    const r = childForJob(store.state, job)!;
    const attempts = (r.purchaseSends ?? []).filter((row) => row.step === step);
    if (attempts.some((a) => !a.outcome || a.outcome === "landed"))
      throw new WalletError("NETWORK", "The supplier purchase is awaiting its original receipt.");
    const fees = BigInt(r.view.quote.networkFees?.lamports ?? "0");
    const approved = step === "attest" ? APPROVAL_FEE_LAMPORTS : (fees - APPROVAL_FEE_LAMPORTS) / 4n;
    if (maximumFee > approved || attempts.some((a) => BigInt(a.fee ?? "0") > 0n))
      throw new WalletError(
        "NOT_ALLOWED",
        "The approved purchase fee was used. Review recovery of this escrow.",
      );
  };
  check();
  try {
    return await inTransportScope(
      {
        signal: AbortSignal.timeout(60_000),
        sending: (receipt) => {
          check();
          store.update((state) => {
            const r = childForJob(state, job)!;
            (r.purchaseSends ??= []).push({ ...receipt, step });
          });
        },
        confirmed() {},
      },
      send,
    );
  } finally {
    await reconcilePurchaseSends(store, chain, job);
  }
}
