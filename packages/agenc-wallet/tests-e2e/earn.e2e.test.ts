import { setEarnWithApproval } from "./harness.js";
// "Take jobs while idle": the stock worker loop runs for an agent, signs with
// the agent's own wallet, delivers a public job, and the pay shows up.
import { values } from "@tetsuo-ai/marketplace-sdk";
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

    const switchedOn = await setEarnWithApproval(wallet, agent.id, true, 10);
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

    const off = await setEarnWithApproval(wallet, agent.id, false);
    expect(off.earn.enabled).toBe(false);
    expect(off.earn.state).toBe("off");
  }, 90_000);

  it("is not given its registration money again when switched back on", async () => {
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
    const { wallet } = world;
    const agent = await wallet.createAgent("My assistant");
    await setEarnWithApproval(wallet, agent.id, true, 10);
    // The worker registers on its first pass.
    await eventually(async () => (await wallet.overview()).agents[0]!.earn.setAside.lamports === "10000000", 30_000);
    await setEarnWithApproval(wallet, agent.id, false);

    // Its deposit is locked already; taking jobs again needs only what a job
    // needs. At most a little for fees moves from the balance, never another
    // deposit (before, it moved the deposit and the registration's rent again).
    const main = await world.balance(wallet.mainAddress);
    const seen = (await wallet.listActivity(500)).length;
    await setEarnWithApproval(wallet, agent.id, true, 10);
    const moved = main - (await world.balance(wallet.mainAddress));
    expect(moved).toBeLessThan(100_000n);
    const since = (await wallet.listActivity(500)).slice(0, -seen || undefined).map((entry) => entry.text);
    expect(since).not.toContain("Set money aside so My assistant can register to take jobs.");
  }, 90_000);

  it("shows the person a turn-down they may dispute, and with no dispute the price goes back to the buyer", async () => {
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
    await setEarnWithApproval(wallet, agent.id, true, 10);
    const open = await sandbox.postOpenJob({
      title: "Write a line",
      instructions: "Write one friendly line.",
      rewardLamports: 50n * CENT,
    });
    await eventually(async () => {
      const jobs = await wallet.listJobs({ role: "working" }, true);
      return jobs.find((job) => job.status === "delivered");
    }, 30_000);

    // The buyer reads the work and turns it down. The price goes on hold,
    // and the person sees the turn-down, the bond a dispute costs, and when
    // the time to dispute ends.
    await open.turnDown();
    await wallet.tick();
    const held = (await wallet.listJobs({ role: "working" }, true)).find(
      (job) => job.task === open.task,
    );
    expect(held?.status).toBe("in_review");
    expect(held?.reviewEndsAt).not.toBeNull();
    expect(held?.statusText).toMatch(/turned this down. You can dispute that for a bond of/);
    expect(held?.turnDown).toMatchObject({
      disputable: true,
      disputed: false,
      ifNobodyActs: "buyer_refunded",
      bond: { lamports: values.MIN_DISPUTE_BOND_LAMPORTS.toString() },
    });
    // Disputing is the person's decision, never an agent's or the wallet's.
    expect(held?.canDispute).toBe(true);
    const asAgent = (await wallet.listJobs({ role: "working" }, false)).find(
      (job) => job.task === open.task,
    );
    expect(asAgent?.canDispute).toBe(false);
    await expect(wallet.disputeTurnDown(held!.id, false)).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    expect((await wallet.overview()).agents[0]!.earned.lamports).toBe("0");

    // Nobody disputed. When the time ends the provider's own wallet settles
    // the job: the price goes back to the buyer, and the agent is not paid.
    sandbox.advanceClock(72 * 3600 + 120);
    clock.now += (72 * 3600 + 120) * 1000;
    await wallet.tick();
    const done = await eventually(async () => {
      const jobs = await wallet.listJobs({ role: "working" }, true);
      const job = jobs.find((entry) => entry.task === open.task);
      return job?.status === "refunded" ? job : null;
    }, 30_000);
    expect(done.statusText).toBe("This job was not paid. The price went back to the buyer.");
    expect((await wallet.overview()).agents[0]!.earned.lamports).toBe("0");
  }, 120_000);

  it("lets the person dispute a turn-down: the reviewers rule for the agent, and it is paid with its bond back", async () => {
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
    await setEarnWithApproval(wallet, agent.id, true, 10);
    const open = await sandbox.postOpenJob({
      title: "Write a line",
      instructions: "Write one friendly line.",
      rewardLamports: 50n * CENT,
    });
    await eventually(async () => {
      const jobs = await wallet.listJobs({ role: "working" }, true);
      return jobs.find((job) => job.status === "delivered");
    }, 30_000);
    await open.turnDown();
    await wallet.tick();
    const held = (await wallet.listJobs({ role: "working" }, true)).find(
      (job) => job.task === open.task,
    )!;
    expect(held.canDispute).toBe(true);

    // The agent's wallet holds what it needs to work, not a bond: the person
    // is told what to add, and nothing changes.
    // In the person's money (play money: $1.00 is 0.01 SOL), never in SOL.
    await expect(wallet.disputeTurnDown(held.id, true)).rejects.toMatchObject({
      code: "NOT_ENOUGH_MONEY",
      message: expect.stringMatching(
        /^Disputing this turn-down needs \$[0-9.]+: the bond of \$1\.00, a deposit of \$[0-9.]+ that comes back, and network fees\. Add at least \$[0-9.]+ and try again\. Nothing changed\.$/,
      ),
    });
    await wallet.fundAgent(agent.id, { usdCents: 200 });

    const before = await world.balance(agent.address as never);
    const disputed = await wallet.disputeTurnDown(held.id, true);
    expect(disputed.turnDown?.disputed).toBe(true);
    expect(disputed.canDispute).toBe(false);
    expect(disputed.statusText).toMatch(/You disputed the buyer's turn-down/);
    // The bond, its record's deposit (which comes back), and the fee.
    const bondRent = await sandbox.chain.getMinimumBalanceForRentExemption(186);
    expect(before - (await world.balance(agent.address as never))).toBe(
      values.MIN_DISPUTE_BOND_LAMPORTS + bondRent + 5_000n,
    );
    await expect(wallet.disputeTurnDown(held.id, true)).rejects.toMatchObject({ code: "NOT_ALLOWED" });

    await sandbox.ruleOnTurnedDown({ task: open.task, payProvider: true });
    await wallet.tick();
    const paid = await eventually(async () => {
      const overview = await wallet.overview();
      return BigInt(overview.agents[0]!.earned.lamports) > 0n ? overview.agents[0]! : null;
    }, 30_000);
    expect(paid.earned.lamports).toBe(((50n * CENT * 95n) / 100n).toString());
    // Paid, and the bond came back with its deposit.
    expect((await world.balance(agent.address as never)) - before).toBeGreaterThan(
      (50n * CENT * 95n) / 100n,
    );
    const done = (await wallet.listJobs({ role: "working" }, true)).find(
      (job) => job.task === open.task,
    );
    expect(done?.status).toBe("paid");
  }, 120_000);

  it("offers no dispute while the marketplace has the agent suspended, and refuses one with the reason", async () => {
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
    await setEarnWithApproval(wallet, agent.id, true, 10);
    await wallet.fundAgent(agent.id, { usdCents: 200 });
    const open = await sandbox.postOpenJob({
      title: "Write a line",
      instructions: "Write one friendly line.",
      rewardLamports: 50n * CENT,
    });
    await eventually(async () => {
      const jobs = await wallet.listJobs({ role: "working" }, true);
      return jobs.find((job) => job.status === "delivered");
    }, 30_000);
    await open.turnDown();
    // The marketplace's owners suspend the agent (two of them approve).
    await sandbox.setAgentSuspended({ task: open.task as never, suspended: true });
    await wallet.tick();
    const held = (await wallet.listJobs({ role: "working" }, true)).find(
      (job) => job.task === open.task,
    )!;
    expect(held.status).toBe("in_review");
    expect(held.turnDown?.providerSuspended).toBe(true);
    expect(held.canDispute).toBe(false);
    expect(held.statusText).toMatch(/The marketplace has suspended your agent, and a suspended agent cannot dispute\./);
    const before = await world.balance(agent.address as never);
    await expect(wallet.disputeTurnDown(held.id, true)).rejects.toMatchObject({
      code: "NOT_ALLOWED",
      message: expect.stringMatching(/suspended this agent, and a suspended agent cannot dispute a turn-down\. Nothing changed\./),
    });
    // Refused before anything was signed: not even a fee.
    expect(await world.balance(agent.address as never)).toBe(before);

    // Lifted: the offer comes back on the next look.
    await sandbox.setAgentSuspended({ task: open.task as never, suspended: false });
    await wallet.tick();
    const lifted = (await wallet.listJobs({ role: "working" }, true)).find(
      (job) => job.task === open.task,
    )!;
    expect(lifted.turnDown?.providerSuspended).toBe(false);
    expect(lifted.canDispute).toBe(true);
  }, 120_000);
});
