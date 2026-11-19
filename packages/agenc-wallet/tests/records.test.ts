// Reading the record a buyer sees, against a chain made of hand-built
// accounts: the marketplace's list of finished jobs is believed only about
// who did a job, and the job's own record decides whether it counts.
import { describe, expect, it } from "vitest";
import { getAddressDecoder, type Address } from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  findAgentStatsPda,
  getAgentRegistrationEncoder,
  getAgentStatsEncoder,
  getHireRatingEncoder,
  getServiceListingEncoder,
  getTaskEncoder,
  TaskStatus,
  type GpaFilter,
} from "@tetsuo-ai/marketplace-sdk";
import type { Chain, RawAccount } from "../src/chain.js";
import {
  createRecordKeeper,
  readMarketRecord,
  SETTLEMENT_LOOKUPS_PER_READ,
  TASK_DESCRIPTION_OFFSET,
  TASK_STATUS_OFFSET,
  type RecordRow,
  type RecordSource,
} from "../src/records.js";
import { NO_FIRST_PARTY, type FirstParty } from "../src/trust.js";

const PROGRAM = AGENC_COORDINATION_PROGRAM_ADDRESS;
const at = (seed: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(seed));
const SYSTEM = "11111111111111111111111111111111" as Address;

const PROVIDER = at(1);
const OTHER_PROVIDER = at(2);
const OWNER = at(3);
const OTHER_OWNER = at(4);
const LISTING = at(5);
const RETIRED_LISTING = at(6);
const OTHER_LISTING = at(7);
const BUYER = at(8);
const SPEC = "ab".repeat(32);
const OTHER_SPEC = "cd".repeat(32);
const MINT = at(9);
const PRICE = 10_000_000n;

function bytes(hexText: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hexText, "hex"));
}

function taskData(input: {
  creator?: Address;
  status?: TaskStatus;
  reward?: bigint;
  bps?: number;
  mint?: Address | null;
  spec?: string;
}): Uint8Array {
  const description = new Uint8Array(64);
  description.set(bytes(input.spec ?? SPEC), 0);
  return Uint8Array.from(
    getTaskEncoder().encode({
      taskId: new Uint8Array(32),
      creator: input.creator ?? BUYER,
      requiredCapabilities: 1n,
      description,
      constraintHash: new Uint8Array(32),
      rewardAmount: input.reward ?? PRICE,
      maxWorkers: 1,
      currentWorkers: 0,
      status: input.status ?? TaskStatus.Completed,
      taskType: 0,
      createdAt: 0n,
      deadline: 0n,
      completedAt: 1n,
      escrow: SYSTEM,
      result: new Uint8Array(64),
      completions: 1,
      requiredCompletions: 1,
      bump: 0,
      protocolFeeBps: input.bps ?? 500,
      dependsOn: null,
      dependencyType: 0,
      minReputation: 0,
      rewardMint: input.mint ?? null,
      operator: SYSTEM,
      operatorFeeBps: 0,
      reserved: new Uint8Array(16),
      referrer: SYSTEM,
      referrerFeeBps: 0,
    }),
  );
}

function agentData(owner: Address, options: { finished?: number; since?: number; stake?: bigint } = {}): Uint8Array {
  return Uint8Array.from(
    getAgentRegistrationEncoder().encode({
      agentId: new Uint8Array(32).fill(1),
      authority: owner,
      capabilities: 1n,
      status: 1,
      endpoint: "",
      metadataUri: "",
      registeredAt: BigInt(options.since ?? 1_780_000_000),
      lastActive: 0n,
      tasksCompleted: BigInt(options.finished ?? 3),
      totalEarned: 0n,
      reputation: 3000,
      activeTasks: 0,
      stake: options.stake ?? 10_000_000n,
      bump: 0,
      lastTaskCreated: 0n,
      lastDisputeInitiated: 0n,
      taskCount24h: 0,
      disputeCount24h: 0,
      rateLimitWindowStart: 0n,
      activeDisputeVotes: 0,
      lastVoteTimestamp: 0n,
      lastStateUpdate: 0n,
      disputesAsDefendant: 0,
      reserved: new Uint8Array(4),
    }),
  );
}

function statsData(agent: Address, turnedDown: number, disputesLost: number): Uint8Array {
  return Uint8Array.from(
    getAgentStatsEncoder().encode({
      agent,
      tasksRejected: BigInt(turnedDown),
      disputesWon: 0n,
      disputesLost: BigInt(disputesLost),
      claimsExpired: 0n,
      totalCancelled: 0n,
      lastUpdated: 0n,
      bump: 0,
      reserved: new Uint8Array(32),
    }),
  );
}

function ratingData(task: Address, listing: Address, score: number, buyer: Address = BUYER): Uint8Array {
  return Uint8Array.from(
    getHireRatingEncoder().encode({
      task,
      listing,
      buyer,
      score,
      reviewHash: null,
      reviewUri: "",
      ratedAt: 0n,
      bump: 0,
      reserved: new Uint8Array(32),
    }),
  );
}

function listingData(provider: Address, owner: Address): Uint8Array {
  return Uint8Array.from(
    getServiceListingEncoder().encode({
      providerAgent: provider,
      authority: owner,
      listingId: new Uint8Array(32),
      name: new Uint8Array(32),
      category: new Uint8Array(32),
      tags: new Uint8Array(64),
      specHash: bytes(OTHER_SPEC),
      specUri: "",
      price: PRICE,
      priceMint: null,
      requiredCapabilities: 1n,
      defaultDeadlineSecs: 0n,
      operator: SYSTEM,
      operatorFeeBps: 0,
      state: 2,
      maxOpenJobs: 0,
      openJobs: 0,
      totalHires: 0n,
      totalRating: 0n,
      ratingCount: 0,
      version: 0n,
      createdAt: 0n,
      updatedAt: 0n,
      bump: 0,
      reserved: new Uint8Array(32),
    }),
  );
}

/**
 * A chain of hand-built accounts, the marketplace's list of who did which
 * job, and (when `settled` is given) the chain's history of who each
 * finished job paid.
 */
async function world(setup: {
  accounts: Array<[Address, Uint8Array, Address?]>;
  ratings?: Uint8Array[];
  finished?: Record<string, string[] | Error>;
  settled?: Record<string, Address | null | Error>;
}) {
  const accounts = new Map<string, RawAccount>(
    setup.accounts.map(([address, data, owner]) => [address, { data, owner: owner ?? PROGRAM, lamports: 1n }]),
  );
  const asked: string[] = [];
  const looked: string[] = [];
  const matches = (filter: GpaFilter, data: Uint8Array): boolean =>
    "dataSize" in filter
      ? data.length === filter.dataSize
      : filter.memcmp.bytes.every((byte, index) => data[filter.memcmp.offset + index] === byte);
  const settled = setup.settled;
  const chain = {
    network: "mainnet",
    readRawAccounts: async (list: readonly Address[]) => list.map((address) => accounts.get(address) ?? null),
    gpa: {
      getProgramAccounts: async ({ filters }: { filters: readonly GpaFilter[] }) =>
        [
          ...(setup.ratings ?? []).map((data, index) => ({ address: at(200 + index), data })),
          ...[...accounts]
            .filter(([, account]) => account.owner === PROGRAM)
            .map(([address, account]) => ({ address: address as Address, data: account.data })),
        ].filter(({ data }) => filters.every((filter) => matches(filter, data))),
    },
    ...(settled === undefined
      ? {}
      : {
          findSettlementWorker: async (task: Address) => {
            looked.push(task);
            const worker = settled[task];
            if (worker instanceof Error) throw worker;
            return worker ?? null;
          },
        }),
  } as unknown as Chain;
  const services = {
    finishedJobs: async (provider: Address) => {
      asked.push(provider);
      const list = setup.finished?.[provider] ?? [];
      if (list instanceof Error) throw list;
      return list;
    },
  };
  const source = (firstParty: FirstParty = NO_FIRST_PARTY): RecordSource => ({ chain, services, firstParty });
  return {
    asked,
    looked,
    source,
    read: (rows: RecordRow[], firstParty: FirstParty = NO_FIRST_PARTY, settledBy?: Map<string, string | null>) =>
      readMarketRecord({ ...source(firstParty), ...(settledBy === undefined ? {} : { settledBy }) }, rows),
  };
}

const ROW: RecordRow = { listing: LISTING, providerAgent: PROVIDER, specHashHex: SPEC };
const OTHER_ROW: RecordRow = { listing: OTHER_LISTING, providerAgent: OTHER_PROVIDER, specHashHex: OTHER_SPEC };

async function statsAddress(agent: Address): Promise<Address> {
  return (await findAgentStatsPda({ creatorAgent: agent }))[0];
}

describe("reading a service's record", () => {
  it("counts a job only when its own record says it was finished and paid in SOL", async () => {
    const [done, running, inToken, missing, foreign] = [at(20), at(21), at(22), at(23), at(24)];
    const { read } = await world({
      accounts: [
        [PROVIDER, agentData(OWNER)],
        [done, taskData({})],
        [running, taskData({ status: TaskStatus.InProgress })],
        [inToken, taskData({ mint: MINT })],
        // Not the marketplace's account, whatever its bytes say.
        [foreign, taskData({}), SYSTEM],
      ],
      finished: { [PROVIDER]: [done, running, inToken, missing, foreign] },
    });
    const record = await read([ROW]);
    expect(record.listings.get(LISTING)).toMatchObject({ jobs: 1, paidLamports: PRICE, feeLamports: PRICE / 20n, buyers: 1 });
    expect(record.providers.get(PROVIDER)).toMatchObject({ jobs: 1 });
  });

  it("takes who paid and how much from the chain, never from the list", async () => {
    const [first, second] = [at(25), at(26)];
    const { read } = await world({
      accounts: [
        [PROVIDER, agentData(OWNER)],
        [first, taskData({ creator: at(30), reward: 4n * PRICE })],
        [second, taskData({ creator: at(31), bps: 250 })],
      ],
      finished: { [PROVIDER]: [first, second] },
    });
    const record = (await read([ROW])).listings.get(LISTING)!;
    expect(record.buyers).toBe(2);
    expect(record.paidLamports).toBe(5n * PRICE);
    // Each job's fee at its own rate: 5% of the first, 2.5% of the second.
    expect(record.feeLamports).toBe((4n * PRICE) / 20n + PRICE / 40n);
  });

  it("ties a job to the one service whose description it names", async () => {
    const [named, unknown] = [at(27), at(28)];
    const { read } = await world({
      accounts: [
        [PROVIDER, agentData(OWNER)],
        [named, taskData({ spec: SPEC })],
        [unknown, taskData({ spec: "ef".repeat(32) })],
      ],
      finished: { [PROVIDER]: [named, unknown] },
    });
    const record = await read([ROW]);
    // Both are the agent's; only one can be told to be this service's.
    expect(record.listings.get(LISTING)).toMatchObject({ jobs: 1 });
    expect(record.providers.get(PROVIDER)).toMatchObject({ jobs: 2 });
  });

  it("believes a rating about whose job it was, and nobody about a job two agents claim", async () => {
    const [rated, contested] = [at(32), at(33)];
    const { read } = await world({
      accounts: [
        [PROVIDER, agentData(OWNER)],
        [OTHER_PROVIDER, agentData(OTHER_OWNER)],
        [rated, taskData({})],
        [contested, taskData({ spec: OTHER_SPEC })],
      ],
      ratings: [ratingData(rated, LISTING, 4)],
      // The list says the other agent did both.
      finished: { [PROVIDER]: [contested], [OTHER_PROVIDER]: [rated, contested] },
    });
    const record = await read([ROW, OTHER_ROW]);
    expect(record.listings.get(LISTING)).toMatchObject({ jobs: 1, ratings: 1, rating: 4 });
    expect(record.providers.has(OTHER_PROVIDER)).toBe(false);
    expect(record.listings.has(OTHER_LISTING)).toBe(false);
  });

  it("counts a rating on an agent's service that is no longer on offer for that agent", async () => {
    const task = at(34);
    const { read } = await world({
      accounts: [
        [PROVIDER, agentData(OWNER, { finished: 0 })],
        [RETIRED_LISTING, listingData(PROVIDER, OWNER)],
        [task, taskData({})],
      ],
      ratings: [ratingData(task, RETIRED_LISTING, 5)],
    });
    const record = await read([ROW]);
    expect(record.providers.get(PROVIDER)).toMatchObject({ jobs: 1, ratings: 1, rating: 5 });
    expect(record.listings.has(LISTING)).toBe(false);
  });

  it("does not take a rating from anyone but the job's buyer", async () => {
    const task = at(35);
    const { read } = await world({
      accounts: [
        [PROVIDER, agentData(OWNER)],
        [task, taskData({ creator: BUYER })],
      ],
      ratings: [ratingData(task, LISTING, 1, at(36))],
    });
    const record = (await read([ROW])).listings.get(LISTING)!;
    expect(record).toMatchObject({ jobs: 1, ratings: 0, rating: null });
  });

  it("names the agents whose finished jobs could not be read", async () => {
    const { read } = await world({
      accounts: [
        [PROVIDER, agentData(OWNER)],
        [OTHER_PROVIDER, agentData(OTHER_OWNER)],
        [at(37), taskData({ spec: OTHER_SPEC })],
      ],
      finished: { [PROVIDER]: new Error("busy"), [OTHER_PROVIDER]: [at(37)] },
    });
    const record = await read([ROW, OTHER_ROW]);
    expect([...record.unread]).toEqual([PROVIDER]);
    expect(record.listings.get(OTHER_LISTING)).toMatchObject({ jobs: 1 });
  });

  it("leaves out an agent the marketplace owns, and does not even ask about it", async () => {
    const task = at(38);
    const { read, asked } = await world({
      accounts: [
        [PROVIDER, agentData(OWNER)],
        [task, taskData({})],
      ],
      ratings: [ratingData(task, LISTING, 5)],
      finished: { [PROVIDER]: [task] },
    });
    const record = await read([ROW], { wallets: new Set([OWNER]), agents: new Set(), listings: new Set() });
    expect(record.listings.size).toBe(0);
    expect(record.providers.size).toBe(0);
    expect(asked).toEqual([]);
  });

  it("says when the agent joined, what it keeps on deposit, and what its stats record holds", async () => {
    const { read } = await world({
      accounts: [
        [PROVIDER, agentData(OWNER, { since: 1_790_000_000, stake: 25_000_000n })],
        [await statsAddress(PROVIDER), statsData(PROVIDER, 2, 1)],
        [OTHER_PROVIDER, agentData(OTHER_OWNER)],
        // A stats record that names another agent is not this one's.
        [await statsAddress(OTHER_PROVIDER), statsData(PROVIDER, 9, 9)],
      ],
    });
    const record = await read([ROW, OTHER_ROW]);
    expect(record.facts.get(PROVIDER)).toMatchObject({
      wallet: OWNER,
      since: 1_790_000_000_000,
      depositLamports: 25_000_000n,
      turnedDown: 2,
      disputesLost: 1,
      active: true,
    });
    expect(record.facts.get(OTHER_PROVIDER)).toMatchObject({ turnedDown: null, disputesLost: null });
  });

  it("reads a provider without a stats record as not counted, never as clean", async () => {
    const { read } = await world({
      accounts: [
        [PROVIDER, agentData(OWNER)],
        // A record that is kept and empty is clean.
        [OTHER_PROVIDER, agentData(OTHER_OWNER)],
        [await statsAddress(OTHER_PROVIDER), statsData(OTHER_PROVIDER, 0, 0)],
      ],
    });
    const record = await read([ROW, OTHER_ROW]);
    expect(record.facts.get(PROVIDER)).toMatchObject({ turnedDown: null, disputesLost: null });
    expect(record.facts.get(OTHER_PROVIDER)).toMatchObject({ turnedDown: 0, disputesLost: 0 });
  });
});

describe("jobs the marketplace's list forgot", () => {
  // The list reads only what is still open on the chain, and tidying a paid
  // job closes its link to the service: such a job is found by the
  // description it names, and the transaction that paid for it says whose.
  it("finds a tidied job by the description it names and the agent it paid", async () => {
    const task = at(40);
    const { read, looked } = await world({
      accounts: [
        [PROVIDER, agentData(OWNER, { finished: 1 })],
        [task, taskData({})],
      ],
      settled: { [task]: PROVIDER },
    });
    const record = await read([ROW]);
    expect(record.listings.get(LISTING)).toMatchObject({ jobs: 1, ratings: 0, paidLamports: PRICE, buyers: 1 });
    expect(record.providers.get(PROVIDER)).toMatchObject({ jobs: 1 });
    expect(record.pending).toBe(0);
    expect(looked).toEqual([task]);
  });

  it("counts it only for the agent the transaction paid, whoever else offers that description", async () => {
    const [paidToProvider, paidToStranger] = [at(41), at(42)];
    const { read } = await world({
      accounts: [
        [PROVIDER, agentData(OWNER, { finished: 1 })],
        [OTHER_PROVIDER, agentData(OTHER_OWNER, { finished: 1 })],
        [paidToProvider, taskData({})],
        [paidToStranger, taskData({})],
      ],
      settled: { [paidToProvider]: PROVIDER, [paidToStranger]: at(43) },
    });
    // Another agent's service carries the same description.
    const copy: RecordRow = { listing: OTHER_LISTING, providerAgent: OTHER_PROVIDER, specHashHex: SPEC };
    const record = await read([ROW, copy]);
    expect(record.listings.get(LISTING)).toMatchObject({ jobs: 1 });
    expect(record.listings.has(OTHER_LISTING)).toBe(false);
    expect(record.providers.has(OTHER_PROVIDER)).toBe(false);
  });

  it("does not look when the list and the ratings account for every job the agent finished", async () => {
    const [listed, rated] = [at(44), at(45)];
    const { read, looked } = await world({
      accounts: [
        [PROVIDER, agentData(OWNER, { finished: 2 })],
        [listed, taskData({})],
        [rated, taskData({})],
      ],
      ratings: [ratingData(rated, LISTING, 5)],
      finished: { [PROVIDER]: [listed] },
      settled: { [listed]: PROVIDER, [rated]: PROVIDER },
    });
    expect((await read([ROW])).listings.get(LISTING)).toMatchObject({ jobs: 2, ratings: 1 });
    expect(looked).toEqual([]);
  });

  it("looks only at finished jobs, and not at the marketplace's own agents", async () => {
    const [running, done] = [at(46), at(47)];
    const { read, looked } = await world({
      accounts: [
        [PROVIDER, agentData(OWNER, { finished: 2 })],
        [running, taskData({ status: TaskStatus.InProgress })],
        [done, taskData({})],
      ],
      settled: { [running]: PROVIDER, [done]: PROVIDER },
    });
    expect((await read([ROW])).listings.get(LISTING)).toMatchObject({ jobs: 1 });
    expect(looked).toEqual([done]);
    looked.length = 0;
    const own = await read([ROW], { wallets: new Set(), agents: new Set([PROVIDER]), listings: new Set() });
    expect(own.listings.size).toBe(0);
    expect(looked).toEqual([]);
  });

  it("names the agent whose jobs' history could not be read", async () => {
    const task = at(48);
    const { read } = await world({
      accounts: [
        [PROVIDER, agentData(OWNER, { finished: 1 })],
        [task, taskData({})],
      ],
      settled: { [task]: new Error("busy") },
    });
    const record = await read([ROW]);
    expect([...record.unread]).toEqual([PROVIDER]);
  });

  it("looks up only so many jobs per read, goes on with the next read, and never twice", async () => {
    const count = SETTLEMENT_LOOKUPS_PER_READ + 2;
    const tasks = Array.from({ length: count }, (_, index) => at(60 + index));
    const { read, looked } = await world({
      accounts: [
        [PROVIDER, agentData(OWNER, { finished: count })],
        ...tasks.map((task): [Address, Uint8Array] => [task, taskData({})]),
      ],
      settled: Object.fromEntries(tasks.map((task) => [task, PROVIDER])),
    });
    const settledBy = new Map<string, string | null>();
    const first = await read([ROW], NO_FIRST_PARTY, settledBy);
    expect(first.listings.get(LISTING)).toMatchObject({ jobs: SETTLEMENT_LOOKUPS_PER_READ });
    expect(first.pending).toBe(2);
    const second = await read([ROW], NO_FIRST_PARTY, settledBy);
    expect(second.listings.get(LISTING)).toMatchObject({ jobs: count });
    expect(second.pending).toBe(0);
    expect(looked).toHaveLength(count);
    expect(new Set(looked).size).toBe(count);
  });

  it("is read again soon while jobs are left to look up", async () => {
    const count = SETTLEMENT_LOOKUPS_PER_READ + 1;
    const tasks = Array.from({ length: count }, (_, index) => at(100 + index));
    const { source } = await world({
      accounts: [
        [PROVIDER, agentData(OWNER, { finished: count })],
        ...tasks.map((task): [Address, Uint8Array] => [task, taskData({})]),
      ],
      settled: Object.fromEntries(tasks.map((task) => [task, PROVIDER])),
    });
    const keeper = createRecordKeeper(source(), () => 0);
    const first = await keeper.read([ROW], 5_000);
    expect(first.record?.listings.get(LISTING)).toMatchObject({ jobs: SETTLEMENT_LOOKUPS_PER_READ });
    // No time has passed, and the record is read again all the same.
    const second = await keeper.read([ROW], 5_000);
    expect(second.record?.listings.get(LISTING)).toMatchObject({ jobs: count });
  });

  it("finds the description and the status where a job's record keeps them", () => {
    const done = taskData({ spec: SPEC });
    expect(Buffer.from(done.slice(TASK_DESCRIPTION_OFFSET, TASK_DESCRIPTION_OFFSET + 32)).toString("hex")).toBe(SPEC);
    expect(done[TASK_STATUS_OFFSET]).toBe(TaskStatus.Completed);
    expect(taskData({ status: TaskStatus.InProgress })[TASK_STATUS_OFFSET]).toBe(TaskStatus.InProgress);
  });
});
