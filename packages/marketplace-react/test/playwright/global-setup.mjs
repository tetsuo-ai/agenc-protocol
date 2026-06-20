/**
 * Playwright global setup for the A3 checkout browser e2e.
 *
 * 1. Boots the deterministic local sandbox (validator + protocol/moderation
 *    config + seeded listings) via test/sandbox-up.mjs (idempotent).
 * 2. Generates a fresh buyer keypair, funds it, and resolves the on-chain
 *    parameters the checkout needs (listing spec hash/price/version, the worker
 *    agent + authority, the treasury from ProtocolConfig).
 * 3. Writes those into test-apps/checkout/public/sandbox-config.json so the
 *    served checkout SPA adopts the SAME buyer identity the worker harness signs
 *    set_task_job_spec with.
 * 4. Stashes the resolved context on a JSON file the spec reads
 *    (.playwright-sandbox.json), so the test process can run the Node-side worker
 *    scaffolding between the browser's hire and accept.
 *
 * Teardown (global-teardown.mjs) stops the validator.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as kit from "@solana/kit";
import {
  findProtocolConfigPda,
  fetchMaybeProtocolConfig,
} from "@tetsuo-ai/marketplace-sdk";
import { start, readSandboxEnv } from "../sandbox-up.mjs";
import { fetchListing } from "./worker-harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKOUT_PUBLIC = path.resolve(
  HERE,
  "../../test-apps/checkout/public/sandbox-config.json",
);
const CONTEXT_FILE = path.join(HERE, ".playwright-sandbox.json");

const LAMPORTS_PER_SOL = 1_000_000_000n;

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function airdrop(rpc, addr) {
  await rpc
    .requestAirdrop(kit.address(addr), kit.lamports(2n * LAMPORTS_PER_SOL))
    .send();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { value } = await rpc.getBalance(kit.address(addr)).send();
    if (BigInt(value) >= LAMPORTS_PER_SOL) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`airdrop to ${addr} did not land`);
}

/** True when the validator answers getHealth=ok on `rpcUrl`. */
async function rpcHealthy(rpcUrl) {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      signal: AbortSignal.timeout(2000),
    });
    const body = await res.json();
    return body.result === "ok";
  } catch {
    return false;
  }
}

export default async function globalSetup() {
  // 1) Boot/converge the sandbox. Existing env files do NOT prove the validator
  // is up (e.g. after `down --purge`, env.json/fixtures.json survive but the
  // ledger is wiped), so health-check the RPC and (re)boot when it is down,
  // unseeded, or still running a stale repo-built program binary.
  let env = await readSandboxEnv();
  const healthy = env !== null && (await rpcHealthy(env.rpcUrl));
  if (env === null || env.fixtures === null || !healthy || !env.programCurrent) {
    env = await start({ quiet: true });
  }
  const rpc = kit.createSolanaRpc(env.rpcUrl);

  // 2) Buyer wallet: generate a fresh EXTRACTABLE ed25519 keypair so we can hand
  // the 64-byte secret to BOTH the browser (mock embedded wallet adopts it) and
  // the Node worker harness (signs set_task_job_spec as the task creator). kit's
  // generateKeyPairSigner produces a NON-extractable key, so we mint our own.
  const buyerSecretKeyBytes = await generateExtractableSecretKey();
  const buyer = await kit.createKeyPairSignerFromBytes(buyerSecretKeyBytes);
  await airdrop(rpc, String(buyer.address));

  // 3) Resolve checkout parameters from chain.
  const listingEntry = env.fixtures.listings[0];
  const listing = await fetchListing(rpc, kit, listingEntry.address);
  const [pcPda] = await findProtocolConfigPda();
  const pc = await fetchMaybeProtocolConfig(rpc, pcPda);
  if (!pc.exists) throw new Error("ProtocolConfig missing on the sandbox");

  // The seeder is the provider authority (the worker authority paid on accept).
  const seederBytes = Uint8Array.from(
    JSON.parse(await import("node:fs/promises").then((m) => m.readFile(env.keypairs.seeder, "utf8"))),
  );
  const seeder = await kit.createKeyPairSignerFromBytes(seederBytes);

  const sandboxConfig = {
    rpcUrl: env.rpcUrl,
    listing: listingEntry.address,
    listingSpecHashHex: hex(listing.specHash),
    expectedPriceLamports: listing.price.toString(),
    expectedVersion: listing.version.toString(),
    reviewWindowSecs: "3600",
    workerAgent: listingEntry.provider,
    workerAuthority: String(seeder.address),
    treasury: String(pc.data.treasury),
    buyerSecretKeyHex: hex(buyerSecretKeyBytes),
  };

  await writeFile(CHECKOUT_PUBLIC, `${JSON.stringify(sandboxConfig, null, 2)}\n`);

  // 4) Stash the harness context for the spec (worker side runs in Node).
  await mkdir(path.dirname(CONTEXT_FILE), { recursive: true });
  await writeFile(
    CONTEXT_FILE,
    `${JSON.stringify(
      {
        rpcUrl: env.rpcUrl,
        listing: listingEntry.address,
        workerAgent: listingEntry.provider,
        seederKeyPath: env.keypairs.seeder,
        moderatorKeyPath: env.keypairs.moderator,
        buyerSecretKeyHex: hex(buyerSecretKeyBytes),
        workerAuthority: String(seeder.address),
      },
      null,
      2,
    )}\n`,
  );

}

/**
 * Generate a fresh ed25519 keypair as a 64-byte secret (seed 32 || pubkey 32),
 * the format `createKeyPairSignerFromBytes` expects. Uses an EXTRACTABLE
 * WebCrypto key so the seed can be exported (kit's generated keys are not).
 */
async function generateExtractableSecretKey() {
  const kp = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const seed = base64UrlToBytes(jwk.d); // 32-byte private seed
  const pub = base64UrlToBytes(jwk.x); // 32-byte public key
  const out = new Uint8Array(64);
  out.set(seed, 0);
  out.set(pub, 32);
  return out;
}

function base64UrlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = Buffer.from(b64 + pad, "base64");
  return new Uint8Array(bin);
}
