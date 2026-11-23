import type { Address } from "@solana/kit";
import { getTaskClaimDecoder, getTaskClaimDiscriminatorBytes, SubmissionStatus, TaskStatus } from "@tetsuo-ai/marketplace-sdk";
import type { Chain } from "./chain.js";
import { deliveryFileProblem, deliveryFileType, splitDelivery, type DeliveryFile } from "./client/delivery-files.js";
import type { DeliveryBinding, EvidenceChunk, OutputAgreement } from "./client/job-exchange.js";
import { WalletError } from "./errors.js";
import { readAgent, readProgramAccount, readSubmission, readTask } from "./market.js";
import { bundleManifest, digest, type ExchangeJournal, type PrivateBundle } from "./private-inputs.js";
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
  const binding: DeliveryBinding = { task, claim: submission.claim, worker, claimedAt: String(held.claimedAt), round: submission.account.submissionCount,
    deliveryHash: Buffer.from(submission.account.proofHash).toString("hex"), reviewEndsAt: Number(submission.account.reviewDeadlineAt) * 1000 };
  return { binding, authority: agent.authority, pointer: Uint8Array.from(submission.account.resultData) };
}

export async function verifiedEvidence(current: Awaited<ReturnType<typeof currentSubmission>>, services: MarketServices,
  journal: ExchangeJournal, agreement: OutputAgreement, requiresPrivate: boolean): Promise<Evidence> {
  const { binding, authority, pointer } = current;
  const { deliveryHash, task, claim, claimedAt } = binding;
  const result = await services.fetchResult({ proofHashHex: deliveryHash, resultData: pointer }).catch(() => null);
  if (!result || digest(result.bytes) !== deliveryHash || result.bytes.length > 262144) return unavailable();
  let raw: string;
  try { raw = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes); } catch { return unavailable(); }
  const match = /^agenc\.private-output\.v1:([a-f0-9]{64})$/.exec(raw);
  if (requiresPrivate && !match) return unavailable();
  let { text, files } = splitDelivery(raw);
  if (!match && !files.length && raw.includes("\n---\nFiles with this delivery:\n")) return unavailable();
  const parts = new Map<string, Buffer>();
  if (match) {
    const bundle = journal.read<PrivateBundle>(JSON.stringify(["output", task, claim, claimedAt, authority, match[1]]));
    if (!bundle || bundleManifest(bundle) !== match[1]) return unavailable();
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

const receiptKey = (scope: string, manifest: string) => JSON.stringify(["inspection", scope, manifest]);

function complete(e: Evidence, offsets: Record<string, number>) {
  return [...e.parts].every(([part, bytes]) => Object.hasOwn(offsets, part) && offsets[part] === bytes.length);
}

export function readEvidenceChunk(journal: ExchangeJournal, scope: string, e: Evidence, part: string, offset: number): EvidenceChunk {
  const bytes = e.parts.get(part);
  if (!bytes || !Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length) {
    throw new WalletError("BAD_REQUEST", "Choose a listed delivery part and a valid byte offset.");
  }
  const key = receiptKey(scope, e.manifest);
  const seen = journal.read<Record<string, number>>(key) ?? {};
  if (offset > (seen[part] ?? 0)) throw new WalletError("BAD_REQUEST", "Read the preceding bytes first.");
  const next = bytes.subarray(offset, offset + CHUNK);
  seen[part] = Math.max(seen[part] ?? 0, offset + next.length);
  journal.write(key, seen);
  return { binding: e.binding, manifest: e.manifest, part, offset, totalBytes: bytes.length, base64: next.toString("base64"), inspected: complete(e, seen) };
}

export function requireInspection(journal: ExchangeJournal, scope: string, e: Evidence, hash: string, round: number) {
  if (hash !== e.binding.deliveryHash || round !== e.binding.round ||
      !complete(e, journal.read<Record<string, number>>(receiptKey(scope, e.manifest)) ?? {})) {
    throw new WalletError("NOT_ALLOWED", "Read the complete current delivery and every listed file before approving payment.");
  }
}
