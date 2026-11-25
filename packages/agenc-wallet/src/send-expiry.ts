// Proof that a signed transaction this wallet saved never landed and never can.
// Settling a payment as failed releases its payer and its allowance, so a wrong
// "it expired" is a possible second payment. A signature that is merely missing
// is not enough: a lagging node has not seen it yet, and a node without history
// has forgotten it. Every read below is therefore finalized, taken at or after
// one finalized slot whose height is already past the transaction's last valid
// height, and the payer's own history must reach back to before the
// transaction could first land without naming its signature.
import {
  getCompiledTransactionMessageDecoder, getSignatureFromTransaction, getTransactionDecoder,
  type Blockhash, type GetBlockApi, type GetEpochInfoApi, type GetSignatureStatusesApi,
  type GetSignaturesForAddressApi, type IsBlockhashValidApi, type Rpc, type Signature,
} from "@solana/kit";
import type { PendingListingSend } from "./transport-scope.js";

type ExpiryRpc = Rpc<GetEpochInfoApi & IsBlockhashValidApi & GetSignatureStatusesApi & GetSignaturesForAddressApi & GetBlockApi>;

/** Produced blocks a recent blockhash stays valid for (the network's MAX_PROCESSING_AGE). */
const BLOCKHASH_LIFETIME_BLOCKS = 150n;
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const HISTORY_PAGE = 25;
const HISTORY_PAGES = 40;

/**
 * True only when all of this holds on finalized state:
 *  - the receipt carries the signed bytes, they match its signature, and they
 *    use a recent blockhash (a durable nonce never expires);
 *  - the finalized block height is past the transaction's last valid height;
 *  - at that slot or later the blockhash is no longer valid, the signature has
 *    no status in the node's whole history, and the fee payer's history, read
 *    newest first, reaches a block at or before the one the blockhash came
 *    from without containing the signature.
 * False means "not proven", never "landed". Errors are the caller's "not proven".
 */
export async function provenNeverLanded(rpc: ExpiryRpc, receipt: PendingListingSend): Promise<boolean> {
  if (!receipt.signedTransaction) return false;
  const tx = getTransactionDecoder().decode(Buffer.from(receipt.signedTransaction, "base64"));
  if (getSignatureFromTransaction(tx) !== receipt.signature) return false;
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const payer = message.staticAccounts[0];
  if (!payer) return false;
  // A message layout this check does not know proves nothing.
  if (!("instructions" in message)) return false;
  const first = message.instructions[0];
  // SystemInstruction::AdvanceNonceAccount (4) first makes the lifetime a nonce.
  if (first && message.staticAccounts[first.programAddressIndex] === SYSTEM_PROGRAM && first.data?.length === 4 &&
      new DataView(first.data.buffer, first.data.byteOffset, 4).getUint32(0, true) === 4) return false;
  const lastValid = BigInt(receipt.lastValidBlockHeight);
  const signature = receipt.signature as Signature;

  const tip = await rpc.getEpochInfo({ commitment: "finalized" }).send();
  if (BigInt(tip.blockHeight) <= lastValid) return false;
  const at = { commitment: "finalized", minContextSlot: BigInt(tip.absoluteSlot) } as const;
  if ((await rpc.isBlockhashValid(message.lifetimeToken as Blockhash, at).send()).value !== false) return false;
  const status = (await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send()).value[0];
  if (status != null) return false;

  let before: Signature | undefined;
  for (let page = 0; page < HISTORY_PAGES; page += 1) {
    const rows = await rpc.getSignaturesForAddress(payer, { ...at, limit: HISTORY_PAGE, ...(before && { before }) }).send();
    if (rows.some(row => row.signature === signature)) return false;
    const oldest = rows.at(-1);
    // The history ends before it reaches the time of signing: it proves nothing.
    if (!oldest) return false;
    const block = await rpc.getBlock(BigInt(oldest.slot), {
      commitment: "finalized", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0,
    }).send();
    if (!block) return false;
    // A transaction lands only after the block its blockhash names.
    if (BigInt(block.blockHeight) + BLOCKHASH_LIFETIME_BLOCKS <= lastValid) return true;
    if (rows.length < HISTORY_PAGE) return false;
    before = oldest.signature;
  }
  return false;
}
