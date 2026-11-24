import { taskThread } from "@tetsuo-ai/marketplace-sdk";
import type { ExchangeReceipt } from "./client/job-exchange.js";
import { conversationPage, type ConversationEntry, type WaitingQuestion } from "./job-conversation.js";
import { type ExchangeJournal, type Parties } from "./private-inputs.js";

/** Remember only chain-verified contexts. Allows a party to reopen its own
 * encrypted transcript after the claim is closed or the relay is offline. */
export function rememberExchange(journal: ExchangeJournal, jobId: string, parties: Parties) {
  const key = "job-contexts/" + jobId;
  const contexts = journal.read<Parties[]>(key) ?? [];
  const context = taskThread.exchangeContext(parties);
  if (!contexts.some(p => p.generation && taskThread.exchangeContext(p) === context)) journal.write(key, [...contexts, parties]);
}

export interface ExchangeHistoryEntry {
  parties: Parties;
  receipt: ExchangeReceipt | null;
  entries: ConversationEntry[];
  beforeEntry: number | null;
  previousContext: number | null;
  contextIndex: number;
  cursor: number;
  deadline: number | null;
  waiting: WaitingQuestion | null;
}

export function localExchangeHistory(journal: ExchangeJournal, jobId: string, task: string, contextIndex?: number, beforeEntry?: number): ExchangeHistoryEntry[] {
  const contexts = (journal.read<Parties[]>("job-contexts/" + jobId) ?? []).filter(p => p.task === task);
  if (!contexts.length) return [];
  const index = contextIndex ?? contexts.length - 1;
  if (!Number.isSafeInteger(index) || index < 0 || index >= contexts.length) throw new Error("Invalid job history page.");
  const parties = contexts[index]!;
  // Pre-generation records remain available only in the local transcript.
  const context = parties.generation ? taskThread.exchangeContext(parties) :
    taskThread.legacyOutputContext(parties);
  const box = journal.read<{ receipt?: ExchangeReceipt }>("inbox/" + context);
  const thread = journal.read<{ entries: ConversationEntry[]; cursor: number; deadline: number; waiting: WaitingQuestion | null }>("thread/" + context);
  return [{ parties, contextIndex: index, previousContext: index ? index - 1 : null,
    receipt: box?.receipt ?? null, ...conversationPage(thread?.entries ?? [], beforeEntry), cursor: thread?.cursor ?? 0,
    deadline: thread?.deadline ?? null, waiting: thread?.waiting ?? null }];
}
