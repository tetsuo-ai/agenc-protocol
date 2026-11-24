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

export async function reconcileOperation(chain: Chain, store: StateStore, id: string) {
  const saved = store.state.moneyOperations?.[id];
  if (!saved) return saved;
  if (saved.network && saved.network !== chain.network)
    throw new WalletError("NOT_ALLOWED", "This receipt belongs to a different network.");
  const outcome = saved.state === "pending" ? await chain.reviewSendOutcome?.(saved.receipt) : null;
  // A missing or pruned signature, even after expiry, is not proof of failure.
  if (outcome === "landed" || outcome === "failed")
    settleOperation(store, id, outcome === "landed" ? "confirmed" : "failed");
  const current = store.state.moneyOperations?.[id]!;
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
  return store.state.moneyOperations?.[id]!;
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
  const prior = await reconcileOperation(chain, store, id);
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
    return (await reconcileOperation(chain, store, id))!;
  }

  if (!recordsSignedOperations(transport))
    throw new WalletError("NOT_AVAILABLE", "This transport cannot save a signed receipt before payment.");
  function record(tx: SignedTransaction) {
      const signature = getSignatureFromTransaction(tx);
      store.update(draft => {
        options.checkExpiry?.();
        if (store.state.moneyOperations?.[id]) throw new WalletError("NOT_ALLOWED", "This operation is already signed.");
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
    if (store.state.moneyOperations?.[id]?.receipt.signature !== result.signature) throw new WalletError("NETWORK", "The signature did not match.");
    settleOperation(store, id, "confirmed");
  } catch (error) {
    if (!store.state.moneyOperations?.[id]) {
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
      await reconcileOperation(chain, store, id).catch(() => undefined);
    }
  }
  return store.state.moneyOperations?.[id]!;
}

declare module "./store.js" {
  interface WalletState {
    ratingQuotes?: Record<string, RatingQuote>;
    requestedRatings?: Record<string, { quoteId: string; message?: string }>;
  }
}
