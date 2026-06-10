// A Transport backed by litesvm: the SAME client pipeline that talks to a kit
// RPC in production runs here against the real compiled program, in-process.
// litesvm is synchronous and final, so "confirm" is simply the send result.
import { FailedTransactionMetadata, type LiteSVM } from "litesvm";
import { getBase58Decoder } from "@solana/kit";
import type { Transport } from "../src/client/index.js";

/**
 * Build a {@link Transport} over a litesvm VM.
 *
 * - `getLatestBlockhash` returns litesvm's current blockhash with a synthetic
 *   `lastValidBlockHeight` (litesvm does not model block-height expiry).
 * - `sendAndConfirm` executes the signed transaction; on failure it throws an
 *   Error whose message embeds litesvm's `err()` text (which carries
 *   `custom program error: 0x…` fragments for program errors) and whose
 *   `logs` property carries the program logs — exactly the shapes the
 *   client's AgencError hydration consumes.
 */
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
