/**
 * The log line for a job the wallet cannot fund (rt6-a: it stopped at
 * "... fee headroom 1000000. Fund ", so the address and the amount to add
 * were lost). The worker's reason is said whole, up to a bound that a
 * whole funding sentence fits in; a longer one is cut at its last full stop.
 */
export const FUNDING_SHORT_REASON_MAX = 1200;

export function fundingShortLogLine(agentId: string, task: string, reason: unknown): string {
  const text = String(reason ?? "");
  let said = text;
  if (text.length > FUNDING_SHORT_REASON_MAX) {
    const cut = text.slice(0, FUNDING_SHORT_REASON_MAX);
    const end = cut.lastIndexOf(". ");
    said = end > 0 ? cut.slice(0, end + 1) : cut;
  }
  return `earn ${agentId}: cannot fund ${task}: ${said}`;
}
