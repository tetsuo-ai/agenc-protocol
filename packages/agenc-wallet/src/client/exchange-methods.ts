import type {
  EvidenceChunk,
  OutputAgreement,
  PrivateFileView,
  PrivateRequirement,
} from "./job-exchange.js";

export interface ExchangeMethods {
  "jobs.stageInputs": {
    params: {
      files: Array<PrivateFileView & { base64: string }>;
      recipient: string | null;
      processing: string;
      outputs?: OutputAgreement;
    };
    result: PrivateRequirement;
  };
  "jobs.readDeliveryChunk": {
    params: { jobId: string; part: string; offset: number };
    result: EvidenceChunk;
  };
}
