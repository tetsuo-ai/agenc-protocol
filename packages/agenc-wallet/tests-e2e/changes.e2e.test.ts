// Asking for changes: the note's hash goes on-chain, the provider reads the
// note and delivers again, and the buyer then approves.
import { afterEach, describe, expect, it, vi } from "vitest";
import { startWorld, type World } from "./harness.js";

let world: World | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await world?.wallet.close();
  world = null;
});

describe("asking for changes", () => {
  it("sends a delivery back and gets a second one", async () => {
    world = await startWorld();
    const { wallet, sandbox, listing } = world;
    const agent = await wallet.createAgent("My assistant");
    await wallet.setPolicy(agent.id, {
      askAboveCents: 100,
      refill: { enabled: false, topUpToCents: 0, perDayCents: 0 },
    });
    await wallet.fundAgent(agent.id, { usdCents: 300 });
    const { job } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku." });
    await sandbox.workOnce();
    expect((await wallet.getJob(job.id, false, agent.id)).status).toBe("delivered");

    const sentBack = await wallet.askChanges(job.id, "Make it about the sea.", false, agent.id);
    expect(sentBack.status).toBe("changes_requested");
    expect(sentBack.canApprove).toBe(false);

    // The stock worker waits two minutes after delivering before it treats a
    // change as a new round (so a delayed confirmation is not mistaken for
    // one). Move the calendar, not the timers, past that wait.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 130_000);
    await sandbox.workOnce();
    vi.useRealTimers();
    const again = await wallet.getJob(job.id, false, agent.id);
    expect(again.status).toBe("delivered");
    expect(again.result?.verified).toBe(true);
    expect((await wallet.approveJob(job.id, undefined, false, agent.id)).status).toBe("paid");
  });
});
