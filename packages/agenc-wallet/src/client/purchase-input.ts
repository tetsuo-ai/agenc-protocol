export interface PublicPurchaseAdmission {
  privateInputs?: { required: true; version: 1; commitment: string };
  childPolicyDigest?: string;
}

/** Public revision-one supplier terms in the seller's hash-verified listing metadata. */
export interface ListedSupplier {
  version: 1;
  payingSeller: string;
  policy: {
    allowedListings: string[];
    maxDebitLamports: string;
    returnBeforeSecs: number;
    reviewWindowSecs: number;
    sharing: "public-brief" | "buyer-approved-input";
  };
  digest: string;
}
