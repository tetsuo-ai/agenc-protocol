import { AsyncLocalStorage } from "node:async_hooks";
import type { Transport, SignedTransaction } from "@tetsuo-ai/marketplace-sdk";

// Keep the original SDK client, revision gate and priority-fee configuration.
// The recorder runs synchronously at the final signed transport boundary.
export const signedOperation = new AsyncLocalStorage<(tx: SignedTransaction) => void>();
const recordedTransports = new WeakSet<Transport>();
export const recordsSignedOperations = (transport: Transport) => recordedTransports.has(transport);

export function operationTransport(transport: Transport): Transport {
  const wrapped: Transport = { ...transport, sendAndConfirm: (tx, beforeSend) => {
    beforeSend?.();
    signedOperation.getStore()?.(tx);
    return transport.sendAndConfirm(tx, beforeSend);
  } };
  recordedTransports.add(wrapped);
  return wrapped;
}
