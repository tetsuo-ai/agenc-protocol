import { taskThread } from "@tetsuo-ai/marketplace-sdk";
import { type ExchangeReceipt, type PrivateRequirement } from "./client/job-exchange.js";
import { type Packet, type PrivateBundle, bundleManifest, JobExchange } from "./private-inputs.js";

/** Configured by the wallet host. A job or a peer cannot redirect private
 * data or credentials by supplying a URL. A read signature is short-lived. */
export class ExchangeRelay {
  private base: URL;
  constructor(origin: string, private fetcher = fetch) {
    this.base = new URL(origin);
    if ((this.base.protocol !== "https:" && !(this.base.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(this.base.hostname))) ||
        this.base.username || this.base.password || this.base.pathname !== "/" || this.base.search || this.base.hash) throw new Error("Invalid job exchange origin.");
  }
  private async request(packet: Packet) {
    const uri = new URL("/api/job-exchange/" + encodeURIComponent(packet.header.task), this.base);
    const res = await this.fetcher(uri, { method: "POST", redirect: "error", credentials: "omit", cache: "no-store",
      signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/json" }, body: JSON.stringify(packet) });
    if (!res.ok || !res.body) throw new Error("The private job exchange is unavailable. Retry.");
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4_100_000) throw new Error("The exchange response is too large.");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as { cursor: number; packet?: Packet | null };
  }
  async put(exchange: JobExchange, packet: Packet) {
    await taskThread.verifyPacket(packet, await exchange.live(), exchange.signer.address, packet.header.purpose);
    return (await this.request(packet)).cursor;
  }
  async next(exchange: JobExchange, after: number): Promise<{ packet: Packet; cursor: number } | null> {
    const p = await exchange.live();
    const request = await taskThread.signPacket({ ...p, sender: exchange.signer.address, purpose: "read", id: taskThread.newExchangeId() },
      JSON.stringify([after, Date.now()]), exchange.signer);
    const reply = await this.request(request);
    if (reply.packet === null && reply.cursor === after) return null;
    if (!reply.packet || reply.cursor !== after + 1) throw new Error("Invalid exchange cursor.");
    await taskThread.verifyPacket(reply.packet, p, reply.packet.header.sender, reply.packet.header.purpose);
    return { packet: reply.packet, cursor: reply.cursor };
  }
}

export type HandoffView =
  | { state: "waitingForBuyer" | "waitingForRoom"; deadline: number }
  | { state: "received"; deadline: number; receipt: ExchangeReceipt };

/** A host supplies the receipt from the privileged guest channel only after
 * the named room has independently checked the entire manifest. */
export async function importAndAcknowledge(exchange: JobExchange, requirement: PrivateRequirement, packet: Packet,
  buyerKey: Packet, importInRoom: (bundle: PrivateBundle) => Promise<ExchangeReceipt>): Promise<{ receipt: ExchangeReceipt; ack: Packet }> {
  const p = await exchange.live();
  const key = "receipt/" + taskThread.exchangeContext(p) + requirement.commitment;
  const bundle = await exchange.receiveBundle(packet, "inputs", requirement.commitment);
  const receipt = exchange.journal.read<ExchangeReceipt>(key) ?? await importInRoom(bundle);
  if (receipt.version !== bundle.version || receipt.manifest !== bundleManifest(bundle) || receipt.room !== p.room) throw new Error("The room receipt changed.");
  const ack = await exchange.confirmImport(requirement, receipt, buyerKey);
  exchange.journal.write(key, receipt);
  return { receipt, ack };
}

export async function acceptImportReceipt(exchange: JobExchange, requirement: PrivateRequirement, ack: Packet) {
  const p = await exchange.live();
  const receipt = await exchange.receive<ExchangeReceipt>(ack, "receipt");
  if (p.buyer !== exchange.signer.address || receipt.commitment !== requirement.commitment || receipt.manifest !== requirement.commitment ||
      receipt.version !== 1 || receipt.room !== p.room) throw new Error("The room receipt does not match this job.");
  // Recheck that this particular claim and room received a grant from this buyer.
  await exchange.inputs(requirement);
  exchange.journal.write("receipt/" + taskThread.exchangeContext(p) + requirement.commitment, receipt);
  return receipt;
}

export async function handoffView(exchange: JobExchange, requirement: PrivateRequirement, deadline: number): Promise<HandoffView> {
  const p = await exchange.live();
  const receipt = exchange.journal.read<ExchangeReceipt>("receipt/" + taskThread.exchangeContext(p) + requirement.commitment);
  if (receipt) return { state: "received", deadline, receipt };
  const granted = exchange.journal.read("grant/" + requirement.commitment + taskThread.exchangeContext(p));
  return { state: granted ? "waitingForRoom" : "waitingForBuyer", deadline };
}
