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
  snapshotFixedBytes32,
  stabilizeSelectedTransactionSigner,
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

type HireCreator = Parameters<
  typeof facadeNs.hireFromListingHumanless
>[0]["creator"];
type HireAuthority = Parameters<
  typeof facadeNs.hireFromListing
>[0]["authority"];

interface HireMutationVariables {
  client: ReturnType<typeof requireClient>;
  input: AnyHireInput;
  creator: HireCreator;
  creatorAddress: Address;
  authority?: HireAuthority;
  orchestrationRpcUrl: ReturnType<
    typeof useAgencContext
  >["orchestrationRpcUrl"];
  orchestrationRpc: ReturnType<typeof useAgencContext>["orchestrationRpc"];
  referral: ReturnType<typeof resolveReferrerArgs>;
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
 *   listingSpecHash, taskJobSpecHash,
 * });
 * ```
 */
export function useHire(): UseHireResult {
  const ctx = useAgencContext();

  const mutation = useMutation<HireResult, Error, HireMutationVariables>({
    mutationFn: async ({
      client,
      input,
      creator,
      creatorAddress,
      authority,
      orchestrationRpcUrl,
      orchestrationRpc,
      referral,
    }): Promise<HireResult> => {
      const { referrerArgs, referrerInjected } = referral;

      // Derive exactly once from the synchronously captured signer identity and
      // detached task id. The same PDA is returned after the funded await.
      const [taskPda] = await findTaskPda({
        creator: creatorAddress,
        taskId: input.taskId,
      });

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
          rpcUrl: orchestrationRpcUrl,
          ...(orchestrationRpc === null ? {} : { rpc: orchestrationRpc }),
          listing: input.listing,
          listingSpecHash,
          moderator: input.moderator,
        });
      }

      let signature: string;

      if (input.humanless === true) {
        // Storefront-visitor hire: no creator agent; CreatorReview-pinned, so
        // it settles via the buyer review path (useSubmissionReview).
        const result = await client.hireFromListingHumanless({
          ...input,
          ...moderationArgs,
          creator,
          ...referrerArgs,
        } as Parameters<typeof facadeNs.hireFromListingHumanless>[0]);
        signature = result.signature;
      } else {
        // Standard hire: authority == creator == buyer (the buyer has an agent).
        if (authority === undefined) {
          throw new Error("useHire: missing snapshotted authority");
        }
        const result = await client.hireFromListing({
          ...input,
          ...moderationArgs,
          authority,
          creator,
          ...referrerArgs,
        } as Parameters<typeof facadeNs.hireFromListing>[0]);
        signature = result.signature;
      }

      return { signature, taskPda, referrerInjected };
    },
  });

  const hire = useCallback(
    async (input: AnyHireInput) => {
      const client = requireClient(ctx.client);
      const detachedInput = withoutReferrerArgs(input) as AnyHireInput;
      const snapshottedInput = {
        ...detachedInput,
        taskId: snapshotFixedBytes32(detachedInput.taskId, "useHire: taskId"),
        ...(detachedInput.listingSpecHash === undefined
          ? {}
          : {
              listingSpecHash: snapshotFixedBytes32(
                detachedInput.listingSpecHash,
                "useHire: listingSpecHash",
              ),
            }),
        ...(detachedInput.taskJobSpecHash === undefined
          ? {}
          : {
              taskJobSpecHash: snapshotFixedBytes32(
                detachedInput.taskJobSpecHash,
                "useHire: taskJobSpecHash",
              ),
            }),
      } as unknown as AnyHireInput;

      // Stabilize the same signer objects the SDK will place in the
      // instruction. The SDK helper canonicalizes and permanently locks the
      // address while preserving Kit's fee-payer/signer object identity and
      // any unrelated stateful wallet/session fields.
      const clientSigner = stabilizeSelectedTransactionSigner(client.signer);
      const creator = stabilizeSelectedTransactionSigner(
        clientSigner,
        detachedInput.creator,
      );
      const creatorAddress = creator.address;
      let authority: HireAuthority | undefined;
      if (detachedInput.humanless !== true) {
        const selectedAuthority = stabilizeSelectedTransactionSigner(
          clientSigner,
          detachedInput.authority,
        );
        // Creator and authority may be two wallet-adapter wrappers for the
        // same non-fee-payer account. Kit requires one object identity per
        // address across every signer role, so make creator the canonical
        // representative for that address while preserving distinct signers.
        authority = stabilizeSelectedTransactionSigner(
          creator,
          selectedAuthority,
        );
      }

      return mutation.mutateAsync({
        client,
        input: snapshottedInput,
        creator,
        creatorAddress,
        ...(authority === undefined ? {} : { authority }),
        orchestrationRpcUrl: ctx.orchestrationRpcUrl,
        orchestrationRpc: ctx.orchestrationRpc,
        // Resolve fresh at this synchronous enqueue boundary so provider
        // changes cannot alter an already accepted hire intent.
        referral: resolveReferrerArgs(ctx),
      });
    },
    [ctx, mutation],
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
