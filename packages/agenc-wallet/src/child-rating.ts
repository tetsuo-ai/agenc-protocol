// A listing rating is optional and is quoted separately by A. Constrain the
// ordinary payer signer too, so bundled and standalone stars share the child cap.
import { getCompiledTransactionMessageDecoder, type KeyPairSigner } from "@solana/kit";
import { AGENC_COORDINATION_PROGRAM_ADDRESS, getRateHireDiscriminatorBytes } from "@tetsuo-ai/marketplace-sdk";
import { childForJob } from "./child-hire-store.js";
import { WalletError } from "./errors.js";
import type { JobRecord, WalletState } from "./store.js";

type RatingState = {
  ratingQuotes?: Record<
    string,
    {
      jobId: string;
      task: string;
      listing: string;
      payer: string;
      score: number;
      expiresAt: number;
      maximumDebit: { lamports: string };
    }
  >;
  moneyOperations?: Record<
    string,
    { kind: string; jobId?: string; state: string; amount: string; fee: string }
  >;
};
export function childRatingSigner(
  signer: KeyPairSigner,
  job: JobRecord,
  state: () => WalletState & RatingState,
  now: () => number,
): KeyPairSigner {
  return {
    ...signer,
    signTransactions: async (transactions, options) => {
      for (const tx of transactions) {
        const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
        if (msg.version !== 0 && msg.version !== "legacy")
          throw new WalletError("NOT_ALLOWED", "Review the supplier transaction version.");
        const program = (index: number) => msg.staticAccounts[index];
        const instruction = msg.instructions.find(
          (ix) =>
            program(ix.programAddressIndex) === AGENC_COORDINATION_PROGRAM_ADDRESS &&
            ix.data &&
            Buffer.from(ix.data.subarray(0, 8)).equals(Buffer.from(getRateHireDiscriminatorBytes())),
        );
        if (!instruction) continue;
        const memo = msg.instructions.find(
          (ix) => program(ix.programAddressIndex) === "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
        );
        const id =
          memo?.data && /^agenc\.operation\.v1 ([a-zA-Z0-9_-]+)$/.exec(Buffer.from(memo.data).toString())?.[1];
        const journal = state(),
          child = childForJob(journal, job);
        const quote = id && journal.ratingQuotes?.[id];
        if (
          !child ||
          !quote ||
          quote.jobId !== job.id ||
          quote.task !== job.task ||
          quote.listing !== job.listing ||
          quote.payer !== signer.address ||
          quote.score !== instruction.data?.[8] ||
          quote.expiresAt <= now()
        )
          throw new WalletError(
            "APPROVAL_REQUIRED",
            "Review the supplier rating and its exact cost in Market.",
          );
        const reviews = Object.values(child.reviewDebits ?? {}).reduce(
          (sum, v) => sum + BigInt(v),
          BigInt(child.reviewSpent ?? "0"),
        );
        const ratings = Object.entries(journal.moneyOperations ?? {}).reduce((sum, [previous, op]) => {
          if (previous === id || op.kind !== "rating" || op.jobId !== job.id)
            return sum;
          return sum + BigInt(op.fee) + (op.state === "failed" ? 0n : BigInt(op.amount));
        }, 0n);
        if (reviews + ratings + BigInt(quote.maximumDebit.lamports) > BigInt(child.view.reviewReserve.lamports))
          throw new WalletError("NOT_ALLOWED", "The rating would exceed the approved supplier spending cap.");
      }
      return signer.signTransactions(transactions, options);
    },
  };
}
