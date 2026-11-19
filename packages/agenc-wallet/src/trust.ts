// What a buyer is told about a service and the agent behind it, weighed by
// money. Anything a provider can have for free can be faked for free, so
// nothing here counts by the event: a rating or a finished job counts in
// proportion to the marketplace fee that was really taken for that job. A
// five-star rating on a job that paid the marketplace next to nothing weighs
// next to nothing, and faking a record costs about the fee on the business it
// claims.
//
// Pure arithmetic over jobs that were already checked against the chain
// (records.ts reads and checks them).

/** One finished job a buyer paid for, as the record of a service is built from. */
export interface PaidJob {
  /** The job's address. Each job counts once. */
  task: string;
  /** The service it was hired from, or null when that is not known. */
  listing: string | null;
  /** The agent that did the work. */
  provider: string;
  /** The wallet that paid for it. */
  buyer: string;
  /** What the buyer paid. */
  priceLamports: bigint;
  /** The marketplace's fee taken out of that price: what makes the job count. */
  feeLamports: bigint;
  /** The buyer's stars for this job, 1 to 5, or null when it was not rated. */
  score: number | null;
}

/** A service's or a provider's record, as a buyer is shown it. */
export interface TrustRecord {
  /**
   * The buyers' stars, each rating weighed by the fee its job paid (see
   * {@link jobWeight}). Null when no counted job was rated.
   */
  rating: number | null;
  /** How many ratings `rating` holds. */
  ratings: number;
  /** Finished jobs buyers paid for. */
  jobs: number;
  /** What the buyers paid for them. */
  paidLamports: bigint;
  /** The marketplace's fee on them. */
  feeLamports: bigint;
  /** Distinct wallets that paid for at least one. */
  buyers: number;
  /** How well the record ranks: see {@link trustScore}. */
  score: number;
}

/**
 * Accounts whose jobs are left out of every record: the marketplace's own.
 * For the marketplace a fee is not a cost (it is paid to itself), so a record
 * it builds with its own accounts proves nothing.
 */
export interface FirstParty {
  /** Wallets: a job they paid for, or a service they own, counts for nothing. */
  readonly wallets: ReadonlySet<string>;
  /** Provider agents whose jobs count for nothing. */
  readonly agents: ReadonlySet<string>;
  /** Services whose jobs count for nothing. */
  readonly listings: ReadonlySet<string>;
}

export const NO_FIRST_PARTY: FirstParty = {
  wallets: new Set(),
  agents: new Set(),
  listings: new Set(),
};

/**
 * True when a job says nothing a buyer can trust: one of the marketplace's
 * own accounts was on either side of it. `providerWallet` is the wallet that
 * owns the provider agent, when known.
 */
export function isFirstPartyJob(
  job: Pick<PaidJob, "listing" | "provider" | "buyer">,
  providerWallet: string | null,
  firstParty: FirstParty,
): boolean {
  return (
    firstParty.wallets.has(job.buyer) ||
    firstParty.agents.has(job.provider) ||
    (providerWallet !== null && firstParty.wallets.has(providerWallet)) ||
    (job.listing !== null && firstParty.listings.has(job.listing))
  );
}

/**
 * The most one job weighs, in marketplace fee: the fee on a 0.05 SOL job at
 * 5%. A bigger job counts as much as that and no more, so one large job
 * cannot outweigh a record of many.
 */
export const JOB_WEIGHT_CAP_LAMPORTS = 2_500_000n;

/**
 * How much fee a record needs before it moves far from {@link NEUTRAL_STARS}:
 * a record backed by this much counts as much as the starting point. Four
 * capped jobs' worth, so three four-star jobs rank above one five-star job of
 * any size.
 */
export const PRIOR_WEIGHT_LAMPORTS = 4n * JOB_WEIGHT_CAP_LAMPORTS;

/** Where a service with no record starts: the middle of one to five stars. */
export const NEUTRAL_STARS = 3;

/**
 * What a paid job its buyer did not rate counts as. Paying is the buyer's
 * yes: they looked at the work and approved it.
 */
export const PAID_UNRATED_STARS = 4;

/** What one job weighs: its fee, up to {@link JOB_WEIGHT_CAP_LAMPORTS}. */
export function jobWeight(feeLamports: bigint): bigint {
  if (feeLamports <= 0n) return 0n;
  return feeLamports < JOB_WEIGHT_CAP_LAMPORTS ? feeLamports : JOB_WEIGHT_CAP_LAMPORTS;
}

/**
 * How a record ranks. Every paid job is a vote: its stars when the buyer
 * rated it, {@link PAID_UNRATED_STARS} when they only paid. Each vote weighs
 * the fee its job paid (see {@link jobWeight}), and the record starts from
 * {@link NEUTRAL_STARS} with the weight {@link PRIOR_WEIGHT_LAMPORTS}. So a
 * handful of cheap five-star jobs barely moves a service, and many good jobs
 * move it more than one excellent one.
 */
export function trustScore(jobs: readonly Pick<PaidJob, "feeLamports" | "score">[]): number {
  let weight = Number(PRIOR_WEIGHT_LAMPORTS);
  let sum = NEUTRAL_STARS * weight;
  for (const job of jobs) {
    const w = Number(jobWeight(job.feeLamports));
    if (w === 0) continue;
    weight += w;
    sum += w * (job.score ?? PAID_UNRATED_STARS);
  }
  return sum / weight;
}

/** A valid star score, or null. */
function stars(score: number | null): number | null {
  return score !== null && Number.isInteger(score) && score >= 1 && score <= 5 ? score : null;
}

/**
 * Add up a set of jobs. A job that paid the marketplace nothing is left out,
 * as is a second entry for the same job.
 */
export function tally(jobs: readonly PaidJob[]): TrustRecord {
  const seen = new Set<string>();
  const counted: PaidJob[] = [];
  for (const job of jobs) {
    if (job.feeLamports <= 0n || job.priceLamports <= 0n || seen.has(job.task)) continue;
    seen.add(job.task);
    counted.push({ ...job, score: stars(job.score) });
  }
  let ratedWeight = 0;
  let ratedSum = 0;
  let ratings = 0;
  let paid = 0n;
  let fees = 0n;
  const buyers = new Set<string>();
  for (const job of counted) {
    paid += job.priceLamports;
    fees += job.feeLamports;
    buyers.add(job.buyer);
    if (job.score !== null) {
      const w = Number(jobWeight(job.feeLamports));
      ratings += 1;
      ratedWeight += w;
      ratedSum += w * job.score;
    }
  }
  return {
    rating: ratedWeight > 0 ? ratedSum / ratedWeight : null,
    ratings,
    jobs: counted.length,
    paidLamports: paid,
    feeLamports: fees,
    buyers: buyers.size,
    score: trustScore(counted),
  };
}

/** The record of nothing: a service nobody has paid for yet. */
export const EMPTY_RECORD: TrustRecord = tally([]);

/**
 * Order two records best first: the higher {@link trustScore}, then the one
 * more money stands behind.
 */
export function compareRecords(a: TrustRecord, b: TrustRecord): number {
  if (a.score !== b.score) return b.score - a.score;
  return a.feeLamports > b.feeLamports ? -1 : a.feeLamports < b.feeLamports ? 1 : 0;
}
