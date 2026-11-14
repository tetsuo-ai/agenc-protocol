// Money and time, written the way a person says them.
import type { Money } from "./types.js";

const LAMPORTS_PER_SOL = 1_000_000_000n;

/** "$1.42", "$0.05", "less than $0.01". */
export function formatUsd(cents: number): string {
  if (!Number.isFinite(cents)) return "$0.00";
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  if (absolute > 0 && absolute < 1) return negative ? "-less than $0.01" : "less than $0.01";
  const whole = Math.floor(absolute / 100);
  const part = Math.round(absolute - whole * 100);
  const carried = part === 100 ? whole + 1 : whole;
  const fraction = part === 100 ? 0 : part;
  const grouped = String(carried).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${grouped}.${String(fraction).padStart(2, "0")}`;
}

/** "0.005 SOL": up to six decimals, trailing zeros dropped. */
export function formatSol(lamports: string | bigint): string {
  let value: bigint;
  try {
    value = typeof lamports === "bigint" ? lamports : BigInt(lamports);
  } catch {
    return "0 SOL";
  }
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / LAMPORTS_PER_SOL;
  // Round to six decimals (1000 lamports).
  const micro = (absolute % LAMPORTS_PER_SOL + 500n) / 1000n;
  const carriedWhole = micro === 1_000_000n ? whole + 1n : whole;
  const fraction = micro === 1_000_000n ? 0n : micro;
  const digits = fraction.toString().padStart(6, "0").replace(/0+$/, "");
  const body = digits.length > 0 ? `${carriedWhole}.${digits}` : `${carriedWhole}`;
  return `${negative ? "-" : ""}${body} SOL`;
}

/** Dollars when a price is known, SOL otherwise. */
export function formatMoney(money: Money): string {
  return money.usdCents === null ? formatSol(money.lamports) : formatUsd(money.usdCents);
}

/** "in 4 minutes", "in 2 hours", "any moment now". */
export function formatWait(untilMs: number, nowMs: number): string {
  const seconds = Math.round((untilMs - nowMs) / 1000);
  if (seconds <= 20) return "any moment now";
  if (seconds < 90) return "in about a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours === 1 ? "in about an hour" : `in ${hours} hours`;
  const days = Math.round(hours / 24);
  return `in ${days} days`;
}

/** "5 minutes", "2 hours", "3 days" for a delivery promise. */
export function formatDuration(seconds: number): string {
  if (seconds < 90) return "a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours === 1 ? "an hour" : `${hours} hours`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}
