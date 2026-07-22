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
  const maximumLength = 214;
  let cleaned = "";
  let normalizedLength = 0;
  let lastNonHyphenEnd = 0;
  let started = false;
  let pendingSeparator = false;

  const append = (character: string): void => {
    if (cleaned.length < maximumLength) cleaned += character;
    normalizedLength += 1;
    if (character !== "-") lastNonHyphenEnd = normalizedLength;
  };

  for (const character of name.toLowerCase()) {
    const code = character.charCodeAt(0);
    const allowed =
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      character === "-" ||
      character === "." ||
      character === "_" ||
      character === "~";

    if (!allowed) {
      if (started) pendingSeparator = true;
      continue;
    }
    if (
      !started &&
      (character === "-" || character === "." || character === "_")
    ) {
      continue;
    }
    if (pendingSeparator) append("-");
    pendingSeparator = false;
    started = true;
    append(character);
  }

  // Strip every trailing hyphen before applying npm's 214-character limit.
  // Tracking the conceptual length preserves that ordering without an
  // unbounded intermediate normalized string.
  cleaned = cleaned.slice(0, Math.min(maximumLength, lastNonHyphenEnd));
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

function lamportsAsSol(value: string): string {
  const lamports = BigInt(value);
  const whole = lamports / 1_000_000_000n;
  const fractional = (lamports % 1_000_000_000n)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/u, "");
  return fractional === "" ? whole.toString() : `${whole}.${fractional}`;
}

function settlementCopy(config: AgencConfig): string {
  const sentences = [
    "Settlement pays the worker and applies the current on-chain protocol fee terms.",
  ];
  if (config.listing.operatorFeeBps > 0) {
    sentences.push("A configured operator fee adds an operator payee leg.");
  }
  if (config.listing.referrerFeeBps > 0) {
    sentences.push(
      "A validated optional referrer can add a referrer payee leg.",
    );
  }
  return sentences.join(" ");
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
import { constants } from "node:fs";
import { link, mkdir, open, realpath, unlink } from "node:fs/promises";
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
  const directoryHandle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function secureJobSpecDirectory(create: boolean): Promise<string> {
  const directory = jobSpecDirectory();
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const resolved = await realpath(directory);
  if (resolved !== directory) {
    throw new Error("AGENC_JOB_SPEC_DIR must not contain symbolic-link components");
  }
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) throw new Error("AGENC_JOB_SPEC_DIR must be a directory");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("AGENC_JOB_SPEC_DIR must be owned by the checkout process user");
    }
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new Error("AGENC_JOB_SPEC_DIR must use private permissions (chmod 700)");
    }
  } finally {
    await handle.close();
  }
  return directory;
}

export interface StoredJobSpec {
  jobSpecHash: Uint8Array;
  jobSpecUri: string;
}

function envelopeFor(payload: Record<string, unknown>, hash: string): string {
  return (
    '{"integrity":{"algorithm":"sha256","canonicalization":"json-stable-v1","payloadHash":"' +
    hash +
    '"},"payload":' +
    values.canonicalJobSpecJson(payload) +
    "}\\n"
  );
}

export async function storeJobSpec(
  payload: Record<string, unknown>,
): Promise<StoredJobSpec> {
  const digest = await values.canonicalJobSpecHash(payload);
  // Build the envelope from the same canonical payload bytes that were hashed.
  // This guarantees one immutable file representation per content address even
  // when callers construct equivalent objects with different key insertion order.
  const envelope = envelopeFor(payload, digest.hex);
  if (new TextEncoder().encode(envelope).byteLength > MAX_JOB_SPEC_BYTES) {
    throw new Error(\`job spec exceeds \${MAX_JOB_SPEC_BYTES} bytes\`);
  }

  const jobSpecUri = \`\${publicBaseUrl()}?hash=\${digest.hex}\`;
  if (new TextEncoder().encode(jobSpecUri).byteLength > MAX_JOB_SPEC_URI_BYTES) {
    throw new Error(\`job-spec URI exceeds \${MAX_JOB_SPEC_URI_BYTES} bytes\`);
  }

  const directory = await secureJobSpecDirectory(true);
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
      const existing = await readJobSpec(digest.hex);
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

/**
 * Read the exact advertised URI back before a funded hire is sent. This catches
 * proxy/routing/cache misconfiguration that a successful local disk write
 * cannot detect.
 */
export async function verifyPublishedJobSpec(
  stored: StoredJobSpec,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const digest = await values.canonicalJobSpecHash(payload);
  if (values.bytesToHex(stored.jobSpecHash) !== digest.hex) {
    throw new Error("stored job-spec hash does not match the requested payload");
  }
  let url: URL;
  try {
    url = new URL(stored.jobSpecUri);
  } catch {
    throw new Error("stored job-spec URI is invalid");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new Error("stored job-spec URI must be credential-free HTTPS");
  }
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "manual",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status < 200 || response.status >= 300 || response.body === null) {
    throw new Error("advertised job-spec URI did not return a non-redirect 2xx response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_JOB_SPEC_BYTES) {
      await reader.cancel();
      throw new Error(\`advertised job spec exceeds \${MAX_JOB_SPEC_BYTES} bytes\`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const actual = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (actual !== envelopeFor(payload, digest.hex)) {
    throw new Error("advertised job-spec envelope does not exactly match its content address");
  }
}

export async function readJobSpec(hash: string): Promise<string> {
  if (!HASH_HEX_RE.test(hash)) {
    throw new TypeError("job-spec hash must be 64 hexadecimal characters");
  }
  const directory = await secureJobSpecDirectory(false);
  const file = path.join(directory, \`\${hash.toLowerCase()}.json\`);
  const before = await (await import("node:fs/promises")).lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_JOB_SPEC_BYTES) {
    throw new Error("stored job spec is not a bounded regular file");
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const after = await handle.stat();
    if (
      !after.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      after.size > MAX_JOB_SPEC_BYTES
    ) {
      throw new Error("stored job spec changed while it was opened");
    }
    const envelope = await handle.readFile("utf8");
    if (new TextEncoder().encode(envelope).byteLength > MAX_JOB_SPEC_BYTES) {
      throw new Error("stored job spec exceeds its byte limit");
    }
    const parsed: unknown = JSON.parse(envelope);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("stored job spec envelope is invalid");
    }
    const record = parsed as { integrity?: unknown; payload?: unknown };
    if (typeof record.payload !== "object" || record.payload === null || Array.isArray(record.payload)) {
      throw new Error("stored job spec payload is invalid");
    }
    const digest = await values.canonicalJobSpecHash(record.payload as Record<string, unknown>);
    if (digest.hex !== hash.toLowerCase() || envelope !== envelopeFor(record.payload as Record<string, unknown>, digest.hex)) {
      throw new Error("stored job spec does not match its content address");
    }
    return envelope;
  } finally {
    await handle.close();
  }
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
import { readJobSpec } from "../../../lib/agenc/job-spec-store";

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

/** Strict server-side keypair loader shared by generated checkout routes. */
export function walletFileModule(): string {
  return `// ${MARKER}
// Server-only. Rejects coercible bytes, symlinks, non-files, foreign owners,
// and group/other-readable signing keys.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";

const MAX_WALLET_FILE_BYTES = 4 * 1024;

export function loadWalletFile(walletPath: string): Uint8Array {
  const pathStat = lstatSync(walletPath);
  if (pathStat.isSymbolicLink()) throw new Error("wallet symbolic links are not allowed");
  let fd: number;
  try {
    fd = openSync(walletPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    throw new Error("wallet cannot be opened without following symlinks: " + (error as Error).message);
  }
  try {
    const stat = fstatSync(fd);
    if (stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) {
      throw new Error("wallet changed while it was being opened");
    }
    if (!stat.isFile()) throw new Error("wallet must be a regular file");
    if (stat.size > MAX_WALLET_FILE_BYTES) {
      throw new Error("wallet file exceeds 4096 bytes");
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("wallet must be owned by the current user");
    }
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new Error("wallet must have private permissions (chmod 600)");
    }
    const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!Array.isArray(value) || value.length !== 64) {
      throw new Error("wallet must contain exactly 64 keypair bytes");
    }
    for (let index = 0; index < value.length; index += 1) {
      const byte = value[index];
      if (
        typeof byte !== "number" ||
        !Number.isFinite(byte) ||
        !Number.isSafeInteger(byte) ||
        byte < 0 ||
        byte > 255
      ) {
        throw new Error("wallet byte " + index + " must be an integer in 0..255");
      }
    }
    return Uint8Array.from(value as number[]);
  } finally {
    closeSync(fd);
  }
}
`;
}

/**
 * Safe-default admission policy for funded generated checkouts. Production is
 * deliberately disabled until the application replaces authorizePrincipal
 * with its real session/entitlement policy and a durable distributed store.
 */
export function checkoutPolicyModule(): string {
  return `// ${MARKER}
// SECURITY BOUNDARY: this generated fallback is for local development only.
// Production requests are refused until you replace authorizePrincipal and
// these in-memory limit/idempotency stores with your authenticated application
// policy and a durable, atomic shared store.
import { randomUUID, timingSafeEqual } from "node:crypto";

const WINDOW_MS = 60_000;
const SPEND_WINDOW_MS = 60 * 60_000;
const MAX_REQUESTS_PER_WINDOW = 3;
const MAX_ENTRIES = 10_000;
const KEY_RE = /^[A-Za-z0-9._:-]{16,128}$/u;
const U64_MAX = 18_446_744_073_709_551_615n;

type HeadersLike = { get(name: string): string | null };
type Stored = {
  state: "pending" | "recoverable" | "blocked" | "complete";
  generation: string;
  expiresAt: number;
  maximumDebitLamports: bigint;
  fingerprint?: string;
  recovery?: unknown;
  blockReason?: string;
  reservationId?: string;
  body?: Record<string, unknown>;
};
const idempotency = new Map<string, Stored>();
const requestTimes = new Map<string, number[]>();
const debitReservations = new Map<
  string,
  { principal: string; amount: bigint; expiresAt: number }
>();

export type CheckoutAdmissionSuccess = {
  ok: true;
  recovery?: unknown;
  cachedBody?: Record<string, unknown>;
  bindIntent(fingerprint: string): boolean;
  /** Reconfirm ownership and extend the debit reservation immediately before send. */
  checkpoint(now?: number): boolean;
  preserve(recovery: unknown): void;
  /** Permanently lock an outcome that cannot be proved safe to retry. */
  block(reason: string): void;
  /** Discard recovery after finalized proof that its transaction failed atomically. */
  discardRecovery(): void;
  complete(body: Record<string, unknown>, now?: number): void;
  abort(): void;
};

export type CheckoutAdmission =
  | CheckoutAdmissionSuccess
  | { ok: false; status: number; body: Record<string, unknown> };

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorizePrincipal(headers: HeadersLike): string | { status: number; error: string } {
  if (process.env.NODE_ENV === "production") {
    return {
      status: 503,
      error: "checkout disabled in production: implement authenticated authorization and durable policy storage",
    };
  }
  if (process.env.AGENC_ENABLE_DEV_CHECKOUT !== "1") {
    return { status: 503, error: "checkout disabled: set AGENC_ENABLE_DEV_CHECKOUT=1 for explicit local development" };
  }
  if (process.env.AGENC_NETWORK !== "localnet") {
    return { status: 503, error: "checkout disabled: generated policy requires AGENC_NETWORK=localnet" };
  }
  let rpcUrl: URL;
  try {
    rpcUrl = new URL(process.env.AGENC_RPC_URL ?? "");
  } catch {
    return { status: 503, error: "checkout disabled: AGENC_RPC_URL must be a loopback URL" };
  }
  if (
    !["http:", "https:"].includes(rpcUrl.protocol) ||
    rpcUrl.username !== "" ||
    rpcUrl.password !== "" ||
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(rpcUrl.hostname)
  ) {
    return { status: 503, error: "checkout disabled: AGENC_RPC_URL must be credential-free HTTP(S) loopback" };
  }
  const expected = process.env.AGENC_CHECKOUT_SECRET?.trim() ?? "";
  const presented = headers.get("x-agenc-checkout-secret") ?? "";
  if (expected === "") return { status: 503, error: "checkout disabled: set AGENC_CHECKOUT_SECRET for local development" };
  if (!safeEqual(presented, expected)) return { status: 401, error: "unauthorized" };
  return "development";
}

function debitLimit(): bigint | null {
  const raw = process.env.AGENC_CHECKOUT_HOURLY_DEBIT_LIMIT_LAMPORTS?.trim() ?? "";
  if (!/^[1-9]\\d*$/u.test(raw) || raw.length > 20) return null;
  const value = BigInt(raw);
  return value <= U64_MAX ? value : null;
}

function prune(now: number): void {
  // Never TTL-forget a key once a funded outcome may exist. Losing its taskId
  // or SDK progress would turn an outage into a duplicate-spend opportunity.
  for (const [key, value] of idempotency) {
    if (
      value.expiresAt <= now &&
      value.state !== "recoverable" &&
      value.state !== "blocked" &&
      value.state !== "complete" &&
      !(value.state === "pending" && value.recovery !== undefined)
    ) {
      idempotency.delete(key);
    }
  }
  const retainedReservationIds = new Set(
    [...idempotency.values()]
      // Pending code may still broadcast, so its reservation cannot expire.
      // Recoverable code is dormant; a later retry atomically creates a fresh
      // full reservation when the original rolling-window entry has expired.
      .filter((entry) => entry.state === "pending" || entry.state === "blocked")
      .map((entry) => entry.reservationId)
      .filter((id): id is string => id !== undefined),
  );
  for (const [id, value] of debitReservations) {
    if (value.expiresAt <= now && !retainedReservationIds.has(id)) {
      debitReservations.delete(id);
    }
  }
  for (const [key, values] of requestTimes) {
    const current = values.filter((time) => time > now - WINDOW_MS);
    if (current.length === 0) requestTimes.delete(key);
    else requestTimes.set(key, current);
  }
}

export function admitCheckout(
  headers: HeadersLike,
  maximumDebitLamports: bigint,
  now = Date.now(),
): CheckoutAdmission {
  const principal = authorizePrincipal(headers);
  if (typeof principal !== "string") {
    return { ok: false, status: principal.status, body: { error: principal.error } };
  }
  const hourlyDebitLimit = debitLimit();
  if (
    maximumDebitLamports <= 0n ||
    maximumDebitLamports > U64_MAX ||
    hourlyDebitLimit === null
  ) {
    return { ok: false, status: 503, body: { error: "invalid checkout total-debit policy" } };
  }
  prune(now);
  const rawKey = headers.get("idempotency-key") ?? "";
  if (!KEY_RE.test(rawKey)) {
    return { ok: false, status: 400, body: { error: "a 16..128 character idempotency-key header is required" } };
  }
  const key = principal + ":" + rawKey;
  const previous = idempotency.get(key);
  if (previous?.state === "pending") {
    return { ok: false, status: 409, body: { error: "checkout with this idempotency key is in progress" } };
  }
  if (previous?.state === "blocked") {
    return {
      ok: false,
      status: 409,
      body: { error: previous.blockReason ?? "checkout outcome requires manual operator review" },
    };
  }
  if (
    previous === undefined &&
    idempotency.size + requestTimes.size + debitReservations.size >= MAX_ENTRIES
  ) {
    return { ok: false, status: 503, body: { error: "checkout policy capacity reached" } };
  }
  const resumed = previous?.state === "recoverable" || previous?.state === "complete";
  if (resumed && previous.maximumDebitLamports !== maximumDebitLamports) {
    return { ok: false, status: 409, body: { error: "checkout debit intent changed for this idempotency key" } };
  }
  const completedReplay = previous?.state === "complete";
  let reservationId = previous?.reservationId;
  let createdReservation = false;
  if (!completedReplay) {
    const recent = requestTimes.get(principal) ?? [];
    if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
      return { ok: false, status: 429, body: { error: "checkout rate limit exceeded" } };
    }
    const amount = [...debitReservations.values()]
      .filter((reservation) => reservation.principal === principal)
      .reduce((total, reservation) => total + reservation.amount, 0n);
    const existingReservation = reservationId === undefined
      ? undefined
      : debitReservations.get(reservationId);
    const additionalDebit = existingReservation === undefined ? maximumDebitLamports : 0n;
    if (amount + additionalDebit > hourlyDebitLimit) {
      return { ok: false, status: 429, body: { error: "checkout hourly total-debit ceiling exceeded" } };
    }
    requestTimes.set(principal, [...recent, now]);
    if (existingReservation === undefined) {
      reservationId = randomUUID();
      createdReservation = true;
      debitReservations.set(reservationId, {
        principal,
        amount: maximumDebitLamports,
        expiresAt: now + SPEND_WINDOW_MS,
      });
    } else if (previous?.state === "recoverable") {
      // A recovery may broadcast fresh post-hire transactions. Restart its
      // rolling spend window even when the original reservation still exists;
      // otherwise a minute-59 resume would fall out at minute 60.
      existingReservation.expiresAt = now + SPEND_WINDOW_MS;
      debitReservations.set(reservationId!, existingReservation);
    }
  }
  const active: Stored = {
    state: "pending",
    generation: randomUUID(),
    expiresAt: previous?.expiresAt ?? now + SPEND_WINDOW_MS,
    maximumDebitLamports,
    fingerprint: previous?.fingerprint,
    recovery: previous?.recovery,
    reservationId,
  };
  idempotency.set(key, active);
  let settled = false;
  const isCurrent = () => idempotency.get(key)?.generation === active.generation;
  const refreshReservation = (activityAt: number): void => {
    if (completedReplay || reservationId === undefined) return;
    const reservation = debitReservations.get(reservationId);
    if (reservation === undefined) return;
    reservation.expiresAt = Math.max(activityAt, now) + SPEND_WINDOW_MS;
    debitReservations.set(reservationId, reservation);
  };
  return {
    ok: true,
    recovery: previous?.state === "recoverable" ? previous.recovery : undefined,
    cachedBody: previous?.state === "complete" ? previous.body : undefined,
    bindIntent(fingerprint) {
      if (settled || !isCurrent() || fingerprint === "") return false;
      if (resumed && active.fingerprint === undefined) return false;
      if (active.fingerprint !== undefined && active.fingerprint !== fingerprint) return false;
      active.fingerprint = fingerprint;
      idempotency.set(key, active);
      return true;
    },
    checkpoint(activityAt = Date.now()) {
      if (settled || !isCurrent()) return false;
      refreshReservation(activityAt);
      idempotency.set(key, active);
      return true;
    },
    preserve(recovery) {
      if (settled || !isCurrent()) return;
      settled = true;
      idempotency.set(key, {
        ...active,
        state: "recoverable",
        expiresAt: Number.MAX_SAFE_INTEGER,
        recovery,
      });
    },
    block(reason) {
      if (settled || !isCurrent()) return;
      settled = true;
      idempotency.set(key, {
        ...active,
        state: "blocked",
        expiresAt: Number.MAX_SAFE_INTEGER,
        recovery: undefined,
        blockReason: reason,
      });
    },
    discardRecovery() {
      if (settled || !isCurrent()) return;
      settled = true;
      idempotency.delete(key);
      if (reservationId !== undefined) debitReservations.delete(reservationId);
    },
    complete(body, activityAt = Date.now()) {
      if (settled || !isCurrent()) return;
      settled = true;
      refreshReservation(activityAt);
      idempotency.set(key, {
        ...active,
        state: "complete",
        expiresAt: Number.MAX_SAFE_INTEGER,
        recovery: undefined,
        body,
      });
    },
    abort() {
      if (settled || !isCurrent()) return;
      settled = true;
      if (resumed && previous !== undefined) {
        if (createdReservation && reservationId !== undefined) {
          debitReservations.delete(reservationId);
        }
        idempotency.set(key, previous);
        return;
      }
      idempotency.delete(key);
      if (createdReservation && reservationId !== undefined) {
        debitReservations.delete(reservationId);
      }
    },
  };
}
`;
}

/** Shared funded-checkout implementation used by both Next router adapters. */
export function checkoutCoreModule(config: AgencConfig): string {
  return `// ${MARKER}
// Safe to edit; re-run \`agenc init --force\` to regenerate.
//
// Local-development checkout core. The generated admission policy refuses
// production; replace it with durable authorization/idempotency before launch.
import { createHash } from "node:crypto";
import {
  address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  getBase58Decoder,
  getBase58Encoder,
  isNone,
  type Address,
  type ReadonlyUint8Array,
} from "@solana/kit";
import {
  createMarketplaceClient,
  fetchMaybeTaskJobSpec,
  fetchServiceListing,
  findTaskModerationPda,
  findTaskJobSpecPda,
  getAuthorityRateLimitSize,
  getHireRecordSize,
  getTaskEscrowSize,
  getTaskValidationConfigSize,
  HireAndActivateError,
  HireAndActivateFinalizedFailure,
  hireAndActivate,
  ListingState,
  resumeHireAndActivate,
  values,
  type HireAndActivateProgress,
} from "@tetsuo-ai/marketplace-sdk";
import { requestSandboxAttestation } from "@tetsuo-ai/marketplace-sdk/sandbox";
import type { CheckoutAdmissionSuccess } from "./checkout-policy";
import { storeJobSpec, verifyPublishedJobSpec } from "./job-spec-store";
import { loadWalletFile } from "./wallet-file";

const EXPECTED_PRICE_LAMPORTS = BigInt(${sourceStringLiteral(config.listing.priceLamports)});
const EXPECTED_OPERATOR_FEE_BPS = ${config.listing.operatorFeeBps};
const EXPECTED_DEFAULT_DEADLINE_SECS = 3600n;
const EXPECTED_REQUIRED_CAPABILITIES = 1n;
const REFERRER_FEE_BPS = ${config.listing.referrerFeeBps};
const U64_MAX = 18_446_744_073_709_551_615n;
const PUBLIC_CLUSTER_GENESIS = new Map<string, string>([
  ["5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", "mainnet-beta"],
  ["EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "devnet"],
  ["4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY", "testnet"],
]);

/** Operator-reviewed worst-case debit reservation, including reward/rent/fees. */
export function checkoutMaximumDebitLamports(): bigint {
  const raw = requiredEnv("AGENC_CHECKOUT_MAX_DEBIT_LAMPORTS");
  if (!/^[1-9]\\d*$/u.test(raw) || raw.length > 20) {
    throw new Error("AGENC_CHECKOUT_MAX_DEBIT_LAMPORTS must be a canonical positive integer");
  }
  const value = BigInt(raw);
  if (value > U64_MAX || value <= EXPECTED_PRICE_LAMPORTS) {
    throw new Error("AGENC_CHECKOUT_MAX_DEBIT_LAMPORTS must exceed price and fit u64");
  }
  return value;
}

type Recovery = {
  taskId: Uint8Array;
  expectedVersion: bigint;
  storedJobSpec: { jobSpecHash: Uint8Array; jobSpecUri: string };
  progress: HireAndActivateProgress;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") throw new Error(name + " is not set");
  return value;
}

function parsedAddress(name: string): Address {
  try {
    return address(requiredEnv(name));
  } catch {
    throw new Error(name + " must be a valid Solana address");
  }
}

function canonicalLamportsEnv(name: string): bigint {
  const raw = requiredEnv(name);
  if (!/^[1-9]\\d*$/u.test(raw) || raw.length > 20) {
    throw new Error(name + " must be a canonical positive integer");
  }
  const value = BigInt(raw);
  if (value > U64_MAX) throw new Error(name + " must fit u64");
  return value;
}

async function minimumReviewedDebit(
  rpc: ReturnType<typeof createSolanaRpc>,
): Promise<bigint> {
  // Reserve every creator-funded allocation conservatively. The rate-limit PDA
  // is included even when it already exists, so a rolled-back existence read can
  // never understate the maximum debit. Fixed-size allocations come from the
  // generated SDK; the two variable-codec allocations are compile-time pinned by
  // the program and checked against those pins in the CLI template tests.
  const accountSizes = [
    466n,
    BigInt(getTaskEscrowSize()),
    BigInt(getHireRecordSize()),
    388n,
    BigInt(getTaskValidationConfigSize()),
    BigInt(getAuthorityRateLimitSize()),
  ];
  const rents = await Promise.all(
    accountSizes.map((size) =>
      rpc.getMinimumBalanceForRentExemption(size, { commitment: "finalized" }).send(),
    ),
  );
  const feeBudget = canonicalLamportsEnv("AGENC_CHECKOUT_TX_FEE_BUDGET_LAMPORTS");
  return rents.reduce((total, rent) => total + BigInt(rent), EXPECTED_PRICE_LAMPORTS) + feeBudget;
}

function localAttestorUrl(): string {
  const raw = requiredEnv("AGENC_ATTESTOR_URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("AGENC_ATTESTOR_URL must be an absolute loopback URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
  ) {
    throw new Error("AGENC_ATTESTOR_URL must be credential-free HTTP(S) loopback");
  }
  return url.toString();
}

async function verifyAttestorModerator(endpoint: string, expected: Address): Promise<void> {
  const infoUrl = new URL("/v1/info", endpoint);
  const response = await fetch(infoUrl, {
    method: "GET",
    redirect: "manual",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status < 200 || response.status >= 300 || response.body === null) {
    throw new Error("local attestor /v1/info did not return a non-redirect 2xx response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 16 * 1024) {
      await reader.cancel();
      throw new Error("local attestor /v1/info response exceeds 16384 bytes");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let advertised: Address;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const moderator = (parsed as { moderator?: unknown } | null)?.moderator;
    if (typeof moderator !== "string") throw new Error("missing moderator");
    advertised = address(moderator);
  } catch {
    throw new Error("local attestor /v1/info returned an invalid moderator");
  }
  if (advertised !== expected) {
    throw new Error("local attestor identity does not match AGENC_MODERATOR");
  }
}

function bytesEqual(left: ReadonlyUint8Array, right: ReadonlyUint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function isCanonicalAddress(value: unknown): value is Address {
  if (typeof value !== "string") return false;
  try {
    return address(value) === value;
  } catch {
    return false;
  }
}

function isCanonicalTransactionSignature(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 100) return false;
  try {
    const bytes = new Uint8Array(getBase58Encoder().encode(value));
    return bytes.byteLength === 64 && getBase58Decoder().decode(bytes) === value;
  } catch {
    return false;
  }
}

function isIntentDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isRecovery(value: unknown): value is Recovery {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<Recovery>;
  const stored = record.storedJobSpec as Recovery["storedJobSpec"] | undefined;
  const progress = record.progress as Partial<HireAndActivateProgress> | undefined;
  const hiring = progress as
    | Partial<Extract<HireAndActivateProgress, { phase: "hiring" }>>
    | undefined;
  const committed = progress as
    | Partial<Extract<HireAndActivateProgress, { phase: "moderating" }>>
    | Partial<Extract<HireAndActivateProgress, { phase: "activating" }>>
    | undefined;
  const activating = progress as
    | Partial<Extract<HireAndActivateProgress, { phase: "activating" }>>
    | undefined;
  const validStored =
    typeof stored === "object" &&
    stored !== null &&
    stored.jobSpecHash instanceof Uint8Array &&
    stored.jobSpecHash.byteLength === 32 &&
    typeof stored.jobSpecUri === "string" &&
    stored.jobSpecUri !== "";
  const validProgress =
    typeof progress === "object" &&
    progress !== null &&
    (progress.phase === "hiring" ||
      progress.phase === "moderating" ||
      progress.phase === "activating") &&
      isCanonicalAddress(progress.taskPda) &&
      isIntentDigest(progress.hireIntentDigest) &&
      (progress.phase === "hiring"
        ? hiring?.candidateSignature === null ||
          isCanonicalTransactionSignature(hiring?.candidateSignature)
        : isCanonicalTransactionSignature(committed?.hireSignature) &&
          committed?.hireReconciled !== true &&
          (progress.phase === "moderating" ||
            (activating?.jobSpecHash instanceof Uint8Array &&
              activating.jobSpecHash.byteLength === 32 &&
              typeof activating.jobSpecUri === "string" &&
              activating.jobSpecUri !== "" &&
              isCanonicalAddress(activating.moderator) &&
              validStored &&
              bytesEqual(activating.jobSpecHash, stored!.jobSpecHash) &&
              activating.jobSpecUri === stored!.jobSpecUri)));
  return (
    record.taskId instanceof Uint8Array &&
    record.taskId.byteLength === 32 &&
    typeof record.expectedVersion === "bigint" &&
    record.expectedVersion > 0n &&
    record.expectedVersion <= U64_MAX &&
    validStored &&
    validProgress
  );
}

function intentFingerprint(input: {
  creator: Address;
  clusterIdentity: string;
  listing: Address;
  operator: Address;
  providerAgent: Address;
  listingSpecHash: string;
  moderator: Address;
  instructions: string;
  referrer: Address | null;
}): string {
  const instructionsHash = createHash("sha256").update(input.instructions, "utf8").digest("hex");
  return createHash("sha256")
    .update(JSON.stringify({
      creator: input.creator,
      clusterIdentity: input.clusterIdentity,
      listing: input.listing,
      operator: input.operator,
      providerAgent: input.providerAgent,
      listingSpecHash: input.listingSpecHash,
      moderator: input.moderator,
      expectedPriceLamports: EXPECTED_PRICE_LAMPORTS.toString(),
      expectedOperatorFeeBps: EXPECTED_OPERATOR_FEE_BPS,
      expectedDefaultDeadlineSecs: EXPECTED_DEFAULT_DEADLINE_SECS.toString(),
      expectedRequiredCapabilities: EXPECTED_REQUIRED_CAPABILITIES.toString(),
      instructionsHash,
      referrer: input.referrer,
      referrerFeeBps: input.referrer === null ? 0 : REFERRER_FEE_BPS,
    }))
    .digest("hex");
}

async function reconcileActivation(
  rpc: ReturnType<typeof createSolanaRpc>,
  creator: Address,
  progress: Extract<HireAndActivateProgress, { phase: "activating" }>,
): Promise<{ committed: false } | { committed: true; signature: string | null }> {
  const [jobSpecPda] = await findTaskJobSpecPda({ task: progress.taskPda });
  const account = await fetchMaybeTaskJobSpec(rpc, jobSpecPda, { commitment: "finalized" });
  if (!account.exists) return { committed: false };
  if (
    account.data.task !== progress.taskPda ||
    account.data.creator !== creator ||
    !bytesEqual(account.data.jobSpecHash, progress.jobSpecHash) ||
    account.data.jobSpecUri !== progress.jobSpecUri
  ) {
    throw new Error("on-chain TaskJobSpec does not match saved activation intent");
  }
  // Exact finalized account state proves activation committed. Do not attach an
  // arbitrary address-touching transaction as evidence when its signature is
  // unavailable from the failed RPC response.
  return { committed: true, signature: null };
}

export async function executeCheckout(
  instructions: string,
  referrerText: string,
  admission: CheckoutAdmissionSuccess,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let rpcUrl: string;
  let wallet: string;
  let listing: Address;
  let providerAgent: Address;
  let operator: Address;
  let moderator: Address;
  let listingSpecHash: Uint8Array;
  let listingSpecHashHex: string;
  let attestorUrl: string;
  let referrer: Address | null = null;
  try {
    rpcUrl = new URL(requiredEnv("AGENC_RPC_URL")).toString();
    wallet = requiredEnv("AGENC_WALLET");
    listing = parsedAddress("AGENC_LISTING");
    providerAgent = parsedAddress("AGENC_PROVIDER_AGENT");
    operator = parsedAddress("AGENC_OPERATOR");
    moderator = parsedAddress("AGENC_MODERATOR");
    listingSpecHashHex = requiredEnv("AGENC_LISTING_SPEC_HASH").toLowerCase();
    listingSpecHash = values.hexToBytes(listingSpecHashHex);
    if (listingSpecHash.byteLength !== 32 || values.bytesToHex(listingSpecHash) !== listingSpecHashHex) {
      throw new Error("AGENC_LISTING_SPEC_HASH must be 64 canonical hexadecimal characters");
    }
    attestorUrl = localAttestorUrl();
  } catch (error) {
    admission.abort();
    return { status: 501, body: { error: (error as Error).message } };
  }
  if (referrerText !== "") {
    try {
      if (REFERRER_FEE_BPS <= 0) throw new Error("this checkout does not configure a referrer fee");
      referrer = address(referrerText);
    } catch (error) {
      admission.abort();
      return { status: 400, body: { error: "invalid referrer: " + (error as Error).message } };
    }
  }

  let signer: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>;
  try {
    signer = await createKeyPairSignerFromBytes(loadWalletFile(wallet));
  } catch {
    admission.abort();
    return { status: 503, body: { error: "signer wallet failed safety validation" } };
  }
  if (signer.address === moderator) {
    admission.abort();
    return {
      status: 503,
      body: {
        error: "AGENC_MODERATOR must be a separate attestor-funded wallet, not the checkout signer",
      },
    };
  }

  const rpc = createSolanaRpc(rpcUrl);
  let clusterIdentity: string;
  try {
    const untrustedClusterIdentity: unknown = await rpc.getGenesisHash().send();
    if (
      typeof untrustedClusterIdentity !== "string" ||
      untrustedClusterIdentity.length === 0 ||
      untrustedClusterIdentity.length > 64 ||
      !/^[1-9A-HJ-NP-Za-km-z]+$/u.test(untrustedClusterIdentity)
    ) {
      throw new Error("invalid genesis hash");
    }
    clusterIdentity = untrustedClusterIdentity;
  } catch {
    admission.abort();
    return { status: 503, body: { error: "RPC cluster identity could not be verified" } };
  }
  const publicCluster = PUBLIC_CLUSTER_GENESIS.get(clusterIdentity);
  if (publicCluster !== undefined) {
    admission.abort();
    return {
      status: 503,
      body: {
        error: "generated local-only checkout refuses public Solana cluster " + publicCluster,
      },
    };
  }

  const fingerprint = intentFingerprint({
    creator: signer.address,
    clusterIdentity,
    listing,
    operator,
    providerAgent,
    listingSpecHash: listingSpecHashHex,
    moderator,
    instructions,
    referrer,
  });
  if (!admission.bindIntent(fingerprint)) {
    admission.abort();
    return { status: 409, body: { error: "idempotency key was already bound to a different checkout intent" } };
  }
  if (admission.cachedBody !== undefined) {
    admission.complete(admission.cachedBody);
    return { status: 200, body: admission.cachedBody };
  }
  const saved = isRecovery(admission.recovery) ? admission.recovery : undefined;
  if (admission.recovery !== undefined && saved === undefined) {
    admission.preserve(admission.recovery);
    return { status: 503, body: { error: "saved checkout recovery state is invalid; key remains locked" } };
  }
  if (saved?.progress?.phase === "activating" && saved.progress.moderator !== moderator) {
    admission.preserve(admission.recovery);
    return { status: 503, body: { error: "saved activation moderator does not match AGENC_MODERATOR; key remains locked" } };
  }

  const client = createMarketplaceClient({ rpc, signer, commitment: "finalized" });
  try {
    const configured = checkoutMaximumDebitLamports();
    const required = await minimumReviewedDebit(rpc);
    if (configured < required) {
      throw new Error(
        "AGENC_CHECKOUT_MAX_DEBIT_LAMPORTS is below live reward+rent+fee requirements (minimum " +
          required.toString() +
          ")",
      );
    }
  } catch (error) {
    admission.abort();
    return { status: 503, body: { error: (error as Error).message } };
  }

  let version: bigint;
  if (saved !== undefined) {
    // A genuine SDK post-send recovery remains bound to the original CAS
    // version. Provider changes must not turn it into a fresh spend under a
    // different intent.
    version = saved.expectedVersion;
  } else {
    try {
      const live = (await fetchServiceListing(rpc, listing, { commitment: "finalized" })).data;
      if (
        live.providerAgent !== providerAgent ||
        live.operator !== operator ||
        live.operatorFeeBps !== EXPECTED_OPERATOR_FEE_BPS ||
        live.defaultDeadlineSecs !== EXPECTED_DEFAULT_DEADLINE_SECS ||
        live.requiredCapabilities !== EXPECTED_REQUIRED_CAPABILITIES ||
        live.state !== ListingState.Active ||
        live.price !== EXPECTED_PRICE_LAMPORTS ||
        !isNone(live.priceMint) ||
        !bytesEqual(live.specHash, listingSpecHash)
      ) {
        admission.abort();
        return { status: 409, body: { error: "live listing terms do not match this reviewed checkout" } };
      }
      version = live.version;
    } catch (error) {
      admission.abort();
      return { status: 503, body: { error: "live listing could not be verified: " + (error as Error).message } };
    }
  }

  const jobSpec = { instructions };
  let storedJobSpec: Awaited<ReturnType<typeof storeJobSpec>>;
  try {
    storedJobSpec =
      saved?.progress.phase === "hiring" ||
      saved?.progress.phase === "activating"
        ? {
            jobSpecHash: new Uint8Array(saved.storedJobSpec.jobSpecHash),
            jobSpecUri: saved.storedJobSpec.jobSpecUri,
          }
        : await storeJobSpec(jobSpec);
    await verifyPublishedJobSpec(storedJobSpec, jobSpec);
  } catch {
    admission.abort();
    return {
      status: 503,
      body: {
        error: saved === undefined
          ? "job-spec publish/readback failed; no hire was sent"
          : "saved post-send recovery exists, but job-spec readback failed; retry with the same idempotency key",
      },
    };
  }

  const taskId = saved?.taskId ?? values.randomId32();
  const recovery = (progress: HireAndActivateProgress): Recovery => ({
    taskId,
    expectedVersion: version,
    storedJobSpec,
    progress,
  });
  if (!admission.checkpoint()) {
    admission.abort();
    return {
      status: 409,
      body: {
        error: "checkout ownership expired before hire submission; no transaction was sent",
      },
    };
  }
  const orchestration = {
    hire: {
      listing,
      providerAgent,
      taskId,
      expectedPrice: EXPECTED_PRICE_LAMPORTS,
      expectedVersion: version,
      reviewWindowSecs: 3600n,
      listingSpecHash,
      taskJobSpecHash: storedJobSpec.jobSpecHash,
      moderator,
      ...(referrer === null ? {} : { referrer, referrerFeeBps: REFERRER_FEE_BPS }),
    },
    jobSpec,
    hostAndModerateJobSpec: async (host: { taskPda: Address }) => {
      await verifyAttestorModerator(attestorUrl, moderator);
      await requestSandboxAttestation({
        kind: "task",
        address: host.taskPda,
        specHash: storedJobSpec.jobSpecHash,
        endpoint: attestorUrl,
      });
      const [taskModeration] = await findTaskModerationPda({
        task: host.taskPda,
        jobSpecHash: storedJobSpec.jobSpecHash,
        moderator,
      });
      return {
        ...storedJobSpec,
        moderationAttested: true,
        moderator,
        moderation: { taskModeration },
      };
    },
    rpc,
    rpcUrl,
  };

  let attemptedProgress = saved?.progress;
  try {
    const progress = attemptedProgress;
    if (progress?.phase === "activating") {
      const activation = await reconcileActivation(rpc, signer.address, progress);
      if (activation.committed) {
        const responseBody = {
          task: progress.taskPda,
          hireSignature: progress.hireSignature === "" ? null : progress.hireSignature,
          hireReconciled: progress.hireReconciled === true,
          activationSignature: activation.signature,
          activationReconciled: true,
        };
        admission.complete(responseBody);
        return { status: 200, body: responseBody };
      }
    }
    const result = progress === undefined
      ? await hireAndActivate(client, orchestration)
      : await resumeHireAndActivate(client, orchestration, progress);
    const responseBody = {
      task: result.taskPda,
      hireSignature: result.hireSignature === "" ? null : result.hireSignature,
      hireReconciled: result.hireReconciled === true,
      activationSignature: result.activationSignature === "" ? null : result.activationSignature,
      activationReconciled: result.activationReconciled,
      moderation: result.moderation,
    };
    admission.complete(responseBody);
    return { status: 200, body: responseBody };
  } catch (error) {
    if (error instanceof HireAndActivateFinalizedFailure) {
      if (!isCanonicalTransactionSignature(error.signature)) {
        if (attemptedProgress !== undefined) {
          admission.preserve(recovery(attemptedProgress));
        } else {
          admission.block(
            "checkout outcome is locked: SDK returned an invalid finalized-failure signature",
          );
        }
        return {
          status: 503,
          body: {
            error: attemptedProgress !== undefined
              ? "SDK returned an invalid finalized-failure signature; recovery was not discarded and this key is locked"
              : "SDK returned an invalid finalized-failure signature; the outcome cannot be proved safe to retry and this key is locked",
          },
        };
      }
      admission.discardRecovery();
      return {
        status: 503,
        body: {
          error: "hire transaction failed atomically at finalized commitment; no hire was funded and this idempotency key may be retried",
          signature: error.signature,
        },
      };
    }
    if (error instanceof HireAndActivateError) {
      const sdkRecovery = recovery(error.progress);
      admission.preserve(sdkRecovery);
      if (!isRecovery(sdkRecovery)) {
        return {
          status: 503,
          body: {
            error: "SDK returned an invalid post-send recovery token; this idempotency key remains locked",
          },
        };
      }
      return {
        status: 503,
        body: {
          error:
            error.progress.phase === "hiring"
              ? "hire submission outcome is not finalized; retry only with the same idempotency key"
              : "hire committed but activation is incomplete; retry with the same idempotency key",
          task: error.progress.taskPda,
          phase: error.progress.phase,
        },
      };
    }
    if (attemptedProgress !== undefined) {
      admission.preserve(recovery(attemptedProgress));
      return {
        status: 503,
        body: {
          error: "saved post-hire recovery could not be reconciled; retry the same idempotency key",
          task: attemptedProgress.taskPda,
          phase: attemptedProgress.phase,
        },
      };
    }
    // The SDK contract wraps every post-send outcome in HireAndActivateError.
    // A generic error therefore carries no resumable send evidence and is
    // treated as preflight: release the idempotency key instead of fabricating
    // an account-state recovery token.
    admission.abort();
    return {
      status: 503,
      body: { error: "hire was not submitted; fix the preflight failure and retry this idempotency key" },
    };
  }
}
`;
}

/**
 * Next.js App Router checkout page — GET /agenc. Server component, zero
 * client JS: documents the deliberately disabled-by-default funded endpoint.
 */
export function appCheckoutPage(config: AgencConfig): string {
  return `// ${MARKER}
// Safe to edit; re-run \`agenc init --force\` to regenerate.
//
// GET /agenc — safe-default checkout information for "${commentSafeName(config.name)}".
// The funded POST route remains disabled in production until the application
// supplies real auth and durable admission policy.
const SERVICE_NAME = ${sourceStringLiteral(config.name)};
const PRICE_SOL = ${sourceStringLiteral(lamportsAsSol(config.listing.priceLamports))};
const SETTLEMENT_COPY = ${sourceStringLiteral(settlementCopy(config))};

export default function AgencCheckoutPage() {
  return (
    <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "system-ui" }}>
      <h1>{SERVICE_NAME}</h1>
      <p>Hire this service through the AgenC marketplace — {PRICE_SOL} SOL. {SETTLEMENT_COPY}</p>
      <p>
        Funded checkout is disabled by default. Connect this endpoint to your
        authenticated application and durable idempotency/spend policy before
        exposing a hire button.
      </p>
    </main>
  );
}
`;
}

/**
 * Next.js App Router route handler — POST /agenc/checkout.
 */
export function appCheckoutRoute(config: AgencConfig): string {
  void config;
  return `// ${MARKER}
// Safe to edit; regenerate with agenc init --force.
//
// POST /agenc/checkout is a header-authenticated LOCALNET development aid.
// Production is deliberately refused until your application supplies durable
// authorization, idempotency/recovery, and audited wallet-debit controls.
//
// Required local environment:
//   AGENC_ENABLE_DEV_CHECKOUT=1
//   AGENC_NETWORK=localnet
//   AGENC_RPC_URL=http://127.0.0.1:<port>
//   AGENC_CHECKOUT_SECRET=<header secret>
//   AGENC_CHECKOUT_MAX_DEBIT_LAMPORTS=<reviewed per-checkout worst case>
//   AGENC_CHECKOUT_HOURLY_DEBIT_LIMIT_LAMPORTS=<total wallet-debit budget>
//   AGENC_CHECKOUT_TX_FEE_BUDGET_LAMPORTS=<reviewed per-checkout fee reserve>
//   AGENC_WALLET / AGENC_LISTING / AGENC_PROVIDER_AGENT / AGENC_OPERATOR
//   AGENC_LISTING_SPEC_HASH / AGENC_MODERATOR / AGENC_ATTESTOR_URL
//   AGENC_JOB_SPEC_DIR / AGENC_JOB_SPEC_PUBLIC_BASE_URL
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { admitCheckout } from "../checkout-policy";
import {
  checkoutMaximumDebitLamports,
  executeCheckout,
} from "../checkout-core";

const MAX_BODY_BYTES = 16 * 1024;

async function readCheckoutBody(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new TypeError("content-type must be application/x-www-form-urlencoded");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new RangeError("request body exceeds 16384 bytes");
  }
  if (request.body === null) return new URLSearchParams();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new RangeError("request body exceeds 16384 bytes");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export async function POST(request: Request): Promise<Response> {
  let maximumDebitLamports: bigint;
  try {
    maximumDebitLamports = checkoutMaximumDebitLamports();
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 503 });
  }
  const admission = admitCheckout(request.headers, maximumDebitLamports);
  if (!admission.ok) return Response.json(admission.body, { status: admission.status });

  let form: URLSearchParams;
  try {
    form = await readCheckoutBody(request);
  } catch (error) {
    admission.abort();
    return Response.json(
      { error: (error as Error).message },
      { status: error instanceof RangeError ? 413 : 400 },
    );
  }
  const instructions = (form.get("instructions") ?? "").trim();
  if (instructions === "" || new TextEncoder().encode(instructions).byteLength > 8 * 1024) {
    admission.abort();
    return Response.json({ error: "instructions are required and must fit 8192 UTF-8 bytes" }, { status: 400 });
  }
  const referrer = (form.get("referrer") ?? "").trim();
  const result = await executeCheckout(instructions, referrer, admission);
  return Response.json(result.body, { status: result.status });
}
`;
}

/** Pages Router checkout information page. */
export function pagesCheckoutPage(config: AgencConfig): string {
  return `// ${MARKER}
// Safe to edit; regenerate with agenc init --force.
//
// /agenc is informational. The generated funded API is local-development only
// and always refuses production.
export default function AgencCheckoutPage() {
  const priceSol = ${sourceStringLiteral(lamportsAsSol(config.listing.priceLamports))};
  const settlement = ${sourceStringLiteral(settlementCopy(config))};
  return (
    <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "system-ui" }}>
      <h1>{${sourceStringLiteral(config.name)}}</h1>
      <p>Hire this service through the AgenC marketplace — {priceSol} SOL. {settlement}</p>
      <p>
        Funded checkout is disabled by default. Add production authorization,
        durable idempotency/recovery, and audited spend controls before launch.
      </p>
    </main>
  );
}
`;
}

/** Pages Router fallback API route: delegates to the same plain-SDK flow. */
export function pagesCheckoutApi(config: AgencConfig): string {
  void config;
  return `// ${MARKER}
// Safe to edit; regenerate with agenc init --force.
//
// POST /api/agenc/checkout is the Pages Router adapter for the same local-only
// funded checkout core. Helpers live under lib/agenc so Next does not interpret
// them as API endpoints.
// Required environment is identical to the App Router header, including
// AGENC_PROVIDER_AGENT and all three AGENC_CHECKOUT_* debit-budget variables.
import type { NextApiRequest, NextApiResponse } from "next";
import { admitCheckout } from "../../../lib/agenc/checkout-policy";
import {
  checkoutMaximumDebitLamports,
  executeCheckout,
} from "../../../lib/agenc/checkout-core";

export const config = { api: { bodyParser: false } };
const MAX_BODY_BYTES = 16 * 1024;

function requestHeaders(req: NextApiRequest): { get(name: string): string | null } {
  return {
    get(name) {
      const value = req.headers[name.toLowerCase()];
      return typeof value === "string" ? value : Array.isArray(value) ? (value[0] ?? null) : null;
    },
  };
}

async function readCheckoutBody(req: NextApiRequest): Promise<URLSearchParams> {
  const contentType = String(req.headers["content-type"] ?? "").split(";", 1)[0]?.trim();
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new TypeError("content-type must be application/x-www-form-urlencoded");
  }
  const declared = req.headers["content-length"];
  if (typeof declared === "string" && (!/^\\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new RangeError("request body exceeds 16384 bytes");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    length += chunk.byteLength;
    if (length > MAX_BODY_BYTES) throw new RangeError("request body exceeds 16384 bytes");
    chunks.push(chunk);
  }
  return new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let maximumDebitLamports: bigint;
  try {
    maximumDebitLamports = checkoutMaximumDebitLamports();
  } catch (error) {
    return res.status(503).json({ error: (error as Error).message });
  }
  const admission = admitCheckout(requestHeaders(req), maximumDebitLamports);
  if (!admission.ok) return res.status(admission.status).json(admission.body);

  let form: URLSearchParams;
  try {
    form = await readCheckoutBody(req);
  } catch (error) {
    admission.abort();
    return res.status(error instanceof RangeError ? 413 : 400).json({ error: (error as Error).message });
  }
  const instructions = (form.get("instructions") ?? "").trim();
  if (instructions === "" || new TextEncoder().encode(instructions).byteLength > 8 * 1024) {
    admission.abort();
    return res.status(400).json({ error: "instructions are required and must fit 8192 UTF-8 bytes" });
  }
  const referrer = (form.get("referrer") ?? "").trim();
  const result = await executeCheckout(instructions, referrer, admission);
  return res.status(result.status).json(result.body);
}
`;
}
export function workerLoopMjs(config: AgencConfig): string {
  return `#!/usr/bin/env node
// ${MARKER}
// Safe to edit; re-run \`agenc init --force\` to regenerate.
//
// worker.mjs — "${commentSafeName(config.name)}" earning on the AgenC marketplace through the
// @tetsuo-ai/agenc-worker programmatic API: register once, watch claim
// candidates, claim -> execute (your own coding-agent CLI) -> submit, and report
// settlements (with receipt URLs when observable).
//
// Run:  AGENC_WORKER_RPC_URL=<rpc> AGENC_WORKER_WALLET=<keypair.json> \\
//       AGENC_WORKER_MAX_REWARD_LAMPORTS=<finite-cap> \\
//       AGENC_WORKER_CREATOR_ALLOWLIST=<trusted-creator-wallet> \\
//       AGENC_WORKER_STATE_DIR=<private-project-specific-state-dir> \\
//       AGENC_WORKER_ENDPOINT=<usable-public-endpoint> node worker.mjs
// (or put rpcUrl/walletPath in ~/.config/agenc-worker/config.json)
import { createKeyPairSignerFromBytes, createSolanaRpc } from "@solana/kit";
import { createMarketplaceClient, taskThread } from "@tetsuo-ai/marketplace-sdk";
import {
  configFromEnv,
  createSolanaAccountReaders,
  DEFAULT_ENDPOINT,
  defaultConfigPath,
  findVerifiedSettlementSignature,
  loadConfigFile,
  loadSolanaKeypairFile,
  resolveWorkerConfig,
  runUp,
} from "@tetsuo-ai/agenc-worker";

const environmentConfig = configFromEnv(process.env);
const fileConfig = loadConfigFile(
  process.env.AGENC_WORKER_CONFIG ?? defaultConfigPath(),
  { explicit: process.env.AGENC_WORKER_CONFIG !== undefined },
);
if (environmentConfig.stateDir === undefined && fileConfig.stateDir === undefined) {
  throw new Error(
    "Set AGENC_WORKER_STATE_DIR (or config stateDir) to a private project-specific directory",
  );
}
const config = resolveWorkerConfig(
  // resolveWorkerConfig is first-source-wins: env and the operator's config
  // must precede generated project fallbacks.
  environmentConfig,
  fileConfig,
);
if (config.endpoint === DEFAULT_ENDPOINT) {
  throw new Error(
    "Set AGENC_WORKER_ENDPOINT (or config endpoint) to this worker's reviewed usable HTTP(S) endpoint",
  );
}

const signer = await createKeyPairSignerFromBytes(
  loadSolanaKeypairFile(config.walletPath),
);
const rpc = createSolanaRpc(config.rpcUrl);
const client = createMarketplaceClient({ rpc, signer });
const { readAccount, readAccountInfo } = createSolanaAccountReaders(async (address) => {
  const { value } = await rpc
    .getAccountInfo(address, { commitment: "confirmed", encoding: "base64" })
    .send();
  return value;
});

const ctx = {
  config,
  client,
  signer,
  gpa: rpc,
  readAccount,
  readAccountInfo,
  getBalance: async (address) =>
    BigInt((await rpc.getBalance(address, { commitment: "confirmed" }).send()).value),
  getMinimumBalanceForRentExemption: async (space) =>
    BigInt(
      await rpc
        .getMinimumBalanceForRentExemption(BigInt(space), {
          commitment: "finalized",
        })
        .send(),
    ),
  stateDir: config.stateDir,
  log: (event) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...event })),
  taskThreadTransport: taskThread.createContentTransport({
    baseUrl: config.taskThreadBaseUrl,
  }),
  findSettlementSignature: async (task) =>
    findVerifiedSettlementSignature(rpc, task),
};

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
await runUp(ctx, { signal: controller.signal });
`;
}
