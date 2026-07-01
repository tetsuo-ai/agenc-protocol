// Unit tests for the environment seam: the resolveMcpConfig posture that
// decides the read transport and the mutation opt-in. No network, no litesvm.
import { describe, it, expect } from "vitest";
import {
  resolveMcpConfig,
  envFlag,
  DEFAULT_RPC_URL,
  selectTools,
  readonlyTools,
  marketplaceTools,
  prepareTools,
} from "../src/index.js";

describe("envFlag", () => {
  it("treats 1/true/yes/on (any case) as truthy and everything else as false", () => {
    for (const v of ["1", "true", "TRUE", "Yes", "on"]) {
      expect(envFlag(v)).toBe(true);
    }
    for (const v of ["0", "false", "no", "off", "", undefined]) {
      expect(envFlag(v)).toBe(false);
    }
  });
});

describe("resolveMcpConfig: read transport", () => {
  it("defaults to mainnet cluster + the mainnet default RPC when nothing is set", () => {
    const config = resolveMcpConfig({});
    expect(config.cluster).toBe("mainnet");
    expect(config.rpcUrl).toBe(DEFAULT_RPC_URL.mainnet);
    expect(config.rpcUrlExplicit).toBe(false);
    expect(config.indexerUrl).toBeUndefined();
  });

  it("uses the cluster default RPC for devnet / localnet", () => {
    expect(resolveMcpConfig({ AGENC_MARKETPLACE_CLUSTER: "devnet" }).rpcUrl).toBe(
      DEFAULT_RPC_URL.devnet,
    );
    expect(
      resolveMcpConfig({ AGENC_MARKETPLACE_CLUSTER: "localnet" }).rpcUrl,
    ).toBe(DEFAULT_RPC_URL.localnet);
  });

  it("an explicit AGENC_RPC_URL overrides the cluster default and is flagged explicit", () => {
    const config = resolveMcpConfig({
      AGENC_MARKETPLACE_CLUSTER: "localnet",
      AGENC_RPC_URL: "http://127.0.0.1:9000",
    });
    expect(config.rpcUrl).toBe("http://127.0.0.1:9000");
    expect(config.rpcUrlExplicit).toBe(true);
  });

  it("carries the indexer URL/key and program override when set", () => {
    const config = resolveMcpConfig({
      AGENC_INDEXER_URL: "https://marketplace.agenc.tech",
      AGENC_INDEXER_API_KEY: "sk-test",
      AGENC_PROGRAM_ADDRESS: "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK",
    });
    expect(config.indexerUrl).toBe("https://marketplace.agenc.tech");
    expect(config.indexerApiKey).toBe("sk-test");
    expect(config.programAddress).toBe(
      "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK",
    );
  });

  it("rejects an unknown cluster loudly", () => {
    expect(() =>
      resolveMcpConfig({ AGENC_MARKETPLACE_CLUSTER: "testnet" }),
    ).toThrow(/mainnet \| devnet \| localnet/);
  });
});

describe("resolveMcpConfig: mutation opt-in", () => {
  it("mutations are OFF by default", () => {
    expect(resolveMcpConfig({}).enableMutations).toBe(false);
  });

  it("AGENC_MCP_ENABLE_MUTATIONS=1 turns mutations on", () => {
    expect(
      resolveMcpConfig({ AGENC_MCP_ENABLE_MUTATIONS: "1" }).enableMutations,
    ).toBe(true);
  });

  it("a non-truthy value keeps mutations off", () => {
    expect(
      resolveMcpConfig({ AGENC_MCP_ENABLE_MUTATIONS: "0" }).enableMutations,
    ).toBe(false);
    expect(
      resolveMcpConfig({ AGENC_MCP_ENABLE_MUTATIONS: "please" }).enableMutations,
    ).toBe(false);
  });
});

describe("selectTools", () => {
  it("readonly selection excludes prepare tools", () => {
    const tools = selectTools(false);
    expect(tools).toBe(readonlyTools);
    expect(tools.every((t) => t.kind === "readonly")).toBe(true);
    expect(tools.map((t) => t.name)).not.toContain("prepare_hire");
  });

  it("mutation selection is the full set (readonly + prepare)", () => {
    const tools = selectTools(true);
    expect(tools).toBe(marketplaceTools);
    expect(tools.filter((t) => t.kind === "prepare")).toHaveLength(
      prepareTools.length,
    );
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(prepareTools.map((t) => t.name)),
    );
  });
});
