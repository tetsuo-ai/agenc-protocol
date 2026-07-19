// File contents `agenc init` writes. Every file opens with a clear
// "written by agenc init" marker; init refuses to overwrite differing
// content without --force, so these are safe to hand-edit afterward.
import type { AgencConfig } from "./config.js";

const MARKER = "Written by `agenc init` (@tetsuo-ai/agenc-cli).";

/**
 * Dependency pins written into a scaffolded package.json. Keep them inside
 * the agenc-protocol docs/VERSIONING.md §1.1 support matrix (the same truth
 * `agenc promote` checks against).
 */
export const SDK_DEP_RANGE = "^0.12.0";
export const WORKER_DEP_RANGE = "^0.2.0";
export const KIT_DEP_RANGE = "^6.9.0";

/** Make a directory/config name a valid npm package name. */
export function npmPackageName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-._~]+/gu, "-")
    .replace(/^[-._]+/u, "")
    .replace(/-+$/u, "")
    .slice(0, 214);
  return cleaned === "" ? "agenc-project" : cleaned;
}

/**
 * Make a config name safe to embed in a generated-source COMMENT (audit F-19):
 * a poisoned package.json name carrying newlines/backticks/`${` could otherwise
 * break out of the comment and inject code into the scaffolded file. Collapse to
 * a single line of conservative characters.
 */
export function commentSafeName(name: string): string {
  const cleaned = name
    .replace(/[^\w .@:+-]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80);
  return cleaned === "" ? "agenc-project" : cleaned;
}

/** Encode an arbitrary config value as a generated JavaScript string literal. */
export function sourceStringLiteral(value: string): string {
  return JSON.stringify(value);
}

/**
 * Shared, server-only content-addressed job-spec store used by both Next.js
 * checkout variants. The generated checkout must publish a canonical envelope
 * at an ordinary HTTPS URI so the stock worker can retrieve and verify it.
 */
export function jobSpecStoreModule(): string {
  return `// ${MARKER}
// Safe to edit; re-run \`agenc init --force\` to regenerate.
//
// Server-only immutable job-spec storage. AGENC_JOB_SPEC_DIR must be durable and
// shared by every app instance. AGENC_JOB_SPEC_PUBLIC_BASE_URL must be the public
// HTTPS URL of the generated GET route (without a query string or trailing slash).
import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { values } from "@tetsuo-ai/marketplace-sdk";

const HASH_HEX_RE = /^[0-9a-f]{64}$/iu;
const MAX_JOB_SPEC_BYTES = 64 * 1024;
const MAX_JOB_SPEC_URI_BYTES = 256;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(\`\${name} is required for durable job-spec hosting\`);
  }
  return value;
}

function jobSpecDirectory(): string {
  return path.resolve(requiredEnv("AGENC_JOB_SPEC_DIR"));
}

function publicBaseUrl(): string {
  const raw = requiredEnv("AGENC_JOB_SPEC_PUBLIC_BASE_URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("AGENC_JOB_SPEC_PUBLIC_BASE_URL must be an absolute HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    raw.includes("?") ||
    raw.includes("#") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "AGENC_JOB_SPEC_PUBLIC_BASE_URL must be credential-free HTTPS with no query or fragment",
    );
  }
  return url.toString().replace(/\\/+$/u, "");
}

async function syncDirectory(directory: string): Promise<void> {
  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

export interface StoredJobSpec {
  jobSpecHash: Uint8Array;
  jobSpecUri: string;
}

export async function storeJobSpec(
  payload: Record<string, unknown>,
): Promise<StoredJobSpec> {
  const digest = await values.canonicalJobSpecHash(payload);
  // Build the envelope from the same canonical payload bytes that were hashed.
  // This guarantees one immutable file representation per content address even
  // when callers construct equivalent objects with different key insertion order.
  const canonicalPayload = values.canonicalJobSpecJson(payload);
  const envelope =
    \`{"integrity":{"algorithm":"sha256","canonicalization":"json-stable-v1","payloadHash":"\${digest.hex}"},"payload":\${canonicalPayload}}\\n\`;
  if (new TextEncoder().encode(envelope).byteLength > MAX_JOB_SPEC_BYTES) {
    throw new Error(\`job spec exceeds \${MAX_JOB_SPEC_BYTES} bytes\`);
  }

  const jobSpecUri = \`\${publicBaseUrl()}?hash=\${digest.hex}\`;
  if (new TextEncoder().encode(jobSpecUri).byteLength > MAX_JOB_SPEC_URI_BYTES) {
    throw new Error(\`job-spec URI exceeds \${MAX_JOB_SPEC_URI_BYTES} bytes\`);
  }

  const directory = jobSpecDirectory();
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, \`\${digest.hex}.json\`);
  const tempFile = path.join(
    directory,
    \`.\${digest.hex}.json.\${process.pid}.\${randomUUID()}.tmp\`,
  );
  let tempCreated = false;
  try {
    // Never expose the final path until every byte is written and fsynced.
    // The hard-link publish is atomic and fails instead of overwriting a
    // concurrent immutable winner.
    const handle = await open(tempFile, "wx", 0o600);
    tempCreated = true;
    try {
      await handle.writeFile(envelope, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(tempFile, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(file, "utf8");
      if (existing !== envelope) {
        throw new Error(\`stored job spec \${digest.hex} does not match its content address\`);
      }
    }
    // Persist both the final hard-link and removal of the private temporary
    // name before reporting a successful (or idempotently verified) publish.
    await unlink(tempFile);
    tempCreated = false;
    await syncDirectory(directory);
  } finally {
    if (tempCreated) {
      try {
        await unlink(tempFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return { jobSpecHash: digest.bytes, jobSpecUri };
}

export async function readJobSpec(hash: string): Promise<string> {
  if (!HASH_HEX_RE.test(hash)) {
    throw new TypeError("job-spec hash must be 64 hexadecimal characters");
  }
  return readFile(path.join(jobSpecDirectory(), \`\${hash.toLowerCase()}.json\`), "utf8");
}
`;
}

/** App Router GET endpoint serving immutable content-addressed envelopes. */
export function appJobSpecRoute(): string {
  return `// ${MARKER}
// Public GET /agenc/job-specs?hash=<64 lowercase hex>.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { readJobSpec } from "../job-spec-store";

export async function GET(request: Request): Promise<Response> {
  const hash = new URL(request.url).searchParams.get("hash") ?? "";
  try {
    const envelope = await readJobSpec(hash);
    return new Response(envelope, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    const status = error instanceof TypeError
      ? 400
      : (error as NodeJS.ErrnoException).code === "ENOENT"
        ? 404
        : 500;
    return Response.json(
      { error: status === 400 ? "invalid job-spec hash" : status === 404 ? "job spec not found" : "job-spec storage unavailable" },
      { status },
    );
  }
}
`;
}

/** Pages Router GET endpoint serving immutable content-addressed envelopes. */
export function pagesJobSpecApi(): string {
  return `// ${MARKER}
// Public GET /api/agenc/job-specs?hash=<64 lowercase hex>.
import type { NextApiRequest, NextApiResponse } from "next";
import { readJobSpec } from "./job-spec-store";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const rawHash = Array.isArray(req.query.hash) ? req.query.hash[0] : req.query.hash;
  try {
    const envelope = await readJobSpec(rawHash ?? "");
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "public, max-age=31536000, immutable");
    res.setHeader("x-content-type-options", "nosniff");
    return res.status(200).send(envelope);
  } catch (error) {
    const status = error instanceof TypeError
      ? 400
      : (error as NodeJS.ErrnoException).code === "ENOENT"
        ? 404
        : 500;
    return res.status(status).json({
      error: status === 400 ? "invalid job-spec hash" : status === 404 ? "job spec not found" : "job-spec storage unavailable",
    });
  }
}
`;
}

/**
 * package.json scaffolded when the project has none — so `npm install` puts
 * node_modules HERE instead of hoisting into an ancestor project (where
 * `agenc promote` and the templates would never find the sdk), with the
 * AgenC deps pre-pinned inside the support matrix.
 */
export function scaffoldPackageJson(config: AgencConfig): string {
  const dependencies: Record<string, string> = {
    "@solana/kit": KIT_DEP_RANGE,
    "@tetsuo-ai/marketplace-sdk": SDK_DEP_RANGE,
  };
  if (config.kind === "worker") {
    dependencies["@tetsuo-ai/agenc-worker"] = WORKER_DEP_RANGE;
  }
  return `${JSON.stringify(
    {
      name: npmPackageName(config.name),
      private: true,
      version: "0.1.0",
      type: "module",
      dependencies,
    },
    null,
    2,
  )}\n`;
}

/**
 * Next.js App Router checkout page — GET /agenc. Server component, zero
 * client JS: shows the service and posts to the checkout route handler.
 */
export function appCheckoutPage(config: AgencConfig): string {
  return `// ${MARKER}
// Safe to edit; re-run \`agenc init --force\` to regenerate.
//
// GET /agenc — the minimal AgenC checkout surface for "${commentSafeName(config.name)}".
// The form posts to /agenc/checkout (see ./checkout/route.ts), which runs
// the plain-SDK \`hireAndActivate\` orchestration.
import { readFile } from "node:fs/promises";
import path from "node:path";

async function loadAgencConfig(): Promise<{ name: string; listing: { priceLamports: string } }> {
  const raw = await readFile(path.join(process.cwd(), "agenc.config.json"), "utf8");
  return JSON.parse(raw);
}

export default async function AgencCheckoutPage() {
  const config = await loadAgencConfig();
  const sol = Number(config.listing.priceLamports) / 1e9;
  return (
    <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "system-ui" }}>
      <h1>{config.name}</h1>
      <p>
        Hire this service through the AgenC marketplace — {sol} SOL, settled
        on-chain with an escrowed 4-way split.
      </p>
      <form action="/agenc/checkout" method="post">
        <label style={{ display: "block", marginBottom: 8 }}>
          What do you need done?
          <textarea name="instructions" rows={4} style={{ width: "100%" }} required />
        </label>
        <label style={{ display: "block", marginBottom: 8 }}>
          Checkout secret
          <input
            type="password"
            name="checkoutSecret"
            autoComplete="current-password"
            style={{ width: "100%" }}
            required
          />
        </label>
        <button type="submit">Hire for {sol} SOL</button>
      </form>
    </main>
  );
}
`;
}

/**
 * Next.js App Router route handler — POST /agenc/checkout. Runs the plain
 * @tetsuo-ai/marketplace-sdk \`hireAndActivate\` orchestration (no
 * marketplace-react required) against the env-configured listing.
 */
export function appCheckoutRoute(config: AgencConfig): string {
  return `// ${MARKER}
// Safe to edit; re-run \`agenc init --force\` to regenerate.
//
// POST /agenc/checkout — hires this project's AgenC listing with the plain
// SDK (\`hireAndActivate\`; no marketplace-react needed).
//
// Required environment (see \`agenc promote\` for the go-live checklist):
//   AGENC_RPC_URL       Solana RPC endpoint
//   AGENC_WALLET        path to the buyer keypair JSON (server-side signer)
//   AGENC_LISTING       ServiceListing PDA to hire
//   AGENC_LISTING_SPEC_HASH  the listing's pinned spec hash (64-char hex)
//   AGENC_MODERATOR     moderation authority whose attestations the hire consumes
//   AGENC_ATTESTOR_URL  attestation service that records TaskModeration
//                       (e.g. the localnet auto-attestor, or attest.agenc.ag)
//   AGENC_JOB_SPEC_DIR  durable shared directory for canonical job-spec envelopes
//   AGENC_JOB_SPEC_PUBLIC_BASE_URL  public HTTPS URL of /agenc/job-specs
//   AGENC_CHECKOUT_SECRET  REQUIRED shared secret; the generated form sends it
//                       as checkoutSecret in the POST body, while API callers may
//                       use x-agenc-checkout-secret. Without it this route is
//                       disabled (503) — it funds a REAL on-chain hire per request.
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { createKeyPairSignerFromBytes, type Address } from "@solana/kit";
import {
  createMarketplaceClient,
  findTaskModerationPda,
  hireAndActivate,
  values,
} from "@tetsuo-ai/marketplace-sdk";
import { requestSandboxAttestation } from "@tetsuo-ai/marketplace-sdk/sandbox";
import { storeJobSpec } from "../job-spec-store";

// ${commentSafeName(config.name)}: listing terms captured by \`agenc init\` (agenc.config.json).
const EXPECTED_PRICE_LAMPORTS = BigInt(${sourceStringLiteral(config.listing.priceLamports)});

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(\`\${name} is not set — see the header of app/agenc/checkout/route.ts\`);
  }
  return value;
}

// SECURITY (agenc init hardening): this route makes the server wallet (AGENC_WALLET)
// fund a REAL on-chain hire — it SPENDS SOL on every accepted request. It ships
// FAIL-CLOSED: every request is refused unless AGENC_CHECKOUT_SECRET is set AND the
// caller presents it in the POST body or x-agenc-checkout-secret header. Replace
// this shared-secret gate with your app's real auth/session/entitlement check
// before going live.
function checkCheckoutAuth(request: Request, form: FormData): Response | null {
  const secret = process.env.AGENC_CHECKOUT_SECRET?.trim();
  if (secret === undefined || secret === "") {
    return Response.json(
      { error: "checkout disabled: set AGENC_CHECKOUT_SECRET" },
      { status: 503 },
    );
  }
  const headerSecret = request.headers.get("x-agenc-checkout-secret");
  const presentedValue =
    headerSecret !== null && headerSecret !== ""
      ? headerSecret
      : String(form.get("checkoutSecret") ?? "");
  const presented = Buffer.from(presentedValue);
  const expected = Buffer.from(secret);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const denied = checkCheckoutAuth(request, form);
  if (denied !== null) return denied;

  const instructions = String(form.get("instructions") ?? "").trim();
  if (instructions === "") {
    return Response.json({ error: "instructions are required" }, { status: 400 });
  }

  let env: Record<string, string>;
  try {
    env = {
      rpcUrl: requiredEnv("AGENC_RPC_URL"),
      wallet: requiredEnv("AGENC_WALLET"),
      listing: requiredEnv("AGENC_LISTING"),
      listingSpecHash: requiredEnv("AGENC_LISTING_SPEC_HASH"),
      moderator: requiredEnv("AGENC_MODERATOR"),
      attestorUrl: requiredEnv("AGENC_ATTESTOR_URL"),
    };
  } catch (error) {
    // Not wired yet — honest 501 with the missing piece, nothing signed.
    return Response.json({ error: (error as Error).message }, { status: 501 });
  }

  const signerBytes = JSON.parse(await readFile(env.wallet, "utf8")) as number[];
  const signer = await createKeyPairSignerFromBytes(Uint8Array.from(signerBytes));
  const client = createMarketplaceClient({ rpcUrl: env.rpcUrl, signer });

  const jobSpec = { instructions };
  let storedJobSpec: Awaited<ReturnType<typeof storeJobSpec>>;
  try {
    // Host first, before hireAndActivate signs anything. A storage/configuration
    // failure must not leave a funded but unclaimable Task behind.
    storedJobSpec = await storeJobSpec(jobSpec);
  } catch {
    return Response.json(
      { error: "job-spec hosting unavailable: check AGENC_JOB_SPEC_DIR and AGENC_JOB_SPEC_PUBLIC_BASE_URL" },
      { status: 503 },
    );
  }
  const moderator = env.moderator as Address;

  const result = await hireAndActivate(client, {
    hire: {
      listing: env.listing as Address,
      taskId: values.randomId32(),
      expectedPrice: EXPECTED_PRICE_LAMPORTS,
      expectedVersion: 1n,
      reviewWindowSecs: 3600n,
      listingSpecHash: values.hexToBytes(env.listingSpecHash),
      moderator,
    },
    jobSpec,
    hostAndModerateJobSpec: async (host) => {
      await requestSandboxAttestation({
        kind: "task",
        address: host.taskPda,
        specHash: storedJobSpec.jobSpecHash,
        endpoint: env.attestorUrl,
      });
      const [taskModeration] = await findTaskModerationPda({
        task: host.taskPda,
        jobSpecHash: storedJobSpec.jobSpecHash,
        moderator,
      });
      // The attestor broadcast the TaskModeration record; surface its PDA so
      // callers can verify before relying on the activation.
      void taskModeration;
      return { ...storedJobSpec, moderationAttested: true, moderator };
    },
    rpcUrl: env.rpcUrl,
  });

  return Response.json({
    task: result.taskPda,
    hireSignature: result.hireSignature,
    activationSignature: result.activationSignature,
  });
}
`;
}

/** Pages Router fallback: /pages/agenc.tsx (form posting to the API route). */
export function pagesCheckoutPage(config: AgencConfig): string {
  return `// ${MARKER}
// Safe to edit; re-run \`agenc init --force\` to regenerate.
//
// /agenc — pages-router fallback of the AgenC checkout surface for
// "${commentSafeName(config.name)}". Posts to /api/agenc/checkout.
export default function AgencCheckoutPage() {
  return (
    <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "system-ui" }}>
      <h1>{${sourceStringLiteral(config.name)}}</h1>
      <p>Hire this service through the AgenC marketplace.</p>
      <form action="/api/agenc/checkout" method="post">
        <label style={{ display: "block", marginBottom: 8 }}>
          What do you need done?
          <textarea name="instructions" rows={4} style={{ width: "100%" }} required />
        </label>
        <label style={{ display: "block", marginBottom: 8 }}>
          Checkout secret
          <input
            type="password"
            name="checkoutSecret"
            autoComplete="current-password"
            style={{ width: "100%" }}
            required
          />
        </label>
        <button type="submit">Hire</button>
      </form>
    </main>
  );
}
`;
}

/** Pages Router fallback API route: delegates to the same plain-SDK flow. */
export function pagesCheckoutApi(config: AgencConfig): string {
  return `// ${MARKER}
// Safe to edit; re-run \`agenc init --force\` to regenerate.
//
// POST /api/agenc/checkout — pages-router fallback. Same plain-SDK
// \`hireAndActivate\` flow as the app-router template; see the env contract
// in the header comment there (AGENC_RPC_URL, AGENC_WALLET, AGENC_LISTING,
// AGENC_LISTING_SPEC_HASH, AGENC_MODERATOR, AGENC_ATTESTOR_URL,
// AGENC_JOB_SPEC_DIR, AGENC_JOB_SPEC_PUBLIC_BASE_URL).
// SECURITY: this route spends the server wallet's SOL on every accepted request.
// It ships FAIL-CLOSED: set AGENC_CHECKOUT_SECRET and submit it through the
// generated checkoutSecret field, or use x-agenc-checkout-secret for API calls.
import type { NextApiRequest, NextApiResponse } from "next";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { createKeyPairSignerFromBytes, type Address } from "@solana/kit";
import {
  createMarketplaceClient,
  hireAndActivate,
  values,
} from "@tetsuo-ai/marketplace-sdk";
import { requestSandboxAttestation } from "@tetsuo-ai/marketplace-sdk/sandbox";
import { storeJobSpec } from "./job-spec-store";

const EXPECTED_PRICE_LAMPORTS = BigInt(${sourceStringLiteral(config.listing.priceLamports)});

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") throw new Error(\`\${name} is not set\`);
  return value;
}

function checkCheckoutAuth(req: NextApiRequest, res: NextApiResponse): boolean {
  const secret = process.env.AGENC_CHECKOUT_SECRET?.trim();
  if (secret === undefined || secret === "") {
    res.status(503).json({
      error: "checkout disabled: set AGENC_CHECKOUT_SECRET",
    });
    return false;
  }
  const headerValue = req.headers["x-agenc-checkout-secret"];
  const headerSecret = typeof headerValue === "string" ? headerValue : "";
  const formSecret =
    typeof req.body?.checkoutSecret === "string" ? req.body.checkoutSecret : "";
  const presented = Buffer.from(headerSecret || formSecret);
  const expected = Buffer.from(secret);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!checkCheckoutAuth(req, res)) return;
  const instructions = String(req.body?.instructions ?? "").trim();
  if (instructions === "") return res.status(400).json({ error: "instructions are required" });

  let env: Record<string, string>;
  try {
    env = {
      rpcUrl: requiredEnv("AGENC_RPC_URL"),
      wallet: requiredEnv("AGENC_WALLET"),
      listing: requiredEnv("AGENC_LISTING"),
      listingSpecHash: requiredEnv("AGENC_LISTING_SPEC_HASH"),
      moderator: requiredEnv("AGENC_MODERATOR"),
      attestorUrl: requiredEnv("AGENC_ATTESTOR_URL"),
    };
  } catch (error) {
    return res.status(501).json({ error: (error as Error).message });
  }

  const signerBytes = JSON.parse(await readFile(env.wallet, "utf8")) as number[];
  const signer = await createKeyPairSignerFromBytes(Uint8Array.from(signerBytes));
  const client = createMarketplaceClient({ rpcUrl: env.rpcUrl, signer });
  const jobSpec = { instructions };
  let storedJobSpec: Awaited<ReturnType<typeof storeJobSpec>>;
  try {
    storedJobSpec = await storeJobSpec(jobSpec);
  } catch {
    return res.status(503).json({
      error: "job-spec hosting unavailable: check AGENC_JOB_SPEC_DIR and AGENC_JOB_SPEC_PUBLIC_BASE_URL",
    });
  }
  const moderator = env.moderator as Address;

  const result = await hireAndActivate(client, {
    hire: {
      listing: env.listing as Address,
      taskId: values.randomId32(),
      expectedPrice: EXPECTED_PRICE_LAMPORTS,
      expectedVersion: 1n,
      reviewWindowSecs: 3600n,
      listingSpecHash: values.hexToBytes(env.listingSpecHash),
      moderator,
    },
    jobSpec,
    hostAndModerateJobSpec: async (host) => {
      await requestSandboxAttestation({
        kind: "task",
        address: host.taskPda,
        specHash: storedJobSpec.jobSpecHash,
        endpoint: env.attestorUrl,
      });
      return { ...storedJobSpec, moderationAttested: true, moderator };
    },
    rpcUrl: env.rpcUrl,
  });

  return res.status(200).json({
    task: result.taskPda,
    hireSignature: result.hireSignature,
    activationSignature: result.activationSignature,
  });
}
`;
}

/** Generic node/agent projects: a worker loop over @tetsuo-ai/agenc-worker. */
export function workerLoopMjs(config: AgencConfig): string {
  return `#!/usr/bin/env node
// ${MARKER}
// Safe to edit; re-run \`agenc init --force\` to regenerate.
//
// worker.mjs — "${commentSafeName(config.name)}" earning on the AgenC marketplace through the
// @tetsuo-ai/agenc-worker programmatic API: register once, watch claimable
// tasks, claim -> execute (your own coding-agent CLI) -> submit, and report
// settlements (with receipt URLs when observable).
//
// Run:  AGENC_WORKER_RPC_URL=<rpc> AGENC_WORKER_WALLET=<keypair.json> \\
//       AGENC_WORKER_MAX_REWARD_LAMPORTS=<finite-cap> \\
//       AGENC_WORKER_CREATOR_ALLOWLIST=<trusted-creator-wallet> node worker.mjs
// (or put rpcUrl/walletPath in ~/.config/agenc-worker/config.json)
import { readFileSync } from "node:fs";
import { createKeyPairSignerFromBytes, createSolanaRpc } from "@solana/kit";
import { createMarketplaceClient, taskThread } from "@tetsuo-ai/marketplace-sdk";
import {
  configFromEnv,
  defaultConfigPath,
  loadConfigFile,
  resolveWorkerConfig,
  runUp,
} from "@tetsuo-ai/agenc-worker";

const config = resolveWorkerConfig(
  {
    // Project defaults from agenc.config.json — flags/env still win.
    endpoint: "https://example.invalid/${config.name.replace(/[^A-Za-z0-9._-]/gu, "-")}",
  },
  configFromEnv(process.env),
  loadConfigFile(process.env.AGENC_WORKER_CONFIG ?? defaultConfigPath(), {
    explicit: false,
  }),
);

const signer = await createKeyPairSignerFromBytes(
  Uint8Array.from(JSON.parse(readFileSync(config.walletPath, "utf8"))),
);
const rpc = createSolanaRpc(config.rpcUrl);
const client = createMarketplaceClient({ rpc, signer });

const ctx = {
  config,
  client,
  signer,
  gpa: rpc,
  readAccount: async (address) => {
    const { value } = await rpc.getAccountInfo(address, { encoding: "base64" }).send();
    return value === null ? null : new Uint8Array(Buffer.from(value.data[0], "base64"));
  },
  stateDir: config.stateDir,
  log: (event) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...event })),
  taskThreadTransport: taskThread.createContentTransport({
    baseUrl: config.taskThreadBaseUrl,
  }),
  findSettlementSignature: async (task) => {
    const signatures = await rpc.getSignaturesForAddress(task, { limit: 1 }).send();
    const newest = signatures[0];
    return newest === undefined || newest.err !== null ? null : newest.signature;
  },
};

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
await runUp(ctx, { signal: controller.signal });
`;
}
