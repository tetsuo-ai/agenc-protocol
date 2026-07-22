/**
 * Internal helpers shared by the headless hooks.
 *
 * - A namespaced TanStack Query key factory so every hook's cache entries are
 *   stable, collision-free, and individually invalidatable.
 * - Tiny guards that turn a missing write client / signer into a clear,
 *   catalog-routed error (never a `null.method()` crash) BEFORE a mutation runs.
 *
 * SSR-safe: pure functions, no `window`/`document`, no module-scope side
 * effects.
 *
 * @module hooks/internal
 */
import { stabilizeTransactionSigner } from "@tetsuo-ai/marketplace-sdk";
import { t } from "../strings/index.js";
import type {
  Address,
  AgencContextValue,
  MarketplaceClient,
  TransactionSigner,
} from "../types.js";

/** Root namespace for every cache key this package writes. */
export const QUERY_KEY_ROOT = "agenc" as const;

/** Namespace used only by direct callers that omit deployment identity. */
export const DEFAULT_QUERY_CACHE_NAMESPACE = "default" as const;

function queryRoot(cacheNamespace: string) {
  return [QUERY_KEY_ROOT, cacheNamespace] as const;
}

/**
 * Stable, hierarchical TanStack Query keys. Hooks build their keys ONLY through
 * this factory so a consumer (or a hook) can invalidate a deployment sub-tree
 * (`["agenc", namespace, "listings"]`) or one entity
 * (`["agenc", namespace, "listing", pda]`).
 *
 * `JSON.stringify` is intentionally NOT used — TanStack compares keys
 * structurally, so passing the raw filter object keeps equality correct for
 * `bigint`/`Address` values without a serialization step.
 */
export const queryKeys = {
  /** All listings list queries (with their filter object as the leaf). */
  listings: (
    filter?: unknown,
    cacheNamespace: string = DEFAULT_QUERY_CACHE_NAMESPACE,
  ) => [...queryRoot(cacheNamespace), "listings", filter ?? null] as const,
  /** One listing + its joined provider/track-record/moderation. */
  listing: (
    pda: string,
    cacheNamespace: string = DEFAULT_QUERY_CACHE_NAMESPACE,
  ) => [...queryRoot(cacheNamespace), "listing", pda] as const,
  /** One agent's indexer track record. */
  agentTrackRecord: (
    agentPda: string,
    cacheNamespace: string = DEFAULT_QUERY_CACHE_NAMESPACE,
  ) => [...queryRoot(cacheNamespace), "agentTrackRecord", agentPda] as const,
  /** One task's status (read via transport / svm decode). */
  taskStatus: (
    taskPda: string,
    cacheNamespace: string = DEFAULT_QUERY_CACHE_NAMESPACE,
  ) => [...queryRoot(cacheNamespace), "taskStatus", taskPda] as const,
  /** One task's dispute record. */
  dispute: (
    taskPda: string,
    cacheNamespace: string = DEFAULT_QUERY_CACHE_NAMESPACE,
  ) => [...queryRoot(cacheNamespace), "dispute", taskPda] as const,
  /** One task's completion-bond ("Guaranteed Hire") state. */
  taskGuarantee: (
    taskPda: string,
    cacheNamespace: string = DEFAULT_QUERY_CACHE_NAMESPACE,
  ) => [...queryRoot(cacheNamespace), "taskGuarantee", taskPda] as const,
  /** One referrer wallet's earnings (indexer-gated; see useReferrerEarnings). */
  referrerEarnings: (
    wallet: string,
    cacheNamespace: string = DEFAULT_QUERY_CACHE_NAMESPACE,
  ) => [...queryRoot(cacheNamespace), "referrerEarnings", wallet] as const,
} as const;

/**
 * Assert a write client exists, returning it narrowed to non-null. Throws a
 * clear, catalog-routed error when the provider was configured read-only (no
 * `client` and no resolvable `rpcUrl` + `signer`).
 *
 * Mutating hooks call this at the top of their `mutationFn` so the failure is a
 * descriptive Error in the mutation's `error` channel — never a crash.
 *
 * @throws Error (`provider.missingWriteClient`) when `client` is null.
 */
export function requireClient(
  client: MarketplaceClient | null,
): MarketplaceClient {
  if (client === null) {
    throw new Error(t("provider.missingWriteClient"));
  }
  return client;
}

export type MutationStatus = "idle" | "pending" | "success" | "error";

export function mutationStatusOf(mutation: {
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
}): MutationStatus {
  if (mutation.isPending) return "pending";
  if (mutation.isError) return "error";
  if (mutation.isSuccess) return "success";
  return "idle";
}

/** Coerce an `Address | string` to its string form for use as a cache key. */
export function pdaKey(pda: Address | string): string {
  return String(pda);
}

export interface ReferrerArgs {
  referrer?: Address;
  referrerFeeBps?: number;
}

export interface ResolvedReferrerArgs {
  referrerArgs: ReferrerArgs;
  referrerInjected: boolean;
}

export function resolveReferrerArgs(
  ctx: Pick<AgencContextValue, "resolveReferrerCapability">,
): ResolvedReferrerArgs {
  const capability = ctx.resolveReferrerCapability();
  if (!capability.live || !capability.referrer) {
    return { referrerArgs: {}, referrerInjected: false };
  }
  return {
    referrerArgs: {
      referrer: capability.referrer.wallet,
      referrerFeeBps: capability.referrer.feeBps,
    },
    referrerInjected: true,
  };
}

/**
 * Detach one on-chain fixed-byte value from caller-owned mutable storage.
 * Validation happens synchronously at the hook's public enqueue boundary so a
 * later TanStack/SDK await can never observe a different byte sequence.
 */
export function snapshotFixedBytes32(
  value: unknown,
  label: string,
): Uint8Array {
  return snapshotFixedBytes(value, 32, label);
}

function snapshotFixedBytes(
  value: unknown,
  byteLength: number,
  label: string,
): Uint8Array {
  if (
    !isExactUint8Array(value) ||
    typedArrayByteLengthGetter?.call(value) !== byteLength ||
    !hasOrdinaryArrayBuffer(value)
  ) {
    throw new TypeError(`${label} must be exactly ${byteLength} bytes`);
  }
  return new Uint8Array(value);
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayTagGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  Symbol.toStringTag,
)?.get;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)?.get;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "buffer",
)?.get;
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)?.get;

/**
 * Recognize the SDK's exact byte-view contract across browser/worker realms.
 * `instanceof` is realm-local and `Object#toString` honors a spoofable own
 * `Symbol.toStringTag`. Calling the shared `%TypedArray%` intrinsic getter
 * directly performs the unforgeable typed-array-kind check across realms.
 */
function isExactUint8Array(value: unknown): value is Uint8Array {
  return (
    ArrayBuffer.isView(value) &&
    typedArrayTagGetter?.call(value) === "Uint8Array"
  );
}

/** Shared backing can change concurrently and cannot yield one coherent hash. */
function hasOrdinaryArrayBuffer(value: Uint8Array): boolean {
  try {
    const buffer = typedArrayBufferGetter?.call(value);
    return (
      buffer !== undefined &&
      typeof arrayBufferByteLengthGetter?.call(buffer) === "number"
    );
  } catch {
    // `%ArrayBuffer%.byteLength` rejects SharedArrayBuffer and foreign brands.
    return false;
  }
}

/**
 * Detach a nullable Solana `OptionOrNullable<ReadonlyUint8Array>` while
 * preserving its public representation. Both the convenient nullable form and
 * Kit's explicit `Some`/`None` objects are accepted by generated encoders.
 */
export function snapshotOptionalFixedBytes<T>(
  value: T,
  byteLength: number,
  label: string,
): T {
  if (value === undefined || value === null) return value;
  if (isExactUint8Array(value)) {
    return snapshotFixedBytes(value, byteLength, label) as T;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${label} must be exactly ${byteLength} bytes or None`);
  }

  const option = value as {
    readonly __option?: unknown;
    readonly value?: unknown;
  };
  const tag = option.__option;
  if (tag === "None") {
    return Object.freeze({ __option: "None" }) as T;
  }
  if (tag === "Some") {
    const bytes = snapshotFixedBytes(option.value, byteLength, label);
    return Object.freeze({ __option: "Some", value: bytes }) as T;
  }
  throw new TypeError(`${label} must be exactly ${byteLength} bytes or None`);
}

/**
 * Copy and freeze one caller-owned record. Callers with nested mutable values
 * must replace those values with their own snapshots before enqueueing.
 */
export function snapshotRecord<T extends object>(value: T): T {
  return Object.freeze({ ...value }) as T;
}

/** Copy a caller-owned account collection and every known-flat entry. */
export function snapshotRecordArray<T extends object>(
  value: readonly T[],
): readonly T[] {
  return Object.freeze(value.map((entry) => snapshotRecord(entry)));
}

/**
 * Stabilize the fee-payer signer and the exact optional instruction override at
 * the synchronous hook boundary. An override for the fee-payer's canonical
 * address resolves to the fee-payer object because Solana Kit rejects distinct
 * signer implementations for one address. A different-address override keeps
 * its own identity after the SDK guard permanently locks its address. Other
 * stateful wallet/session fields remain usable.
 */
export function stabilizeSelectedTransactionSigner(
  clientSigner: TransactionSigner,
  override?: TransactionSigner,
): TransactionSigner {
  const stableClientSigner = stabilizeTransactionSigner(clientSigner);
  if (
    override === undefined ||
    override === stableClientSigner ||
    override.address === stableClientSigner.address
  ) {
    return stableClientSigner;
  }
  const stableOverride = stabilizeTransactionSigner(override);
  return stableOverride.address === stableClientSigner.address
    ? stableClientSigner
    : stableOverride;
}

export function withoutReferrerArgs<T extends object>(
  input: T,
): Omit<T, "referrer" | "referrerFeeBps"> {
  const {
    referrer: _referrer,
    referrerFeeBps: _referrerFeeBps,
    ...rest
  } = input as T & { referrer?: unknown; referrerFeeBps?: unknown };
  return rest;
}
