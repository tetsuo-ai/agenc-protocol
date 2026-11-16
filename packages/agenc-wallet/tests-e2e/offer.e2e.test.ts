// Offering a service: an earning agent lists one thing it does, another
// agent hires it, the stock worker loop does the job, and the pay shows up.
// The service is only on the marketplace while someone is there to do it.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Address } from "@solana/kit";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentView } from "../src/client/types.js";
import { WalletError } from "../src/errors.js";
import { readListing } from "../src/market.js";
import { CENT, eventually, startWorld, type World } from "./harness.js";

const EARN = {
  executor: {
    argv: [process.execPath, "-e", "process.stdout.write('Here is the finished work.')", "{prompt}"],
    mode: "sandboxed" as const,
    envAllowlist: [],
    timeoutMs: 30_000,
  },
  pollIntervalMs: 150,
};
const LINE_WRITER = {
  name: "Line Writer",
  summary: "One friendly line about anything you name.",
  price: { usdCents: 30 },
};
const NO_REFILL = { enabled: false, topUpToCents: 0, perDayCents: 0 };

let world: World | null = null;
afterEach(async () => {
  await world?.wallet.close();
  world = null;
});

async function agentView(current: World, agentId: string): Promise<AgentView> {
  const overview = await current.wallet.overview();
  return overview.agents.find((agent) => agent.id === agentId)!;
}

/** Run housekeeping until the agent's service reaches `status`. */
async function offerReaches(
  current: World,
  agentId: string,
  status: NonNullable<AgentView["earn"]["offer"]>["status"],
): Promise<AgentView> {
  return eventually(async () => {
    await current.wallet.tick();
    const view = await agentView(current, agentId);
    return view.earn.offer?.status === status ? view : null;
  }, 30_000);
}

async function startOffering(): Promise<{ current: World; worker: AgentView }> {
  world = await startWorld({ earn: EARN });
  const created = await world.wallet.createAgent("Worker");
  await world.wallet.setEarn(created.id, true, 10);
  await world.wallet.setOffer(created.id, LINE_WRITER);
  return { current: world, worker: await offerReaches(world, created.id, "live") };
}

describe("offering a service", () => {
  it("is hired by another agent, done by the worker loop, and paid", async () => {
    world = await startWorld({ earn: EARN });
    const { wallet, sandbox } = world;
    const worker = await wallet.createAgent("Worker");
    const buyer = await wallet.createAgent("Buyer");
    await wallet.fundAgent(buyer.id, { usdCents: 500 });
    await wallet.setPolicy(buyer.id, { askAboveCents: 100, refill: NO_REFILL });

    const before = await wallet.setEarn(worker.id, true, 10);
    // The one-time cost is known before anything is spent on it.
    expect(BigInt(before.earn.offerCost!.lamports)).toBeGreaterThan(0n);

    const offered = await wallet.setOffer(worker.id, LINE_WRITER);
    expect(offered.earn.offer).toMatchObject({ name: "Line Writer", summary: LINE_WRITER.summary });
    expect(offered.earn.offer!.price.usdCents).toBe(30);

    // The worker registers on its first pass; housekeeping then lists the
    // service and has it checked.
    const live = await offerReaches(world, worker.id, "live");
    expect(live.earn.offer!.statusText).toBe("On offer. Other agents can hire it.");
    expect(live.earn.offerCost).toBeNull();
    const listing = live.earn.offer!.listing as Address;
    const onChain = (await readListing(sandbox.chain, listing))!;
    expect(onChain.price).toBe(30n * CENT);
    expect(onChain.authority).toBe(worker.address);
    expect(onChain.maxOpenJobs).toBe(0);
    expect((await wallet.listActivity()).map((entry) => entry.text)).toContain(
      "Worker now offers “Line Writer”.",
    );

    // It is in the catalog like any other service.
    const found = (await wallet.find({ query: "friendly line" })).services.find(
      (service) => service.listing === listing,
    )!;
    expect(found).toMatchObject({ name: "Line Writer", summary: LINE_WRITER.summary });
    expect(found.price.usdCents).toBe(30);

    // An agent cannot hire itself; another agent of the same person can.
    await expect(
      wallet.hire({ agentId: worker.id, listing, request: "Write a line." }),
    ).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    const { job, approval } = await wallet.hire({
      agentId: buyer.id,
      listing,
      request: "Write one friendly line about tea.",
    });
    expect(approval).toBeNull();

    // The worker loop takes the hire, does it and delivers.
    const delivered = await eventually(async () => {
      const view = await wallet.getJob(job.id, true);
      return view.status === "delivered" ? view : null;
    }, 60_000);
    expect(delivered.result?.text).toBe("Here is the finished work.");
    const working = await eventually(async () => {
      const jobs = await wallet.listJobs({ role: "working", agentId: worker.id }, true);
      return jobs.find((entry) => entry.task === delivered.task);
    }, 30_000);
    expect(working.status).toBe("delivered");

    await wallet.approveJob(job.id, undefined, true);
    const paid = await eventually(async () => {
      const view = await agentView(world!, worker.id);
      return BigInt(view.earned.lamports) > 0n ? view : null;
    }, 30_000);
    // The price minus the marketplace's 5% fee.
    expect(paid.earned.lamports).toBe(((30n * CENT * 95n) / 100n).toString());
    expect(paid.earn.jobsDone).toBe(1);
    expect((await agentView(world, buyer.id)).spent.lamports).toBe((30n * CENT).toString());
  }, 120_000);

  it("can be limited to jobs from the wallet's own agents", async () => {
    // For a host that cannot yet keep a stranger's job away from the
    // person's files: nothing a stranger wrote is ever run.
    const lines: string[] = [];
    world = await startWorld({
      earn: {
        ...EARN,
        executor: {
          ...EARN.executor,
          // The job program is told which agent it works for.
          argv: [process.execPath, "-e", "process.stdout.write('done by ' + process.argv[1])", "{agent}", "{prompt}"],
        },
        ownJobsOnly: true,
        serviceRefreshMs: 400,
      },
      config: { log: (line) => lines.push(line) },
    });
    const { wallet, sandbox } = world;
    expect((await wallet.overview()).earning).toBe("own-jobs");
    const worker = await wallet.createAgent("Worker");
    await wallet.setEarn(worker.id, true, 10);
    await wallet.setOffer(worker.id, LINE_WRITER);
    const live = await offerReaches(world, worker.id, "live");

    // A stranger's public job is left alone, however long it waits.
    const strangers = await sandbox.postOpenJob({
      title: "Write a line",
      instructions: "Write one friendly line.",
      rewardLamports: 50n * CENT,
    });

    // An agent added after earning started is one of the wallet's own too.
    const buyer = await wallet.createAgent("Buyer");
    await wallet.fundAgent(buyer.id, { usdCents: 500 });
    await wallet.setPolicy(buyer.id, { askAboveCents: 100, refill: NO_REFILL });
    const { job } = await wallet.hire({
      agentId: buyer.id,
      listing: live.earn.offer!.listing!,
      request: "Write one friendly line about tea.",
    });
    const delivered = await eventually(async () => {
      const view = await wallet.getJob(job.id, true);
      return view.status === "delivered" ? view : null;
    }, 60_000);
    expect(delivered.result?.text).toBe(`done by ${worker.id}`);
    expect(await strangers.delivered()).toBe(false);
    expect(sandbox.deliveries.size).toBe(1);
  }, 120_000);

  it("says whose jobs can be taken", async () => {
    world = await startWorld();
    expect((await world.wallet.overview()).earning).toBe("off");
    await world.wallet.close();
    world = await startWorld({ earn: EARN });
    expect((await world.wallet.overview()).earning).toBe("open");
  });

  it("takes a hire straight away while an earlier job still waits to be paid", async () => {
    // No fresh look in this test: the spare money alone has to carry it.
    world = await startWorld({ earn: { ...EARN, serviceRefreshMs: 100_000_000 } });
    const { wallet, sandbox } = world;
    const worker = await wallet.createAgent("Worker");
    const buyer = await wallet.createAgent("Buyer");
    await wallet.fundAgent(buyer.id, { usdCents: 500 });
    await wallet.setPolicy(buyer.id, { askAboveCents: 100, refill: NO_REFILL });
    await wallet.setEarn(worker.id, true, 10);
    await wallet.setOffer(worker.id, LINE_WRITER);
    const live = await offerReaches(world, worker.id, "live");

    // A public job is done and its buyer is in no hurry to pay.
    const open = await sandbox.postOpenJob({
      title: "Write a line",
      instructions: "Write one friendly line.",
      rewardLamports: 50n * CENT,
    });
    await eventually(async () => open.delivered(), 30_000);

    const { job } = await wallet.hire({
      agentId: buyer.id,
      listing: live.earn.offer!.listing!,
      request: "Write one friendly line about tea.",
    });
    const delivered = await eventually(async () => {
      const view = await wallet.getJob(job.id, true);
      return view.status === "delivered" ? view : null;
    }, 30_000);
    expect(delivered.result?.text).toBe("Here is the finished work.");
  }, 120_000);

  it("takes a hire it could not take the first time it saw it", async () => {
    // The stock watcher reports a job once. Nobody else can take a hire of
    // this agent's service, so the agent has to look again.
    const lines: string[] = [];
    world = await startWorld({
      earn: { ...EARN, serviceRefreshMs: 400 },
      config: { log: (line) => lines.push(line) },
    });
    const { wallet } = world;
    const worker = await wallet.createAgent("Worker");
    const buyer = await wallet.createAgent("Buyer");
    await wallet.fundAgent(buyer.id, { usdCents: 500 });
    await wallet.setPolicy(buyer.id, { askAboveCents: 100, refill: NO_REFILL });
    await wallet.setEarn(worker.id, true, 10);
    await wallet.setOffer(worker.id, LINE_WRITER);
    const live = await offerReaches(world, worker.id, "live");

    // The worker's wallet is short when the hire arrives.
    await wallet.reclaimFromAgent(worker.id, "all");
    const { job } = await wallet.hire({
      agentId: buyer.id,
      listing: live.earn.offer!.listing!,
      request: "Write one friendly line about tea.",
    });
    await eventually(
      async () => lines.some((line) => line.includes("task.processing-error") && line.includes("insufficient funds")),
      30_000,
    );
    expect((await wallet.getJob(job.id, true)).status).toBe("waiting");

    // Money comes back, and the next fresh look takes the job.
    await wallet.fundAgent(worker.id, { usdCents: 300 });
    const delivered = await eventually(async () => {
      const view = await wallet.getJob(job.id, true);
      return view.status === "delivered" ? view : null;
    }, 60_000);
    expect(delivered.result?.text).toBe("Here is the finished work.");
  }, 120_000);

  it("leaves the marketplace while nobody is taking jobs, and comes back", async () => {
    const { current, worker } = await startOffering();
    const listing = worker.earn.offer!.listing as Address;
    const buyer = await current.wallet.createAgent("Buyer");

    const off = await current.wallet.setEarn(worker.id, false);
    expect(off.earn.offer).toMatchObject({
      status: "paused",
      statusText: "Off offer while taking jobs is switched off.",
    });
    // Switched off, the agent is still registered and its deposit still locked.
    expect(off.earn.setAside.lamports).toBe("10000000");
    expect(Number((await readListing(current.sandbox.chain, listing))!.state)).toBe(1);
    expect((await current.wallet.find({})).services.map((service) => service.listing)).not.toContain(listing);
    await expect(
      current.wallet.hire({ agentId: buyer.id, listing, request: "Write a line." }),
    ).rejects.toMatchObject({ code: "NOT_AVAILABLE" });

    await current.wallet.setEarn(worker.id, true);
    await offerReaches(current, worker.id, "live");
    expect(Number((await readListing(current.sandbox.chain, listing))!.state)).toBe(0);
    expect((await current.wallet.find({})).services.map((service) => service.listing)).toContain(listing);
  }, 120_000);

  it("can change its price and description, but not its name", async () => {
    const { current, worker } = await startOffering();
    const listing = worker.earn.offer!.listing as Address;

    await current.wallet.setOffer(worker.id, { ...LINE_WRITER, price: { usdCents: 45 } });
    const repriced = await offerReaches(current, worker.id, "live");
    expect(repriced.earn.offer!.price.usdCents).toBe(45);
    // The marketplace carries exactly the price the wallet recorded.
    expect((await readListing(current.sandbox.chain, listing))!.price).toBe(
      BigInt(repriced.earn.offer!.price.lamports),
    );

    // New words are checked again before the service is back on offer.
    const reworded = await current.wallet.setOffer(worker.id, {
      ...LINE_WRITER,
      price: { usdCents: 45 },
      summary: "Two friendly lines about anything you name.",
    });
    expect(reworded.earn.offer!.status).not.toBe("problem");
    await offerReaches(current, worker.id, "live");
    const found = (await current.wallet.find({})).services.find((service) => service.listing === listing)!;
    expect(found.summary).toBe("Two friendly lines about anything you name.");
    expect(found.price.usdCents).toBe(45);

    await expect(
      current.wallet.setOffer(worker.id, { ...LINE_WRITER, name: "Poem Writer" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Still the same listing: nothing was created a second time.
    expect((await agentView(current, worker.id)).earn.offer!.listing).toBe(listing);
  }, 120_000);

  it("can be withdrawn and offered again", async () => {
    const { current, worker } = await startOffering();
    const listing = worker.earn.offer!.listing as Address;

    const withdrawn = await current.wallet.setOffer(worker.id, null);
    expect(withdrawn.earn.offer).toMatchObject({ status: "paused", statusText: "Off offer." });
    expect(Number((await readListing(current.sandbox.chain, listing))!.state)).toBe(1);
    // Housekeeping leaves a withdrawn service alone.
    await current.wallet.tick();
    expect(Number((await readListing(current.sandbox.chain, listing))!.state)).toBe(1);

    await current.wallet.setOffer(worker.id, LINE_WRITER);
    const back = await offerReaches(current, worker.id, "live");
    expect(back.earn.offer!.listing).toBe(listing);
  }, 120_000);

  it("comes off offer when the wallet closes and returns when it reopens", async () => {
    const { current, worker } = await startOffering();
    const listing = worker.earn.offer!.listing as Address;

    await current.wallet.close();
    expect(Number((await readListing(current.sandbox.chain, listing))!.state)).toBe(1);

    current.wallet = await current.reopen();
    const back = await offerReaches(current, worker.id, "live");
    expect(back.earn.offer!.listing).toBe(listing);
    expect(Number((await readListing(current.sandbox.chain, listing))!.state)).toBe(0);
  }, 120_000);

  it("is found by the person's other agents before the marketplace's list catches up", async () => {
    // The list of services is put together by the marketplace's site and runs
    // minutes behind. Here it never shows the new service at all.
    world = await startWorld({
      earn: EARN,
      services: (base) => ({
        ...base,
        async listServices() {
          return (await base.listServices()).filter((row) => row.name !== "Line Writer");
        },
      }),
    });
    const { wallet } = world;
    const worker = await wallet.createAgent("Worker");
    const buyer = await wallet.createAgent("Buyer");
    await wallet.setBudget(buyer.id, 500);
    await wallet.setEarn(worker.id, true, 10);
    await wallet.setOffer(worker.id, LINE_WRITER);

    // Not on offer yet: nobody can find it.
    expect((await wallet.find({ query: "friendly line" })).services.map((service) => service.name)).not.toContain("Line Writer");

    const live = await offerReaches(world, worker.id, "live");
    const listing = live.earn.offer!.listing as Address;
    const found = (await wallet.find({ query: "friendly line" })).services.filter((service) => service.name === "Line Writer");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ listing, summary: LINE_WRITER.summary });
    expect(found[0]!.price.usdCents).toBe(30);
    // The marketplace's own services are still there, once each.
    const all = (await wallet.find({})).services;
    expect(all.filter((service) => service.name === "Haiku Writer")).toHaveLength(1);

    // And it can be hired from what was found.
    const { job, approval } = await wallet.hire({ agentId: buyer.id, listing: found[0]!.listing, request: "A line about tea." });
    expect(approval).toBeNull();
    expect(job.status).toBe("waiting");

    // Off offer again, it is not offered to anyone.
    await wallet.setOffer(worker.id, null);
    expect((await wallet.find({ query: "friendly line" })).services.map((service) => service.name)).not.toContain("Line Writer");
  }, 120_000);

  it("points an old listing at where its description is really published", async () => {
    // A listing made before descriptions were published first names an
    // address nobody can read. The safety check and buyers read the listing's
    // address, so it is moved, with the same words, before anything else.
    const store = { base: null as string | null };
    world = await startWorld({
      earn: EARN,
      services: (base) => ({
        ...base,
        async publishListing(input) {
          const uri = await base.publishListing(input);
          return store.base === null || uri === null ? uri : `${store.base}/${input.specHashHex}.json`;
        },
      }),
    });
    const current = world;
    const created = await current.wallet.createAgent("Worker");
    await current.wallet.setEarn(created.id, true, 10);
    await current.wallet.setOffer(created.id, LINE_WRITER);
    const worker = await offerReaches(current, created.id, "live");
    const listing = worker.earn.offer!.listing as Address;
    const before = (await readListing(current.sandbox.chain, listing))!;
    expect(before.specUri).toMatch(/^agenc:\/\/job-spec\/sha256\/[0-9a-f]{64}$/);

    // The journal of an older wallet: it does not say where the description is.
    await current.wallet.close();
    const file = path.join(current.dataDir, "state.json");
    const journal = JSON.parse(readFileSync(file, "utf8"));
    delete journal.agents[created.id].earn.offer.specUri;
    writeFileSync(file, JSON.stringify(journal));
    store.base = "https://descriptions.example/job-specs";

    current.wallet = await current.reopen();
    const back = await offerReaches(current, created.id, "live");
    expect(back.earn.offer!.listing).toBe(listing);
    const after = (await readListing(current.sandbox.chain, listing))!;
    const hash = Buffer.from(after.specHash as Uint8Array).toString("hex");
    expect(after.specUri).toBe(`https://descriptions.example/job-specs/${hash}.json`);
    // Same words, same price: only the address moved.
    expect(Buffer.from(after.specHash as Uint8Array)).toEqual(Buffer.from(before.specHash as Uint8Array));
    expect(after.price).toBe(before.price);
    // And it is not moved a second time.
    const version = after.version;
    await current.wallet.tick();
    await current.wallet.tick();
    expect((await readListing(current.sandbox.chain, listing))!.version).toBe(version);
  }, 120_000);

  it("stays off offer on a computer that cannot run jobs", async () => {
    const { current, worker } = await startOffering();
    const listing = worker.earn.offer!.listing as Address;
    await current.wallet.close();

    // The same wallet, opened where there is no program to do the work.
    current.wallet = await current.reopen({ earn: { executor: null } });
    expect((await current.wallet.overview()).earning).toBe("off");
    await current.wallet.tick();
    await current.wallet.tick();
    const view = await agentView(current, worker.id);
    expect(view.earn.offer!.status).toBe("paused");
    expect(Number((await readListing(current.sandbox.chain, listing))!.state)).toBe(1);
    // The deposit behind its registration is still locked, and still shown.
    expect(view.earn.setAside.lamports).toBe("10000000");
  }, 120_000);

  it("does not keep asking about a description the safety check refused", async () => {
    world = await startWorld({ earn: EARN });
    const { wallet, sandbox } = world;
    const attest = sandbox.services.attestListing.bind(sandbox.services);
    let asked = 0;
    sandbox.services.attestListing = async (input) => {
      asked += 1;
      const words = JSON.stringify(input.spec);
      if (words.includes("forbidden")) {
        throw new WalletError("NOT_ALLOWED", "The description did not pass the safety check.");
      }
      return attest(input);
    };
    const worker = await wallet.createAgent("Worker");
    await wallet.setEarn(worker.id, true, 10);
    await wallet.setOffer(worker.id, { ...LINE_WRITER, summary: "Something forbidden." });

    const refused = await offerReaches(world, worker.id, "problem");
    expect(refused.earn.offer!.statusText).toBe("The description did not pass the safety check.");
    expect(asked).toBe(1);
    world.clock.now += 10 * 60_000;
    await wallet.tick();
    await wallet.tick();
    expect(asked).toBe(1);

    // Different words are a new question.
    await wallet.setOffer(worker.id, LINE_WRITER);
    await offerReaches(world, worker.id, "live");
    expect(asked).toBe(2);
  }, 120_000);

  it("says so plainly when the balance cannot cover the listing", async () => {
    world = await startWorld({ earn: EARN });
    const { wallet } = world;
    const worker = await wallet.createAgent("Worker");
    await wallet.setEarn(worker.id, true, 10);
    // Everything else leaves the wallet before the service is offered.
    await wallet.withdraw(world.listing, "all");
    await wallet.setOffer(worker.id, LINE_WRITER);

    const stuck = await offerReaches(world, worker.id, "problem");
    expect(stuck.earn.offer!.statusText).toMatch(/not enough in your balance/);
    expect(stuck.earn.offer!.listing).not.toBeNull();
    expect(await readListing(world.sandbox.chain, stuck.earn.offer!.listing as Address)).toBeNull();
  }, 120_000);

  it("refuses an offer on a host that cannot run jobs, and bad terms", async () => {
    world = await startWorld();
    const idle = await world.wallet.createAgent("Idle");
    await expect(world.wallet.setOffer(idle.id, LINE_WRITER)).rejects.toMatchObject({
      code: "NOT_AVAILABLE",
    });
    await world.wallet.close();

    world = await startWorld({ earn: EARN });
    const worker = await world.wallet.createAgent("Worker");
    const bad = [
      { ...LINE_WRITER, name: "  " },
      { ...LINE_WRITER, name: "A name far too long for the marketplace to keep" },
      { ...LINE_WRITER, summary: "" },
      { ...LINE_WRITER, price: { lamports: "10" } },
    ];
    for (const offer of bad) {
      await expect(world.wallet.setOffer(worker.id, offer)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    // Set before taking jobs is switched on, it simply waits.
    const waiting = await world.wallet.setOffer(worker.id, LINE_WRITER);
    expect(waiting.earn.offer).toMatchObject({
      status: "paused",
      statusText: "Off offer while taking jobs is switched off.",
    });
  }, 120_000);
});
