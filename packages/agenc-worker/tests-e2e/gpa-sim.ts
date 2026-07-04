// GpaSimulator: a ProgramAccountsTransport over litesvm (litesvm has no
// getProgramAccounts). Mirrors packages/sdk-ts/tests-e2e/gpa-sim.ts: the test
// world registers the addresses it creates; filters use EXACT RPC semantics.
import type { Address } from "@solana/kit";
import type { LiteSVM } from "litesvm";
import type { GpaFilter, ProgramAccountsTransport } from "@tetsuo-ai/marketplace-sdk";
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
