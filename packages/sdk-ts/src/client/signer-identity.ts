import {
  address,
  isTransactionSigner,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { snapshotByteArray } from "../values/fixed-bytes.js";

const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const defineProperty = Object.defineProperty;
const create = Object.create;
const ownKeys = Reflect.ownKeys;
const apply = Reflect.apply;
const arrayIsArray = Array.isArray;
const arrayPush = Array.prototype.push;

// Compiled Solana instruction/account indices are u8 values. Rejecting a
// larger or sparse caller-owned container also prevents an adversarial length
// from turning the synchronous intent snapshot into an unbounded loop.
const MAX_TRANSACTION_ITEMS = 256;

function safelyGetOwnPropertyDescriptor(
  value: object,
  key: PropertyKey,
  label: string,
): PropertyDescriptor | undefined {
  try {
    return getOwnPropertyDescriptor(value, key);
  } catch (cause) {
    throw new TypeError(`${label} must be safely inspectable`, { cause });
  }
}

/**
 * Copy only own data properties without invoking caller-controlled getters.
 * Transparent Proxies are reduced to an owned plain record; inconsistent or
 * throwing traps and accessor-backed records fail closed.
 */
function snapshotOwnDataRecord<T extends object>(value: T, label: string): T {
  let keys: readonly PropertyKey[];
  try {
    keys = ownKeys(value);
  } catch (cause) {
    throw new TypeError(`${label} must be safely inspectable`, { cause });
  }
  const snapshot = create(null) as Record<PropertyKey, unknown>;
  for (const key of keys) {
    const descriptor = safelyGetOwnPropertyDescriptor(value, key, label);
    if (descriptor === undefined) {
      throw new TypeError(`${label} changed while it was being inspected`);
    }
    if (!("value" in descriptor)) {
      throw new TypeError(`${label} must contain only own data properties`);
    }
    defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: descriptor.enumerable,
      configurable: true,
      writable: true,
    });
  }
  return snapshot as T;
}

/** Snapshot one dense array without consulting its caller-controlled `map`. */
function snapshotDenseArray<T>(values: readonly T[], label: string): T[] {
  let isArray: boolean;
  try {
    isArray = arrayIsArray(values);
  } catch (cause) {
    throw new TypeError(`${label} must be a safely inspectable array`, {
      cause,
    });
  }
  if (!isArray) throw new TypeError(`${label} must be an array`);

  const lengthDescriptor = safelyGetOwnPropertyDescriptor(
    values,
    "length",
    label,
  );
  const length =
    lengthDescriptor !== undefined && "value" in lengthDescriptor
      ? lengthDescriptor.value
      : undefined;
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_TRANSACTION_ITEMS
  ) {
    throw new TypeError(
      `${label} must be a dense array of at most ${MAX_TRANSACTION_ITEMS} items`,
    );
  }

  const snapshot: T[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = safelyGetOwnPropertyDescriptor(
      values,
      String(index),
      `${label}[${index}]`,
    );
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(
        `${label} must be dense and contain only own data entries`,
      );
    }
    apply(arrayPush, snapshot, [descriptor.value]);
  }
  return snapshot;
}

function lockTransactionSignerAtAddress(
  signer: TransactionSigner,
  signerAddress: TransactionSigner["address"],
): TransactionSigner {
  const descriptor = getOwnPropertyDescriptor(signer, "address");
  if (
    descriptor === undefined ||
    descriptor.configurable === true ||
    ("value" in descriptor && descriptor.writable === true)
  ) {
    try {
      defineProperty(signer, "address", {
        value: signerAddress,
        enumerable: descriptor?.enumerable ?? true,
        configurable: false,
        writable: false,
      });
    } catch (cause) {
      throw new TypeError(
        "stabilizeTransactionSigner: signer.address must be lockable for transaction identity safety",
        { cause },
      );
    }
  } else if (!("value" in descriptor) || descriptor.value !== signerAddress) {
    throw new TypeError(
      "stabilizeTransactionSigner: signer.address must be a stable canonical data property",
    );
  }
  return signer;
}

/**
 * Lock a mutable transaction signer to one canonical identity before it crosses
 * an async transaction-building boundary. Only the address property is locked:
 * the capability object identity and unrelated mutable signer/session state are
 * preserved for Solana Kit and wallet adapters.
 */
export function stabilizeTransactionSigner(
  signer: TransactionSigner,
): TransactionSigner {
  return lockTransactionSignerAtAddress(signer, address(signer.address));
}

class SignerIdentityRegistry {
  readonly #byAddress = new Map<string, TransactionSigner>();

  constructor(preferredSigner?: TransactionSigner) {
    if (preferredSigner !== undefined) this.canonicalize(preferredSigner);
  }

  canonicalize<TSigner extends TransactionSigner>(signer: TSigner): TSigner {
    // Capture exactly once. Mutable accessors must not be able to present one
    // address for lookup and a second address while the signer is locked.
    const signerAddress = address(signer.address);
    const existing = this.#byAddress.get(signerAddress);
    if (existing !== undefined) return existing as TSigner;

    const stable = lockTransactionSignerAtAddress(signer, signerAddress);
    this.#byAddress.set(signerAddress, stable);
    return stable as TSigner;
  }
}

/**
 * Stabilize a signer tuple and collapse equal public keys to one capability
 * object. The optional preferred signer wins its address (the transaction fee
 * payer uses this), while distinct addresses and capabilities remain distinct.
 */
export function canonicalizeTransactionSigners<
  const TSigners extends readonly TransactionSigner[],
>(
  signers: TSigners,
  preferredSigner?: TransactionSigner,
): { [K in keyof TSigners]: TSigners[K] } {
  const registry = new SignerIdentityRegistry(preferredSigner);
  const signerSnapshot = snapshotDenseArray(signers, "transaction signers");
  const canonical: TransactionSigner[] = [];
  for (let index = 0; index < signerSnapshot.length; index += 1) {
    apply(arrayPush, canonical, [
      registry.canonicalize(signerSnapshot[index]!),
    ]);
  }
  return canonical as { [K in keyof TSigners]: TSigners[K] };
}

function isSigner(value: unknown): value is TransactionSigner {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  ) {
    return false;
  }
  return isTransactionSigner(
    value as { [key: string]: unknown; address: TransactionSigner["address"] },
  );
}

/**
 * Shallow-snapshot a facade input and stabilize every top-level signer before
 * the async generated builder gets a chance to derive PDAs or account metas.
 */
export function canonicalizeFacadeInputSigners<TInput>(
  input: TInput,
  preferredSigner: TransactionSigner,
): TInput {
  if (
    (typeof input !== "object" || input === null) &&
    typeof input !== "function"
  ) {
    throw new TypeError("client facade input must be an object");
  }
  // Lock the explicitly typed signer before consulting any caller-controlled
  // input reflection. A Proxy ownKeys/descriptor trap must not get a chance to
  // redirect the preferred identity between argument capture and locking.
  const registry = new SignerIdentityRegistry(preferredSigner);
  const snapshot = snapshotOwnDataRecord(
    input as object,
    "client facade input",
  ) as Record<PropertyKey, unknown>;
  for (const key of ownKeys(snapshot)) {
    const value = snapshot[key];
    if (value === preferredSigner) {
      snapshot[key] = registry.canonicalize(preferredSigner);
    } else if (isSigner(value)) {
      snapshot[key] = registry.canonicalize(value);
    }
  }
  return snapshot as TInput;
}

/**
 * Snapshot a facade input while binding every statically known signer field
 * before any caller-controlled whole-object reflection. Use this for facades
 * with more than one signer role; structural runtime classification cannot
 * safely infer an adversarial Proxy's capability role.
 */
export function canonicalizeFacadeInputSignerFields<
  TInput extends object,
  const TKeys extends readonly (keyof TInput)[],
  const TOptionalKeys extends readonly (keyof TInput)[] = readonly [],
>(
  input: TInput,
  signerKeys: TKeys,
  optionalSignerKeys: TOptionalKeys = [] as unknown as TOptionalKeys,
): TInput {
  if (signerKeys.length === 0) {
    throw new TypeError("client facade signer fields must not be empty");
  }

  const captured = new Map<keyof TInput, TransactionSigner>();
  let registry: SignerIdentityRegistry | undefined;
  const captureSigner = (key: keyof TInput, optional: boolean) => {
    const descriptor = safelyGetOwnPropertyDescriptor(
      input,
      key as PropertyKey,
      `client facade signer field ${String(key)}`,
    );
    if (descriptor === undefined) {
      if (optional) return;
      throw new TypeError(
        `client facade signer field ${String(key)} must be an own data property`,
      );
    }
    if (!("value" in descriptor)) {
      throw new TypeError(
        `client facade signer field ${String(key)} must be an own data property`,
      );
    }
    if (optional && descriptor.value === undefined) return;
    const signer = descriptor.value as TransactionSigner;
    if (registry === undefined) registry = new SignerIdentityRegistry(signer);
    captured.set(key, registry.canonicalize(signer));
  };

  for (let index = 0; index < signerKeys.length; index += 1) {
    captureSigner(signerKeys[index]!, false);
  }
  for (let index = 0; index < optionalSignerKeys.length; index += 1) {
    const key = optionalSignerKeys[index]!;
    if (captured.has(key)) {
      throw new TypeError(
        `client facade signer field ${String(key)} must not be listed twice`,
      );
    }
    captureSigner(key, true);
  }

  const snapshot = snapshotOwnDataRecord(
    input,
    "client facade input",
  ) as Record<PropertyKey, unknown>;
  for (const [key, signer] of captured) {
    snapshot[key as PropertyKey] = signer;
  }
  for (const key of ownKeys(snapshot)) {
    if (captured.has(key as keyof TInput)) continue;
    const value = snapshot[key];
    if (isSigner(value)) snapshot[key] = registry!.canonicalize(value);
  }
  return snapshot as TInput;
}

type SignerAccountMeta = NonNullable<Instruction["accounts"]>[number] & {
  readonly signer?: unknown;
};

/**
 * Snapshot instruction account metas and collapse duplicate signer wrappers
 * before the first blockhash await. This is the final generic guard for direct
 * `client.send()` callers and custom facade builders.
 */
export function canonicalizeInstructionSigners(
  instructions: readonly Instruction[],
  feePayer: TransactionSigner,
): readonly Instruction[] {
  const registry = new SignerIdentityRegistry(feePayer);
  const instructionInputs = snapshotDenseArray(
    instructions,
    "client.send: instructions",
  );
  const canonicalInstructions: Instruction[] = [];
  for (
    let instructionIndex = 0;
    instructionIndex < instructionInputs.length;
    instructionIndex += 1
  ) {
    const instruction = snapshotOwnDataRecord(
      instructionInputs[instructionIndex]!,
      `client.send: instructions[${instructionIndex}]`,
    );
    const instructionData = instruction.data;
    const instructionAccounts = instruction.accounts;
    const data =
      instructionData === undefined
        ? undefined
        : snapshotByteArray(instructionData, "client.send: instruction.data");
    if (instructionAccounts === undefined) {
      apply(arrayPush, canonicalInstructions, [
        {
          ...instruction,
          ...(data === undefined ? {} : { data }),
        },
      ]);
      continue;
    }
    const accountInputs = snapshotDenseArray(
      instructionAccounts,
      `client.send: instructions[${instructionIndex}].accounts`,
    );
    const accounts: SignerAccountMeta[] = [];
    for (
      let accountIndex = 0;
      accountIndex < accountInputs.length;
      accountIndex += 1
    ) {
      const meta = snapshotOwnDataRecord(
        accountInputs[accountIndex] as SignerAccountMeta,
        `client.send: instructions[${instructionIndex}].accounts[${accountIndex}]`,
      );
      const candidateSigner = meta.signer;
      if (candidateSigner === undefined) {
        apply(arrayPush, accounts, [meta]);
        continue;
      }
      if (!isSigner(candidateSigner))
        throw new TypeError(
          "client.send: instruction signer metadata must contain a transaction signer",
        );
      const stableSigner = registry.canonicalize(candidateSigner);
      const accountAddress = address(meta.address);
      if (accountAddress !== stableSigner.address) {
        throw new TypeError(
          "client.send: instruction signer address does not match signer.address",
        );
      }
      apply(arrayPush, accounts, [
        {
          ...meta,
          address: stableSigner.address,
          signer: stableSigner,
        },
      ]);
    }
    apply(arrayPush, canonicalInstructions, [
      {
        ...instruction,
        accounts,
        ...(data === undefined ? {} : { data }),
      } as Instruction,
    ]);
  }
  return canonicalInstructions;
}
