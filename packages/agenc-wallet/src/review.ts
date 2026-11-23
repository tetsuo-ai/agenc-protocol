import { createHash } from "node:crypto";
import type { Address, KeyPairSigner } from "@solana/kit";
import { facade, findClaimPda, findTaskValidationConfigPda, getDisputeBondSize, getTaskClaimDecoder,
  getTaskClaimDiscriminatorBytes, getTaskValidationConfigDecoder, getTaskValidationConfigDiscriminatorBytes,
  SubmissionStatus, TaskStatus, taskThread, values } from "@tetsuo-ai/marketplace-sdk";
import type { Chain } from "./chain.js";
import { deliveryFileProblem, deliveryFileType, MAX_DELIVERY_FILE_BYTES } from "./client/delivery-files.js";
import type { ReviewAction, ReviewAttachment, ReviewConfirmation, ReviewQuote } from "./client/reviews.js";
import { WalletError } from "./errors.js";
import { readProgramAccount, readSubmission, readTask, readTurnDownOnChain, snapshotReader } from "./market.js";
import { publishReviewBytes, type MarketServices } from "./services.js";
import { money } from "./views.js";

export function reviewNote(input: unknown): string {
  if (typeof input !== "string" || !input.trim() || input.trim().length > 2000) {
    throw new WalletError("BAD_REQUEST", "Enter a reason or instructions in up to 2,000 characters.");
  }
  return input.trim();
}

export function reviewAttachments(input: unknown, task: string): ReviewAttachment[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 8) throw new WalletError("BAD_REQUEST", "Attach up to eight files.");
  try {
    return taskThread.assertTaskThreadEnvelope({ v: 1, parentHash: null, role: "buyer", ts: 0,
      taskPda: task, body: "", attachments: input }).attachments;
  } catch {
    throw new WalletError("BAD_REQUEST", "Each file needs a public address and a SHA-256 fingerprint.");
  }
}

export async function publishReviewFiles(services: MarketServices, signer: KeyPairSigner, review: ReviewConfirmation) {
  const attachments = [...review.attachments];
  const files = review.files ?? [];
  if (!Array.isArray(files) || files.length + attachments.length > 8) throw new WalletError("BAD_REQUEST", "Attach up to eight files.");
  let total = 0;
  const checked = files.map(file => {
    if (!file || typeof file.name !== "string" || typeof file.base64 !== "string" || file.base64.length > 350_000) {
      throw new WalletError("BAD_REQUEST", "The file is invalid or too large.");
    }
    const bytes = Buffer.from(file.base64, "base64");
    const problem = deliveryFileProblem(file.name, bytes);
    if (problem || bytes.toString("base64") !== file.base64) throw new WalletError("BAD_REQUEST", problem ?? "The file is invalid.");
    total += bytes.length;
    return { name: file.name, bytes };
  });
  const names = checked.map(file => file.name);
  for (const file of attachments) {
    const url = new URL(file.uri);
    const name = url.hash.slice(1);
    if (!name || !url.pathname.endsWith("/" + file.hash)) continue;
    if (!deliveryFileType(name)) throw new WalletError("BAD_REQUEST", "That file name or type is unsupported.");
    const bytes = await services.fetchFile(file.hash);
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== file.hash || deliveryFileProblem(name, bytes)) {
      throw new WalletError("BAD_REQUEST", "The referenced input file could not be verified.");
    }
    names.push(name);
    total += bytes.length;
  }
  if (new Set(names.map(name => name.toLowerCase())).size !== names.length) throw new WalletError("BAD_REQUEST", "Choose a different name for each file.");
  if (total > MAX_DELIVERY_FILE_BYTES) throw new WalletError("BAD_REQUEST", "Choose files totaling up to 256 KB.");
  for (const file of checked) {
    if (!services.fileLinkPrefix) throw new WalletError("NOT_AVAILABLE", "File storage is unavailable.");
    const hash = await publishReviewBytes(services, signer, file.bytes);
    attachments.push({ uri: services.fileLinkPrefix + hash + "#" + encodeURIComponent(file.name), hash });
  }
  return attachments;
}

export async function quoteReview(chain: Chain, jobId: string, task: Address, provider: Address, buying: boolean, rate: number | null) {
  const [account, submission, [validation], [claim]] = await Promise.all([
    readTask(chain, task), readSubmission(chain, task, provider), findTaskValidationConfigPda({ task }), findClaimPda({ task, bidder: provider }),
  ]);
  let resubmitBy: number | null = null;
  let lastRevision: { round: number; due: number } | null = null;
  let quote: ReviewQuote | null = null;
  if (!account || !submission) return { quote, resubmitBy, lastRevision };
  const held = await readProgramAccount(chain, claim, getTaskClaimDiscriminatorBytes(), data => getTaskClaimDecoder().decode(data));
  const limits = [Number(account.deadline), Number(held?.expiresAt ?? 0)].filter(n => n > 0);
  const due = limits.length ? Math.min(...limits) : null;
  const revising = account.status === TaskStatus.InProgress && submission.account.status === SubmissionStatus.Rejected;
  const round = submission.account.submissionCount - (revising ? 0 : 1);
  // Only request_changes extends these two deadlines. Until the claim closes,
  // they still describe its latest revision after the next delivery or freeze.
  if (held && round > 0 && due !== null) {
    lastRevision = { round, due: due * 1000 };
    if (revising) resubmitBy = lastRevision.due;
  }
  const actions: ReviewAction[] = [];
  const pending = buying && held && account.status === TaskStatus.PendingValidation && submission.account.status === SubmissionStatus.Submitted;
  const now = pending ? await chain.clusterTime() : null;
  if (now !== null && now <= Number(submission.account.reviewDeadlineAt)) {
    actions.push("reject");
    if (submission.account.submissionCount < 3) actions.push("change");
  }
  if (!buying && account.status === TaskStatus.RejectFrozen) {
    const frozen = await readTurnDownOnChain(chain, task, provider);
    if (frozen?.disputeOpen && !frozen.providerSuspended) actions.push("dispute");
  }
  if (!actions.length) return { quote, resubmitBy, lastRevision };
  const [record, disputeRent, terms] = await Promise.all([
    facade.missingRecordCost(snapshotReader(chain), size => chain.getMinimumBalanceForRentExemption(size), { creator: account.creator, workerAgent: provider }),
    chain.getMinimumBalanceForRentExemption(getDisputeBondSize()),
    readProgramAccount(chain, validation, getTaskValidationConfigDiscriminatorBytes(), data => getTaskValidationConfigDecoder().decode(data)),
  ]);
  if (!terms) return { quote, resubmitBy, lastRevision };
  const bond = values.disputeBondForTask(account);
  const deliveryHash = Buffer.from(submission.account.proofHash).toString("hex");
  const reviewEndsAt = Number(submission.account.reviewDeadlineAt) * 1000;
  const reviewWindowSeconds = Number(terms.reviewWindowSecs);
  const id = createHash("sha256").update(JSON.stringify([jobId, task, provider, actions, deliveryHash, submission.account.submissionCount,
    reviewEndsAt, reviewWindowSeconds, String(held?.expiresAt), String(account.deadline), String(record.lamports), String(disputeRent), String(bond), String(chain.transferFeeLamports)])).digest("hex");
  quote = { id, actions, deliveryHash, reviewEndsAt, reviewWindowSeconds, bond: money(bond, rate), fee: money(chain.transferFeeLamports, rate),
    estimatedResubmitBy: due === null || now === null ? null : Math.max(due, now + Math.max(86400, reviewWindowSeconds)) * 1000,
    rejectionTotal: money(chain.transferFeeLamports + record.lamports, rate),
    disputeTotal: money(chain.transferFeeLamports + bond + disputeRent, rate),
    rejectionRent: money(record.lamports, rate), disputeRent: money(disputeRent, rate) };
  return { quote, resubmitBy, lastRevision };
}
