// Execute a full simulated day of the real wallet and worker, with local
// program accounts only. Five units per scan, one per ordinary RPC read.
import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Chain } from "../src/chain.js";
import { eventually, startWorld } from "./harness.js";

const realSetImmediate = globalThis.setImmediate;

const executor = {
  argv: [process.execPath, "-e", "process.stdout.write('done')", "{prompt}"],
  mode: "sandboxed" as const, envAllowlist: [], timeoutMs: 30_000,
};

describe("idle selling budget", () => {
  it("stays below the included daily allowance with one live service", async () => {
    const calls: Record<string, number> = {};
    const count = (name: string) => { calls[name] = (calls[name] ?? 0) + 1; };
    const world = await startWorld({
      earn: { executor, pollIntervalMs: 100 },
      chain: (base) => new Proxy(base, {
        get(target, key, receiver) {
          if (key === "gpa") return new Proxy(target.gpa, {
            get(gpa, method) {
              // Real Chain.gpa is a full RPC object. Discovery must not
              // activate the SDK's separate signature polling fallback.
              if (method === "getSignaturesForAddress") return () => {
                count("getSignaturesForAddress");
                throw new Error("Unexpected signature polling");
              };
              const value = Reflect.get(gpa, method);
              if (method !== "getProgramAccounts") return value;
              return (...args: unknown[]) => { count("scan"); return value.apply(gpa, args); };
            },
          });
          const value = Reflect.get(target, key, receiver);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (/^(read|getBalance|getBalances|getMinimum|clusterTime)/.test(String(key))) count(String(key));
            return value.apply(target, args);
          };
        },
      }) as Chain,
    });
    try {
      const agent = await world.wallet.createAgent("Seller");
      await world.wallet.setEarn(agent.id, true, 10);
      await world.wallet.setOffer(agent.id, { name: "Writer", summary: "A friendly line.", price: { usdCents: 30 } });
      await eventually(async () => {
        await world.wallet.tick();
        return (await world.wallet.overview()).agents[0]?.earn.offer?.status === "live";
      });
      await world.wallet.close();
      vi.useFakeTimers();
      for (const key of Object.keys(calls)) delete calls[key];
      world.wallet = await world.reopen({ earn: { executor, checkExecutionReady: async () => {} } });
      world.wallet.start();
      for (let minute = 0; minute < 24 * 60; minute += 1) {
        await vi.advanceTimersByTimeAsync(60_000);
        // Let native PDA hashing finish between simulated minutes, as it
        // would in production. Do not race a whole day past pending I/O.
        await new Promise<void>((resolve) => realSetImmediate(resolve));
      }
      const scans = calls.scan ?? 0;
      const otherReads = Object.entries(calls).filter(([key]) => key !== "scan").reduce((sum, [, value]) => sum + value, 0);
      const units = 5 * scans + otherReads;
      if (process.env.AGENC_TEST_METRICS_FILE) {
        writeFileSync(process.env.AGENC_TEST_METRICS_FILE, JSON.stringify({ scans, otherReads, units, calls }, null, 2));
      }
      expect(calls.getSignaturesForAddress).toBeUndefined();
      expect(units).toBeLessThan(10_000);
    } finally {
      await world.wallet.close();
      vi.useRealTimers();
    }
  }, 120_000);
});
