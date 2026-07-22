import { address, type Address } from "@solana/kit";

const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const freeze = Object.freeze;

export type ExplicitOption<T> =
  | { readonly __option: "None" }
  | { readonly __option: "Some"; readonly value: T };

/**
 * Detach a Kit `OptionOrNullable` scalar from a caller-owned explicit Option
 * wrapper before an async instruction builder. Raw scalar values are immutable;
 * explicit wrappers must expose own data properties and are copied/frozen.
 */
export function snapshotOptionOrNullable<T>(
  value: T | null | ExplicitOption<T>,
  label: string,
  snapshotSome: (value: T) => T = (item) => item,
): T | null | ExplicitOption<T> {
  if (value === null || typeof value !== "object") {
    return value === null ? null : snapshotSome(value);
  }
  const option = getOwnPropertyDescriptor(value, "__option");
  if (option === undefined || !("value" in option)) {
    throw new TypeError(
      `${label} must be a scalar, Some(value), None, or null with a stable data discriminator`,
    );
  }
  if (option.value === "None") {
    return freeze({ __option: "None" as const });
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
    value: snapshotSome(someValue.value as T),
  });
}

/** Snapshot and runtime-validate an optional Solana address by value. */
export function snapshotOptionalAddress<T extends Address>(
  value: T | null | ExplicitOption<T>,
  label: string,
): T | null | ExplicitOption<T> {
  return snapshotOptionOrNullable(value, label, (candidate) =>
    address(candidate),
  ) as T | null | ExplicitOption<T>;
}
