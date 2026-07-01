import type {
  TaskModerationInput,
  TaskModerationResult,
} from "./activate-job-spec.js";

export interface RemoteTaskModerationAttestorConfig {
  endpoint: string;
  bearerToken?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface RemoteModerationBody {
  ok?: boolean;
  attested?: boolean;
  moderation?: unknown;
  txSignature?: string | null;
  error?: string | { message?: string; reason?: string };
}

function errorMessage(body: RemoteModerationBody | null, fallback: string): string {
  if (!body?.error) return fallback;
  if (typeof body.error === "string") return body.error;
  return body.error.reason ?? body.error.message ?? fallback;
}

export function createRemoteTaskModerationAttestor({
  endpoint,
  bearerToken,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
}: RemoteTaskModerationAttestorConfig): (
  input: TaskModerationInput,
) => Promise<TaskModerationResult> {
  const url = endpoint.trim();
  if (!url) {
    throw new Error("createRemoteTaskModerationAttestor: endpoint is required.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("createRemoteTaskModerationAttestor: timeoutMs must be positive.");
  }

  return async function attestTaskModeration(
    input,
  ): Promise<TaskModerationResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
        },
        signal: controller.signal,
        body: JSON.stringify({
          taskPda: input.taskPda,
          jobSpecHash: input.jobSpecHashHex,
          jobSpecUri: input.jobSpecUri,
          jobSpec: input.payload,
          jobSpecCanonicalJson: input.canonicalJson,
        }),
      });
    } catch (cause) {
      if (controller.signal.aborted) {
        throw new Error("Task moderation endpoint timed out.");
      }
      throw cause;
    } finally {
      clearTimeout(timeout);
    }

    const body = (await response.json().catch(() => null)) as
      | RemoteModerationBody
      | null;
    if (!response.ok) {
      throw new Error(
        errorMessage(body, `Task moderation endpoint failed (${response.status}).`),
      );
    }

    return {
      attested: body?.attested === true,
      moderation: body?.moderation ?? null,
      txSignature: body?.txSignature ?? null,
    };
  };
}
