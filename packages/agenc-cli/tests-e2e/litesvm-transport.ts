// A Transport backed by litesvm: the SAME client pipeline that talks to a kit
// RPC in production runs here against the real compiled program, in-process.
// Mirrors packages/agenc-worker/tests-e2e/litesvm-transport.ts.
import { FailedTransactionMetadata, type LiteSVM } from "litesvm";
import { getBase58Decoder } from "@solana/kit";
import type { Transport } from "@tetsuo-ai/marketplace-sdk";

export function createLiteSvmTransport(svm: LiteSVM): Transport {
  return {
    async getLatestBlockhash() {
      return {
        blockhash: svm.latestBlockhash(),
        lastValidBlockHeight: 0xffff_ffff_ffff_ffffn,
      };
    },
    async sendAndConfirm(signedTx) {
      const result = svm.sendTransaction(signedTx);
      if (result instanceof FailedTransactionMetadata) {
        const logs = result.meta().logs();
        const error = new Error(
          `Transaction failed: ${result.err()}` +
            (logs.length > 0 ? `\n${logs.join("\n")}` : ""),
        ) as Error & { logs: readonly string[] };
        error.logs = logs;
        throw error;
      }
      return {
        signature: getBase58Decoder().decode(result.signature()),
        logs: result.logs(),
      };
    },
  };
}
