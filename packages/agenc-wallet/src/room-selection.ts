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

export interface FirstCallPrice {
  baseTicks: number;
  inputTicksPerByte: number;
  needsExpiry?: boolean;
  tokenHold?: number;
}

export interface LiveRoom {
  setting: string;
  keyStore: string;
  coreCandidates: readonly string[];
  baseFiles: readonly string[];
  agentFiles: readonly string[];
  codexFiles?: readonly string[];
  codexPlanMinimumCents?: number;
  acpFiles?: readonly string[];
  acpPrices?: Record<string, FirstCallPrice>;
  generationFiles?: readonly string[];
  managedSettingsRoot?: string;
}
export interface RoomSelection {
  agent: string;
  minimumModelCents?: number;
  firstCall?: FirstCallPrice;
  validUntil?: number;
  identity?: string;
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

function entryPoint(argv: readonly string[]): string | undefined {
  const command = basename(argv[0] ?? "");
  if (!/^(?:node|nodejs|python[\d.]*|bash|sh|electron)(?:\.exe)?$/i.test(command))
    return ["job","peer-job"].includes(argv[2] ?? "") ? argv[1] : undefined;
  const name = command.toLowerCase().replace(/\.exe$/, "");
  const node = ["node","nodejs","electron"].includes(name);
  const python = name.startsWith("python");
  const inline = node ? ["-e","--eval"] : ["-c"];
  const flags = node ? ["--no-warnings","--no-deprecation","--trace-warnings","--unhandled-rejections=strict","--enable-source-maps"] :
    python ? ["-u","-B","-E","-I","-s","-S","-O"] : ["-e","-u","-x","--noprofile","--norc"];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") return argv[i+1] ?? "";
    if (!arg.startsWith("-")) return arg;
    if (inline.includes(arg)) return argv[i+1] ? undefined : "";
    if (node && arg === "--disable-warning") {
      if (!argv[++i] || argv[i]!.startsWith("-")) return "";
    } else if (!flags.includes(arg)) return "";
  }
  return "";
}

export function privateProcessing(argv:readonly string[],agent:string): string | undefined {
  if (argv[2] !== "job" || !argv[3] || !isAbsolute(argv[3])) return undefined;
  const slot=argv[3].replaceAll("{agent}",agent)+".processing.json";
  try {
    const data=JSON.parse(readFileSync(slot,"utf8"));
    const name=/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$/;
    if (data.version === 1 && Object.keys(data).sort().join() === "model,provider,version" &&
        typeof data.provider === "string" && name.test(data.provider) && typeof data.model === "string" && name.test(data.model))
      return JSON.stringify([file(slot).id,data.provider,data.model]);
  } catch {}
  return "unavailable";
}

export function checkNamedProgram(argv: readonly string[]) {
  const command = argv[0];
  if (!command || !executablePath(command))
    throw new ExecutorCapabilityError("The named job program is unavailable.");
  const script = entryPoint(argv);
  if (script === undefined) return;
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
  const commands = [argv,probe].flatMap(parts => {
    if (!parts[0]) return [];
    const script = entryPoint(parts);
    return [executablePath(parts[0]) ?? parts[0], ...(script && isAbsolute(script) ? [script] : [])];
  });
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
      ...(room.acpFiles ?? []),
      ...(room.generationFiles ?? []),
      ...(room.managedSettingsRoot ? [room.managedSettingsRoot] : []),
    ].every((p) => typeof p === "string" && isAbsolute(p)) ||
    !room.baseFiles.length ||
    !room.agentFiles.length ||
    (room.codexPlanMinimumCents !== undefined &&
      (!Number.isSafeInteger(room.codexPlanMinimumCents) || room.codexPlanMinimumCents < 1)) ||
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
    let version: unknown;
    let tag: unknown;
    let validSlot = slot.regular;
    // Desktop seals the login and owns this envelope. Only its public choice enters the wallet.
    if (slot.regular && (room.acpPrices || room.codexFiles !== undefined)) {
      try {
        if (statSync(room.setting).size > 65536) throw new Error();
        const envelope = JSON.parse(readFileSync(room.setting, "utf8"));
        profile = envelope.agent;
        version = envelope.version;
        tag = envelope.tag;
        validUntil = envelope.validUntil;
      } catch { profile = null; }
    }
    let agent: RoomSelection["agent"] = slot.id === "missing" ? "core" : "claude-code";
    let planVersion: string | undefined;
    let planTag: string | undefined;
    if (agent !== "core" && profile !== "claude-code") {
      if (room.codexFiles !== undefined && (profile === "codex-api" || profile === "codex-plan")) {
        agent = profile;
        if (profile === "codex-plan" && typeof version === "string" && /^[a-f0-9]{64}$/.test(version)) {
          planVersion = version;
          planTag = typeof tag === "string" ? tag : undefined;
        }
      } else if (room.acpPrices) agent = "acp";
      else validSlot = false;
    }
    const firstCall = agent === "acp" && typeof profile === "string" && Object.hasOwn(room.acpPrices ?? {}, profile)
      ? room.acpPrices![profile] : undefined;
    const identity = agent === "acp" && firstCall && typeof version === "string" && /^[a-f0-9]{64}$/.test(version)
      ? "acp:" + profile + ":" + version : undefined;
    let retryAt = 0;
    let entitled = true;
    if (identity) {
      const marker = join(dirname(room.setting), ".paid-agent-entitlement." + profile + "." + version);
      if (file(marker).regular) {
        retryAt = Number(readFileSync(marker, "utf8"));
        entitled = Number.isSafeInteger(retryAt) && Date.now() >= retryAt;
      }
    }
    const loginCurrent = !firstCall?.needsExpiry || (typeof validUntil === "number" && Number.isSafeInteger(validUntil) && Date.now() < validUntil);
    const agentFiles = (agent === "codex-api" || agent === "codex-plan" ? room.codexFiles ?? [] :
      agent === "acp" ? room.acpFiles ?? [] : room.agentFiles).map(file);
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
      !managed && keysStable && loginCurrent && entitled && (agent !== "acp" || (!!firstCall && Number.isSafeInteger(firstCall.tokenHold) && firstCall.tokenHold! > 0 && firstCall.tokenHold! <= 1000000)) &&
      (epoch === "legacy" || /^[0-9a-f-]{36}$/.test(epoch)) &&
      base.every((f) => f.regular) &&
      (agent === "core"
        ? !!coreCommand
        : validSlot && agentFiles.length > 0 && agentFiles.every((f) => f.regular) &&
          (agent !== "codex-plan" || room.codexPlanMinimumCents !== undefined) && (agent !== "acp" || !!identity));
    let refusals: string[] = [];
    if (slot.regular)
      refusals = readdirSync(dirname(room.setting))
        .filter((n) => {
          if (/^\.paid-agent-(denied|refused)\./.test(n))
            return !planVersion || n === ".paid-agent-denied.unidentified" || n === ".paid-agent-refused." + planVersion || n === ".paid-agent-denied." + planTag;
          if (!/^\.paid-agent-claim\.[a-f0-9]{64}\.[a-f0-9]{64}$/.test(n)) return false;
          if (planVersion && !n.startsWith(".paid-agent-claim." + planTag + ".")) return false;
          const marker = readFileSync(join(dirname(room.setting),n),"utf8");
          if (!isAbsolute(marker)) return true;
          if (!file(marker).regular) return false;
          if (!planVersion) return true;
          const denied = readFileSync(marker,"utf8");
          return !/^[a-f0-9]{64}$/.test(denied) || denied === planTag;
        })
        .sort();
    const generation = JSON.stringify([
      epoch,
      keysEpoch,
      loginCurrent, entitled, retryAt,
      managed,
      refusals,
      planVersion ?? slot.id,
      file(room.keyStore).id,
      coreCommand,
      commands,
      base,
      agentFiles,
      room.generationFiles?.map(file),
    ]);
    const refused = refusals.includes(".paid-agent-denied.unidentified") || refusals.includes(".paid-agent-refused." + version) || (typeof tag === "string" && /^[a-f0-9]{64}$/.test(tag) &&
      (refusals.includes(".paid-agent-denied." + tag) || refusals.some(n => n.startsWith(".paid-agent-claim." + tag + "."))));
    return { agent, ready:ready && !refused && !file(join(dirname(room.setting),".paid-agent-clearing")).regular, coreCommand, generation,
      ...(agent === "codex-plan" && room.codexPlanMinimumCents !== undefined && {minimumModelCents:room.codexPlanMinimumCents}), ...(identity && {identity}), ...(firstCall && {firstCall}), ...(firstCall?.needsExpiry && typeof validUntil === "number" && {validUntil}) };
  };
}

export const ACP_ADMISSION = "room-acp-admission-v2";

export function admissionArgs(argv: readonly string[], selection?: RoomSelection): string[] {
  return argv[2] === "self-test" && selection?.agent === "acp" ? [ACP_ADMISSION] : [];
}
