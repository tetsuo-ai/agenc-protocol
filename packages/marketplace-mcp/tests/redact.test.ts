// Unit tests for the credential-redaction seam (audit F-8): every diagnostic
// surface — boot logs, the fatal handler, MCP tool-error results, and process
// crash handlers — shares the same sanitizer, so a provider URL carrying
// userinfo or a query-string API key can never reach stderr or the MCP client.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { redactUrl, sanitizeDiagnostic } from "../src/redact.js";
import { toErrorResult } from "../src/server.js";

const CRED_URL = "https://user:pass@mainnet.helius-rpc.com/?api-key=SECRETKEY123";
const CRED_INDEXER = "https://idx.example.com/v2/INDEXERKEY456/path";

const ENV_BACKUP: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ["AGENC_RPC_URL", "AGENC_INDEXER_URL", "AGENC_INDEXER_API_KEY"]) {
    ENV_BACKUP[key] = process.env[key];
  }
});

afterEach(() => {
  for (const key of ["AGENC_RPC_URL", "AGENC_INDEXER_URL", "AGENC_INDEXER_API_KEY"]) {
    if (ENV_BACKUP[key] === undefined) delete process.env[key];
    else process.env[key] = ENV_BACKUP[key];
  }
});

describe("redactUrl", () => {
  it("reduces credential-bearing URLs to their origin", () => {
    expect(redactUrl(CRED_URL)).toBe("https://mainnet.helius-rpc.com");
    expect(redactUrl("wss://user:pass@host:8900/ws?token=x")).toBe("wss://host:8900");
  });

  it("never echoes unparseable input", () => {
    expect(redactUrl("not a url")).toBe("<unparseable-url-redacted>");
    expect(redactUrl(undefined)).toBe("none");
    expect(redactUrl("")).toBe("none");
  });
});

describe("sanitizeDiagnostic", () => {
  it("strips the configured RPC/indexer URL (and its trimmed form) from error text", () => {
    process.env.AGENC_RPC_URL = `  ${CRED_URL} `; // config.ts trims — cover both forms
    process.env.AGENC_INDEXER_URL = CRED_INDEXER;

    const undiciStyle = `TypeError: Request cannot be constructed from a URL that includes credentials: ${CRED_URL}`;
    const out1 = sanitizeDiagnostic(undiciStyle);
    expect(out1).not.toContain("SECRETKEY123");
    expect(out1).not.toContain("user:pass");
    expect(out1).toContain("https://mainnet.helius-rpc.com");

    const sdkStyle = `indexer at ${CRED_INDEXER} responded 502 for GET /agents`;
    const out2 = sanitizeDiagnostic(sdkStyle);
    expect(out2).not.toContain("INDEXERKEY456");
    expect(out2).toContain("https://idx.example.com");
  });

  it("redacts the indexer API key wherever it appears", () => {
    process.env.AGENC_INDEXER_API_KEY = "rawkey789";
    const out = sanitizeDiagnostic("request failed with key rawkey789 in header");
    expect(out).not.toContain("rawkey789");
    expect(out).toContain("<redacted>");
  });

  it("leaves unrelated text alone", () => {
    delete process.env.AGENC_RPC_URL;
    delete process.env.AGENC_INDEXER_URL;
    expect(sanitizeDiagnostic("plain failure, no urls")).toBe("plain failure, no urls");
  });
});

describe("toErrorResult", () => {
  it("sanitizes handler error messages before they reach the MCP client", () => {
    process.env.AGENC_INDEXER_URL = CRED_INDEXER;
    const result = toErrorResult(
      "get_agent_track_record",
      new Error(`indexer at ${CRED_INDEXER} responded 502 for GET /x`),
    );
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).not.toContain("INDEXERKEY456");
    expect(text).toContain("https://idx.example.com");
  });
});
