import { describe, it, expect } from "vitest";
import {
  MarketplaceToolError,
  marketplaceTools,
  readonlyTools,
  prepareTools,
  marketplaceToolRegistry,
  createToolRegistry,
  getTool,
  type JsonSchema,
  type MarketplaceTool,
} from "../src/index.js";
import { fakeTransport } from "./fixtures.js";
import {
  A_AUTHORITY,
  A_CREATOR,
  A_LISTING_PDA,
  A_MODERATOR,
  A_PROVIDER,
  A_TASK_PDA,
} from "./fixtures.js";

const EXPECTED_NAMES = [
  "list_listings",
  "get_listing",
  "list_open_tasks",
  "get_task",
  "get_agent_track_record",
  "search",
  "prepare_hire",
  "prepare_hire_humanless",
  "prepare_set_task_job_spec",
  "prepare_claim",
  "prepare_submit",
  "prepare_accept_task_result",
  "prepare_reject_task_result",
  "prepare_auto_accept_task_result",
  "prepare_cancel_task",
  "prepare_close_task",
  "prepare_rate_hire",
  "prepare_create_service_listing",
  "prepare_register_agent",
];

const HEX32 = "07".repeat(32);
const HEX64 = "ab".repeat(64);

/** Every property is populated so optional fields are exercised too. */
const VALID_ARGS: Readonly<Record<string, Record<string, unknown>>> = {
  list_listings: {
    category: "research",
    provider: A_PROVIDER,
    state: "Active",
    limit: 1,
  },
  get_listing: { pda: A_LISTING_PDA },
  list_open_tasks: {
    capabilities: "1",
    minReward: "0",
    creator: A_CREATOR,
    limit: 1,
  },
  get_task: { pda: A_TASK_PDA },
  get_agent_track_record: { agent: A_PROVIDER },
  search: { query: "code", kind: "both", limit: 1 },
  prepare_hire: {
    listing: A_LISTING_PDA,
    providerAgent: A_PROVIDER,
    buyer: A_AUTHORITY,
    creatorAgent: A_PROVIDER,
    taskId: HEX32,
    expectedPrice: "1000",
    expectedVersion: "1",
    moderator: A_MODERATOR,
    listingSpecHash: HEX32,
    taskJobSpecHash: HEX32,
    moderatorIsAttestor: false,
    listingModeration: A_LISTING_PDA,
    referrer: A_CREATOR,
    referrerFeeBps: 0,
  },
  prepare_hire_humanless: {
    listing: A_LISTING_PDA,
    providerAgent: A_PROVIDER,
    buyer: A_AUTHORITY,
    taskId: HEX32,
    expectedPrice: "1000",
    expectedVersion: "1",
    moderator: A_MODERATOR,
    listingSpecHash: HEX32,
    taskJobSpecHash: HEX32,
    moderatorIsAttestor: false,
    listingModeration: A_LISTING_PDA,
    reviewWindowSecs: "86400",
    referrer: A_CREATOR,
    referrerFeeBps: 0,
  },
  prepare_set_task_job_spec: {
    task: A_TASK_PDA,
    creator: A_CREATOR,
    jobSpecHash: HEX32,
    jobSpecUri: `agenc://job-spec/${HEX32}`,
    moderator: A_MODERATOR,
    moderatorIsAttestor: false,
    taskModeration: A_LISTING_PDA,
  },
  prepare_claim: {
    task: A_TASK_PDA,
    worker: A_PROVIDER,
    workerAuthority: A_AUTHORITY,
    jobSpecHash: HEX32,
    legacyListing: A_LISTING_PDA,
    parentTask: A_LISTING_PDA,
  },
  prepare_submit: {
    task: A_TASK_PDA,
    worker: A_PROVIDER,
    workerAuthority: A_AUTHORITY,
    proofHash: HEX32,
    resultData: HEX64,
  },
  prepare_accept_task_result: {
    task: A_TASK_PDA,
    worker: A_PROVIDER,
    workerAuthority: A_AUTHORITY,
    treasury: A_CREATOR,
    creator: A_CREATOR,
    operator: A_AUTHORITY,
    referrer: A_MODERATOR,
  },
  prepare_reject_task_result: {
    task: A_TASK_PDA,
    claim: A_LISTING_PDA,
    worker: A_PROVIDER,
    workerAuthority: A_AUTHORITY,
    creator: A_CREATOR,
    rejectionHash: HEX32,
  },
  prepare_auto_accept_task_result: {
    task: A_TASK_PDA,
    worker: A_PROVIDER,
    workerAuthority: A_AUTHORITY,
    treasury: A_CREATOR,
    creator: A_CREATOR,
    authority: A_AUTHORITY,
    operator: A_LISTING_PDA,
    referrer: A_MODERATOR,
  },
  prepare_cancel_task: {
    task: A_TASK_PDA,
    authority: A_AUTHORITY,
    workerBondAuthority: A_CREATOR,
  },
  prepare_close_task: {
    task: A_TASK_PDA,
    authority: A_AUTHORITY,
    hireRecord: A_LISTING_PDA,
    listing: A_PROVIDER,
  },
  prepare_rate_hire: {
    task: A_TASK_PDA,
    listing: A_LISTING_PDA,
    buyer: A_AUTHORITY,
    score: 5,
    reviewHash: HEX32,
    reviewUri: "agenc://review/example",
  },
  prepare_create_service_listing: {
    providerAgent: A_PROVIDER,
    authority: A_AUTHORITY,
    listingId: HEX32,
    name: "Research Summary",
    category: "research",
    tags: ["solana", "analysis"],
    specHash: HEX32,
    specUri: `agenc://listing-spec/${HEX32}`,
    price: "1000",
    requiredCapabilities: "1",
    defaultDeadlineSecs: "3600",
    maxOpenJobs: 1,
    operator: A_CREATOR,
    operatorFeeBps: 0,
  },
  prepare_register_agent: {
    authority: A_AUTHORITY,
    agentId: HEX32,
    capabilities: "1",
    endpoint: "https://agent.example/card",
    metadataUri: "ipfs://metadata-cid",
    stakeAmount: "0",
  },
};

function wrongType(type: string): unknown {
  switch (type) {
    case "string":
      return 1;
    case "number":
    case "integer":
      return "1";
    case "boolean":
      return "false";
    case "array":
      return "not-an-array";
    case "object":
      return "not-an-object";
    default:
      throw new Error(`unsupported test type ${type}`);
  }
}

function invalidFormat(format: string): string {
  switch (format) {
    case "solana-address":
      return "not-a-solana-address";
    case "hex-32":
      return "00";
    case "nonzero-hex-32":
      return "00".repeat(32);
    case "hex-64":
      return "ab";
    case "uint64":
      return "18446744073709551616";
    case "nonzero-uint64":
      return "0";
    case "int64":
      return "9223372036854775808";
    case "uri":
      return "javascript:alert(1)";
    case "http-url":
      return "ipfs://not-http";
    case "kebab-token":
      return "Not Kebab";
    case "listing-name":
      return "   ";
    default:
      throw new Error(`unsupported test format ${format}`);
  }
}

/** A minimal structural validator for the JSON-Schema subset the tools emit. */
function assertValidSchema(schema: JsonSchema, toolName: string) {
  expect(schema.type, `${toolName}: top-level type`).toBe("object");
  expect(typeof schema.properties, `${toolName}: properties is an object`).toBe(
    "object",
  );
  // additionalProperties should be explicit-false for a strict tool envelope.
  expect(schema.additionalProperties, `${toolName}: additionalProperties`).toBe(
    false,
  );
  for (const [prop, def] of Object.entries(schema.properties)) {
    expect(
      ["string", "number", "integer", "boolean", "array", "object"],
      `${toolName}.${prop}: valid type`,
    ).toContain(def.type);
    expect(
      typeof def.description,
      `${toolName}.${prop}: has a description`,
    ).toBe("string");
    if (def.enum) {
      expect(
        Array.isArray(def.enum),
        `${toolName}.${prop}: enum is array`,
      ).toBe(true);
      expect(
        def.enum.length,
        `${toolName}.${prop}: enum non-empty`,
      ).toBeGreaterThan(0);
    }
  }
  // Every name in `required` must be a declared property.
  for (const req of schema.required ?? []) {
    expect(
      Object.keys(schema.properties),
      `${toolName}: required "${req}" is a declared property`,
    ).toContain(req);
  }
}

describe("tool registry", () => {
  it("exposes exactly the expected tools in stable order", () => {
    expect(marketplaceTools.map((t) => t.name)).toEqual(EXPECTED_NAMES);
  });

  it("partitions readonly vs prepare correctly", () => {
    expect(readonlyTools.map((t) => t.name)).toEqual([
      "list_listings",
      "get_listing",
      "list_open_tasks",
      "get_task",
      "get_agent_track_record",
      "search",
    ]);
    expect(prepareTools.map((t) => t.name)).toEqual([
      "prepare_hire",
      "prepare_hire_humanless",
      "prepare_set_task_job_spec",
      "prepare_claim",
      "prepare_submit",
      "prepare_accept_task_result",
      "prepare_reject_task_result",
      "prepare_auto_accept_task_result",
      "prepare_cancel_task",
      "prepare_close_task",
      "prepare_rate_hire",
      "prepare_create_service_listing",
      "prepare_register_agent",
    ]);
    for (const t of readonlyTools) expect(t.kind).toBe("readonly");
    for (const t of prepareTools) expect(t.kind).toBe("prepare");
  });

  it("has no tool whose kind permits signing/sending (no 'mutate' kind)", () => {
    for (const t of marketplaceTools) {
      expect(["readonly", "prepare"]).toContain(t.kind);
    }
  });

  it("every tool has a name, description, schema, and handler", () => {
    for (const t of marketplaceTools) {
      expect(typeof t.name).toBe("string");
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(10);
      expect(typeof t.handler).toBe("function");
      assertValidSchema(t.inputSchema, t.name);
    }
  });

  it("rejects missing, extra, wrong-type, and malformed formatted values on every shipped tool", async () => {
    const context = { read: fakeTransport([]) };
    for (const tool of marketplaceTools) {
      const valid = VALID_ARGS[tool.name];
      expect(valid, `${tool.name}: canonical test input`).toBeDefined();

      await expect(
        tool.handler(null as never, context),
        `${tool.name}: missing input envelope`,
      ).rejects.toMatchObject({
        code: "INVALID_TOOL_INPUT",
        tool: tool.name,
      });
      await expect(
        tool.handler({ ...valid, __unexpected: true }, context),
        `${tool.name}: additional property`,
      ).rejects.toMatchObject({
        code: "INVALID_TOOL_INPUT",
        tool: tool.name,
      });

      for (const required of tool.inputSchema.required ?? []) {
        const missing = { ...valid };
        delete missing[required];
        await expect(
          tool.handler(missing, context),
          `${tool.name}.${required}: required`,
        ).rejects.toMatchObject({
          code: "INVALID_TOOL_INPUT",
          tool: tool.name,
        });
      }

      for (const [property, schema] of Object.entries(
        tool.inputSchema.properties,
      )) {
        await expect(
          tool.handler(
            { ...valid, [property]: wrongType(schema.type) },
            context,
          ),
          `${tool.name}.${property}: wrong type`,
        ).rejects.toMatchObject({
          code: "INVALID_TOOL_INPUT",
          tool: tool.name,
        });

        if (schema.format !== undefined) {
          await expect(
            tool.handler(
              { ...valid, [property]: invalidFormat(schema.format) },
              context,
            ),
            `${tool.name}.${property}: ${schema.format}`,
          ).rejects.toMatchObject({
            code: "INVALID_TOOL_INPUT",
            tool: tool.name,
          });
        }
      }
    }
  });

  it("leaves no unbounded free-form string or array in a shipped schema", () => {
    for (const tool of marketplaceTools) {
      for (const [property, schema] of Object.entries(
        tool.inputSchema.properties,
      )) {
        if (schema.type === "string") {
          const isBoundedEnum = schema.enum !== undefined;
          const isBoundedText =
            schema.minLength !== undefined && schema.maxLength !== undefined;
          expect(
            schema.format !== undefined || isBoundedEnum || isBoundedText,
            `${tool.name}.${property}: string constraint`,
          ).toBe(true);
        }
        if (schema.type === "array") {
          expect(
            schema.minItems,
            `${tool.name}.${property}: minItems`,
          ).toBeDefined();
          expect(
            schema.maxItems,
            `${tool.name}.${property}: maxItems`,
          ).toBeDefined();
          expect(
            schema.items?.format,
            `${tool.name}.${property}: item format`,
          ).toBeDefined();
        }
      }
    }
  });

  it.each([
    ["prepare_create_service_listing", { price: "999" }],
    ["prepare_create_service_listing", { defaultDeadlineSecs: "-1" }],
    ["prepare_create_service_listing", { defaultDeadlineSecs: "31536001" }],
    ["prepare_create_service_listing", { tags: ["a".repeat(64), "b"] }],
    ["prepare_create_service_listing", { name: "é".repeat(17) }],
    ["prepare_hire", { expectedPrice: "999" }],
    ["prepare_hire_humanless", { reviewWindowSecs: "0" }],
    ["prepare_hire_humanless", { reviewWindowSecs: "604801" }],
    [
      "prepare_set_task_job_spec",
      { jobSpecUri: `https://example.com/${"é".repeat(120)}` },
    ],
    [
      "prepare_set_task_job_spec",
      { jobSpecUri: "https://example.com/unescaped space" },
    ],
    [
      "prepare_register_agent",
      { endpoint: `https://example.com/${"é".repeat(60)}` },
    ],
    [
      "prepare_register_agent",
      { metadataUri: `ipfs://metadata/${"é".repeat(60)}` },
    ],
  ])("enforces protocol bound: %s %o", async (toolName, override) => {
    const tool = getTool(toolName)!;
    await expect(
      tool.handler(
        { ...VALID_ARGS[toolName], ...override },
        { read: fakeTransport([]) },
      ),
    ).rejects.toBeInstanceOf(MarketplaceToolError);
  });

  it("requires immutable provider and job-spec bindings on money/assignment tools", () => {
    expect(getTool("prepare_hire")!.inputSchema.required).toContain(
      "providerAgent",
    );
    expect(getTool("prepare_hire_humanless")!.inputSchema.required).toContain(
      "providerAgent",
    );
    expect(getTool("prepare_claim")!.inputSchema.required).toContain(
      "jobSpecHash",
    );
    expect(getTool("prepare_claim")!.inputSchema.properties).toHaveProperty(
      "legacyListing",
    );
    expect(getTool("prepare_claim")!.inputSchema.required).not.toContain(
      "legacyListing",
    );
    expect(getTool("prepare_claim")!.inputSchema.properties).toHaveProperty(
      "parentTask",
    );
    expect(getTool("prepare_claim")!.inputSchema.required).not.toContain(
      "parentTask",
    );
  });

  it("registry resolves tools by name and rejects duplicates", () => {
    for (const name of EXPECTED_NAMES) {
      expect(getTool(name)?.name).toBe(name);
    }
    expect(getTool("does_not_exist")).toBeUndefined();
    expect(marketplaceToolRegistry.size).toBe(EXPECTED_NAMES.length);
    const dup = [marketplaceTools[0]!, marketplaceTools[0]!];
    expect(() => createToolRegistry(dup)).toThrow(/Duplicate/);
  });

  it("registry rejects unsupported or internally inconsistent schemas", () => {
    const makeTool = (inputSchema: unknown): MarketplaceTool => ({
      name: "schema_probe",
      description: "Schema registration validation probe.",
      kind: "readonly",
      inputSchema: inputSchema as JsonSchema,
      async handler() {
        return { ok: true };
      },
    });

    expect(() =>
      createToolRegistry([
        makeTool({
          type: "object",
          properties: {},
          additionalProperties: false,
          oneOf: [{ type: "object" }],
        }),
      ]),
    ).toThrowError(
      expect.objectContaining({
        name: "MarketplaceToolError",
        code: "INVALID_TOOL_SCHEMA",
        tool: "schema_probe",
      }),
    );

    expect(() =>
      createToolRegistry([
        makeTool({
          type: "object",
          properties: {},
          additionalProperties: false,
          required: ["missing"],
        }),
      ]),
    ).toThrow(/required.*missing/i);
  });

  it("registry handlers enforce nested values, enums, and supported formats", async () => {
    const calls: unknown[] = [];
    const tool: MarketplaceTool = {
      name: "runtime_probe",
      description: "Runtime schema validation probe.",
      kind: "readonly",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["owner", "mode", "values"],
        properties: {
          owner: {
            type: "string",
            format: "solana-address",
            description: "Owner address.",
          },
          mode: {
            type: "string",
            enum: ["safe", "strict"],
            description: "Execution mode.",
          },
          values: {
            type: "array",
            items: { type: "integer", minimum: 0, maximum: 2 },
            description: "Small integer values.",
          },
        },
      },
      async handler(input) {
        calls.push(input);
        return { ok: true };
      },
    };
    const registered = createToolRegistry([tool]).get("runtime_probe")!;
    const context = { read: fakeTransport([]) };

    await expect(
      registered.handler(
        { owner: "not-an-address", mode: "unsafe", values: [0, 3] },
        context,
      ),
    ).rejects.toBeInstanceOf(MarketplaceToolError);
    expect(calls).toEqual([]);

    const valid = {
      owner: "11111111111111111111111111111111",
      mode: "safe",
      values: [0, 2],
    };
    await expect(registered.handler(valid, context)).resolves.toEqual({
      ok: true,
    });
    expect(calls).toEqual([valid]);
  });

  it("default getTool handlers reject extra model-controlled properties", async () => {
    const list = getTool("list_listings")!;
    await expect(
      list.handler(
        { unexpected: "model supplied" },
        { read: fakeTransport([]) },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_TOOL_INPUT",
      tool: "list_listings",
    });
  });

  it("accepts the inclusive u64 ceiling and rejects negative/non-canonical decimal inputs", async () => {
    const tool = getTool("list_open_tasks")!;
    const context = { read: fakeTransport([]) };
    await expect(
      tool.handler(
        {
          capabilities: "18446744073709551615",
          minReward: "18446744073709551615",
        },
        context,
      ),
    ).resolves.toEqual({ tasks: [] });
    for (const capabilities of ["-1", "01", "18446744073709551616"]) {
      await expect(
        tool.handler({ capabilities }, context),
      ).rejects.toMatchObject({
        code: "INVALID_TOOL_INPUT",
        tool: "list_open_tasks",
      });
    }
  });

  it("snapshots schemas so post-registration mutation cannot desynchronize validation", async () => {
    const schema: JsonSchema = {
      type: "object",
      required: ["count"],
      properties: {
        count: { type: "integer", description: "A count." },
      },
    };
    const registered = createToolRegistry([
      {
        name: "immutable_schema_probe",
        description: "Immutable schema registration probe.",
        kind: "readonly",
        inputSchema: schema,
        async handler(input) {
          return input;
        },
      },
    ]).get("immutable_schema_probe")!;

    schema.properties.count = {
      type: "string",
      description: "A mutated definition.",
    };
    expect(registered.inputSchema.properties.count?.type).toBe("integer");
    expect(registered.inputSchema.additionalProperties).toBe(false);
    expect(Object.isFrozen(registered.inputSchema)).toBe(true);
    await expect(
      registered.handler({ count: "1" }, { read: fakeTransport([]) }),
    ).rejects.toMatchObject({ code: "INVALID_TOOL_INPUT" });
    await expect(
      registered.handler({ count: 1 }, { read: fakeTransport([]) }),
    ).resolves.toEqual({ count: 1 });
  });
});
