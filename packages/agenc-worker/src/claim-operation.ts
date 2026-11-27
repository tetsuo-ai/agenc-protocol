import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getBase64EncodedWireTransaction, getSignatureFromTransaction, type Address } from "@solana/kit";
import { AgencError, findClaimPda, type SendOptions } from "@tetsuo-ai/marketplace-sdk";
import { syncDir } from "./claim-admission.js";
import type { WorkerContext } from "./runtime.js";

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
    const signature = existsSync(signed) ? JSON.parse(readFileSync(signed, "utf8")).signature : previousSignature;
    const transport = ctx.client.transport;
    const status = signature && await transport?.getSignatureStatus?.(signature);
    if (status?.err === null && (status.confirmationStatus === "finalized" ||
        (status.confirmationStatus === "confirmed" && transport.confirmationCommitment !== "finalized"))) return signature;
    throw new Error("The previous signature requires chain confirmation.");
  }
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
      },
      onSigned(transaction) {
        reserve();
        write(signed, JSON.stringify({
          signature: getSignatureFromTransaction(transaction),
          signedTransaction: getBase64EncodedWireTransaction(transaction),
          blockhash: transaction.lifetimeConstraint.blockhash,
          lastValidBlockHeight: String(transaction.lifetimeConstraint.lastValidBlockHeight),
        }));
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
