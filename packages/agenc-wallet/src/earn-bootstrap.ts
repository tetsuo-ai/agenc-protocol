import { lstatSync, readFileSync, watch } from "node:fs";
import path from "node:path";
import { liveRoomSelection, type LiveRoom } from "./room-selection.js";
import { WalletError } from "./errors.js";
import type { EarnOptions } from "./earn.js";

export interface Bootstrap {
  unlockSecret: string;
  ownerToken: string;
  earn?: {
    executor: { argv: string[]; mode: string; isolatedJobRoom?: boolean; reserveRevisionBudget?: boolean; envAllowlist?: string[]; timeoutMs?: number; readiness?: { argv: string[]; timeoutMs?: number } } | null;
    defaultRoomSetting?: string;
    liveRoom?: LiveRoom;
    conditionalRoom?: { setting: string; when?: "core"; executor: NonNullable<NonNullable<Bootstrap["earn"]>["executor"]> };
    maxRewardLamports?: string | null;
    /** Take jobs only from this wallet's own addresses. */
    ownJobsOnly?: boolean;
    /** Path of Desktop's non-secret earning preference, supplied only at bootstrap. */
    chosenRoomSetting?: string;
    /** A different executor for named agents (a seller paired with a remote room). */
    agentExecutors?: Record<string, NonNullable<NonNullable<Bootstrap["earn"]>["executor"]>>;
  } | null;
  hosted?: {
    siteUrl?: string;
    attestUrl?: string;
    artifactBaseUrl?: string | null;
    artifactUploadUrl?: string | null;
  };
  /** Priority fee in micro-lamports per compute unit. */
  computeUnitPrice?: string;
  /**
   * The person's own Solana RPC endpoint. It often carries an API key, so a
   * host hands it over here, on stdin, and never as a flag another process
   * could read. `--rpc-url` wins when both are given.
   */
  rpcUrl?: string;
  /** Play money given to an empty main balance in the sandbox. */
  practiceLamports?: string;
}

export function earnOptions(bootstrap: Bootstrap): EarnOptions {
  const conditional = bootstrap.earn?.conditionalRoom;
  if (conditional !== undefined && (bootstrap.earn?.executor != null || !conditional ||
      typeof conditional.setting !== "string" || !path.isAbsolute(conditional.setting) ||
      (conditional.when !== undefined && conditional.when !== "core") ||
      conditional.executor?.mode !== "sandboxed" || conditional.executor.isolatedJobRoom !== true ||
      !conditional.executor.readiness)) throw new WalletError("BAD_REQUEST", "The selected room needs an isolated executor and a readiness check.");
  const executor = conditional?.executor ?? bootstrap.earn?.executor ?? null;
  const parseExecutor = (): EarnOptions["executor"] => {
  if (executor === null) return null;
  if (
    !Array.isArray(executor.argv) ||
    executor.argv.length === 0 ||
    executor.argv.some((part) => typeof part !== "string") ||
    !executor.argv.includes("{prompt}")
  ) {
    throw new WalletError(
      "BAD_REQUEST",
      'The earn executor needs an argv list that includes "{prompt}".',
    );
  }
  if (executor.mode !== "sandboxed" && executor.mode !== "safe" && executor.mode !== "unsafe") {
    throw new WalletError("BAD_REQUEST", "The earn executor mode is not valid.");
  }
  const readiness = executor.readiness;
  if (readiness !== undefined && (
    readiness === null || typeof readiness !== "object" ||
    !Array.isArray(readiness.argv) || readiness.argv.length === 0 ||
    readiness.argv.some((part) => typeof part !== "string" || part.includes("{prompt}")) ||
    (readiness.timeoutMs !== undefined && (!Number.isSafeInteger(readiness.timeoutMs) || readiness.timeoutMs <= 0 || readiness.timeoutMs > 120_000))
  )) {
    throw new WalletError("BAD_REQUEST", "The readiness self-test needs an argv list and a timeout of at most 120 seconds.");
  }
  return {argv:executor.argv, mode:executor.mode, envAllowlist:executor.envAllowlist ?? [],
    isolatedJobRoom:executor.isolatedJobRoom === true, reserveRevisionBudget:executor.reserveRevisionBudget === true,
    timeoutMs:executor.timeoutMs ?? 15 * 60_000, ...(readiness && { readiness })};
  };
  const live = bootstrap.earn?.liveRoom && liveRoomSelection(bootstrap.earn.liveRoom);
  const maxReward = bootstrap.earn?.maxRewardLamports;
  const chosenRoomSetting = bootstrap.earn?.chosenRoomSetting;
  const selection = bootstrap.earn?.defaultRoomSetting ?? conditional?.setting;
  if (selection !== undefined && (typeof selection !== "string" || !path.isAbsolute(selection)))
    throw new WalletError("BAD_REQUEST", "The room selection needs a host path.");
  return {
    executor: parseExecutor(),
    ...(conditional && { defaultExecutorEnabled: () => {
      // Only the presence of the host setting matters. Its contents stay with the host.
      try { return lstatSync(conditional.setting).isFile() && conditional.when !== "core"; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" && conditional.when === "core"; }
    } }),
    ...(selection && { defaultExecutorGeneration: () => {
      // Read the public epoch. Only stat the encrypted slot. A switch away and back has a new epoch.
      let epoch = "legacy", slot = "core";
      try {
        epoch = readFileSync(selection + ".epoch", "utf8");
        if (!/^[0-9a-f-]{36}$/.test(epoch)) throw new Error("The job room selection is changing.");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      try {
        const stat = lstatSync(selection, {bigint:true});
        slot = [stat.dev, stat.ino, stat.ctimeNs].join("-");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      return epoch + "/" + slot;
    } }),
    ...(live && {liveRoomState:live, defaultExecutorEnabled:()=>live().ready, defaultExecutorGeneration:()=>live().generation}),
    ...(maxReward === undefined
      ? {}
      : { maxRewardLamports: maxReward === null ? null : BigInt(maxReward) }),
    ...(typeof chosenRoomSetting === "string" && path.isAbsolute(chosenRoomSetting)
      ? { watchChosenRoom: (revoke: () => void) => {
        const watcher = watch(path.dirname(chosenRoomSetting), (_event, file) => {
          if (!file || file === path.basename(chosenRoomSetting)) revoke();
        });
        watcher.on("error", revoke);
        return () => watcher.close();
      }, chosenRoomEnabled: () => {
        try {
          return JSON.parse(readFileSync(chosenRoomSetting, "utf8"))?.takeJobsFromOthers === true;
        } catch { return false; }
      } } : {}),
    ...(bootstrap.earn?.ownJobsOnly === true ? { ownJobsOnly: true } : {}),
  };
}

