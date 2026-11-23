import type { PurchaseAttachments } from "./purchase-admission.js";
import { facade } from "@tetsuo-ai/marketplace-sdk";
import { createHash } from "node:crypto";
import type { AmountInput } from "./client/protocol.js";
import type { JobTerms } from "./client/types.js";
import { WalletError } from "./errors.js";

import { tidyText } from "./services.js";

/** Checks a delivery has to pass, as a buyer wrote them: at most 8 lines of 300 characters. */
export function checkedAcceptance(list: readonly string[] | undefined): string[] {
  if (list !== undefined && !Array.isArray(list)) throw new WalletError("BAD_REQUEST", "Provide the checks as a list.");
  const acceptance = (list ?? []).map((item) => {
    if (typeof item !== "string" || item.trim().length > 300) throw new WalletError("BAD_REQUEST", "Use up to 300 characters per check.");
    const line = tidyText(item, 300);
    if (line === null) throw new WalletError("BAD_REQUEST", "A check cannot be empty.");
    return line;
  });
  if (acceptance.length > 8) {
    throw new WalletError("BAD_REQUEST", "Use at most 8 checks.");
  }
  return acceptance;
}

export interface TermsInput extends PurchaseAttachments {
  contestEntries?: number;
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
  if (input.contestEntries !== undefined) {
    if (listingDuration !== null || !Number.isInteger(input.contestEntries) || input.contestEntries < 2 || input.contestEntries > 4) {
      throw new WalletError("BAD_REQUEST", "Choose 2 to 4 contest entry slots on a public post.");
    }
    return { deadline, reviewWindowSecs, eligibility, listingDurationSecs: null, contest: {
      maxEntries: input.contestEntries, entryDepositLamports: facade.CONTEST_ENTRY_DEPOSIT_LAMPORTS.toString(),
      releaseAt: deadline + Number(facade.CONTEST_SELECTION_WINDOW_SECS),
    } };
  }
  return { deadline, reviewWindowSecs, eligibility, listingDurationSecs: listingDuration };
}

/** Use the caller's amount and clock choice so a retry survives rate and clock changes. */
export function jobIdentity(input: TermsInput & { request: string; acceptance?: string[]; listing?: string; listingAgreement?: import("./client/listing-exchange.js").ListingAgreement; expectedPriceLamports?: string; expectedSpecHash?: string; reward?: AmountInput; maxPriceCents?: number }, quoteOnly: boolean, acceptanceFormat: "normalized" | "raw" = "normalized"): string {
  if (typeof input.request !== "string") throw new WalletError("BAD_REQUEST", "Describe the work.");
  const reward = input.reward;
  if (reward !== undefined && (typeof reward !== "object" || reward === null || ("usdCents" in reward && "lamports" in reward))) {
    throw new WalletError("BAD_REQUEST", "Choose one amount for the reward.");
  }
  const amount = reward && ("usdCents" in reward ? ["usdCents", reward.usdCents] : ["lamports", reward.lamports]);
  return createHash("sha256").update(JSON.stringify([
    quoteOnly, input.request.trim(), acceptanceFormat === "raw" ? input.acceptance ?? [] : checkedAcceptance(input.acceptance), input.listing, amount, input.maxPriceCents,
    input.deadline, input.deadline === undefined && !input.listing ? input.deadlineDays ?? 7 : input.deadlineDays,
    input.reviewWindowSecs, input.minReputation ?? 0, input.requiredCapabilities ?? "1",
    ...(input.privateCommitment !== undefined ? ["private", input.privateCommitment] : []),
    ...(input.childPolicyDigest !== undefined ? ["supplier", input.childPolicyDigest] : []),
    ...(input.listingAgreement ? ["inquiry", input.listingAgreement.question?.signature, input.listingAgreement.reply?.signature, input.listingAgreement.selected] : []),
    ...(input.contestEntries === undefined ? [] : ["contest", input.contestEntries]),
    ...(input.expectedPriceLamports || input.expectedSpecHash ? [input.expectedPriceLamports, input.expectedSpecHash] : []),
  ])).digest("hex");
}
