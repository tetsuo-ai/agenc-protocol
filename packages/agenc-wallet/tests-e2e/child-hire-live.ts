// Subprocess for Desktop's scoped Electron walkthrough. This runner only opens a local LiteSVM.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { address } from "@solana/kit";
import { enqueueChildResume, parkChildRun, stageChildResult, takeChildResume } from "@tetsuo-ai/agenc-worker";
import { childHireHandlers } from "../src/child-hire.js";
import { openParentFixture } from "./child-hire-fixture.js";
import { confirmPayout, eventually, HAIKU, type World } from "./harness.js";
import type { WalletConfig } from "../src/wallet.js";
import type { ChildResult } from "../src/client/child-hire.js";

async function main() {
  const moduleUrl = new URL("../dist/index.js", import.meta.url);
  const built: typeof import("../src/index.js") = await import(moduleUrl.href);
  const f = await openParentFixture({}, async (options = {}) => {
    const sandbox = await built.startSandbox({ followWallClock: false });
    const secret = randomBytes(32),
      dataDir = mkdtempSync(join(tmpdir(), "child-wallet-"));
    const clock = { now: Date.now() };
    const config: WalletConfig = {
      chain: sandbox.chain,
      services: sandbox.services,
      prices: sandbox.prices,
      dataDir,
      unlockSecret: secret,
      now: () => clock.now,
      ...options.config,
      earn: { executor: null, ...options.earn, checkExecutionReady: async () => {} },
    };
    const wallet = await built.AgencWallet.open(config);
    sandbox.fund(wallet.mainAddress, 5_000_000_000n);
    return {
      wallet,
      sandbox,
      dataDir,
      secret,
      clock,
      listing: await sandbox.addService(HAIKU),
      balance: (account) => sandbox.chain.getBalance(address(account)),
      reopen: (overrides) => built.AgencWallet.open({ ...config, ...overrides }),
    } satisfies World;
  });
  const { world, grant, request, room } = f;
  let modelStarts = 0;
  async function run(method: string, params: Record<string, unknown>) {
    const { wallet } = world;
    const handlers = childHireHandlers(wallet);
    switch (method) {
      case "fixture":
        return { grant, request };
      case "park":
        return parkChildRun(room, grant, String(params.key));
      case "work":
        return world.sandbox.workOnce();
      case "stage": {
        const view = await wallet.childHires.timeline(grant.parentTask);
        return stageChildResult(
          room,
          { ...grant, childTask: view.child.task!, purchaseKey: view.purchaseKey },
          params.result as ChildResult,
        );
      }
      case "resume": {
        const view = await wallet.childHires.timeline(grant.parentTask);
        const receipt = String(params.receipt);
        await enqueueChildResume(room, grant, view.purchaseKey, receipt);
        const ticket = await takeChildResume(room, grant, receipt);
        if (ticket.start) {
          modelStarts++;
          writeFileSync(f.finish, ticket.runId);
        }
        return modelStarts;
      }
      case "settle": {
        const view = await wallet.childHires.timeline(grant.parentTask);
        await confirmPayout(wallet, view.child.jobId);
        await eventually(async () => (await wallet.getJob(f.job.id, true)).status === "delivered");
        await confirmPayout(wallet, f.job.id);
        return wallet.childHires.timeline(grant.parentTask);
      }
      case "close":
        await wallet.close();
        rmSync(room, { recursive: true, force: true });
        rmSync(world.dataDir, { recursive: true, force: true });
        return true;
      default: {
        if (!Object.hasOwn(handlers, method)) throw new Error("Unknown test operation.");
        return handlers[method as keyof typeof handlers](params as never);
      }
    }
  }
  process.on(
    "message",
    async ({ id, method, params }: { id: number; method: string; params: Record<string, unknown> }) => {
      try {
        const result = await run(method, params);
        process.send?.({ id, result }, () => {
          if (method === "close" && process.connected) process.disconnect?.();
        });
      } catch (e) {
        process.send?.({ id, error: e instanceof Error ? e.message : String(e) });
      }
    },
  );
  process.on("disconnect", () => {
    void world.wallet.close();
  });
  process.send?.({ ready: true });
}
if (process.send)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
    process.disconnect?.();
  });
