// Typed failures for the hosted indexer API client.

/**
 * Typed failure from the hosted indexer API, mapped from the storefront's
 * house error envelope (`{ error: { code, message } }`).
 *
 * - `status` — HTTP status of the response, or `0` when the request never
 *   produced an HTTP response (network-layer fetch failure: DNS, refused
 *   connection, no network).
 * - `code` — the envelope's machine-readable code (e.g.
 *   `"LISTING_NOT_FOUND"`, `"RATE_LIMITED"`). When the response carried no
 *   envelope, a synthetic code: `"NETWORK_ERROR"` (status 0),
 *   `"INVALID_RESPONSE"` (unparseable/contract-violating body), or
 *   `"HTTP_<status>"` (non-2xx without an envelope).
 * - `message` — human-readable description (the envelope message when
 *   present).
 */
export class IndexerError extends Error {
  /** HTTP status (`0` = the fetch itself failed before any HTTP response). */
  readonly status: number;
  /** Machine-readable error code (envelope code or a synthetic fallback). */
  readonly code: string;

  constructor(
    message: string,
    options: { status: number; code: string; cause?: unknown },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {});
    this.name = "IndexerError";
    this.status = options.status;
    this.code = options.code;
  }
}
