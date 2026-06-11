import { describe, it, expect } from "vitest";
import {
  AGENT_METADATA_VERSION,
  AGENT_METADATA_SCHEMA_ID,
  validateAgentMetadata,
  renderAgentMetadata,
  type AgentMetadata,
} from "../src/values/index.js";

/** A minimal valid v1 document (only the required fields). */
const minimal: AgentMetadata = { version: 1, name: "translation-bot" };

/** A full valid v1 document exercising every optional field. */
const full: AgentMetadata = {
  version: 1,
  name: "Acme Translation Agent",
  description: "Translates English to French and back. Handles docs and chat.",
  operatorDomain: "acme.example",
  contact: {
    email: "ops@acme.example",
    url: "https://acme.example/support",
    x: "acme_agent",
  },
  logo: "https://acme.example/logo.png",
  tosUri: "https://acme.example/tos",
};

describe("agent-metadata constants", () => {
  it("exposes the v1 version and the published schema $id", () => {
    expect(AGENT_METADATA_VERSION).toBe(1);
    expect(AGENT_METADATA_SCHEMA_ID).toBe(
      "https://agenc.tech/schemas/agent-metadata-v1.schema.json",
    );
  });
});

describe("validateAgentMetadata — accepts", () => {
  it("accepts a minimal document (version + name only)", () => {
    const res = validateAgentMetadata(minimal);
    expect(res.valid).toBe(true);
    if (res.valid) {
      expect(res.value.name).toBe("translation-bot");
      expect(res.errors).toEqual([]);
    }
  });

  it("accepts a fully-populated document", () => {
    const res = validateAgentMetadata(full);
    expect(res.valid).toBe(true);
  });

  it("preserves unknown top-level fields (additive evolution)", () => {
    const res = validateAgentMetadata({ ...minimal, futureField: { a: 1 } });
    expect(res.valid).toBe(true);
    if (res.valid) {
      expect((res.value as Record<string, unknown>).futureField).toEqual({ a: 1 });
    }
  });

  it("preserves unknown contact channels", () => {
    const res = validateAgentMetadata({
      ...minimal,
      contact: { email: "ops@acme.example", telegram: "acme" },
    });
    expect(res.valid).toBe(true);
    if (res.valid) {
      expect(res.value.contact?.telegram).toBe("acme");
    }
  });

  it("accepts ipfs/ar/agenc logo URIs", () => {
    for (const logo of ["ipfs://cid", "ar://txid", "agenc://logo/abc"]) {
      expect(validateAgentMetadata({ ...minimal, logo }).valid).toBe(true);
    }
  });
});

describe("validateAgentMetadata — rejects", () => {
  it("rejects a non-object", () => {
    for (const bad of [null, 42, "x", [], true]) {
      const res = validateAgentMetadata(bad);
      expect(res.valid).toBe(false);
      if (!res.valid) expect(res.errors.length).toBeGreaterThan(0);
    }
  });

  it("rejects a missing version", () => {
    const res = validateAgentMetadata({ name: "x" });
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.errors.some((e) => e.path === "version")).toBe(true);
  });

  it("rejects a wrong version (e.g. a future v2 doc against the v1 validator)", () => {
    const res = validateAgentMetadata({ version: 2, name: "x" });
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.errors.some((e) => e.path === "version")).toBe(true);
  });

  it("rejects a missing or empty name", () => {
    expect(validateAgentMetadata({ version: 1 }).valid).toBe(false);
    expect(validateAgentMetadata({ version: 1, name: "" }).valid).toBe(false);
  });

  it("rejects a name over 120 chars", () => {
    const res = validateAgentMetadata({ version: 1, name: "a".repeat(121) });
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.errors.some((e) => e.path === "name")).toBe(true);
  });

  it("rejects a non-bare operatorDomain (scheme/port/path)", () => {
    for (const domain of ["https://acme.example", "acme.example:443", "acme.example/x", "acme"]) {
      const res = validateAgentMetadata({ ...minimal, operatorDomain: domain });
      expect(res.valid, domain).toBe(false);
      if (!res.valid) expect(res.errors.some((e) => e.path === "operatorDomain")).toBe(true);
    }
  });

  it("rejects an http (non-allowlisted scheme) logo and a data: URI", () => {
    for (const logo of ["http://acme.example/logo.png", "data:image/png;base64,AAAA"]) {
      const res = validateAgentMetadata({ ...minimal, logo });
      expect(res.valid, logo).toBe(false);
      if (!res.valid) expect(res.errors.some((e) => e.path === "logo")).toBe(true);
    }
  });

  it("rejects a non-https contact.url", () => {
    const res = validateAgentMetadata({ ...minimal, contact: { url: "http://acme.example" } });
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.errors.some((e) => e.path === "contact.url")).toBe(true);
  });

  it("rejects a malformed contact.email and an over-long X handle", () => {
    expect(
      validateAgentMetadata({ ...minimal, contact: { email: "not-an-email" } }).valid,
    ).toBe(false);
    expect(
      validateAgentMetadata({ ...minimal, contact: { x: "way_too_long_handle_x" } }).valid,
    ).toBe(false);
  });

  it("reports every error, not just the first", () => {
    const res = validateAgentMetadata({ version: 9, name: "", logo: "http://x" });
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe("renderAgentMetadata", () => {
  it("flattens a full document into a provider-card view", () => {
    const view = renderAgentMetadata(full);
    expect(view).toMatchObject({
      name: "Acme Translation Agent",
      operatorDomain: "acme.example",
      contact: "ops@acme.example",
      logo: "https://acme.example/logo.png",
      tosUri: "https://acme.example/tos",
    });
  });

  it("prefers email, then url, then @handle for the contact line", () => {
    expect(renderAgentMetadata({ ...minimal, contact: { url: "https://a.example" } }).contact).toBe(
      "https://a.example",
    );
    expect(renderAgentMetadata({ ...minimal, contact: { x: "acme" } }).contact).toBe("@acme");
  });

  it("leaves optional fields undefined on a minimal document", () => {
    const view = renderAgentMetadata(minimal);
    expect(view.name).toBe("translation-bot");
    expect(view.description).toBeUndefined();
    expect(view.operatorDomain).toBeUndefined();
    expect(view.contact).toBeUndefined();
    expect(view.logo).toBeUndefined();
    expect(view.tosUri).toBeUndefined();
  });
});
