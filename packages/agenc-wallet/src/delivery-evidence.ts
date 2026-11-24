import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Address } from "@solana/kit";
import { getTaskClaimDecoder, getTaskClaimDiscriminatorBytes, SubmissionStatus, TaskStatus } from "@tetsuo-ai/marketplace-sdk";
import type { Chain } from "./chain.js";
import { deliveryFileProblem, deliveryFileType, splitDelivery, type DeliveryFile } from "./client/delivery-files.js";
import type { DeliveryBinding, DeliveryChunkAck, EvidenceChunk, OutputAgreement } from "./client/job-exchange.js";
import { WalletError } from "./errors.js";
import { readAgent, readProgramAccount, readSubmission, readTask } from "./market.js";
import { digest, type ExchangeJournal, type PrivateBundle } from "./private-inputs.js";
import type { MarketServices } from "./services.js";

const CHUNK = 24 * 1024;
const unavailable = (): never => { throw new WalletError("NOT_AVAILABLE", "The current delivery could not be verified. Retry before the review deadline.", { retryable: true }); };
export interface Evidence {
  binding: DeliveryBinding;
  manifest: string;
  text: string;
  files: DeliveryFile[];
  parts: Map<string, Buffer>;
}

export async function currentSubmission(chain: Chain, task: Address, worker: Address, buyer: Address) {
  const [submission, job, agent] = await Promise.all([readSubmission(chain, task, worker), readTask(chain, task), readAgent(chain, worker)]);
  if (!submission || !job || !agent || job.creator !== buyer || job.status !== TaskStatus.PendingValidation ||
      submission.account.worker !== worker || submission.account.claim !== submission.claim ||
      submission.account.status !== SubmissionStatus.Submitted) return unavailable();
  const held = await readProgramAccount(chain, submission.claim, getTaskClaimDiscriminatorBytes(), b => getTaskClaimDecoder().decode(b));
  if (!held || held.worker !== worker || held.task !== task || held.isCompleted) return unavailable();
  const binding: DeliveryBinding = { task, claim: submission.claim, worker, claimedAt: String(held.claimedAt), generation: Buffer.from(job.reserved).readBigUInt64LE(3).toString(), round: submission.account.submissionCount,
    deliveryHash: Buffer.from(submission.account.proofHash).toString("hex"), reviewEndsAt: Number(submission.account.reviewDeadlineAt) * 1000 };
  return { binding, authority: agent.authority, pointer: Uint8Array.from(submission.account.resultData) };
}

export async function verifiedEvidence(current: Awaited<ReturnType<typeof currentSubmission>>, services: MarketServices,
  bundle: PrivateBundle | undefined, agreement: OutputAgreement, requiresPrivate: boolean): Promise<Evidence> {
  const { binding, pointer } = current;
  const { deliveryHash } = binding;
  const result = await services.fetchResult({ proofHashHex: deliveryHash, resultData: pointer }).catch(() => null);
  if (!result || digest(result.bytes) !== deliveryHash || result.bytes.length > 262144) return unavailable();
  let raw: string;
  try { raw = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes); } catch { return unavailable(); }
  const match = /^agenc\.private-output\.v2:([a-f0-9]{64})$/.exec(raw);
  if (requiresPrivate && !match) return unavailable();
  let { text, files } = splitDelivery(raw);
  if (!match && !files.length && raw.includes("\n---\nFiles with this delivery:\n")) return unavailable();
  const parts = new Map<string, Buffer>();
  if (match) {
    if (!bundle) return unavailable();
    text = bundle.text;
    files = bundle.files.map(f => ({ name: f.name, sha256: f.sha256, bytes: f.bytes, type: deliveryFileType(f.name) ?? "" }));
    for (const file of bundle.files) parts.set(file.name, Buffer.from(file.base64, "base64"));
  }
  if ((!text.trim() && !files.length) || (!agreement.allowTextOnly && !files.length) ||
      agreement.requiredFiles.some(name => !files.some(file => file.name === name)) ||
      new Set(files.map(f => f.name.toLowerCase())).size !== files.length) return unavailable();
  for (const file of files) {
    const bytes = parts.get(file.name) ?? await services.fetchFile(file.sha256).catch(() => null);
    if (!bytes || bytes.length !== file.bytes || digest(bytes) !== file.sha256 || deliveryFileProblem(file.name, bytes)) return unavailable();
    parts.set(file.name, Buffer.from(bytes));
  }
  parts.set("text", Buffer.from(text));
  const manifest = digest(JSON.stringify([binding, digest(text), files.map(f => [f.name, f.bytes, f.sha256]), agreement]));
  return { binding, manifest, text, parts, files };
}

const receiptKey = (scope: string, manifest: string) => JSON.stringify(["inspection-ack-v1", scope, manifest]);

function complete(e: Evidence, offsets: Record<string, number>) {
  return [...e.parts].every(([part, bytes]) => Object.hasOwn(offsets, part) && offsets[part] === bytes.length);
}

interface Coverage { secret: string; offsets: Record<string, number> }

function coverage(journal: ExchangeJournal, key: string): Coverage {
  const stored = journal.read<Coverage>(key);
  if (stored) return stored;
  const fresh = { secret: randomBytes(32).toString("hex"), offsets: {} };
  journal.write(key, fresh);
  return fresh;
}

function chunkBytes(e: Evidence, part: string, offset: number) {
  const bytes = e.parts.get(part);
  if (!bytes || !Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length) {
    throw new WalletError("BAD_REQUEST", "Choose a listed delivery part and a valid byte offset.");
  }
  return { totalBytes: bytes.length, next: bytes.subarray(offset, offset + CHUNK) };
}

function challenge(state: Coverage, part: string, offset: number) {
  return createHmac("sha256", state.secret).update(JSON.stringify([part, offset])).digest("hex");
}

export function readEvidenceChunk(journal: ExchangeJournal, scope: string | null, e: Evidence, part: string, offset: number): EvidenceChunk {
  const { totalBytes, next } = chunkBytes(e, part, offset);
  const state = scope === null ? null : coverage(journal, receiptKey(scope, e.manifest));
  if (state && offset > (state.offsets[part] ?? 0)) throw new WalletError("BAD_REQUEST", "Acknowledge the preceding bytes first.");
  return { binding: e.binding, manifest: e.manifest, part, offset, totalBytes, base64: next.toString("base64"),
    challenge: state ? challenge(state, part, offset) : null, inspected: state ? complete(e, state.offsets) : false };
}

export function acknowledgeEvidenceChunk(journal: ExchangeJournal, scope: string, e: Evidence, ack: DeliveryChunkAck) {
  const key = receiptKey(scope, e.manifest);
  const state = journal.read<Coverage>(key);
  const { next } = chunkBytes(e, ack.part, ack.offset);
  if (!state || ack.manifest !== e.manifest || ack.offset > (state.offsets[ack.part] ?? 0) ||
      ack.proof !== createHash("sha256").update(challenge(state, ack.part, ack.offset)).update(next).digest("hex")) {
    throw new WalletError("NOT_ALLOWED", "Acknowledge the bytes received for the current delivery.");
  }
  state.offsets[ack.part] = Math.max(state.offsets[ack.part] ?? 0, ack.offset + next.length);
  journal.write(key, state);
  return { inspected: complete(e, state.offsets) };
}

export function requireInspection(journal: ExchangeJournal, scope: string, e: Evidence, hash: string, round: number) {
  if (hash !== e.binding.deliveryHash || round !== e.binding.round ||
      !complete(e, journal.read<Coverage>(receiptKey(scope, e.manifest))?.offsets ?? {})) {
    throw new WalletError("NOT_ALLOWED", "Read the complete current delivery and every listed file before approving payment.");
  }
}

/** The reviewer that read the bytes: the paying agent itself, or one outside connection acting for it.
 * A different connection, another agent or a room import never shares this receipt. */
export function reviewerScope(agentId: string, connectionId?: string | null) {
  if (!agentId) throw new WalletError("NOT_ALLOWED", "A paying agent is required.");
  return connectionId ? JSON.stringify(["connection", agentId, connectionId]) : agentId;
}

const roomImportKey = (grant: RoomImportScope, manifest: string) =>
  JSON.stringify(["room-import-v1", grant.parentTask, grant.sellerAgentId, grant.claimedAt, grant.roomId, manifest]);
export interface RoomImportScope { kind: "room-import"; parentTask: string; sellerAgentId: string; claimedAt: string; roomId: string }

/** One verified snapshot for a seller's room. Its receipt lives in its own
 * namespace and never counts as a payment inspection. */
export function roomImportEvidence(journal: ExchangeJournal, scope: RoomImportScope, e: Evidence, outputs: string[]) {
  if (scope.kind !== "room-import" || !Array.isArray(outputs) ||
      outputs.some(name => name === "text" ? !e.text.trim() : !e.files.some(file => file.name === name))) return unavailable();
  journal.write(roomImportKey(scope, e.manifest), { round: e.binding.round, hash: e.binding.deliveryHash });
  return {
    round: e.binding.round,
    deliveryHash: e.binding.deliveryHash,
    text: e.text,
    files: e.files.map(f => ({ name: f.name, bytes: f.bytes, sha256: f.sha256, base64: e.parts.get(f.name)!.toString("base64") })),
  };
}
