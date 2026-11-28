import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getBase64EncodedWireTransaction, getSignatureFromTransaction, type Address, type Blockhash } from "@solana/kit";
import { AgencError, findClaimPda, type SendOptions, type SignedTransaction } from "@tetsuo-ai/marketplace-sdk";
import { syncDir } from "./claim-admission.js";
import type { WorkerContext } from "./runtime.js";

interface SignedRecord {
  signature: string;
  signedTransaction?: string;
  messageBytes?: string;
  signatures?: Record<string, string | null>;
  blockhash?: string;
  lastValidBlockHeight?: string;
  /** True once the bytes passed the send-boundary guard and went to the transport. */
  dispatched?: boolean;
}

/** A signed attempt survives worker restores. Reconciliation only reads the chain. */
export async function sendClaimOperation(
  ctx: WorkerContext, worker: Address, task: Address, operation: "release" | "reclaim" | "expire" | `submit-${number}`,
  intent: string, send: (options: SendOptions) => Promise<{ signature: string }>,
  check?: () => void, previousSignature?: string,
): Promise<string> {
  const [claim] = await findClaimPda({ task, bidder: worker });
  const root = ctx.modelSpendDir ?? ctx.stateDir;
  const dir = join(root, ctx.signer.address + "-" + claim);
  const marker = join(dir, operation);
  const signed = marker + ".signed";
  const write = (file: string, data: string) => {
    writeFileSync(file, data, { flag: "wx", mode: 0o600, flush: true });
    syncDir(dir);
  };
  if (existsSync(marker) || previousSignature) {
    if (existsSync(marker) && readFileSync(marker, "utf8") !== intent)
      throw new Error("This claim has a different signed operation.");
    const record: SignedRecord | undefined = existsSync(signed) ? JSON.parse(readFileSync(signed, "utf8")) : undefined;
    const signature = record?.signature ?? previousSignature;
    const transport = ctx.client.transport;
    const status = signature ? await transport?.getSignatureStatus?.(signature) : undefined;
    if (signature && status?.err === null && (status.confirmationStatus === "finalized" ||
        (status.confirmationStatus === "confirmed" && transport.confirmationCommitment !== "finalized"))) return signature;
    const lifetime = ctx.operationLifetime;
    const forget = () => {
      rmSync(signed, { force: true });
      rmSync(marker, { force: true });
      if (existsSync(dir)) syncDir(dir);
    };
    if (record?.messageBytes && record.signatures && record.blockhash && record.lastValidBlockHeight && lifetime) {
      // The bytes never reached the network: nothing can land, so one fresh signature is safe.
      if (record.dispatched !== true) forget();
      // The saved bytes are still valid: send those same bytes again under the same check.
      else if (await lifetime.blockhashValid(record.blockhash).catch(() => true)) {
        const resend: SignedTransaction = {
          messageBytes: Buffer.from(record.messageBytes, "base64"),
          signatures: Object.fromEntries(Object.entries(record.signatures).map(([a, b]) => [a, b === null ? null : Buffer.from(b, "base64")])),
          lifetimeConstraint: { blockhash: record.blockhash as Blockhash, lastValidBlockHeight: BigInt(record.lastValidBlockHeight) },
        } as unknown as SignedTransaction;
        const guard = () => check?.();
        guard();
        return (await transport.sendAndConfirm(resend, guard)).signature;
      }
      // The blockhash expired: only proof that it never landed permits another signature.
      else if (record.signedTransaction && await lifetime.neverLanded({ signature: record.signature, signedTransaction: record.signedTransaction,
          lastValidBlockHeight: record.lastValidBlockHeight }).catch(() => false)) forget();
      else throw new Error("The previous signature requires chain confirmation.");
    }
    // A 0.1.16 submission kept only a signature. Absent from the chain, it was re-signed then, and it is once more.
    else if (!record && !existsSync(marker) && previousSignature && status === null) { /* sign afresh below */ }
    else throw new Error("The previous signature requires chain confirmation.");
  }
  const markDispatched = () => {
    if (!existsSync(signed)) return;
    const record = JSON.parse(readFileSync(signed, "utf8")) as SignedRecord;
    if (record.dispatched === true) return;
    writeFileSync(signed, JSON.stringify({ ...record, dispatched: true }), { mode: 0o600, flush: true });
    syncDir(dir);
  };
  let reserved = false;
  function reserve() {
    if (reserved) return;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    syncDir(root);
    write(marker, intent);
    reserved = true;
  }
  try {
    const result = await send({
      maxRetries: 0,
      assertAuthorized(boundary) {
        check?.();
        if (boundary === "sign") reserve();
        // Only now can the bytes reach the network; before this they were withheld.
        if (boundary === "send") markDispatched();
      },
      onSigned(transaction) {
        reserve();
        write(signed, JSON.stringify({
          signature: getSignatureFromTransaction(transaction),
          signedTransaction: getBase64EncodedWireTransaction(transaction),
          messageBytes: Buffer.from(transaction.messageBytes).toString("base64"),
          signatures: Object.fromEntries(Object.entries(transaction.signatures).map(([a, b]) => [a, b === null ? null : Buffer.from(b).toString("base64")])),
          blockhash: transaction.lifetimeConstraint.blockhash,
          lastValidBlockHeight: String(transaction.lifetimeConstraint.lastValidBlockHeight),
          dispatched: false,
        } satisfies SignedRecord));
      },
    });
    return result.signature;
  } catch (error) {
    // Older client adapters can supply just the signature of an ambiguous send.
    if (error instanceof AgencError && error.signature && !existsSync(signed)) {
      reserve();
      write(signed, JSON.stringify({ signature: error.signature }));
    }
    throw error;
  }
}
