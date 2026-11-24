import type {
  EvidenceChunk,
  OutputAgreement,
  PrivateFileView,
  PrivateRequirement,
} from "./job-exchange.js";

export type ExchangeAction =
  | {
      action:
        | "join"
        | "refresh"
        | "grantPreview"
        | "retryMessages"
        | "retryInputs";
    }
  | {
      action: "status" | "history";
      contextIndex?: number;
      beforeEntry?: number;
    }
  | {
      action: "release";
      preview: import("./job-exchange.js").RecipientGrantPreview;
    }
  | { action: "send"; message: import("./job-exchange.js").JobMessage }
  | { action: "collect" };
export interface ExchangeMethods {
  "jobs.bindRoom": {
    params: { jobId: string; room: string };
    result: { bound: boolean };
  };
  "jobs.exchange": {
    params: { jobId: string; request: ExchangeAction };
    result: unknown;
  };
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
  /** The paying agent confirms it received a part's bytes (B's challenge). Never the owner. */
  "jobs.acknowledgeDeliveryChunk": {
    params: { jobId: string; ack: import("./job-exchange.js").DeliveryChunkAck };
    result: unknown;
  };
}
