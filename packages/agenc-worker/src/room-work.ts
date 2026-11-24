// The trusted host binds its input exchange, conversation, child supplier and
// run journal to a verified task. A request cannot install an executor.
import type { Address } from "@solana/kit";
import type { runExecutor } from "./executor.js";

export interface VerifiedRoomWork {
  task: Address;
  seller: Address;
  deadline: bigint;
  spec: Record<string, unknown>;
  listing: Address | null;
  privateInputs: boolean;
}

export function needsPrivateRoom(spec: Record<string, unknown>): boolean {
  const criteria = spec.acceptance ?? spec.acceptanceCriteria;
  return spec.privateInputs !== undefined || (Array.isArray(criteria) &&
    criteria.some(line => typeof line === "string" && line.startsWith("Private input handoff v1: ")));
}
type Execute = typeof runExecutor;
export type RoomTurnResult = { state: "parked" } | { state: "delivered"; stdout: Buffer };
export interface RoomWork {
  /** Refuse incompatible inputs, image, disclosure or output terms before claim. */
  admit(binding: VerifiedRoomWork): Promise<void>;
  /** Check the live claim and its original deadline before opening a model.
   * A parked turn reattaches only to the run that already owns its budget. */
  open(binding: VerifiedRoomWork): Promise<
    { state: "ordinary" } | { state: "waiting" } |
    { state: "resume"; resume(): Promise<RoomTurnResult> } |
    { state: "ready"; execute(input: Parameters<Execute>[0]): Promise<RoomTurnResult> }
  >;
}
