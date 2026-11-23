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

export function checkOutputAgreement(value: OutputAgreement): OutputAgreement {
  if (!value || typeof value.allowTextOnly !== "boolean" || !Array.isArray(value.requiredFiles) || value.requiredFiles.length > 8 ||
      value.requiredFiles.some(n => typeof n !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(n) || n.includes("..")) ||
      new Set(value.requiredFiles.map(n => n.toLowerCase())).size !== value.requiredFiles.length) throw new Error("Invalid promised output manifest.");
  return { requiredFiles: [...value.requiredFiles], allowTextOnly: value.allowTextOnly };
}

export interface RecipientGrantPreview {
  parties: { task: string; claim: string; claimedAt: string; worker: string; buyer: string; authority: string; room: string };
  keySignature: string;
  commitment: string;
  deadline: number;
  processing: string;
  files: readonly PrivateFileView[];
}

/** Add these actions to the scoped chat job tool. Owner file picking and
 * release decisions stay in the Market panel. Use the earlier message ID on retry. */
export const jobExchangeChatSchema = {
  type: "object",
  additionalProperties: false,
  required: ["jobId", "action"],
  properties: {
    jobId: { type: "string", minLength: 1 },
    action: { enum: ["status", "history", "refresh", "join", "send", "retryMessages", "readDeliveryChunk"] },
    message: {
      type: "object", additionalProperties: false, required: ["kind", "body", "id", "parent"],
      properties: {
        kind: { enum: ["question", "reply", "progress", "ack"] }, body: { type: "string", minLength: 1, maxLength: 8000 },
        id: { type: "string", pattern: "^[a-f0-9]{32}$" }, parent: { anyOf: [{ type: "null" }, { type: "string", pattern: "^[a-f0-9]{32}$" }] },
      },
    },
    part: { type: "string", maxLength: 64 }, offset: { type: "integer", minimum: 0 },
  },
} as const;

export const privatePurchaseNotice = "Anyone can read the brief and acceptance criteria. Add private files in Market. The owner chooses which confirmed worker and room receive them.";
