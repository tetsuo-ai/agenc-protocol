// Stock revision 9 extends the shared task clock for every request, and only
// the reviewed worker's claim clock. Both accounts may be gone at read time.
import { AccountRole, signature, type Address } from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS, AgencCoordinationInstruction as Ix, findClaimPda, findTaskPda,
  parseAgencCoordinationEvents, parseAgencCoordinationInstruction, values,
} from "@tetsuo-ai/marketplace-sdk";
import { resubmissionDeadline, reviewRead } from "./review.js";
import type { HistoryTransaction, ReviewAnchor } from "./review-history.js";
import { sentInstruction, type SettlementHistoryRpc } from "./settlement.js";

type Events = ReturnType<typeof parseAgencCoordinationEvents>;

function dependentDeadline(tx: HistoryTransaction, task: Address): bigint | null {
  // The dependent creation event omits the deadline. Its signed instruction carries it.
  const instructions = [...(tx.transaction?.message?.instructions ?? []),
    ...(tx.meta?.innerInstructions ?? []).flatMap(group => group.instructions)];
  for (const raw of instructions) {
    const ix = sentInstruction(raw);
    if (ix?.programAddress !== AGENC_COORDINATION_PROGRAM_ADDRESS || ix.accounts[0] !== task) continue;
    const parsed = parseAgencCoordinationInstruction({ ...ix, accounts: ix.accounts.map(address => ({ address, role: AccountRole.READONLY })) });
    if (parsed.instructionType === Ix.CreateDependentTask) return parsed.data.deadline;
  }
  return null;
}

interface Creation { taskId: Uint8Array; deadline: bigint; claimDuration: bigint }

async function replay(creation: Creation, newestFirst: Events[], task: Address, claim: Address, change: ReviewAnchor) {
  let taskDue = creation.deadline;
  let claimDue: bigint | null = null;
  const submissions = new Map<Address, { round: number; window: bigint }>();
  const decision = newestFirst[0];
  for (const events of newestFirst.reverse()) {
    for (const event of events) {
      if (event.eventName === "TaskClaimed" && Buffer.from(event.data.taskId).equals(creation.taskId) &&
          (await findClaimPda({ task, bidder: event.data.worker }))[0] === claim) {
        // claim_task and the bid path both add one hour to a fixed task deadline.
        claimDue = taskDue > 0n ? taskDue + 3600n : event.data.timestamp + creation.claimDuration;
      } else if (event.eventName === "TaskResultSubmitted" && event.data.task === task) {
        submissions.set(event.data.claim, { round: event.data.submissionCount, window: event.data.reviewDeadlineAt - event.data.submittedAt });
      } else if (event.eventName === "TaskChangesRequested" && event.data.task === task) {
        const { claim: reviewed, round, timestamp } = event.data;
        const submission = submissions.get(reviewed);
        if (!submission || submission.round !== round || submission.window <= 0n) return null;
        const due = timestamp + (submission.window > values.MIN_RESUBMIT_WINDOW_SECS ? submission.window : values.MIN_RESUBMIT_WINDOW_SECS);
        if (taskDue > 0n && taskDue < due) taskDue = due;
        if (reviewed !== claim) continue;
        if (claimDue === null) return null;
        if (claimDue < due) claimDue = due;
        // Only the requested receipt can establish this deadline, even if a claim address was reused.
        if (events === decision && round === change.round && Number(timestamp) * 1000 === change.at) {
          const seconds = resubmissionDeadline(taskDue, claimDue);
          return seconds === null ? null : seconds * 1000;
        }
      }
    }
  }
  return null;
}

export async function closedRevisionDeadline(rpc: SettlementHistoryRpc, task: Address, claim: Address, change: ReviewAnchor,
  // Offline stock receipts use initialize_protocol's immutable seven-day default.
  claimDuration = async () => 7n * 86400n): Promise<number | null> {
  let before = signature(change.signature);
  let rows: readonly { signature?: unknown; err?: unknown }[] = [{ signature: before, err: null }];
  const batches: Events[] = [];
  const until = performance.now() + 2400;
  while (performance.now() < until) {
    const receipts = await Promise.all(rows.filter(row => row.err === null).map(async row => {
      if (typeof row.signature !== "string") return null;
      const tx = await reviewRead(rpc.getTransaction(row.signature, {
        encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0,
      }).send(), 800) as HistoryTransaction | null;
      const logs = tx?.meta?.logMessages;
      if (tx?.meta?.err !== null || tx.transaction?.signatures?.[0] !== row.signature ||
          !logs?.length || logs.some(line => line.startsWith("Log truncated"))) return null;
      return { tx, events: parseAgencCoordinationEvents(logs) };
    }));
    for (const receipt of receipts) {
      if (!receipt) return null;
      batches.push(receipt.events);
      for (const event of receipt.events) {
        if (event.eventName !== "TaskCreated" && event.eventName !== "DependentTaskCreated") continue;
        const taskId = Uint8Array.from(event.data.taskId);
        if ((await findTaskPda({ creator: event.data.creator, taskId }))[0] !== task) continue;
        const deadline = event.eventName === "TaskCreated" ? event.data.deadline : dependentDeadline(receipt.tx, task);
        if (deadline === null) return null;
        const duration = deadline > 0n ? 0n : await reviewRead(claimDuration(), 800);
        if (duration === null || (deadline <= 0n && duration <= 0n)) return null;
        return replay({ taskId, deadline, claimDuration: duration }, batches, task, claim, change);
      }
    }
    const page = await reviewRead(rpc.getSignaturesForAddress(task, { limit: 32, commitment: "confirmed", before }).send(), 800);
    const next = page?.at(-1)?.signature;
    if (!page || page.some(row => row.err === undefined) || typeof next !== "string" || next === before) return null;
    before = signature(next);
    rows = page;
  }
  return null;
}
