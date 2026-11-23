/** Public purchase metadata. All filenames, recipients and contents stay in the exchange. */
export interface PrivateRequirement {
  version: 1;
  commitment: string;
  required: true;
}

export interface OutputAgreement {
  requiredFiles: readonly string[];
  allowTextOnly: boolean;
}

export interface DeliveryBinding {
  task: string;
  claim: string;
  worker: string;
  claimedAt: string;
  round: number;
  deliveryHash: string;
  reviewEndsAt: number;
}

export interface EvidenceChunk {
  binding: DeliveryBinding;
  manifest: string;
  part: string;
  offset: number;
  totalBytes: number;
  base64: string;
  inspected: boolean;
}

export type ConversationKind = "question" | "reply" | "progress" | "ack";
export interface JobMessage {
  id: string;
  kind: ConversationKind;
  parent: string | null;
  body: string;
}

export interface PrivateFileView {
  name: string;
  bytes: number;
  sha256: string;
}

export interface ExchangeReceipt {
  commitment: string;
  version: number;
  manifest: string;
  room: string;
}
