import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimSignatureJournal } from "../src/claim-admission.js";
import { enrollClaimBudget, spendClaimRound } from "../src/revision-budget.js";
const dirs: string[] = [];
const root = () => { const dir=mkdtempSync(join(tmpdir(),"claim-upgrade-")); dirs.push(dir); return dir; };
afterEach(()=>{for(const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true});});
it("holds an empty 0.1.16 claim across enrollment and worker restore",()=>{
  const dir=root(); mkdirSync(join(dir,"seller-claim"));
  const journal=claimSignatureJournal(dir,"seller","task","claim");
  expect(journal.exists()).toBe(true);
  enrollClaimBudget(dir,"seller" as never,"claim" as never);
  expect(()=>journal.reserve()).toThrow();
});
it("publishes no reservation if the initial zero receipt cannot be flushed",()=>{
  const dir=root(), claim=join(dir,"seller-claim");
  enrollClaimBudget(dir,"seller" as never,"claim" as never);
  mkdirSync(join(claim,"0.usage"));
  expect(()=>spendClaimRound(dir,"seller" as never,"claim" as never,0,10)).toThrow();
  expect(existsSync(join(claim,"0"))).toBe(false);
});

it("recovers a matching zero receipt after the reserving process exited",()=>{
  const dir=root(), claim=join(dir,"seller-claim");
  enrollClaimBudget(dir,"seller" as never,"claim" as never);
  writeFileSync(join(claim,".reserving"),"");
  writeFileSync(join(claim,"0.usage"),JSON.stringify({reservedCents:10,costUsd:0}));
  const reserve=(cents:number)=>spendClaimRound(dir,"seller" as never,"claim" as never,0,cents);
  expect(()=>reserve(11)).toThrow();
  expect(readFileSync(reserve(10),"utf8")).toBe("10");
  expect(()=>reserve(10)).toThrow();
});

it("keeps a live reservation exclusive and recovers it when its owner exits",async()=>{
  const dir=root(), claim=join(dir,"seller-claim");
  enrollClaimBudget(dir,"seller" as never,"claim" as never);
  const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",`
    import {acquireStateLock} from "./src/state.ts";
    import {writeFileSync} from "node:fs";
    acquireStateLock(process.argv[1]);
    writeFileSync(process.argv[1]+"/0.usage",JSON.stringify({reservedCents:10,costUsd:0}),{flush:true});
    process.stdout.write("ready");setInterval(()=>{},1000);
  `,claim],{stdio:["ignore","pipe","inherit"]});
  const exited=once(child,"exit");
  try {
    await once(child.stdout,"data");
    expect(()=>spendClaimRound(dir,"seller" as never,"claim" as never,0,10)).toThrow();
  } finally { child.kill("SIGKILL"); await exited; }
  expect(readFileSync(spendClaimRound(dir,"seller" as never,"claim" as never,0,10),"utf8")).toBe("10");
});
