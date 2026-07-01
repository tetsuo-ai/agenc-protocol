import { createActivateJobSpecHandler } from "./activate-job-spec.js";
import { createFileJobSpecStore } from "./file-store.js";
import { createRemoteTaskModerationAttestor } from "./remote-attestor.js";
import { assertStarterBackendEnv } from "./setup-check.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Copy this file and its relative `server/` helper imports into a Next.js host
 * app route at `app/api/agenc/job-specs/activate/route.ts`, then set the
 * environment variables checked by `setup-check.ts`.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const setup = assertStarterBackendEnv(process.env);
    const handler = createActivateJobSpecHandler({
      storeJobSpec: createFileJobSpecStore({
        directory: setup.jobSpecDir,
        publicBaseUrl: setup.jobSpecPublicBaseUrl,
      }),
      attestTaskModeration: createRemoteTaskModerationAttestor({
        endpoint: setup.taskModerationAttestUrl,
        bearerToken: setup.taskModerationAttestToken,
      }),
    });
    return await handler(request);
  } catch {
    return new Response(
      JSON.stringify({
        error: "Starter activation backend is not configured.",
      }),
      {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }
}
