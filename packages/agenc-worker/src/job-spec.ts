// Fetch + verify a task's pinned job spec BEFORE claiming.
//
// The on-chain `TaskJobSpec` pointer carries a 32-byte `jobSpecHash` and a
// `jobSpecUri`. The worker resolves a full job-spec envelope, canonicalizes its
// payload with the SDK's normative `json-stable-v1` contract, and FAILS CLOSED
// unless that payload hash equals both the envelope's integrity hash and the
// on-chain commitment. Public http(s) is supported directly. `agenc://` is
// supported only through an explicitly injected trusted resolver and never as
// an empty-content bypass. Every other scheme is refused outright.
import { timingSafeEqual } from "node:crypto";
import { promises as dns } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { Address } from "@solana/kit";
import {
  findTaskJobSpecPda,
  getTaskJobSpecDecoder,
  values,
} from "@tetsuo-ai/marketplace-sdk";

/** Read raw account bytes; `null` when the account does not exist. */
export type AccountReader = (address: Address) => Promise<Uint8Array | null>;

/** Download a URI's raw bytes (injectable for tests). */
export type UriFetcher = (uri: string) => Promise<Uint8Array>;

/** Cap on downloaded job-spec size (bytes). */
export const DEFAULT_MAX_JOB_SPEC_BYTES = 64 * 1024;

/** Maximum redirects followed by the hardened default downloader. */
export const DEFAULT_MAX_JOB_SPEC_REDIRECTS = 5;

/** One DNS result used to pin a connection after validation. */
export type ResolvedAddress = { address: string; family: 4 | 6 };

/** Injectable only so the DNS-rebinding and redirect policy can be unit-tested. */
export type HostResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

type HopResponse =
  | { kind: "redirect"; location: string }
  | { kind: "success"; bytes: Uint8Array };

/** Injectable transport seam. Production always uses the pinned native transport. */
export type PinnedHttpRequester = (options: {
  url: URL;
  address: ResolvedAddress;
  maxBytes: number;
  signal: AbortSignal;
}) => Promise<HopResponse>;

/** Thrown on any job-spec verification failure — the task is NOT claimed. */
export class JobSpecError extends Error {
  override name = "JobSpecError";
}

/** A verified job spec, ready to feed the executor prompt. */
export type VerifiedJobSpec = {
  /** The on-chain 32-byte commitment. */
  jobSpecHash: Uint8Array;
  /** The on-chain pointer URI. */
  jobSpecUri: string;
  /** Canonical JSON bytes of the verified envelope payload. */
  content: Uint8Array;
};

function ipv4Number(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = result * 256 + octet;
  }
  return result;
}

function ipv4InCidr(value: number, base: string, prefix: number): boolean {
  const baseValue = ipv4Number(base)!;
  const divisor = 2 ** (32 - prefix);
  return Math.floor(value / divisor) === Math.floor(baseValue / divisor);
}

function ipv6Number(input: string): bigint | null {
  let value = input.toLowerCase();
  if (value.includes("%")) return null; // scoped/link-local literals are never public.
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    const v4 = ipv4Number(value.slice(lastColon + 1));
    if (lastColon < 0 || v4 === null) return null;
    value = `${value.slice(0, lastColon)}:${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  if ((value.match(/::/g) ?? []).length > 1) return null;
  const [leftRaw, rightRaw] = value.split("::");
  const left = leftRaw === "" ? [] : leftRaw!.split(":");
  const right = rightRaw === undefined || rightRaw === "" ? [] : rightRaw.split(":");
  const missing = 8 - left.length - right.length;
  if (rightRaw === undefined ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))
  ) {
    return null;
  }
  return groups.reduce((total, group) => (total << 16n) | BigInt(`0x${group}`), 0n);
}

function ipv6InCidr(value: bigint, base: string, prefix: number): boolean {
  const baseValue = ipv6Number(base)!;
  const shift = BigInt(128 - prefix);
  return value >> shift === baseValue >> shift;
}

/**
 * True only for globally routable unicast addresses. This deliberately
 * rejects documentation, transition, benchmarking, multicast, reserved, and
 * address-translation ranges as well as the familiar private/link-local
 * ranges: several translation ranges can otherwise tunnel a private IPv4
 * target through an apparently-global IPv6 literal.
 */
export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    if (value === null) return false;
    const blocked: Array<[string, number]> = [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.88.99.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ];
    return !blocked.some(([base, prefix]) => ipv4InCidr(value, base, prefix));
  }
  if (family === 6) {
    const value = ipv6Number(address);
    if (value === null) return false;
    // Current globally-routable unicast allocation. Fail closed on future or
    // local-use prefixes until they are deliberately reviewed.
    if (!ipv6InCidr(value, "2000::", 3)) return false;
    const blocked: Array<[string, number]> = [
      ["::", 96], // unspecified and obsolete IPv4-compatible addresses
      ["::ffff:0:0", 96], // IPv4-mapped addresses
      ["64:ff9b::", 96], // NAT64 can encode a private IPv4 destination
      ["64:ff9b:1::", 48],
      ["100::", 64],
      ["2001::", 32], // Teredo
      ["2001:2::", 48],
      ["2001:10::", 28],
      ["2001:20::", 28],
      ["2001:db8::", 32],
      ["2002::", 16], // 6to4 can encode a private IPv4 destination
      ["3fff::", 20],
      ["5f00::", 16],
      ["fc00::", 7],
      ["fe80::", 10],
      ["fec0::", 10],
      ["ff00::", 8],
    ];
    return !blocked.some(([base, prefix]) => ipv6InCidr(value, base, prefix));
  }
  return false;
}

function hostnameWithoutBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function validateFetchUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new JobSpecError(
      `refusing job-spec URI scheme ${url.protocol.slice(0, -1)} — only public http(s) is fetched`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new JobSpecError("refusing job-spec URI containing credentials");
  }
  if (url.hostname === "") throw new JobSpecError("job-spec URI has no hostname");
}

async function defaultResolver(hostname: string): Promise<readonly ResolvedAddress[]> {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map(({ address, family }) => {
    if (family !== 4 && family !== 6) {
      throw new JobSpecError(`unsupported address family ${family} for ${hostname}`);
    }
    return { address, family };
  });
}

async function resolvePublicAddress(
  url: URL,
  resolver: HostResolver,
): Promise<ResolvedAddress> {
  const hostname = hostnameWithoutBrackets(url.hostname);
  let addresses: readonly ResolvedAddress[];
  if (isIP(hostname) !== 0) {
    addresses = [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
  } else {
    addresses = await resolver(hostname);
  }
  if (addresses.length === 0) {
    throw new JobSpecError(`job-spec hostname ${hostname} resolved to no addresses`);
  }
  // Reject the entire answer when even one record is non-public. Besides
  // blocking direct private targets, this prevents mixed-answer rebinding
  // tricks where connection retry semantics select a different record.
  const nonPublic = addresses.find(({ address }) => !isPublicIpAddress(address));
  if (nonPublic !== undefined) {
    throw new JobSpecError(
      `refusing non-public job-spec target ${hostname} (${nonPublic.address})`,
    );
  }
  return addresses[0]!;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function defaultPinnedRequester(options: {
  url: URL;
  address: ResolvedAddress;
  maxBytes: number;
  signal: AbortSignal;
}): Promise<HopResponse> {
  const { url, address, maxBytes, signal } = options;
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const originalHostname = hostnameWithoutBrackets(url.hostname);
    const request = transport.get(
      {
        protocol: url.protocol,
        // Connect directly to the validated address. There is no second DNS
        // lookup at all, closing the lookup/connect rebinding window.
        hostname: address.address,
        family: address.family,
        port: url.port === "" ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        // Preserve the original authority at the HTTP and TLS layers. For a
        // DNS hostname, certificate verification is performed against SNI;
        // for an IP literal Node verifies against the connected IP.
        ...(url.protocol === "https:" && isIP(originalHostname) === 0
          ? { servername: originalHostname }
          : {}),
        headers: {
          accept: "application/json, text/plain;q=0.9, application/octet-stream;q=0.8",
          host: url.host,
          "user-agent": "agenc-worker/job-spec",
        },
        signal,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (REDIRECT_STATUSES.has(status)) {
          const location = response.headers.location;
          response.resume();
          if (location === undefined) {
            reject(new JobSpecError(`job-spec redirect ${status} has no Location header`));
          } else {
            resolve({ kind: "redirect", location });
          }
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          reject(
            new JobSpecError(
              `job-spec download failed: ${status} ${response.statusMessage ?? ""}`.trim(),
            ),
          );
          return;
        }
        const declared = response.headers["content-length"];
        if (
          typeof declared === "string" &&
          /^\d+$/.test(declared) &&
          BigInt(declared) > BigInt(maxBytes)
        ) {
          response.destroy();
          reject(
            new JobSpecError(
              `job spec exceeds the ${maxBytes}-byte cap (content-length ${declared})`,
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > maxBytes) {
            response.destroy(
              new JobSpecError(`job spec exceeds the ${maxBytes}-byte cap`),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({ kind: "success", bytes: new Uint8Array(Buffer.concat(chunks)) });
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
  });
}

/**
 * Build the production-safe downloader. Every hop is parsed and resolved,
 * every answer must contain public IPs only, and the validated address is
 * pinned into the socket connection to defeat DNS rebinding.
 */
export function createPublicUriFetcher(options: {
  maxBytes: number;
  maxRedirects?: number;
  resolver?: HostResolver;
  requester?: PinnedHttpRequester;
}): UriFetcher {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new JobSpecError("job-spec byte cap must be a positive safe integer");
  }
  const resolver = options.resolver ?? defaultResolver;
  const requester = options.requester ?? defaultPinnedRequester;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_JOB_SPEC_REDIRECTS;
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) {
    throw new JobSpecError("job-spec redirect cap must be a non-negative safe integer");
  }
  return async (uri) => {
    let current: URL;
    try {
      current = new URL(uri);
    } catch {
      throw new JobSpecError(`job-spec URI is not a valid URL: ${JSON.stringify(uri)}`);
    }
    // One wall-clock budget covers DNS, every redirect, and body streaming.
    const signal = AbortSignal.timeout(30_000);
    for (let redirects = 0; ; redirects += 1) {
      validateFetchUrl(current);
      let address: ResolvedAddress;
      try {
        address = await withAbort(resolvePublicAddress(current, resolver), signal);
      } catch (error) {
        if (error instanceof JobSpecError) throw error;
        if (signal.aborted) throw new JobSpecError("job-spec download timed out after 30000ms");
        throw new JobSpecError(
          `job-spec DNS lookup failed for ${current.hostname}: ${(error as Error).message}`,
        );
      }
      let response: HopResponse;
      try {
        response = await requester({
          url: current,
          address,
          maxBytes: options.maxBytes,
          signal,
        });
      } catch (error) {
        if (error instanceof JobSpecError) throw error;
        if (signal.aborted) {
          throw new JobSpecError("job-spec download timed out after 30000ms");
        }
        throw new JobSpecError(
          `job-spec download failed: ${(error as Error).message}`,
        );
      }
      if (response.kind === "success") return response.bytes;
      if (redirects >= maxRedirects) {
        throw new JobSpecError(`job-spec download exceeded ${maxRedirects} redirects`);
      }
      try {
        current = new URL(response.location, current);
      } catch {
        throw new JobSpecError(
          `job-spec redirect has an invalid Location: ${JSON.stringify(response.location)}`,
        );
      }
    }
  };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/**
 * `agenc://` has no built-in network meaning. Require its canonical
 * content-address form before handing it to a trusted embedding-specific
 * resolver, and bind that address to the same on-chain commitment.
 */
function validateAgencJobSpecUri(
  task: Address,
  url: URL,
  expectedHashHex: string,
): void {
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new JobSpecError(
      `task ${task}: malformed AgenC job-spec URI — credentials, ports, query, and fragment are forbidden`,
    );
  }
  if (url.hostname !== "job-spec") {
    throw new JobSpecError(
      `task ${task}: malformed AgenC job-spec URI — expected host job-spec`,
    );
  }
  const match = /^\/sha256\/([0-9a-f]{64})$/.exec(url.pathname);
  if (match === null) {
    throw new JobSpecError(
      `task ${task}: malformed AgenC job-spec URI — expected /sha256/<64 lowercase hex>`,
    );
  }
  if (match[1] !== expectedHashHex) {
    throw new JobSpecError(
      `task ${task}: AgenC URI hash does not match the on-chain commitment ` +
        `(expected ${expectedHashHex}, got ${match[1]})`,
    );
  }
}

async function verifyJobSpecEnvelope(
  task: Address,
  envelopeBytes: Uint8Array,
  onChainHash: Uint8Array,
): Promise<Uint8Array> {
  let parsed: unknown;
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(envelopeBytes);
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new JobSpecError(
      `task ${task}: job-spec document is not a valid UTF-8 JSON envelope`,
    );
  }
  if (!isJsonObject(parsed)) {
    throw new JobSpecError(`task ${task}: job-spec envelope must be a JSON object`);
  }
  if (!isJsonObject(parsed.integrity)) {
    throw new JobSpecError(
      `task ${task}: job-spec envelope.integrity must be a JSON object`,
    );
  }
  if (parsed.integrity.algorithm !== "sha256") {
    throw new JobSpecError(
      `task ${task}: job-spec envelope integrity.algorithm must be "sha256"`,
    );
  }
  if (parsed.integrity.canonicalization !== "json-stable-v1") {
    throw new JobSpecError(
      `task ${task}: job-spec envelope integrity.canonicalization must be "json-stable-v1"`,
    );
  }
  const declaredPayloadHash = parsed.integrity.payloadHash;
  if (
    typeof declaredPayloadHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(declaredPayloadHash)
  ) {
    throw new JobSpecError(
      `task ${task}: job-spec envelope integrity.payloadHash must be 64 lowercase hex characters`,
    );
  }
  if (!isJsonObject(parsed.payload)) {
    throw new JobSpecError(
      `task ${task}: job-spec envelope.payload must be a JSON object`,
    );
  }

  let canonicalPayload: string;
  let digest: Awaited<ReturnType<typeof values.canonicalJobSpecHash>>;
  try {
    canonicalPayload = values.canonicalJobSpecJson(parsed.payload);
    digest = await values.canonicalJobSpecHash(parsed.payload);
  } catch (error) {
    throw new JobSpecError(
      `task ${task}: job-spec payload is not valid json-stable-v1 data: ${(error as Error).message}`,
    );
  }

  const matchesOnChain =
    digest.bytes.length === onChainHash.length &&
    timingSafeEqual(digest.bytes, onChainHash);
  if (!matchesOnChain) {
    throw new JobSpecError(
      `task ${task}: job-spec payload hash mismatch — canonical payload does not match ` +
        `the on-chain commitment (expected ${hashHex(onChainHash)}, got ${digest.hex})`,
    );
  }
  if (declaredPayloadHash !== digest.hex) {
    throw new JobSpecError(
      `task ${task}: job-spec envelope integrity.payloadHash mismatch ` +
        `(declared ${declaredPayloadHash}, got ${digest.hex})`,
    );
  }

  // Execute only the canonicalized, verified payload. Envelope transport
  // metadata is deliberately not passed to the executor prompt.
  return new TextEncoder().encode(canonicalPayload);
}

/**
 * Fetch the task's `TaskJobSpec` account, resolve its envelope, and verify the
 * normative json-stable-v1 payload hash. FAILS CLOSED on a missing pointer,
 * an unpinned hash, a malformed envelope/URI, unavailable agenc:// resolver,
 * resolution failure, or either commitment mismatch.
 */
export async function fetchAndVerifyJobSpec(options: {
  task: Address;
  readAccount: AccountReader;
  /** Trusted http(s) injection seam. The default fetcher is public-network-only. */
  fetchUri?: UriFetcher;
  /** Trusted resolver for canonical agenc:// content addresses. No default exists. */
  resolveAgencUri?: UriFetcher;
  maxBytes?: number;
}): Promise<VerifiedJobSpec> {
  const { task, readAccount } = options;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_JOB_SPEC_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new JobSpecError("job-spec byte cap must be a positive safe integer");
  }
  const [jobSpecPda] = await findTaskJobSpecPda({ task });
  const data = await readAccount(jobSpecPda);
  if (data === null) {
    throw new JobSpecError(`task ${task}: no TaskJobSpec pinned (nothing to claim)`);
  }
  const spec = getTaskJobSpecDecoder().decode(data);
  const jobSpecHash = new Uint8Array(spec.jobSpecHash);
  if (jobSpecHash.every((byte) => byte === 0)) {
    throw new JobSpecError(`task ${task}: job-spec hash is all zeros (unpinned)`);
  }

  let url: URL;
  try {
    url = new URL(spec.jobSpecUri);
  } catch {
    throw new JobSpecError(
      `task ${task}: job-spec URI is not a valid URI: ${JSON.stringify(spec.jobSpecUri)}`,
    );
  }

  let envelopeBytes: Uint8Array;
  if (url.protocol === "agenc:") {
    validateAgencJobSpecUri(task, url, hashHex(jobSpecHash));
    if (options.resolveAgencUri === undefined) {
      throw new JobSpecError(
        `task ${task}: no trusted AgenC URI resolver is configured; refusing to claim`,
      );
    }
    try {
      envelopeBytes = await options.resolveAgencUri(spec.jobSpecUri);
    } catch (error) {
      if (error instanceof JobSpecError) throw error;
      throw new JobSpecError(
        `task ${task}: AgenC URI job-spec resolution failed: ${(error as Error).message}`,
      );
    }
  } else if (url.protocol === "http:" || url.protocol === "https:") {
    validateFetchUrl(url);
    // `fetchUri` is an explicit trusted injection seam for embedders/tests.
    // The built-in path is public-network-only and pins validated DNS answers.
    const fetchUri = options.fetchUri ?? createPublicUriFetcher({ maxBytes });
    try {
      envelopeBytes = await fetchUri(spec.jobSpecUri);
    } catch (error) {
      if (error instanceof JobSpecError) throw error;
      throw new JobSpecError(
        `task ${task}: job-spec download failed: ${(error as Error).message}`,
      );
    }
  } else {
    throw new JobSpecError(
      `task ${task}: refusing job-spec URI scheme ${url.protocol.slice(0, -1)} — only public http(s) ` +
        `or a resolver-backed AgenC URI is supported`,
    );
  }

  if (!(envelopeBytes instanceof Uint8Array)) {
    throw new JobSpecError(
      `task ${task}: job-spec resolver returned a non-Uint8Array value`,
    );
  }
  if (envelopeBytes.length > maxBytes) {
    throw new JobSpecError(`task ${task}: job spec exceeds the ${maxBytes}-byte cap`);
  }

  const content = await verifyJobSpecEnvelope(task, envelopeBytes, jobSpecHash);
  return { jobSpecHash, jobSpecUri: spec.jobSpecUri, content };
}
