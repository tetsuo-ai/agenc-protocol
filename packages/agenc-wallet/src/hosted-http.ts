import { address, type Address } from "@solana/kit";
import { abortableTransport, listingTimeoutMs, transportSignal } from "./transport-scope.js";
import { WalletError } from "./errors.js";

interface JsonResponse {
  status: number;
  body: unknown;
}

/** A bounded, redirect-refusing JSON request to a first-party endpoint. */
export async function requestJson(
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
  const parent = transportSignal();
  const timeout = AbortSignal.timeout(Math.min(limits.timeoutMs, listingTimeoutMs() ?? limits.timeoutMs));
  const signal = parent === undefined ? timeout : AbortSignal.any([parent, timeout]);
  let response: Response;
  try {
    response = await abortableTransport(signal, () => fetchImpl(url, {
      method: init.method,
      redirect: "error",
      headers: {
        accept: "application/json",
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      ...(payload !== undefined ? { body: payload } : {}),
      signal,
    }));
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
      const { done, value } = await abortableTransport(signal, () => reader.read());
      if (done) break;
      total += value.byteLength;
      if (total > limits.maxBytes) {
        await abortableTransport(signal, () => reader.cancel());
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

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function safeAddress(value: unknown): Address | null {
  if (typeof value !== "string") return null;
  try {
    return address(value);
  } catch {
    return null;
  }
}

export function safeBigInt(value: unknown): bigint | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  if (!/^(?:0|[1-9][0-9]{0,19})$/.test(text)) return null;
  return BigInt(text);
}

export function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Clip untrusted display text to one tidy line. */
export function tidyText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}
