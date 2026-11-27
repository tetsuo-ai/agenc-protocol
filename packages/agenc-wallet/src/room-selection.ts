import {
  accessSync,
  constants,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";

export interface LiveRoom {
  setting: string;
  keyStore: string;
  coreCandidates: readonly string[];
  baseFiles: readonly string[];
  agentFiles: readonly string[];
  codexFiles?: readonly string[];
  codexPlanMinimumCents?: number;
  generationFiles?: readonly string[];
}
export interface RoomSelection {
  agent: "core" | "claude-code" | "codex-api" | "codex-plan";
  minimumModelCents?: number;
  ready: boolean;
  coreCommand: string | null;
  generation: string;
}

function file(path: string) {
  try {
    const link = lstatSync(path, { bigint: true });
    const stat = link.isSymbolicLink()
      ? statSync(path, { bigint: true })
      : link;
    return {
      regular: stat.isFile(),
      id: [
        link.ino,
        link.ctimeNs,
        stat.dev,
        stat.ino,
        stat.ctimeNs,
        stat.mode,
        stat.size,
      ].join("/"),
    };
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "ENOENT" &&
      (error as NodeJS.ErrnoException).code !== "ENOTDIR"
    )
      throw error;
    return { regular: false, id: "missing" };
  }
}

// Named executors own their program, script and readiness command independently of the default.
export function commandGeneration(
  argv: readonly string[],
  probe: readonly string[] = [],
): string {
  const commands = [...argv.slice(0, 2), ...probe.slice(0, 2)].filter(
    isAbsolute,
  );
  // The paired executor authenticates with this profile. Only its file identity is needed.
  if (probe[2] === "peer-ready" && probe[3] && isAbsolute(probe[3])) commands.push(probe[3]);
  return JSON.stringify(commands.map(file));
}

export function liveRoomSelection(room: LiveRoom): () => RoomSelection {
  if (
    ![
      room.setting,
      room.keyStore,
      ...room.coreCandidates,
      ...room.baseFiles,
      ...room.agentFiles,
      ...(room.codexFiles ?? []),
      ...(room.generationFiles ?? []),
    ].every((p) => typeof p === "string" && isAbsolute(p)) ||
    !room.baseFiles.length ||
    !room.agentFiles.length ||
    (room.codexPlanMinimumCents !== undefined &&
      (!Number.isSafeInteger(room.codexPlanMinimumCents) || room.codexPlanMinimumCents < 1))
  )
    throw new Error("Invalid job room paths.");
  return () => {
    const slot = file(room.setting);
    let agent: RoomSelection["agent"] = slot.id === "missing" ? "core" : "claude-code";
    let validSlot = slot.regular;
    if (slot.regular && room.codexFiles !== undefined) {
      try {
        // Desktop seals the login. The wallet needs only the public choice in the envelope.
        const choice: unknown = JSON.parse(readFileSync(room.setting, "utf8")).agent;
        if (choice === "codex-api" || choice === "codex-plan" || choice === "claude-code") agent = choice;
        else validSlot = false;
      } catch { validSlot = false; }
    }
    const codex = agent === "codex-api" || agent === "codex-plan";
    const agentFiles = (codex ? room.codexFiles ?? [] : room.agentFiles).map(file);
    const base = room.baseFiles.map(file), commands = room.coreCandidates.map(file);
    const coreCommand =
      room.coreCandidates.find((p, i) => {
        if (!commands[i]?.regular) return false;
        try {
          accessSync(p, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      }) ?? null;
    const epochPath = room.setting + ".epoch";
    const epoch = file(epochPath).regular
      ? readFileSync(epochPath, "utf8")
      : "legacy";
    const keysEpochPath = room.keyStore + ".epoch";
    const keysEpoch = file(keysEpochPath).regular
      ? readFileSync(keysEpochPath, "utf8")
      : "legacy";
    const keysStable =
      agent !== "core" ||
      keysEpoch === "legacy" ||
      /^[0-9a-f-]{36}$/.test(keysEpoch);
    const ready =
      keysStable &&
      (epoch === "legacy" || /^[0-9a-f-]{36}$/.test(epoch)) &&
      base.every((f) => f.regular) &&
      (agent === "core"
        ? !!coreCommand
        : validSlot && agentFiles.length > 0 && agentFiles.every((f) => f.regular) &&
          (agent !== "codex-plan" || room.codexPlanMinimumCents !== undefined));
    let refusals: string[] = [];
    if (slot.regular)
      refusals = readdirSync(dirname(room.setting))
        .filter((n) => /^\.paid-agent-(denied|refused)\./.test(n))
        .sort();
    const generation = JSON.stringify([
      epoch,
      keysEpoch,
      refusals,
      slot.id,
      file(room.keyStore).id,
      coreCommand,
      commands,
      base,
      agentFiles,
      room.generationFiles?.map(file),
    ]);
    return { agent, ready, coreCommand, generation,
      ...(agent === "codex-plan" && room.codexPlanMinimumCents !== undefined && {minimumModelCents:room.codexPlanMinimumCents}) };
  };
}
