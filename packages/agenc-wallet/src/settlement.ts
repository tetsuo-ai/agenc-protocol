// Who was paid for a finished job, read from the transaction that paid them.
//
// Once a paid job is tidied, its claim, its delivery and its link to the
// service it was hired from are closed on the chain, and the marketplace's
// list of finished jobs, which reads only what is still open on the chain,
// loses it too. Since revision 9 the job's own record is compacted as well:
// a small marker keeps only that it was finished. The transaction that paid
// the agent says it for good: it names the job and the agent, the program
// checked both before it paid, and the events the program logged in it say
// how much the job paid and what fee the marketplace took.
import { AccountRole, getBase58Encoder, type Address, type Signature } from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  AgencCoordinationInstruction,
  findTaskPda, findAgentPda,
  parseAgencCoordinationEvents,
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
  operator?: Address;
}

/**
 * The job `instruction` settles and the agent it pays, or null when it
 * settles nothing. A job is settled by its buyer's approval, by the approval
 * that comes when the buyer's time to review runs out, or by the agent itself
 * on a job that needs no review. A dispute's ruling is left out: it may pay
 * either side.
 */
export function settlementOf(instruction: SentInstruction, includeFrozen = false): Settlement | null {
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
      break;
    case AgencCoordinationInstruction.ResolveRejectFrozen:
    case AgencCoordinationInstruction.ExpireRejectFrozen:
      if (!includeFrozen) return null;
      break;
    default:
      return null;
  }
  const { task, worker, operator } = parsed.accounts;
  return { task: task.address, worker: worker.address, ...(operator && { operator: operator.address }) };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** An instruction as JSON-RPC sends one it cannot read itself: addresses and base58 bytes. */
export function sentInstruction(value: unknown): SentInstruction | null {
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
function settlementIn(value: unknown, task: Address, signature: string, includeFrozen: boolean): Settlement | null {
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
    const settled = settlementOf(instruction, includeFrozen);
    if (settled !== null && settled.task === task) return settled;
  }
  return null;
}

export function settlementWorkerIn(value: unknown, task: Address, signature: string, includeFrozen = false): Address | null {
  return settlementIn(value, task, signature, includeFrozen)?.worker ?? null;
}

/** What the transactions of a finished job say about it. */
export interface SettlementFacts {
  reputation?: { before: number; after: number; signature?: string };
  /** The agent it paid. */
  worker: Address;
  /** What the job paid in all: the agent's share, the fee and any operator or referrer share. */
  priceLamports: bigint;
  /** The marketplace's fee taken out of it. */
  feeLamports: bigint;
  /** An operator account named by the settlement, with no paid or forfeited fee event in its complete logs. */
  unpaidOperator?: { address: Address; sellerNet: bigint };
  operatorPayment?: { address: Address; paid: bigint; forfeited: bigint; sellerNet: bigint };
  /**
   * The service it was hired from, as the program's own hire event names it
   * (for the same job, buyer and agent), or null when no such event was read.
   */
  listing: Address | null;
}

function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * The agent a transaction paid for `task` and what the job paid, from a
 * JSON-RPC `getTransaction` answer in "jsonParsed" form; null unless the
 * transaction settles that job and its log holds the program's own record
 * of the payment. An event counts only when the marketplace program itself
 * logged it (any program can print look-alike bytes), and only when its job
 * id and `creator` give the address of `task`.
 */
export async function settlementFactsIn(
  value: unknown,
  task: Address,
  signature: string,
  creator: Address,
  includeFrozen = false,
): Promise<SettlementFacts | null> {
  const settlement = settlementIn(value, task, signature, includeFrozen);
  if (settlement === null) return null;
  const logs = record(record(value)?.meta)?.logMessages;
  if (!Array.isArray(logs) || !logs.every((line) => typeof line === "string")) return null;
  return settlementFactsFromLogs(logs as string[], task, settlement.worker, creator, settlement.operator, signature);
}

/**
 * What a settlement of `task` that paid `worker` logged: the job's whole
 * price and the fee, from the events the marketplace program itself logged
 * (see {@link settlementFactsIn}). Null when the log holds no such record.
 */
export async function settlementFactsFromLogs(
  logs: readonly string[],
  task: Address,
  worker: Address,
  creator: Address,
  operator?: Address,
  signature?: string,
): Promise<SettlementFacts | null> {
  const events = parseAgencCoordinationEvents(logs);
  for (const event of events) {
    if (event.eventName !== "RewardDistributed" || event.data.recipient !== worker) continue;
    const [paid] = await findTaskPda({ creator, taskId: event.data.taskId });
    if (paid !== task) continue;
    let shares = 0n;
    let operatorPayment: SettlementFacts["operatorPayment"];
    for (const other of events) {
      if (other.eventName === "OperatorFeePaid" && sameBytes(other.data.taskId, event.data.taskId))
        operatorPayment = { address: other.data.operator, paid: other.data.amount, forfeited: 0n, sellerNet: event.data.amount };
      if (other.eventName === "MarketplaceFeeForfeited" && other.data.role === 0 && sameBytes(other.data.taskId, event.data.taskId))
        operatorPayment = { address: other.data.payee, paid: 0n, forfeited: other.data.amount, sellerNet: event.data.amount };
      if (
        (other.eventName === "OperatorFeePaid" || other.eventName === "ReferrerFeePaid") &&
        sameBytes(other.data.taskId, event.data.taskId)
      ) {
        shares += other.data.amount;
      }
    }
    const priceLamports = event.data.amount + event.data.protocolFee + shares;
    // At one basis point or more, only a price below 10,000 can round to zero.
    // A shortened log could omit a later fee event. It cannot prove a zero leg.
    const unpaid = !operatorPayment && operator && priceLamports < 10_000n &&
      !logs.includes("Log truncated") && /^Program [1-9A-HJ-NP-Za-km-z]+ success$/u.test(logs.at(-1) ?? "");
    const updates = events.filter(e => e.eventName === "ReputationChanged" && e.data.reason === 0);
    let reputation: SettlementFacts["reputation"];
    // A transaction may settle multiple tasks for the same worker. Attribute
    // a change only when both the paid task and the reputation event are unique.
    if (!logs.includes("Log truncated") && events.filter(e => e.eventName === "RewardDistributed" && e.data.recipient === worker).length === 1) {
      const matches = [];
      for (const update of updates) {
        if (update.eventName === "ReputationChanged" && (await findAgentPda({ agentId: Uint8Array.from(update.data.agentId) }))[0] === worker)
          matches.push({ before: update.data.oldReputation, after: update.data.newReputation });
      }
      if (matches.length === 1) reputation = { ...matches[0]!, ...(signature && { signature }) };
    }
    return {
      worker,
      ...(reputation && { reputation }),
      ...(unpaid && { unpaidOperator: { address: operator, sellerNet: event.data.amount } }),
      ...(operatorPayment && { operatorPayment }),
      priceLamports,
      feeLamports: event.data.protocolFee,
      listing: null,
    };
  }
  return null;
}

/**
 * The service `task` was hired from, from the program's own hire event in a
 * transaction's log: only when it names this job, its buyer `creator` and
 * the agent `worker`. Null when the log holds no such event.
 */
export function hiredListingFromLogs(
  logs: readonly string[],
  task: Address,
  creator: Address,
  worker: Address,
): Address | null {
  for (const event of parseAgencCoordinationEvents(logs)) {
    if (event.eventName !== "ServiceListingHired") continue;
    const hire = event.data;
    if (hire.task === task && hire.buyer === creator && hire.providerAgent === worker) return hire.listing;
  }
  return null;
}

function logsOf(value: unknown): string[] | null {
  const answer = record(value);
  const meta = record(answer?.meta);
  if (meta === null || meta.err !== null) return null;
  const logs = meta.logMessages;
  return Array.isArray(logs) && logs.every((line) => typeof line === "string") ? (logs as string[]) : null;
}

/** How far back a job's history is read for the transaction that paid for it. */
export const SETTLEMENT_HISTORY_LIMIT = 20;

/** The parts of a JSON-RPC client the history read needs. */
export interface SettlementHistoryRpc {
  getSignaturesForAddress(
    address: Address,
    config: { limit: number; commitment: "confirmed"; before?: Signature },
  ): { send(): Promise<readonly { signature?: unknown; err?: unknown }[]> };
  getTransaction(
    signature: string,
    config: { commitment: "confirmed"; encoding: "jsonParsed"; maxSupportedTransactionVersion: 0 },
  ): { send(): Promise<unknown> };
}

/**
 * What the transaction that paid for finishing `task` says (see
 * {@link settlementFactsIn}), from the job's own recent history on the
 * chain, newest first. `creator` is the job's buyer, as its record or its
 * marker names it. Null when none of it settles the job. Throws when the
 * history cannot be read.
 */
export async function readSettlementFacts(
  rpc: SettlementHistoryRpc,
  task: Address,
  creator: Address,
  options: { listing?: boolean; limit?: number; includeFrozen?: boolean } = {},
): Promise<SettlementFacts | null> {
  const limit = options.limit ?? SETTLEMENT_HISTORY_LIMIT;
  const history = await rpc.getSignaturesForAddress(task, { limit, commitment: "confirmed" }).send();
  let facts: SettlementFacts | null = null;
  for (const entry of history) {
    if (typeof entry.signature !== "string" || entry.err !== null) continue;
    const transaction = await rpc
      .getTransaction(entry.signature, {
        commitment: "confirmed",
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0,
      })
      .send();
    if (facts === null) {
      facts = await settlementFactsIn(transaction, task, entry.signature, creator, options.includeFrozen);
      // Newest first: what was read before the settlement came after it.
      if (facts !== null && options.listing !== true) return facts;
      continue;
    }
    // The hire came before the settlement: its event names the service.
    const logs = logsOf(transaction);
    const listing = logs === null ? null : hiredListingFromLogs(logs, task, creator, facts.worker);
    if (listing !== null) return { ...facts, listing };
  }
  return facts;
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
