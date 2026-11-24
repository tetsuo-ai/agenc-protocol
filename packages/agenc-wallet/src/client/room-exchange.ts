// The job room program's link to the wallet's scoped private exchange for one run.
// The wallet opens a per-run socket bound to the confirmed claim and room and
// passes its path and a one-run token in the room's scope (`scope.exchange`).
// Only these operations exist: no money, no signing, no other job.
import { connect } from "node:net";
import { createInterface } from "node:readline";
import type { ExchangeReceipt, JobMessage, PrivateRequirement } from "./job-exchange.js";

export interface RoomExchangeAddress { socket: string; token: string }
export interface RoomBundle {
  processing?: string;
  outputs?: { requiredFiles: string[]; allowTextOnly: boolean };
  version: number;
  salt: string;
  files: { name: string; bytes: number; sha256: string; base64: string }[];
  text: string;
}
export const ROOM_EXCHANGE_METHODS = ["roomInputs", "importInputs", "returnRoomOutput", "send", "roomTurnState", "status"] as const;

export function checkRoomExchangeAddress(value: unknown): RoomExchangeAddress {
  const v = value as Partial<RoomExchangeAddress> | null;
  if (!v || typeof v.socket !== "string" || !v.socket.startsWith("/") || typeof v.token !== "string" || !/^[a-f0-9]{64}$/.test(v.token))
    throw new Error("The private exchange link is not valid.");
  return { socket: v.socket, token: v.token };
}

/** One connection per run. Each call is answered in order. */
export async function connectRoomExchange(address: RoomExchangeAddress) {
  const { socket: path, token } = checkRoomExchangeAddress(address);
  const socket = connect(path);
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
  let next = 0;
  let queue = Promise.resolve();
  socket.write(JSON.stringify({ token }) + "\n");
  const call = <T>(method: (typeof ROOM_EXCHANGE_METHODS)[number], params: unknown = null) => {
    const run = queue.then(async () => {
      const id = ++next;
      socket.write(JSON.stringify({ id, method, params }) + "\n");
      const { value, done } = await lines.next();
      if (done) throw new Error("The private exchange closed.");
      const reply = JSON.parse(value) as { id: number; ok: boolean; result?: T; error?: string };
      if (reply.id !== id) throw new Error("The private exchange answered out of order.");
      if (!reply.ok) throw new Error(reply.error ?? "The private exchange refused this step.");
      return reply.result as T;
    });
    queue = run.then(() => undefined, () => undefined);
    return run;
  };
  return {
    roomInputs: () => call<{ requirement: PrivateRequirement; room: string; bundle: RoomBundle }>("roomInputs"),
    /** `verify` runs in the room against the current bundle; the wallet checks the receipt again. */
    async importInputs(verify: (bundle: RoomBundle) => Promise<ExchangeReceipt>) {
      const { bundle } = await call<{ bundle: RoomBundle }>("roomInputs");
      return call<ExchangeReceipt>("importInputs", { receipt: await verify(bundle) });
    },
    returnRoomOutput: (text: string, files: RoomBundle["files"]) => call<string>("returnRoomOutput", { text, files }),
    async send(message: JobMessage) { await call("send", { message }); },
    roomTurnState: () => call<"parked" | "expired" | "ready">("roomTurnState"),
    status: () => call<unknown>("status"),
    close() { socket.destroy(); },
  };
}
