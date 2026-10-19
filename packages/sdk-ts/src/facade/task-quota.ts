import { AccountRole, type AccountMeta, type Address } from "@solana/kit";
import { findTaskQuotaPda } from "../generated/index.js";
import { assertCapability, type CapabilitySet } from "./surface.js";

export type TaskCreationQuotaInput = {
  /** Opt in to a previously multisig-approved wallet quota on revision 7. */
  taskQuotaSurface?: CapabilitySet;
};

/** Snapshot the capability decision before any asynchronous PDA resolution. */
export function snapshotTaskQuotaSurface(surface: CapabilitySet | undefined) {
  if (surface === undefined) return false;
  assertCapability(surface, "taskCreationQuotas");
  return true;
}

export async function appendTaskCreationQuota<
  T extends { readonly accounts: readonly AccountMeta[] },
>(instruction: Promise<T>, authority: Address, include: boolean) {
  const ix = await instruction;
  if (!include) return ix;
  const [quota] = await findTaskQuotaPda({ taskAuthority: authority });
  return {
    ...ix,
    accounts: [...ix.accounts, { address: quota, role: AccountRole.WRITABLE }],
  };
}
