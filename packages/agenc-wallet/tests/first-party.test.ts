// The marketplace's own accounts on the live network: what they do proves
// nothing to a buyer, so their jobs are left out of every record.
import { describe, expect, it } from "vitest";
import { firstPartyAccounts, MAINNET_FIRST_PARTY } from "../src/first-party.js";

describe("the marketplace's own accounts", () => {
  it("are listed for the live network, each with the reason it is on the list", () => {
    const own = firstPartyAccounts("mainnet");
    // The dogfood loop, its agent and the wallet that owns it.
    expect(own.listings.has("8HtcGBDTZvarRc1YbFzmM3C1ZrWQc8antcwHAYHsHC9b")).toBe(true);
    expect(own.agents.has("3cZeUpRdhDhmRSRHFqm96Hw2gRpgtXFxUtoVARnS6gZN")).toBe(true);
    expect(own.wallets.has("Fv1pBRo5JKwiB4kE71W3Yw5caegMBio7ANNTQva28wmS")).toBe(true);
    // The treasury, where every fee goes.
    expect(own.wallets.has("4tA32m8FRM1mVKTasuiEvbRksBJTGBvwF9jsT4WLM84n")).toBe(true);
    for (const address of [...own.wallets, ...own.agents, ...own.listings]) {
      expect(MAINNET_FIRST_PARTY.reasons.get(address)?.length ?? 0).toBeGreaterThan(5);
      expect(address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    }
  });

  it("are none on practice money, where the whole marketplace is the practice one's", () => {
    for (const network of ["sandbox", "devnet", "localnet"] as const) {
      const own = firstPartyAccounts(network);
      expect(own.wallets.size + own.agents.size + own.listings.size).toBe(0);
    }
  });
});
