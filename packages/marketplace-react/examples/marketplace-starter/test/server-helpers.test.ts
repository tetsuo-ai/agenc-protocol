import assert from "node:assert/strict";
import {
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { values } from "@tetsuo-ai/marketplace-sdk";
import {
  createFileJobSpecGetHandler,
  createFileJobSpecStore,
} from "../server/file-store.js";
import { createRemoteTaskModerationAttestor } from "../server/remote-attestor.js";
import type {
  StarterJobSpecPayload,
  StoreJobSpecInput,
  TaskModerationInput,
} from "../server/activate-job-spec.js";

const TASK_PDA = "11111111111111111111111111111111";

function payload(): StarterJobSpecPayload {
  return {
    schema: "agenc.marketplace.starter.jobSpec.v1",
    taskPda: TASK_PDA,
    title: "Title",
    deliverables: ["Deliverable"],
    acceptanceCriteria: ["Criterion"],
  };
}

async function storeInput(): Promise<StoreJobSpecInput> {
  const jobSpecPayload = payload();
  const jobSpecHashHex = (await values.canonicalJobSpecHash(jobSpecPayload)).hex;
  return {
    taskPda: TASK_PDA,
    jobSpecHashHex,
    envelope: {
      integrity: {
        algorithm: "sha256",
        canonicalization: "json-stable-v1",
        payloadHash: jobSpecHashHex,
      },
      payload: jobSpecPayload,
    },
  };
}

function moderationInput(
  hash: string,
): Omit<TaskModerationInput, "jobSpecUri"> {
  const jobSpecPayload = payload();
  return {
    taskPda: TASK_PDA,
    jobSpecHashHex: hash,
    canonicalJson: values.canonicalJobSpecJson(jobSpecPayload),
    payload: jobSpecPayload,
  };
}

test("file job-spec store writes a worker-verifiable content-addressed envelope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agenc-job-specs-"));
  try {
    const store = createFileJobSpecStore({
      directory,
      publicBaseUrl: "https://market.example/job-specs/",
    });
    const input = await storeInput();
    input.jobSpecHashHex = input.jobSpecHashHex.toUpperCase();
    const hash = input.jobSpecHashHex;
    const stored = await store(input);

    assert.equal(
      stored.uri,
      `https://market.example/job-specs/${hash.toLowerCase()}.json`,
    );
    const storedDocument = await readFile(
      join(directory, `${hash.toLowerCase()}.json`),
      "utf8",
    );
    assert.equal(storedDocument, `${values.canonicalJobSpecJson(input.envelope)}\n`);
    const document = JSON.parse(storedDocument);
    assert.deepEqual(document, {
      integrity: {
        algorithm: "sha256",
        canonicalization: "json-stable-v1",
        payloadHash: input.envelope.integrity.payloadHash,
      },
      payload: input.envelope.payload,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("public GET handler serves the exact immutable worker envelope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agenc-job-specs-"));
  try {
    const store = createFileJobSpecStore({
      directory,
      publicBaseUrl: "https://market.example/job-specs",
    });
    const input = await storeInput();
    const stored = await store(input);
    const getJobSpec = createFileJobSpecGetHandler({ directory });

    const response = await getJobSpec(new Request(stored.uri));
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
    );
    const envelope = JSON.parse(await response.text());
    assert.deepEqual(envelope, input.envelope);
    assert.equal(
      (await values.canonicalJobSpecHash(envelope.payload)).hex,
      envelope.integrity.payloadHash,
    );

    const missing = await getJobSpec(
      new Request(`https://market.example/job-specs/${"0".repeat(64)}.json`),
    );
    assert.equal(missing.status, 404);
    const invalid = await getJobSpec(
      new Request("https://market.example/job-specs/../secret.json"),
    );
    assert.equal(invalid.status, 400);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file job-spec store is idempotent and never overwrites a hash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agenc-job-specs-"));
  try {
    const store = createFileJobSpecStore({
      directory,
      publicBaseUrl: "https://market.example/job-specs",
    });
    const initial = await storeInput();
    const hash = initial.jobSpecHashHex;

    await store(initial);
    await store(initial);

    const filePath = join(directory, `${hash}.json`);
    const conflictingDocument = "{\"unexpected\":true}\n";
    await writeFile(filePath, conflictingDocument, "utf8");
    await assert.rejects(() => store(initial), /different contents/i);

    assert.equal(await readFile(filePath, "utf8"), conflictingDocument);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file job-spec store atomically publishes one complete concurrent winner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agenc-job-specs-"));
  try {
    const store = createFileJobSpecStore({
      directory,
      publicBaseUrl: "https://market.example/job-specs",
    });
    const input = await storeInput();
    const expected = `${values.canonicalJobSpecJson(input.envelope)}\n`;

    const results = await Promise.all(
      Array.from({ length: 24 }, () => store(input)),
    );
    assert.equal(new Set(results.map(({ uri }) => uri)).size, 1);
    assert.equal(
      await readFile(join(directory, `${input.jobSpecHashHex}.json`), "utf8"),
      expected,
    );
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file job-spec store fsyncs its directory before successful return", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "agenc-job-specs-"));
  const probe = await open(directory, "r");
  const fileHandlePrototype = Object.getPrototypeOf(probe) as {
    sync: FileHandle["sync"];
  };
  await probe.close();
  const originalSync = fileHandlePrototype.sync;
  let directorySyncs = 0;
  context.mock.method(
    fileHandlePrototype,
    "sync",
    async function (this: FileHandle): Promise<void> {
      if ((await this.stat()).isDirectory()) directorySyncs += 1;
      await originalSync.call(this);
    },
  );

  try {
    const store = createFileJobSpecStore({
      directory,
      publicBaseUrl: "https://market.example/job-specs",
    });
    const input = await storeInput();

    await store(input);
    await store(input);

    assert.equal(directorySyncs, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file job-spec store rejects unsafe hash filenames", async () => {
  const store = createFileJobSpecStore({
    directory: "/tmp/agenc-job-specs-test",
    publicBaseUrl: "https://market.example/job-specs",
  });

  const input = await storeInput();
  await assert.rejects(
    () => store({ ...input, jobSpecHashHex: "../not-a-hash" }),
    /32-byte hex/,
  );
});

test("file job-spec store rejects unsafe public base URLs", () => {
  const invalidBaseUrls = [
    "ftp://market.example/job-specs",
    "https://user:secret@market.example/job-specs",
    "https://market.example/job-specs?",
    "https://market.example/job-specs#",
  ];

  for (const publicBaseUrl of invalidBaseUrls) {
    assert.throws(
      () =>
        createFileJobSpecStore({
          directory: "/tmp/agenc-job-specs-test",
          publicBaseUrl,
        }),
      /publicBaseUrl must be/i,
    );
  }
});

test("file job-spec store rejects a public URI that cannot fit on the task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agenc-job-specs-"));
  try {
    const store = createFileJobSpecStore({
      directory,
      publicBaseUrl: `https://market.example/${"x".repeat(240)}`,
    });
    const input = await storeInput();

    await assert.rejects(() => store(input), /public URI exceeds 256 bytes/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file job-spec store rejects a payload that does not match its content address", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agenc-job-specs-"));
  try {
    const store = createFileJobSpecStore({
      directory,
      publicBaseUrl: "https://market.example/job-specs",
    });
    const input = await storeInput();
    input.envelope.payload = { ...input.envelope.payload, title: "Changed" };

    await assert.rejects(() => store(input), /payload does not match its address/i);
    await assert.rejects(
      () => readFile(join(directory, `${input.jobSpecHashHex}.json`), "utf8"),
      /ENOENT/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
    ...moderationInput("ab".repeat(32)),
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
        ...moderationInput("ab".repeat(32)),
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
        ...moderationInput("ab".repeat(32)),
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
        ...moderationInput("ab".repeat(32)),
        jobSpecUri: "https://market.example/job-specs/ab.json",
      }),
    /timed out/,
  );
});
