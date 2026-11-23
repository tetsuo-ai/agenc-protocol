// Solana decides when a hash expires. Shortening lastValidBlockHeight locally
// would only stop confirmation polling; the signed transaction could still land.
import type { GetBlockApi, GetBlocksApi, GetLatestBlockhashApi, Rpc } from "@solana/kit";
import { WalletError } from "./errors.js";

export async function reviewBlockhash(rpc: Rpc<GetBlockApi & GetBlocksApi & GetLatestBlockhashApi>) {
  const { context, value } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const options = { commitment: "confirmed", transactionDetails: "none", rewards: false } as const;
  const [tip, slots] = await Promise.all([
    rpc.getBlock(context.slot, options).send(),
    rpc.getBlocks(context.slot > 320n ? context.slot - 320n : 0n, context.slot, { commitment: "confirmed" }).send(),
  ]);
  const unavailable = () => new WalletError("NETWORK", "A short-lived review transaction could not be prepared. Reopen the delivery and try again.");
  if (!tip || tip.blockhash !== value.blockhash || slots.at(-1) !== context.slot) throw unavailable();
  // Count produced blocks, not slots. Skipped slots do not age a blockhash.
  const lifetime = value.lastValidBlockHeight - tip.blockHeight;
  const age = lifetime - 16n;
  if (age < 0n || age >= BigInt(slots.length)) throw unavailable();
  const block = await rpc.getBlock(slots[slots.length - 1 - Number(age)]!, options).send();
  if (!block || tip.blockHeight - block.blockHeight !== age) throw unavailable();
  return { blockhash: block.blockhash, lastValidBlockHeight: block.blockHeight + lifetime };
}
