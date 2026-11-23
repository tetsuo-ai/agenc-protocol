import { runExecutor } from "@tetsuo-ai/agenc-worker";
import type { EarnOptions } from "./earn.js";
import { WalletError } from "./errors.js";

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
