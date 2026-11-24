import { describe, expect, it } from "vitest";
import { applySellerDecision, type SellerEffect } from "../src/seller-decision.js";
import type { AgentRecord } from "../src/store.js";
import { AgencWallet } from "../src/wallet.js";

// Track F owns worker setup (`quoteManualWork`, `startManualWork`, the "start-manual"
// action, restore consent and room checks). A second copy here would become a
// duplicate class member at the merge, or skip F's checks if it won.
describe("manual work setup belongs to track F", () => {
  it("adds no manual-work methods of its own", () => {
    expect(Object.getOwnPropertyNames(AgencWallet.prototype)).not.toContain("quoteManualWork");
    expect(Object.getOwnPropertyNames(AgencWallet.prototype)).not.toContain("startManualWork");
  });

  it("does not switch on chosen open work from a funding decision", () => {
    const agent = { earn: { enabled: false, minPayCents: 0, offers: [] } } as unknown as AgentRecord;
    const effect = { minPayCents: 25, manual: true } as unknown as SellerEffect;
    applySellerDecision(agent, { quoteId: "fund_1", action: JSON.stringify(["enable", 25]), effect, expiresAt: 0 }, true);
    expect(agent.earn.enabled).toBe(true);
    expect(agent.earn.chooseOpenJobs).toBe(false);
  });
});
