import { WalletError } from "./errors.js";
import { OUTPUT_AGREEMENT_CRITERION, type OutputAgreement } from "./client/job-exchange.js";
import { CHILD_SHARE_PREFIX } from "./client/child-hire.js";

export const PRIVATE_CRITERION = "Private input handoff v1: ";
export const CHILD_CRITERION = "Allow one seller-funded supplier under policy ";
const digest = /^[0-9a-f]{64}$/;
export interface PurchaseAttachments {
  privateCommitment?: string;
  childPolicyDigest?: string;
  /** Required file names and whether a text-only delivery is accepted. */
  outputs?: OutputAgreement;
}
export type PrivateRequirement = { version: 1; required: true; commitment: string };
export type PurchaseAdmission = { privateInputs?: PrivateRequirement; childPolicyDigest?: string };
type ApprovedStage = {
  approvedJobInputs?(commitment: string): Promise<PrivateRequirement>;
  /** The provider authority the staged files were approved for, or null for any provider. */
  approvedJobInputRecipient?(commitment: string): Promise<string | null>;
};

/** Keep the public spec free of private filenames. B commits to its output agreement inside the same staged bundle. */
export async function purchaseAdmission(input: PurchaseAttachments, source: ApprovedStage, supportsHandoff: boolean,
  listedChildPolicy: string | undefined, listingAuthority?: string | null) {
  const admission: PurchaseAdmission = {};
  if (input.privateCommitment !== undefined) {
    if (!digest.test(input.privateCommitment) || !source.approvedJobInputs || !supportsHandoff)
      throw new WalletError("NOT_AVAILABLE", "Private inputs need an approved file set and a compatible room.");
    const approved = await source.approvedJobInputs(input.privateCommitment);
    if (approved.required !== true || approved.version !== 1 || approved.commitment !== input.privateCommitment)
      throw new WalletError("NOT_ALLOWED", "The approved file set changed.");
    // A hire funds one listing's authority. Files approved for another
    // provider must refuse here, before any money moves, not at the handoff.
    if (listingAuthority !== undefined) {
      if (!source.approvedJobInputRecipient || listingAuthority === null)
        throw new WalletError("NOT_AVAILABLE", "The approved file set could not be checked against this provider.");
      const recipient = await source.approvedJobInputRecipient(input.privateCommitment);
      if (recipient !== null && recipient !== listingAuthority)
        throw new WalletError("NOT_ALLOWED", "The approved files are for a different provider. Choose the files again for this service.");
    }
    admission.privateInputs = { required: true, version: 1, commitment: approved.commitment };
  }
  if (input.childPolicyDigest !== undefined) {
    if (!digest.test(input.childPolicyDigest) || listedChildPolicy !== input.childPolicyDigest)
      throw new WalletError("PRICE_CHANGED", "The supplier policy changed. Review the listing again.");
    admission.childPolicyDigest = input.childPolicyDigest;
  }
  return admission;
}

/** Text only the wallet writes: private input, supplier policy and the buyer's share grant. */
export const CHILD_SHARE_MESSAGE = "agenc.child-share.v1";
const RESERVED = [PRIVATE_CRITERION, CHILD_CRITERION, CHILD_SHARE_PREFIX, CHILD_SHARE_MESSAGE].map(m => m.trim().toLowerCase());
export function reservedPurchaseText(value: unknown) {
  return typeof value === "string" && RESERVED.some(marker => value.replace(/\s+/g, " ").toLowerCase().includes(marker));
}

/** A share grant is the buyer's separate signed approval, delivered through the order exchange. Caller-written
 * criteria, request text or checkout fields cannot carry one. */
export function refuseReservedPurchase(input: Record<string, unknown>) {
  for (const key of ["shareGrant", "share_grant", "childShare", "child_share", "childShareGrant", "child_share_grant"])
    if (Object.hasOwn(input, key)) throw new WalletError("BAD_REQUEST", "Approve shared files for a supplier in Market. They cannot be part of an order.");
  const acceptance = Array.isArray(input.acceptance) ? input.acceptance : [];
  if (reservedPurchaseText(input.request) || reservedPurchaseText(input.brief) || acceptance.some(reservedPurchaseText))
    throw new WalletError("BAD_REQUEST", "Use the approved private input or supplier selection for these criteria.");
}

export function purchaseCriteria(criteria: string[], admission: PurchaseAdmission) {
  if (criteria.some(line => line.startsWith(PRIVATE_CRITERION) || line.startsWith(CHILD_CRITERION) || reservedPurchaseText(line) ||
      line.startsWith(OUTPUT_AGREEMENT_CRITERION)))
    throw new WalletError("BAD_REQUEST", "Use the approved private input or supplier selection for these criteria.");
  const lines = [...criteria];
  if (admission.privateInputs) lines.push(PRIVATE_CRITERION + admission.privateInputs.commitment);
  if (admission.childPolicyDigest) lines.push(CHILD_CRITERION + admission.childPolicyDigest);
  if (lines.length > 8) throw new WalletError("BAD_REQUEST", "Use up to eight checks including private inputs and supplier terms.");
  return lines;
}
