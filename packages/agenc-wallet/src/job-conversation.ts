import { taskThread } from "@tetsuo-ai/marketplace-sdk";
import { jobMessageIdPattern, type JobMessage } from "./client/job-exchange.js";
import { JobExchange, digest, type Parties } from "./private-inputs.js";

export interface ConversationEntry { author: string; message: JobMessage }
/** Even maximally escaped message text fits in a single wallet response. */
export function conversationPage(entries: ConversationEntry[], before = entries.length) {
  if (!Number.isSafeInteger(before) || before < 0 || before > entries.length) throw new Error("Invalid message page.");
  const first = Math.max(0, before - 16);
  return { entries: entries.slice(first, before), beforeEntry: first || null };
}

export interface WaitingQuestion { question: string; answer: string | null }
interface Thread {
  deadline: number;
  cursor: number;
  entries: ConversationEntry[];
  waiting: WaitingQuestion | null;
  outbox: taskThread.SignedPacket[];
}

const messageId = new RegExp(jobMessageIdPattern);

function threadId(p: Parties) { return "thread/" + taskThread.exchangeContext(p); }

export class JobConversation {
  constructor(private exchange: JobExchange, private deadline: number, private now = Date.now) {
    if (!Number.isSafeInteger(deadline) || deadline <= 0) throw new Error("A job deadline is required.");
  }
  private state(p: Parties): Thread {
    const thread = this.exchange.journal.read<Thread>(threadId(p)) ?? {
      deadline: this.deadline, cursor: 0, entries: [], waiting: null, outbox: [],
    };
    thread.deadline = Math.min(this.deadline, thread.deadline);
    if (this.exchange.signer.address === p.buyer && thread.waiting?.answer) thread.waiting = null;
    return thread;
  }
  async view() { return this.state(await this.exchange.live()); }

  private apply(thread: Thread, parties: Parties, author: string, m: JobMessage) {
    if (!m || !messageId.test(m.id) || typeof m.body !== "string" || !m.body.trim() || m.body.length > 8000 ||
        !["question", "reply", "progress", "ack"].includes(m.kind)) throw new Error("Invalid job message.");
    const previous = thread.entries.find(entry => entry.message.id === m.id);
    if (previous) {
      if (previous.author !== author || JSON.stringify(previous.message) !== JSON.stringify(m)) throw new Error("Conflicting job message.");
      return;
    }
    if (thread.entries.length >= 512) throw new Error("The job thread is full.");
    const parent = thread.entries.find(entry => entry.message.id === m.parent);
    if (m.kind === "question" || m.kind === "progress") {
      if (m.parent !== null) throw new Error("Unexpected reply reference.");
    } else if (!parent || parent.author === author) throw new Error("This reply needs a message from the other party.");
    if (m.kind === "question" && author === parties.authority) {
      if (thread.waiting) throw new Error("The job already has a blocking question.");
      thread.waiting = { question: m.id, answer: null };
    }
    if (m.kind === "reply") {
      if (parent?.message.kind !== "question") throw new Error("Choose a question to answer.");
      if (thread.waiting?.question === m.parent && !thread.waiting.answer) {
        if (this.exchange.signer.address === parties.buyer) thread.waiting = null;
        else thread.waiting.answer = m.id;
      }
    }
    thread.entries.push({ author, message: m });
  }

  /** Commit the parked state and signed outbox together before relay I/O. */
  async send(message: JobMessage, peerKey: taskThread.SignedPacket): Promise<taskThread.SignedPacket> {
    const p = await this.exchange.live();
    const packet = await this.exchange.prepare(p, "message", message, peerKey, message.id);
    const thread = this.state(p);
    if (this.now() >= thread.deadline) throw new Error("The original job deadline passed.");
    this.apply(thread, p, this.exchange.signer.address, message);
    if (!thread.outbox.some(it => it.header.id === packet.header.id)) thread.outbox.push(packet);
    this.exchange.journal.write(threadId(p), thread);
    return packet;
  }

  async ingest(cursor: number, packet: taskThread.SignedPacket) {
    const p = await this.exchange.live();
    const own = packet.header.sender === this.exchange.signer.address;
    const incoming = packet.header.purpose === "message" && !own ? await this.exchange.receive<JobMessage>(packet, "message") : null;
    await taskThread.verifyPacket(packet, p, packet.header.sender, packet.header.purpose);
    const thread = this.state(p);
    if (cursor <= thread.cursor) return;
    if (cursor !== thread.cursor + 1) throw new Error("Read the preceding job event first.");
    if (incoming) this.apply(thread, p, packet.header.sender, incoming);
    if (own) thread.outbox = thread.outbox.filter(it => it.signature !== packet.signature);
    thread.cursor = cursor;
    this.exchange.journal.write(threadId(p), thread);
  }

  /** An idempotent host queue accepts this stable run ID before acknowledge.
   * If either process stops in between they recover the same queued run. */
  async resume(enqueueOnce: (id: string, answer: string, deadline: number) => Promise<void>) {
    const p = await this.exchange.live();
    const thread = this.state(p);
    if (p.authority !== this.exchange.signer.address || !thread.waiting?.answer || this.now() >= thread.deadline) return false;
    const { question, answer } = thread.waiting;
    const result = thread.entries.find(entry => entry.message.id === answer)!;
    await enqueueOnce(digest(JSON.stringify([threadId(p), question, answer])), result.message.body, thread.deadline);
    const latest = this.state(p);
    if (latest.waiting?.question === question && latest.waiting.answer === answer) latest.waiting = null;
    this.exchange.journal.write(threadId(p), latest);
    return true;
  }
}
