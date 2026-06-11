// A reusable litesvm-backed MarketplaceToolContext for the MCP e2e tests.
//
// startLocalMarketplace() boots the REAL compiled agenc-coordination program
// in litesvm and seeds the config singletons. The MCP server's tool handlers
// need two read seams on the context:
//   - `read`: a ProgramAccountsSource for the list/search tools (gPA).
//   - `rpc`:  a kit-RPC-shaped object exposing getAccountInfo(address).send()
//             for the single-account fetch tools (get_task/get_listing,
//             getAgentTrackRecord).
// Both are served here from the SAME litesvm VM — no validator, no network —
// so the MCP server resolves REAL on-chain accounts the local stack created.
import { getBase64Decoder, type Address } from "@solana/kit";
import type { LiteSVM } from "litesvm";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  type GpaFilter,
  type ProgramAccountsTransport,
} from "@tetsuo-ai/marketplace-sdk";

const PROGRAM = AGENC_COORDINATION_PROGRAM_ADDRESS;

function matchesFilter(filter: GpaFilter, data: Uint8Array): boolean {
  if ("dataSize" in filter) return data.length === filter.dataSize;
  const { offset, bytes } = filter.memcmp;
  if (offset + bytes.length > data.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (data[offset + i] !== bytes[i]) return false;
  }
  return true;
}

/**
 * A litesvm-backed `getProgramAccounts` transport. litesvm has no gPA, so the
 * simulator holds the addresses the test world created and scans them with
 * exact RPC memcmp/dataSize semantics, scoped to the program (gPA semantics).
 */
export class LiteSvmGpa implements ProgramAccountsTransport {
  readonly #svm: LiteSVM;
  readonly #addresses = new Set<Address>();

  constructor(svm: LiteSVM) {
    this.#svm = svm;
  }

  /** Register addresses created by the test world (idempotent). */
  register(...addresses: Address[]): this {
    for (const a of addresses) this.#addresses.add(a);
    return this;
  }

  async getProgramAccounts({
    filters,
  }: {
    filters: readonly GpaFilter[];
  }): Promise<Array<{ address: Address; data: Uint8Array }>> {
    const out: Array<{ address: Address; data: Uint8Array }> = [];
    for (const address of this.#addresses) {
      const acct = this.#svm.getAccount(address);
      if (!acct || !acct.exists) continue;
      if (acct.programAddress !== PROGRAM) continue;
      const data = Uint8Array.from(acct.data);
      if (filters.every((f) => matchesFilter(f, data))) {
        out.push({ address, data });
      }
    }
    return out;
  }
}

/** Minimal kit-RPC shim over litesvm: getAccountInfo(address).send() (base64). */
export interface LiteSvmRpc {
  getAccountInfo(
    address: Address,
    config?: unknown,
  ): { send: () => Promise<{ value: unknown }> };
}

/**
 * A kit-RPC-shaped object exposing `getAccountInfo` over a litesvm VM. This is
 * what `fetchEncodedAccount` (used by `fetchMaybeTask` / `fetchMaybeServiceListing`
 * / `getAgentTrackRecord`) calls — it returns the base64 account-info shape kit
 * parses.
 */
export function liteSvmRpc(svm: LiteSVM): LiteSvmRpc {
  const decode = getBase64Decoder();
  return {
    getAccountInfo(address: Address) {
      return {
        async send() {
          const acct = svm.getAccount(address);
          if (!acct || !acct.exists) return { value: null };
          const data = Uint8Array.from(acct.data);
          return {
            value: {
              data: [decode.decode(data), "base64"],
              executable: acct.executable,
              lamports: acct.lamports,
              owner: acct.programAddress,
              rentEpoch: 0n,
              space: BigInt(data.length),
            },
          };
        },
      };
    },
  };
}
