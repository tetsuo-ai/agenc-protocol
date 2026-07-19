// Browser-safe helpers for facade-only hashes and remaining-account suffixes.
// Instruction account layouts and data encoding belong to the generated client.

import {
  AccountRole,
  type AccountMeta,
  type TransactionSigner,
} from "@solana/kit";

/**
 * Append ProtocolConfig M-of-N approvals in Rust's remaining-account order.
 * Signers must be distinct system-wallet keys. Ownership is enforced on-chain;
 * this helper enforces the structural invariants knowable while building.
 *
 * A signer may intentionally repeat a named account (most commonly the named
 * `authority`). Rust counts approvals only from `remaining_accounts`, so an
 * owner used as a named account must also appear in this appended suffix for
 * its approval to count.
 */
export function appendMultisigSignerMetas<
  TInstruction extends { readonly accounts: readonly AccountMeta[] },
>(
  instruction: TInstruction,
  multisigSigners: readonly TransactionSigner[],
) {
  const signerAddresses = new Set<string>();
  for (const signer of multisigSigners) {
    if (signerAddresses.has(signer.address)) {
      throw new Error(
        `multisigSigners: duplicate signer address ${signer.address}`,
      );
    }
    signerAddresses.add(signer.address);
  }

  return {
    ...instruction,
    accounts: [
      ...instruction.accounts,
      ...multisigSigners.map((signer) => ({
        address: signer.address,
        role: AccountRole.READONLY_SIGNER as const,
        signer,
      })),
    ],
  };
}

function integerValue(value: number | bigint, label: string): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`${label}: expected a safe integer`);
    }
    return BigInt(value);
  }
  return value;
}

export function fixedBytes(
  value: ArrayLike<number>,
  size: number,
  label: string,
): Uint8Array {
  if (value.length !== size) {
    throw new RangeError(`${label}: expected ${size} bytes, got ${value.length}`);
  }
  return Uint8Array.from(value);
}

export function u16Le(value: number, label: string): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`${label}: expected an unsigned 16-bit integer`);
  }
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

export function u32Le(value: number, label: string): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${label}: expected an unsigned 32-bit integer`);
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

export function u64Le(value: number | bigint, label: string): Uint8Array {
  const integer = integerValue(value, label);
  if (integer < 0n || integer > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`${label}: expected an unsigned 64-bit integer`);
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, integer, true);
  return bytes;
}

export function i64Le(value: number | bigint, label: string): Uint8Array {
  const integer = integerValue(value, label);
  if (integer < -0x8000_0000_0000_0000n || integer > 0x7fff_ffff_ffff_ffffn) {
    throw new RangeError(`${label}: expected a signed 64-bit integer`);
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, integer, true);
  return bytes;
}

export function concatBytes(...chunks: readonly ArrayLike<number>[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
