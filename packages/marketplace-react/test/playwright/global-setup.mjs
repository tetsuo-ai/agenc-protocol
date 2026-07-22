/**
 * Playwright global setup for the A3 checkout browser e2e.
 *
 * 1. Boots the deterministic local sandbox (validator + protocol, moderation,
 *    and bid-marketplace configs + seeded listings) via test/sandbox-up.mjs
 *    (idempotent).
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
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as kit from "@solana/kit";
import {
  fetchMaybeModerationConfig,
  findProtocolConfigPda,
  findModerationConfigPda,
  fetchMaybeProtocolConfig,
} from "@tetsuo-ai/marketplace-sdk";
import { start, stop, readSandboxEnv } from "../sandbox-up.mjs";
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

/**
 * Resolve the minimum on-chain state the browser flow needs. A healthy RPC and
 * a current program hash are insufficient: env/fixture JSON survives a ledger
 * reset, so every cached address must be treated as a hint until RPC confirms
 * it still exists.
 */
async function resolveLiveSandboxState(env) {
  const listingEntry = env.fixtures?.listings?.[0];
  if (
    listingEntry === undefined ||
    !env.keypairs?.seeder ||
    !env.keypairs?.moderator
  ) {
    return null;
  }

  const rpc = kit.createSolanaRpc(env.rpcUrl);
  try {
    const listing = await fetchListing(rpc, kit, listingEntry.address);
    const [protocolConfigPda] = await findProtocolConfigPda();
    const protocolConfig = await fetchMaybeProtocolConfig(
      rpc,
      protocolConfigPda,
    );
    const [moderationConfigPda] = await findModerationConfigPda();
    const moderationConfig = await fetchMaybeModerationConfig(
      rpc,
      moderationConfigPda,
    );
    if (
      !protocolConfig.exists ||
      protocolConfig.data.protocolPaused ||
      !moderationConfig.exists
    ) {
      return null;
    }
    return { rpc, listingEntry, listing, protocolConfig, moderationConfig };
  } catch {
    return null;
  }
}

export default async function globalSetup() {
  // 1) Boot the sandbox. The browser flow uses a disposable test-only genesis
  // ProtocolConfig because a fresh production binary correctly starts paused
  // until a complete release-stamp ceremony (whose IDL/custody/bid evidence is
  // deliberately outside this React fixture). Resetting here makes every CI run
  // independent of stale env JSON or a prior paused ledger. Developers can opt
  // into reuse explicitly with AGENC_KEEP_SANDBOX=1.
  const preserveLedger = process.env.AGENC_KEEP_SANDBOX === "1";
  const sandboxPort = Number(process.env.AGENC_SANDBOX_PORT ?? "8899");
  if (
    !Number.isInteger(sandboxPort) ||
    sandboxPort < 1 ||
    sandboxPort > 65432
  ) {
    throw new Error("AGENC_SANDBOX_PORT must be an integer in 1..65432");
  }
  return setupBrowserFixture({ preserveLedger, sandboxPort });
}

async function setupBrowserFixture({ preserveLedger, sandboxPort }) {
  let ownsSandbox = false;
  try {
    let env;
    if (preserveLedger) {
      env = await readSandboxEnv();
      const healthy = env !== null && (await rpcHealthy(env.rpcUrl));
      if (env === null || !healthy || !env.programCurrent) {
        throw new Error(
          "AGENC_KEEP_SANDBOX=1 requires an already-running current browser sandbox; unset it to rebuild the disposable fixture",
        );
      }
    } else {
      await stop({ purge: true, removeState: true, quiet: true });
      await Promise.all([
        rm(CHECKOUT_PUBLIC, { force: true }),
        rm(CONTEXT_FILE, { force: true }),
      ]);
      ownsSandbox = true;
      env = await start({
        port: sandboxPort,
        quiet: true,
        devReady: true,
        disposable: true,
      });
    }

    const liveState = await resolveLiveSandboxState(env);
    if (liveState === null) {
      throw new Error(
        preserveLedger
          ? "preserved sandbox is paused or missing live fixture accounts; unset AGENC_KEEP_SANDBOX to rebuild it"
          : "sandbox bootstrap completed without an unpaused ProtocolConfig and live listing",
      );
    }
    const { rpc, listingEntry, listing, protocolConfig, moderationConfig } =
      liveState;

    // 2) Buyer wallet: generate a fresh EXTRACTABLE ed25519 keypair so we can hand
    // the 64-byte secret to BOTH the browser (mock embedded wallet adopts it) and
    // the Node worker harness (signs set_task_job_spec as the task creator). kit's
    // generateKeyPairSigner produces a NON-extractable key, so we mint our own.
    const buyerSecretKeyBytes = await generateExtractableSecretKey();
    const buyer = await kit.createKeyPairSignerFromBytes(buyerSecretKeyBytes);
    await airdrop(rpc, String(buyer.address));

    // 3) Resolve checkout parameters from chain.
    // The seeder is the provider authority (the worker authority paid on accept).
    const seederBytes = Uint8Array.from(
      JSON.parse(await readFile(env.keypairs.seeder, "utf8")),
    );
    const seeder = await kit.createKeyPairSignerFromBytes(seederBytes);
    const moderatorBytes = Uint8Array.from(
      JSON.parse(await readFile(env.keypairs.moderator, "utf8")),
    );
    const moderator = await kit.createKeyPairSignerFromBytes(moderatorBytes);
    if (moderator.address !== moderationConfig.data.moderationAuthority) {
      throw new Error(
        `sandbox moderator ${moderator.address} does not match ModerationConfig ` +
          `authority ${moderationConfig.data.moderationAuthority}`,
      );
    }

    const sandboxConfig = {
      rpcUrl: env.rpcUrl,
      listing: listingEntry.address,
      listingSpecHashHex: hex(listing.specHash),
      expectedPriceLamports: listing.price.toString(),
      expectedVersion: listing.version.toString(),
      reviewWindowSecs: "3600",
      workerAgent: listingEntry.provider,
      workerAuthority: String(seeder.address),
      treasury: String(protocolConfig.data.treasury),
      moderator: String(moderator.address),
      buyerSecretKeyHex: hex(buyerSecretKeyBytes),
    };

    await writeFile(
      CHECKOUT_PUBLIC,
      `${JSON.stringify(sandboxConfig, null, 2)}\n`,
    );

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
  } catch (error) {
    if (!ownsSandbox) throw error;
    try {
      await Promise.all([
        stop({ purge: true, removeState: true, quiet: true }),
        rm(CHECKOUT_PUBLIC, { force: true }),
        rm(CONTEXT_FILE, { force: true }),
      ]);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Playwright global setup failed and its disposable state could not be cleaned",
      );
    }
    throw error;
  }
}

/**
 * Generate a fresh ed25519 keypair as a 64-byte secret (seed 32 || pubkey 32),
 * the format `createKeyPairSignerFromBytes` expects. Uses an EXTRACTABLE
 * WebCrypto key so the seed can be exported (kit's generated keys are not).
 */
async function generateExtractableSecretKey() {
  const kp = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
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
