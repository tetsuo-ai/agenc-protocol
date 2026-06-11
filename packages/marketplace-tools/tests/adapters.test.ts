import { describe, it, expect } from "vitest";
import {
  marketplaceTools,
  toOpenAITools,
  toLangChainTools,
  toCrewAITools,
  type MarketplaceToolContext,
} from "../src/index.js";
import { fakeTransport, encodeListing } from "./fixtures.js";

const ctx: MarketplaceToolContext = {
  read: fakeTransport([encodeListing()]),
};

describe("toOpenAITools", () => {
  it("produces the OpenAI function-calling shape with the SAME schema body", () => {
    const out = toOpenAITools(marketplaceTools);
    expect(out).toHaveLength(marketplaceTools.length);
    for (let i = 0; i < out.length; i++) {
      const o = out[i]!;
      const src = marketplaceTools[i]!;
      expect(o.type).toBe("function");
      expect(o.function.name).toBe(src.name);
      expect(o.function.description).toBe(src.description);
      // Same object reference — the schema is NOT forked.
      expect(o.function.parameters).toBe(src.inputSchema);
    }
  });
});

describe("toLangChainTools", () => {
  it("produces the StructuredTool-compatible shape (name/description/schema/func)", () => {
    const out = toLangChainTools(marketplaceTools, ctx);
    for (let i = 0; i < out.length; i++) {
      const o = out[i]!;
      const src = marketplaceTools[i]!;
      expect(o.name).toBe(src.name);
      expect(o.description).toBe(src.description);
      expect(o.schema).toBe(src.inputSchema);
      expect(typeof o.func).toBe("function");
    }
  });

  it("func is bound to ctx and returns a string", async () => {
    const tools = toLangChainTools(marketplaceTools, ctx);
    const listTool = tools.find((t) => t.name === "list_listings")!;
    const result = await listTool.func({});
    expect(typeof result).toBe("string");
    const parsed = JSON.parse(result);
    expect(Array.isArray(parsed.listings)).toBe(true);
    expect(parsed.listings).toHaveLength(1);
  });
});

describe("toCrewAITools", () => {
  it("produces the CrewAI shape (name/description/args_schema/run)", () => {
    const out = toCrewAITools(marketplaceTools, ctx);
    for (let i = 0; i < out.length; i++) {
      const o = out[i]!;
      const src = marketplaceTools[i]!;
      expect(o.name).toBe(src.name);
      expect(o.description).toBe(src.description);
      expect(o.args_schema).toBe(src.inputSchema);
      expect(typeof o.run).toBe("function");
    }
  });

  it("run is bound to ctx and returns a string", async () => {
    const tools = toCrewAITools(marketplaceTools, ctx);
    const listTool = tools.find((t) => t.name === "list_listings")!;
    const result = await listTool.run({});
    expect(typeof result).toBe("string");
    expect(JSON.parse(result).listings).toHaveLength(1);
  });
});

describe("schema is the single source of truth", () => {
  it("all three adapters carry the IDENTICAL schema object per tool", () => {
    const openai = toOpenAITools(marketplaceTools);
    const langchain = toLangChainTools(marketplaceTools, ctx);
    const crewai = toCrewAITools(marketplaceTools, ctx);
    for (let i = 0; i < marketplaceTools.length; i++) {
      const schema = marketplaceTools[i]!.inputSchema;
      expect(openai[i]!.function.parameters).toBe(schema);
      expect(langchain[i]!.schema).toBe(schema);
      expect(crewai[i]!.args_schema).toBe(schema);
    }
  });
});
