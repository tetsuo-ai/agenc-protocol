/**
 * `useHire()` — the hire mutation hook (the embeddable money path).
 *
 * Drives `client.hireFromListing(...)` through the provider's write client and
 * surfaces the resulting transaction signature + minted Task PDA. Typed
 * `AgencError`s from the runtime client are surfaced UNTOUCHED in `error`.
 *
 * ## REFERRER SETTLEMENT
 *
 * The full protocol surface supports a demand-side referrer leg. This hook:
 * - reads `resolveReferrerCapability()` from context BEFORE building the hire;
 * - when `live === true`, spreads the validated provider referrer into the hire
 *   input for both standard and humanless hires;
 * - the `referrerInjected` flag in the result is the audit signal. We never set
 *   it true unless the transaction input included the referrer fields.
 *
 * @module hooks/useHire
 */
import { useMutation } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { findTaskPda } from "@tetsuo-ai/marketplace-sdk";
import type { facade as facadeNs } from "@tetsuo-ai/marketplace-sdk";
import { useAgencContext } from "../provider/context.js";
import type { Address } from "../types.js";
import {
  requireClient,
  resolveReferrerArgs,
  signerAddress,
  withoutReferrerArgs,
} from "./internal.js";
import {
  resolveHireListingModerationAccounts,
  type HireListingModerationAccounts,
} from "./moderation-attestor.js";

/**
 * Input to a standard `hire(...)` — a buyer that has a registered marketplace
 * agent (`creatorAgent`). This task settles on the HIRE COMPLETION path (the
 * worker calls `complete_task`). This is the SDK `facade.hireFromListing` input
 * MINUS the fee-payer signers, which default to the provider's write-client
 * signer (authority == creator == buyer). Pass them only to override.
 *
 * NOTE: deliberately NO referrer field — the referrer is provider-level config
 * and is injected only when `resolveReferrerCapability()` is live.
 */
export type HireInput = Omit<
  Parameters<typeof facadeNs.hireFromListing>[0],
  "authority" | "creator" | "referrer" | "referrerFeeBps"
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
  "creator" | "referrer" | "referrerFeeBps"
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
   * Whether a referrer fee leg was injected into THIS hire. Audit signal —
   * never fabricated.
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

      // Resolve fresh per hire so a provider referrer config change cannot leak
      // stale referral terms into a new transaction.
      const { referrerArgs, referrerInjected } = resolveReferrerArgs(ctx);
      const hireInput = withoutReferrerArgs(input);

      // P1.2: the hire gate names an explicit `moderator` (the caller's trust
      // decision) and needs the roster-entry PDA when that moderator is a
      // registered attestor, plus a record override when the listing
      // attestation predates the upgrade (legacy grace window). Resolve the
      // mechanics automatically unless the caller supplied any of them.
      const listingSpecHash = input.listingSpecHash;
      let moderationArgs: HireListingModerationAccounts = {};
      if (
        input.moderationAttestor === undefined &&
        input.moderatorIsAttestor === undefined &&
        input.listingModeration === undefined &&
        listingSpecHash !== undefined
      ) {
        moderationArgs = await resolveHireListingModerationAccounts({
          rpcUrl: ctx.rpcUrl,
          listing: input.listing,
          listingSpecHash,
          moderator: input.moderator,
        });
      }

      const creator = input.creator ?? client.signer;
      let signature: string;

      if (input.humanless === true) {
        // Storefront-visitor hire: no creator agent; CreatorReview-pinned, so
        // it settles via the buyer review path (useSubmissionReview).
        const result = await client.hireFromListingHumanless({
          ...hireInput,
          ...moderationArgs,
          creator,
          ...referrerArgs,
        } as Parameters<typeof facadeNs.hireFromListingHumanless>[0]);
        signature = result.signature;
      } else {
        // Standard hire: authority == creator == buyer (the buyer has an agent).
        const authority = input.authority ?? client.signer;
        const result = await client.hireFromListing({
          ...hireInput,
          ...moderationArgs,
          authority,
          creator,
          ...referrerArgs,
        } as Parameters<typeof facadeNs.hireFromListing>[0]);
        signature = result.signature;
      }

      // Derive the minted Task PDA from (creator, taskId).
      const [taskPda] = await findTaskPda({
        creator: signerAddress(creator),
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
