import { OUTPUT_AGREEMENT_CRITERION } from "./client/job-exchange.js";
import { ceilingLamports, microcents, type JobDeposits } from "./job-money.js";
import type { HirePayoutQuote } from "./client/hire-quote.js";
import { sellerProceeds } from "./seller-terms.js";
import { money } from "./views.js";
import { jobIdentity } from "./job-terms.js";
import { FEE_HEADROOM_LAMPORTS } from "./market.js";
import { WalletError } from "./errors.js";
import type { ServiceView } from "./client/types.js";
import type { ApprovalRecord, JobRecord } from "./store.js";

export function jobCosts(deposits: JobDeposits) {
  const fees = deposits.kept + deposits.networkFees;
  const returned = deposits.total - FEE_HEADROOM_LAMPORTS - deposits.kept - deposits.networkFees;
  return { fees, returned, extra: returned + fees };
}

export function checkPriceLimit(lamports: bigint, cap: number | undefined, rate: number | null): void {
  if (cap === undefined) return;
  if (rate === null) throw new WalletError("NETWORK", "Dollar prices are not available right now, so the price limit cannot be checked.");
  if (lamports > ceilingLamports(cap, rate)) throw new WalletError("PRICE_CHANGED", "The service costs more than the price limit.");
}

/** Recover the absent cap of a pre-upgrade chat hire when its stored inputs prove it. */
export function legacyRefreshLimit(job: JobRecord): number | undefined {
  if (job.kind === "hire" && job.terms && job.inputFingerprint) {
    // Newer jobs end their checks with the wallet-written output agreement, which the
    // caller's fingerprinted input did not contain.
    const written = job.acceptance?.filter(line => !line.startsWith(OUTPUT_AGREEMENT_CRITERION));
    const acceptances = written && written.length !== job.acceptance!.length
      ? [job.acceptance, written, ...(written.length === 0 ? [undefined] : [])] : [job.acceptance];
    for (const acceptance of acceptances) {
      const input = { request: job.request, listing: job.listing, ...(acceptance !== undefined && { acceptance }) };
      for (const deadline of [{}, { deadline: job.terms.deadline }]) {
        for (const review of [{}, { reviewWindowSecs: job.terms.reviewWindowSecs }]) {
          if (jobIdentity({ ...input, ...deadline, ...review }, false) === job.inputFingerprint) return undefined;
        }
      }
    }
  }
  return job.maxPriceCents;
}

/** Snapshot a job and its matching approval together. Both panel and agent requests use this quote. */
export function buildJobQuote(record: JobRecord, input: {
  approvalId: string;
  payer: "main" | "agent";
  service: ServiceView | null;
  deposits: JobDeposits;
  protocolFeeBps: number;
  rentTerms?: string;
  rate: number | null;
  now: number;
  expiresAt: number;
}): { job: JobRecord; approval: ApprovalRecord } {
  const { approvalId, payer, deposits, protocolFeeBps, rate, now, expiresAt } = input;
  const cost = jobCosts(deposits);
  let { service } = input;
  let hire: HirePayoutQuote | undefined;
  if (service) {
    if (!service.listingVersion || service.operator === undefined || service.operatorFeeBps === undefined) {
      throw new WalletError("NOT_AVAILABLE", "The listing terms are incomplete. Request a fresh hire quote.");
    }
    const price = BigInt(record.priceLamports);
    const proceeds = sellerProceeds(price, service.operatorFeeBps, protocolFeeBps, rate);
    hire = {
      listingVersion: service.listingVersion, price: money(price, rate),
      operator: service.operator, operatorFeeBps: service.operatorFeeBps, operatorFee: proceeds.operatorFee,
      marketplaceFeeBps: protocolFeeBps, maximumMarketplaceFee: proceeds.marketFee!,
      minimumSellerNet: proceeds.sellerNet!, minimumSellerNetIfOperatorCannotReceive: proceeds.sellerNetIfForfeited!,
    };
    service = { ...service, proceeds };
  }
  const job = {
    ...record, payer, approvalId,
    ...(hire && record.terms && { terms: { ...record.terms, hire } }),
    ...(rate !== null && { maxPriceCents: record.maxPriceCents ?? Number(microcents(BigInt(record.priceLamports), rate)) / 1_000_000 }),
    approvedCosts: { ...(input.rentTerms && { rentTerms: input.rentTerms }), networkFees: deposits.networkFees.toString(), cancellationRent: deposits.cancellationRent.toString(), total: deposits.total.toString(), kept: deposits.kept.toString(), protocolFeeBps, expiresAt },
  };
  const approval: ApprovalRecord = {
    id: approvalId,
    jobId: job.id,
    agentId: job.agentId,
    kind: job.kind ?? "hire",
    service: service === null ? null : {
      ...service,
      ...(service.details !== "ready" && { summary: null, details: "unavailable" }),
      price: money(job.priceLamports, rate),
      marketFee: { bps: protocolFeeBps, amount: money(BigInt(job.priceLamports) * BigInt(protocolFeeBps) / 10_000n, rate) },
    },
    request: job.request,
    ...(job.contestRegistration && { contestRegistration: job.contestRegistration }),
    acceptance: job.acceptance,
    ...(job.terms && { terms: job.terms }),
    ...(job.maxPriceCents !== undefined && { maxPriceCents: job.maxPriceCents }),
    priceLamports: job.priceLamports,
    depositsLamports: cost.extra.toString(),
    keptLamports: cost.fees.toString(),
    fromMainLamports: payer === "main" ? (BigInt(job.priceLamports) + cost.extra).toString() : "0",
    protocolFeeBps,
    networkFees: deposits.networkFees.toString(),
    retainedRent: (deposits.kept - deposits.cancellationRent - BigInt(record.contestRegistration?.rent ?? "0") - BigInt(record.contestRegistration?.stake ?? "0")).toString(),
    cancellationRent: deposits.cancellationRent.toString(),
    quoteRate: rate,
    createdAt: now,
    expiresAt,
    status: "pending",
  };
  return { job, approval };
}
