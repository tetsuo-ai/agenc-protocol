import { address, type Address } from "@solana/kit";
import type { AccountReader } from "./job-spec.js";

/** Immutable metadata needed to distinguish a real program account from dust. */
export type AccountSnapshot = Readonly<{
  data: Uint8Array;
  owner: Address;
  executable: boolean;
}>;

/** Read account bytes together with their security-relevant RPC metadata. */
export type AccountInfoReader = (
  account: Address,
) => Promise<AccountSnapshot | null>;

/** The two compatible readers built over one Solana `getAccountInfo` adapter. */
export type SolanaAccountReaders = Readonly<{
  /** Backward-compatible raw-byte reader used by existing worker consumers. */
  readAccount: AccountReader;
  /** Ownership/executable-aware reader used at account-classification boundaries. */
  readAccountInfo: AccountInfoReader;
}>;

/** Minimal injectable seam around `getAccountInfo(..., { encoding: "base64" })`. */
export type Base64AccountInfoFetcher = (account: Address) => Promise<unknown>;

function decodeCanonicalBase64(value: string): Uint8Array {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    throw new Error("RPC account data is not canonical base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new Error("RPC account data is not canonical base64");
  }
  return new Uint8Array(bytes);
}

function decodeBase64AccountInfo(value: unknown): AccountSnapshot | null {
  if (value === null) return null;
  if (typeof value !== "object") {
    throw new Error("RPC account info is malformed");
  }
  let encoded: unknown;
  let owner: unknown;
  let executable: unknown;
  try {
    const candidate = value as Record<string, unknown>;
    encoded = candidate.data;
    owner = candidate.owner;
    executable = candidate.executable;
  } catch {
    throw new Error("RPC account info is malformed");
  }
  let encodedData: unknown;
  let encoding: unknown;
  let encodedLength: unknown;
  try {
    if (Array.isArray(encoded)) {
      encodedLength = encoded.length;
      encodedData = encoded[0];
      encoding = encoded[1];
    }
  } catch {
    throw new Error("RPC account info is malformed");
  }
  if (
    !Array.isArray(encoded) ||
    encodedLength !== 2 ||
    typeof encodedData !== "string" ||
    encoding !== "base64" ||
    typeof owner !== "string" ||
    typeof executable !== "boolean"
  ) {
    throw new Error("RPC account info is malformed");
  }
  return Object.freeze({
    data: decodeCanonicalBase64(encodedData),
    owner: address(owner),
    executable,
  });
}

/**
 * Adapt Solana RPC account values into both the historical bytes-only reader
 * and a metadata-preserving reader. The fetcher must return the `value` field
 * from a base64 `getAccountInfo` response, not the outer RPC response.
 */
export function createSolanaAccountReaders(
  fetchAccountInfo: Base64AccountInfoFetcher,
): SolanaAccountReaders {
  const readAccountInfo: AccountInfoReader = async (account) =>
    decodeBase64AccountInfo(await fetchAccountInfo(account));
  const readAccount: AccountReader = async (account) => {
    const snapshot = await readAccountInfo(account);
    return snapshot === null ? null : snapshot.data;
  };
  return Object.freeze({ readAccount, readAccountInfo });
}
