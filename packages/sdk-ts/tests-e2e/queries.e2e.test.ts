import { describe, it, expect, beforeAll } from "vitest";
import { lamports, type Address, type KeyPairSigner } from "@solana/kit";
import type { LiteSVM } from "litesvm";
import {
  facade,
  findAgentPda,
  findTaskPda,
  findClaimPda,
  findBidPda,
  findBidBookPda,
  findBidMarketplacePda,
  findBidderMarketStatePda,
  findHireRecordPda,
  findEscrowPda,
  findListingPda,
  findTaskJobSpecPda,
  findModerationBlockPda,
  getBidMarketplaceConfigEncoder,
  getTaskDecoder,
  getTaskJobSpecDecoder,
  getTaskClaimSize,
  ListingState,
  TaskStatus,
} from "../src/index.js";
import {
  bidsByTask,
  listActiveListings,
  listClaimsForWorker,
  listHireRecordsForBuyer,
  listingsByProvider,
  listOpenTasks,
} from "../src/queries/index.js";
import {
  freshSvm,
  seedProtocolConfig,
  seedModerationConfig,
  fundedSigner,
  send,
  accountData,
  PROGRAM,
} from "./harness.js";
import { GpaSimulator } from "./gpa-sim.js";

async function moderationBlockFor(contentHash: Uint8Array) {
  return (await findModerationBlockPda({ contentHash }))[0];
}

// REAL on-chain world for the query layer: listings (2 providers, 2 categories,
// one paused), tasks (2 creators, one claimed so its status differs), bids on two
// BidExclusive tasks, and a hire (Task + HireRecord) minted from a listing — all
// driven through SDK facade instructions against the compiled program. Every
// created address (plus plenty of non-matching noise accounts) is registered in
// a GpaSimulator, and each query helper must return EXACTLY the matching subset.

const PRICE = 1_000_000n;
const REWARD = 4_000_000n;
const RICH_REWARD = 10_000_000n;

/** NUL-pad a category string to the 32-byte on-chain form (same as the helper). */
function cat32(s: string): Uint8Array {
  const b = new Uint8Array(32);
  b.set(new TextEncoder().encode(s));
  return b;
}

function addrs(rows: Array<{ address: Address }>): Set<Address> {
  return new Set(rows.map((r) => r.address));
}

/**
 * Seed the singleton BidMarketplaceConfig directly. The real initializer is
 * multisig-gated (2-of-N owners), which litesvm tests don't stand up — same
 * pattern as the harness's seeded ProtocolConfig/ModerationConfig.
 */
async function seedBidMarketplace(
  svm: LiteSVM,
  authority: Address,
): Promise<Address> {
  const [pda, bump] = await findBidMarketplacePda();
  const data = getBidMarketplaceConfigEncoder().encode({
    authority,
    minBidBondLamports: 100_000n,
    bidCreationCooldownSecs: 0n,
    maxBidsPer24h: 100,
    maxActiveBidsPerTask: 10,
    maxBidLifetimeSecs: 86_400n,
    acceptedNoShowSlashBps: 0,
    bump,
  });
  svm.setAccount({
    address: pda,
    data,
    executable: false,
    lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(data.length))),
    programAddress: PROGRAM,
    space: BigInt(data.length),
  });
  return pda;
}

describe("e2e: query helpers return exactly the matching on-chain subset", () => {
  let svm: LiteSVM;
  let sim: GpaSimulator;
  let providerA: KeyPairSigner;
  let creator1: KeyPairSigner;
  let creator2: KeyPairSigner;
  let agentA: Address;
  let agentB: Address;
  let L1: Address, L2: Address, L3: Address;
  let T1: Address, T2: Address, T3: Address, T4: Address, T5: Address, T6: Address;
  let C3: Address; // agentA's claim on T3
  let B4A: Address, B4B: Address, B5A: Address; // bids
  let H1: Address; // hire record for T6

  beforeAll(async () => {
    svm = freshSvm();
    sim = new GpaSimulator(svm);

    const admin = await fundedSigner(svm);
    const moderator = await fundedSigner(svm);
    const protocolConfig = await seedProtocolConfig(svm, admin.address);
    const moderationConfig = await seedModerationConfig(
      svm,
      admin.address,
      moderator.address,
      true,
    );

    providerA = await fundedSigner(svm);
    const providerB = await fundedSigner(svm);
    creator1 = await fundedSigner(svm);
    creator2 = await fundedSigner(svm);

    // ---- agents (capabilities bit 0 everywhere) ----
    const ids = {
      agentA: new Uint8Array(32).fill(1),
      agentB: new Uint8Array(32).fill(2),
      agentC1: new Uint8Array(32).fill(3),
      agentC2: new Uint8Array(32).fill(4),
    };
    for (const [signer, agentId, endpoint] of [
      [providerA, ids.agentA, "http://a.test"],
      [providerB, ids.agentB, "http://b.test"],
      [creator1, ids.agentC1, "http://c1.test"],
      [creator2, ids.agentC2, "http://c2.test"],
    ] as const) {
      await send(svm, signer, [
        await facade.registerAgent({
          authority: signer,
          agentId,
          capabilities: 1n,
          endpoint,
          metadataUri: null,
          stakeAmount: 0n,
        }),
      ]);
    }
    [agentA] = await findAgentPda({ agentId: ids.agentA });
    [agentB] = await findAgentPda({ agentId: ids.agentB });
    const [agentC1] = await findAgentPda({ agentId: ids.agentC1 });
    const [agentC2] = await findAgentPda({ agentId: ids.agentC2 });

    // ---- listings: 2 providers, 2 categories; L2 gets paused ----
    const l1SpecHash = new Uint8Array(32).fill(7);
    const mkListing = async (
      signer: KeyPairSigner,
      agent: Address,
      listingId: Uint8Array,
      category: Uint8Array,
      specHash: Uint8Array,
    ): Promise<Address> => {
      await send(svm, signer, [
        await facade.createServiceListing({
          providerAgent: agent,
          authority: signer,
          listingId,
          name: new Uint8Array(32).fill(0x4e),
          category,
          tags: new Uint8Array(64).fill(3),
          specHash,
          specUri: "agenc://job-spec/sha256/queries",
          price: PRICE,
          priceMint: null,
          requiredCapabilities: 1n,
          defaultDeadlineSecs: 3600n,
          maxOpenJobs: 0,
          operator: null,
          operatorFeeBps: 0,
        }),
      ]);
      const [listing] = await findListingPda({ providerAgent: agent, listingId });
      return listing;
    };
    L1 = await mkListing(providerA, agentA, new Uint8Array(32).fill(5), cat32("code"), l1SpecHash);
    L2 = await mkListing(providerA, agentA, new Uint8Array(32).fill(6), cat32("design"), new Uint8Array(32).fill(8));
    L3 = await mkListing(providerB, agentB, new Uint8Array(32).fill(5), cat32("code"), new Uint8Array(32).fill(9));
    await send(svm, providerA, [
      await facade.setServiceListingState({
        listing: L2,
        providerAgent: agentA,
        authority: providerA,
        state: "Paused",
      }),
    ]);

    // ---- tasks: 2 creators; T3 gets claimed (InProgress); T4/T5 BidExclusive ----
    const now = svm.getClock().unixTimestamp;
    const mkTask = async (
      signer: KeyPairSigner,
      creatorAgent: Address,
      taskId: Uint8Array,
      requiredCapabilities: bigint,
      rewardAmount: bigint,
      taskType: number,
    ): Promise<Address> => {
      await send(svm, signer, [
        await facade.createTask({
          authority: signer,
          creator: signer,
          creatorAgent,
          taskId,
          requiredCapabilities,
          description: new Uint8Array(64).fill(0x44, 0, 32),
          rewardAmount,
          maxWorkers: 1,
          deadline: now + 3600n,
          taskType,
          constraintHash: null,
          minReputation: 0,
          rewardMintArg: null,
        }),
      ]);
      const [task] = await findTaskPda({ creator: signer.address, taskId });
      return task;
    };
    T1 = await mkTask(creator1, agentC1, new Uint8Array(32).fill(10), 1n, REWARD, 0);
    T2 = await mkTask(creator1, agentC1, new Uint8Array(32).fill(11), 0b10n, RICH_REWARD, 0);
    T3 = await mkTask(creator2, agentC2, new Uint8Array(32).fill(12), 1n, REWARD, 0);
    T4 = await mkTask(creator1, agentC1, new Uint8Array(32).fill(14), 1n, REWARD, 3); // BidExclusive
    T5 = await mkTask(creator2, agentC2, new Uint8Array(32).fill(15), 1n, REWARD, 3); // BidExclusive

    // Assignment and bid entry both pin a creator-published, moderated spec.
    const t3JobHash = new Uint8Array(32).fill(13);
    const t4JobHash = new Uint8Array(32).fill(14);
    const t5JobHash = new Uint8Array(32).fill(15);
    const publishTaskSpec = async (
      task: Address,
      creator: KeyPairSigner,
      jobSpecHash: Uint8Array,
      tag: string,
    ) => {
      await send(svm, moderator, [
        await facade.recordTaskModeration({
          moderator,
          task,
          jobSpecHash,
          status: 0,
          riskScore: 0,
          categoryMask: 0n,
          policyHash: new Uint8Array(32).fill(1),
          scannerHash: new Uint8Array(32).fill(2),
          expiresAt: 0n,
        }),
      ]);
      await send(svm, creator, [
        await facade.setTaskJobSpec({
          creator,
          task,
          jobSpecHash,
          jobSpecUri: `agenc://job-spec/sha256/${tag}`,
          moderator: moderator.address,
        }),
      ]);
    };
    await publishTaskSpec(T3, creator2, t3JobHash, "queries-t3");
    await publishTaskSpec(T4, creator1, t4JobHash, "queries-t4");
    await publishTaskSpec(T5, creator2, t5JobHash, "queries-t5");
    await send(svm, providerA, [
      await facade.claimTaskWithJobSpec({
        authority: providerA,
        worker: agentA,
        task: T3,
        moderationBlock: await moderationBlockFor(t3JobHash),
        jobSpecHash: t3JobHash,
      }),
    ]);
    [C3] = await findClaimPda({ task: T3, bidder: agentA });
    expect(getTaskDecoder().decode(accountData(svm, T3)!).status).toBe(
      TaskStatus.InProgress,
    );

    // ---- bids: agentA + agentB bid on T4; agentA bids on T5 ----
    const bidMarketplace = await seedBidMarketplace(svm, admin.address);
    for (const [signer, task] of [
      [creator1, T4],
      [creator2, T5],
    ] as const) {
      await send(svm, signer, [
        await facade.initializeBidBook({
          task,
          creator: signer,
          policy: 0, // BestPrice
          priceWeightBps: 0,
          etaWeightBps: 0,
          confidenceWeightBps: 0,
          reliabilityWeightBps: 0,
        }),
      ]);
    }
    const mkBid = async (
      signer: KeyPairSigner,
      bidder: Address,
      task: Address,
    ): Promise<Address> => {
      const expectedJobSpecHash = task === T4 ? t4JobHash : t5JobHash;
      const [taskJobSpec] = await findTaskJobSpecPda({ task });
      const spec = getTaskJobSpecDecoder().decode(accountData(svm, taskJobSpec)!);
      await send(svm, signer, [
        await facade.createBid({
          task,
          bidder,
          authority: signer,
          requestedRewardLamports: REWARD,
          etaSeconds: 900,
          confidenceBps: 5000,
          qualityGuaranteeHash: new Uint8Array(32).fill(4),
          metadataHash: new Uint8Array(32).fill(5),
          expiresAt: now + 1800n,
          expectedJobSpecHash,
          expectedJobSpecUpdatedAt: spec.updatedAt,
        }),
      ]);
      const [bid] = await findBidPda({ task, bidder });
      return bid;
    };
    B4A = await mkBid(providerA, agentA, T4);
    B4B = await mkBid(providerB, agentB, T4);
    B5A = await mkBid(providerA, agentA, T5);

    // ---- hire: creator1 hires L1 (moderated CLEAN) => mints T6 + HireRecord ----
    await send(svm, moderator, [
      await facade.recordListingModeration({
        moderator,
        listing: L1,
        jobSpecHash: l1SpecHash,
        status: 0,
        riskScore: 0,
        categoryMask: 0n,
        policyHash: new Uint8Array(32).fill(9),
        scannerHash: new Uint8Array(32).fill(8),
        expiresAt: 0n,
      }),
    ]);
    const t6Id = new Uint8Array(32).fill(16);
    await send(svm, creator1, [
      await facade.hireFromListing({
        listing: L1,
        providerAgent: agentA,
        creatorAgent: agentC1,
        authority: creator1,
        creator: creator1,
        taskId: t6Id,
        expectedPrice: PRICE,
        expectedVersion: 1n,
        listingSpecHash: l1SpecHash,
        taskJobSpecHash: l1SpecHash,
        moderator: moderator.address,
      }),
    ]);
    [T6] = await findTaskPda({ creator: creator1.address, taskId: t6Id });
    [H1] = await findHireRecordPda({ task: T6 });

    // ---- register every created address in the simulator, plus NOISE accounts
    //      (agents, escrows, configs, bid books, bidder states, job spec) that
    //      the discriminator filters must exclude. ----
    sim.register(L1, L2, L3, T1, T2, T3, T4, T5, T6, C3, B4A, B4B, B5A, H1);
    sim.register(agentA, agentB, agentC1, agentC2);
    sim.register(protocolConfig, moderationConfig, bidMarketplace);
    for (const task of [T1, T2, T3, T4, T5, T6]) {
      const [escrow] = await findEscrowPda({ task });
      sim.register(escrow);
    }
    const [bidBook4] = await findBidBookPda({ task: T4 });
    const [bidBook5] = await findBidBookPda({ task: T5 });
    const [bmsA] = await findBidderMarketStatePda({ bidder: agentA });
    const [bmsB] = await findBidderMarketStatePda({ bidder: agentB });
    const [t3JobSpec] = await findTaskJobSpecPda({ task: T3 });
    sim.register(bidBook4, bidBook5, bmsA, bmsB, t3JobSpec);
  }, 120_000);

  it("listActiveListings returns exactly the Active listings", async () => {
    expect(addrs(await listActiveListings(sim))).toEqual(new Set([L1, L3]));
  });

  it("listActiveListings filters by provider agent (L2 excluded: Paused)", async () => {
    const rows = await listActiveListings(sim, { provider: agentA });
    expect(addrs(rows)).toEqual(new Set([L1]));
    expect(rows[0].account.providerAgent).toBe(agentA);
  });

  it("listActiveListings filters by category, NUL-padding plain strings", async () => {
    expect(addrs(await listActiveListings(sim, { category: "code" }))).toEqual(
      new Set([L1, L3]),
    );
    // raw 32-byte category form matches too
    expect(
      addrs(await listActiveListings(sim, { category: cat32("code") })),
    ).toEqual(new Set([L1, L3]));
  });

  it("listActiveListings with an explicit state returns the paused listing", async () => {
    const rows = await listActiveListings(sim, {
      category: "design",
      state: ListingState.Paused,
    });
    expect(addrs(rows)).toEqual(new Set([L2]));
    expect(rows[0].account.state).toBe(ListingState.Paused);
  });

  it("listingsByProvider returns every state for that provider only", async () => {
    expect(addrs(await listingsByProvider(sim, agentA))).toEqual(
      new Set([L1, L2]),
    );
    expect(addrs(await listingsByProvider(sim, agentB))).toEqual(
      new Set([L3]),
    );
  });

  it("listOpenTasks excludes the claimed (InProgress) task", async () => {
    expect(addrs(await listOpenTasks(sim))).toEqual(
      new Set([T1, T2, T4, T5, T6]),
    );
  });

  it("listOpenTasks filters by creator via memcmp", async () => {
    expect(addrs(await listOpenTasks(sim, { creator: creator1.address }))).toEqual(
      new Set([T1, T2, T4, T6]),
    );
    expect(addrs(await listOpenTasks(sim, { creator: creator2.address }))).toEqual(
      new Set([T5]), // T3 is InProgress
    );
  });

  it("listOpenTasks refines capabilities and minReward client-side", async () => {
    // a capability-bit-0 worker cannot take T2 (requires bit 1)
    expect(addrs(await listOpenTasks(sim, { capabilities: 1n }))).toEqual(
      new Set([T1, T4, T5, T6]),
    );
    expect(addrs(await listOpenTasks(sim, { minReward: 5_000_000n }))).toEqual(
      new Set([T2]),
    );
  });

  it("listClaimsForWorker keys on the worker AGENT PDA", async () => {
    const rows = await listClaimsForWorker(sim, agentA);
    expect(addrs(rows)).toEqual(new Set([C3]));
    expect(rows[0].account.task).toBe(T3);
    expect(rows[0].account.worker).toBe(agentA);
    expect(await listClaimsForWorker(sim, agentB)).toEqual([]);
  });

  it("bidsByTask returns exactly the bids on that task", async () => {
    const t4Bids = await bidsByTask(sim, T4);
    expect(addrs(t4Bids)).toEqual(new Set([B4A, B4B]));
    expect(new Set(t4Bids.map((r) => r.account.bidder))).toEqual(
      new Set([agentA, agentB]),
    );
    expect(addrs(await bidsByTask(sim, T5))).toEqual(new Set([B5A]));
  });

  it("listHireRecordsForBuyer joins HireRecords to the buyer's tasks", async () => {
    const rows = await listHireRecordsForBuyer(sim, creator1.address);
    expect(addrs(rows)).toEqual(new Set([H1]));
    expect(rows[0].account.task).toBe(T6);
    expect(rows[0].account.listing).toBe(L1);
    expect(await listHireRecordsForBuyer(sim, creator2.address)).toEqual([]);
  });

  it("the simulator applies dataSize with exact RPC semantics", async () => {
    const rows = await sim.getProgramAccounts({
      filters: [{ dataSize: getTaskClaimSize() }],
    });
    expect(addrs(rows).has(C3)).toBe(true);
    for (const { data } of rows) expect(data.length).toBe(getTaskClaimSize());
  });
});
