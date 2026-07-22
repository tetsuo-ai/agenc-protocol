/**
 * Fixed-byte snapshots for transaction and recovery boundaries.
 *
 * Solana's generated fixed-size encoders accept `ReadonlyUint8Array`, but an
 * adapter can supply that view from another browser/worker realm. Realm-local
 * `instanceof` checks reject those legitimate values, while permissive view
 * checks admit DataView, wider typed arrays, or SharedArrayBuffer-backed bytes
 * that another agent can change during a copy. Use the intrinsic brand and
 * backing-store getters so the accepted value is exactly a Uint8Array over an
 * ordinary ArrayBuffer, regardless of realm.
 */

const apply = Reflect.apply;
const Uint8ArrayIntrinsic = Uint8Array;
const arrayBufferIsView = ArrayBuffer.isView;
const typedArrayPrototype = Object.getPrototypeOf(
  Uint8ArrayIntrinsic.prototype,
);
const typedArrayTagGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  Symbol.toStringTag,
)?.get;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)?.get;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "buffer",
)?.get;
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)?.get;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const freeze = Object.freeze;

function isExactUint8Array(value: unknown): value is Uint8Array {
  return (
    arrayBufferIsView(value) &&
    apply(typedArrayTagGetter!, value, []) === "Uint8Array"
  );
}

function hasOrdinaryArrayBuffer(value: Uint8Array): boolean {
  try {
    const buffer = apply(typedArrayBufferGetter!, value, []);
    return (
      buffer !== undefined &&
      typeof apply(arrayBufferByteLengthGetter!, buffer, []) === "number"
    );
  } catch {
    // `%ArrayBuffer%.byteLength` rejects SharedArrayBuffer and foreign brands.
    return false;
  }
}

/**
 * Validate and detach one exact fixed-width byte value synchronously.
 * Cross-realm Uint8Arrays are accepted; shared backing and non-byte views are
 * rejected so later awaits observe one coherent caller intent.
 */
export function snapshotFixedBytes(
  value: unknown,
  byteLength: number,
  label: string,
): Uint8Array {
  if (
    !isExactUint8Array(value) ||
    apply(typedArrayByteLengthGetter!, value, []) !== byteLength ||
    !hasOrdinaryArrayBuffer(value)
  ) {
    throw new TypeError(`${label} must be exactly ${byteLength} bytes`);
  }
  return new Uint8ArrayIntrinsic(value);
}

/**
 * Validate and detach variable-width instruction data synchronously. This is
 * the generic counterpart to {@link snapshotFixedBytes}: only an exact
 * Uint8Array over an ordinary ArrayBuffer is accepted, including cross-realm
 * Uint8Arrays; proxies, detached views, spoofed views, and shared backing fail.
 */
export function snapshotByteArray(value: unknown, label: string): Uint8Array {
  if (!isExactUint8Array(value) || !hasOrdinaryArrayBuffer(value)) {
    throw new TypeError(
      `${label} must be a Uint8Array backed by an ordinary ArrayBuffer`,
    );
  }
  try {
    return new Uint8ArrayIntrinsic(value);
  } catch (cause) {
    throw new TypeError(
      `${label} must be a non-detached Uint8Array backed by an ordinary ArrayBuffer`,
      { cause },
    );
  }
}

/**
 * Snapshot a Kit `OptionOrNullable<ReadonlyUint8Array>` without retaining the
 * caller's bytes or Option wrapper across an async instruction-builder boundary.
 * The wrapper discriminator and payload must be own data properties so getters
 * cannot change the selected value between validation and encoding.
 */
export function snapshotOptionalFixedBytes<T>(
  value: T,
  byteLength: number,
  label: string,
): T {
  if (value === null) return value;
  if (isExactUint8Array(value)) {
    return snapshotFixedBytes(value, byteLength, label) as T;
  }
  if (typeof value !== "object" || value === null) {
    throw new TypeError(
      `${label} must be null, exactly ${byteLength} bytes, Some(bytes), or None`,
    );
  }
  const option = getOwnPropertyDescriptor(value, "__option");
  if (option === undefined || !("value" in option)) {
    throw new TypeError(
      `${label} option must have a stable data discriminator`,
    );
  }
  if (option.value === "None") {
    return freeze({ __option: "None" as const }) as T;
  }
  if (option.value !== "Some") {
    throw new TypeError(`${label} has an invalid Option discriminator`);
  }
  const someValue = getOwnPropertyDescriptor(value, "value");
  if (someValue === undefined || !("value" in someValue)) {
    throw new TypeError(`${label} Some value must be a stable data property`);
  }
  return freeze({
    __option: "Some" as const,
    value: snapshotFixedBytes(someValue.value, byteLength, `${label} Some`),
  }) as T;
}
