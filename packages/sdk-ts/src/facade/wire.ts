// Browser-safe helpers for facade-only hashes and remaining-account suffixes.
// Instruction account layouts and data encoding belong to the generated client.

import {
  AccountRole,
  isTransactionSigner,
  type AccountMeta,
  type TransactionSigner,
} from "@solana/kit";
import {
  canonicalizeFacadeInputSignerFields,
  stabilizeTransactionSigner,
} from "../client/signer-identity.js";

const apply = Reflect.apply;
const arrayIsArray = Array.isArray;
const arrayPush = Array.prototype.push;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const freeze = Object.freeze;
const numberIsSafeInteger = Number.isSafeInteger;
const setAdd = Set.prototype.add;
const setHas = Set.prototype.has;

// A configured ProtocolConfig has at most five owners. updateMultisig is the
// only instruction that can legitimately need more: its remaining-account
// suffix may contain the disjoint union of the old and proposed owner sets.
const MAX_MULTISIG_APPROVALS = 10;

/**
 * Own and stabilize a caller-provided ProtocolConfig approval list before any
 * async instruction builder can observe a wallet account switch.
 */
export function snapshotMultisigSigners(
  multisigSigners: readonly TransactionSigner[],
  preferredSigners: readonly TransactionSigner[] = [],
): readonly TransactionSigner[] {
  let isArray: boolean;
  try {
    isArray = arrayIsArray(multisigSigners);
  } catch (cause) {
    throw new TypeError("multisigSigners must be safely inspectable", {
      cause,
    });
  }
  if (!isArray) {
    throw new TypeError("multisigSigners must be an array");
  }
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    lengthDescriptor = getOwnPropertyDescriptor(multisigSigners, "length");
  } catch (cause) {
    throw new TypeError("multisigSigners must be safely inspectable", {
      cause,
    });
  }
  const length =
    lengthDescriptor !== undefined && "value" in lengthDescriptor
      ? lengthDescriptor.value
      : undefined;
  if (
    !numberIsSafeInteger(length) ||
    length < 0 ||
    length > MAX_MULTISIG_APPROVALS
  ) {
    throw new TypeError(
      `multisigSigners must be a dense array of at most ${MAX_MULTISIG_APPROVALS} approvals`,
    );
  }

  const preferredByAddress = new Map<string, TransactionSigner>();
  for (let index = 0; index < preferredSigners.length; index += 1) {
    let stableSigner: TransactionSigner;
    let signerIsTransactionSigner: boolean;
    try {
      stableSigner = stabilizeTransactionSigner(preferredSigners[index]!);
      signerIsTransactionSigner = isTransactionSigner(stableSigner);
    } catch (cause) {
      throw new TypeError(
        `preferredSigners[${index}] must be safely inspectable`,
        { cause },
      );
    }
    if (!signerIsTransactionSigner) {
      throw new TypeError(
        `preferredSigners[${index}] must be a transaction signer`,
      );
    }
    if (!preferredByAddress.has(stableSigner.address)) {
      preferredByAddress.set(stableSigner.address, stableSigner);
    }
  }

  const signerAddresses = new Set<string>();
  const snapshot: TransactionSigner[] = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = getOwnPropertyDescriptor(multisigSigners, String(index));
    } catch (cause) {
      throw new TypeError("multisigSigners must be safely inspectable", {
        cause,
      });
    }
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(
        "multisigSigners must be dense and contain only own data entries",
      );
    }
    const signer = descriptor.value as TransactionSigner;
    let stableSigner: TransactionSigner;
    let signerIsTransactionSigner: boolean;
    try {
      // Bind the address before capability probing. A hostile capability getter
      // must not be able to switch the public key that is later placed in the
      // account meta.
      stableSigner = stabilizeTransactionSigner(signer);
      signerIsTransactionSigner = isTransactionSigner(stableSigner);
    } catch (cause) {
      throw new TypeError(
        `multisigSigners[${index}] must be safely inspectable`,
        { cause },
      );
    }
    if (!signerIsTransactionSigner) {
      throw new TypeError(
        `multisigSigners[${index}] must be a transaction signer`,
      );
    }
    if (apply(setHas, signerAddresses, [stableSigner.address])) {
      throw new Error(
        `multisigSigners: duplicate signer address ${stableSigner.address}`,
      );
    }
    apply(setAdd, signerAddresses, [stableSigner.address]);
    apply(arrayPush, snapshot, [
      preferredByAddress.get(stableSigner.address) ?? stableSigner,
    ]);
  }
  return freeze(snapshot);
}

/**
 * Snapshot a multisig-gated facade input before its generated builder yields.
 * Statically named signer roles win identity for equal-address approvals so a
 * directly consumed Solana Kit instruction never carries two capabilities for
 * one public key.
 */
export function snapshotMultisigFacadeInput<
  TInput extends object & {
    readonly multisigSigners?: readonly TransactionSigner[];
  },
  const TSignerKeys extends readonly (keyof TInput)[],
  const TOptionalSignerKeys extends readonly (keyof TInput)[] = readonly [],
>(
  input: TInput,
  signerKeys: TSignerKeys,
  options: {
    readonly multisigRequired?: boolean;
    readonly optionalSignerKeys?: TOptionalSignerKeys;
  } = {},
): Readonly<{
  generatedInput: Omit<TInput, "multisigSigners">;
  multisigSigners: readonly TransactionSigner[];
}> {
  const stableInput = canonicalizeFacadeInputSignerFields(
    input,
    signerKeys,
    options.optionalSignerKeys ?? ([] as unknown as TOptionalSignerKeys),
  );
  const { multisigSigners, ...generatedInput } = stableInput;
  if (multisigSigners === undefined && options.multisigRequired !== false) {
    throw new TypeError("multisigSigners must be an own data property");
  }

  const preferredSigners: TransactionSigner[] = [];
  for (let index = 0; index < signerKeys.length; index += 1) {
    apply(arrayPush, preferredSigners, [
      stableInput[signerKeys[index]!] as TransactionSigner,
    ]);
  }
  const optionalSignerKeys = options.optionalSignerKeys ?? [];
  for (let index = 0; index < optionalSignerKeys.length; index += 1) {
    const signer = stableInput[optionalSignerKeys[index]!] as
      | TransactionSigner
      | undefined;
    if (signer !== undefined) apply(arrayPush, preferredSigners, [signer]);
  }

  return freeze({
    generatedInput: generatedInput as Omit<TInput, "multisigSigners">,
    multisigSigners: snapshotMultisigSigners(
      multisigSigners ?? [],
      preferredSigners,
    ),
  });
}

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
>(instruction: TInstruction, multisigSigners: readonly TransactionSigner[]) {
  const namedSigners: TransactionSigner[] = [];
  for (let index = 0; index < instruction.accounts.length; index += 1) {
    const account = instruction.accounts[index]!;
    if ("signer" in account && account.signer !== undefined) {
      apply(arrayPush, namedSigners, [account.signer]);
    }
  }
  const stableSigners = snapshotMultisigSigners(multisigSigners, namedSigners);
  const signerMetas: AccountMeta[] = [];
  for (let index = 0; index < stableSigners.length; index += 1) {
    const signer = stableSigners[index]!;
    apply(arrayPush, signerMetas, [
      {
        address: signer.address,
        role: AccountRole.READONLY_SIGNER as const,
        signer,
      },
    ]);
  }

  return {
    ...instruction,
    accounts: [...instruction.accounts, ...signerMetas],
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
    throw new RangeError(
      `${label}: expected ${size} bytes, got ${value.length}`,
    );
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

export function concatBytes(
  ...chunks: readonly ArrayLike<number>[]
): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
