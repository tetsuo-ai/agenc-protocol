/**
 * `useHire()` — the hire mutation hook (the embeddable money path).
 *
 * Drives `client.hireFromListing(...)` through the provider's write client and
 * surfaces the resulting transaction signature + minted Task PDA. Typed
 * `AgencError`s from the runtime client are surfaced UNTOUCHED in `error`.
 *
 * ## THE P6.2 REFERRER GATE (PLAN_2 §0, MANDATORY — read before editing)
 *
 * The on-chain referrer args + 4th settlement leg (PLAN.md P6.2) are UNBUILT.
 * The SDK `facade.hireFromListing` has NO referrer parameter. So this hook:
 * - reads `resolveReferrerCapability()` from context BEFORE building the hire;
 * - when `live === false` (ALWAYS, today): it injects NO referrer argument into
 *   the hire input. The referrer config is still accepted/validated/stored on
 *   the provider and disclosure UI may show the pending-support copy — but the
 *   transaction the user signs is a plain hire with no referral leg.
 * - the `referrerInjected` flag in the result is the audit signal: it is `false`
 *   today and would only become `true` once P6.2 is live AND a referrer is
 *   configured. We NEVER fabricate it.
 *
 * When P6.2 ships, the ONLY change here is: under `capability.live === true`,
 * spread the referrer fields (`referrer`, `referrerFeeBps`) into the hire input
 * below. Nothing else moves.
 *
 * @module hooks/useHire
 */
import { useMutation } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { facade, findTaskPda } from "@tetsuo-ai/marketplace-sdk";
import type { facade as facadeNs } from "@tetsuo-ai/marketplace-sdk";
import { useAgencContext } from "../provider/context.js";
import type { Address } from "../types.js";
import { requireClient } from "./internal.js";

/**
 * Input to a standard `hire(...)` — a buyer that has a registered marketplace
 * agent (`creatorAgent`). This task settles on the HIRE COMPLETION path (the
 * worker calls `complete_task`). This is the SDK `facade.hireFromListing` input
 * MINUS the fee-payer signers, which default to the provider's write-client
 * signer (authority == creator == buyer). Pass them only to override.
 *
 * NOTE: deliberately NO referrer field — the referrer is provider-level config,
 * gated by P6.2, and is never threaded through a per-call hire input.
 */
export type HireInput = Omit<
  Parameters<typeof facadeNs.hireFromListing>[0],
  "authority" | "creator"
> & {
  /** Standard hire (default). */
  humanless?: false;
  /** Override the buyer authority signer (defaults to the client signer). */
  authority?: Parameters<typeof facadeNs.hireFromListing>[0]["authority"];
  /** Override the buyer/creator signer (defaults to the client signer). */
  creator?: Parameters<typeof facadeNs.hireFromListing>[0]["creator"];
};

/**
 * Input to a HUMANLESS `hire(...)` — a plain-wallet buyer with NO registered
 * agent (the storefront-visitor path). The task is pinned to CreatorReview, so
 * it settles via the BUYER REVIEW path (`useSubmissionReview` accept/reject) —
 * the human reviews before funds release. This is the SDK
 * `facade.hireFromListingHumanless` input minus the `creator` signer (defaulted
 * to the client signer).
 */
export type HumanlessHireInput = Omit<
  Parameters<typeof facadeNs.hireFromListingHumanless>[0],
  "creator"
> & {
  /** Discriminates the humanless storefront-visitor hire. */
  humanless: true;
  /** Override the buyer/creator signer (defaults to the client signer). */
  creator?: Parameters<typeof facadeNs.hireFromListingHumanless>[0]["creator"];
};

/** The union of standard and humanless hire inputs. */
export type AnyHireInput = HireInput | HumanlessHireInput;

/** Lifecycle status of the hire mutation. */
export type HireStatus = "idle" | "pending" | "success" | "error";

/** Result of a settled hire. */
export interface HireResult {
  /** The confirmed transaction signature. */
  signature: string;
  /** The minted Task PDA (derived from creator + taskId). */
  taskPda: Address;
  /**
   * Whether a referrer fee leg was injected into THIS hire. Always `false`
   * today (the P6.2 gate). Audit signal — never fabricated.
   */
  referrerInjected: boolean;
}

/** Return value of {@link useHire}. */
export interface UseHireResult {
  /** Execute a hire. Resolves to {@link HireResult}; rejects with `AgencError`. */
  hire: (input: AnyHireInput) => Promise<HireResult>;
  /** Current mutation status. */
  status: HireStatus;
  /** The minted Task PDA from the last successful hire, or null. */
  taskPda: Address | null;
  /** The signature from the last successful hire, or null. */
  signature: string | null;
  /** The error from the last hire (typed `AgencError` untouched), or null. */
  error: Error | null;
  /** Whether a hire is currently in flight. */
  isPending: boolean;
  /** Reset the mutation back to idle. */
  reset: () => void;
}

/**
 * The hire hook.
 *
 * @returns {@link UseHireResult}.
 *
 * @example
 * ```tsx
 * const { hire, status, taskPda, error } = useHire();
 * await hire({
 *   listing, creatorAgent, taskId, expectedPrice: price, expectedVersion: 1n,
 *   listingSpecHash,
 * });
 * ```
 */
export function useHire(): UseHireResult {
  const ctx = useAgencContext();

  const mutation = useMutation<HireResult, Error, AnyHireInput>({
    mutationFn: async (input: AnyHireInput): Promise<HireResult> => {
      const client = requireClient(ctx.client);

      // --- THE P6.2 GATE ---
      // Capability is resolved fresh per hire. Today it is ALWAYS not-live, so
      // we build a referrer-free hire. When P6.2 lands, the `capability.live`
      // branch is where the referrer fields get spread in (for BOTH paths).
      const capability = ctx.resolveReferrerCapability();
      const referrerInjected = capability.live && ctx.referrer !== null;

      const creator = input.creator ?? client.signer;
      let signature: string;

      if (input.humanless === true) {
        // Storefront-visitor hire: no creator agent; CreatorReview-pinned, so
        // it settles via the buyer review path (useSubmissionReview).
        const ix = await facade.hireFromListingHumanless({
          ...input,
          creator,
          // NOTE: P6.2 referrer fields would spread here under capability.live.
        } as Parameters<typeof facadeNs.hireFromListingHumanless>[0]);
        ({ signature } = await client.send([ix]));
      } else {
        // Standard hire: authority == creator == buyer (the buyer has an agent).
        const authority = input.authority ?? client.signer;
        const result = await client.hireFromListing({
          ...input,
          authority,
          creator,
          // NOTE: P6.2 referrer fields would spread here under capability.live.
        } as Parameters<typeof facadeNs.hireFromListing>[0]);
        signature = result.signature;
      }

      // Derive the minted Task PDA from (creator, taskId).
      const [taskPda] = await findTaskPda({
        creator:
          typeof creator === "object" && creator !== null && "address" in creator
            ? creator.address
            : (creator as Address),
        taskId: input.taskId,
      });

      return { signature, taskPda, referrerInjected };
    },
  });

  const hire = useCallback(
    (input: AnyHireInput) => mutation.mutateAsync(input),
    [mutation],
  );

  const status: HireStatus = useMemo(() => {
    if (mutation.isPending) return "pending";
    if (mutation.isError) return "error";
    if (mutation.isSuccess) return "success";
    return "idle";
  }, [mutation.isPending, mutation.isError, mutation.isSuccess]);

  return {
    hire,
    status,
    taskPda: mutation.data?.taskPda ?? null,
    signature: mutation.data?.signature ?? null,
    error: mutation.error ?? null,
    isPending: mutation.isPending,
    reset: mutation.reset,
  };
}
