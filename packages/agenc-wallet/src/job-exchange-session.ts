import { randomBytes } from "node:crypto";
import { taskThread } from "@tetsuo-ai/marketplace-sdk";
import { type ExchangeReceipt, type JobMessage, type RecipientGrantPreview, type PrivateRequirement } from "./client/job-exchange.js";
import { acceptImportReceipt, ExchangeRelay, handoffView, importAndAcknowledge } from "./exchange-relay.js";
import { deliveryFileProblem } from "./client/delivery-files.js";
import { conversationPage, isShareMessage, JobConversation } from "./job-conversation.js";
import { CHILD_SHARE_MESSAGE } from "./purchase-admission.js";
import { verifyChildShare } from "./child-share.js";
import type { ChildShareBinding } from "./client/child-hire.js";
import { digest, JobExchange, protectOutput, type Packet, type PrivateBundle } from "./private-inputs.js";

interface Mailbox {
  peerKey?: Packet;
  inputs?: Packet;
  receipt?: ExchangeReceipt;
  /** Supplier share approvals signed by this order's buyer, verified on arrival. */
  shares?: { binding: ChildShareBinding; proof: string }[];
}

/** Scoped host controller used by the wallet broker and worker. The caller
 * derives the room, deadline and requirement from verified job context. No
 * monetary operation is available through this controller. */
export class JobExchangeSession {
  readonly conversation: JobConversation;
  constructor(private exchange: JobExchange, private relay: ExchangeRelay, private deadline: number,
    private required?: PrivateRequirement, private now = Date.now, private collect?: () => Promise<{ hash: string | null }>) {
    this.conversation = new JobConversation(exchange, deadline, now);
  }

  private async mailbox(parties?: taskThread.ExchangeParties) {
    const id = "inbox/" + taskThread.exchangeContext(parties ?? await this.exchange.live());
    return { id, read: (): Mailbox => this.exchange.journal.read<Mailbox>(id) ?? {} };
  }

  async join() {
    const packet = await this.exchange.announceKey();
    return this.relay.put(this.exchange, packet);
  }

  /** Synchronize a bounded page. Apply each event durably before advancing
   * the cursor. Replaying after a crash repeats only idempotent writes. */
  async refresh() {
    for (let count = 0; count < 16; count++) {
      const thread = await this.conversation.view();
      const event = await this.relay.next(this.exchange, thread.cursor);
      if (!event) break;
      const { packet, cursor } = event;
      if (packet.header.sender !== this.exchange.signer.address) {
        const p = await this.exchange.live();
        const peer = this.exchange.signer.address === p.buyer ? p.authority : p.buyer;
        await taskThread.verifyPacket(packet, p, peer, packet.header.purpose);
        const { id, read } = await this.mailbox(p);
        if (packet.header.purpose === "key") this.exchange.journal.write(id, { ...read(), peerKey: packet });
        if (packet.header.purpose === "inputs" && this.required) {
          await this.exchange.receiveBundle(packet, "inputs", this.required.commitment);
          this.exchange.journal.write(id, { ...read(), inputs: packet });
        }
        if (packet.header.purpose === "message" && packet.header.sender === p.buyer && this.exchange.signer.address === p.authority) {
          const message = await this.exchange.receive<JobMessage>(packet, "message").catch(() => null);
          if (message && isShareMessage(message)) {
            const share = await this.verifiedShare(p, message.body.slice(CHILD_SHARE_MESSAGE.length + 1));
            const saved = read().shares ?? [];
            if (share && !saved.some(other => other.proof === share.proof) && saved.length < 8)
              this.exchange.journal.write(id, { ...read(), shares: [...saved, share] });
          }
        }
        if (packet.header.purpose === "receipt" && this.required) {
          const receipt = await acceptImportReceipt(this.exchange, this.required, packet);
          this.exchange.journal.write(id, { ...read(), receipt });
        }
      }
      await this.conversation.ingest(cursor, packet);
    }
    return this.status();
  }

  async status(beforeEntry?: number) {
    const { read } = await this.mailbox();
    const box = read();
    const { cursor, entries, waiting, deadline } = await this.conversation.view();
    const handoff = this.required ? await handoffView(this.exchange, this.required, deadline) : null;
    return { deadline, cursor, ...conversationPage(entries, beforeEntry), waiting, receipt: box.receipt ?? null, peerReady: !!box.peerKey,
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

  /** Host-only. Rebuild the private input disk for each fresh guest, including
   * when a previous boot already delivered a signed receipt. */
  async roomInputs() {
    const box = (await this.mailbox()).read();
    if (!this.required || !box.inputs || !box.peerKey) throw new Error("Waiting for buyer.");
    if (this.now() >= this.deadline) throw new Error("The original job deadline passed.");
    const bundle = await this.exchange.receiveBundle(box.inputs, "inputs", this.required.commitment);
    return { requirement: this.required, room: box.inputs.header.room, bundle };
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

  private async verifiedShare(p: taskThread.ExchangeParties, raw: string) {
    try {
      const { binding, proof } = JSON.parse(raw) as { binding: ChildShareBinding; proof: string };
      if (binding?.parentTask !== p.task || typeof proof !== "string") return null;
      await verifyChildShare(p.buyer, binding, proof);
      return { binding, proof };
    } catch { return null; }
  }

  /** Buyer wallet only. Send the owner-signed supplier share to this order's verified provider. */
  async sendChildShare(binding: ChildShareBinding, proof: string) {
    const p = await this.exchange.live();
    if (this.exchange.signer.address !== p.buyer || binding.parentTask !== p.task) throw new Error("Only this order's buyer can approve a supplier share.");
    await verifyChildShare(p.buyer, binding, proof);
    const peer = (await this.mailbox(p)).read().peerKey;
    if (!peer) throw new Error("Waiting for a job-specific recipient key.");
    const body = CHILD_SHARE_MESSAGE + ":" + JSON.stringify({ binding, proof });
    const message: JobMessage = { id: digest(body).slice(0, 32), kind: "progress", parent: null, body };
    await this.relay.put(this.exchange, await this.conversation.send(message, peer, true));
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

  /** Re-exporting the same bytes after a lost acknowledgement reuses the
   * original protected pointer. A changed file or text gets a fresh salt. */
  async returnRoomOutput(text: string, files: PrivateBundle["files"]) {
    const parties = await this.exchange.live();
    if (parties.authority !== this.exchange.signer.address) throw new Error("A confirmed worker is required.");
    const id = JSON.stringify(["output-salt", taskThread.exchangeContext(parties), digest(text), files.map(f => [f.name, f.bytes, f.sha256])]);
    let salt = this.exchange.journal.read<string>(id);
    if (!salt) {
      salt = randomBytes(32).toString("hex");
      this.exchange.journal.write(id, salt);
    }
    return this.returnOutput({ version: 1, salt, text, files });
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

  /** Compatibility with earlier room hosts. Only the buyer's current verified
   * submission or settlement can select the output. */
  async collectOutput(commitment: string) {
    if (!this.collect || !/^[a-f0-9]{64}$/.test(commitment)) throw new Error("A verified buyer delivery is required.");
    const { hash } = await this.collect();
    if (!["v1", "v2"].some(version => digest(`agenc.private-output.${version}:${commitment}`) === hash)) {
      throw new Error("The private delivery commitment changed.");
    }
  }
}
