import type { Address, GetSignaturesForAddressApi, GetTransactionApi, Rpc, Signature } from "@solana/kit";
import type { Chain } from "./chain.js";
import type { StateStore, WalletState } from "./store.js";

import type { AccountChange, HistoryRow } from "./client/money-operations.js";
export type { AccountChange, HistoryRow } from "./client/money-operations.js";
interface Cursor { head?: string; before?: string; target?: string; gap?: string; missingCheckpoint?: string }
declare module "./store.js" {
  interface WalletState { moneyCursors?: Record<string, Cursor>; moneyRows?: Record<string, HistoryRow> }
}
export interface ChangePage { rows: AccountChange[]; end: boolean; gap?: string }

export async function readChangePage(rpc: Rpc<GetTransactionApi & GetSignaturesForAddressApi>, account: Address, before?: string, until?: string): Promise<ChangePage> {
  const list = await rpc.getSignaturesForAddress(account, { limit: 12, ...(before && { before: before as Signature }),
    commitment: "confirmed" }).send();
  const rows: AccountChange[] = [];
  for (const sig of list) {
    if (sig.signature === until) return { rows, end: true };
    const change = await readAccountChange(rpc, account, sig.signature);
    if (!change) return { rows, end: false, gap: `Receipt ${sig.signature} is unavailable.` };
    rows.push(change);
  }
  const exhausted = list.length < 12;
  return { rows, end: exhausted, ...(until && exhausted && { gap: "The previous history checkpoint is unavailable." }) };
}

export async function readAccountChange(rpc: Rpc<GetTransactionApi>, account: Address, signature: Signature): Promise<AccountChange | null> {
    const tx = await rpc.getTransaction(signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }).send();
    const keys = tx?.transaction.message.accountKeys;
    const index = keys?.findIndex(k => k.pubkey === account) ?? -1;
    const meta = tx?.meta;
    if (!meta || String(tx!.transaction.signatures[0]) !== signature || index < 0 || meta.preBalances[index] == null || meta.postBalances[index] == null)
      return null;
    const delta = meta.postBalances[index]! - meta.preBalances[index]!;
    const fee = index === 0 ? meta.fee : 0n;
    // Only a single verified top-level system transfer whose credit explains
    // the net is a deposit. A positive balance change alone is insufficient.
    const credits = tx!.transaction.message.instructions.flatMap(ix => {
      if (!("parsed" in ix) || ix.programId !== "11111111111111111111111111111111") return [];
      const p = ix.parsed as { type?: string; info?: { source?: string; destination?: string; lamports?: bigint } };
      if (p.type !== "transfer" || p.info?.destination !== account || String(p.info.lamports) !== String(delta + fee)) return [];
      return p.info.source ? [p.info.source] : [];
    });
    return { signature, account, delta: String(delta), payerFee: String(fee),
      failed: meta.err !== null, at: tx!.blockTime == null ? null : Number(tx!.blockTime) * 1000,
      externalSender: meta.err === null && credits.length === 1 ? credits[0]! : null };
}

function classify(state: WalletState, change: AccountChange, own: ReadonlySet<string>): HistoryRow {
  if (change.failed) return { ...change, kind: "fee" };
  for (const job of Object.values(state.jobs)) {
    const effect = Object.entries(job.signatures).find(([, sig]) => sig === change.signature)?.[0];
    if (effect) return { ...change, jobId: job.id, kind: effect === "close" ? "rent" :
      effect === "cancel" || (effect === "settle" && job.outcome === "refunded") ? "refund" : "settlement" };
  }
  if (change.externalSender && !own.has(change.externalSender)) return { ...change, kind: "deposit" };
  if (Object.values(state.moneyOperations ?? {}).some(op => op.receipt.signature === change.signature) || change.externalSender)
    return { ...change, kind: "transfer" };
  return { ...change, kind: BigInt(change.delta) === -BigInt(change.payerFee) && BigInt(change.payerFee) > 0n ? "fee" : "other" };
}

export async function indexAccountChanges(chain: Chain, store: StateStore, account: Address, own: ReadonlySet<string>, onDeposit: (draft: WalletState, row: HistoryRow) => void) {
  const cursor = store.state.moneyCursors?.[account] ?? {};
  let page: ChangePage;
  try {
    page = chain.accountChanges ? await chain.accountChanges(account, cursor.before, cursor.head) : { rows: [], end: false, gap: "Transaction history is unavailable." };
  } catch { page = { rows: [], end: false, gap: "Transaction history could not be read." }; }
  if (!page.rows.length && !page.gap && !cursor.before && !cursor.gap) return;
  store.update(s => {
    const rows = s.moneyRows ??= {};
    for (const change of page.rows) {
      const key = change.signature + "/" + account;
      if (rows[key]) continue;
      const row = classify(s, change, own);
      rows[key] = row;
      if (row.kind === "deposit") onDeposit(s, row);
    }
    const target = cursor.target ?? page.rows[0]?.signature;
    const before = page.rows.at(-1)?.signature ?? cursor.before;
    (s.moneyCursors ??= {})[account] = page.end ? {
      ...(target && { head: target }), ...(cursor.missingCheckpoint && { missingCheckpoint: cursor.missingCheckpoint }),
      ...(page.gap && { missingCheckpoint: page.gap }),
    } :
      { ...cursor, ...(before && { before }), ...(target && { target }), ...(page.gap && { gap: page.gap }) };
  });
}
