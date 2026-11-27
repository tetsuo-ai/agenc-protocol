import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimSignatureJournal } from "../src/claim-admission.js";
import { enrollClaimBudget } from "../src/revision-budget.js";
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
