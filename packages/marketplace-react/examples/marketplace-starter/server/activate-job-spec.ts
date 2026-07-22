import { values } from "@tetsuo-ai/marketplace-sdk";
import { isAddress } from "@solana/kit";
import {
  normalizeStarterJobSpec,
  type StarterJobSpec,
  type StarterJobSpecPayload,
} from "../src/job-spec.js";

const DEFAULT_MAX_CANONICAL_BYTES = 64 * 1024;
const DEFAULT_MAX_REQUEST_BYTES = 128 * 1024;
const TASK_JOB_SPEC_URI_MAX_BYTES = 256;

export type StarterJobSpecInput = StarterJobSpec;
export type { StarterJobSpecPayload } from "../src/job-spec.js";

export interface StarterJobSpecEnvelope {
  integrity: {
    algorithm: "sha256";
    canonicalization: "json-stable-v1";
    payloadHash: string;
  };
  payload: StarterJobSpecPayload;
}

export interface StoredJobSpec {
  uri: string;
}

export interface StoreJobSpecInput {
  taskPda: string;
  jobSpecHashHex: string;
  envelope: StarterJobSpecEnvelope;
}

export interface TaskModerationInput {
  taskPda: string;
  jobSpecHashHex: string;
  payload: StarterJobSpecPayload;
  canonicalJson: string;
  jobSpecUri: string;
}

export interface TaskModerationResult {
  attested: boolean;
  moderation?: unknown;
  txSignature?: string | null;
}

export interface ActivateJobSpecRouteDeps {
  storeJobSpec: (input: StoreJobSpecInput) => Promise<StoredJobSpec>;
  attestTaskModeration: (
    input: TaskModerationInput,
  ) => Promise<TaskModerationResult>;
  maxRequestBytes?: number;
  maxCanonicalBytes?: number;
}

export interface ActivateJobSpecResponse {
  jobSpecHashHex: string;
  jobSpecUri: string;
  moderationAttested: boolean;
  moderation?: unknown;
  txSignature?: string | null;
}

interface ErrorResponse {
  error: string;
  moderation?: unknown;
}

class InvalidJsonError extends Error {}

class RequestBodyTooLargeError extends Error {}

async function readJsonBody(
  request: Request,
  maxRequestBytes: number,
): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength) {
    const bytes = Number(declaredLength);
    if (Number.isFinite(bytes) && bytes > maxRequestBytes) {
      throw new RequestBodyTooLargeError("Request body is too large.");
    }
  }

  const text = await readRequestText(request, maxRequestBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidJsonError("Request body must be valid JSON.");
  }
}

async function readRequestText(
  request: Request,
  maxRequestBytes: number,
): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > maxRequestBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyTooLargeError("Request body is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

function jsonResponse(
  body: ActivateJobSpecResponse | ErrorResponse,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function validateStoredJobSpecUri(value: string): string {
  if (
    new TextEncoder().encode(value).byteLength > TASK_JOB_SPEC_URI_MAX_BYTES
  ) {
    throw new Error("Stored job-spec URI is too long.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Stored job-spec URI must be an absolute public URL.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("Stored job-spec URI must be credential-free HTTP(S).");
  }
  return value;
}

function requestParts(body: unknown): { taskPda: string; spec: unknown } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Request body must be a JSON object.");
  }
  const record = body as Record<string, unknown>;
  const taskPda =
    typeof record.taskPda === "string" ? record.taskPda.trim() : "";
  if (!isAddress(taskPda)) {
    throw new Error("taskPda must be an exact 32-byte Solana address.");
  }
  return { taskPda, spec: record.spec };
}

export function createActivateJobSpecHandler({
  storeJobSpec,
  attestTaskModeration,
  maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
  maxCanonicalBytes = DEFAULT_MAX_CANONICAL_BYTES,
}: ActivateJobSpecRouteDeps): (request: Request) => Promise<Response> {
  return async function activateJobSpec(request: Request): Promise<Response> {
    if (request.method && request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed." }, 405);
    }

    let body: unknown;
    try {
      body = await readJsonBody(request, maxRequestBytes);
    } catch (cause) {
      if (cause instanceof RequestBodyTooLargeError) {
        return jsonResponse({ error: cause.message }, 413);
      }
      return jsonResponse({ error: "Request body must be valid JSON." }, 400);
    }

    let taskPda: string;
    let payload: StarterJobSpecPayload;
    let canonicalJson: string;
    let jobSpecHashHex: string;
    let envelope: StarterJobSpecEnvelope;
    try {
      const parts = requestParts(body);
      taskPda = parts.taskPda;
      payload = normalizeStarterJobSpec(taskPda, parts.spec);
      canonicalJson = values.canonicalJobSpecJson(payload);
      jobSpecHashHex = (await values.canonicalJobSpecHash(payload)).hex;
      envelope = {
        integrity: {
          algorithm: "sha256",
          canonicalization: "json-stable-v1",
          payloadHash: jobSpecHashHex,
        },
        payload,
      };
      // The worker's fetch limit applies to the complete hosted document, not
      // just its payload. Include integrity-envelope overhead in the route cap.
      const canonicalEnvelopeJson = values.canonicalJobSpecJson(envelope);
      if (
        new TextEncoder().encode(canonicalEnvelopeJson).byteLength >
        maxCanonicalBytes
      ) {
        return jsonResponse({ error: "Canonical job spec is too large." }, 413);
      }
    } catch {
      // Validation helpers can throw values supplied by dependencies. Never
      // reflect an arbitrary exception (or its stack-bearing message) across
      // this public HTTP boundary.
      return jsonResponse({ error: "Task PDA or job spec is invalid." }, 400);
    }

    let stored: StoredJobSpec;
    try {
      stored = await storeJobSpec({
        taskPda,
        jobSpecHashHex,
        envelope,
      });
    } catch {
      return jsonResponse({ error: "Job-spec storage failed." }, 502);
    }

    let storedUri: unknown;
    try {
      // Treat dependency output as caller-owned. Snapshot its accessor exactly
      // once and never mutate or re-read it across the moderation await.
      storedUri = stored.uri;
    } catch {
      return jsonResponse(
        { error: "Job-spec storage returned an invalid URI." },
        502,
      );
    }
    if (storedUri === "" || storedUri === null || storedUri === undefined) {
      return jsonResponse({ error: "Job-spec storage returned no URI." }, 502);
    }
    let jobSpecUri: string;
    try {
      if (typeof storedUri !== "string") {
        throw new TypeError("Stored job-spec URI must be a string.");
      }
      jobSpecUri = validateStoredJobSpecUri(storedUri);
    } catch {
      return jsonResponse(
        { error: "Job-spec storage returned an invalid URI." },
        502,
      );
    }

    let moderation: TaskModerationResult;
    try {
      moderation = await attestTaskModeration({
        taskPda,
        jobSpecHashHex,
        payload,
        canonicalJson,
        jobSpecUri,
      });
    } catch {
      return jsonResponse(
        { error: "Task moderation attestation failed." },
        502,
      );
    }

    if (moderation.attested !== true) {
      return jsonResponse(
        {
          error: "Task moderation did not attest this job spec.",
          moderation: moderation.moderation ?? null,
        },
        422,
      );
    }

    return jsonResponse({
      jobSpecHashHex,
      jobSpecUri,
      moderationAttested: moderation.attested === true,
      moderation: moderation.moderation ?? null,
      txSignature: moderation.txSignature ?? null,
    });
  };
}
