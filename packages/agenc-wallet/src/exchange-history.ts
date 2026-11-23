import { taskThread } from "@tetsuo-ai/marketplace-sdk";
import type { ExchangeReceipt } from "./client/job-exchange.js";
import type { ConversationEntry, WaitingQuestion } from "./job-conversation.js";
import { type ExchangeJournal, type Parties } from "./private-inputs.js";

/** Remember only chain-verified contexts. Allows a party to reopen its own
 * encrypted transcript after the claim is closed or the relay is offline. */
export function rememberExchange(journal: ExchangeJournal, jobId: string, parties: Parties) {
  const key = "job-contexts/" + jobId;
  const contexts = journal.read<Parties[]>(key) ?? [];
  const context = taskThread.exchangeContext(parties);
  if (!contexts.some(p => taskThread.exchangeContext(p) === context)) journal.write(key, [...contexts, parties]);
}

export interface ExchangeHistoryEntry {
  parties: Parties;
  receipt: ExchangeReceipt | null;
  entries: ConversationEntry[];
  cursor: number;
  deadline: number | null;
  waiting: WaitingQuestion | null;
}

export function localExchangeHistory(journal: ExchangeJournal, jobId: string, task: string): ExchangeHistoryEntry[] {
  const contexts = journal.read<Parties[]>("job-contexts/" + jobId) ?? [];
  return contexts.filter(p => p.task === task).map(parties => {
    const context = taskThread.exchangeContext(parties);
    const box = journal.read<{ receipt?: ExchangeReceipt }>("inbox/" + context);
    const thread = journal.read<{ entries: ConversationEntry[]; cursor: number; deadline: number; waiting: WaitingQuestion | null }>("thread/" + context);
    return { parties, receipt: box?.receipt ?? null, entries: thread?.entries ?? [], cursor: thread?.cursor ?? 0,
      deadline: thread?.deadline ?? null, waiting: thread?.waiting ?? null };
  });
}
