import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  resultDataFromHashHex,
  resultPlaceholderUri,
  ResultUploadError,
  sha256,
  sha256Hex,
  uploadResult,
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
    let seen: { url: string; method?: string } | null = null;
    const uri = await uploadResult({
      uploaderUrl: "https://up.example/store",
      body,
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        seen = { url: String(url), method: init?.method ?? "" };
        return new Response(JSON.stringify({ uri: "https://cdn.example/r/1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    expect(uri).toBe("https://cdn.example/r/1");
    expect(seen).toEqual({ url: "https://up.example/store", method: "POST" });
  });

  it("rejects non-https uploader URLs", async () => {
    await expect(
      uploadResult({ uploaderUrl: "http://up.example", body }),
    ).rejects.toBeInstanceOf(ResultUploadError);
  });

  it("fails closed on non-2xx and on a bad response shape", async () => {
    await expect(
      uploadResult({
        uploaderUrl: "https://up.example",
        body,
        fetchImpl: (async () => new Response("nope", { status: 500 })) as typeof fetch,
      }),
    ).rejects.toThrow(/500/);
    await expect(
      uploadResult({
        uploaderUrl: "https://up.example",
        body,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ notUri: true }), { status: 200 })) as typeof fetch,
      }),
    ).rejects.toThrow(/uri/);
  });
});
