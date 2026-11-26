// Per-agent job executors. A host may run one seller's jobs somewhere else
// (a remote room the owner paired with that seller). Every agent the host
// did not name keeps the shared executor, so pairing one seller never
// changes how another seller works.
import type { EarnExecutor, EarnOptions } from "./earn.js";
import { WalletError } from "./errors.js";

const AGENT_ID = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Add the host's per-agent executors to `options`. `check` validates each
 * one exactly like the shared executor and throws on a bad one.
 */
export function withAgentExecutors(
  options: EarnOptions,
  named: unknown,
  check: (executor: object) => EarnExecutor | null,
): EarnOptions {
  if (named === undefined || named === null) return options;
  if (typeof named !== "object" || Array.isArray(named)) {
    throw new WalletError("BAD_REQUEST", "The per-agent executors are not valid.");
  }
  const agentExecutors: Record<string, EarnExecutor> = {};
  for (const [agentId, executor] of Object.entries(named as Record<string, unknown>)) {
    if (!AGENT_ID.test(agentId) || executor === null || typeof executor !== "object" || Array.isArray(executor)) {
      throw new WalletError("BAD_REQUEST", "The per-agent executors are not valid.");
    }
    const checked = check(executor);
    if (checked !== null) agentExecutors[agentId] = checked;
  }
  return Object.keys(agentExecutors).length === 0 ? options : { ...options, agentExecutors };
}
