import { createFileJobSpecGetHandler } from "./file-store.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Copy this file and its relative `server/` helper import into a Next.js host
 * route at `app/job-specs/[hash]/route.ts`. Configure
 * `AGENC_JOB_SPEC_PUBLIC_BASE_URL=https://your-host.example/job-specs` so every
 * URI returned by the activation route resolves to this public GET handler.
 */
export async function GET(request: Request): Promise<Response> {
  const directory = process.env.AGENC_JOB_SPEC_DIR?.trim();
  if (!directory) {
    return Response.json(
      { error: "Public job-spec hosting is not configured." },
      { status: 500 },
    );
  }
  return createFileJobSpecGetHandler({ directory })(request);
}
