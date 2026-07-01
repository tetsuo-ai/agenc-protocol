import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";
import type { facade as facadeNs } from "@tetsuo-ai/marketplace-sdk";
import { useAgencContext } from "../provider/context.js";
import {
  mutationStatusOf,
  requireClient,
  type MutationStatus,
} from "./internal.js";

export type RateHireInput = Omit<
  Parameters<typeof facadeNs.rateHire>[0],
  "task" | "buyer"
> & {
  buyer?: Parameters<typeof facadeNs.rateHire>[0]["buyer"];
};
export type RateHireStatus = MutationStatus;

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
  const mutation = useMutation<string, Error, RateHireInput>({
    mutationFn: async (input) => {
      const client = requireClient(ctx.client);
      const { signature } = await client.rateHire({
        ...input,
        task: taskPda,
        buyer: input.buyer ?? client.signer,
      } as Parameters<typeof facadeNs.rateHire>[0]);
      return signature;
    },
  });
  const rate = useCallback((input: RateHireInput) => mutation.mutateAsync(input), [mutation]);
  return {
    rate,
    status: mutationStatusOf(mutation),
    signature: mutation.data ?? null,
    error: mutation.error ?? null,
    isPending: mutation.isPending,
    reset: mutation.reset,
  };
}
