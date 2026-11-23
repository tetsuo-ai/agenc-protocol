import { WalletError } from "./errors.js";

export const PRIVATE_CRITERION = "Private input handoff v1: ";
export const CHILD_CRITERION = "Allow one seller-funded supplier under policy ";
const digest = /^[0-9a-f]{64}$/;
export interface PurchaseAttachments {
  privateCommitment?: string;
  childPolicyDigest?: string;
}
export type PrivateRequirement = { version: 1; required: true; commitment: string };
export type PurchaseAdmission = { privateInputs?: PrivateRequirement; childPolicyDigest?: string };
type ApprovedStage = { approvedJobInputs?(commitment: string): Promise<PrivateRequirement> };

/** Keep the public spec free of private filenames. B commits to its output agreement inside the same staged bundle. */
export async function purchaseAdmission(input: PurchaseAttachments, source: ApprovedStage, supportsHandoff: boolean,
  listedChildPolicy: string | undefined) {
  const admission: PurchaseAdmission = {};
  if (input.privateCommitment !== undefined) {
    if (!digest.test(input.privateCommitment) || !source.approvedJobInputs || !supportsHandoff)
      throw new WalletError("NOT_AVAILABLE", "Private inputs need an approved file set and a compatible room.");
    const approved = await source.approvedJobInputs(input.privateCommitment);
    if (approved.required !== true || approved.version !== 1 || approved.commitment !== input.privateCommitment)
      throw new WalletError("NOT_ALLOWED", "The approved file set changed.");
    admission.privateInputs = { required: true, version: 1, commitment: approved.commitment };
  }
  if (input.childPolicyDigest !== undefined) {
    if (!digest.test(input.childPolicyDigest) || listedChildPolicy !== input.childPolicyDigest)
      throw new WalletError("PRICE_CHANGED", "The supplier policy changed. Review the listing again.");
    admission.childPolicyDigest = input.childPolicyDigest;
  }
  return admission;
}

export function purchaseCriteria(criteria: string[], admission: PurchaseAdmission) {
  if (criteria.some(line => line.startsWith(PRIVATE_CRITERION) || line.startsWith(CHILD_CRITERION)))
    throw new WalletError("BAD_REQUEST", "Use the approved private input or supplier selection for these criteria.");
  const lines = [...criteria];
  if (admission.privateInputs) lines.push(PRIVATE_CRITERION + admission.privateInputs.commitment);
  if (admission.childPolicyDigest) lines.push(CHILD_CRITERION + admission.childPolicyDigest);
  if (lines.length > 8) throw new WalletError("BAD_REQUEST", "Use up to eight checks including private inputs and supplier terms.");
  return lines;
}
