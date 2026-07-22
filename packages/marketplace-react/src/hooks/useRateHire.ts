import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";
import type { facade as facadeNs } from "@tetsuo-ai/marketplace-sdk";
import { useAgencContext } from "../provider/context.js";
import type { MarketplaceClient } from "../types.js";
import {
  mutationStatusOf,
  requireClient,
  snapshotOptionalFixedBytes,
  snapshotRecord,
  stabilizeSelectedTransactionSigner,
  type MutationStatus,
} from "./internal.js";

export type RateHireInput = Omit<
  Parameters<typeof facadeNs.rateHire>[0],
  "task" | "buyer"
> & {
  buyer?: Parameters<typeof facadeNs.rateHire>[0]["buyer"];
};
export type RateHireStatus = MutationStatus;

interface QueuedRateHireInput {
  readonly client: MarketplaceClient;
  readonly input: RateHireInput;
}

export interface UseRateHireResult {
  rate: (input: RateHireInput) => Promise<string>;
  status: RateHireStatus;
  signature: string | null;
  error: Error | null;
  isPending: boolean;
  reset: () => void;
}

export function useRateHire(
  taskPda: Parameters<typeof facadeNs.rateHire>[0]["task"],
): UseRateHireResult {
  const ctx = useAgencContext();
  const mutation = useMutation<string, Error, QueuedRateHireInput>({
    mutationFn: async ({ client, input }) => {
      const { signature } = await client.rateHire({
        ...input,
        task: taskPda,
      } as Parameters<typeof facadeNs.rateHire>[0]);
      return signature;
    },
  });
  const rate = useCallback(
    async (input: RateHireInput) => {
      const client = requireClient(ctx.client);
      const detachedInput = snapshotRecord(input);
      const buyer = stabilizeSelectedTransactionSigner(
        client.signer,
        detachedInput.buyer,
      );
      const snapshottedInput = snapshotRecord({
        ...detachedInput,
        buyer,
        reviewHash: snapshotOptionalFixedBytes(
          detachedInput.reviewHash,
          32,
          "useRateHire.rate: reviewHash",
        ),
      }) as RateHireInput;
      return mutation.mutateAsync({ client, input: snapshottedInput });
    },
    [ctx.client, mutation],
  );
  return {
    rate,
    status: mutationStatusOf(mutation),
    signature: mutation.data ?? null,
    error: mutation.error ?? null,
    isPending: mutation.isPending,
    reset: mutation.reset,
  };
}
