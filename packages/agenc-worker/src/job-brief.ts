/** Fields the buyer and worker retain from the same verified document. */
export interface BriefTerms {
  deadline: number;
  reviewWindowSecs: number;
  eligibility: { minReputation: number; requiredCapabilities: string } | null;
  contest?: { maxEntries: number; entryDepositLamports: string; releaseAt: number };
  listingDurationSecs: number | null;
}

const deliveryText = "Put the complete result in your submission. The buyer reads exactly what you submit.";

export function briefDeliverable(terms?: BriefTerms): string {
  if (!terms) return deliveryText;
  const eligibility = terms.eligibility
    ? ` Workers need reputation of at least ${terms.eligibility.minReputation} and capability mask ${terms.eligibility.requiredCapabilities}.`
    : "";
  if (terms.contest) {
    return `${deliveryText} Up to ${terms.contest.maxEntries} simultaneous entries. Deliver by ${new Date(terms.deadline * 1000).toISOString()}. Entry deposit ${terms.contest.entryDepositLamports} lamports, returned on settlement. A no-show forfeits it. Review setting ${terms.reviewWindowSecs} seconds. The owner can choose one winner before ${new Date(terms.contest.releaseAt * 1000).toISOString()}. After that, remaining submitters share the prize.${eligibility}`;
  }
  const duration = terms.listingDurationSecs === null ? "" : ` The escrow deadline is ${terms.listingDurationSecs} seconds after funding.`;
  return `${deliveryText} Deliver by ${new Date(terms.deadline * 1000).toISOString()}. The buyer has ${terms.reviewWindowSecs} seconds to review the submission.${eligibility}${duration}`;
}

export function isBriefTerms(value: unknown): value is BriefTerms {
  if (!value || typeof value !== "object") return false;
  const { deadline, reviewWindowSecs, eligibility, listingDurationSecs } = value as Partial<BriefTerms>;
  if (!Number.isSafeInteger(deadline) || typeof deadline !== "number" || deadline <= 0 ||
      !Number.isSafeInteger(reviewWindowSecs) || typeof reviewWindowSecs !== "number" ||
      reviewWindowSecs < 1 || reviewWindowSecs > 604800) return false;
  if (listingDurationSecs !== null && (typeof listingDurationSecs !== "number" ||
      !Number.isSafeInteger(listingDurationSecs) || listingDurationSecs <= 0)) return false;
  const contest = (value as Partial<BriefTerms>).contest;
  if (contest !== undefined && (!contest || listingDurationSecs !== null || !Number.isInteger(contest.maxEntries) ||
      contest.maxEntries < 2 || contest.maxEntries > 4 || contest.entryDepositLamports !== "10000000" ||
      contest.releaseAt !== deadline + 172800)) return false;
  if (eligibility === null) return true;
  if (!eligibility || typeof eligibility !== "object") return false;
  const { minReputation, requiredCapabilities } = eligibility;
  return Number.isInteger(minReputation) && minReputation >= 0 && minReputation <= 10000 &&
    typeof requiredCapabilities === "string" && /^[1-9][0-9]{0,19}$/.test(requiredCapabilities) &&
    BigInt(requiredCapabilities) <= 0xffffffffffffffffn;
}

function readTerms(text: unknown): BriefTerms | undefined {
  if (typeof text !== "string" || !text.startsWith(deliveryText)) return undefined;
  if (text.startsWith(deliveryText + " Up to ")) {
    const contest = /^ Up to (\d+) simultaneous entries\. Deliver by (\S+)\. Entry deposit (\d+) lamports, returned on settlement\. A no-show forfeits it\. Review setting (\d+) seconds\. The owner can choose one winner before (\S+)\. After that, remaining submitters share the prize\.(?: Workers need reputation of at least (\d+) and capability mask (\d+)\.)?$/.exec(text.slice(deliveryText.length));
    if (!contest) throw new Error("Invalid contest terms.");
    const terms = { deadline: Date.parse(contest[2]!) / 1000, reviewWindowSecs: Number(contest[4]), listingDurationSecs: null,
      contest: { maxEntries: Number(contest[1]), entryDepositLamports: contest[3]!, releaseAt: Date.parse(contest[5]!) / 1000 },
      eligibility: contest[6] ? { minReputation: Number(contest[6]), requiredCapabilities: contest[7]! } : null };
    if (!isBriefTerms(terms) || briefDeliverable(terms) !== text) throw new Error("Invalid contest terms.");
    return terms;
  }
  const match = /^ Deliver by (\S+)\. The buyer has (\d+) seconds to review the submission\.(?: Workers need reputation of at least (\d+) and capability mask (\d+)\.)?(?: The escrow deadline is (\d+) seconds after funding\.)?$/.exec(text.slice(deliveryText.length));
  if (!match) return undefined;
  const terms = {
    deadline: Date.parse(match[1]!) / 1000,
    reviewWindowSecs: Number(match[2]),
    eligibility: match[3] ? { minReputation: Number(match[3]), requiredCapabilities: match[4]! } : null,
    listingDurationSecs: match[5] ? Number(match[5]) : null,
  };
  if (!isBriefTerms(terms) || briefDeliverable(terms) !== text) throw new Error("Invalid job terms.");
  return terms;
}

export function parseJobBrief(spec: Record<string, unknown>) {
  const descriptions = [spec.instructions, spec.fullDescription, spec.details].filter(value => value != null && value !== "");
  const request = descriptions[0] ?? spec.shortDescription ?? spec.summary ?? "";
  const checks = spec.acceptance ?? spec.acceptanceCriteria ?? [];
  if (typeof request !== "string" || descriptions.some(value => value !== request) ||
      !Array.isArray(checks) || !checks.every((item): item is string => typeof item === "string") ||
      (spec.acceptance != null && spec.acceptanceCriteria != null && JSON.stringify(spec.acceptance) !== JSON.stringify(spec.acceptanceCriteria))) {
    throw new Error("The job spec contains conflicting or invalid instructions.");
  }
  const deliverables = spec.deliverables;
  if (spec.deliverable != null && deliverables != null && JSON.stringify([spec.deliverable]) !== JSON.stringify(deliverables)) {
    throw new Error("The job spec contains conflicting deliverables.");
  }
  const terms = readTerms(spec.deliverable ?? (Array.isArray(deliverables) ? deliverables[0] : undefined));
  return { request, acceptance: checks as string[], ...(terms && { terms }) };
}
