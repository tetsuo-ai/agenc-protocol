// Return actual SVM instructions, logs and before/after balances in the
// production JSON-RPC shape. The production reader must interpret them.
import { getBase58Decoder, getCompiledTransactionMessageDecoder, type Address } from "@solana/kit";
import type { Transport } from "@tetsuo-ai/marketplace-sdk";
import type { Chain } from "../src/chain.js";
import { readReviewHistory } from "../src/review-history.js";
import type { SettlementHistoryRpc } from "../src/settlement.js";

export function reviewRpc() {
  let legacy = false;
  let local: Chain | undefined;
  const rows = new Map<string, { accounts: readonly Address[]; tx: unknown }>();
  const rpc: SettlementHistoryRpc = {
    getSignaturesForAddress: (address, { limit, before }) => ({ send: async () => {
      const keys = [...rows].reverse().filter(([, row]) => row.accounts.includes(address)).map(([signature]) => signature);
      const start = before === undefined ? 0 : keys.indexOf(before) + 1;
      return keys.slice(start, start + limit).map(signature => ({ signature, err: null }));
    } }),
    getTransaction: signature => ({ send: async () => {
      const tx = rows.get(signature)?.tx as { meta: { logMessages: string[] } } | undefined;
      return tx && legacy ? { ...tx, meta: { ...tx.meta, logMessages: tx.meta.logMessages.filter(line => !line.startsWith("Program log: Revision deadline ")) } } : tx ?? null;
    } }),
  };
  return {
    useLegacyReceipts() { legacy = true; },
    chain(base: Chain): Chain {
      local = base;
      return { ...base, reviewHistory: (task, claim, before) => readReviewHistory(rpc, task, claim, undefined, before) };
    },
    transport(base: Transport): Transport {
      return { ...base, async sendAndConfirm(signed) {
        const message = getCompiledTransactionMessageDecoder().decode(signed.messageBytes);
        const accounts = message.staticAccounts;
        const preBalances = await local?.getBalances(accounts);
        const result = await base.sendAndConfirm(signed);
        const postBalances = await local?.getBalances(accounts);
        const instructions = ("instructions" in message ? message.instructions : []).map(ix => ({
          programId: accounts[ix.programAddressIndex], accounts: (ix.accountIndices ?? []).map(index => accounts[index]),
          data: getBase58Decoder().decode(ix.data ?? new Uint8Array()),
        }));
        rows.set(result.signature, { accounts, tx: {
          transaction: { signatures: [result.signature], message: { accountKeys: accounts.map(pubkey => ({ pubkey })), instructions } },
          meta: { err: null, logMessages: result.logs, fee: 5000n * BigInt(Object.keys(signed.signatures).length), preBalances, postBalances },
        } });
        return result;
      } };
    },
  };
}
