import {
  accessSync,
  constants,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";

export interface FirstCallPrice {
  baseTicks: number;
  inputTicksPerByte: number;
  needsExpiry?: boolean;
}

export interface LiveRoom {
  setting: string;
  keyStore: string;
  coreCandidates: readonly string[];
  baseFiles: readonly string[];
  agentFiles: readonly string[];
  acpFiles?: readonly string[];
  acpPrices?: Record<string, FirstCallPrice>;
  generationFiles?: readonly string[];
}
export interface RoomSelection {
  agent: "core" | "claude-code" | "acp";
  firstCall?: FirstCallPrice;
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
      ...(room.acpFiles ?? []),
      ...(room.generationFiles ?? []),
    ].every((p) => typeof p === "string" && isAbsolute(p)) ||
    !room.baseFiles.length ||
    !room.agentFiles.length ||
    (!!room.acpPrices !== !!room.acpFiles?.length) ||
    Object.values(room.acpPrices ?? {}).some(p => !p || !Number.isSafeInteger(p.baseTicks) || p.baseTicks <= 0 ||
      !Number.isSafeInteger(p.inputTicksPerByte) || p.inputTicksPerByte < 0)
  )
    throw new Error("Invalid job room paths.");
  return () => {
    const slot = file(room.setting);
    const base = room.baseFiles.map(file),
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
    let profile: unknown = "claude-code";
    let validUntil: unknown;
    // Desktop owns this envelope. Only its public profile name enters the wallet.
    if (slot.regular && room.acpPrices) {
      try {
        if (statSync(room.setting).size > 65536) throw new Error();
        const envelope = JSON.parse(readFileSync(room.setting, "utf8"));
        profile = envelope.agent;
        validUntil = envelope.validUntil;
      } catch { profile = null; }
    }
    const agent = slot.id === "missing" ? "core" : profile === "claude-code" ? "claude-code" : "acp";
    const firstCall = agent === "acp" && typeof profile === "string" && Object.hasOwn(room.acpPrices ?? {}, profile)
      ? room.acpPrices![profile] : undefined;
    const loginCurrent = !firstCall?.needsExpiry || (typeof validUntil === "number" && Number.isSafeInteger(validUntil) && Date.now() < validUntil);
    const agentFiles = (agent === "acp" ? room.acpFiles ?? [] : room.agentFiles).map(file);
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
      keysStable && loginCurrent &&
      (epoch === "legacy" || /^[0-9a-f-]{36}$/.test(epoch)) &&
      base.every((f) => f.regular) &&
      (agent === "core"
        ? !!coreCommand
        : slot.regular && (agent !== "acp" || !!firstCall) && agentFiles.every((f) => f.regular));
    let refusals: string[] = [];
    if (slot.regular)
      refusals = readdirSync(dirname(room.setting))
        .filter((n) => /^\.paid-agent-(denied|refused)\./.test(n))
        .sort();
    const generation = JSON.stringify([
      epoch,
      keysEpoch,
      loginCurrent,
      refusals,
      slot.id,
      file(room.keyStore).id,
      coreCommand,
      commands,
      base,
      agentFiles,
      room.generationFiles?.map(file),
    ]);
    return { agent, ready, coreCommand, generation, ...(firstCall && {firstCall}) };
  };
}
