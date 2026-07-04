// Fetch + verify a task's pinned job spec BEFORE claiming.
//
// The on-chain `TaskJobSpec` pointer carries a 32-byte `jobSpecHash` and a
// `jobSpecUri`. The worker downloads the URI over http(s) ONLY and FAILS
// CLOSED unless sha256(bytes) equals the pinned hash byte-for-byte — a spec
// that doesn't match its on-chain commitment is never executed. The single
// non-fetchable exception is the `agenc://` scheme, which by convention means
// "no fetchable content — work from the task description alone"; every other
// scheme (file:, ftp:, data:, ipfs:, ...) is refused outright.
import { timingSafeEqual } from "node:crypto";
import type { Address } from "@solana/kit";
import {
  findTaskJobSpecPda,
  getTaskJobSpecDecoder,
} from "@tetsuo-ai/marketplace-sdk";
import { sha256 } from "./result.js";

/** Read raw account bytes; `null` when the account does not exist. */
export type AccountReader = (address: Address) => Promise<Uint8Array | null>;

/** Download a URI's raw bytes (injectable for tests). */
export type UriFetcher = (uri: string) => Promise<Uint8Array>;

/** Cap on downloaded job-spec size (bytes). */
export const DEFAULT_MAX_JOB_SPEC_BYTES = 5 * 1024 * 1024;

/** Thrown on any job-spec verification failure — the task is NOT claimed. */
export class JobSpecError extends Error {
  override name = "JobSpecError";
}

/** A verified job spec, ready to feed the executor prompt. */
export type VerifiedJobSpec = {
  /** The on-chain 32-byte commitment. */
  jobSpecHash: Uint8Array;
  /** The on-chain pointer URI. */
  jobSpecUri: string;
  /**
   * The downloaded spec bytes, verified against `jobSpecHash`; `null` for the
   * `agenc://` convention (no fetchable content — use the task description).
   */
  content: Uint8Array | null;
};

function defaultFetcher(maxBytes: number): UriFetcher {
  return async (uri) => {
    const response = await fetch(uri, {
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new JobSpecError(
        `job-spec download failed: ${response.status} ${response.statusText}`,
      );
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) > maxBytes) {
      throw new JobSpecError(
        `job spec exceeds the ${maxBytes}-byte cap (content-length ${declared})`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxBytes) {
      throw new JobSpecError(`job spec exceeds the ${maxBytes}-byte cap`);
    }
    return bytes;
  };
}

/**
 * Fetch the task's `TaskJobSpec` account, download its URI (http/https only),
 * and verify sha256(content) === the pinned hash. FAILS CLOSED on: missing
 * pointer account, all-zero hash, non-http(s)/non-agenc scheme, download
 * failure, or hash mismatch.
 */
export async function fetchAndVerifyJobSpec(options: {
  task: Address;
  readAccount: AccountReader;
  fetchUri?: UriFetcher;
  maxBytes?: number;
}): Promise<VerifiedJobSpec> {
  const { task, readAccount } = options;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_JOB_SPEC_BYTES;
  const [jobSpecPda] = await findTaskJobSpecPda({ task });
  const data = await readAccount(jobSpecPda);
  if (data === null) {
    throw new JobSpecError(`task ${task}: no TaskJobSpec pinned (nothing to claim)`);
  }
  const spec = getTaskJobSpecDecoder().decode(data);
  const jobSpecHash = new Uint8Array(spec.jobSpecHash);
  if (jobSpecHash.every((byte) => byte === 0)) {
    throw new JobSpecError(`task ${task}: job-spec hash is all zeros (unpinned)`);
  }

  let url: URL;
  try {
    url = new URL(spec.jobSpecUri);
  } catch {
    throw new JobSpecError(
      `task ${task}: job-spec URI is not a valid URI: ${JSON.stringify(spec.jobSpecUri)}`,
    );
  }

  if (url.protocol === "agenc:") {
    // Convention: no fetchable content — the hash commits to content delivered
    // out of band (or to the task description itself). Execute from the task
    // description alone.
    return { jobSpecHash, jobSpecUri: spec.jobSpecUri, content: null };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new JobSpecError(
      `task ${task}: refusing job-spec URI scheme ${url.protocol}// — only http(s) is fetched (agenc:// = no content)`,
    );
  }

  const fetchUri = options.fetchUri ?? defaultFetcher(maxBytes);
  let content: Uint8Array;
  try {
    content = await fetchUri(spec.jobSpecUri);
  } catch (error) {
    if (error instanceof JobSpecError) throw error;
    throw new JobSpecError(
      `task ${task}: job-spec download failed: ${(error as Error).message}`,
    );
  }
  if (content.length > maxBytes) {
    throw new JobSpecError(`task ${task}: job spec exceeds the ${maxBytes}-byte cap`);
  }

  const digest = sha256(content);
  const matches =
    digest.length === jobSpecHash.length &&
    timingSafeEqual(digest, jobSpecHash);
  if (!matches) {
    // FAIL CLOSED: content that does not match its on-chain commitment is
    // never executed.
    throw new JobSpecError(
      `task ${task}: job-spec hash mismatch — downloaded content does not match ` +
        `the on-chain commitment (expected ${Buffer.from(jobSpecHash).toString("hex")}, ` +
        `got ${Buffer.from(digest).toString("hex")})`,
    );
  }
  return { jobSpecHash, jobSpecUri: spec.jobSpecUri, content };
}
