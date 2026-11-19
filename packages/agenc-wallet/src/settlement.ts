// Who was paid for a finished job, read from the transaction that paid them.
//
// Once a paid job is tidied, its claim, its delivery and its link to the
// service it was hired from are closed on the chain. The job's own record
// stays, but it does not say which agent did the work, and the marketplace's
// list of finished jobs, which reads only what is still open on the chain,
// loses it too. The transaction that paid the agent says it for good: it
// names the job and the agent, and the program checked both before it paid.
import { AccountRole, getBase58Encoder, type Address } from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  AgencCoordinationInstruction,
  parseAgencCoordinationInstruction,
} from "@tetsuo-ai/marketplace-sdk";

/** One instruction of a transaction, as far as this file needs it. */
export interface SentInstruction {
  programAddress: Address;
  accounts: readonly Address[];
  data: Uint8Array;
}

/** A job and the agent its settlement paid. */
export interface Settlement {
  task: Address;
  worker: Address;
}

/**
 * The job `instruction` settles and the agent it pays, or null when it
 * settles nothing. A job is settled by its buyer's approval, by the approval
 * that comes when the buyer's time to review runs out, or by the agent itself
 * on a job that needs no review. A dispute's ruling is left out: it may pay
 * either side.
 */
export function settlementOf(instruction: SentInstruction): Settlement | null {
  if (instruction.programAddress !== AGENC_COORDINATION_PROGRAM_ADDRESS) return null;
  let parsed: ReturnType<typeof parseAgencCoordinationInstruction>;
  try {
    parsed = parseAgencCoordinationInstruction({
      programAddress: instruction.programAddress,
      accounts: instruction.accounts.map((address) => ({ address, role: AccountRole.READONLY })),
      data: instruction.data,
    });
  } catch {
    // Not one of the program's instructions, or not as many accounts as one
    // needs: it settles nothing.
    return null;
  }
  switch (parsed.instructionType) {
    case AgencCoordinationInstruction.AcceptTaskResult:
    case AgencCoordinationInstruction.AutoAcceptTaskResult:
    case AgencCoordinationInstruction.CompleteTask:
      return { task: parsed.accounts.task.address, worker: parsed.accounts.worker.address };
    default:
      return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** An instruction as JSON-RPC sends one it cannot read itself: addresses and base58 bytes. */
function sentInstruction(value: unknown): SentInstruction | null {
  const entry = record(value);
  if (entry === null || typeof entry.programId !== "string" || typeof entry.data !== "string") return null;
  const accounts = entry.accounts;
  if (!Array.isArray(accounts) || !accounts.every((account) => typeof account === "string")) return null;
  let data: Uint8Array;
  try {
    data = Uint8Array.from(getBase58Encoder().encode(entry.data));
  } catch {
    return null;
  }
  return { programAddress: entry.programId as Address, accounts: accounts as Address[], data };
}

/**
 * The agent a transaction paid for `task`, from a JSON-RPC `getTransaction`
 * answer in "jsonParsed" form; null when the transaction failed, is not the
 * one asked for, or does not settle that job. Instructions another program
 * called count as well: the program checked them the same way.
 */
export function settlementWorkerIn(value: unknown, task: Address, signature: string): Address | null {
  const answer = record(value);
  const meta = record(answer?.meta);
  if (meta === null || meta.err !== null) return null;
  const transaction = record(answer?.transaction);
  const signatures = transaction?.signatures;
  if (!Array.isArray(signatures) || signatures[0] !== signature) return null;
  const message = record(transaction?.message);
  const outer = Array.isArray(message?.instructions) ? message.instructions : [];
  const inner = Array.isArray(meta.innerInstructions)
    ? meta.innerInstructions.flatMap((group) => {
        const list = record(group)?.instructions;
        return Array.isArray(list) ? list : [];
      })
    : [];
  for (const raw of [...outer, ...inner]) {
    const instruction = sentInstruction(raw);
    if (instruction === null) continue;
    const settled = settlementOf(instruction);
    if (settled !== null && settled.task === task) return settled.worker;
  }
  return null;
}

/** How far back a job's history is read for the transaction that paid for it. */
export const SETTLEMENT_HISTORY_LIMIT = 20;

/** The parts of a JSON-RPC client the history read needs. */
export interface SettlementHistoryRpc {
  getSignaturesForAddress(
    address: Address,
    config: { limit: number; commitment: "confirmed" },
  ): { send(): Promise<readonly { signature?: unknown; err?: unknown }[]> };
  getTransaction(
    signature: string,
    config: { commitment: "confirmed"; encoding: "jsonParsed"; maxSupportedTransactionVersion: 0 },
  ): { send(): Promise<unknown> };
}

/**
 * The agent that was paid for finishing `task`, from the job's own recent
 * history on the chain, newest first. Null when none of it settles the job.
 * Throws when the history cannot be read.
 */
export async function readSettlementWorker(
  rpc: SettlementHistoryRpc,
  task: Address,
  limit: number = SETTLEMENT_HISTORY_LIMIT,
): Promise<Address | null> {
  const history = await rpc.getSignaturesForAddress(task, { limit, commitment: "confirmed" }).send();
  for (const entry of history) {
    if (typeof entry.signature !== "string" || entry.err !== null) continue;
    const transaction = await rpc
      .getTransaction(entry.signature, {
        commitment: "confirmed",
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0,
      })
      .send();
    const worker = settlementWorkerIn(transaction, task, entry.signature);
    if (worker !== null) return worker;
  }
  return null;
}
