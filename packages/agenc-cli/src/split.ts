// THE PAYOFF: the settlement rendered as a 4-way split table with REAL
// lamport deltas read from the chain (worker / operator / referrer /
// protocol treasury), percentages of the escrowed reward, and the receipt
// note. Pure formatting — the deltas come from balance snapshots around the
// settlement transaction.

export interface SettlementLeg {
  /** e.g. "worker", "operator", "referrer", "protocol treasury". */
  label: string;
  /** Payee address (base58). */
  address: string;
  /** Lamports this payee gained in the settlement transaction. */
  deltaLamports: bigint;
}

const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Format lamports as a SOL decimal string (full precision, trimmed). */
export function lamportsToSol(lamports: bigint): string {
  const negative = lamports < 0n;
  const abs = negative ? -lamports : lamports;
  const whole = abs / LAMPORTS_PER_SOL;
  const frac = (abs % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/u, "");
  const body = frac.length > 0 ? `${whole}.${frac}` : whole.toString();
  return negative ? `-${body}` : body;
}

/** Percentage of `reward` with 2 decimal places (bigint-safe). */
export function percentOfReward(delta: bigint, reward: bigint): string {
  if (reward === 0n) return "0.00%";
  const scaled = (delta * 10_000n) / reward; // basis points
  const whole = scaled / 100n;
  const frac = (scaled % 100n).toString().padStart(2, "0");
  return `${whole}.${frac}%`;
}

function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * Render the 4-way split as an aligned table. `rewardLamports` is the
 * escrowed listing price the legs are measured against; the worker's delta
 * can exceed `reward - fees` because settlement also refunds the worker's
 * claim/submission account rents (a footnote is added when it does).
 */
export function formatSplitTable(
  legs: SettlementLeg[],
  rewardLamports: bigint,
): string {
  const rows = legs.map((leg) => ({
    label: leg.label,
    address: shortAddress(leg.address),
    lamports: leg.deltaLamports.toString(),
    sol: lamportsToSol(leg.deltaLamports),
    pct: percentOfReward(leg.deltaLamports, rewardLamports),
  }));
  const total = legs.reduce((sum, leg) => sum + leg.deltaLamports, 0n);
  rows.push({
    label: "total",
    address: "",
    lamports: total.toString(),
    sol: lamportsToSol(total),
    pct: percentOfReward(total, rewardLamports),
  });

  const headers = { label: "leg", address: "payee", lamports: "Δ lamports", sol: "Δ SOL", pct: "% of reward" };
  const widths = {
    label: Math.max(headers.label.length, ...rows.map((r) => r.label.length)),
    address: Math.max(headers.address.length, ...rows.map((r) => r.address.length)),
    lamports: Math.max(headers.lamports.length, ...rows.map((r) => r.lamports.length)),
    sol: Math.max(headers.sol.length, ...rows.map((r) => r.sol.length)),
    pct: Math.max(headers.pct.length, ...rows.map((r) => r.pct.length)),
  };
  const line = (r: typeof headers): string =>
    `  ${r.label.padEnd(widths.label)}  ${r.address.padEnd(widths.address)}  ` +
    `${r.lamports.padStart(widths.lamports)}  ${r.sol.padStart(widths.sol)}  ${r.pct.padStart(widths.pct)}`;
  const divider = `  ${"-".repeat(widths.label)}  ${"-".repeat(widths.address)}  ${"-".repeat(widths.lamports)}  ${"-".repeat(widths.sol)}  ${"-".repeat(widths.pct)}`;

  const out = [line(headers), divider];
  for (const row of rows.slice(0, -1)) out.push(line(row));
  out.push(divider);
  out.push(line(rows[rows.length - 1]!));
  if (total > rewardLamports) {
    out.push(
      `  (total > reward: settlement also refunds the worker's claim/submission account rents)`,
    );
  }
  return out.join("\n");
}
