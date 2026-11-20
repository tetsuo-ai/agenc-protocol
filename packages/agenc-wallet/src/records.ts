// The record a buyer sees before hiring: who offers a service, and what
// buyers really paid it for. Everything that counts is read from the chain.
//
//  - The agent behind a service: when it joined, what it keeps on deposit to
//    take jobs, how often its work was turned down and how many disputes it
//    lost (its registration and its optional stats record).
//  - Ratings: every rating record, which names its job, its service and its
//    buyer. They are kept for good.
//  - Finished jobs: the marketplace's own record says which jobs an agent
//    did (MarketServices.finishedJobs). That is the one thing taken on its
//    word: each job's own record on the chain must then say it was finished
//    and paid, by whom and for how much, or the job does not count. A job's
//    record also names the description of the service it was hired from,
//    which ties it to one of that agent's services.
//  - Tidied jobs: that list reads only what is still open on the chain, and
//    tidying a paid job closes its link to the service, so the list soon
//    forgets it. When an agent's registration says it finished more jobs
//    than the list and the ratings account for, the finished jobs that name
//    its services' descriptions are found on the chain, and the transaction
//    that paid for each one says which agent did it (settlement.ts).
//
// The jobs are then weighed by money (trust.ts), and the marketplace's own
// accounts are left out (first-party.ts).
import type { Address } from "@solana/kit";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  findAgentStatsPda,
  getAgentRegistrationDecoder,
  getAgentRegistrationDiscriminatorBytes,
  getAgentStatsDecoder,
  getAgentStatsDiscriminatorBytes,
  getHireRatingDecoder,
  getHireRatingDiscriminatorBytes,
  getServiceListingDecoder,
  getServiceListingDiscriminatorBytes,
  getTaskDecoder,
  getTaskDiscriminatorBytes,
  resolveProgramAccountsTransport,
  TaskStatus,
} from "@tetsuo-ai/marketplace-sdk";
import type { Chain, RawAccount } from "./chain.js";
import type { MarketServices } from "./services.js";
import { isFirstPartyJob, tally, type FirstParty, type PaidJob, type TrustRecord } from "./trust.js";

/** What is known of the agent behind a service. */
export interface ProviderFacts {
  agent: string;
  /** The wallet that owns the agent, or null when its registration could not be read. */
  wallet: string | null;
  /** When the agent joined the marketplace, unix milliseconds. */
  since: number | null;
  /** What it keeps on deposit with the marketplace to take jobs. */
  depositLamports: bigint | null;
  /**
   * Deliveries of its that buyers turned down, as its stats record counts
   * them. Null when it has no stats record: nobody has to keep one, and
   * starting it costs whoever does, so a missing record says nothing.
   */
  turnedDown: number | null;
  /** Disputes about its work that it lost, from the same record. Null without one. */
  disputesLost: number | null;
  /** True while it may take jobs (not suspended or retired). */
  active: boolean;
  /** Jobs it finished, by its registration's own count (any size, any buyer). */
  finished: number;
}

export interface MarketRecord {
  /** By service: the jobs that counted. A service nobody paid for is absent. */
  listings: ReadonlyMap<string, TrustRecord>;
  /** By provider agent: every job of theirs that counted, from any of their services. */
  providers: ReadonlyMap<string, TrustRecord>;
  /** By provider agent. */
  facts: ReadonlyMap<string, ProviderFacts>;
  /** Provider agents whose finished jobs could not be read this time. */
  unread: ReadonlySet<string>;
  /**
   * Finished jobs found on the chain whose agent is still to be looked up:
   * a read looks up only so many, and the next read goes on.
   */
  pending: number;
}

/** What the record needs to know of a service on offer. */
export interface RecordRow {
  listing: string;
  providerAgent: string;
  /** The hash of the description the service committed to, as lowercase hex. */
  specHashHex: string | null;
}

const hex = (bytes: ArrayLike<number>): string => Buffer.from(Uint8Array.from(bytes)).toString("hex");

function startsWith(data: Uint8Array, prefix: ArrayLike<number>): boolean {
  if (data.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (data[index] !== prefix[index]) return false;
  }
  return true;
}

/** Decode a program account, or null when it is not one of the kind expected. */
function decoded<T>(
  account: RawAccount | null,
  discriminator: ArrayLike<number>,
  decode: (data: Uint8Array) => T,
): T | null {
  if (account === null || account.owner !== AGENC_COORDINATION_PROGRAM_ADDRESS) return null;
  if (!startsWith(account.data, discriminator)) return null;
  try {
    return decode(account.data);
  } catch {
    return null;
  }
}

/** What a finished job's own record says, when it says the job was finished and paid in SOL. */
interface FinishedTask {
  buyer: string;
  priceLamports: bigint;
  feeLamports: bigint;
  /** The description hash of the service it was hired from (the first half of its description). */
  listingSpecHex: string;
}

function finishedTask(account: RawAccount | null): FinishedTask | null {
  const task = decoded(account, getTaskDiscriminatorBytes(), (data) => getTaskDecoder().decode(data));
  if (task === null) return null;
  if (Number(task.status) !== TaskStatus.Completed) return null;
  // A token-priced job's fee is not in SOL and is not weighed here.
  if (task.rewardMint.__option === "Some") return null;
  const bps = BigInt(task.protocolFeeBps);
  if (bps <= 0n || bps > 10_000n || task.rewardAmount <= 0n) return null;
  return {
    buyer: task.creator,
    priceLamports: task.rewardAmount,
    feeLamports: (task.rewardAmount * bps) / 10_000n,
    listingSpecHex: hex(task.description.slice(0, 32)),
  };
}

export interface RecordSource {
  chain: Chain;
  services: Pick<MarketServices, "finishedJobs">;
  firstParty: FirstParty;
  /**
   * The agent each finished job paid, as looked up so far, or null when its
   * history holds no settlement of it. A finished job's agent never changes,
   * so this is kept from one read to the next.
   */
  settledBy?: Map<string, string | null>;
}

// Where a job's record keeps what the scan for tidied jobs filters on: its
// description comes after its kind (8 bytes), id (32), buyer (32) and the
// skills it needs (8); its status after the description (64), the hash of
// its terms (32), its price (8) and two counts of workers (1 each); when it
// was posted right after its status and kind (1 each).
export const TASK_DESCRIPTION_OFFSET = 80;
export const TASK_STATUS_OFFSET = 186;
const TASK_CREATED_AT_OFFSET = 188;

/** How many tidied jobs one read looks up the agent of. */
export const SETTLEMENT_LOOKUPS_PER_READ = 24;

/** What the chain says about finished jobs the marketplace's list does not name. */
interface SettledJobs {
  /** By job: the agent the transaction that paid for it paid. */
  workers: Map<string, string>;
  /** Agents whose jobs could not be looked up this time. */
  unread: Set<string>;
  /** Jobs left to look up on a later read. */
  pending: number;
}

function postedAt(data: Uint8Array): bigint {
  if (data.length < TASK_CREATED_AT_OFFSET + 8) return 0n;
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).readBigInt64LE(TASK_CREATED_AT_OFFSET);
}

/**
 * Find the finished jobs that name one of `searched`'s descriptions (by
 * description: the agents whose services have it) and are not in `skip`,
 * and look up which agent each one paid, newest first.
 */
async function readSettledJobs(
  source: RecordSource,
  searched: ReadonlyMap<string, readonly string[]>,
  skip: ReadonlySet<string>,
): Promise<SettledJobs> {
  const out: SettledJobs = { workers: new Map(), unread: new Set(), pending: 0 };
  const find = source.chain.findSettlementWorker;
  if (find === undefined || searched.size === 0) return out;

  const scan = resolveProgramAccountsTransport(source.chain.gpa);
  const candidates = new Map<string, { agents: Set<string>; at: bigint }>();
  for (const [spec, agents] of searched) {
    let found: Array<{ address: Address; data: Uint8Array }>;
    try {
      found = await scan.getProgramAccounts({
        filters: [
          { memcmp: { offset: 0, bytes: Uint8Array.from(getTaskDiscriminatorBytes()) } },
          { memcmp: { offset: TASK_STATUS_OFFSET, bytes: Uint8Array.of(TaskStatus.Completed) } },
          { memcmp: { offset: TASK_DESCRIPTION_OFFSET, bytes: Uint8Array.from(Buffer.from(spec, "hex")) } },
        ],
      });
    } catch {
      for (const agent of agents) out.unread.add(agent);
      continue;
    }
    for (const { address, data } of found) {
      if (skip.has(address)) continue;
      const entry = candidates.get(address) ?? { agents: new Set<string>(), at: postedAt(data) };
      for (const agent of agents) entry.agents.add(agent);
      candidates.set(address, entry);
    }
  }

  const cache = source.settledBy ?? new Map<string, string | null>();
  const newestFirst = [...candidates].sort(([, a], [, b]) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0));
  let lookups = 0;
  let failed = false;
  for (const [task, { agents }] of newestFirst) {
    let worker = cache.get(task);
    if (worker === undefined) {
      if (failed) {
        // The history cannot be read right now: these agents' records are not known.
        for (const agent of agents) out.unread.add(agent);
        continue;
      }
      if (lookups >= SETTLEMENT_LOOKUPS_PER_READ) {
        out.pending += 1;
        continue;
      }
      lookups += 1;
      try {
        worker = await find(task as Address);
      } catch {
        failed = true;
        for (const agent of agents) out.unread.add(agent);
        continue;
      }
      cache.set(task, worker);
    }
    // Only the agent the job paid, and only when one of its services has the
    // description the job names.
    if (worker !== null && agents.has(worker)) out.workers.set(task, worker);
  }
  return out;
}

/**
 * Read the record of every service in `rows` and of the agents behind them.
 * Throws only when the chain cannot be read at all; an agent whose finished
 * jobs cannot be listed right now is named in `unread`.
 */
export async function readMarketRecord(source: RecordSource, rows: readonly RecordRow[]): Promise<MarketRecord> {
  const { chain, services, firstParty } = source;
  const agents = [...new Set(rows.map((row) => row.providerAgent))];
  const listingProvider = new Map(rows.map((row) => [row.listing, row.providerAgent]));

  // The agents themselves.
  const statsAddresses = await Promise.all(
    agents.map(async (agent) => (await findAgentStatsPda({ creatorAgent: agent as Address }))[0]),
  );
  const [registrations, statsAccounts] = await Promise.all([
    chain.readRawAccounts(agents as Address[]),
    chain.readRawAccounts(statsAddresses),
  ]);
  const facts = new Map<string, ProviderFacts>();
  agents.forEach((agent, index) => {
    const registration = decoded(registrations[index] ?? null, getAgentRegistrationDiscriminatorBytes(), (data) =>
      getAgentRegistrationDecoder().decode(data),
    );
    const stats = decoded(statsAccounts[index] ?? null, getAgentStatsDiscriminatorBytes(), (data) =>
      getAgentStatsDecoder().decode(data),
    );
    facts.set(agent, {
      agent,
      wallet: registration?.authority ?? null,
      since: registration !== null && registration.registeredAt > 0n ? Number(registration.registeredAt) * 1000 : null,
      depositLamports: registration?.stake ?? null,
      // No stats record is not a clean one: nothing was kept.
      turnedDown: stats === null || stats.agent !== agent ? null : Number(stats.tasksRejected),
      disputesLost: stats === null || stats.agent !== agent ? null : Number(stats.disputesLost),
      // 1 is Active and 2 is Busy: both take jobs.
      active: registration !== null && (Number(registration.status) === 1 || Number(registration.status) === 2),
      finished: registration === null ? 0 : Number(registration.tasksCompleted),
    });
  });

  // Every rating, with the service it is for.
  const ratingAccounts = await resolveProgramAccountsTransport(chain.gpa).getProgramAccounts({
    filters: [{ memcmp: { offset: 0, bytes: Uint8Array.from(getHireRatingDiscriminatorBytes()) } }],
  });
  const ratings = new Map<string, { listing: string; buyer: string; score: number }>();
  for (const { data } of ratingAccounts) {
    const rating = decoded(
      { data, owner: AGENC_COORDINATION_PROGRAM_ADDRESS, lamports: 0n },
      getHireRatingDiscriminatorBytes(),
      (bytes) => getHireRatingDecoder().decode(bytes),
    );
    if (rating === null) continue;
    ratings.set(rating.task, { listing: rating.listing, buyer: rating.buyer, score: rating.score });
  }
  // A rating may be for one of an agent's services that is not on offer now:
  // its own record says whose it is.
  const unknownListings = [...new Set([...ratings.values()].map((entry) => entry.listing))].filter(
    (listing) => !listingProvider.has(listing),
  );
  if (unknownListings.length > 0) {
    const listingAccounts = await chain.readRawAccounts(unknownListings as Address[]);
    unknownListings.forEach((listing, index) => {
      const account = decoded(listingAccounts[index] ?? null, getServiceListingDiscriminatorBytes(), (data) =>
        getServiceListingDecoder().decode(data),
      );
      if (account !== null && facts.has(account.providerAgent)) listingProvider.set(listing, account.providerAgent);
    });
  }

  // The jobs each agent finished, as the marketplace lists them. An agent
  // that never finished one, or that is the marketplace's own, is not asked.
  const unread = new Set<string>();
  const lists = await Promise.all(
    agents.map(async (agent): Promise<readonly string[]> => {
      const known = facts.get(agent)!;
      if (known.finished === 0 || firstParty.agents.has(agent)) return [];
      if (known.wallet !== null && firstParty.wallets.has(known.wallet)) return [];
      if (services.finishedJobs === undefined) return [];
      try {
        return await services.finishedJobs(agent as Address);
      } catch {
        unread.add(agent);
        return [];
      }
    }),
  );
  // A job two agents are both said to have done cannot be told apart: it
  // counts for neither, unless a rating on the chain says whose it is.
  const claimed = new Map<string, string>();
  const contested = new Set<string>();
  agents.forEach((agent, index) => {
    for (const task of new Set(lists[index])) {
      const other = claimed.get(task);
      if (other !== undefined && other !== agent) contested.add(task);
      else claimed.set(task, agent);
    }
  });
  for (const task of contested) claimed.delete(task);
  const rated = [...ratings.entries()].filter(([, entry]) => listingProvider.has(entry.listing));

  // The jobs the list and the ratings account for, by agent. An agent whose
  // registration says it finished more has jobs the list forgot (tidied
  // ones): those are looked for on the chain, by its services' descriptions.
  const accounted = new Map<string, Set<string>>();
  const note = (agent: string, task: string): void => {
    accounted.set(agent, (accounted.get(agent) ?? new Set()).add(task));
  };
  agents.forEach((agent, index) => {
    for (const task of lists[index] ?? []) note(agent, task);
  });
  for (const [task, entry] of rated) note(listingProvider.get(entry.listing)!, task);
  const searched = new Map<string, string[]>();
  for (const row of rows) {
    const known = facts.get(row.providerAgent)!;
    if (row.specHashHex === null || unread.has(row.providerAgent)) continue;
    if (firstParty.agents.has(row.providerAgent)) continue;
    if (known.wallet !== null && firstParty.wallets.has(known.wallet)) continue;
    if (known.finished <= (accounted.get(row.providerAgent)?.size ?? 0)) continue;
    const list = searched.get(row.specHashHex) ?? [];
    if (!list.includes(row.providerAgent)) list.push(row.providerAgent);
    searched.set(row.specHashHex, list);
  }
  const settled = await readSettledJobs(
    source,
    searched,
    new Set([...claimed.keys(), ...contested, ...rated.map(([task]) => task)]),
  );
  for (const [task, worker] of settled.workers) claimed.set(task, worker);
  for (const agent of settled.unread) unread.add(agent);

  // Each job's own record decides whether it counts.
  const tasks = [...new Set([...claimed.keys(), ...rated.map(([task]) => task)])];
  const taskAccounts = tasks.length === 0 ? [] : await chain.readRawAccounts(tasks as Address[]);
  const specListings = new Map<string, string[]>();
  for (const row of rows) {
    if (row.specHashHex === null) continue;
    const key = `${row.providerAgent} ${row.specHashHex}`;
    specListings.set(key, [...(specListings.get(key) ?? []), row.listing]);
  }
  const jobs: PaidJob[] = [];
  tasks.forEach((task, index) => {
    const record = finishedTask(taskAccounts[index] ?? null);
    if (record === null) return;
    const rating = ratings.get(task);
    // A rating ties its job to a service, and so to its agent, for good;
    // otherwise the job's description does, when it names exactly one of
    // the agent's services.
    let provider = claimed.get(task) ?? null;
    let listing: string | null = null;
    if (rating !== undefined && listingProvider.has(rating.listing)) {
      provider = listingProvider.get(rating.listing)!;
      listing = rating.listing;
    } else if (provider !== null) {
      const matches = specListings.get(`${provider} ${record.listingSpecHex}`) ?? [];
      listing = matches.length === 1 ? matches[0]! : null;
    }
    if (provider === null) return;
    const job: PaidJob = {
      task,
      listing,
      provider,
      buyer: record.buyer,
      priceLamports: record.priceLamports,
      feeLamports: record.feeLamports,
      // Only the job's own buyer rates it.
      score: rating !== undefined && rating.buyer === record.buyer ? rating.score : null,
    };
    if (isFirstPartyJob(job, facts.get(provider)?.wallet ?? null, firstParty)) return;
    jobs.push(job);
  });

  const byListing = new Map<string, PaidJob[]>();
  const byProvider = new Map<string, PaidJob[]>();
  for (const job of jobs) {
    if (job.listing !== null) byListing.set(job.listing, [...(byListing.get(job.listing) ?? []), job]);
    byProvider.set(job.provider, [...(byProvider.get(job.provider) ?? []), job]);
  }
  return {
    listings: new Map([...byListing].map(([listing, list]) => [listing, tally(list)])),
    providers: new Map([...byProvider].map(([agent, list]) => [agent, tally(list)])),
    facts,
    unread,
    pending: settled.pending,
  };
}

/** How long a record is used before it is read again. */
const RECORD_TTL_MS = 5 * 60_000;
/** After a read that failed, how long before it is tried again. */
const RECORD_RETRY_MS = 60_000;

/** The record as last read, and whether a newer one is on its way. */
export interface KnownRecord {
  /** Null until a read has succeeded. */
  record: MarketRecord | null;
  /** A read is under way. */
  reading: boolean;
}

export interface RecordKeeper {
  /**
   * The record of these services, read again when it is old or misses one
   * of their agents, waiting at most `waitMs` for a read that is under way.
   */
  read(rows: readonly RecordRow[], waitMs: number): Promise<KnownRecord>;
  /** Something the record counts has changed (a job was paid or rated): read it again next time. */
  invalidate(): void;
}

/** Keep one record, read in the background and used for a few minutes. */
export function createRecordKeeper(source: RecordSource, now: () => number = Date.now): RecordKeeper {
  // Who each finished job paid is looked up once and kept: it never changes.
  const reader: RecordSource = { ...source, settledBy: source.settledBy ?? new Map() };
  let known: { at: number; record: MarketRecord } | null = null;
  let reading: Promise<void> | null = null;
  let failedAt: number | null = null;
  let stale = false;

  function due(rows: readonly RecordRow[]): boolean {
    if (stale) return true;
    if (failedAt !== null && now() - failedAt < RECORD_RETRY_MS) return false;
    if (known === null || now() - known.at >= RECORD_TTL_MS) return true;
    const facts = known.record.facts;
    return rows.some((row) => !facts.has(row.providerAgent));
  }

  return {
    async read(rows, waitMs) {
      if (reading === null && due(rows)) {
        stale = false;
        const asked = [...rows];
        reading = readMarketRecord(reader, asked).then(
          (record) => {
            known = { at: now(), record };
            failedAt = null;
            // Jobs still to look up: the next read goes on with them.
            if (record.pending > 0) stale = true;
          },
          () => {
            failedAt = now();
          },
        );
        void reading.finally(() => {
          reading = null;
        });
      }
      const pending = reading;
      if (pending !== null && waitMs > 0) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          pending,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, waitMs);
            timer.unref();
          }),
        ]);
        clearTimeout(timer);
      }
      return { record: known?.record ?? null, reading: reading !== null };
    },
    invalidate() {
      stale = true;
    },
  };
}
