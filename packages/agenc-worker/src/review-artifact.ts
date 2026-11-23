import { taskThread } from "@tetsuo-ai/marketplace-sdk";
import { createHash } from "node:crypto";

export class ReviewArtifactUnavailable extends Error {}

async function readPublished(read: (hash: string) => Promise<Uint8Array | null>, hash: string) {
  const bytes = await read(hash).catch(() => null);
  if (!bytes) throw new ReviewArtifactUnavailable("The published review file is unavailable.");
  return bytes;
}

/** A content address comes from the chain. Never follow a URL supplied by a message. */
export async function readReviewEnvelope(
  read: (hash: string) => Promise<Uint8Array | null>,
  task: string,
  hash: string,
  role: taskThread.TaskThreadRole,
): Promise<taskThread.TaskThreadEnvelope> {
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error("Invalid review fingerprint.");
  const bytes = await readPublished(read, hash);
  if (bytes.length > 256 * 1024 || createHash("sha256").update(bytes).digest("hex") !== hash) {
    throw new Error("The published review could not be verified.");
  }
  const envelope = taskThread.assertTaskThreadEnvelope(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  if (envelope.taskPda !== task || envelope.role !== role || (await taskThread.envelopeHash(envelope)).hex !== hash) {
    throw new Error("The published review does not match this job and author.");
  }
  return envelope;
}

export interface ReviewInputFile { name: string; bytes: Uint8Array }

export async function readReviewInputs(
  envelope: taskThread.TaskThreadEnvelope,
  read: (hash: string) => Promise<Uint8Array | null>,
  fileProblem: (name: string, bytes: Uint8Array) => string | null,
): Promise<ReviewInputFile[]> {
  const files: ReviewInputFile[] = [];
  let total = 0;
  for (const attachment of envelope.attachments) {
    const uri = new URL(attachment.uri);
    if (!uri.pathname.endsWith("/" + attachment.hash)) continue;
    const name = uri.hash.slice(1);
    // A plain URI is a reference. Named copies in the artifact store are input files.
    if (!name) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name) || name.includes("..") ||
        files.length >= 8 || files.some(file => file.name.toLowerCase() === name.toLowerCase())) {
      throw new Error("The review has invalid or duplicate input names.");
    }
    const bytes = await readPublished(read, attachment.hash);
    if (!bytes?.length || createHash("sha256").update(bytes).digest("hex") !== attachment.hash) {
      throw new Error("A revision input could not be verified.");
    }
    const problem = fileProblem(name, bytes);
    if (problem) throw new Error("Invalid revision input: " + problem);
    total += bytes.length;
    if (total > 256 * 1024) throw new Error("The revision inputs exceed 256 KB.");
    files.push({ name, bytes });
  }
  return files;
}
