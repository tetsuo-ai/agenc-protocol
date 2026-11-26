import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applySellerDecision, type SellerEffect } from "../src/seller-decision.js";
import type { AgentRecord } from "../src/store.js";
import { AgencWallet } from "../src/wallet.js";

// Track F owns worker setup (`quoteManualWork`, `startManualWork`, the "start-manual"
// action, restore consent and room checks). After the final merge F's copy is the
// only one: C's "enable-manual" path and its manual seller effect are gone.
describe("manual work setup belongs to track F", () => {
  it("keeps exactly F's manual-work implementation", () => {
    expect(Object.getOwnPropertyNames(AgencWallet.prototype)).toContain("quoteManualWork");
    expect(Object.getOwnPropertyNames(AgencWallet.prototype)).toContain("startManualWork");
    const source = ["wallet.ts", "seller-decision.ts"].map(name => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8")).join("\n");
    expect(source).toContain('"start-manual"');
    expect(source).not.toContain("enable-manual");
    expect(source.match(/^  (?:async )?quoteManualWork\(/gm)).toHaveLength(1);
    expect(source.match(/^  (?:async )?startManualWork\(/gm)).toHaveLength(1);
  });

  it("does not switch on chosen open work from a funding decision", () => {
    const agent = { earn: { enabled: false, minPayCents: 0, offers: [] } } as unknown as AgentRecord;
    const effect = { minPayCents: 25, manual: true } as unknown as SellerEffect;
    applySellerDecision(agent, { quoteId: "fund_1", action: JSON.stringify(["enable", 25]), effect, expiresAt: 0 }, true);
    expect(agent.earn.enabled).toBe(true);
    expect(agent.earn.chooseOpenJobs).toBe(false);
  });
});
