import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { emptyState, saveState } from "@tetsuo-ai/agenc-worker";
import type { KeyPairSigner } from "@solana/kit";
import type { Chain } from "../src/chain.js";
import type { MarketServices } from "../src/services.js";
import { EarnHost } from "../src/earn.js";

const calls = vi.hoisted(() => ({ order: [] as string[] }));
vi.mock("@tetsuo-ai/agenc-worker", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tetsuo-ai/agenc-worker")>(),
  checkSettlements: vi.fn(async () => { calls.order.push("reconcile"); return []; }),
  runUpkeep: vi.fn(async () => { calls.order.push("collect overdue reviews"); }),
  runUp: vi.fn(async () => { throw new Error("must not look for work"); }),
}));
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  calls.order.length = 0;
});

it("reconciles before and after overdue-review collection with no executor or earning loop", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "earn-upkeep-"));
  folders.push(dataDir);
  const state = emptyState();
  state.agentIdHex = "ab".repeat(32);
  saveState(path.join(dataDir, "agent"), state);
  const host = new EarnHost({
    dataDir, chain: { clientFor: () => ({}) } as unknown as Chain,
    services: {} as MarketServices, options: { executor: null }, log: vi.fn(), notify: vi.fn(),
  });
  await host.tidyUp({ agentId: "agent", signer: {} as KeyPairSigner, minRewardLamports: 0n });
  expect(calls.order).toEqual(["reconcile", "collect overdue reviews", "reconcile"]);
  expect(host.state("agent").state).toBe("off");
});
