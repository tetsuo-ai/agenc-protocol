// Facade: ergonomic, named entry points over the generated client. Thin by design —
// the generated client already resolves PDAs and encodes data; the facade adds friendly
// signatures, defaults, and (for multi-PDA flows) bundling. Never import from generated/
// internals other than its public exports.
//
// Domain: batch-2 on-chain store identity (P5.2). `register_store` is the
// PERMISSIONLESS self-registration path — one `Store` per wallet (PDA
// `["store", owner]`), paying rent plus the fixed registration bond onto the
// PDA. `update_store` rewrites the mutable identity fields in place, and
// `close_store` refunds rent + the bond (never confiscatable, owner-only).
import type { ReadonlyUint8Array } from "@solana/kit";
import {
  getRegisterStoreInstructionAsync,
  getUpdateStoreInstructionAsync,
  getCloseStoreInstructionAsync,
  findStorePda,
  fetchStore,
  fetchMaybeStore,
  type RegisterStoreAsyncInput,
  type UpdateStoreAsyncInput,
  type CloseStoreAsyncInput,
} from "../generated/index.js";
import { encodeStoreHandle } from "../values/index.js";

export { findStorePda, fetchStore, fetchMaybeStore };

/**
 * The fixed store registration bond, held as excess lamports on the `Store`
 * PDA and refunded in full by {@link closeStore}. Mirrors the on-chain
 * `STORE_REGISTRATION_BOND_LAMPORTS` (0.05 SOL, CPI-enforced).
 */
export const STORE_REGISTRATION_BOND_LAMPORTS = 50_000_000n;

/**
 * Friendly input for {@link registerStore}. Identical to the generated
 * `RegisterStoreAsyncInput`, except `handle` accepts EITHER the raw on-chain
 * 32-byte zero-padded form (passed through byte-for-byte, for power users) OR
 * the plain string form, which the facade validates and encodes via
 * `values.encodeStoreHandle` (3-20 chars of lowercase `[a-z0-9-]`, starting
 * alphanumeric).
 */
export type RegisterStoreInput = Omit<RegisterStoreAsyncInput, "handle"> & {
  /** Store handle: raw 32-byte zero-padded field, or a plain string. */
  handle: RegisterStoreAsyncInput["handle"] | string;
};

/** Same string-or-bytes `handle` convenience for {@link updateStore}. */
export type UpdateStoreInput = Omit<UpdateStoreAsyncInput, "handle"> & {
  /** Store handle: raw 32-byte zero-padded field, or a plain string. */
  handle: UpdateStoreAsyncInput["handle"] | string;
};

/** Encode the string form of a handle; pass raw bytes through untouched. */
function coerceHandle(
  handle: ReadonlyUint8Array | string,
): ReadonlyUint8Array {
  return typeof handle === "string" ? encodeStoreHandle(handle) : handle;
}

/**
 * Build a register_store instruction (batch-2 P5.2, PERMISSIONLESS).
 *
 * The `owner` signer self-registers an on-chain `Store` identity — the store
 * PDA (`["store", owner]`, auto-derived) and systemProgram are filled in by
 * the generated builder, so callers only supply the identity fields. `init`
 * means one store per wallet: registering twice fails at account creation,
 * and a re-register after {@link closeStore} re-inits a fresh entry. The
 * owner pays rent AND the fixed {@link STORE_REGISTRATION_BOND_LAMPORTS}
 * bond, both refunded at close.
 *
 * The on-chain handle rule (`InvalidStoreHandle`) is a charset floor, NOT a
 * uniqueness claim — handle collisions are resolved by consumers (e.g. by
 * registration time or curation), never by the program.
 */
export async function registerStore(input: RegisterStoreInput) {
  return getRegisterStoreInstructionAsync({
    ...input,
    handle: coerceHandle(input.handle),
  });
}

/**
 * Build an update_store instruction (owner-only). Rewrites the mutable
 * identity fields (`handle`, metadata pointer, fee terms, operator, domain)
 * in place on the owner's store PDA (auto-derived from the `owner` signer).
 * The bond stays untouched on the PDA across updates.
 */
export async function updateStore(input: UpdateStoreInput) {
  return getUpdateStoreInstructionAsync({
    ...input,
    handle: coerceHandle(input.handle),
  });
}

/**
 * Build a close_store instruction (owner-only). Closes the owner's store PDA
 * (auto-derived from the `owner` signer) and refunds rent + the registration
 * bond to the owner in one step — the full, never-confiscatable refund.
 */
export async function closeStore(input: CloseStoreAsyncInput) {
  return getCloseStoreInstructionAsync(input);
}
