// P7.1 task-thread rails — SDK unit tests.
//
// Load-bearing requirements (PLAN.md Phase 7 wave 2):
//  - the canonical envelope hash round-trips and is stable under key reordering
//    (it IS the on-chain changes_hash / rejection_hash / rationale_hash);
//  - resolveChangesRequest matches the envelope whose hash equals the on-chain
//    digest, and rejects a thread that contains no matching message.
//
// A minimal fake content transport stands in for the storefront.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import {
  TASK_THREAD_ENVELOPE_VERSION,
  DEFAULT_MAX_TASK_THREAD_MESSAGES,
  canonicalEnvelopeJson,
  envelopeHash,
  assertTaskThreadEnvelope,
  createContentTransport,
  ContentTransportError,
  postTaskMessage,
  fetchTaskThread,
  resolveChangesRequest,
  type ContentTransport,
  type TaskThreadEnvelope,
} from "../src/task-thread/index.js";
import { canonicalJobSpecHash } from "../src/values/index.js";

/**
 * Committed cross-implementation known-answer vectors for the envelope
 * canonicalization + digest. The storefront task-thread test imports the SAME
 * SDK canonicalEnvelopeJson/envelopeHash and asserts the SAME file, so any
 * canonicalization drift between the two repos fails loudly. Loaded via fs to
 * stay agnostic to JSON-import-attribute syntax across Node versions.
 */
const VECTORS_PATH = fileURLToPath(
  new URL("./fixtures/task-thread-vectors.json", import.meta.url),
);
interface TaskThreadVector {
  name: string;
  envelope: TaskThreadEnvelope;
  canonical: string;
  expectedHex: string;
}
const TASK_THREAD_VECTORS: { vectors: TaskThreadVector[] } = JSON.parse(
  readFileSync(VECTORS_PATH, "utf8"),
) as { vectors: TaskThreadVector[] };

const TASK_PDA = "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK";

function makeEnvelope(
  over: Partial<TaskThreadEnvelope> = {},
): TaskThreadEnvelope {
  return {
    v: TASK_THREAD_ENVELOPE_VERSION,
    taskPda: TASK_PDA,
    parentHash: null,
    role: "buyer",
    body: "Please tighten the intro and add a benchmarks section.",
    attachments: [
      { uri: "agenc://artifact/sha256/abc", hash: "ab".repeat(32) },
    ],
    ts: 1_700_000_000,
    ...over,
  };
}

/** A fake content transport backed by an in-memory thread store. */
function makeFakeTransport(
  initial: TaskThreadEnvelope[] = [],
): ContentTransport & {
  stored: TaskThreadEnvelope[];
} {
  const stored = [...initial];
  return {
    baseUrl: "https://fake.test",
    stored,
    async get(path: string) {
      if (path.startsWith("/api/task-threads/")) {
        return { messages: stored };
      }
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path: string, body: unknown) {
      if (path.startsWith("/api/task-threads/")) {
        const env = (body as { envelope: TaskThreadEnvelope }).envelope;
        stored.push(env);
        return { envelope: env };
      }
      throw new Error(`unexpected POST ${path}`);
    },
  };
}

describe("envelope hash (P7.1)", () => {
  it("equals the json-stable-v1 sha256 the on-chain digest uses", async () => {
    const env = makeEnvelope();
    const { hex, bytes } = await envelopeHash(env);
    // The digest is exactly the canonical job-spec hash of the envelope object.
    const viaJobSpec = await canonicalJobSpecHash(env);
    expect(hex).toBe(viaJobSpec.hex);
    expect(Array.from(bytes)).toEqual(Array.from(viaJobSpec.bytes));
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable under object key reordering (canonicalization sorts keys)", async () => {
    const a = makeEnvelope();
    // Build a structurally identical envelope with keys inserted in a different order.
    const b: TaskThreadEnvelope = {
      ts: a.ts,
      attachments: a.attachments,
      body: a.body,
      role: a.role,
      parentHash: a.parentHash,
      taskPda: a.taskPda,
      v: a.v,
    };
    expect(canonicalEnvelopeJson(a)).toBe(canonicalEnvelopeJson(b));
    expect((await envelopeHash(a)).hex).toBe((await envelopeHash(b)).hex);
  });

  it("changes when any field changes (round-trip distinctness)", async () => {
    const base = await envelopeHash(makeEnvelope());
    const changedBody = await envelopeHash(makeEnvelope({ body: "different" }));
    const changedRole = await envelopeHash(makeEnvelope({ role: "worker" }));
    expect(changedBody.hex).not.toBe(base.hex);
    expect(changedRole.hex).not.toBe(base.hex);
  });

  it("assertTaskThreadEnvelope round-trips a valid envelope and rejects junk", () => {
    const env = makeEnvelope();
    expect(assertTaskThreadEnvelope(env)).toEqual(env);
    expect(() => assertTaskThreadEnvelope({ ...env, v: 2 })).toThrow(/version/);
    expect(() => assertTaskThreadEnvelope({ ...env, role: "judge" })).toThrow(
      /role/,
    );
    expect(() => assertTaskThreadEnvelope(null)).toThrow(/JSON object/);
  });

  it("rejects invalid addresses, hashes, URI schemes, bounds, and unknown keys", () => {
    const env = makeEnvelope();
    expect(() =>
      assertTaskThreadEnvelope({ ...env, taskPda: "../admin" }),
    ).toThrow(/taskPda/);
    expect(() =>
      assertTaskThreadEnvelope({ ...env, parentHash: "abcd" }),
    ).toThrow(/parentHash/);
    expect(() =>
      assertTaskThreadEnvelope({
        ...env,
        attachments: [{ uri: "javascript:alert(1)", hash: "ab".repeat(32) }],
      }),
    ).toThrow(/uri/);
    expect(() =>
      assertTaskThreadEnvelope({
        ...env,
        attachments: [{ uri: "https://safe.test/a", hash: "AB".repeat(32) }],
      }),
    ).toThrow(/hash/);
    expect(() => assertTaskThreadEnvelope({ ...env, ts: 1.5 })).toThrow(/ts/);
    expect(() => assertTaskThreadEnvelope({ ...env, extra: true })).toThrow(
      /unknown|keys/i,
    );
  });

  // CROSS-IMPL DRIFT GUARD (revert-sensitive): pin the canonicalization AND the
  // digest to fixed known answers in tests/fixtures/task-thread-vectors.json.
  // The storefront task-thread test imports the SAME SDK canonicalEnvelopeJson/
  // envelopeHash and asserts the SAME file; any drift in either canonicalizer
  // (Unicode handling, undefined-dropping, number/array formatting) breaks one
  // of these assertions instead of silently letting the two repos diverge.
  describe("committed known-answer vectors", () => {
    for (const vec of TASK_THREAD_VECTORS.vectors) {
      it(`canonical JSON + sha256 match the pinned vector: ${vec.name}`, async () => {
        expect(canonicalEnvelopeJson(vec.envelope)).toBe(vec.canonical);
        const { hex } = await envelopeHash(vec.envelope);
        expect(hex).toBe(vec.expectedHex);
        expect(hex).toMatch(/^[0-9a-f]{64}$/);
      });
    }

    it("drops an undefined-valued property without changing the digest (json-stable-v1)", async () => {
      const vec = TASK_THREAD_VECTORS.vectors.find(
        (v) => v.name === "tricky-nested-nonascii-undefined-drop",
      );
      if (vec === undefined) throw new Error("missing tricky vector");
      // JSON cannot carry `undefined`, so inject it at runtime: the canonicalizer
      // must drop it and produce the same canonical string + digest.
      const withUndefined = {
        ...vec.envelope,
        droppedUndefined: undefined,
      } as TaskThreadEnvelope;
      expect(canonicalEnvelopeJson(withUndefined)).toBe(vec.canonical);
      expect((await envelopeHash(withUndefined)).hex).toBe(vec.expectedHex);
    });
  });
});

describe("postTaskMessage / fetchTaskThread (P7.1)", () => {
  it("publishes an envelope and reads it back in order", async () => {
    const t = makeFakeTransport();
    const first = makeEnvelope({ body: "first" });
    const r1 = await postTaskMessage(t, first);
    expect(r1.hash).toBe((await envelopeHash(first)).hex);

    const second = makeEnvelope({
      body: "second",
      parentHash: r1.hash,
      role: "worker",
    });
    await postTaskMessage(t, second);

    const thread = await fetchTaskThread(t, TASK_PDA);
    expect(thread.messages.map((m) => m.body)).toEqual(["first", "second"]);
    expect(thread.messages[1].parentHash).toBe(r1.hash);
  });

  it("never returns a host-substituted envelope under the outbound hash", async () => {
    const outbound = makeEnvelope({ body: "pay A" });
    const substituted = makeEnvelope({ body: "pay B" });
    const transport: ContentTransport = {
      baseUrl: "https://fake.test",
      async get() {
        return { messages: [] };
      },
      async post() {
        return { envelope: substituted };
      },
    };
    const receipt = await postTaskMessage(transport, outbound);
    expect(receipt.envelope).toEqual(outbound);
    expect(receipt.hash).toBe((await envelopeHash(receipt.envelope)).hex);
  });

  it("validates outbound envelopes before hashing or transport and encodes path segments", async () => {
    const post = vi.fn(async () => ({}));
    const get = vi.fn(async () => ({ messages: [] }));
    const transport = {
      baseUrl: "https://fake.test",
      post,
      get,
    } satisfies ContentTransport;
    await expect(
      postTaskMessage(transport, makeEnvelope({ taskPda: "../admin" })),
    ).rejects.toThrow(/taskPda/);
    expect(post).not.toHaveBeenCalled();
    await expect(fetchTaskThread(transport, "../admin")).rejects.toThrow(
      /taskPda/,
    );
    expect(get).not.toHaveBeenCalled();
    await fetchTaskThread(transport, TASK_PDA);
    expect(get).toHaveBeenCalledWith(
      `/api/task-threads/${encodeURIComponent(TASK_PDA)}`,
    );
  });

  it("fetchTaskThread rejects a non-{messages} body", async () => {
    const bad: ContentTransport = {
      baseUrl: "https://fake.test",
      async get() {
        return { notMessages: [] };
      },
      async post() {
        return {};
      },
    };
    await expect(fetchTaskThread(bad, TASK_PDA)).rejects.toThrow(/messages/);
  });

  it("fetchTaskThread rejects a thread above its configured message limit", async () => {
    const t = makeFakeTransport([
      makeEnvelope({ body: "one" }),
      makeEnvelope({ body: "two" }),
      makeEnvelope({ body: "three" }),
    ]);

    await expect(
      fetchTaskThread(t, TASK_PDA, { maxMessages: 2 }),
    ).rejects.toThrow(/3 messages.*limit of 2/i);
  });

  it("fetchTaskThread applies a finite message limit by default", async () => {
    const messages = Array.from(
      { length: DEFAULT_MAX_TASK_THREAD_MESSAGES + 1 },
      (_unused, index) => makeEnvelope({ body: `message-${index}` }),
    );

    await expect(
      fetchTaskThread(makeFakeTransport(messages), TASK_PDA),
    ).rejects.toThrow(
      new RegExp(
        `${DEFAULT_MAX_TASK_THREAD_MESSAGES + 1} messages.*limit of ${DEFAULT_MAX_TASK_THREAD_MESSAGES}`,
        "i",
      ),
    );
  });
});

describe("content transport resource limits", () => {
  it("rejects disabled or non-finite resource bounds", () => {
    expect(() =>
      createContentTransport({
        baseUrl: "https://limits.test",
        timeoutMs: 0,
      }),
    ).toThrow(/timeoutMs must be a positive integer/);
    expect(() =>
      createContentTransport({
        baseUrl: "https://limits.test",
        maxResponseBytes: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(/maxResponseBytes must be a positive safe integer/);
  });

  it("times out even when an injected fetch implementation ignores abort", async () => {
    const transport = createContentTransport({
      baseUrl: "https://slow.test",
      timeoutMs: 5,
      fetchImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const failure = await transport
      .get("/slow")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ContentTransportError);
    expect(failure).toMatchObject({ status: 0 });
    expect((failure as Error).message).toContain("timed out after 5ms");
  });

  it("rejects an oversized streamed response before JSON parsing", async () => {
    const transport = createContentTransport({
      baseUrl: "https://large.test",
      maxResponseBytes: 32,
      fetchImpl: async () =>
        new Response(JSON.stringify({ payload: "x".repeat(128) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    const failure = await transport
      .get("/large")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ContentTransportError);
    expect(failure).toMatchObject({ status: 200 });
    expect((failure as Error).message).toMatch(/exceeds.*32 bytes/i);
  });

  it("fails closed without materializing a response that has no byte stream", async () => {
    const text = vi.fn(async () => {
      throw new Error("response.text() must not be called");
    });
    const transport = createContentTransport({
      baseUrl: "https://streamless.test",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        body: null,
        async json() {
          return { ok: true };
        },
        text,
      }),
    });

    const failure = await transport
      .get("/streamless")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ContentTransportError);
    expect(failure).toMatchObject({ status: 200 });
    expect((failure as Error).message).toMatch(/not a readable byte stream/i);
    expect(text).not.toHaveBeenCalled();
  });
});

describe("resolveChangesRequest (P7.1)", () => {
  it("returns the envelope whose hash matches the on-chain digest (hex + bytes)", async () => {
    const changeReq = makeEnvelope({ body: "rework section 2", role: "buyer" });
    const noise = makeEnvelope({ body: "unrelated chatter", role: "worker" });
    const t = makeFakeTransport([noise, changeReq]);
    const { hex, bytes } = await envelopeHash(changeReq);

    const byHex = await resolveChangesRequest(t, TASK_PDA, hex);
    expect(byHex.body).toBe("rework section 2");

    const byBytes = await resolveChangesRequest(t, TASK_PDA, bytes);
    expect(byBytes.body).toBe("rework section 2");

    // Uppercase / 0x-prefixed hex normalizes too.
    const byUpper = await resolveChangesRequest(
      t,
      TASK_PDA,
      "0x" + hex.toUpperCase(),
    );
    expect(byUpper.body).toBe("rework section 2");
  });

  it("throws when no thread message hashes to the on-chain digest", async () => {
    const t = makeFakeTransport([makeEnvelope({ body: "only message" })]);
    const bogus = "00".repeat(32);
    await expect(resolveChangesRequest(t, TASK_PDA, bogus)).rejects.toThrow(
      /no envelope/,
    );
  });
});
