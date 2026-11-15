// Everything the wallet needs from OUTSIDE the chain, behind one interface:
// the catalog of services, moderation attestations, job-spec hosting and
// delivery storage. The hosted implementation talks to the public AgenC
// services; the sandbox supplies an in-process one.
//
// None of these services is trusted with money. They can refuse or be down
// (the wallet then waits or refunds); they cannot move funds, and every hash
// they return is re-checked here against what the chain recorded.
import { createHash } from "node:crypto";
import { address, type Address, type KeyPairSigner } from "@solana/kit";
import { createPublicUriFetcher, type UriFetcher } from "@tetsuo-ai/agenc-worker";
import { taskThread, values } from "@tetsuo-ai/marketplace-sdk";
import { WalletError } from "./errors.js";

/** One service as a catalog source reports it (chain-shaped, not display). */
export interface CatalogRow {
  listing: Address;
  providerAgent: Address;
  name: string;
  category: string | null;
  summary: string | null;
  priceLamports: bigint;
  /** Average rating 1..5, or null when unrated. */
  rating: number | null;
  ratingCount: number;
  jobsDone: number;
  deliverySecs: number | null;
}

export interface AttestTaskInput {
  task: Address;
  jobSpecHashHex: string;
  jobSpec: Record<string, unknown>;
  /** Where the request was published (see {@link MarketServices.publishJobSpec}). */
  jobSpecUri: string;
  /** The wallet that pays for the approval: the one that posted the job. */
  payer: Address;
}

export interface AttestListingInput {
  listing: Address;
  /** The canonical hash of `spec`, as committed in the listing on-chain. */
  specHashHex: string;
  /** The listing's advertised description (see {@link buildListingSpec}). */
  spec: Record<string, unknown>;
  /** Where the description was published (see {@link MarketServices.publishListing}). */
  specUri: string;
  /** The wallet that pays for the approval: the one that offers the service. */
  payer: Address;
}

export interface PublishListingInput {
  /** The listing's advertised description (see {@link buildListingSpec}). */
  spec: Record<string, unknown>;
  /** The canonical hash of `spec`: what the listing commits to on-chain. */
  specHashHex: string;
  /** The wallet that offers the service. It signs the upload. */
  signer: KeyPairSigner;
}

export interface PublishJobInput {
  /** The name of the service being hired. */
  title: string;
  /** What the buyer wants done, in their words. */
  request: string;
  /** Checks the delivery has to pass. */
  acceptance: readonly string[];
  listing: Address;
  /** The wallet that pays for the job. It signs the upload. */
  signer: KeyPairSigner;
}

/** A job's request as it was published: what a provider will read. */
export interface PublishedJob {
  /** The request in the marketplace's own shape. The hash commits to exactly this. */
  spec: Record<string, unknown>;
  /** Canonical hash of `spec`: the value the hire commits to on-chain. */
  hashHex: string;
  /** Where it can be read. */
  uri: string;
}

/**
 * An approval that passed and is waiting to be paid for: the approver's
 * transaction, which the wallet checks, signs and sends (see approval.ts).
 * It comes from outside and is not trusted until checked.
 */
export interface ApprovalPayment {
  /** The transaction as the approver sent it: signed by it, not yet by the payer. */
  transaction: Uint8Array;
  /** The approver the service says signed it. */
  moderator: Address;
}

/** How the earn side publishes a delivery so the buyer can fetch it. */
export interface ResultUploader {
  /** Passed to the worker runtime as `resultUploader`. */
  url: string;
  /** Passed to the worker runtime as `uploadFetch`. */
  fetch: typeof fetch;
}

export interface MarketServices {
  /** Services a buyer can hire right now. */
  listServices(): Promise<CatalogRow[]>;
  /**
   * Attestation signers this wallet accepts besides the cluster's own
   * moderation authority, most preferred first.
   */
  trustedModerators(): Promise<Address[]>;
  /** Ask for a listing to be attested when no accepted attestation exists. */
  acquireListingAttestation(listing: Address): Promise<void>;
  /**
   * Publish the description of a service this wallet offers where anyone can
   * read it, and return that address: it is what the listing points at. Null
   * when this network has nowhere to publish it, and a service cannot be
   * offered then. Publishing the same description again gives the same
   * address.
   */
  publishListing(input: PublishListingInput): Promise<string | null>;
  /**
   * Publish a job's request where providers can read it, in the shape the
   * marketplace's workers expect. Nothing is paid and nothing is on-chain
   * yet: the hire then commits to the hash returned here. Publishing the same
   * request again gives the same result.
   */
  publishJobSpec(input: PublishJobInput): Promise<PublishedJob>;
  /**
   * Have a listing approved for exactly its published description, so buyers
   * can hire it. The listing must already exist on-chain with this hash.
   * Returns the approval to pay for, or null when it is already recorded.
   */
  attestListing(input: AttestListingInput): Promise<ApprovalPayment | null>;
  /**
   * Have a job's published request approved for exactly
   * `(task, jobSpecHashHex)`. Returns the approval to pay for, or null when
   * it is already recorded.
   */
  attestTask(input: AttestTaskInput): Promise<ApprovalPayment | null>;
  /**
   * Fetch a delivery. `resultData` is the 64-byte pointer the provider
   * recorded with the job. Returns bytes only when they hash to
   * `proofHashHex`; otherwise null.
   */
  fetchResult(input: {
    proofHashHex: string;
    resultData: Uint8Array;
  }): Promise<{ bytes: Uint8Array; uri: string | null } | null>;
  /** Delivery publishing for an agent that earns, or null when unavailable. */
  resultUploader(signer: KeyPairSigner): ResultUploader | null;
  /** Resolver for `agenc://` job-spec addresses the earn side may meet. */
  resolveAgencUri?: UriFetcher;
  /**
   * Publish a buyer's change request where the provider can read it. The
   * request's hash is what goes on-chain; this delivers the words. Absent
   * when the network has no message host, and asking for changes is then
   * unavailable.
   */
  postChangeRequest?(envelope: taskThread.TaskThreadEnvelope): Promise<void>;
  /** The message host the earn side reads change requests from. */
  taskThreadTransport?: ReturnType<typeof taskThread.createContentTransport>;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Read the text a provider wrote into the fixed 64-byte result slot. */
export function decodeResultPointer(resultData: Uint8Array): string {
  let end = resultData.length;
  while (end > 0 && resultData[end - 1] === 0) end -= 1;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(resultData.subarray(0, end)).trim();
  } catch {
    return "";
  }
}

/** The sha-256 hex a result pointer names, when it names one. */
export function digestFromPointer(pointer: string): string | null {
  if (HEX64.test(pointer)) return pointer;
  const hexUri = /^agenc:\/\/(?:result|artifact)\/sha256\/([0-9a-f]{64})$/.exec(pointer);
  if (hexUri) return hexUri[1]!;
  const compact = /^ag:\/\/a\/([A-Za-z0-9_-]{43})$/.exec(pointer);
  if (compact) {
    const bytes = Buffer.from(compact[1]!, "base64url");
    return bytes.length === 32 ? bytes.toString("hex") : null;
  }
  return null;
}

interface JsonResponse {
  status: number;
  body: unknown;
}

/** A bounded, redirect-refusing JSON request to a first-party endpoint. */
async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: {
    method: "GET" | "POST";
    body?: unknown;
    /** JSON that was already serialised, sent byte for byte (a signed upload). */
    bytes?: Uint8Array;
    headers?: Record<string, string>;
  },
  limits: { timeoutMs: number; maxBytes: number },
): Promise<JsonResponse> {
  const payload =
    init.bytes !== undefined
      ? (init.bytes as unknown as NonNullable<RequestInit["body"]>)
      : init.body !== undefined
        ? JSON.stringify(init.body)
        : undefined;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: init.method,
      redirect: "error",
      headers: {
        accept: "application/json",
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      ...(payload !== undefined ? { body: payload } : {}),
      signal: AbortSignal.timeout(limits.timeoutMs),
    });
  } catch (error) {
    throw new WalletError("NETWORK", "The marketplace could not be reached. Try again in a moment.", {
      cause: error,
    });
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limits.maxBytes) {
        await reader.cancel();
        throw new WalletError("NETWORK", "The marketplace sent an answer that was too large.");
      }
      chunks.push(value);
    }
  }
  let body: unknown = null;
  if (total > 0) {
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      body = null;
    }
  }
  return { status: response.status, body };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeAddress(value: unknown): Address | null {
  if (typeof value !== "string") return null;
  try {
    return address(value);
  } catch {
    return null;
  }
}

function safeBigInt(value: unknown): bigint | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  if (!/^(?:0|[1-9][0-9]{0,19})$/.test(text)) return null;
  return BigInt(text);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The largest transaction the network carries, in bytes. */
const MAX_TRANSACTION_BYTES = 1232;

/**
 * The approval a service hands back for the wallet to pay for, or null when
 * its answer holds none. Only the shape is checked here; what the transaction
 * does is checked before anything is signed (approval.ts).
 */
function parsePayment(data: Record<string, unknown>): ApprovalPayment | null {
  const payment = record(data.payment);
  if (payment === null) return null;
  const moderator = safeAddress(data.moderator);
  const text = payment.transaction;
  if (
    moderator !== null &&
    typeof text === "string" &&
    text.length > 0 &&
    text.length <= Math.ceil(MAX_TRANSACTION_BYTES / 3) * 4 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(text)
  ) {
    const transaction = new Uint8Array(Buffer.from(text, "base64"));
    if (transaction.length > 0 && transaction.length <= MAX_TRANSACTION_BYTES) {
      return { transaction, moderator };
    }
  }
  throw new WalletError(
    "NETWORK",
    "The marketplace's safety check sent back something this wallet will not sign. Nothing was paid.",
  );
}

/** Clip untrusted display text to one tidy line. */
export function tidyText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}

export interface HostedServicesOptions {
  /** Public read API with the hireable-listings route. */
  siteUrl?: string;
  /** Public attestation service. */
  attestUrl?: string;
  /**
   * Base of a content-addressed delivery store: a delivery with sha-256 `h`
   * is fetched from `<base>/artifacts/<h>`. Leave unset when none is known;
   * deliveries are then shown only when the provider recorded an https link.
   */
  artifactBaseUrl?: string | null;
  /**
   * Endpoint that stores a delivery for the earn side (signed upload).
   * Leave unset to deliver by fingerprint only.
   */
  artifactUploadUrl?: string | null;
  /**
   * Endpoint that publishes a service's description or a job's request
   * (signed upload). Defaults to the marketplace site's own. Null means
   * there is nowhere to publish, and nothing can be offered or hired.
   */
  specUploadUrl?: string | null;
  fetchImpl?: typeof fetch;
  /** Fetcher for provider-controlled URLs. Defaults to the SSRF-guarded one. */
  publicFetcher?: UriFetcher;
  now?: () => number;
}

export const DEFAULT_SITE_URL = "https://agenc.ag";
export const DEFAULT_ATTEST_URL = "https://attest.agenc.ag";

const CATALOG_TTL_MS = 60_000;
const INFO_TTL_MS = 10 * 60_000;
const MAX_CATALOG_PAGES = 3;
const MAX_RESULT_BYTES = 256 * 1024;

function trimBase(url: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WalletError("BAD_REQUEST", `The ${label} address is not a valid URL.`);
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new WalletError("BAD_REQUEST", `The ${label} address must use https.`);
  }
  return parsed.href.replace(/\/+$/, "");
}

/** The message a wallet signs so the marketplace publishes a description or a request. */
export function specUploadMessage(sha256: string, wallet: string, ts: number): string {
  return `agenc.ag job-spec upload\nsha256: ${sha256}\nwallet: ${wallet}\nts: ${ts}`;
}

/** The message a wallet signs so the artifact store accepts an upload. */
export function artifactUploadMessage(sha256: string, wallet: string, ts: number): string {
  return `agenc.ag artifact upload\nsha256: ${sha256}\nwallet: ${wallet}\nts: ${ts}`;
}

/** Marketplace services backed by the public AgenC endpoints. */
export function createHostedServices(options: HostedServicesOptions = {}): MarketServices {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const siteUrl = trimBase(options.siteUrl ?? DEFAULT_SITE_URL, "marketplace");
  const attestUrl = trimBase(options.attestUrl ?? DEFAULT_ATTEST_URL, "attestation service");
  const artifactBaseUrl =
    options.artifactBaseUrl == null ? null : trimBase(options.artifactBaseUrl, "delivery store");
  const artifactUploadUrl =
    options.artifactUploadUrl == null
      ? null
      : trimBase(options.artifactUploadUrl, "delivery upload");
  const specUploadUrl =
    options.specUploadUrl === null
      ? null
      : trimBase(options.specUploadUrl ?? `${siteUrl}/api/jobspecs`, "description store");
  const publicFetcher =
    options.publicFetcher ?? createPublicUriFetcher({ maxBytes: MAX_RESULT_BYTES });

  let catalog: { at: number; rows: CatalogRow[] } | null = null;
  let info: { at: number; moderator: Address } | null = null;

  /**
   * Hand the marketplace a document to publish, signed by `signer`. It
   * answers with the address, the payload it stored and that payload's hash,
   * and the hash is re-derived here before any of it is believed.
   */
  async function publish(
    signer: KeyPairSigner,
    document: unknown,
    refused: string,
  ): Promise<{ uri: string; hashHex: string; payload: Record<string, unknown> }> {
    if (specUploadUrl === null) {
      throw new WalletError("NOT_AVAILABLE", "This network has nowhere to publish that yet.");
    }
    const bytes = new TextEncoder().encode(JSON.stringify(document));
    const ts = now();
    const message = new TextEncoder().encode(
      specUploadMessage(sha256Hex(bytes), signer.address, ts),
    );
    const [signed] = await signer.signMessages([{ content: message, signatures: {} }]);
    const signature = signed?.[signer.address];
    if (signature === undefined) {
      throw new WalletError("INTERNAL", "The upload could not be signed.");
    }
    const { status, body } = await requestJson(
      fetchImpl,
      specUploadUrl,
      {
        method: "POST",
        bytes,
        headers: {
          "x-agenc-wallet": signer.address,
          "x-agenc-ts": String(ts),
          "x-agenc-signature": Buffer.from(signature).toString("base64"),
        },
      },
      { timeoutMs: 60_000, maxBytes: 512 * 1024 },
    );
    const data = record(body);
    if (status === 400 || status === 413 || status === 415) {
      throw new WalletError("NOT_ALLOWED", refused);
    }
    const uri = typeof data?.uri === "string" ? data.uri : "";
    const hashHex = typeof data?.payloadSha256 === "string" ? data.payloadSha256 : "";
    const payload = record(data?.payload);
    if (
      status !== 200 ||
      payload === null ||
      !HEX64.test(hashHex) ||
      !/^https:\/\/[^\s]{1,240}$/.test(uri)
    ) {
      throw new WalletError(
        "NETWORK",
        "The marketplace could not publish that right now. Try again in a moment.",
      );
    }
    let derived: string;
    try {
      derived = (await values.canonicalJobSpecHash(payload)).hex;
    } catch {
      derived = "";
    }
    if (derived !== hashHex) {
      throw new WalletError(
        "NETWORK",
        "The marketplace published something other than what was sent. Nothing was posted.",
      );
    }
    return { uri, hashHex, payload };
  }

  async function attestorInfo(): Promise<NonNullable<typeof info>> {
    if (info !== null && now() - info.at < INFO_TTL_MS) return info;
    const { status, body } = await requestJson(
      fetchImpl,
      `${attestUrl}/v1/info`,
      { method: "GET" },
      { timeoutMs: 15_000, maxBytes: 64 * 1024 },
    );
    const data = record(body);
    const moderator = safeAddress(data?.moderator);
    if (status !== 200 || data?.signerConfigured !== true || moderator === null) {
      throw new WalletError(
        "NETWORK",
        "The marketplace's safety check is not available right now. Try again in a moment.",
      );
    }
    info = { at: now(), moderator };
    return info;
  }

  function parseRow(value: unknown): CatalogRow | null {
    const item = record(value);
    if (item === null) return null;
    const listing = safeAddress(item.pda);
    const providerAgent = safeAddress(item.providerAgent);
    const price = safeBigInt(item.priceLamports);
    const name = tidyText(item.name, 64);
    if (listing === null || providerAgent === null || price === null || name === null) return null;
    if (item.priceMint !== null && item.priceMint !== undefined) return null;
    if (item.state !== 0) return null;
    const provenance = record(item.provenance);
    const ratingCount = finite(provenance?.rawRatingCount) ?? finite(item.ratingCount) ?? 0;
    const average =
      finite(provenance?.weightedRatingAverage) ?? finite(provenance?.rawRatingAverage);
    const rating =
      ratingCount > 0 && average !== null && average >= 1 && average <= 5 ? average : null;
    const settled = finite(provenance?.settledHireCount);
    const deadline = finite(item.defaultDeadlineSecs);
    return {
      listing,
      providerAgent,
      name,
      category: tidyText(item.category, 40),
      summary: tidyText(item.summary ?? item.description, 280),
      priceLamports: price,
      rating,
      ratingCount: Math.max(0, Math.trunc(ratingCount)),
      jobsDone: Math.max(0, Math.trunc(settled ?? 0)),
      deliverySecs: deadline !== null && deadline > 0 ? Math.trunc(deadline) : null,
    };
  }

  return {
    async listServices() {
      if (catalog !== null && now() - catalog.at < CATALOG_TTL_MS) return catalog.rows;
      const rows: CatalogRow[] = [];
      for (let page = 1; page <= MAX_CATALOG_PAGES; page += 1) {
        const { status, body } = await requestJson(
          fetchImpl,
          `${siteUrl}/api/listings?hireable=1&page=${page}&pageSize=100`,
          { method: "GET" },
          { timeoutMs: 30_000, maxBytes: 2 * 1024 * 1024 },
        );
        const data = record(body);
        if (status !== 200 || data === null || !Array.isArray(data.items)) {
          throw new WalletError(
            "NETWORK",
            "The list of services could not be loaded. Try again in a moment.",
          );
        }
        for (const item of data.items) {
          const row = parseRow(item);
          if (row !== null) rows.push(row);
        }
        const total = finite(data.total) ?? 0;
        if (data.items.length === 0 || page * 100 >= total) break;
      }
      catalog = { at: now(), rows };
      return rows;
    },

    async trustedModerators() {
      return [(await attestorInfo()).moderator];
    },

    async acquireListingAttestation(listing) {
      const { status, body } = await requestJson(
        fetchImpl,
        `${attestUrl}/v1/moderation/listings`,
        { method: "POST", body: { listing } },
        { timeoutMs: 120_000, maxBytes: 64 * 1024 },
      );
      const data = record(body);
      if (status === 200 && data?.ok === true && data.attested === true) return;
      if (status === 200 && data?.ok === true) {
        throw new WalletError(
          "NOT_AVAILABLE",
          "This service did not pass the marketplace's safety check, so it cannot be hired.",
        );
      }
      // The check is paid for by whoever offers the service, not by a buyer.
      if (status === 402) {
        throw new WalletError(
          "NOT_AVAILABLE",
          "That service has not been through the marketplace's safety check yet, so it cannot be hired.",
        );
      }
      if (status === 429 || status >= 500) {
        throw new WalletError(
          "NETWORK",
          "The marketplace's safety check is busy. Try again in a moment.",
        );
      }
      throw new WalletError("NOT_AVAILABLE", "This service cannot be hired right now.");
    },

    async publishListing(input) {
      if (specUploadUrl === null) return null;
      // The shape the marketplace keeps for every listing: the description
      // with the hash it commits to.
      const published = await publish(
        input.signer,
        {
          integrity: {
            algorithm: "sha256",
            canonicalization: "json-stable-v1",
            payloadHash: input.specHashHex,
          },
          payload: input.spec,
        },
        "The marketplace would not publish this service's description.",
      );
      if (published.hashHex !== input.specHashHex) {
        throw new WalletError(
          "NETWORK",
          "The marketplace published a different description. The service is not on offer yet.",
        );
      }
      return published.uri;
    },

    async publishJobSpec(input) {
      // Plain fields. The marketplace turns them into the full request a
      // worker reads, and says what that request hashes to.
      const published = await publish(
        input.signer,
        {
          title: `Hire: ${input.title}`,
          summary: input.request,
          ...(input.request.length > JOB_SUMMARY_MAX ? { details: input.request } : {}),
          ...(input.acceptance.length > 0 ? { acceptance: [...input.acceptance] } : {}),
          deliverables: [JOB_DELIVERABLE],
        },
        "The marketplace would not publish this request.",
      );
      return { spec: published.payload, hashHex: published.hashHex, uri: published.uri };
    },

    async attestListing(input) {
      const { status, body } = await requestJson(
        fetchImpl,
        `${attestUrl}/v1/moderation/listings`,
        {
          method: "POST",
          body: {
            listing: input.listing,
            spec: input.spec,
            specUri: input.specUri,
            payer: input.payer,
          },
        },
        { timeoutMs: 120_000, maxBytes: 64 * 1024 },
      );
      const data = record(body);
      if (status === 200 && data?.ok === true) {
        const payment = data.attested === true ? null : parsePayment(data);
        if (data.attested !== true && payment === null) {
          throw new WalletError(
            "NOT_ALLOWED",
            "The service's description did not pass the marketplace's safety check. Change the wording and try again.",
          );
        }
        if (data.specHash !== input.specHashHex) {
          throw new WalletError(
            "NETWORK",
            "The marketplace answered about a different description. The service is not on offer yet.",
          );
        }
        return payment;
      }
      // 404 is the checker not seeing a listing created seconds ago; it is
      // retried like any other temporary answer.
      if (status === 422 || status === 400) {
        throw new WalletError(
          "NOT_ALLOWED",
          "The marketplace refused this service's description, so it is not on offer.",
        );
      }
      throw new WalletError(
        "NETWORK",
        "The marketplace's safety check is busy. The service goes on offer as soon as it answers.",
      );
    },

    async attestTask(input) {
      const { status, body } = await requestJson(
        fetchImpl,
        `${attestUrl}/v1/moderation/tasks`,
        {
          method: "POST",
          body: {
            task: input.task,
            jobSpecHash: input.jobSpecHashHex,
            spec: input.jobSpec,
            specUri: input.jobSpecUri,
            payer: input.payer,
          },
        },
        { timeoutMs: 120_000, maxBytes: 64 * 1024 },
      );
      const data = record(body);
      if (status === 200 && data?.ok === true) {
        const payment = data.attested === true ? null : parsePayment(data);
        if (data.attested !== true && payment === null) {
          throw new WalletError(
            "NOT_ALLOWED",
            "The request did not pass the marketplace's safety check, so the job was not posted.",
          );
        }
        if (data.specHash !== input.jobSpecHashHex) {
          throw new WalletError(
            "NETWORK",
            "The marketplace answered about a different request. Nothing was posted.",
          );
        }
        return payment;
      }
      if (status === 422 || status === 400) {
        throw new WalletError(
          "NOT_ALLOWED",
          "The marketplace refused this request, so the job was not posted.",
        );
      }
      throw new WalletError(
        "NETWORK",
        "The marketplace's safety check is busy. The job will be posted as soon as it answers.",
      );
    },

    async fetchResult({ proofHashHex, resultData }) {
      if (!HEX64.test(proofHashHex)) return null;
      const pointer = decodeResultPointer(resultData);
      const candidates: string[] = [];
      if (/^https:\/\//.test(pointer)) candidates.push(pointer);
      const digest = digestFromPointer(pointer);
      if (artifactBaseUrl !== null && (digest === null || digest === proofHashHex)) {
        candidates.push(`${artifactBaseUrl}/artifacts/${proofHashHex}`);
      }
      for (const uri of candidates) {
        try {
          const bytes = await publicFetcher(uri);
          if (bytes.length <= MAX_RESULT_BYTES && sha256Hex(bytes) === proofHashHex) {
            return { bytes, uri };
          }
        } catch {
          // Try the next place; a miss is not an error.
        }
      }
      return null;
    },

    resultUploader(signer) {
      if (artifactUploadUrl === null) return null;
      const upload: typeof fetch = async (_input, init) => {
        const raw = init?.body;
        if (!(raw instanceof Uint8Array)) {
          throw new Error("delivery upload expects raw bytes");
        }
        if (raw.length > MAX_RESULT_BYTES) {
          throw new Error("delivery is larger than the store accepts");
        }
        const digest = sha256Hex(raw);
        const ts = now();
        const message = new TextEncoder().encode(
          artifactUploadMessage(digest, signer.address, ts),
        );
        const [signed] = await signer.signMessages([{ content: message, signatures: {} }]);
        const signature = signed?.[signer.address];
        if (signature === undefined) throw new Error("delivery upload could not be signed");
        const response = await fetchImpl(artifactUploadUrl, {
          method: "POST",
          redirect: "error",
          headers: {
            "content-type": "application/octet-stream",
            "x-agenc-wallet": signer.address,
            "x-agenc-ts": String(ts),
            "x-agenc-signature": Buffer.from(signature).toString("base64"),
          },
          body: raw as unknown as NonNullable<RequestInit["body"]>,
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) {
          return new Response(null, { status: response.status });
        }
        const stored = record(await response.json().catch(() => null));
        if (stored?.sha256 !== digest) {
          return new Response(null, { status: 502 });
        }
        // The worker runtime wants exactly `{ "uri": ... }`. The delivery is
        // addressed by its fingerprint; the store keeps it at that address.
        return new Response(
          JSON.stringify({ uri: `agenc://result/sha256/${digest}` }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };
      return { url: artifactUploadUrl, fetch: upload };
    },
  };
}

/** What every job asks the provider to hand in. */
const JOB_DELIVERABLE =
  "Put the complete result in your submission. The buyer reads exactly what you submit.";
/** The marketplace keeps this much of a request as its summary; the rest goes in the details. */
const JOB_SUMMARY_MAX = 240;

/**
 * A job's request in a plain shape, for a marketplace that has no publisher
 * of its own (the practice one). Deterministic for the same inputs. On a real
 * network the request is published through {@link MarketServices.publishJobSpec}
 * and the marketplace's own shape is used instead.
 */
export function buildJobSpec(input: {
  title: string;
  request: string;
  acceptance: readonly string[];
  listing: Address;
}): Record<string, unknown> {
  return {
    kind: "agenc.marketplace.jobSpec",
    title: `Hire: ${input.title}`,
    instructions: input.request,
    ...(input.acceptance.length > 0 ? { acceptance: [...input.acceptance] } : {}),
    deliverable: JOB_DELIVERABLE,
    sourceListing: input.listing,
  };
}

/**
 * Build the advertised description of a service this wallet offers, in the
 * shape the marketplace publishes for every listing: the display document
 * lives under `custom.listingMetadata`. Deterministic for the same inputs, so
 * the hash committed in the listing can be reproduced later.
 */
export function buildListingSpec(input: {
  name: string;
  summary: string;
  category: string;
}): Record<string, unknown> {
  return {
    category: input.category,
    custom: {
      listingMetadata: {
        displayName: input.name,
        longDescription: input.summary,
      },
    },
  };
}

/** Canonical hash of a job spec: the value committed on-chain. */
export async function jobSpecHash(spec: Record<string, unknown>): Promise<{
  bytes: Uint8Array;
  hex: string;
}> {
  return values.canonicalJobSpecHash(spec);
}
