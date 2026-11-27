// The trusted host binds its input exchange, conversation, child supplier and
// run journal to a verified task. A request cannot install an executor.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "@solana/kit";
import type { runExecutor } from "./executor.js";

export interface VerifiedRoomWork {
  task: Address;
  seller: Address;
  deadline: bigint;
  spec: Record<string, unknown>;
  listing: Address | null;
  privateInputs: boolean;
  /** Service metadata read against the listing's committed digest. */
  listingMetadata?: Uint8Array | null;
}

export function needsPrivateRoom(spec: Record<string, unknown>): boolean {
  const criteria = spec.acceptance ?? spec.acceptanceCriteria;
  return spec.privateInputs !== undefined || (Array.isArray(criteria) &&
    criteria.some(line => typeof line === "string" && line.startsWith("Private input handoff v1: ")));
}
type Execute = typeof runExecutor;
export type RoomTurnResult = { state: "parked" } | { state: "delivered"; stdout: Buffer };
/** B supplies the verified session. The host accepts the stable ID before
 * the wallet acknowledges the reply. Only opaque IDs are kept in this spool. */
export interface RoomQuestionHost {
  session: {
    refresh(): Promise<{ waiting: unknown }>;
    conversation: { resume(enqueue: (id: string, answer: string, deadline: number) => Promise<void>): Promise<boolean> };
  };
  enqueueOnce(id: string, answer: string, deadline: number): Promise<void>;
}

export async function waitForRoomAnswer(stateDir: string, task: Address, host: RoomQuestionHost) {
  const { waiting } = await host.session.refresh();
  if (!waiting) return false;
  await host.session.conversation.resume(async (id, answer, deadline) => {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid room continuation.");
    mkdirSync(join(stateDir, "room-answers", task, id), { recursive: true, mode: 0o700 });
    // Redelivery after a crash reuses the same queue key until the host confirms.
    await host.enqueueOnce(id, answer, deadline);
  });
  return true;
}

export interface RoomWork {
  verifySavedOutput?(task:Address,claim:Address,hash:string):Promise<boolean>;
  questions?(binding: VerifiedRoomWork): Promise<RoomQuestionHost | undefined>;
  /** Refuse incompatible inputs, image, disclosure or output terms before claim. */
  admit(binding: VerifiedRoomWork): Promise<void>;
  /** Check the live claim and its original deadline before opening a model.
   * A parked turn reattaches only to the run that already owns its budget. */
  open(binding: VerifiedRoomWork): Promise<
    { state: "ordinary" } | { state: "waiting" } |
    { state: "resume"; resume(deadlineMs?: number, signal?: AbortSignal, claimRound?: string): Promise<RoomTurnResult> } |
    { state: "ready"; execute(input: Parameters<Execute>[0]): Promise<RoomTurnResult> }
  >;
}
