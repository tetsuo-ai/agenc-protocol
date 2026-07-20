import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { formatDiagnosticError } from "../src/redact.js";
import {
  resultDataFromHashHex,
  resultPlaceholderUri,
  ResultUploadError,
  sha256,
  sha256Hex,
  uploadResult,
  validateResultUri,
} from "../src/result.js";

describe("result hashing", () => {
  it("sha256/sha256Hex match node:crypto for arbitrary bytes", () => {
    const body = new TextEncoder().encode("the deliverable\nwith lines\n");
    const expected = createHash("sha256").update(body).digest();
    expect(Buffer.from(sha256(body))).toEqual(expected);
    expect(sha256Hex(body)).toBe(expected.toString("hex"));
    // Known vector: sha256("") =
    expect(sha256Hex(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("builds the documented placeholder URI from the hash", () => {
    const hex = sha256Hex(new TextEncoder().encode("result"));
    expect(resultPlaceholderUri(hex)).toBe(`agenc://result/sha256/${hex}`);
    expect(() => resultPlaceholderUri("nothex")).toThrow(/64-char/);
  });

  it("encodes resultData as the 64 utf8 bytes of the hex digest", () => {
    const hex = sha256Hex(new TextEncoder().encode("result"));
    const data = resultDataFromHashHex(hex);
    expect(data.length).toBe(64);
    expect(new TextDecoder().decode(data)).toBe(hex);
  });
});

describe("uploadResult", () => {
  const body = new TextEncoder().encode("artifact");

  it("POSTs the body and returns the uri from a {uri} response", async () => {
    let seen: {
      url: string;
      method?: string;
      headers?: Headers;
      redirect?: RequestInit["redirect"];
    } | null = null;
    const uri = await uploadResult({
      uploaderUrl: "https://up.example/store",
      body,
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        seen = {
          url: String(url),
          method: init?.method ?? "",
          headers: new Headers(init?.headers),
          redirect: init?.redirect,
        };
        return new Response(
          JSON.stringify({ uri: "https://cdn.example/r/1" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }) as typeof fetch,
    });
    expect(uri).toBe("https://cdn.example/r/1");
    expect(seen).toMatchObject({
      url: "https://up.example/store",
      method: "POST",
      redirect: "manual",
    });
    expect(seen!.headers!.get("idempotency-key")).toBe(sha256Hex(body));
  });

  it("rejects non-https uploader URLs", async () => {
    const failure = await uploadResult({
      uploaderUrl: "http://up.example",
      body,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ResultUploadError);
    expect(formatDiagnosticError(failure)).toBe(
      "resultUploader must be a credential-free HTTPS URL",
    );

    const invalid = await uploadResult({ uploaderUrl: "not a URL", body }).catch(
      (error: unknown) => error,
    );
    expect(formatDiagnosticError(invalid)).toBe(
      "resultUploader must be an absolute HTTPS URL",
    );
  });

  it("fails closed on non-2xx and on a bad response shape", async () => {
    await expect(
      uploadResult({
        uploaderUrl: "https://up.example",
        body,
        fetchImpl: (async () =>
          new Response("nope", { status: 500 })) as typeof fetch,
      }),
    ).rejects.toThrow(/500/);
    await expect(
      uploadResult({
        uploaderUrl: "https://up.example",
        body,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ notUri: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as typeof fetch,
      }),
    ).rejects.toThrow(/uri/);
  });

  it.each([300, 301, 302, 303, 304, 305, 306, 307, 308, 399])(
    "never follows or reads a %i redirect response",
    async (status) => {
      let calls = 0;
      let redirect: RequestInit["redirect"] | undefined;
      let bodyRead = false;
      const response = {
        ok: false,
        status,
        statusText: "Redirect",
        type: "basic",
        headers: new Headers({
          location: "http://127.0.0.1/leak",
          "content-type": "application/json",
        }),
        get body() {
          bodyRead = true;
          throw new Error("redirect body must not be read");
        },
      } as unknown as Response;

      await expect(
        uploadResult({
          uploaderUrl: "https://up.example",
          body,
          fetchImpl: (async (_url: unknown, init?: RequestInit) => {
            calls += 1;
            redirect = init?.redirect;
            return response;
          }) as typeof fetch,
        }),
      ).rejects.toThrow(/redirect/i);
      expect(calls).toBe(1);
      expect(redirect).toBe("manual");
      expect(bodyRead).toBe(false);
    },
  );

  it("rejects an opaque manual redirect response", async () => {
    await expect(
      uploadResult({
        uploaderUrl: "https://up.example",
        body,
        fetchImpl: (async () =>
          ({
            ok: false,
            status: 0,
            statusText: "",
            type: "opaqueredirect",
            headers: new Headers(),
            body: null,
          }) as Response) as typeof fetch,
      }),
    ).rejects.toThrow(/redirect/i);
  });

  it("bounds the streamed JSON response before parsing", async () => {
    await expect(
      uploadResult({
        uploaderUrl: "https://up.example",
        body,
        maxResponseBytes: 16,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ uri: "https://cdn.example/result" }), {
            headers: { "content-type": "application/json" },
          })) as typeof fetch,
      }),
    ).rejects.toThrow(/exceeds 16 bytes/);
  });

  it.each([
    { uri: null },
    { uri: "" },
    { uri: "javascript:alert(1)" },
    { uri: "https://user:secret@cdn.example/result" },
    { uri: "https://cdn.example/result\npoison" },
    { uri: `https://cdn.example/${"a".repeat(300)}` },
    { uri: "https://cdn.example/result", extra: true },
  ])("rejects unsafe or non-exact response schema %#", async (payload) => {
    await expect(
      uploadResult({
        uploaderUrl: "https://up.example",
        body,
        fetchImpl: (async () =>
          new Response(JSON.stringify(payload), {
            headers: { "content-type": "application/json" },
          })) as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(ResultUploadError);
  });

  it("requires JSON content type and wraps malformed uploader URLs", async () => {
    await expect(
      uploadResult({ uploaderUrl: "not a url", body }),
    ).rejects.toBeInstanceOf(ResultUploadError);
    await expect(
      uploadResult({
        uploaderUrl: "https://up.example",
        body,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ uri: "https://cdn.example/result" }))) as typeof fetch,
      }),
    ).rejects.toThrow(/content type/);
  });
});

describe("canonical result URI validation", () => {
  it.each([
    "https://cdn.example/result",
    `agenc://result/sha256/${"ab".repeat(32)}`,
    `ar://${"A".repeat(43)}`,
    `ipfs://Qm${"a".repeat(44)}/artifact.json`,
    `ipfs://b${"a".repeat(58)}`,
  ])("accepts canonical supported URI %s", (uri) => {
    expect(validateResultUri(uri)).toBe(uri);
  });

  it.each([
    "agenc:garbage",
    "agenc://result/sha256/not-a-hash",
    "ipfs:garbage",
    "ipfs://not-a-cid",
    `ipfs://Qm${"a".repeat(44)}/../secret`,
    "ar:garbage",
    "ar://short",
    "https://cdn.example/a/../result",
    "https://cdn.example/result#mutable",
  ])("rejects malformed or non-canonical URI %s", (uri) => {
    expect(() => validateResultUri(uri)).toThrow(ResultUploadError);
  });
});
