import { AsyncLocalStorage } from "node:async_hooks";
import { getSignatureFromTransaction, type RpcTransport } from "@solana/kit";
import type { Transport } from "@tetsuo-ai/marketplace-sdk";

export const LISTING_TRANSPORT_TIMEOUT_MS = 30_000;

/** Written before dispatch; an interrupted send is unresolved until chain reconciliation. */
export interface PendingListingSend {
  signature: string;
  lastValidBlockHeight: string;
}

interface TransportScope {
  signal: AbortSignal;
  sending: (receipt: PendingListingSend) => void;
  confirmed: (signature: string) => void;
}

// Listing work also calls funding, revision checks and marketplace services.
// Carry its cancellation through those shared helpers without cancelling
// unrelated worker or owner requests using the same chain instance.
const scope = new AsyncLocalStorage<TransportScope>();
export function inTransportScope<T>(context: TransportScope, work: () => Promise<T>): Promise<T> {
  return scope.run(context, work);
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

/** Forward cancellation all the way to Kit's HTTP fetch, including queued RPCs. */
export function scopedRpcTransport(base: RpcTransport): RpcTransport {
  return (async (config: Parameters<RpcTransport>[0]) => {
    const parent = transportSignal();
    const signal = parent === undefined ? config.signal
      : config.signal === undefined ? parent : AbortSignal.any([parent, config.signal]);
    return abortableTransport(signal, () => base({ ...config, ...(signal === undefined ? {} : { signal }) }));
  }) as RpcTransport;
}

/**
 * The signed transport has no local store writes. Cancelling its wait is safe:
 * all later RPC continuations inherit the aborted scope and cannot dispatch.
 * A broadcast already accepted by the cluster remains in the journal.
 */
export function scopedSendTransport(base: Transport): Transport {
  return {
    ...base,
    getLatestBlockhash: () => abortableTransport(transportSignal(), () => base.getLatestBlockhash()),
    async sendAndConfirm(transaction) {
      const context = scope.getStore();
      if (context === undefined) return base.sendAndConfirm(transaction);
      context.signal.throwIfAborted();
      const signature = getSignatureFromTransaction(transaction);
      context.sending({ signature, lastValidBlockHeight: transaction.lifetimeConstraint.lastValidBlockHeight.toString() });
      const result = await abortableTransport(context.signal, () => base.sendAndConfirm(transaction));
      context.confirmed(signature);
      return result;
    },
  };
}
