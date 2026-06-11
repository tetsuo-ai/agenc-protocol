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
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

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
}

/**
 * Typed failure from the content host: a network-layer fetch rejection
 * (`status` 0 — DNS failure, refused connection, no network), any non-2xx HTTP
 * response, or a 2xx response whose body is not the expected JSON.
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
 * @param options - Base URL, optional default upload ticket, optional fetch override.
 * @throws TypeError when `baseUrl` is empty.
 */
export function createContentTransport(
  options: ContentTransportOptions,
): ContentTransport {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  if (baseUrl.length === 0) {
    throw new TypeError("createContentTransport: baseUrl is required");
  }
  // Wrapped so the global fetch keeps its expected receiver in browsers.
  const fetchImpl: ContentFetchLike =
    options.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));

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

    let response: Awaited<ReturnType<ContentFetchLike>>;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      throw new ContentTransportError(
        `content host at ${baseUrl} could not be reached (${method} ${path}: ` +
          `the fetch itself failed before any HTTP response)`,
        { status: 0, cause },
      );
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => null);
      throw new ContentTransportError(
        `content host at ${baseUrl} responded ${response.status} for ` +
          `${method} ${path}` +
          (bodyText ? `: ${bodyText}` : ""),
        { status: response.status, body: bodyText },
      );
    }

    try {
      return await response.json();
    } catch (cause) {
      throw new ContentTransportError(
        `content host at ${baseUrl} returned ${response.status} for ` +
          `${method} ${path} but the body is not JSON`,
        { status: response.status, cause },
      );
    }
  }

  return {
    baseUrl,
    get: (path) => request("GET", path, undefined, undefined),
    post: (path, body, ticket) => request("POST", path, body, ticket),
  };
}
