import { describe, expect, it } from "vitest";
import { defaultConfig, parseConfig, serializeConfig } from "../src/config.js";

describe("parseConfig exact schema", () => {
  it("round-trips the complete generated config", () => {
    const config = defaultConfig("service", "worker");
    expect(parseConfig(serializeConfig(config), "/project/agenc.config.json")).toEqual(config);
  });

  it("bounds generated listing names by UTF-8 bytes without splitting characters", () => {
    const config = defaultConfig(`${"é".repeat(20)}tail`, "worker");
    expect(new TextEncoder().encode(config.name).byteLength).toBeLessThanOrEqual(32);
    expect(config.name).toBe("é".repeat(16));
    expect(() => parseConfig(serializeConfig(config), "/project/agenc.config.json")).not.toThrow();
  });

  it.each([
    { listing: { category: "Not-Kebab" } },
    { listing: { category: "unknown-category" } },
    { listing: { tags: ["UPPER"] } },
    { listing: { tags: ["duplicate", "duplicate"] } },
    { listing: { tags: ["a".repeat(65)] } },
  ])("rejects non-canonical listing metadata %#", (override) => {
    const value = {
      ...defaultConfig("service", "worker"),
      ...override,
      listing: {
        ...defaultConfig("service", "worker").listing,
        ...override.listing,
      },
    };
    expect(() => parseConfig(JSON.stringify(value), "/project/agenc.config.json")).toThrow(
      /listing\.(category|tags)/,
    );
  });

  it.each([
    { name: "x", kind: "worker", network: 1 },
    { name: "x", kind: "worker", network: "testnet" },
    { name: "x", kind: "worker", rpcUrl: 7 },
    { name: "x", kind: "worker", walletPath: false },
    { name: "x", kind: "worker", listing: null },
    { name: "x", kind: "worker", listing: { category: 1 } },
    { name: "x", kind: "worker", listing: { tags: ["ok", 1] } },
    { name: "x", kind: "worker", listing: { priceLamports: 1_000 } },
  ])("rejects a present but invalid optional value %#", (value) => {
    expect(() => parseConfig(JSON.stringify(value), "/project/agenc.config.json")).toThrow(
      /agenc\.config\.json/,
    );
  });

  it.each([
    { name: "x", kind: "worker", typo: true },
    { name: "x", kind: "worker", listing: { typo: true } },
  ])("rejects unknown keys with a property path %#", (value) => {
    expect(() => parseConfig(JSON.stringify(value), "/project/agenc.config.json")).toThrow(
      /unknown property.*typo/,
    );
  });

  it.each([
    "http://rpc.example",
    "https://user:secret@rpc.example",
    "https://rpc.example/?api-key=committed-secret",
    "https://rpc.example/#secret",
  ])("rejects secret-bearing or non-HTTPS committed RPC URL %s", (rpcUrl) => {
    const config = { ...defaultConfig("service", "checkout"), rpcUrl };
    expect(() => parseConfig(JSON.stringify(config), "/project/agenc.config.json")).toThrow(
      /AGENC_RPC_URL|credential-free HTTPS/u,
    );
  });
});
