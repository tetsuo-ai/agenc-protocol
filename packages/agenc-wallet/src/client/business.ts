// Owner and agent projections shared by the wallet, Desktop and scoped broker.
import type { DeliveryFile } from "./delivery-files.js";

export interface JobParties {
  creatorWallet: string;
  creatorProfile?: string;
  workerRegistration: string | null;
  workerWallet: string | null;
  claimedAt: number | null; // Unix ms from the claim account
  workerProfile: string | null;
}

export interface JobLink {
  jobId: string;
  role: "buying" | "working";
}
export interface JobAction extends JobLink {
  id: string;
  agentId: string;
  event: "review" | "dispute" | "refund";
  title: string;
  dueAt: number | null; // Unix ms
  stage: "new" | "soon" | "due";
}

export interface WorkInspection {
  hash: string;
  part: string;
  base64: string;
  next: number | null;
  totalBytes: number;
  files: DeliveryFile[];
  correctionCents: number;
}

export interface PortableDraft {
  id: string;
  agentId: string;
  name: string;
  description: string;
  priceCents: number | null;
  lamports?: string;
  createdAt: number;
  terms?: import("./seller-terms.js").SellerTerms;
}
export interface PortableAsset {
  sha256: string;
  base64: string;
}
export interface PortableService {
  agentId: string;
  listingId: string;
  version: string;
  // The pinned bundle manifest is itself a content-addressed asset.
  manifest: string;
  assets: PortableAsset[];
}
export interface PortableBusiness {
  version: 1;
  drafts: PortableDraft[];
  services: PortableService[];
}
export interface RecoveryView {
  restoredAt: number;
  obligations: Array<
    JobLink & {
      unclaimed?: boolean;
      title: string;
      agentId: string;
      task: string | null;
    }
  >;
  pendingSignatures: string[];
  drafts: number;
  services: number;
  requiresConsent: boolean;
}
export interface BusinessMethods {
  "jobs.inbox": {
    params: Record<string, never>;
    result: { actions: JobAction[] };
  };
  "jobs.dismiss": { params: { id: string }; result: { dismissed: boolean } };
  "work.inspect": {
    params: {
      agentId: string;
      task: string;
      hash: string;
      part: string;
      offset: number;
    };
    result: WorkInspection;
  };
  "work.correct": {
    params: { agentId: string; task: string; hash: string; note: string };
    result: { hash: string };
  };
  "work.quoteManual": {
    params: { agentId: string };
    result: import("./types.js").EarnFundingQuote;
  };
  "work.startManual": {
    params: { agentId: string; fundingQuoteId: string };
    result: import("./types.js").AgentView;
  };
  "business.resume": {
    params: { restoredAt: number };
    result: RecoveryView | null;
  };
  "business.status": {
    params: Record<string, never>;
    result: RecoveryView | null;
  };
}

declare module "./types.js" {
  interface JobTerms {
    inquiry?: Awaited<ReturnType<typeof import("./listing-exchange.js").selectedListingTerms>>;
  }
  interface WalletOverview {
    businessVersion?: 1;
  }
  interface JobView {
    parties?: JobParties;
  }
  interface WorkerJobView {
    /** Unix seconds a correction must finish by, leaving time to submit or give back the claim. */
    correctionEndsAt?: number | null;
  }
}
