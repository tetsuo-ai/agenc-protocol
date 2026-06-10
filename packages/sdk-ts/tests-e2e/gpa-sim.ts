// GpaSimulator: a ProgramAccountsTransport over litesvm for the e2e query tests.
//
// litesvm has no getProgramAccounts, so the simulator holds the set of addresses
// the test world created, reads each account's live bytes via svm.getAccount,
// and applies the filters with EXACT RPC semantics:
//   - dataSize: account data length must equal the filter value;
//   - memcmp: the bytes at `offset` must equal `bytes` byte-for-byte, and a
//     comparison running past the end of the data never matches;
//   - all filters must match (logical AND);
//   - only accounts owned by the agenc-coordination program are returned
//     (gPA is scoped to one program by construction).
import type { Address } from "@solana/kit";
import type { LiteSVM } from "litesvm";
import type {
  GpaFilter,
  ProgramAccountsTransport,
} from "../src/queries/index.js";
import { PROGRAM } from "./harness.js";

function matchesFilter(filter: GpaFilter, data: Uint8Array): boolean {
  if ("dataSize" in filter) {
    return data.length === filter.dataSize;
  }
  const { offset, bytes } = filter.memcmp;
  if (offset + bytes.length > data.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (data[offset + i] !== bytes[i]) return false;
  }
  return true;
}

export class GpaSimulator implements ProgramAccountsTransport {
  readonly #svm: LiteSVM;
  readonly #addresses = new Set<Address>();

  constructor(svm: LiteSVM) {
    this.#svm = svm;
  }

  /** Register addresses created by the test world (idempotent). */
  register(...addresses: Address[]): void {
    for (const a of addresses) this.#addresses.add(a);
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
