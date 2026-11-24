import { runExecutor } from "@tetsuo-ai/agenc-worker";
import type { EarnOptions } from "./earn.js";
import { WalletError } from "./errors.js";
import type { WalletState } from "./store.js";

/** Pre-funding readiness uses the pinned host probe with no worker text. */
export async function checkBusinessRoom(
  options: EarnOptions | undefined,
  agentId: string,
) {
  if (
    options?.executor?.mode !== "sandboxed" ||
    options.chosenRoomEnabled?.() !== true
  )
    throw new WalletError(
      "NOT_AVAILABLE",
      "Enable the isolated job room on this device first.",
    );
  if (options.checkExecutionReady)
    await options.checkExecutionReady({ agentId });
  else {
    const { readiness, envAllowlist } = options.executor;
    if (!readiness)
      throw new WalletError(
        "NOT_AVAILABLE",
        "The room self-test is unavailable.",
      );
    await runExecutor({
      argv: readiness.argv.map((arg) => arg.replaceAll("{agent}", agentId)),
      timeoutMs: readiness.timeoutMs ?? 30_000,
      envAllowlist,
      maxStdoutBytes: 65536,
    });
  }
  if (!options.chosenRoomEnabled())
    throw new WalletError(
      "NOT_AVAILABLE",
      "Room permission changed during the check.",
    );
}

/** Seller state from before the restore, or still open on this device. A buyer only never needs the room. */
export function restoredSeller(state: WalletState, agentId: string, openClaim: boolean): boolean {
  const agent = state.agents[agentId];
  if (!agent) return false;
  const sellers = state.businessRecovery?.sellers ?? [];
  return (
    openClaim ||
    sellers.includes(agentId) ||
    Boolean(agent.earn?.offer || agent.earn?.offers?.length || agent.earn?.pendingListingSends?.length)
  );
}
