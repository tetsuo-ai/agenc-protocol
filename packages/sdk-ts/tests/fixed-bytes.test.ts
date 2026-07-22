import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  snapshotFixedBytes,
  snapshotOptionalFixedBytes,
} from "../src/values/fixed-bytes.js";

describe("snapshotFixedBytes", () => {
  it("accepts exact ordinary-buffer Uint8Arrays across realms", () => {
    const ForeignUint8Array = runInNewContext(
      "Uint8Array",
    ) as Uint8ArrayConstructor;
    const foreign = new ForeignUint8Array(32).fill(0x71);
    expect(foreign).not.toBeInstanceOf(Uint8Array);

    const snapshot = snapshotFixedBytes(foreign, 32, "foreign hash");

    expect(snapshot).toEqual(new Uint8Array(32).fill(0x71));
    expect(snapshot).toBeInstanceOf(Uint8Array);
    expect(snapshot).not.toBe(foreign);
  });

  it("rejects non-byte views even when their public tag is spoofed", () => {
    const spoof = <T extends object>(value: T): T =>
      Object.defineProperty(value, Symbol.toStringTag, {
        configurable: true,
        value: "Uint8Array",
      });
    for (const impostor of [
      spoof(new DataView(new ArrayBuffer(32))),
      spoof(new Uint8ClampedArray(32)),
      spoof(new Uint16Array(16)),
    ]) {
      expect(() => snapshotFixedBytes(impostor, 32, "impostor")).toThrow(
        /impostor must be exactly 32 bytes/,
      );
    }
  });

  it("uses intrinsic length and rejects SharedArrayBuffer backing", () => {
    const short = new Uint8Array(16);
    Object.defineProperty(short, "byteLength", { value: 32 });
    expect(() => snapshotFixedBytes(short, 32, "short")).toThrow(
      /short must be exactly 32 bytes/,
    );

    const exact = new Uint8Array(32).fill(0x52);
    Object.defineProperty(exact, "byteLength", { value: 16 });
    expect(snapshotFixedBytes(exact, 32, "exact")).toEqual(
      new Uint8Array(32).fill(0x52),
    );

    if (typeof SharedArrayBuffer !== "undefined") {
      const shared = new Uint8Array(new SharedArrayBuffer(32));
      expect(() => snapshotFixedBytes(shared, 32, "shared")).toThrow(
        /shared must be exactly 32 bytes/,
      );
    }
  });
});

describe("snapshotOptionalFixedBytes", () => {
  it("copies raw and Some bytes while preserving None/null semantics", () => {
    const raw = new Uint8Array(32).fill(0x41);
    const someBytes = new Uint8Array(32).fill(0x42);
    const rawSnapshot = snapshotOptionalFixedBytes(raw, 32, "raw");
    const someSnapshot = snapshotOptionalFixedBytes(
      { __option: "Some" as const, value: someBytes },
      32,
      "some",
    );
    raw.fill(0x51);
    someBytes.fill(0x52);

    expect(rawSnapshot).toEqual(new Uint8Array(32).fill(0x41));
    expect(someSnapshot).toEqual({
      __option: "Some",
      value: new Uint8Array(32).fill(0x42),
    });
    expect(Object.isFrozen(someSnapshot)).toBe(true);
    expect(snapshotOptionalFixedBytes(null, 32, "null")).toBeNull();
    expect(
      snapshotOptionalFixedBytes({ __option: "None" as const }, 32, "none"),
    ).toEqual({ __option: "None" });
  });

  it("accepts cross-realm Some bytes and rejects unstable or unsafe forms", () => {
    const ForeignUint8Array = runInNewContext(
      "Uint8Array",
    ) as Uint8ArrayConstructor;
    const foreign = new ForeignUint8Array(32).fill(0x61);
    expect(
      snapshotOptionalFixedBytes(
        { __option: "Some" as const, value: foreign },
        32,
        "foreign",
      ),
    ).toEqual({
      __option: "Some",
      value: new Uint8Array(32).fill(0x61),
    });

    const detached = new Uint8Array(32);
    structuredClone(detached, { transfer: [detached.buffer] });
    for (const bad of [
      new Proxy(new Uint8Array(32), {}),
      new Uint8Array(new SharedArrayBuffer(32)),
      detached,
    ]) {
      expect(() =>
        snapshotOptionalFixedBytes(
          { __option: "Some" as const, value: bad },
          32,
          "unsafe",
        ),
      ).toThrow(/exactly 32 bytes/);
    }

    const accessor = Object.defineProperty({}, "__option", {
      enumerable: true,
      get: () => "None",
    });
    expect(() => snapshotOptionalFixedBytes(accessor, 32, "accessor")).toThrow(
      /stable data discriminator/,
    );
  });
});
