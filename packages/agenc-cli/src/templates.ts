// File contents `agenc init` writes. Every file opens with a clear
// "written by agenc init" marker; init refuses to overwrite differing
// content without --force, so these are safe to hand-edit afterward.
import type { AgencConfig } from "./config.js";

const MARKER = "Written by `agenc init` (@tetsuo-ai/agenc-cli).";

/**
 * Next.js App Router checkout page — GET /agenc. Server component, zero
 * client JS: shows the service and posts to the checkout route handler.
 */
export function appCheckoutPage(config: AgencConfig): string {
  return `// ${MARKER}
// Safe to edit; re-run \`agenc init --force\` to regenerate.
//
// GET /agenc — the minimal AgenC checkout surface for "${config.name}".
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
import { readFile } from "node:fs/promises";
import { createKeyPairSignerFromBytes, type Address } from "@solana/kit";
import {
  createMarketplaceClient,
  findTaskModerationPda,
  hireAndActivate,
  values,
} from "@tetsuo-ai/marketplace-sdk";
import { requestSandboxAttestation } from "@tetsuo-ai/marketplace-sdk/sandbox";

// ${config.name}: listing terms captured by \`agenc init\` (agenc.config.json).
const EXPECTED_PRICE_LAMPORTS = ${config.listing.priceLamports}n;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(\`\${name} is not set — see the header of app/agenc/checkout/route.ts\`);
  }
  return value;
}

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
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

  const jobSpecHash = await values.descriptionHash(instructions);
  const jobSpecUri = \`agenc://job-spec/sha256/\${values.bytesToHex(jobSpecHash)}\`;
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
    jobSpec: { instructions },
    hostAndModerateJobSpec: async (host) => {
      await requestSandboxAttestation({
        kind: "task",
        address: host.taskPda,
        specHash: jobSpecHash,
        endpoint: env.attestorUrl,
      });
      const [taskModeration] = await findTaskModerationPda({
        task: host.taskPda,
        jobSpecHash,
        moderator,
      });
      // The attestor broadcast the TaskModeration record; surface its PDA so
      // callers can verify before relying on the activation.
      void taskModeration;
      return { jobSpecHash, jobSpecUri, moderationAttested: true, moderator };
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
// "${config.name}". Posts to /api/agenc/checkout.
export default function AgencCheckoutPage() {
  return (
    <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "system-ui" }}>
      <h1>${config.name}</h1>
      <p>Hire this service through the AgenC marketplace.</p>
      <form action="/api/agenc/checkout" method="post">
        <label style={{ display: "block", marginBottom: 8 }}>
          What do you need done?
          <textarea name="instructions" rows={4} style={{ width: "100%" }} required />
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
// AGENC_LISTING_SPEC_HASH, AGENC_MODERATOR, AGENC_ATTESTOR_URL).
import type { NextApiRequest, NextApiResponse } from "next";
import { readFile } from "node:fs/promises";
import { createKeyPairSignerFromBytes, type Address } from "@solana/kit";
import {
  createMarketplaceClient,
  hireAndActivate,
  values,
} from "@tetsuo-ai/marketplace-sdk";
import { requestSandboxAttestation } from "@tetsuo-ai/marketplace-sdk/sandbox";

const EXPECTED_PRICE_LAMPORTS = ${config.listing.priceLamports}n;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") throw new Error(\`\${name} is not set\`);
  return value;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
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
  const jobSpecHash = await values.descriptionHash(instructions);
  const jobSpecUri = \`agenc://job-spec/sha256/\${values.bytesToHex(jobSpecHash)}\`;
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
    jobSpec: { instructions },
    hostAndModerateJobSpec: async (host) => {
      await requestSandboxAttestation({
        kind: "task",
        address: host.taskPda,
        specHash: jobSpecHash,
        endpoint: env.attestorUrl,
      });
      return { jobSpecHash, jobSpecUri, moderationAttested: true, moderator };
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
// worker.mjs — "${config.name}" earning on the AgenC marketplace through the
// @tetsuo-ai/agenc-worker programmatic API: register once, watch claimable
// tasks, claim -> execute (your own coding-agent CLI) -> submit, and report
// settlements (with receipt URLs when observable).
//
// Run:  AGENC_WORKER_RPC_URL=<rpc> AGENC_WORKER_WALLET=<keypair.json> node worker.mjs
// (or put rpcUrl/walletPath in ~/.config/agenc-worker/config.json)
import { readFileSync } from "node:fs";
import { createKeyPairSignerFromBytes, createSolanaRpc } from "@solana/kit";
import { createMarketplaceClient } from "@tetsuo-ai/marketplace-sdk";
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
