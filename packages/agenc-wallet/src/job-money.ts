// Use the decimal values that crossed the RPC boundary. Binary floating point
// can buy an extra lamport at a ceiling, even when both inputs look integral.
import { APPROVAL_FEE_LAMPORTS } from "./approval.js";
import { WalletError } from "./errors.js";
import { childHolds } from "./child-hire-store.js";
import type { AgentRecord } from "./store.js";

export type JobDeposits = { total: bigint; kept: bigint; networkFees: bigint; cancellationRent: bigint;
  /** Part of `kept`: the paying wallet's marketplace record, made and kept on its first job only. */
  firstRecordRent?: bigint };
export function jobNetworkFees(transactionFee: bigint): bigint {
  // Create, pin, pay or cancel, then tidy. Moderation supplies a separate
  // fixed two-signature transaction whose instructions the wallet validates.
  return 4n * transactionFee + APPROVAL_FEE_LAMPORTS;
}

function ratio(value: number): [bigint, bigint] {
  if (!Number.isFinite(value) || value <= 0) throw new WalletError("BAD_REQUEST", "Enter a positive dollar amount.");
  const [digits, exponent = "0"] = value.toString().split("e");
  const [whole, fraction = ""] = digits!.split(".");
  const scale = fraction.length - Number(exponent);
  return [BigInt(whole + fraction) * 10n ** BigInt(Math.max(0, -scale)), 10n ** BigInt(Math.max(0, scale))];
}

/** The exact decimal when the usual cent display would hide part of a quote. */
export function fractionalQuoteUsd(lamports: bigint, usdPerSol: number): string | undefined {
  const [rate, scale] = ratio(usdPerSol);
  const numerator = lamports * rate;
  const denominator = 1_000_000_000n * scale;
  if ((numerator * 100n) % denominator === 0n) return undefined;
  const fraction = (numerator % denominator).toString().padStart(denominator.toString().length - 1, "0").replace(/0+$/, "");
  return (numerator / denominator).toString() + "." + fraction;
}

export function ceilingLamports(cents: number, usdPerSol: number): bigint {
  const [cap, capScale] = ratio(cents);
  const [rate, rateScale] = ratio(usdPerSol);
  return cap * rateScale * 10_000_000n / (capScale * rate);
}

export function microcents(lamports: bigint, usdPerSol: number): bigint {
  const [rate, scale] = ratio(usdPerSol);
  const divisor = 10n * scale;
  return (lamports * rate + divisor - 1n) / divisor;
}

/** Unknown charges from an older wallet require approval until they age out. */
export function remainingJobMicrocents(agent: AgentRecord, now: number, except?: string, reviewFor?: string, rate?: number): bigint {
  let room = BigInt(agent.policy.refill.perDayCents) * 1_000_000n;
  const holds = childHolds(agent).childHolds;
  for (const [id, hold] of Object.entries(holds ?? {})) {
    if (id === except) continue;
    const alreadyCounted = hold.funded && agent.jobSpends?.some(entry => entry.id === id && entry.at > now - 86_400_000);
    const purchase = !hold.funded ? hold.purchase : alreadyCounted ? "0" : hold.futurePurchase ?? "0";
    room -= microcents((reviewFor === id ? 0n : BigInt(hold.review)) + BigInt(purchase), hold.rate);
  }
  let purchases = 0n;
  for (const entry of agent.jobSpends ?? []) {
    if (holds?.[entry.id]?.funded === false) continue;
    if (entry.id === except || entry.at <= now - 86_400_000) continue;
    if (entry.microcents === null) return 0n;
    purchases += BigInt(entry.microcents);
  }
  const pending = new Set<string>();
  for (const hold of Object.values(holds ?? {})) {
    for (const [signature, amount] of Object.entries(hold.pending ?? {})) {
      pending.add(signature);
      room -= microcents(BigInt(amount), hold.rate);
    }
  }
  let incoming = 0n;
  for (const charge of agent.refills) {
    if (charge.signature && pending.has(charge.signature)) continue;
    if (!charge.work && charge.ts <= now - 86_400_000) continue;
    // Refills move buying power from main to agent. Its later purchase spends
    // that same principal. Both the transfer limit and outgoing limit apply.
    const funding = !charge.work && (!charge.id || charge.id.startsWith("refill_"));
    if (funding && rate === undefined) continue;
    if (charge.usdCents === null || (charge.usdCents === undefined && !rate)) return 0n;
    const amount = charge.usdCents === undefined ? microcents(BigInt(charge.lamports), rate!)
      : BigInt(Math.round(charge.usdCents * 1_000_000));
    if (funding) incoming += amount;
    else room -= amount;
  }
  room -= incoming > purchases ? incoming : purchases;
  return room > 0n ? room : 0n;
}

/** How long after a restore an agent cannot spend on its own: the length of the allowance day. */
export const RESTORE_HOLD_MS = 86_400_000;
export const RESTORED_ALLOWANCE_TEXT = "This wallet was restored from a backup, so what this agent spent since the backup is not known. " +
  "For 24 hours after the restore it cannot spend on its own. You can approve each payment in Market.";

/**
 * A backup holds the allowance ledger of the moment it was made. After a restore
 * the agent may already have used today's allowance, so nothing it decides alone
 * is inside it until a full day has passed. The owner's own approvals are not affected.
 */
export function allowanceUnknown(agent: AgentRecord, now: number): boolean {
  return agent.allowanceUnknownUntil !== undefined && now < agent.allowanceUnknownUntil;
}

/** Called while a backup is put back, on the records it restores. */
export function holdRestoredAllowances(state: { agents?: Record<string, AgentRecord>; activity?: unknown[] }, now: number): void {
  const agents = Object.values(state.agents ?? {});
  for (const agent of agents) agent.allowanceUnknownUntil = now + RESTORE_HOLD_MS;
  if (agents.length && Array.isArray(state.activity)) state.activity.push({ id: "act_restore_" + now, ts: now, kind: "note",
    text: "Restored from a backup. Spending since the backup is not known, so for 24 hours every agent payment needs your approval.",
    lamports: null, agentId: null, jobId: null, signature: null });
}

/**
 * Called while a backup is put back. A job that was quoted or approved but not
 * yet funded in the backup may have been funded afterwards: mark it so the
 * wallet reads the chain before it quotes, declines, fails or sends it again.
 */
export function markRestoredJobs(state: { jobs?: Record<string, { role?: string; phase?: string; hiredAt?: number | null; hireAttemptAt?: number | null; fundingUnknown?: true }> }): void {
  for (const job of Object.values(state.jobs ?? {})) {
    if (job.role === "buying" && job.hiredAt == null && job.hireAttemptAt == null &&
        (job.phase === "needs_approval" || job.phase === "cleared" || job.phase === "hiring")) job.fundingUnknown = true;
  }
}

export function reserveJobSpend(agent: AgentRecord, id: string, charge: bigint, price: bigint, now: number, ownerApproved: boolean): boolean {
  if (!ownerApproved && allowanceUnknown(agent, now)) return false;
  if (!ownerApproved && (price > BigInt(agent.policy.askAboveCents) * 1_000_000n ||
      charge > remainingJobMicrocents(agent, now, id))) return false;
  const recent = (agent.jobSpends ?? []).filter(entry => entry.at > now - 86_400_000 && entry.id !== id);
  agent.jobSpends = [...recent, { id, at: now, microcents: charge.toString() }];
  return true;
}
