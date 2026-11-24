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
  /** B: present only for the paying agent; answer it with deliveryChunkAck after the bytes arrive. */
  challenge?: string | null;
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

export interface PrivateInputFile extends PrivateFileView { base64: string }
export type PrivateInputPart = PrivateInputFile | { stagedCommitment: string };

/** The owner transport accepts one MiB per request. Large selections are
 * staged a file at a time, then committed as one ordered, approved set. */
export async function stageInputSelection(files: PrivateInputFile[], stage: (parts: PrivateInputPart[]) => Promise<PrivateRequirement>) {
  if (!files.length || files.length > 8) throw new Error("Choose up to eight private files.");
  if (files.reduce((size, file) => size + file.base64.length, 0) <= 1000000) return stage(files);
  const references: PrivateInputPart[] = [];
  for (const file of files) {
    const approved = await stage([file]);
    references.push({ stagedCommitment: approved.commitment });
  }
  return stage(references);
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

// From track B (client/job-exchange.ts). The final merge takes B's whole file.
export interface DeliveryChunkAck { manifest: string; part: string; offset: number; proof: string }

/** Compute this in the authenticated reader after decoding the reply. */
export async function deliveryChunkAck(chunk: EvidenceChunk): Promise<DeliveryChunkAck> {
  if (!chunk.challenge) throw new Error("Only the paying agent can acknowledge a delivery.");
  const bytes = Uint8Array.from(atob(chunk.base64), char => char.charCodeAt(0));
  const nonce = new TextEncoder().encode(chunk.challenge);
  const input = new Uint8Array(nonce.length + bytes.length);
  input.set(nonce);
  input.set(bytes, nonce.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return { manifest: chunk.manifest, part: chunk.part, offset: chunk.offset, proof: Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("") };
}

export const jobMessageIdPattern = "^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$";

/** Add these actions to the scoped chat job tool. Owner file picking and
 * release decisions stay in the Market panel. Use the earlier message ID on retry. */
export const jobExchangeChatSchema = {
  type: "object",
  additionalProperties: false,
  required: ["jobId", "action"],
  properties: {
    jobId: { type: "string", minLength: 1 },
    action: { enum: ["status", "history", "refresh", "join", "send", "retryMessages", "collect", "readDeliveryChunk", "acknowledgeDeliveryChunk"] },
    message: {
      type: "object", additionalProperties: false, required: ["kind", "body", "id", "parent"],
      properties: {
        kind: { enum: ["question", "reply", "progress", "ack"] }, body: { type: "string", minLength: 1, maxLength: 8000 },
        id: { type: "string", pattern: jobMessageIdPattern }, parent: { anyOf: [{ type: "null" }, { type: "string", pattern: jobMessageIdPattern }] },
      },
    },
    contextIndex: { type: "integer", minimum: 0 }, beforeEntry: { type: "integer", minimum: 0 },
    manifest: { type: "string", pattern: "^[a-f0-9]{64}$" }, proof: { type: "string", pattern: "^[a-f0-9]{64}$" },
    part: { type: "string", maxLength: 64 }, offset: { type: "integer", minimum: 0 },
  },
} as const;

export const privatePurchaseNotice = "Anyone can read the brief and acceptance criteria. Add private files in Market. The owner chooses which confirmed worker and room receive them.";

