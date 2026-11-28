import { runExecutor } from "@tetsuo-ai/agenc-worker";
import { admissionArgs, commandGeneration } from "./room-selection.js";
import type { EarnExecutor, EarnOptions } from "./earn.js";
import { WalletError } from "./errors.js";
import type { WalletState } from "./store.js";

/** Pre-funding readiness uses the pinned host probe with no worker text. */
export async function checkBusinessRoom(
  options: EarnOptions | undefined,
  agentId: string,
  resolve: () => EarnExecutor | null = () =>
    options?.agentExecutors?.[agentId] ?? options?.executor ?? null,
) {
  const executor = resolve();
  const generation = () =>
    JSON.stringify([
      options?.agentExecutors?.[agentId]
        ? ""
        : options?.defaultExecutorGeneration?.(),
      executor && commandGeneration(executor.argv, executor.readiness?.argv),
    ]);
  const before = generation();
  if (executor?.mode !== "sandboxed" || options?.chosenRoomEnabled?.() !== true)
    throw new WalletError(
      "NOT_AVAILABLE",
      "Enable the isolated job room on this device first.",
    );
  let hostCheck: void | (() => void);
  if (options.checkExecutionReady)
    hostCheck = await options.checkExecutionReady({ agentId });
  else {
    const { readiness, envAllowlist } = executor;
    if (!readiness)
      throw new WalletError(
        "NOT_AVAILABLE",
        "The room self-test is unavailable.",
      );
    await runExecutor({
      argv: [...readiness.argv.map((arg) =>
        arg === "{roomCore}"
          ? (options.liveRoomState?.().coreCommand ?? "room-agent")
          : arg.replaceAll("{agent}", agentId),
      ), ...admissionArgs(readiness.argv,options.liveRoomState?.())],
      timeoutMs: readiness.timeoutMs ?? 30_000,
      envAllowlist,
      maxStdoutBytes: 65536,
    });
  }
  const current = () => {
    if (hostCheck) hostCheck();
    if (
      !options.chosenRoomEnabled?.() ||
      resolve() !== executor ||
      generation() !== before
    )
      throw new WalletError(
        "NOT_AVAILABLE",
        "Room permission changed during the check.",
      );
  };
  current();
  return current;
}

/** Seller state from before the restore, or still open on this device. A buyer only never needs the room. */
export function restoredSeller(
  state: WalletState,
  agentId: string,
  openClaim: boolean,
): boolean {
  const agent = state.agents[agentId];
  if (!agent) return false;
  const sellers = state.businessRecovery?.sellers ?? [];
  return (
    openClaim ||
    sellers.includes(agentId) ||
    Boolean(
      agent.earn?.offer ||
      agent.earn?.offers?.length ||
      agent.earn?.pendingListingSends?.length,
    )
  );
}
