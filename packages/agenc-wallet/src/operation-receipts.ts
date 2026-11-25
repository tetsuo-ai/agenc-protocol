import { signedOperation, recordsSignedOperations } from "./operation-transport.js";
import { createHash, randomUUID } from "node:crypto";
import { address, getBase64EncodedWireTransaction, getCompiledTransactionMessageDecoder, getSignatureFromTransaction, getTransactionDecoder, type Address, type Blockhash, type Instruction, type KeyPairSigner } from "@solana/kit";
import { AgencError, type SignedTransaction } from "@tetsuo-ai/marketplace-sdk";
import { type Chain } from "./chain.js";
import type { TransferRequest, TransferQuote, RatingQuote } from "./client/money-operations.js";
export type { TransferRequest, TransferQuote, RatingQuote } from "./client/money-operations.js";
import type { WalletState, StateStore } from "./store.js";
import type { PendingListingSend } from "./transport-scope.js";
import { microcents } from "./job-money.js";
import { WalletError } from "./errors.js";

export interface MoneyOperation {
  id: string; network?: string; fingerprint: string; payer: string; recipient: string; kind: string;
  state: "pending" | "confirmed" | "failed";
  allowance?: { agentId: string; usdPerSol: number };
  receipt: PendingListingSend; amount: string; fee: string; recorded?: boolean; jobId?: string;
}
export interface TransferReservation { quote: TransferQuote; request: TransferRequest }
export interface OperationState {
  purchaseBindings?: Record<string, string | { network: string; fingerprint: string }>;
  moneyOperations?: Record<string, MoneyOperation>;
  transferQuotes?: Record<string, TransferReservation>;
  legacyTransfers?: Record<string, string>;
}
declare module "./store.js" { interface WalletState extends OperationState {} }

export function operationFingerprint(fields: readonly unknown[]) {
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}
export const operationId = () => randomUUID();

function savedTransaction(op: MoneyOperation) {
  if (!op.receipt.signedTransaction) return null;
  const tx = getTransactionDecoder().decode(Buffer.from(op.receipt.signedTransaction, "base64"));
  if (getSignatureFromTransaction(tx) !== op.receipt.signature) throw new WalletError("INTERNAL", "The saved signature changed.");
  const blockhash = getCompiledTransactionMessageDecoder().decode(tx.messageBytes).lifetimeToken as Blockhash;
  return { ...tx, lifetimeConstraint: { blockhash, lastValidBlockHeight: BigInt(op.receipt.lastValidBlockHeight) } } as SignedTransaction;
}

export async function canRetryOperation(chain: Chain, op: MoneyOperation) {
  const tx = savedTransaction(op);
  return !!(tx && await chain.operationBlockhashValid?.(tx.lifetimeConstraint.blockhash).catch(() => false));
}

function settleOperation(store: StateStore, id: string, state: "confirmed" | "failed") {
  store.update(draft => {
    const row = draft.moneyOperations?.[id];
    if (row?.state === "pending") row.state = state;
  });
}

/**
 * Settle a signed operation as failed once the chain proves it can never land,
 * and give back what it held, as the pre-broadcast refusal does. Without the
 * proof (also when the network cannot be asked) it stays pending.
 */
async function releaseExpired(chain: Chain, store: StateStore, id: string, released?: OperationRelease) {
  const saved = store.operation(id);
  if (saved?.state !== "pending") return;
  if (await chain.sendNeverLands?.(saved.receipt).catch(() => false) !== true) return;
  store.update(draft => {
    const row = draft.moneyOperations?.[id];
    if (row?.state !== "pending" || row.receipt.signature !== saved.receipt.signature) return;
    row.state = "failed";
    if (row.allowance) {
      const agent = draft.agents[row.allowance.agentId];
      if (agent) agent.jobSpends = (agent.jobSpends ?? []).filter(spend => spend.id !== id);
      delete row.allowance;
    }
    released?.(draft, row);
  });
}

/** What else an operation reserved when it was signed, given back in the same write that fails it. */
export type OperationRelease = (draft: WalletState, operation: MoneyOperation) => void;

export async function reconcileOperation(chain: Chain, store: StateStore, id: string, released?: OperationRelease) {
  const saved = store.operation(id);
  if (!saved) return saved;
  if (saved.network && saved.network !== chain.network)
    throw new WalletError("NOT_ALLOWED", "This receipt belongs to a different network.");
  const outcome = saved.state === "pending" ? await chain.reviewSendOutcome?.(saved.receipt) : null;
  // A missing or pruned signature, even after expiry, is not proof of failure.
  if (outcome === "landed" || outcome === "failed")
    settleOperation(store, id, outcome === "landed" ? "confirmed" : "failed");
  // Only the chain's own proof that the signed bytes can never land is.
  else if (outcome === "expired") await releaseExpired(chain, store, id, released);
  const current = store.operation(id)!;
  if (current.state === "failed" && current.allowance) {
    const debit = await chain.accountChange?.(current.payer as Address, current.receipt.signature).catch(() => null);
    if (debit?.failed && debit.signature === current.receipt.signature && debit.account === current.payer) {
      const { agentId, usdPerSol } = current.allowance;
      store.update(draft => {
        const charge = draft.agents[agentId]?.jobSpends?.find(entry => entry.id === id);
        if (charge) charge.microcents = String(microcents(BigInt(debit.payerFee), usdPerSol));
        const updated = { ...current };
        delete updated.allowance;
        (draft.moneyOperations ??= {})[id] = updated;
      });
    }
  }
  return store.operation(id)!;
}

export async function sendOperation(options: {
  chain: Chain; store: StateStore; signer: KeyPairSigner; id: string; fingerprint: string;
  kind: string; recipient: Address; amount: bigint; instructions: Instruction[]; jobId?: string;
  allowance?: MoneyOperation["allowance"];
  checkExpiry?: () => void;
  refused?: (draft: WalletState, receipt: PendingListingSend) => void;
  reserve?: (draft: WalletState, receipt: PendingListingSend) => void;
}): Promise<MoneyOperation> {
  const { chain, store, signer, id, fingerprint } = options;
  const released: OperationRelease = (draft, row) => options.refused?.(draft, row.receipt);
  const prior = await reconcileOperation(chain, store, id, released);
  const client = chain.clientFor(signer);
  const transport = client.transport;
  if (prior) {
    if (prior.fingerprint !== fingerprint || prior.payer !== signer.address)
      throw new WalletError("BAD_REQUEST", "That operation approved different terms.");
    if (prior.state !== "pending") return prior;
    const signed = savedTransaction(prior);
    if (signed && await chain.operationBlockhashValid?.(signed.lifetimeConstraint.blockhash)) {
      const result = await transport.sendAndConfirm(signed).catch(() => null);
      if (result?.signature === prior.receipt.signature)
        settleOperation(store, id, "confirmed");
    }
    return (await reconcileOperation(chain, store, id, released))!;
  }

  if (!recordsSignedOperations(transport))
    throw new WalletError("NOT_AVAILABLE", "This transport cannot save a signed receipt before payment.");
  function record(tx: SignedTransaction) {
      const signature = getSignatureFromTransaction(tx);
      store.update(draft => {
        options.checkExpiry?.();
        if (store.operation(id)) throw new WalletError("NOT_ALLOWED", "This operation is already signed.");
        const receipt = { signature, lastValidBlockHeight: String(tx.lifetimeConstraint.lastValidBlockHeight),
          signedTransaction: getBase64EncodedWireTransaction(tx) };
        options.reserve?.(draft, receipt);
        (draft.moneyOperations ??= {})[id] = {
          id, network: chain.network, fingerprint, kind: options.kind, payer: signer.address, recipient: options.recipient,
          state: "pending", amount: String(options.amount), fee: String(chain.transferFeeLamports),
          ...(options.jobId && { jobId: options.jobId }),
          ...(options.allowance && { allowance: options.allowance }), receipt,
        };
      });
  }
  // Even two intentional identical sends in the same block have distinct signatures.
  const memo = { programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), data: Buffer.from("agenc.operation.v1 " + id) };
  try {
    const result = await signedOperation.run(record, () => client.send([...options.instructions, memo], { maxRetries: 0 }));
    if (store.operation(id)?.receipt.signature !== result.signature) throw new WalletError("NETWORK", "The signature did not match.");
    settleOperation(store, id, "confirmed");
  } catch (error) {
    if (!store.operation(id)) {
      if (error instanceof WalletError) throw error;
      const cause = (error as Error)?.cause;
      if (cause instanceof WalletError) throw cause;
      throw new WalletError("NETWORK", "The wallet could not confirm the operation.", { cause: error });
    }
    // With maxRetries zero the SDK attaches the local signature to every
    // ambiguous transport error. Only its proven pre-broadcast refusal is unsigned.
    if (error instanceof AgencError && error.signature === null) {
      store.update(draft => {
        const row = draft.moneyOperations![id]!;
        row.state = "failed";
        if (row.allowance) {
          const agent = draft.agents[row.allowance.agentId]!;
          agent.jobSpends = (agent.jobSpends ?? []).filter(spend => spend.id !== id);
          delete row.allowance;
        }
        options.refused?.(draft, row.receipt);
      });
    } else {
      await reconcileOperation(chain, store, id, released).catch(() => undefined);
    }
  }
  return store.operation(id)!;
}

declare module "./store.js" {
  interface WalletState {
    ratingQuotes?: Record<string, RatingQuote>;
    requestedRatings?: Record<string, { quoteId: string; message?: string }>;
  }
}
