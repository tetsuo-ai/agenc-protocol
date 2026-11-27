import {
  accessSync,
  constants,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { executablePath, ExecutorCapabilityError } from "@tetsuo-ai/agenc-worker";
import { basename, dirname, isAbsolute, join } from "node:path";

export interface LiveRoom {
  setting: string;
  keyStore: string;
  coreCandidates: readonly string[];
  baseFiles: readonly string[];
  agentFiles: readonly string[];
  generationFiles?: readonly string[];
  managedSettingsRoot?: string;
}
export interface RoomSelection {
  agent: string;
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

export function checkNamedProgram(argv: readonly string[]) {
  const [command, script, mode] = argv;
  if (!command || !executablePath(command))
    throw new ExecutorCapabilityError("The named job program is unavailable.");
  const interpreter = /^(?:node|nodejs|python[\d.]*|bash|sh|electron)(?:\.exe)?$/i.test(basename(command));
  if (!script || script.startsWith("-") || (!interpreter && mode !== "job" && mode !== "peer-job")) return;
  try {
    if (!isAbsolute(script) || !statSync(script).isFile()) throw new Error();
    accessSync(script, constants.R_OK);
  } catch {
    throw new ExecutorCapabilityError("The named job script is unavailable.");
  }
}

// Named executors own their program, script and readiness command independently of the default.
export function commandGeneration(
  argv: readonly string[],
  probe: readonly string[] = [],
): string {
  const commands = [argv,probe].flatMap(parts => parts[0] ? [executablePath(parts[0]) ?? parts[0], ...parts.slice(1,2).filter(isAbsolute)] : []);
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
      ...(room.generationFiles ?? []),
      ...(room.managedSettingsRoot ? [room.managedSettingsRoot] : []),
    ].every((p) => typeof p === "string" && isAbsolute(p)) ||
    !room.baseFiles.length ||
    !room.agentFiles.length
  )
    throw new Error("Invalid job room paths.");
  return () => {
    const slot = file(room.setting);
    const base = room.baseFiles.map(file),
      agentFiles = room.agentFiles.map(file),
      commands = room.coreCandidates.map(file);
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
    const agent = slot.id === "missing" ? "core" : "claude-code";
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
    let managed = false;
    if (room.managedSettingsRoot) {
      try {
        const config = join(room.managedSettingsRoot,"config.toml");
        const drop = join(room.managedSettingsRoot,"config.d");
        const occupied = (path: string) => {
          try { return lstatSync(path); }
          catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
        };
        const directory = occupied(drop);
        managed = !!occupied(config) || !!directory && (!directory.isDirectory() || readdirSync(drop).length > 0);
      } catch { managed = true; }
    }
    const ready =
      !managed && keysStable &&
      (epoch === "legacy" || /^[0-9a-f-]{36}$/.test(epoch)) &&
      base.every((f) => f.regular) &&
      (agent === "core"
        ? !!coreCommand
        : slot.regular && agentFiles.every((f) => f.regular));
    let refusals: string[] = [];
    if (slot.regular)
      refusals = readdirSync(dirname(room.setting))
        .filter((n) => {
          if (/^\.paid-agent-(denied|refused)\./.test(n)) return true;
          if (!/^\.paid-agent-claim\.[a-f0-9]{64}\.[a-f0-9]{64}$/.test(n)) return false;
          const marker = readFileSync(join(dirname(room.setting),n),"utf8");
          return !isAbsolute(marker) || file(marker).regular;
        })
        .sort();
    const generation = JSON.stringify([
      epoch,
      keysEpoch,
      managed,
      refusals,
      slot.id,
      file(room.keyStore).id,
      coreCommand,
      commands,
      base,
      agentFiles,
      room.generationFiles?.map(file),
    ]);
    return { agent, ready, coreCommand, generation };
  };
}
