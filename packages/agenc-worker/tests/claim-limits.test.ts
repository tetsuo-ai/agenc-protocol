import { writeFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import * as ledger from "../src/revision-budget.js";

it("keeps the first executor and budget when restorable state changes", () => {
  const root = mkdtempSync(join(tmpdir(), "claim-ledger-"));
  const wallet = "seller" as never,
    claim = "claim" as never,
    dir = join(root, "seller-claim");
  try {
    ledger.enrollClaimBudget(root, wallet, claim);
    ledger.pinClaim(dir, "claude-code", 10);
    ledger.spendClaimRound(root, wallet, claim, 0, 8);
    expect(() => ledger.requireClaimExecutor(dir, "core")).toThrow();
    expect(() => ledger.pinClaim(dir, "core", 20)).toThrow();
    expect(() => ledger.spendClaimRound(root, wallet, claim, 1, 3)).toThrow();
    expect(existsSync(join(dir, "1"))).toBe(false);
    ledger.requireClaimExecutor(dir, "claude-code");
    expect(
      readFileSync(ledger.spendClaimRound(root, wallet, claim, 1, 2), "utf8"),
    ).toBe("2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("reads paid deadlines from the chain clock and stops when that clock is missing", async () => {
  const { claimChainTime } = await import("../src/upkeep.js");
  const account = new Uint8Array(40);
  new DataView(account.buffer).setBigInt64(32, 1000n, true);
  await expect(claimChainTime(async () => account)).resolves.toBe(1000);
  await expect(claimChainTime(async () => null)).rejects.toThrow("clock");
});

it.each([{tokens:8,calls:64},{tokens:500001,calls:2}])("keeps a known cap refusal out of the next reservation (%o)", prior => {
  const root = mkdtempSync(join(tmpdir(), "round-cap-"));
  const wallet = "seller" as never, claim = "claim" as never, dir = join(root,"seller-claim");
  try {
    ledger.enrollClaimBudget(root,wallet,claim);
    ledger.pinClaim(dir,"acp:grok:standin",6000);
    ledger.spendClaimRound(root,wallet,claim,0,3600);
    writeFileSync(join(dir,"0.counts"),JSON.stringify(prior));
    const start = () => ledger.spendClaimRound(root,wallet,claim,1,1200,{tokens:500000,calls:2});
    expect(start).toThrow();
    expect(existsSync(join(dir,"1"))).toBe(false);
    expect(existsSync(join(dir,"1.usage"))).toBe(false);
    writeFileSync(join(dir,"0.counts"),JSON.stringify({tokens:500000,calls:62}));
    expect(start()).toBe(join(dir,"1"));
  } finally { rmSync(root,{recursive:true,force:true}); }
});
