// The content-rails transport seam (P7.1 / P7.2 / P7.3 off-chain rails): a
// thin, typed, fetch-based client over the storefront content host. Injectable
// so the SDK helpers run against the real storefront, a fake in tests, or any
// custom HTTP transport.
//
// Browser-safe: fetch only — no Node built-ins anywhere in this module.

/**
 * Minimal structural slice of `fetch` used by the content-rails helpers. The
 * global `fetch` satisfies it; tests inject a fake.
 */
export type ContentFetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  /**
   * Raw byte stream used to enforce `maxResponseBytes` before materializing
   * untrusted content. A null body is accepted structurally but rejected by
   * the bounded transport at runtime.
   */
  body: ContentBodyStream | null;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** Default wall-clock bound for one content-host request. */
export const DEFAULT_CONTENT_TRANSPORT_TIMEOUT_MS = 10_000;
/** Default maximum raw response body accepted from the content host (1 MiB). */
export const DEFAULT_MAX_CONTENT_RESPONSE_BYTES = 1024 * 1024;

/** Minimal readable-byte-stream reader required from injected fetch adapters. */
export type ContentBodyReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel?(reason?: unknown): Promise<void>;
  releaseLock?(): void;
};

/** Minimal readable byte stream required for bounded content responses. */
export type ContentBodyStream = {
  getReader(): ContentBodyReader;
  cancel?(reason?: unknown): Promise<void>;
};

/**
 * An upload ticket / wallet-verification credential the storefront content host
 * requires for authenticated write paths (publishing a task-thread message,
 * fetching a gated deliverable key). Opaque to the SDK — it is forwarded
 * verbatim as the `Authorization: Bearer <ticket>` header. The storefront
 * verifies it the same way it verifies artifact-upload tickets.
 */
export type UploadTicket = string;

/** Options for {@link createContentTransport}. */
export interface ContentTransportOptions {
  /**
   * Base URL of the storefront content host (e.g.
   * `https://marketplace.agenc.tech`). Paths like `/api/task-threads/<pda>`
   * are appended to it. A trailing slash is trimmed.
   */
  baseUrl: string;
  /**
   * Default upload ticket / wallet credential forwarded as a bearer token on
   * write requests. Optional: reads are anonymous; per-call tickets override it.
   */
  uploadTicket?: UploadTicket;
  /** Override the fetch implementation (tests / custom transports). */
  fetchImpl?: ContentFetchLike;
  /** Wall-clock request timeout in milliseconds. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Maximum raw response bytes accepted before JSON parsing. Defaults to 1 MiB. */
  maxResponseBytes?: number;
}

/**
 * Typed failure from the content host: a network-layer fetch rejection
 * (`status` 0 — DNS failure, refused connection, no network, or timeout), any
 * oversized/non-2xx HTTP response, or a 2xx response whose body is not the
 * expected JSON.
 */
export class ContentTransportError extends Error {
  /** HTTP status (`0` = the fetch itself failed before any HTTP response). */
  readonly status: number;
  /** Raw response body text (when readable), for diagnostics. */
  readonly body: string | null;

  constructor(
    message: string,
    options: { status: number; body?: string | null; cause?: unknown },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {});
    this.name = "ContentTransportError";
    this.status = options.status;
    this.body = options.body ?? null;
  }
}

/**
 * The injectable content-rails transport: a typed `get` / `post` over the
 * storefront content host. The seam every off-chain content helper takes, so
 * the same helper works against the real storefront or a fake.
 */
export interface ContentTransport {
  /** Base URL the transport posts/gets against (trailing slash trimmed). */
  readonly baseUrl: string;
  /**
   * GET `path` (relative to {@link ContentTransport.baseUrl}) and return the
   * parsed JSON body.
   */
  get(path: string): Promise<unknown>;
  /**
   * POST `body` as JSON to `path` (relative to the base URL) and return the
   * parsed JSON response body. `ticket` (or the transport's default
   * `uploadTicket`) is sent as a bearer token.
   */
  post(path: string, body: unknown, ticket?: UploadTicket): Promise<unknown>;
}

/**
 * Build a {@link ContentTransport} over the storefront content host. Browser-safe
 * (fetch only). Tests inject `fetchImpl`; production passes only `baseUrl`
 * (+ an `uploadTicket` for write paths).
 *
 * @param options - Base URL, credentials, fetch override, and resource bounds.
 * @throws TypeError when `baseUrl` or a resource bound is invalid.
 */
export function createContentTransport(
  options: ContentTransportOptions,
): ContentTransport {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  if (baseUrl.length === 0) {
    throw new TypeError("createContentTransport: baseUrl is required");
  }
  const timeoutMs =
    options.timeoutMs ?? DEFAULT_CONTENT_TRANSPORT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2_147_483_647
  ) {
    throw new TypeError(
      "createContentTransport: timeoutMs must be a positive integer no greater than 2147483647",
    );
  }
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_CONTENT_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new TypeError(
      "createContentTransport: maxResponseBytes must be a positive safe integer",
    );
  }
  // Wrapped so the global fetch keeps its expected receiver in browsers.
  const fetchImpl: ContentFetchLike =
    options.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));

  function timeoutFailure(method: string, path: string): ContentTransportError {
    return new ContentTransportError(
      `content host at ${baseUrl} timed out after ${timeoutMs}ms ` +
        `(${method} ${path})`,
      { status: 0 },
    );
  }

  function oversizedFailure(
    status: number,
    method: string,
    path: string,
  ): ContentTransportError {
    return new ContentTransportError(
      `content host response for ${method} ${path} exceeds the configured ` +
        `limit of ${maxResponseBytes} bytes`,
      { status },
    );
  }

  async function readBoundedResponseText(
    response: Awaited<ReturnType<ContentFetchLike>>,
    method: string,
    path: string,
  ): Promise<string> {
    const responseWithExtras = response as typeof response & {
      headers?: unknown;
      body?: unknown;
    };
    const responseHeaders = responseWithExtras.headers;
    const declaredLength =
      responseHeaders !== null &&
      typeof responseHeaders === "object" &&
      "get" in responseHeaders &&
      typeof responseHeaders.get === "function"
        ? (responseHeaders.get("content-length") as unknown)
        : null;
    if (
      typeof declaredLength === "string" &&
      /^\d+$/u.test(declaredLength) &&
      BigInt(declaredLength) > BigInt(maxResponseBytes)
    ) {
      const responseBody = responseWithExtras.body;
      if (
        responseBody !== null &&
        typeof responseBody === "object" &&
        "cancel" in responseBody &&
        typeof responseBody.cancel === "function"
      ) {
        await Promise.resolve(
          responseBody.cancel("content response exceeds configured byte limit"),
        ).catch(() => undefined);
      }
      throw oversizedFailure(response.status, method, path);
    }

    const possibleStream = responseWithExtras.body;
    if (
      possibleStream !== null &&
      typeof possibleStream === "object" &&
      "getReader" in possibleStream &&
      typeof possibleStream.getReader === "function"
    ) {
      const stream = possibleStream as ContentBodyStream;
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let totalBytes = 0;
      const textChunks: string[] = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!(value instanceof Uint8Array)) {
            throw new TypeError("content response stream returned a non-byte chunk");
          }
          totalBytes += value.byteLength;
          if (totalBytes > maxResponseBytes) {
            await reader
              .cancel?.("content response exceeds configured byte limit")
              .catch(() => undefined);
            throw oversizedFailure(response.status, method, path);
          }
          textChunks.push(decoder.decode(value, { stream: true }));
        }
        textChunks.push(decoder.decode());
        return textChunks.join("");
      } finally {
        reader.releaseLock?.();
      }
    }

    // A Content-Length header is not authoritative and text() materializes the
    // entire response before its encoded size can be checked. Fail closed when
    // an injected fetch implementation cannot expose a byte stream; the
    // default transport always enforces maxResponseBytes.
    throw new ContentTransportError(
      `content host response for ${method} ${path} cannot be safely bounded ` +
        `because the fetch response body is not a readable byte stream`,
      { status: response.status },
    );
  }

  async function request(
    method: string,
    path: string,
    body: unknown,
    ticket: UploadTicket | undefined,
  ): Promise<unknown> {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    const bearer = ticket ?? options.uploadTicket;
    if (bearer !== undefined) headers["authorization"] = `Bearer ${bearer}`;
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(timeoutFailure(method, path));
      }, timeoutMs);
    });

    const performRequest = async (): Promise<unknown> => {
      let response: Awaited<ReturnType<ContentFetchLike>>;
      try {
        response = await fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (cause) {
        if (controller.signal.aborted) throw timeoutFailure(method, path);
        throw new ContentTransportError(
          `content host at ${baseUrl} could not be reached (${method} ${path}: ` +
            `the fetch itself failed before any HTTP response)`,
          { status: 0, cause },
        );
      }
      if (controller.signal.aborted) throw timeoutFailure(method, path);

      let bodyText: string;
      try {
        bodyText = await readBoundedResponseText(response, method, path);
      } catch (cause) {
        if (cause instanceof ContentTransportError) throw cause;
        if (controller.signal.aborted) throw timeoutFailure(method, path);
        throw new ContentTransportError(
          `content host at ${baseUrl} returned ${response.status} for ` +
            `${method} ${path} but its body could not be read`,
          { status: response.status, cause },
        );
      }

      if (!response.ok) {
        throw new ContentTransportError(
          `content host at ${baseUrl} responded ${response.status} for ` +
            `${method} ${path}` +
            (bodyText ? `: ${bodyText}` : ""),
          { status: response.status, body: bodyText },
        );
      }

      try {
        return JSON.parse(bodyText) as unknown;
      } catch (cause) {
        throw new ContentTransportError(
          `content host at ${baseUrl} returned ${response.status} for ` +
            `${method} ${path} but the body is not JSON`,
          { status: response.status, body: bodyText, cause },
        );
      }
    };

    try {
      return await Promise.race([performRequest(), timeout]);
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  return {
    baseUrl,
    get: (path) => request("GET", path, undefined, undefined),
    post: (path, body, ticket) => request("POST", path, body, ticket),
  };
}
