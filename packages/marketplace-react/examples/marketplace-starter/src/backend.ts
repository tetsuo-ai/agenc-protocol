import type { Address } from "@solana/kit";
import { values } from "@tetsuo-ai/marketplace-sdk";

export interface StarterJobSpec {
  title: string;
  deliverables: string[];
  acceptanceCriteria: string[];
  notes?: string;
}

export interface HostedModeratedJobSpec {
  jobSpecHash: Uint8Array;
  jobSpecHashHex: string;
  jobSpecUri: string;
  moderationAttested: boolean;
}

export interface HostAndModerateJobSpecInput {
  taskPda: Address | string;
  spec: StarterJobSpec;
}

export interface MarketplaceBackendAdapter {
  /**
   * Host the job spec and record task moderation for `(taskPda, jobSpecHash)`
   * before the browser signs `set_task_job_spec`.
   */
  hostAndModerateJobSpec(
    input: HostAndModerateJobSpecInput,
  ): Promise<HostedModeratedJobSpec>;
}

export class BackendAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendAdapterError";
  }
}

function parseHex32(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new BackendAdapterError("Backend returned an invalid 32-byte jobSpecHashHex.");
  }
  return values.hexToBytes(hex.toLowerCase());
}

/**
 * Adapter for a self-hosted backend route. This starter deliberately does not
 * call agenc.ag same-origin write routes as a hosted write API. Deploy your own
 * route with this contract, or replace this adapter with your platform backend.
 */
export function createHttpBackendAdapter(baseUrl: string): MarketplaceBackendAdapter {
  const root = baseUrl.replace(/\/+$/, "");
  if (!root) {
    return {
      async hostAndModerateJobSpec(): Promise<HostedModeratedJobSpec> {
        throw new BackendAdapterError(
          "Set VITE_AGENC_BACKEND_URL to your self-hosted moderation/upload backend.",
        );
      },
    };
  }

  return {
    async hostAndModerateJobSpec(input): Promise<HostedModeratedJobSpec> {
      const response = await fetch(`${root}/api/agenc/job-specs/activate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskPda: String(input.taskPda),
          spec: input.spec,
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | {
            jobSpecHashHex?: string;
            jobSpecUri?: string;
            moderationAttested?: boolean;
            error?: string;
          }
        | null;
      if (!response.ok || !body) {
        throw new BackendAdapterError(
          body?.error ?? `Backend activation request failed (${response.status}).`,
        );
      }
      if (!body.jobSpecHashHex || !body.jobSpecUri) {
        throw new BackendAdapterError("Backend response is missing job spec hash or URI.");
      }
      return {
        jobSpecHashHex: body.jobSpecHashHex.toLowerCase(),
        jobSpecHash: parseHex32(body.jobSpecHashHex),
        jobSpecUri: body.jobSpecUri,
        moderationAttested: body.moderationAttested === true,
      };
    },
  };
}
