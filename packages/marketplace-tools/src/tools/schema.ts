import type { JsonSchemaProperty } from "../types.js";

/** On-chain protocol bounds shared by the public tool schemas and handlers. */
export const MIN_LISTING_PRICE = 1_000n;
export const MAX_DEADLINE_SECONDS = 31_536_000n;
export const MAX_REVIEW_WINDOW_SECONDS = 604_800n;
export const CONTENT_URI_MAX_BYTES = 256;
export const AGENT_URI_MAX_BYTES = 128;

export function solanaAddress(description: string): JsonSchemaProperty {
  return {
    type: "string",
    format: "solana-address",
    minLength: 32,
    maxLength: 44,
    description,
  };
}

export function hex32(
  description: string,
  nonzero = false,
): JsonSchemaProperty {
  return {
    type: "string",
    format: nonzero ? "nonzero-hex-32" : "hex-32",
    minLength: 64,
    maxLength: 64,
    description,
  };
}

export function hex64(description: string): JsonSchemaProperty {
  return {
    type: "string",
    format: "hex-64",
    minLength: 128,
    maxLength: 128,
    description,
  };
}

export function uint64(
  description: string,
  nonzero = false,
): JsonSchemaProperty {
  return {
    type: "string",
    format: nonzero ? "nonzero-uint64" : "uint64",
    minLength: 1,
    maxLength: 20,
    description,
  };
}

export function int64(description: string): JsonSchemaProperty {
  return {
    type: "string",
    format: "int64",
    minLength: 1,
    maxLength: 20,
    description,
  };
}

export function contentUri(
  description: string,
  maxBytes: 128 | 256 = CONTENT_URI_MAX_BYTES,
): JsonSchemaProperty {
  return {
    type: "string",
    format: "uri",
    minLength: 1,
    maxLength: maxBytes,
    description,
  };
}

export function httpUrl(description: string): JsonSchemaProperty {
  return {
    type: "string",
    format: "http-url",
    minLength: 1,
    maxLength: AGENT_URI_MAX_BYTES,
    description,
  };
}
