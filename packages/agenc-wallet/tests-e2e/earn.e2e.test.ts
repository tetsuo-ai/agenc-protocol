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

  it("collects the pay itself when a buyer turns the work down and nobody rules", async () => {
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
    const { wallet, sandbox, clock } = world;
    const agent = await wallet.createAgent("My assistant");
    await wallet.setEarn(agent.id, true, 10);
    const open = await sandbox.postOpenJob({
      title: "Write a line",
      instructions: "Write one friendly line.",
      rewardLamports: 50n * CENT,
    });
    await eventually(async () => {
      const jobs = await wallet.listJobs({ role: "working" }, true);
      return jobs.find((job) => job.status === "delivered");
    }, 30_000);

    // The buyer reads the work and turns it down. The price goes on hold; it
    // does not go back to the buyer, and the provider can see where it stands.
    await open.turnDown();
    await wallet.tick();
    const held = (await wallet.listJobs({ role: "working" }, true)).find(
      (job) => job.task === open.task,
    );
    expect(held?.status).toBe("in_review");
    expect(held?.reviewEndsAt).not.toBeNull();
    expect(held?.statusText).toMatch(/turned this down.*your agent is paid/);
    expect((await wallet.overview()).agents[0]!.earned.lamports).toBe("0");

    // Before the review time is up, nothing is collected.
    sandbox.advanceClock(3_000);
    clock.now += 3_000_000;
    await wallet.tick();
    expect((await wallet.overview()).agents[0]!.earned.lamports).toBe("0");

    // Nobody ruled. The provider's own wallet settles the job and is paid:
    // it does not depend on the buyer's software.
    sandbox.advanceClock(720);
    clock.now += 720_000;
    await wallet.tick();
    const paid = await eventually(async () => {
      const overview = await wallet.overview();
      return BigInt(overview.agents[0]!.earned.lamports) > 0n ? overview.agents[0]! : null;
    }, 30_000);
    expect(paid.earned.lamports).toBe(((50n * CENT * 95n) / 100n).toString());
    const done = (await wallet.listJobs({ role: "working" }, true)).find(
      (job) => job.task === open.task,
    );
    expect(done?.status).toBe("paid");
  }, 120_000);
});
