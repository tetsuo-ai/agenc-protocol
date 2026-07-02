import { describe, it, expect } from "vitest";
import {
  marketplaceTools,
  readonlyTools,
  prepareTools,
  marketplaceToolRegistry,
  createToolRegistry,
  getTool,
  type JsonSchema,
} from "../src/index.js";

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
      expect(Array.isArray(def.enum), `${toolName}.${prop}: enum is array`).toBe(
        true,
      );
      expect(def.enum.length, `${toolName}.${prop}: enum non-empty`).toBeGreaterThan(
        0,
      );
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

  it("registry resolves tools by name and rejects duplicates", () => {
    for (const name of EXPECTED_NAMES) {
      expect(getTool(name)?.name).toBe(name);
    }
    expect(getTool("does_not_exist")).toBeUndefined();
    expect(marketplaceToolRegistry.size).toBe(EXPECTED_NAMES.length);
    const dup = [marketplaceTools[0]!, marketplaceTools[0]!];
    expect(() => createToolRegistry(dup)).toThrow(/Duplicate/);
  });
});
