// Return actual SVM instructions, logs and before/after balances in the
// production JSON-RPC shape. The production reader must interpret them.
import { getBase58Decoder, getCompiledTransactionMessageDecoder, type Address } from "@solana/kit";
import { lighthouse, TASK_RESULT_ACCEPTED_EVENT_DISCRIMINATOR, type Transport } from "@tetsuo-ai/marketplace-sdk";
import type { Chain } from "../src/chain.js";
import { readReviewHistory, type ReviewAnchor } from "../src/review-history.js";
import type { SettlementHistoryRpc } from "../src/settlement.js";

export function reviewRpc(withCache = false) {
  const cache = withCache ? new Map<string, readonly ReviewAnchor[]>() : undefined;
  let hideAcceptance = false;
  let legacy = false;
  let hideDeliveries = false;
  let guardView: "original" | "legacy" | "wrongTarget" = "original";
  let local: Chain | undefined;
  const rows = new Map<string, { accounts: readonly Address[]; tx: unknown }>();
  const rpc: SettlementHistoryRpc = {
    getSignaturesForAddress: (address, { limit, before }) => ({ send: async () => {
      const keys = [...rows].reverse().filter(([, row]) => row.accounts.includes(address)).map(([signature]) => signature);
      const start = before === undefined ? 0 : keys.indexOf(before) + 1;
      return keys.slice(start, start + limit).map(signature => ({ signature, err: null }));
    } }),
    getTransaction: signature => ({ send: async () => {
      let tx = rows.get(signature)?.tx as {
        meta: { logMessages: string[] };
        transaction: { message: { instructions: { programId: string; accounts?: string[] }[] } };
      } | undefined;
      if (tx && guardView !== "original") {
        const { transaction } = tx;
        const { message } = transaction;
        const instructions = guardView === "legacy" ? message.instructions.filter(ix => ix.programId !== lighthouse.LIGHTHOUSE)
          : message.instructions.map(ix => ix.programId === lighthouse.LIGHTHOUSE ? { ...ix, accounts: [lighthouse.RENT] } : ix);
        tx = { ...tx, transaction: { ...transaction, message: { ...message, instructions } } };
      }
      if (hideAcceptance && tx) {
        return { ...tx, meta: { ...tx.meta, logMessages: tx.meta.logMessages.filter(line =>
          !line.startsWith("Program data: ") || !Buffer.from(line.slice("Program data: ".length), "base64").subarray(0, 8).equals(Buffer.from(TASK_RESULT_ACCEPTED_EVENT_DISCRIMINATOR))) } };
      }
      if (hideDeliveries && tx?.meta.logMessages.includes("Program log: Instruction: SubmitTaskResult")) return null;
      return tx && legacy ? { ...tx, meta: { ...tx.meta, logMessages: tx.meta.logMessages.filter(line => !line.startsWith("Program log: Revision deadline ")) } } : tx ?? null;
    } }),
  };
  return {
    rpc,
    hideAcceptance(hidden: boolean) { hideAcceptance = hidden; },
    pruneSubmissions(pruned = true) { hideDeliveries = pruned; },
    useLegacyReceipts() { legacy = true; },
    showGuards(view: typeof guardView) { guardView = view; },
    chain(base: Chain): Chain {
      local = base;
      return { ...base, reviewHistory: (task, claim, before) => readReviewHistory(rpc, task, claim, cache, before) };
    },
    transport(base: Transport): Transport {
      return { ...base, async sendAndConfirm(signed) {
        const message = getCompiledTransactionMessageDecoder().decode(signed.messageBytes);
        const accounts = message.staticAccounts;
        const preBalances = await local?.getBalances(accounts);
        const result = await base.sendAndConfirm(signed);
        const postBalances = await local?.getBalances(accounts);
        const instructions = ("instructions" in message ? message.instructions : []).map(ix => accounts[ix.programAddressIndex] === "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
          ? { programId: accounts[ix.programAddressIndex], program: "spl-memo", parsed: Buffer.from(ix.data ?? []).toString("utf8") }
          : {
          programId: accounts[ix.programAddressIndex], accounts: (ix.accountIndices ?? []).map(index => accounts[index]),
          data: getBase58Decoder().decode(ix.data ?? new Uint8Array()),
        });
        rows.set(result.signature, { accounts, tx: {
          transaction: { signatures: [result.signature], message: { accountKeys: accounts.map(pubkey => ({ pubkey })), instructions } },
          meta: { err: null, logMessages: result.logs, fee: 5000n * BigInt(Object.keys(signed.signatures).length), preBalances, postBalances },
        } });
        return result;
      } };
    },
  };
}
