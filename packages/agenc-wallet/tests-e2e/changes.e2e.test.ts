// Asking for changes: the note's hash goes on-chain, the provider reads the
// note and delivers again, and the buyer then approves.
import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmDecision, REVIEW_ALLOWANCE, startWorld, type World } from "./harness.js";

let world: World | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await world?.wallet.close();
  world = null;
});

describe("asking for changes", () => {
  it("sends a delivery back and keeps its note away from the practice host executor", async () => {
    world = await startWorld();
    const { wallet, sandbox, listing } = world;
    const agent = await wallet.createAgent("My assistant");
    await wallet.setPolicy(agent.id, {
      askAboveCents: 100,
      refill: REVIEW_ALLOWANCE,
    });
    await wallet.fundAgent(agent.id, { usdCents: 300 });
    const { job } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku." });
    await sandbox.workOnce();
    const delivered = await wallet.getJob(job.id, false, agent.id);
    expect(delivered.status).toBe("delivered");
    expect(delivered.canAskChanges).toBe(true);

    await expect(wallet.askChanges(job.id, "Make it about the sea.", false, agent.id)).rejects.toMatchObject({ code: "NOT_ALLOWED" });
    const sentBack = await confirmDecision(wallet, job.id, "change", "Make it about the sea.");
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
    expect(again.status).toBe("changes_requested");
    expect(again.canApprove).toBe(false);
  });

  it("is not offered where the note could never reach the provider", async () => {
    // A network with no message host: the note's fingerprint could be
    // recorded, but nobody could read the words.
    world = await startWorld({
      services: ({ postChangeRequest: _noMessageHost, ...rest }) => rest,
    });
    const { wallet, sandbox, listing } = world;
    const agent = await wallet.createAgent("My assistant");
    await wallet.setPolicy(agent.id, {
      askAboveCents: 100,
      refill: REVIEW_ALLOWANCE,
    });
    await wallet.fundAgent(agent.id, { usdCents: 300 });
    const { job } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku." });
    await sandbox.workOnce();

    for (const isOwner of [true, false]) {
      const delivered = await wallet.getJob(job.id, isOwner, isOwner ? undefined : agent.id);
      expect(delivered.status).toBe("delivered");
      expect(delivered.canAskChanges).toBe(false);
      // Everything else a buyer can do with a delivery is still there.
      expect(delivered.canApprove).toBe(true);
    }
    expect((await wallet.listJobs({ role: "buying" }, true))[0]!.canAskChanges).toBe(false);
    await expect(wallet.askChanges(job.id, "Make it about the sea.", true)).rejects.toMatchObject({
      code: "APPROVAL_REQUIRED",
    });
    // Nothing was sent back: the delivery is still there to approve.
    expect((await wallet.approveJob(job.id, undefined, true)).status).toBe("paid");
  });
});
