// Use the decimal values that crossed the RPC boundary. Binary floating point
// can buy an extra lamport at a ceiling, even when both inputs look integral.
import { APPROVAL_FEE_LAMPORTS } from "./approval.js";
import { WalletError } from "./errors.js";
import type { AgentRecord } from "./store.js";

export type JobDeposits = { total: bigint; kept: bigint; networkFees: bigint; cancellationRent: bigint };
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
export function remainingJobMicrocents(agent: AgentRecord, now: number, except?: string): bigint {
  let room = BigInt(agent.policy.refill.perDayCents) * 1_000_000n;
  for (const entry of agent.jobSpends ?? []) {
    if (entry.id === except || entry.at <= now - 86_400_000) continue;
    if (entry.microcents === null) return 0n;
    room -= BigInt(entry.microcents);
  }
  return room > 0n ? room : 0n;
}

export function reserveJobSpend(agent: AgentRecord, id: string, charge: bigint, price: bigint, now: number, ownerApproved: boolean): boolean {
  if (!ownerApproved && (price > BigInt(agent.policy.askAboveCents) * 1_000_000n ||
      charge > remainingJobMicrocents(agent, now, id))) return false;
  const recent = (agent.jobSpends ?? []).filter(entry => entry.at > now - 86_400_000 && entry.id !== id);
  agent.jobSpends = [...recent, { id, at: now, microcents: charge.toString() }];
  return true;
}
