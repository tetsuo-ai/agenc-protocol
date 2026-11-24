import { afterEach, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { stageChildResult } from "@tetsuo-ai/agenc-worker";
import {
  CHILD_LINEAGE,
  childShareCriterion,
  childPolicyFor,
  readChildDependency,
  withChildDependency,
} from "../src/child-hire.js";
import { openParentFixture, type ChildFixtureOptions } from "./child-hire-fixture.js";
import { CENT, confirmPayout, REVIEW_ALLOWANCE, type World } from "./harness.js";
let world: World;
let room: string;
afterEach(async () => {
  await world?.wallet.close();
  if (room) rmSync(room, { recursive: true, force: true });
});
async function parent(options?: ChildFixtureOptions) {
  const fixture = await openParentFixture(options);
  world = fixture.world;
  room = fixture.room;
  return fixture;
}
it("separates two escrows, recovers the same owner decision, imports only verified bytes and pays the child when the parent fails", async () => {
  const { grant, request, seller, buyer, job } = await parent();
  let wallet = world.wallet;
  const before = await world.balance(seller.address);
  const parentBalance = await world.balance(buyer.address);
  await expect(wallet.childHires.request({ ...grant, sellerAgentId: buyer.id }, request)).rejects.toThrow(
    /claim|seller/,
  );
  const [one, two] = await Promise.all([
    wallet.childHires.request(grant, request),
    wallet.childHires.request(grant, request),
  ]);
  expect(one.quote.id).toBe(two.quote.id);
  if (one.quote.terms && "hire" in one.quote.terms) expect(one.payout).toEqual(one.quote.terms.hire);
  expect(await world.balance(seller.address)).toBe(before);
  await expect(wallet.childHires.request(grant, { ...request, brief: "Changed" })).rejects.toThrow(
    /one supplier/,
  );
  await expect(wallet.decideApproval(one.quote.id, true)).rejects.toThrow();
  await expect(wallet.childHires.decide(grant.parentTask, "other", true)).rejects.toThrow(/quote/);
  const funded = await wallet.childHires.decide(grant.parentTask, one.quote.id, true);
  expect(funded.phase).toBe("funded");
  expect(funded.child.task).toBeTruthy();
  expect(funded.child.task).not.toBe(job.task);
  const spent = await world.balance(seller.address);
  expect(spent).toBeLessThan(before);
  expect(before - spent).toBeLessThanOrEqual(BigInt(one.maxDebit.lamports));
  expect(await world.balance(buyer.address)).toBe(parentBalance);
  // The client loses the reply. Reopen before retrying the same decision.
  await wallet.close();
  wallet = world.wallet = await world.reopen();
  const reopenedBalance = await world.balance(seller.address);
  expect((await wallet.childHires.decide(grant.parentTask, one.quote.id, true)).child.task).toBe(
    funded.child.task,
  );
  expect(await world.balance(seller.address)).toBe(reopenedBalance);
  expect(await world.sandbox.workOnce()).toBe(1);
  await expect(wallet.childHires.delivery({ ...grant, roomId: "other-room" })).rejects.toThrow(/another room/);
  const childJob = await wallet.getJob(one.child.jobId, true);
  const pic = childJob.result!.files[0]!;
  const artifacts = world.sandbox.deliveries as Map<string, Uint8Array>;
  const original = artifacts.get(pic.sha256)!;
  artifacts.set(pic.sha256, new Uint8Array(original.length));
  await expect(wallet.childHires.delivery(grant)).rejects.toThrow(/verif/);
  artifacts.set(pic.sha256, original);
  const result = await wallet.childHires.delivery(grant);
  const binding = {
    roomId: grant.roomId,
    claimedAt: grant.claimedAt,
    parentTask: grant.parentTask,
    childTask: funded.child.task!,
    purchaseKey: funded.purchaseKey,
  };
  const staged = await stageChildResult(room, binding, result);
  expect(await stageChildResult(room, binding, result)).toEqual(staged);
  await wallet.childHires.acknowledgeImport(grant, result.receipt);
  expect((await confirmPayout(wallet, one.child.jobId)).status).toBe("paid");
  await expect(wallet.rateJob(one.child.jobId, 5, true)).rejects.toThrow(/rating|stars/i);
  const quoteRating = Reflect.get(wallet, "quoteRating");
  if (typeof quoteRating === "function") {
    const q = await quoteRating.call(wallet, one.child.jobId, 5, true);
    const rate = () => Reflect.apply(wallet.rateJob, wallet, [one.child.jobId, 5, true, undefined, q.id]);
    const beforeStars = await world.balance(seller.address);
    if (
      BigInt(q.maximumDebit.lamports) + world.sandbox.chain.transferFeeLamports <=
      BigInt(one.reviewReserve.lamports)
    ) {
      await rate();
      expect(beforeStars - (await world.balance(seller.address))).toBeLessThanOrEqual(
        BigInt(q.maximumDebit.lamports),
      );
    } else {
      await expect(rate()).rejects.toThrow(/cap/);
      expect(await world.balance(seller.address)).toBe(beforeStars);
    }
  }
  world.sandbox.advanceClock(8 * 86400);
  await wallet.refundJob(job.id, true);
  const end = await wallet.childHires.timeline(job.task!);
  expect(end.child.status).toBe("paid");
  expect(end.parent.status).toBe("refunded");
}, 120000);
it("charges neither escrow on a decline and rejects an unapproved private share", async () => {
  const { grant, request, seller } = await parent({ privateInputs: true });
  const before = await world.balance(seller.address);
  await expect(
    world.wallet.childHires.request(grant, {
      ...request,
      privateCommitment: "a".repeat(64),
    }),
  ).rejects.toThrow(/original buyer/);
  const proposal = await world.wallet.childHires.request(grant, request);
  await world.wallet.childHires.decide(grant.parentTask, proposal.quote.id, false);
  expect((await world.wallet.childHires.request(grant, request)).phase).toBe("declined");
  expect(await world.balance(seller.address)).toBe(before);
}, 90000);
it("refuses the all-in cap even when the price alone fits", async () => {
  const { grant, request } = await parent({ cap: String(20n * CENT) });
  await expect(world.wallet.childHires.request(grant, request)).rejects.toThrow(/cap or daily/);
}, 90000);
it("reads the funded parent lineage before considering a grandchild", async () => {
  const { grant, request } = await parent({
    criteria: [CHILD_LINEAGE + "earlier job"],
  });
  await expect(world.wallet.childHires.request(grant, request)).rejects.toThrow(/another supplier/);
}, 90000);
it("rechecks the allowance and refunds an unstarted supplier independently", async () => {
  const { grant, request, seller, job } = await parent();
  const wallet = world.wallet;
  const proposal = await wallet.childHires.request(grant, request);
  await wallet.setPolicy(seller.id, {
    askAboveCents: 1000,
    refill: { ...REVIEW_ALLOWANCE, perDayCents: 1 },
  });
  await expect(wallet.childHires.decide(grant.parentTask, proposal.quote.id, true)).rejects.toThrow(
    /allowance/,
  );
  await wallet.setPolicy(seller.id, {
    askAboveCents: 1000,
    refill: { ...REVIEW_ALLOWANCE, perDayCents: 10000 },
  });
  await wallet.childHires.decide(grant.parentTask, proposal.quote.id, true);
  world.sandbox.advanceClock(601);
  world.clock.now += 601000;
  await wallet.refundJob(proposal.child.jobId, true);
  const seen = await wallet.childHires.timeline(job.task!);
  expect(seen.child.status).toBe("refunded");
  expect(seen.parent.status).toBe("working");
}, 90000);

it("binds opt-in and supplier-specific disclosure to the seller, service, brief and files", async () => {
  const { grant, request, seller, buyer, policy, listing } = await parent({
    privateInputs: true,
  });
  const spec = {
    custom: { listingMetadata: { fulfilment: { privateInputs: true } } },
  };
  const published = withChildDependency(spec, seller.address, policy);
  expect(readChildDependency(spec, seller.address)).toBeNull();
  expect(readChildDependency(published, seller.address)?.policy).toEqual(policy);
  const offer = { listing, listed: true, wanted: true, terms: { childPolicy: policy }, spec: published };
  const localSeller = { address: seller.address, earn: { offers: [offer] } } as unknown as Parameters<
    typeof childPolicyFor
  >[1];
  expect(childPolicyFor({}, localSeller, listing)).toEqual(policy);
  expect(childPolicyFor({ childPolicies: { [listing]: null } }, localSeller, listing)).toBeNull();
  expect(
    childPolicyFor({ childPolicies: { [listing]: { ...policy, returnBeforeSecs: 1 } } }, localSeller, listing),
  ).toBeNull();
  offer.wanted = false;
  expect(childPolicyFor({}, localSeller, listing)).toBeNull();
  expect(() => readChildDependency(published, buyer.address)).toThrow(/seller/);
  await expect(
    world.wallet.childHires.setPolicy(seller.id, listing, {
      ...policy,
      allowedListings: [listing],
    }),
  ).rejects.toThrow(/supply itself/);
  const shared = { ...request, privateCommitment: "b".repeat(64) };
  const consent = childShareCriterion(seller.address, shared);
  expect(consent).not.toBe(childShareCriterion(buyer.address, shared));
  expect(consent).not.toBe(childShareCriterion(seller.address, { ...shared, outputs: ["text"] }));
  await expect(world.wallet.childHires.request(grant, shared)).rejects.toThrow(/original buyer/);
}, 90000);

it("reserves time for delivery and review before the parent cutoff", async () => {
  const { grant, request, seller } = await parent({ returnBeforeSecs: 35900 });
  const balance = await world.balance(seller.address);
  await expect(world.wallet.childHires.request(grant, request)).rejects.toThrow(/cutoff/);
  expect(await world.balance(seller.address)).toBe(balance);
}, 90000);

it("shows a rejected supplier's review deadline while the parent claim keeps working", async () => {
  const { grant, request } = await parent();
  const wallet = world.wallet;
  const proposal = await wallet.childHires.request(grant, request);
  await wallet.childHires.decide(grant.parentTask, proposal.quote.id, true);
  await world.sandbox.workOnce();
  const draft = await wallet.draftReview(proposal.child.jobId, "reject", "The agreed result is incomplete.");
  await wallet.confirmReview(proposal.child.jobId, draft, true);
  const end = await wallet.childHires.timeline(grant.parentTask);
  expect(end.child.status).toBe("in_review");
  expect(end.child.reviewEndsAt).toBeGreaterThan(0);
  expect(end.child.action).toBe("View review options");
  expect(end.parent.status).toBe("working");
}, 90000);

it("keeps an unknown signed hire reserved across a restart and daily rollover, then binds its one landed task", async () => {
  let drop = false;
  let sends = 0;
  let reveal = false;
  let landed: (() => Promise<unknown>) | undefined;
  const { grant, request, seller } = await parent({
    world: {
      transport: (base) => ({
        ...base,
        async sendAndConfirm(tx) {
          if (!drop) return base.sendAndConfirm(tx);
          drop = false;
          sends++;
          landed = () => base.sendAndConfirm(tx);
          throw new Error("Connection closed with the purchase outcome unknown.");
        },
      }),
      chain: (chain) => ({
        ...chain,
        workOutcome: async (r) => (!reveal ? "pending" : chain.workOutcome!(r)),
      }),
    },
  });
  let wallet = world.wallet;
  const ask = await wallet.childHires.request(grant, request);
  drop = true;
  const unknown = await wallet.childHires.decide(grant.parentTask, ask.quote.id, true);
  expect(unknown.phase).toBe("dispatching");
  expect(unknown.child.task).toBeNull();
  expect(landed).toBeDefined();
  await wallet.close();
  wallet = world.wallet = await world.reopen();
  world.clock.now += 86400001;
  await wallet.setPolicy(seller.id, {
    askAboveCents: 1000,
    refill: { ...REVIEW_ALLOWANCE, perDayCents: 1 },
  });
  await wallet.getJob(ask.child.jobId, true);
  const { StateStore } = await import("../src/store.js");
  const { remainingJobMicrocents } = await import("../src/job-money.js");
  const { join } = await import("node:path");
  const state = StateStore.open(join(world.dataDir, "state.json"), world.clock.now).state;
  expect(remainingJobMicrocents(state.agents[seller.id]!, world.clock.now)).toBe(0n);
  expect((await wallet.childHires.timeline(grant.parentTask)).child.task).toBeNull();
  await landed!();
  reveal = true;
  await wallet.getJob(ask.child.jobId, true);
  expect((await wallet.childHires.timeline(grant.parentTask)).child.task).toBeTruthy();
  expect(sends).toBe(1);
}, 90000);
