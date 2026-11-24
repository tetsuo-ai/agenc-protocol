import { expect, it } from "vitest";
import { pauseRestoredBusiness } from "../src/business-backup.js";
import { restoredSeller } from "../src/business-room.js";
import type { WalletState } from "../src/store.js";

const agent = (id: string, earn: Record<string, unknown>) => ({ id, earn: { enabled: false, ...earn } });

it("asks for the job room only for agents that sold before the restore or still hold a claim", () => {
  const state = {
    agents: {
      buyer: agent("buyer", {}),
      earner: agent("earner", { enabled: true }),
      lister: agent("lister", { offers: [{ id: "o" }] }),
      bundled: agent("bundled", {}),
    },
    jobs: { j: { phase: "active" } },
  } as unknown as WalletState;
  pauseRestoredBusiness(state, { version: 1, drafts: [], services: [{ agentId: "bundled" }] } as never, 5, false);
  expect(state.businessRecovery).toMatchObject({ requiresConsent: true, sellers: ["earner", "lister", "bundled"] });
  expect(state.agents.earner!.earn.enabled).toBe(false);
  expect(restoredSeller(state, "buyer", false)).toBe(false);
  expect(restoredSeller(state, "buyer", true)).toBe(true);
  for (const id of ["earner", "lister", "bundled"]) expect(restoredSeller(state, id, false)).toBe(true);
  expect(restoredSeller(state, "missing", false)).toBe(false);
});
