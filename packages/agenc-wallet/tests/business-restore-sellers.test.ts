import { expect, it } from "vitest";
import { pauseRestoredBusiness, unresolvedChildDispatch } from "../src/business-backup.js";
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

it("treats a resolved supplier dispatch as history, not pending work", () => {
  const resolved = { view: { phase: "dispatching" }, dispatch: { signature: "s1", outcome: "landed" } };
  const failed = { view: { phase: "dispatching" }, dispatch: { signature: "s2", outcome: "failed" } };
  const waiting = { view: { phase: "dispatching" }, send: { signature: "s3" } };
  const retried = { view: { phase: "funded" }, send: { signature: "s5" }, dispatch: { signature: "s4", outcome: "expired" } };
  expect(unresolvedChildDispatch(resolved)).toBe(false);
  expect(unresolvedChildDispatch(failed)).toBe(false);
  expect(unresolvedChildDispatch(waiting)).toBe(true);
  expect(unresolvedChildDispatch(retried)).toBe(true);
  const state = { agents: {}, jobs: {}, childHires: { p: resolved } } as unknown as WalletState;
  pauseRestoredBusiness(state, undefined, 5, false);
  expect(state.businessRecovery).toBeUndefined();
  expect((state as unknown as { childHires: Record<string, unknown> }).childHires.p).toEqual(resolved);
  const live = { agents: {}, jobs: {}, childHires: { p: waiting } } as unknown as WalletState;
  pauseRestoredBusiness(live, undefined, 5, false);
  expect(live.businessRecovery?.requiresConsent).toBe(true);
});
