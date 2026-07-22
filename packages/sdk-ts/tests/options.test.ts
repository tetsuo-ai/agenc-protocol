import { describe, expect, it } from "vitest";
import { address } from "@solana/kit";
import {
  snapshotOptionOrNullable,
  snapshotOptionalAddress,
} from "../src/values/options.js";

const A = address("HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK");
const B = address("So11111111111111111111111111111111111111112");

describe("OptionOrNullable intent snapshots", () => {
  it("preserves raw and null scalar values and freezes detached wrappers", () => {
    expect(snapshotOptionOrNullable(7n, "raw")).toBe(7n);
    expect(snapshotOptionOrNullable(null, "null")).toBeNull();

    const none = snapshotOptionOrNullable(
      { __option: "None" as const },
      "none",
    );
    expect(none).toEqual({ __option: "None" });
    expect(Object.isFrozen(none)).toBe(true);

    const wrapper = { __option: "Some" as const, value: 11n };
    const some = snapshotOptionOrNullable(wrapper, "some");
    wrapper.value = 99n;
    expect(some).toEqual({ __option: "Some", value: 11n });
    expect(some).not.toBe(wrapper);
    expect(Object.isFrozen(some)).toBe(true);
  });

  it("snapshots and validates an address payload before caller mutation", () => {
    const wrapper: { __option: "Some"; value: ReturnType<typeof address> } = {
      __option: "Some",
      value: A,
    };
    const snapshot = snapshotOptionalAddress(wrapper, "address");
    wrapper.value = B;
    expect(snapshot).toEqual({ __option: "Some", value: A });
    expect(() =>
      snapshotOptionalAddress(
        { __option: "Some", value: "not a Solana address" } as never,
        "bad address",
      ),
    ).toThrow();
  });

  it("rejects accessors and malformed discriminators without invoking them", () => {
    let discriminatorReads = 0;
    let valueReads = 0;
    const discriminatorAccessor = Object.defineProperty({}, "__option", {
      enumerable: true,
      get() {
        discriminatorReads += 1;
        return "Some";
      },
    });
    expect(() =>
      snapshotOptionOrNullable(discriminatorAccessor as never, "accessor"),
    ).toThrow(/stable data discriminator/);
    expect(discriminatorReads).toBe(0);

    const valueAccessor = Object.defineProperties(
      {},
      {
        __option: { enumerable: true, value: "Some" },
        value: {
          enumerable: true,
          get() {
            valueReads += 1;
            return A;
          },
        },
      },
    );
    expect(() =>
      snapshotOptionalAddress(valueAccessor as never, "value accessor"),
    ).toThrow(/stable data property/);
    expect(valueReads).toBe(0);

    expect(() =>
      snapshotOptionOrNullable(
        { __option: "Maybe", value: 1 } as never,
        "malformed",
      ),
    ).toThrow(/invalid Option discriminator/);
  });
});
