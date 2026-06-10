// Transport seam for the trustless getProgramAccounts (gPA) read path.
//
// The query helpers in this module never talk to an RPC directly: they speak to a
// minimal `ProgramAccountsTransport` interface. That seam exists on purpose — the
// Phase-3 hosted indexer API will implement the exact same interface, so every
// helper in `src/queries` works unchanged over raw RPC gPA today and over the
// indexer tomorrow.
import {
  getBase64Decoder,
  getBase64Encoder,
  type Address,
  type GetProgramAccountsApi,
  type GetProgramAccountsDatasizeFilter,
  type GetProgramAccountsMemcmpFilter,
  type Rpc,
} from "@solana/kit";
import { AGENC_COORDINATION_PROGRAM_ADDRESS } from "../generated/index.js";

/**
 * A single account filter in the transport-neutral form used by the query layer.
 *
 * - `{ dataSize }` matches accounts whose data is exactly `dataSize` bytes long.
 * - `{ memcmp }` matches accounts whose data contains exactly `bytes` at byte
 *   `offset` (the standard Solana RPC memcmp semantics: an exact byte-for-byte
 *   comparison; per the RPC spec, memcmp `bytes` are limited to 128 bytes).
 */
export type GpaFilter =
  | { dataSize: number }
  | { memcmp: { offset: number; bytes: Uint8Array } };

/**
 * The transport seam behind every query helper.
 *
 * Implementations return the raw `{ address, data }` pairs for all
 * agenc-coordination program accounts matching ALL of the given filters.
 *
 * This interface is deliberately tiny so alternative back-ends can drop in
 * behind the same helper API:
 *
 * - {@link createRpcProgramAccountsTransport} adapts any `@solana/kit`
 *   `Rpc<GetProgramAccountsApi>` (raw on-chain gPA — fully trustless).
 * - The Phase-3 hosted indexer client will implement this same interface, so
 *   `listActiveListings(indexer, ...)` etc. work without any call-site change.
 * - Tests implement it over litesvm (see `tests-e2e/gpa-sim.ts`).
 */
export interface ProgramAccountsTransport {
  /**
   * Fetch all matching program accounts.
   *
   * @param opts - `filters`: every filter must match (logical AND), using exact
   * RPC semantics (`dataSize` equality; `memcmp` exact byte match at offset).
   * @returns The matching accounts as `{ address, data }` with raw account bytes.
   */
  getProgramAccounts(opts: {
    filters: readonly GpaFilter[];
  }): Promise<Array<{ address: Address; data: Uint8Array }>>;
}

/**
 * What every query helper accepts: either a kit `Rpc` (the helper wraps it with
 * {@link createRpcProgramAccountsTransport} automatically) or any
 * {@link ProgramAccountsTransport} implementation (e.g. the Phase-3 hosted
 * indexer client, or a test simulator).
 */
export type ProgramAccountsSource =
  | Rpc<GetProgramAccountsApi>
  | ProgramAccountsTransport;

/** Convert a transport-neutral {@link GpaFilter} to the kit RPC filter form. */
function toRpcFilter(
  filter: GpaFilter,
): GetProgramAccountsDatasizeFilter | GetProgramAccountsMemcmpFilter {
  if ("dataSize" in filter) {
    return { dataSize: BigInt(filter.dataSize) };
  }
  return {
    memcmp: {
      // base64-encode the raw bytes for the wire (kit/RPC accept base64 memcmp).
      bytes: getBase64Decoder().decode(filter.memcmp.bytes),
      encoding: "base64",
      offset: BigInt(filter.memcmp.offset),
    },
  } as GetProgramAccountsMemcmpFilter;
}

/**
 * Adapt a `@solana/kit` `Rpc<GetProgramAccountsApi>` to the
 * {@link ProgramAccountsTransport} seam.
 *
 * Issues `getProgramAccounts(programAddress, { encoding: "base64", filters })`
 * with memcmp bytes converted to their base64 RPC form, and decodes the
 * base64 response data back into `Uint8Array`s.
 *
 * NOTE (read this before shipping a UI on top of it): raw `getProgramAccounts`
 * is RPC-provider-dependent — many public RPC providers disable or heavily
 * restrict it. It is the trustless read path, not the scale path. The Phase-3
 * hosted indexer exposes the same {@link ProgramAccountsTransport} interface
 * and is the intended drop-in replacement at scale.
 *
 * @param rpc - Any kit RPC that supports `getProgramAccounts`.
 * @param config - Optional `programAddress` override (defaults to the
 * agenc-coordination program).
 * @returns A {@link ProgramAccountsTransport} backed by the RPC.
 *
 * @example
 * ```ts
 * const rpc = createSolanaRpc("https://your-gpa-enabled-rpc");
 * const transport = createRpcProgramAccountsTransport(rpc);
 * const listings = await listActiveListings(transport);
 * ```
 */
export function createRpcProgramAccountsTransport(
  rpc: Rpc<GetProgramAccountsApi>,
  config: { programAddress?: Address } = {},
): ProgramAccountsTransport {
  const programAddress =
    config.programAddress ?? AGENC_COORDINATION_PROGRAM_ADDRESS;
  const base64Encoder = getBase64Encoder();
  return {
    async getProgramAccounts({ filters }) {
      const results = await rpc
        .getProgramAccounts(programAddress, {
          encoding: "base64",
          filters: filters.map(toRpcFilter),
        })
        .send();
      return results.map((item) => ({
        address: item.pubkey,
        data: new Uint8Array(base64Encoder.encode(item.account.data[0])),
      }));
    },
  };
}

/**
 * Resolve a {@link ProgramAccountsSource} to a concrete transport.
 *
 * Shape detection: a kit `Rpc` is a proxy that exposes the full Solana RPC
 * method surface (so `getAccountInfo` is a function on it), while a plain
 * {@link ProgramAccountsTransport} implementation only carries
 * `getProgramAccounts(opts)`. Anything that looks like a kit RPC is wrapped
 * with {@link createRpcProgramAccountsTransport}; everything else is used
 * as-is. If you implement a custom transport, do NOT also expose a
 * `getAccountInfo` function on the same object.
 *
 * @param source - A kit `Rpc<GetProgramAccountsApi>` or a transport.
 * @returns A {@link ProgramAccountsTransport}.
 */
export function resolveProgramAccountsTransport(
  source: ProgramAccountsSource,
): ProgramAccountsTransport {
  if (
    typeof (source as Record<string, unknown>).getProgramAccounts !== "function"
  ) {
    throw new Error(
      "queries: expected a kit Rpc or a ProgramAccountsTransport (missing getProgramAccounts)",
    );
  }
  if (
    typeof (source as Record<string, unknown>).getAccountInfo === "function"
  ) {
    // Full RPC method surface -> a kit Rpc proxy; wrap it.
    return createRpcProgramAccountsTransport(
      source as Rpc<GetProgramAccountsApi>,
    );
  }
  return source as ProgramAccountsTransport;
}
