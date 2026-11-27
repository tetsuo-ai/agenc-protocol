import { accessSync, constants, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

export interface LiveRoom {
  setting: string;
  keyStore: string;
  coreCandidates: readonly string[];
  baseFiles: readonly string[];
  agentFiles: readonly string[];
  generationFiles?: readonly string[];
}
export interface RoomSelection {
  agent: "core" | "claude-code";
  ready: boolean;
  coreCommand: string | null;
  generation: string;
}

function file(path: string) {
  try {
    const link = lstatSync(path,{bigint:true});
    const stat = link.isSymbolicLink() ? statSync(path,{bigint:true}) : link;
    return { regular:stat.isFile(), id:[link.ino,link.ctimeNs,stat.dev,stat.ino,stat.ctimeNs,stat.mode,stat.size].join("/") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
    return {regular:false,id:"missing"};
  }
}

// Named executors own their program, script and readiness command independently of the default.
export function commandGeneration(argv: readonly string[], probe: readonly string[] = []): string {
  const commands = [...argv.slice(0,2),...probe.slice(0,2)].filter(isAbsolute);
  return JSON.stringify(commands.map(file));
}

export function liveRoomSelection(room: LiveRoom): () => RoomSelection {
  if (![room.setting,room.keyStore,...room.coreCandidates,...room.baseFiles,...room.agentFiles,...room.generationFiles ?? []].every(p=>typeof p==="string" && isAbsolute(p)) ||
    !room.baseFiles.length || !room.agentFiles.length) throw new Error("Invalid job room paths.");
  return () => {
    const slot = file(room.setting);
    const base = room.baseFiles.map(file), agentFiles = room.agentFiles.map(file), commands = room.coreCandidates.map(file);
    const coreCommand = room.coreCandidates.find((p,i) => {
      if (!commands[i]?.regular) return false;
      try { accessSync(p,constants.X_OK); return true; } catch { return false; }
    }) ?? null;
    const agent = slot.id === "missing" ? "core" : "claude-code";
    const epochPath = room.setting + ".epoch";
    const epoch = file(epochPath).regular ? readFileSync(epochPath,"utf8") : "legacy";
    const ready = (epoch === "legacy" || /^[0-9a-f-]{36}$/.test(epoch)) && base.every(f=>f.regular) &&
      (agent === "core" ? !!coreCommand : slot.regular && agentFiles.every(f=>f.regular));
    let refusals: string[] = [];
    if (slot.regular) refusals = readdirSync(dirname(room.setting)).filter(n=>/^\.paid-agent-(denied|refused)\./.test(n)).sort();
    const generation = JSON.stringify([epoch,refusals,slot.id,file(room.keyStore).id,coreCommand,commands,base,agentFiles,room.generationFiles?.map(file)]);
    return {agent,ready,coreCommand,generation};
  };
}
