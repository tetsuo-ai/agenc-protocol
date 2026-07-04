/**
 * Every successful settlement has a shareable, independently verifiable
 * receipt page (the 4-way split itemized, each leg linking to the on-chain
 * transaction). Build its canonical URL from the settlement transaction
 * signature. The hosted surface renders accept_task_result /
 * auto_accept_task_result / complete_task / complete_task_private
 * settlements; pass `baseUrl` to point at another node's receipt surface.
 */
const DEFAULT_RECEIPT_BASE_URL = "https://agenc.ag/receipt";

export function settlementReceiptUrl(
  txSignature: string,
  baseUrl: string = DEFAULT_RECEIPT_BASE_URL,
): string {
  const signature = txSignature.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,120}$/u.test(signature)) {
    throw new Error(
      "settlementReceiptUrl requires a base58 transaction signature",
    );
  }
  return `${baseUrl.replace(/\/+$/u, "")}/${signature}`;
}
