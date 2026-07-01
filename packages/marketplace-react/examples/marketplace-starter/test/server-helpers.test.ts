import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFileJobSpecStore } from "../server/file-store.js";
import { createRemoteTaskModerationAttestor } from "../server/remote-attestor.js";
import type { StoreJobSpecInput } from "../server/activate-job-spec.js";

function storeInput(hash: string): StoreJobSpecInput {
  return {
    taskPda: "11111111111111111111111111111111",
    jobSpecHashHex: hash,
    canonicalJson: "{\"schema\":\"agenc.marketplace.starter.jobSpec.v1\"}",
    payload: {
      schema: "agenc.marketplace.starter.jobSpec.v1",
      taskPda: "11111111111111111111111111111111",
      title: "Title",
      deliverables: ["Deliverable"],
      acceptanceCriteria: ["Criterion"],
    },
  };
}

test("file job-spec store writes content-addressed canonical JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agenc-job-specs-"));
  try {
    const store = createFileJobSpecStore({
      directory,
      publicBaseUrl: "https://market.example/job-specs/",
    });
    const hash = "AB".repeat(32);

    const stored = await store(storeInput(hash));

    assert.equal(
      stored.uri,
      `https://market.example/job-specs/${hash.toLowerCase()}.json`,
    );
    assert.equal(
      await readFile(join(directory, `${hash.toLowerCase()}.json`), "utf8"),
      `${storeInput(hash).canonicalJson}\n`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file job-spec store rejects unsafe hash filenames", async () => {
  const store = createFileJobSpecStore({
    directory: "/tmp/agenc-job-specs-test",
    publicBaseUrl: "https://market.example/job-specs",
  });

  await assert.rejects(
    () => store(storeInput("../not-a-hash")),
    /32-byte hex/,
  );
});

test("remote task moderation attestor posts canonical payload and bearer token", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const attestor = createRemoteTaskModerationAttestor({
    endpoint: "https://attestor.example/api/task-moderation/attest",
    bearerToken: "server-token",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({
          attested: true,
          moderation: { verdict: "clean" },
          txSignature: "sig",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const result = await attestor({
    ...storeInput("ab".repeat(32)),
    jobSpecUri: "https://market.example/job-specs/ab.json",
  });

  assert.deepEqual(result, {
    attested: true,
    moderation: { verdict: "clean" },
    txSignature: "sig",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://attestor.example/api/task-moderation/attest");
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(
    (calls[0]!.init.headers as Record<string, string>).authorization,
    "Bearer server-token",
  );
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.jobSpecHash, "ab".repeat(32));
  assert.equal(body.jobSpecUri, "https://market.example/job-specs/ab.json");
  assert.equal(body.jobSpec.schema, "agenc.marketplace.starter.jobSpec.v1");
});

test("remote task moderation attestor surfaces endpoint errors", async () => {
  const attestor = createRemoteTaskModerationAttestor({
    endpoint: "https://attestor.example/api/task-moderation/attest",
    fetch: async () =>
      new Response(JSON.stringify({ error: { reason: "blocked spec" } }), {
        status: 422,
        headers: { "content-type": "application/json" },
      }),
  });

  await assert.rejects(
    () =>
      attestor({
        ...storeInput("ab".repeat(32)),
        jobSpecUri: "https://market.example/job-specs/ab.json",
      }),
    /blocked spec/,
  );
});

test("remote task moderation attestor handles non-JSON error responses", async () => {
  const attestor = createRemoteTaskModerationAttestor({
    endpoint: "https://attestor.example/api/task-moderation/attest",
    fetch: async () => new Response("upstream exploded", { status: 500 }),
  });

  await assert.rejects(
    () =>
      attestor({
        ...storeInput("ab".repeat(32)),
        jobSpecUri: "https://market.example/job-specs/ab.json",
      }),
    /Task moderation endpoint failed \(500\)/,
  );
});

test("remote task moderation attestor times out slow endpoints", async () => {
  const attestor = createRemoteTaskModerationAttestor({
    endpoint: "https://attestor.example/api/task-moderation/attest",
    timeoutMs: 1,
    fetch: async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  });

  await assert.rejects(
    () =>
      attestor({
        ...storeInput("ab".repeat(32)),
        jobSpecUri: "https://market.example/job-specs/ab.json",
      }),
    /timed out/,
  );
});
