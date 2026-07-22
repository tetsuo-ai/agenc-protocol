import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  snapshotDenseStructuredArray,
  snapshotStructuredClone,
} from "../src/values/structured-clone.js";

describe("snapshotStructuredClone", () => {
  it("detaches ordinary cyclic Map/Set graphs and preserves their topology", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const root: Record<string, unknown> = { bytes };
    const set = new Set<unknown>([root]);
    const map = new Map<unknown, unknown>([["set", set]]);
    root.self = root;
    root.map = map;
    let cursor = root;
    for (let index = 0; index < 128; index += 1) {
      const next: Record<string, unknown> = { index };
      cursor.next = next;
      cursor = next;
    }

    const snapshot = snapshotStructuredClone(root, "jobSpec") as typeof root;
    bytes.fill(9);

    expect(snapshot).not.toBe(root);
    expect(snapshot.self).toBe(snapshot);
    expect(snapshot.bytes).toEqual(new Uint8Array([1, 2, 3]));
    const snapshotMap = snapshot.map as Map<unknown, unknown>;
    const snapshotSet = snapshotMap.get("set") as Set<unknown>;
    expect(snapshotSet.has(snapshot)).toBe(true);
    expect(snapshotMap).not.toBe(map);
    expect(snapshotSet).not.toBe(set);
  });

  it("rejects SAB-backed views anywhere in a cross-realm cyclic Map/Set graph", () => {
    if (typeof SharedArrayBuffer === "undefined") return;
    const foreign = runInNewContext(`(() => {
      const root = {};
      const view = new Uint8Array(new SharedArrayBuffer(32));
      root.self = root;
      root.map = new Map([["nested", new Set([{ view }])]]);
      return root;
    })()`);

    expect(() => snapshotStructuredClone(foreign, "jobSpec")).toThrow(
      /SharedArrayBuffer/,
    );
  });

  it("rejects shared WebAssembly.Memory hidden behind Map/cycle internals", () => {
    if (
      typeof WebAssembly === "undefined" ||
      WebAssembly.Memory === undefined ||
      typeof SharedArrayBuffer === "undefined"
    ) {
      return;
    }
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    const root: Record<string, unknown> = {};
    root.self = root;
    root.map = new Map([["memory", memory]]);

    expect(() => snapshotStructuredClone(root, "jobSpec")).toThrow(
      /shared WebAssembly\.Memory/,
    );
  });

  it("does not invoke accessor getters while rejecting an unsafe graph", () => {
    let getterCalls = 0;
    const root = Object.defineProperty({}, "bytes", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return new Uint8Array(new SharedArrayBuffer(32));
      },
    });

    expect(() => snapshotStructuredClone(root, "jobSpec")).toThrow(
      /accessor properties/,
    );
    expect(getterCalls).toBe(0);
  });

  it("rejects proxies before returning a snapshot without invoking get traps", () => {
    let getCalls = 0;
    const proxy = new Proxy(new Uint8Array(32), {
      get(target, key, receiver) {
        getCalls += 1;
        return Reflect.get(target, key, receiver);
      },
    });

    expect(() => snapshotStructuredClone({ proxy }, "jobSpec")).toThrow(
      /structured-cloneable/,
    );
    expect(getCalls).toBe(0);
  });

  it("uses captured view-brand and clone intrinsics after global monkeypatches", () => {
    if (typeof SharedArrayBuffer === "undefined") return;
    const originalIsView = ArrayBuffer.isView;
    const originalStructuredClone = globalThis.structuredClone;
    try {
      ArrayBuffer.isView = (_value: unknown): _value is ArrayBufferView =>
        false;
      globalThis.structuredClone = ((value: unknown) =>
        value) as typeof structuredClone;
      const shared = new Uint8Array(new SharedArrayBuffer(32));
      expect(() => snapshotStructuredClone({ shared }, "jobSpec")).toThrow(
        /SharedArrayBuffer/,
      );
    } finally {
      ArrayBuffer.isView = originalIsView;
      globalThis.structuredClone = originalStructuredClone;
    }
  });
});

describe("snapshotDenseStructuredArray", () => {
  it("detaches dense records without invoking caller-owned iteration methods", () => {
    let flatMapCalls = 0;
    const records = [{ value: 1 }];
    Object.defineProperty(records, "flatMap", {
      value() {
        flatMapCalls += 1;
        return [];
      },
    });

    const poisonedSnapshot = snapshotDenseStructuredArray(records, "records");
    expect(flatMapCalls).toBe(0);
    expect(poisonedSnapshot).toEqual([{ value: 1 }]);
    expect(Object.hasOwn(poisonedSnapshot, "flatMap")).toBe(false);

    const ordinary = [{ value: 1 }];
    const snapshot = snapshotDenseStructuredArray(ordinary, "ordinary");
    ordinary[0]!.value = 2;
    expect(snapshot).toEqual([{ value: 1 }]);
  });

  it("rejects sparse, accessor-backed, and over-limit arrays", () => {
    expect(() => snapshotDenseStructuredArray(new Array(1), "sparse")).toThrow(
      /dense/,
    );

    let getterCalls = 0;
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { value: 1 };
      },
    });
    expect(() => snapshotDenseStructuredArray(accessor, "accessor")).toThrow(
      /own data entries/,
    );
    expect(getterCalls).toBe(0);

    expect(() => snapshotDenseStructuredArray([1, 2], "bounded", 1)).toThrow(
      /at most 1/,
    );
  });
});
