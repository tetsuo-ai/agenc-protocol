// "Take jobs while idle": the stock worker loop runs for an agent, signs with
// the agent's own wallet, delivers a public job, and the pay shows up.
import { afterEach, describe, expect, it } from "vitest";
import { CENT, eventually, startWorld, type World } from "./harness.js";

let world: World | null = null;
afterEach(async () => {
  await world?.wallet.close();
  world = null;
});

describe("earning", () => {
  it("is refused on a host that cannot run jobs", async () => {
    world = await startWorld();
    const agent = await world.wallet.createAgent("My assistant");
    await expect(world.wallet.setEarn(agent.id, true)).rejects.toMatchObject({
      code: "NOT_AVAILABLE",
    });
  });

  it("takes a public job, delivers it and gets paid", async () => {
    world = await startWorld({
      earn: {
        executor: {
          argv: [process.execPath, "-e", "process.stdout.write('Here is the finished work.')", "{prompt}"],
          mode: "sandboxed",
          envAllowlist: [],
          timeoutMs: 30_000,
        },
        pollIntervalMs: 150,
      },
    });
    const { wallet, sandbox } = world;
    const agent = await wallet.createAgent("My assistant");
    const mainBefore = await world.balance(wallet.mainAddress);

    const switchedOn = await wallet.setEarn(agent.id, true, 10);
    expect(switchedOn.earn.enabled).toBe(true);
    // Switching on set aside what registering on the marketplace needs.
    expect(mainBefore - (await world.balance(wallet.mainAddress))).toBeGreaterThan(10_000_000n);

    const open = await sandbox.postOpenJob({
      title: "Write a line",
      instructions: "Write one friendly line.",
      rewardLamports: 50n * CENT,
    });
    await eventually(async () => sandbox.deliveries.size === 1, 30_000);
    const working = await eventually(async () => {
      const jobs = await wallet.listJobs({ role: "working" }, true);
      return jobs.find((job) => job.status === "delivered");
    }, 30_000);
    expect(working.task).toBe(open.task);
    expect(new TextDecoder().decode([...sandbox.deliveries.values()][0])).toBe(
      "Here is the finished work.",
    );

    await open.approve();
    const paid = await eventually(async () => {
      const overview = await wallet.overview();
      return BigInt(overview.agents[0]!.earned.lamports) > 0n ? overview.agents[0]! : null;
    }, 30_000);
    // The reward minus the marketplace's 5% fee.
    expect(paid.earned.lamports).toBe(((50n * CENT * 95n) / 100n).toString());
    expect(paid.earn.jobsDone).toBe(1);
    // The marketplace's deposit for taking jobs is shown, not hidden.
    expect(paid.earn.setAside.lamports).toBe("10000000");
    expect((await wallet.listActivity()).map((entry) => entry.kind)).toContain("earned");

    const off = await wallet.setEarn(agent.id, false);
    expect(off.earn.enabled).toBe(false);
    expect(off.earn.state).toBe("off");
  }, 90_000);
});
