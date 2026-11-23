/** Fields the buyer and worker retain from the same verified document. */
export interface BriefTerms {
  deadline: number;
  reviewWindowSecs: number;
  eligibility: { minReputation: number; requiredCapabilities: string } | null;
  listingDurationSecs: number | null;
}

const deliveryText = "Put the complete result in your submission. The buyer reads exactly what you submit.";

export function briefDeliverable(terms?: BriefTerms): string {
  if (!terms) return deliveryText;
  const eligibility = terms.eligibility
    ? ` Workers need reputation of at least ${terms.eligibility.minReputation} and capability mask ${terms.eligibility.requiredCapabilities}.`
    : "";
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
  if (eligibility === null) return true;
  if (!eligibility || typeof eligibility !== "object") return false;
  const { minReputation, requiredCapabilities } = eligibility;
  return Number.isInteger(minReputation) && minReputation >= 0 && minReputation <= 10000 &&
    typeof requiredCapabilities === "string" && /^[1-9][0-9]{0,19}$/.test(requiredCapabilities) &&
    BigInt(requiredCapabilities) <= 0xffffffffffffffffn;
}

function readTerms(text: unknown): BriefTerms | undefined {
  if (typeof text !== "string" || !text.startsWith(deliveryText)) return undefined;
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
