/**
 * Browser-safe structured-clone boundary for funded orchestration inputs.
 *
 * `structuredClone()` deliberately preserves SharedArrayBuffer backing. That
 * is correct for general JavaScript messaging but unsafe for a transaction
 * intent snapshot: another agent can mutate nested shared bytes after enqueue.
 * Inspect the complete reachable data graph first, without reading ordinary
 * accessor properties, then clone only graphs that contain no shared memory.
 */

const ownKeys = Reflect.ownKeys;
const apply = Reflect.apply;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const arrayBufferIsView = ArrayBuffer.isView;
const structuredCloneIntrinsic = structuredClone;
const weakSetAdd = WeakSet.prototype.add;
const weakSetHas = WeakSet.prototype.has;
const arrayPush = Array.prototype.push;
const arrayPop = Array.prototype.pop;
const arrayIsArray = Array.isArray;

const MAX_DENSE_TRANSACTION_ITEMS = 256;

const sharedArrayBufferByteLengthGetter =
  typeof SharedArrayBuffer === "undefined"
    ? undefined
    : getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayBufferGetter = getOwnPropertyDescriptor(
  typedArrayPrototype,
  "buffer",
)?.get;
const dataViewBufferGetter = getOwnPropertyDescriptor(
  DataView.prototype,
  "buffer",
)?.get;
const webAssemblyMemoryBufferGetter =
  typeof WebAssembly === "undefined" || WebAssembly.Memory === undefined
    ? undefined
    : getOwnPropertyDescriptor(WebAssembly.Memory.prototype, "buffer")?.get;

const mapSizeGetter = getOwnPropertyDescriptor(Map.prototype, "size")?.get;
const mapEntries = Map.prototype.entries;
const mapIteratorNext = Object.getPrototypeOf(new Map().entries()).next as (
  this: MapIterator<[unknown, unknown]>,
) => IteratorResult<[unknown, unknown]>;
const setSizeGetter = getOwnPropertyDescriptor(Set.prototype, "size")?.get;
const setValues = Set.prototype.values;
const setIteratorNext = Object.getPrototypeOf(new Set().values()).next as (
  this: SetIterator<unknown>,
) => IteratorResult<unknown>;

function hasSharedArrayBufferBrand(value: object): boolean {
  if (sharedArrayBufferByteLengthGetter === undefined) return false;
  try {
    apply(sharedArrayBufferByteLengthGetter, value, []);
    return true;
  } catch {
    return false;
  }
}

function viewBackingBuffer(value: ArrayBufferView): ArrayBufferLike {
  try {
    return apply(typedArrayBufferGetter!, value, []) as ArrayBufferLike;
  } catch {
    try {
      return apply(dataViewBufferGetter!, value, []) as ArrayBufferLike;
    } catch (cause) {
      throw new TypeError(
        "structured clone input contains an uninspectable ArrayBuffer view",
        { cause },
      );
    }
  }
}

function hasMapBrand(value: object): value is Map<unknown, unknown> {
  try {
    apply(mapSizeGetter!, value, []);
    return true;
  } catch {
    return false;
  }
}

function hasSetBrand(value: object): value is Set<unknown> {
  try {
    apply(setSizeGetter!, value, []);
    return true;
  } catch {
    return false;
  }
}

function webAssemblyMemoryBackingBuffer(value: object): ArrayBufferLike | null {
  if (webAssemblyMemoryBufferGetter === undefined) return null;
  try {
    return apply(webAssemblyMemoryBufferGetter, value, []) as ArrayBufferLike;
  } catch {
    return null;
  }
}

function enqueueMapEntries(
  value: Map<unknown, unknown>,
  pending: unknown[],
): void {
  const iterator = apply(mapEntries, value, []);
  for (;;) {
    const entry = apply(mapIteratorNext, iterator, []);
    if (entry.done) return;
    apply(arrayPush, pending, [entry.value[0], entry.value[1]]);
  }
}

function enqueueSetValues(value: Set<unknown>, pending: unknown[]): void {
  const iterator = apply(setValues, value, []);
  for (;;) {
    const entry = apply(setIteratorNext, iterator, []);
    if (entry.done) return;
    apply(arrayPush, pending, [entry.value]);
  }
}

/**
 * Reject shared backing anywhere in a structured-clone graph. The traversal is
 * iterative and cycle-safe. Ordinary accessors are rejected from descriptors
 * before `structuredClone` can invoke them. ECMAScript exposes no portable,
 * trap-free Proxy detector; proxy inspection/clone failures are therefore
 * caught and surfaced before any caller callback or transaction submission.
 */
export function assertNoReachableSharedMemory(
  value: unknown,
  label: string,
): void {
  const pending: unknown[] = [value];
  const visited = new WeakSet<object>();

  while (pending.length > 0) {
    const current = apply(arrayPop, pending, []);
    if (
      (typeof current !== "object" || current === null) &&
      typeof current !== "function"
    ) {
      continue;
    }
    const object = current as object;
    if (apply(weakSetHas, visited, [object])) continue;
    apply(weakSetAdd, visited, [object]);

    if (hasSharedArrayBufferBrand(object)) {
      throw new TypeError(
        `${label} must not contain SharedArrayBuffer or SharedArrayBuffer-backed views`,
      );
    }
    if (arrayBufferIsView(object)) {
      const buffer = viewBackingBuffer(object);
      if (hasSharedArrayBufferBrand(buffer as object)) {
        throw new TypeError(
          `${label} must not contain SharedArrayBuffer or SharedArrayBuffer-backed views`,
        );
      }
    }
    const webAssemblyMemoryBuffer = webAssemblyMemoryBackingBuffer(object);
    if (
      webAssemblyMemoryBuffer !== null &&
      hasSharedArrayBufferBrand(webAssemblyMemoryBuffer as object)
    ) {
      throw new TypeError(
        `${label} must not contain shared WebAssembly.Memory instances`,
      );
    }

    if (hasMapBrand(object)) enqueueMapEntries(object, pending);
    if (hasSetBrand(object)) enqueueSetValues(object, pending);

    let keys: readonly PropertyKey[];
    try {
      keys = ownKeys(object);
    } catch (cause) {
      throw new TypeError(`${label} must be safely inspectable`, { cause });
    }
    for (const key of keys) {
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = getOwnPropertyDescriptor(object, key);
      } catch (cause) {
        throw new TypeError(`${label} must be safely inspectable`, { cause });
      }
      if (descriptor === undefined) continue;
      if (!("value" in descriptor)) {
        throw new TypeError(
          `${label} must not contain accessor properties at its snapshot boundary`,
        );
      }
      apply(arrayPush, pending, [descriptor.value]);
    }
  }
}

/** Validate a graph for transaction-intent safety, then detach it. */
export function snapshotStructuredClone<T>(value: T, label: string): T {
  assertNoReachableSharedMemory(value, label);
  try {
    const snapshot = structuredCloneIntrinsic(value);
    // Inspect the result as well. Besides defending against future host clone
    // types that manufacture shared backing during clone, this guarantees the
    // value returned across the funded boundary satisfies the same invariant.
    assertNoReachableSharedMemory(snapshot, label);
    return snapshot;
  } catch (cause) {
    throw new TypeError(`${label} must be structured-cloneable`, { cause });
  }
}

/**
 * Detach a caller-owned array without consulting any caller-owned iteration
 * method. Sparse/accessor entries fail closed: account-wire arrays must have a
 * concrete record at every counted position.
 */
export function snapshotDenseStructuredArray<T>(
  value: readonly T[],
  label: string,
  maxItems = MAX_DENSE_TRANSACTION_ITEMS,
): T[] {
  if (!Number.isSafeInteger(maxItems) || maxItems < 0) {
    throw new TypeError(`${label} has an invalid item limit`);
  }
  let isArray: boolean;
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    isArray = arrayIsArray(value);
    lengthDescriptor = getOwnPropertyDescriptor(value, "length");
  } catch (cause) {
    throw new TypeError(`${label} must be a safely inspectable array`, {
      cause,
    });
  }
  const length =
    lengthDescriptor !== undefined && "value" in lengthDescriptor
      ? lengthDescriptor.value
      : undefined;
  if (
    !isArray ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > maxItems
  ) {
    throw new TypeError(
      `${label} must be a dense array of at most ${maxItems} items`,
    );
  }

  // Reject holes/accessors before cloning so a sparse length can never stand
  // in for a required account record.
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = getOwnPropertyDescriptor(value, String(index));
    } catch (cause) {
      throw new TypeError(`${label}[${index}] must be safely inspectable`, {
        cause,
      });
    }
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(
        `${label} must be dense and contain only own data entries`,
      );
    }
  }

  const clone = snapshotStructuredClone(value, label);
  const dense: T[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = getOwnPropertyDescriptor(clone, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${label} changed while it was being snapshotted`);
    }
    apply(arrayPush, dense, [descriptor.value]);
  }
  return dense;
}
