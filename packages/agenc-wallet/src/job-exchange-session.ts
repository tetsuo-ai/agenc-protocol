import { taskThread } from "@tetsuo-ai/marketplace-sdk";
import { type ExchangeReceipt, type JobMessage, type RecipientGrantPreview, type PrivateRequirement } from "./client/job-exchange.js";
import { acceptImportReceipt, ExchangeRelay, handoffView, importAndAcknowledge } from "./exchange-relay.js";
import { deliveryFileProblem } from "./client/delivery-files.js";
import { JobConversation } from "./job-conversation.js";
import { collectOutput, JobExchange, protectOutput, type Packet, type PrivateBundle } from "./private-inputs.js";

interface Mailbox {
  peerKey?: Packet;
  inputs?: Packet;
  receipt?: ExchangeReceipt;
  protectedOutputs: Packet[];
}

/** Scoped host controller used by the wallet broker and worker. The caller
 * derives the room, deadline and requirement from verified job context. No
 * monetary operation is available through this controller. */
export class JobExchangeSession {
  readonly conversation: JobConversation;
  constructor(private exchange: JobExchange, private relay: ExchangeRelay, private deadline: number,
    private required?: PrivateRequirement, private now = Date.now) {
    this.conversation = new JobConversation(exchange, deadline, now);
  }

  private async mailbox() {
    const id = "inbox/" + taskThread.exchangeContext(await this.exchange.live());
    return { id, read: (): Mailbox => this.exchange.journal.read<Mailbox>(id) ?? { protectedOutputs: [] } };
  }

  async join() {
    const packet = await this.exchange.announceKey();
    return this.relay.put(this.exchange, packet);
  }

  /** Synchronize a bounded page. Apply each event durably before advancing
   * the cursor. Replaying after a crash repeats only idempotent writes. */
  async refresh() {
    const { id, read } = await this.mailbox();
    for (let count = 0; count < 16; count++) {
      const thread = await this.conversation.view();
      const event = await this.relay.next(this.exchange, thread.cursor);
      if (!event) break;
      const { packet, cursor } = event;
      if (packet.header.sender !== this.exchange.signer.address) {
        const p = await this.exchange.live();
        const peer = this.exchange.signer.address === p.buyer ? p.authority : p.buyer;
        await taskThread.verifyPacket(packet, p, peer, packet.header.purpose);
        if (packet.header.purpose === "key") this.exchange.journal.write(id, { ...read(), peerKey: packet });
        if (packet.header.purpose === "inputs" && this.required) {
          await this.exchange.receiveBundle(packet, "inputs", this.required.commitment);
          this.exchange.journal.write(id, { ...read(), inputs: packet });
        }
        if (packet.header.purpose === "receipt" && this.required) {
          const receipt = await acceptImportReceipt(this.exchange, this.required, packet);
          this.exchange.journal.write(id, { ...read(), receipt });
        }
        if (packet.header.purpose === "output") {
          const box = read();
          if (!box.protectedOutputs.some(old => old.signature === packet.signature)) {
            // Only keep the few possible revision rounds for a revision 9 task.
            this.exchange.journal.write(id, { ...box, protectedOutputs: [...box.protectedOutputs, packet].slice(-3) });
          }
        }
      }
      await this.conversation.ingest(cursor, packet);
    }
    return this.status();
  }

  async status() {
    const { read } = await this.mailbox();
    const box = read();
    const { cursor, entries, waiting, deadline } = await this.conversation.view();
    const handoff = this.required ? await handoffView(this.exchange, this.required, deadline) : null;
    return { deadline, cursor, entries, waiting, receipt: box.receipt ?? null, peerReady: !!box.peerKey,
      state: box.receipt ? "received" : box.inputs ? "waitingForRoom" : handoff?.state ?? "ready" };

  }

  /** Owner-only. Approve the exact room, authority, claim instance and public
   * key shown on the card. A substituted key needs a fresh decision. */
  async release(approved: taskThread.ExchangeParties, keySignature: string) {
    const peer = (await this.mailbox()).read().peerKey;
    if (!this.required || !peer || this.now() >= this.deadline || peer.signature !== keySignature) throw new Error("Review the current room and recipient.");
    await this.exchange.grant(this.required, approved, peer);
    return this.retryInputs();
  }

  async grantPreview(): Promise<RecipientGrantPreview | null> {
    const key = (await this.mailbox()).read().peerKey;
    if (!key || !this.required) return null;
    return { ...await this.exchange.stagedPreview(this.required), parties: await this.exchange.live(), keySignature: key.signature, commitment: this.required.commitment, deadline: this.deadline };
  }

  async retryInputs() {
    if (!this.required || this.now() >= this.deadline) throw new Error("The private input deadline passed.");
    return this.relay.put(this.exchange, await this.exchange.inputs(this.required));
  }

  /** Worker-only. The callback reads the privileged guest import receipt. */
  async importInputs(importInRoom: (bundle: PrivateBundle) => Promise<ExchangeReceipt>) {
    const { id, read } = await this.mailbox();
    const box = read();
    if (!this.required || !box.inputs || !box.peerKey) throw new Error("Waiting for buyer.");
    if (this.now() >= this.deadline) throw new Error("The original job deadline passed.");
    const result = await importAndAcknowledge(this.exchange, this.required, box.inputs, box.peerKey, importInRoom);
    await this.relay.put(this.exchange, result.ack);
    this.exchange.journal.write(id, { ...read(), receipt: result.receipt });
    return result.receipt;
  }

  async roomTurnState() {
    const status = await this.status();
    if (this.now() >= status.deadline) return "expired";
    if (status.waiting || (this.required && !status.receipt)) return "parked";
    return "ready";
  }

  async send(message: JobMessage) {
    const peer = (await this.mailbox()).read().peerKey;
    if (!peer) throw new Error("Waiting for a job-specific recipient key.");
    await this.relay.put(this.exchange, await this.conversation.send(message, peer));
  }

  async retryMessages() {
    const thread = await this.conversation.view();
    if (this.now() >= thread.deadline) throw new Error("The original job deadline passed.");
    for (const packet of thread.outbox) await this.relay.put(this.exchange, packet);
  }

  async returnOutput(bundle: PrivateBundle) {
    const box = (await this.mailbox()).read();
    if (!this.required || !box.receipt || !box.inputs || !box.peerKey) throw new Error("The room has not received the approved inputs.");
    if (this.now() >= this.deadline) throw new Error("The original job deadline passed.");
    const inputs = await this.exchange.receiveBundle(box.inputs, "inputs", this.required.commitment);
    if ((!bundle.files.length && (!bundle.text.trim() || inputs.outputs?.allowTextOnly === false)) ||
        inputs.outputs?.requiredFiles.some(name => !bundle.files.some(file => file.name === name)) ||
        bundle.files.some(file => deliveryFileProblem(file.name, Buffer.from(file.base64, "base64")))) {
      throw new Error("Repair the promised outputs before returning this delivery.");
    }
    const sealed = await protectOutput(this.exchange, bundle, box.peerKey);
    await this.relay.put(this.exchange, sealed.packet);
    return sealed.pointer;
  }

  async collectOutput(commitment: string) {
    const packets = (await this.mailbox()).read().protectedOutputs;
    for (const packet of packets) {
      try {
        await collectOutput(this.exchange, commitment, packet);
        return;
      } catch { /* A previous revision may have a different commitment. */ }
    }
    throw new Error("The current private output is unavailable. Retry.");
  }
}
