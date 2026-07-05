// GpaSimulator: a ProgramAccountsTransport over litesvm (litesvm has no
// getProgramAccounts). Used by the `agenc dev` in-process sandbox fallback
// AND by the e2e suite; mirrors packages/agenc-worker/tests-e2e/gpa-sim.ts.
// The world that creates accounts registers their addresses; filters use
// EXACT RPC semantics.
import type { Address } from "@solana/kit";
import type { LiteSVM } from "litesvm";
import {
  AGENC_COORDINATION_PROGRAM_ADDRESS,
  type GpaFilter,
  type ProgramAccountsTransport,
} from "@tetsuo-ai/marketplace-sdk";

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

  /** Register addresses created by the sandbox world (idempotent). */
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
      if (acct.programAddress !== AGENC_COORDINATION_PROGRAM_ADDRESS) continue;
      const data = Uint8Array.from(acct.data);
      if (filters.every((f) => matchesFilter(f, data))) {
        out.push({ address, data });
      }
    }
    return out;
  }
}
