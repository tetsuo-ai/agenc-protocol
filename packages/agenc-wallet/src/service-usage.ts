import { closeSync, fsyncSync, openSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import type { ServiceUsage } from "./client/seller-terms.js";
import { serviceBudget } from "./service-budget.js";
export type { ServiceUsage } from "./client/seller-terms.js";

declare module "./store.js" {
  interface JobRecord { modelUsage?: ServiceUsage; settledSellerLamports?: string | null }
}
/** This path goes only to the trusted room process. The guest sees no host path. */
export function reserveServiceRun(stateDir: string, task: string, reservedCents: number) {
  const dir = path.join(stateDir, "service-usage", task);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  writeFileSync(path.join(dir, id + ".reserve"), String(reservedCents), { flag: "wx", mode: 0o600, flush: true });
  return path.join(dir, id + ".receipt");
}

function claimIndex(stateDir: string, task: string) {
  const root = path.resolve(stateDir,"..","..","model-spend");
  const key = createHash("sha256").update(JSON.stringify([path.basename(stateDir),task])).digest("hex");
  return {root,index:path.join(root,"by-task",key)};
}

export function indexClaimUsage(stateDir: string, task: string, round: string) {
  const {root,index} = claimIndex(stateDir,task);
  const directory = path.dirname(round), name = path.basename(directory);
  if (path.dirname(directory) !== root || !/^[1-9A-HJ-NP-Za-km-z]{32,44}-[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(name))
    throw new Error("Invalid claim ledger.");
  mkdirSync(path.dirname(index),{recursive:true,mode:0o700});
  try {writeFileSync(index,name,{mode:0o600,flag:"wx",flush:true});}
  catch (error) {if ((error as NodeJS.ErrnoException).code !== "EEXIST" || readFileSync(index,"utf8")!==name) throw error;}
  if (process.platform !== "win32") for (const dir of [root,path.dirname(index)]) {
    const fd=openSync(dir,"r"); try{fsyncSync(fd);} finally{closeSync(fd);}
  }
}

function indexedLedger(stateDir:string,task:string):string|null {
  const {root,index}=claimIndex(stateDir,task);
  let name:string;
  try { name=readFileSync(index,"utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code==="ENOENT") return null; throw error; }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}-[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(name)) throw new Error("Invalid claim ledger.");
  return path.join(root,name);
}

export function fileCorrectionAllowed(stateDir:string, task:string, connected?:string):boolean {
  const dir = indexedLedger(stateDir, task);
  const priced = connected === "acp" || connected === "pi";
  if (!dir) return !priced;
  const {executor} = JSON.parse(readFileSync(path.join(dir,"admission"),"utf8"));
  return typeof executor === "string" && !executor.startsWith("acp:") && !executor.startsWith("pi:") && !priced;
}

function durableUsage(stateDir:string,task:string):ServiceUsage|null {
  const dir=indexedLedger(stateDir, task);
  if (!dir) return null;
  const {budget}=JSON.parse(readFileSync(path.join(dir,"admission"),"utf8"));
  const rounds=readdirSync(dir).filter(n=>/^(?:-1|[0-2])$/.test(n));
  let reservedCents=0,unknownReservedCents=0,measured=0;
  for (const round of rounds) {
    const cap=Number(readFileSync(path.join(dir,round),"utf8"));
    if (!Number.isSafeInteger(cap)||cap<=0) throw new Error("Invalid claim reservation.");
    reservedCents+=cap;
    let cost:unknown;
    try {cost=JSON.parse(readFileSync(path.join(dir,round+".usage"),"utf8")).costUsd;} catch { /* An unknown reservation stays charged. */ }
    if (typeof cost==="number" && Number.isFinite(cost) && cost>=0) measured+=cost;
    else unknownReservedCents+=cap;
  }
  return {reservedCents,unknownReservedCents,costUsd:unknownReservedCents?null:measured,runs:rounds.length,budgetCents:budget};
}

export function serviceUsage(stateDir: string, task: string): ServiceUsage | null {
  const durable=durableUsage(stateDir,task);
  if (durable) return durable;
  const dir = path.join(stateDir, "service-usage", task);
  let files: string[];
  try { files = readdirSync(dir).filter(f => f.endsWith(".reserve")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  let costUsd: number | null = 0;
  let reservedCents = 0;
  let unknownReservedCents = 0;
  for (const file of files) {
    const cap = Number(readFileSync(path.join(dir, file), "utf8"));
    if (!Number.isSafeInteger(cap) || cap <= 0) throw new Error("Invalid service cost reservation.");
    reservedCents += cap;
    let measured: unknown;
    try {
      measured = JSON.parse(readFileSync(path.join(dir, file.replace(/\.reserve$/, ".receipt")), "utf8")).costUsd;
    } catch { /* An unfinished run keeps its reservation. */ }
    if (typeof measured === "number" && Number.isFinite(measured) && measured >= 0) {
      if (costUsd !== null) costUsd += measured;
    } else {
      unknownReservedCents += cap;
      costUsd = null;
    }
  }
  const budgetCents = serviceBudget(stateDir, task);
  return files.length ? { reservedCents, unknownReservedCents, costUsd, runs: files.length, ...(budgetCents !== null && { budgetCents }) } : null;
}
