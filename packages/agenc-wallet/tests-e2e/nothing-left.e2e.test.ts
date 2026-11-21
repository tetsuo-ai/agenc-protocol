// Taking money back, or sending it all out, leaves nothing of the person's
// behind where it can never be used. A wallet that is not empty must keep the
// network's minimum, so "all" keeps it only while a job or earning may still
// need that wallet to pay; otherwise the wallet is emptied, less the fee of
// the transfer itself.
import type { Address } from "@solana/kit";
import { afterEach, describe, expect, it } from "vitest";
import { FEE_HEADROOM_LAMPORTS } from "../src/market.js";
import { CENT, eventually, startWorld, type World } from "./harness.js";

let world: World | null = null;
afterEach(async () => {
  await world?.wallet.close();
  world = null;
});

/** An agent that takes jobs runs this as its job program. */
const EARN = {
  executor: {
    argv: [process.execPath, "-e", "process.stdout.write('Here is the finished work.')", "{prompt}"],
    mode: "sandboxed" as const,
    envAllowlist: [],
    timeoutMs: 30_000,
  },
  pollIntervalMs: 150,
};

/** Somewhere outside the wallet to send money to. */
const OUTSIDE = "11111111111111111111111111111112";
const FEE = 5_000n;

async function agentWith(current: World, cents: number) {
  const agent = await current.wallet.createAgent("My assistant");
  await current.wallet.setPolicy(agent.id, {
    askAboveCents: 1_000,
    refill: { enabled: false, topUpToCents: 0, perDayCents: 0 },
  });
  await current.wallet.fundAgent(agent.id, { usdCents: cents });
  return agent;
}

describe("taking everything back", () => {
  it("brings all of an agent's money back when nothing needs it, and leaves its wallet empty", async () => {
    world = await startWorld();
    const { wallet } = world;
    const agent = await agentWith(world, 300);
    const held = await world.balance(agent.address);
    const mainBefore = await world.balance(wallet.mainAddress);

    const back = await wallet.reclaimFromAgent(agent.id, "all");
    expect(back.balance.lamports).toBe("0");
    expect(await world.balance(agent.address)).toBe(0n);
    // Everything came back but the transfer's own fee.
    expect((await world.balance(wallet.mainAddress)) - mainBefore).toBe(held - FEE);
    // Nothing is left to take back, and the agent can be given money again.
    await expect(wallet.reclaimFromAgent(agent.id, "all")).rejects.toMatchObject({ code: "NOT_ENOUGH_MONEY" });
    expect((await wallet.fundAgent(agent.id, { usdCents: 100 })).balance.usdCents).toBe(100);
  });

  it("keeps what an agent's open job still needs, so the job can finish", async () => {
    world = await startWorld();
    const { wallet, sandbox, listing } = world;
    const agent = await agentWith(world, 300);
    const { job } = await wallet.hire({ agentId: agent.id, listing, request: "A haiku." });
    expect(job.status).toBe("waiting");

    await wallet.reclaimFromAgent(agent.id, "all");
    // The network's minimum, the room for fees the job was set up with, and
    // (revision 9) what a first cancel or turn-down spends on the wallet's
    // marketplace record, so the job can still be cancelled or turned down.
    expect(await world.balance(agent.address)).toBe(
      (await sandbox.chain.getMinimumBalanceForRentExemption(0)) +
        FEE_HEADROOM_LAMPORTS +
        (await sandbox.chain.getMinimumBalanceForRentExemption(129)),
    );
    // So the job still finishes: delivered, paid, and its deposits back.
    await sandbox.workOnce();
    expect((await wallet.getJob(job.id, true)).status).toBe("delivered");
    expect((await wallet.approveJob(job.id, undefined, true)).status).toBe("paid");
    // Once it is tidied, nothing needs the agent's money any more.
    world.clock.now += 2 * 60 * 60_000;
    await wallet.tick();
    await wallet.reclaimFromAgent(agent.id, "all");
    expect(await world.balance(agent.address)).toBe(0n);
  });

  it("keeps the minimum in an agent that takes jobs", async () => {
    world = await startWorld({ earn: EARN });
    const { wallet } = world;
    const agent = await agentWith(world, 300);
    await wallet.setEarn(agent.id, true, 10);
    // Once it is registered and watching for jobs, nothing else moves its money.
    await eventually(async () => {
      const earn = (await wallet.overview()).agents[0]!.earn;
      return earn.state === "watching" && earn.setAside.lamports !== "0";
    }, 30_000);
    await wallet.reclaimFromAgent(agent.id, "all");
    expect(await world.balance(agent.address)).toBe(
      await world.sandbox.chain.getMinimumBalanceForRentExemption(0),
    );
    await wallet.setEarn(agent.id, false, 10);
  });

  it("sends everything out of the balance when nothing needs it", async () => {
    world = await startWorld();
    const { wallet } = world;
    const before = await world.balance(wallet.mainAddress);
    const outside = await world.balance(OUTSIDE);

    await wallet.withdraw(OUTSIDE, "all");
    expect(await world.balance(wallet.mainAddress)).toBe(0n);
    expect((await world.balance(OUTSIDE)) - outside).toBe(before - FEE);
    expect((await wallet.overview()).main.balance.lamports).toBe("0");
  });

  it("keeps what a request posted from the balance still needs, so it can be cancelled", async () => {
    world = await startWorld();
    const { wallet } = world;
    const posted = await wallet.postFromBalance({
      request: "Write a haiku about a lighthouse.",
      reward: { usdCents: 5 },
    });
    expect(posted.status).toBe("waiting");

    await wallet.withdraw(OUTSIDE, "all");
    // Revision 9: the first cancel starts the wallet's marketplace record,
    // so that is kept too.
    expect(await world.balance(wallet.mainAddress)).toBe(
      (await world.sandbox.chain.getMinimumBalanceForRentExemption(0)) +
        FEE_HEADROOM_LAMPORTS +
        (await world.sandbox.chain.getMinimumBalanceForRentExemption(129)),
    );
    // So the request can still be cancelled, and its reward comes back.
    const cancelled = await wallet.refundJob(posted.id, true);
    expect(cancelled.status).toBe("refunded");
    expect(await world.balance(wallet.mainAddress as Address)).toBeGreaterThan(5n * CENT);
  });
});
