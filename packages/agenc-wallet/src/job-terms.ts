import { createHash } from "node:crypto";
import type { AmountInput } from "./client/protocol.js";
import type { JobTerms } from "./client/types.js";
import { WalletError } from "./errors.js";

export interface TermsInput {
  deadline?: number;
  deadlineDays?: number;
  reviewWindowSecs?: number;
  minReputation?: number;
  requiredCapabilities?: string;
}

export function resolveJobTerms(input: TermsInput, clock: number, defaultReview: bigint, listingDuration: number | null): JobTerms {
  if (listingDuration !== null && (input.deadlineDays !== undefined || input.minReputation !== undefined || input.requiredCapabilities !== undefined)) {
    throw new WalletError("BAD_REQUEST", "Worker eligibility and delivery days apply only to public requests.");
  }
  const { deadlineDays: days = 7 } = input;
  if (!Number.isInteger(days) || days < 1 || days > 30 || (input.deadline !== undefined && input.deadlineDays !== undefined)) {
    throw new WalletError("BAD_REQUEST", "Choose an exact deadline or a whole number of days from 1 to 30.");
  }
  const duration = listingDuration ?? days * 86_400;
  const { deadline = clock + duration } = input;
  if (!Number.isSafeInteger(deadline) || deadline <= clock || deadline > clock + Math.min(listingDuration ?? Infinity, 365 * 86_400)) {
    throw new WalletError("BAD_REQUEST", "Choose a future deadline within the delivery period.");
  }
  const { reviewWindowSecs = Number(defaultReview) } = input;
  if (!Number.isInteger(reviewWindowSecs) || reviewWindowSecs < 1 || reviewWindowSecs > 604_800) {
    throw new WalletError("BAD_REQUEST", "The review window must be 1 to 604800 seconds.");
  }
  let eligibility = null;
  if (listingDuration === null) {
    const { minReputation = 0, requiredCapabilities = "1" } = input;
    if (!Number.isInteger(minReputation) || minReputation < 0 || minReputation > 10_000) {
      throw new WalletError("BAD_REQUEST", "Minimum reputation must be a whole number from 0 to 10000.");
    }
    if (typeof requiredCapabilities !== "string" || !/^[1-9][0-9]{0,19}$/.test(requiredCapabilities) || BigInt(requiredCapabilities) > 0xffffffffffffffffn) {
      throw new WalletError("BAD_REQUEST", "Enter a nonzero 64-bit capability mask in decimal.");
    }
    eligibility = { minReputation, requiredCapabilities };
  }
  return { deadline, reviewWindowSecs, eligibility, listingDurationSecs: listingDuration };
}

/** Use the caller's amount and clock choice so a retry survives rate and clock changes. */
export function jobIdentity(input: TermsInput & { request: string; acceptance?: string[]; listing?: string; reward?: AmountInput; maxPriceCents?: number }, quoteOnly: boolean): string {
  if (typeof input.request !== "string") throw new WalletError("BAD_REQUEST", "Describe the work.");
  const reward = input.reward;
  if (reward !== undefined && (typeof reward !== "object" || reward === null || ("usdCents" in reward && "lamports" in reward))) {
    throw new WalletError("BAD_REQUEST", "Choose one amount for the reward.");
  }
  const amount = reward && ("usdCents" in reward ? ["usdCents", reward.usdCents] : ["lamports", reward.lamports]);
  return createHash("sha256").update(JSON.stringify([
    quoteOnly, input.request.trim(), input.acceptance ?? [], input.listing, amount, input.maxPriceCents,
    input.deadline, input.deadline === undefined && !input.listing ? input.deadlineDays ?? 7 : input.deadlineDays,
    input.reviewWindowSecs, input.minReputation ?? 0, input.requiredCapabilities ?? "1",
  ])).digest("hex");
}
