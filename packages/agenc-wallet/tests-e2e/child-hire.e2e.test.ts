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
import { CENT, confirmPayout, REVIEW_ALLOWANCE, startWorld, type World } from "./harness.js";
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
  await expect(wallet.childHires.delivery({ ...grant, roomId: "other-room" })).rejects.toThrow(
    /another room/,
  );
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
  // The room import is not the paying agent's own inspection: its chat approval pays nothing.
  const childQuote = (await wallet.reviewRecord(one.child.jobId)).quote!;
  const imported = await world.balance(seller.address);
  await expect(wallet.approveJob(one.child.jobId, undefined, false, seller.id, childQuote.id)).rejects.toThrow(/Read the complete/);
  await expect(wallet.requireDeliveryInspection(one.child.jobId, seller.id, childQuote.deliveryHash, childQuote.submissionCount)).rejects.toThrow();
  expect(await world.balance(seller.address)).toBe(imported);
  expect((await confirmPayout(wallet, one.child.jobId)).status).toBe("paid");
  await wallet.childHires.acknowledgeImport(grant, result.receipt);
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
    childPolicyFor(
      { childPolicies: { [listing]: { ...policy, returnBeforeSecs: 1 } } },
      localSeller,
      listing,
    ),
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

it("recovers an awaiting-publication escrow after restart without a second hire", async () => {
  let offline = false;
  const { grant, request } = await parent({
    world: {
      services: (base) => ({
        ...base,
        attestTask(input) {
          if (offline) throw new Error("Local attestation is temporarily unavailable");
          return base.attestTask(input);
        },
      }),
    },
  });
  const ask = await world.wallet.childHires.request(grant, request);
  offline = true;
  const pending = await world.wallet.childHires.decide(grant.parentTask, ask.quote.id, true);
  expect(pending.phase).toBe("awaiting-publication");
  await world.wallet.close();
  world.wallet = await world.reopen();
  offline = false;
  await world.wallet.tick();
  const active = await world.wallet.childHires.timeline(grant.parentTask);
  expect(active.phase).toBe("funded");
  expect(active.child.task).toBe(pending.child.task);
  expect(active.child.signature).toBeNull();
  expect(active.child.fundingSignature).toBeTruthy();
  expect(await world.sandbox.workOnce()).toBe(1);
}, 90000);

it("keeps overdue status reads observational and leaves the owner able to recover the escrow", async () => {
  const { grant, request, seller } = await parent();
  const ask = await world.wallet.childHires.request(grant, request);
  await world.wallet.childHires.decide(grant.parentTask, ask.quote.id, true);
  const balance = await world.balance(seller.address);
  world.sandbox.advanceClock(601);
  world.clock.now += 601000;
  expect((await world.wallet.getJob(ask.child.jobId, true)).status).toBe("waiting");
  expect(await world.balance(seller.address)).toBe(balance);
  expect((await world.wallet.refundJob(ask.child.jobId, true)).status).toBe("refunded");
}, 90000);

it("refreshes an expired quote by purchase key and declines its replacement without funding", async () => {
  const { grant, request } = await parent();
  const ask = await world.wallet.childHires.request(grant, request);
  world.clock.now = ask.quote.expiresAt + 1;
  const fresh = await world.wallet.childHires.refresh(grant.parentTask, ask.quote.id);
  expect(fresh.purchaseKey).toBe(ask.purchaseKey);
  expect(fresh.quote.id).not.toBe(ask.quote.id);
  world.clock.now = fresh.quote.expiresAt + 1;
  expect((await world.wallet.childHires.decide(grant.parentTask, fresh.quote.id, false)).phase).toBe(
    "declined",
  );
}, 90000);

it("replaces unacknowledged staging and refuses an older submission at acknowledgement", async () => {
  const { grant, request } = await parent();
  const wallet = world.wallet;
  const ask = await wallet.childHires.request(grant, request);
  await wallet.childHires.decide(grant.parentTask, ask.quote.id, true);
  await world.sandbox.workOnce();
  const first = await wallet.childHires.delivery(grant);
  // Simulate a replacement landing between the two host calls. The room has
  // already copied round one and the supplier may reuse the same file bytes.
  const { address } = await import("@solana/kit");
  const { findClaimPda, findTaskSubmissionPda, getTaskSubmissionEncoder, getTaskSubmissionDecoder } =
    await import("@tetsuo-ai/marketplace-sdk");
  const [claim] = await findClaimPda({ task: address(first.childTask), bidder: address(ask.supplier) });
  const [submission] = await findTaskSubmissionPda({ claim });
  const svm = world.sandbox.market.svm;
  const original = svm.getAccount(submission)!;
  if (!original.exists) throw new Error("Missing supplier submission");
  const data = getTaskSubmissionDecoder().decode(original.data);
  svm.setAccount({
    ...original,
    data: getTaskSubmissionEncoder().encode({ ...data, submissionCount: data.submissionCount + 1 }),
  } as never);
  await expect(wallet.childHires.acknowledgeImport(grant, first.receipt)).rejects.toThrow();
  const next = await wallet.childHires.delivery(grant);
  expect(next.round).toBeGreaterThan(first.round);
  await expect(wallet.childHires.acknowledgeImport(grant, first.receipt)).rejects.toThrow();
  await wallet.childHires.acknowledgeImport(grant, next.receipt);
}, 90000);

it("serves bounded local parts after a single verified stage", async () => {
  let reads = 0;
  const { grant, request } = await parent({
    world: {
      services: (base) => ({
        ...base,
        fetchFile(hash) {
          reads++;
          return base.fetchFile(hash);
        },
      }),
    },
  });
  const wallet = world.wallet;
  const ask = await wallet.childHires.request(grant, request);
  await wallet.childHires.decide(grant.parentTask, ask.quote.id, true);
  await world.sandbox.workOnce();
  const { childHireHandlers } = await import("../src/child-hire.js");
  const handlers = childHireHandlers(wallet);
  const manifest = await handlers["child.delivery"]({ grant });
  const count = reads;
  expect(count).toBeGreaterThan(0);
  expect((await handlers["child.delivery"]({ grant })).receipt).toBe(manifest.receipt);
  for (const offset of [0, 1, 0]) {
    const part = await handlers["child.part"]({
      grant,
      receipt: manifest.receipt,
      part: "postcard.png",
      offset,
    });
    expect(Buffer.from(part.base64, "base64").length).toBeLessThanOrEqual(24576);
  }
  expect(reads).toBe(count);
}, 90000);

it("persists a failed dispatch outcome with its fee and clears the pending marker", async () => {
  let lost = false;
  const { grant, request } = await parent({
    world: {
      transport: (base) => ({
        ...base,
        sendAndConfirm(tx) {
          if (lost) throw new Error("Disconnected after dispatch");
          return base.sendAndConfirm(tx);
        },
      }),
      chain: (base) => ({
        ...base,
        workOutcome: async () => "failed",
        reviewDebit: async () => ({ fee: 5000n, debit: 5000n }),
      }),
    },
  });
  const ask = await world.wallet.childHires.request(grant, request);
  lost = true;
  await world.wallet.childHires.decide(grant.parentTask, ask.quote.id, true);
  await world.wallet.getJob(ask.child.jobId, true);
  const { StateStore } = await import("../src/store.js");
  const { childState } = await import("../src/child-hire-store.js");
  const stored = childState(StateStore.open(world.dataDir + "/state.json", world.clock.now).state)
    .childHires![grant.parentTask]!;
  expect(stored.view.phase).toBe("failed");
  expect(stored.send).toBeUndefined();
  expect(stored.dispatch).toMatchObject({ outcome: "failed", fee: "5000", signature: expect.any(String) });
}, 90000);

it("stops failed frozen settlements at the quoted fee limit across restart", async () => {
  let fail = false,
    attempts = 0,
    childTask = "";
  const { getCompiledTransactionMessageDecoder } = await import("@solana/kit");
  const { grant, request } = await parent({
    world: {
      transport: (base) => ({
        ...base,
        sendAndConfirm(tx) {
          if (
            fail &&
            getCompiledTransactionMessageDecoder()
              .decode(tx.messageBytes)
              .staticAccounts.some((a) => a === childTask)
          ) {
            attempts++;
            throw new Error("Synthetic execution failure");
          }
          return base.sendAndConfirm(tx);
        },
      }),
      chain: (base) => ({
        ...base,
        reviewSendOutcome: (r) => (fail ? Promise.resolve("failed") : base.reviewSendOutcome!(r)),
        reviewDebit: (s, p) =>
          fail ? Promise.resolve({ fee: 5000n, debit: 5000n }) : base.reviewDebit!(s, p),
      }),
    },
  });
  const wallet = world.wallet;
  const ask = await wallet.childHires.request(grant, request);
  childTask = (await wallet.childHires.decide(grant.parentTask, ask.quote.id, true)).child.task!;
  await world.sandbox.workOnce();
  await wallet.confirmReview(
    ask.child.jobId,
    await wallet.draftReview(ask.child.jobId, "reject", "The report is incomplete."),
    true,
  );
  world.sandbox.advanceClock(4 * 86400);
  fail = true;
  await wallet.getJob(ask.child.jobId, true);
  expect(attempts).toBe(0);
  for (let i = 0; i < 6; i++) {
    world.clock.now += 300000;
    await world.wallet.tick();
    if (i === 1) {
      await world.wallet.close();
      world.wallet = await world.reopen();
    }
  }
  expect(attempts).toBeGreaterThan(0);
  expect(attempts).toBeLessThanOrEqual(2);
}, 90000);

it("binds the quoted treasury at funding and rotates the settlement quote when it changes", async () => {
  const { grant, request, buyer, seller } = await parent();
  const wallet = world.wallet,
    svm = world.sandbox.market.svm;
  const { findProtocolConfigPda, getProtocolConfigDecoder, getProtocolConfigEncoder } =
    await import("@tetsuo-ai/marketplace-sdk");
  const [id] = await findProtocolConfigPda();
  const original = svm.getAccount(id)!;
  if (!original.exists) throw new Error("Missing protocol configuration");
  const config = getProtocolConfigDecoder().decode(new Uint8Array(original.data));
  function rotate() {
    svm.setAccount({
      ...original,
      data: Uint8Array.from(
        getProtocolConfigEncoder().encode({ ...config, treasury: buyer.address as typeof config.treasury }),
      ),
    } as never);
  }
  const ask = await wallet.childHires.request(grant, request);
  const before = await world.balance(seller.address);
  rotate();
  await expect(wallet.childHires.decide(grant.parentTask, ask.quote.id, true)).rejects.toThrow(/changed/);
  expect(await world.balance(seller.address)).toBe(before);
  svm.setAccount(original as never);
  await wallet.childHires.decide(grant.parentTask, ask.quote.id, true);
  await world.sandbox.workOnce();
  const read = async () =>
    (await wallet.reviewRecord(ask.child.jobId, undefined, { termsOnly: true })).quote!;
  const prior = await read();
  rotate();
  const fresh = await read();
  expect(fresh.id).not.toBe(prior.id);
  expect(fresh.treasury).toBe(buyer.address);
  await expect(wallet.approveJob(ask.child.jobId, undefined, true, undefined, prior.id)).rejects.toThrow();
  await wallet.confirmReview(
    ask.child.jobId,
    await wallet.draftReview(ask.child.jobId, "reject", "Missing the requested document."),
    true,
  );
  const frozen = await wallet.childHires.timeline(grant.parentTask);
  expect(frozen.settlementRecipient?.treasury).toBe(buyer.address);
  svm.setAccount(original as never);
  await expect(
    wallet.childHires.decide(grant.parentTask, frozen.settlementRecipient!.quoteId, true),
  ).rejects.toThrow(/quote/);
  rotate();
  await wallet.childHires.decide(grant.parentTask, frozen.settlementRecipient!.quoteId, true);
  world.sandbox.advanceClock(4 * 86400);
  await wallet.tick();
  expect((await wallet.childHires.timeline(grant.parentTask)).child.status).toBe("refunded");
}, 90000);

it("rejects a matching public criterion before calling private staging", async () => {
  const { address } = await import("@solana/kit");
  const { readAgent, readHireableListing } = await import("../src/market.js");
  const commitment = "ab".repeat(32);
  // E: the buyer's checkout refuses a caller-written share criterion before any order exists.
  await expect(
    openParentFixture(
      {
        privateInputs: true,
        prepareCriteria: async (w, input) => {
          const listing = await readHireableListing(w.sandbox.chain, address(input.listing));
          const supplier = (await readAgent(w.sandbox.chain, listing.providerAgent))!.authority;
          return [childShareCriterion(supplier, { ...input, privateCommitment: commitment })];
        },
      },
      async (o) => (world = await startWorld(o)),
    ),
  ).rejects.toThrow(/approved private input/);
}, 90000);

it("keeps another child's review SOL when the owner reclaims a specific amount", async () => {
  const { grant, request, seller } = await parent();
  const wallet = world.wallet;
  const ask = await wallet.childHires.request(grant, request);
  await wallet.childHires.decide(grant.parentTask, ask.quote.id, true);
  const before = await world.balance(seller.address);
  const floor = await world.sandbox.chain.getMinimumBalanceForRentExemption(0);
  const amount = before - floor - world.sandbox.chain.transferFeeLamports;
  await expect(wallet.reclaimFromAgent(seller.id, { lamports: String(amount) })).rejects.toThrow(
    /much to give back/,
  );
  expect(await world.balance(seller.address)).toBe(before);
}, 90000);

it("imports a first-seen paid supplier delivery with its settled round after restart", async () => {
  const { grant, request } = await parent();
  const ask = await world.wallet.childHires.request(grant, request);
  await world.wallet.childHires.decide(grant.parentTask, ask.quote.id, true);
  await world.sandbox.workOnce();
  expect((await confirmPayout(world.wallet, ask.child.jobId)).status).toBe("paid");
  await world.wallet.close();
  world.wallet = await world.reopen();
  const result = await world.wallet.childHires.delivery(grant);
  expect(result.round).toBe(1);
  expect(result.files[0]?.name).toBe("postcard.png");
  await world.wallet.childHires.acknowledgeImport(grant, result.receipt);
}, 90000);
