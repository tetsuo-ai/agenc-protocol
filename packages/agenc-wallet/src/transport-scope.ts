import { AsyncLocalStorage } from "node:async_hooks";
import { getSignatureFromTransaction, type RpcTransport } from "@solana/kit";
import type { Transport } from "@tetsuo-ai/marketplace-sdk";

export const LISTING_TRANSPORT_TIMEOUT_MS = 30_000;

export interface AllowanceCharge {
  ts: number;
  lamports: string;
  usdCents?: number | null;
  id?: string;
  signature?: string;
  work?: { lastValidBlockHeight: string; fee: string; rate: number };
}

export type ListingOperation =
  | { kind: "funding"; lamports: string; text: string; charge?: AllowanceCharge; mainBalance: string; priorObservation: string | null }
  | { kind: "create"; listing: string; name: string; lamports: string }
  | { kind: "state"; state: "Active" | "Paused" | "Retired"; listings: readonly string[]; lamports: string }
  | { kind: "update" | "approval"; listings: readonly string[]; lamports: string };

export type ListingSendOutcome = "landed" | "failed" | "pending";

/** Written before dispatch; an interrupted send is unresolved until chain reconciliation. */
export interface PendingListingSend {
  signature: string;
  lastValidBlockHeight: string;
  /** Absent on receipts written before operation bookkeeping. */
  operation?: ListingOperation;
}

interface TransportScope {
  signal: AbortSignal;
  timeoutMs?: number;
  operation?: ListingOperation;
  startConfirmation?: () => void;
  sending: (receipt: PendingListingSend) => void;
  confirmed: (signature: string, operation?: ListingOperation) => void;
}

// Listing work also calls funding, revision checks and marketplace services.
// Carry its cancellation through those shared helpers without cancelling
// unrelated worker or owner requests using the same chain instance.
const scope = new AsyncLocalStorage<TransportScope>();
export function inTransportScope<T>(context: TransportScope, work: () => Promise<T>): Promise<T> {
  return scope.run(context, work);
}
export async function withListingOperation(operation: ListingOperation, send: () => Promise<string>): Promise<string> {
  const context = scope.getStore();
  if (!context) return send();
  const signature = await scope.run({ ...context, operation }, send);
  context.confirmed(signature, operation);
  return signature;
}

export function listingTimeoutMs(): number | undefined {
  const context = scope.getStore();
  return context && (context.timeoutMs ?? LISTING_TRANSPORT_TIMEOUT_MS);
}

export function transportSignal(): AbortSignal | undefined {
  return scope.getStore()?.signal;
}

/** Only transport waits belong here, never wallet/store mutation continuations. */
export function abortableTransport<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  if (signal === undefined) return work();
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return work();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Bound one transport call. Its late continuations inherit the aborted signal. */
export async function listingRequest<T>(work: () => Promise<T>, signed = false): Promise<T> {
  const context = scope.getStore();
  if (!context) return work();
  context.signal.throwIfAborted();
  const deadline = new AbortController();
  const signal = AbortSignal.any([context.signal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(new DOMException("Listing transport timed out", "TimeoutError")),
    context.timeoutMs ?? LISTING_TRANSPORT_TIMEOUT_MS);
  try {
    return await scope.run({
      ...context, signal, ...(signed ? { startConfirmation: () => timer.refresh() } : {}),
    }, () => abortableTransport(signal, work));
  } finally {
    clearTimeout(timer);
  }
}

// First-party adapters bound each underlying RPC or HTTP request themselves.
// An injected adapter may only expose a single opaque transport wait.
const requestAwareMethods = new WeakSet<object>();

export function usesScopedRequests<T extends object>(adapter: T): T {
  for (const value of Object.values(adapter)) {
    if (typeof value === "function") requestAwareMethods.add(value);
  }
  return adapter;
}

export function scopeAdapterRequests<T extends object>(adapter: T, methods: readonly (keyof T)[]): T {
  const requests = new Set<PropertyKey>(methods);
  return new Proxy({} as T, {
    get(_target, property) {
      const value: unknown = Reflect.get(adapter, property, adapter);
      if (typeof value !== "function") return value;
      if (!requests.has(property) || requestAwareMethods.has(value)) return value.bind(adapter);
      return (...args: unknown[]) => listingRequest(() => value.apply(adapter, args));
    },
  });
}

/** Forward cancellation all the way to Kit's HTTP fetch, including queued RPCs. */
export function scopedRpcTransport(base: RpcTransport): RpcTransport {
  return ((config: Parameters<RpcTransport>[0]) => listingRequest(async () => {
    const parent = transportSignal();
    const signal = parent === undefined ? config.signal
      : config.signal === undefined ? parent : AbortSignal.any([parent, config.signal]);
    const response = await abortableTransport(signal, () => base({ ...config, ...(signal === undefined ? {} : { signal }) }));
    // The SDK polls for confirmation after this RPC. Give that wait its own budget.
    if ((config.payload as { method?: string }).method === "sendTransaction") scope.getStore()?.startConfirmation?.();
    return response;
  })) as RpcTransport;
}

/**
 * The signed transport has no local store writes. Cancelling its wait is safe:
 * all later RPC continuations inherit the aborted scope and cannot dispatch.
 * A broadcast already accepted by the cluster remains in the journal.
 */
export function scopedSendTransport(base: Transport): Transport {
  return {
    ...base,
    getLatestBlockhash: () => listingRequest(() => base.getLatestBlockhash()),
    ...(base.getSignatureStatus && {
      getSignatureStatus: (signature: string) => listingRequest(() => base.getSignatureStatus!(signature)),
    }),
    ...(base.resolveAddressLookupTables && {
      resolveAddressLookupTables: (addresses: Parameters<NonNullable<Transport["resolveAddressLookupTables"]>>[0]) =>
        listingRequest(() => base.resolveAddressLookupTables!(addresses)),
    }),
    async sendAndConfirm(transaction) {
      const context = scope.getStore();
      if (context === undefined) return base.sendAndConfirm(transaction);
      context.signal.throwIfAborted();
      const signature = getSignatureFromTransaction(transaction);
      context.sending({
        signature,
        lastValidBlockHeight: transaction.lifetimeConstraint.lastValidBlockHeight.toString(),
        ...(context.operation && { operation: context.operation }),
      });
      const result = await listingRequest(() => base.sendAndConfirm(transaction), true);
      if (result.signature !== signature) throw new Error("Transport returned a different transaction signature");
      if (!context.operation) context.confirmed(signature);
      return result;
    },
  };
}
