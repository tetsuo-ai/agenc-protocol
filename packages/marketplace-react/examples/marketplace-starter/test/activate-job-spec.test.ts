import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createActivateJobSpecHandler,
  type StoreJobSpecInput,
  type TaskModerationInput,
} from "../server/activate-job-spec.js";

const TASK_PDA = "11111111111111111111111111111111";

function request(body: unknown, method = "POST"): Request {
  return new Request("https://market.example/api/agenc/job-specs/activate", {
    method,
    headers: { "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

function rawRequest(body: string, headers: HeadersInit = {}): Request {
  return new Request("https://market.example/api/agenc/job-specs/activate", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

test("activate job-spec handler stores and attests the canonical payload", async () => {
  const stored: StoreJobSpecInput[] = [];
  const attested: TaskModerationInput[] = [];
  const handler = createActivateJobSpecHandler({
    storeJobSpec: async (input) => {
      stored.push(input);
      return {
        uri: `https://market.example/job-specs/${input.jobSpecHashHex}.json`,
      };
    },
    attestTaskModeration: async (input) => {
      attested.push(input);
      return {
        attested: true,
        moderation: { verdict: "clean" },
        txSignature: "sig-task-moderation",
      };
    },
  });

  const response = await handler(
    request({
      taskPda: TASK_PDA,
      spec: {
        title: "Summarize the source material",
        deliverables: ["One markdown report"],
        acceptanceCriteria: ["Report cites the provided source material"],
      },
    }),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.jobSpecHashHex, /^[0-9a-f]{64}$/);
  assert.equal(body.moderationAttested, true);
  assert.equal(body.txSignature, "sig-task-moderation");
  assert.equal(body.jobSpecUri, `https://market.example/job-specs/${body.jobSpecHashHex}.json`);

  assert.equal(stored.length, 1);
  assert.equal(attested.length, 1);
  const storedInput = stored[0]!;
  const attestedInput = attested[0]!;
  assert.equal(storedInput.jobSpecHashHex, body.jobSpecHashHex);
  assert.equal(attestedInput.jobSpecHashHex, body.jobSpecHashHex);
  assert.equal(attestedInput.jobSpecUri, body.jobSpecUri);
  assert.equal(storedInput.payload.taskPda, TASK_PDA);
  assert.equal(storedInput.payload.schema, "agenc.marketplace.starter.jobSpec.v1");
  assert.ok(storedInput.canonicalJson.includes("Summarize the source material"));
});

test("activate job-spec handler rejects invalid task PDA and malformed spec", async () => {
  const handler = createActivateJobSpecHandler({
    storeJobSpec: async () => {
      throw new Error("store should not run");
    },
    attestTaskModeration: async () => {
      throw new Error("attestor should not run");
    },
  });

  const badTask = await handler(
    request({
      taskPda: "not-a-pda",
      spec: {
        title: "Title",
        deliverables: ["Deliverable"],
        acceptanceCriteria: ["Criterion"],
      },
    }),
  );
  assert.equal(badTask.status, 400);
  assert.match((await badTask.json()).error, /taskPda/);

  const badSpec = await handler(
    request({
      taskPda: TASK_PDA,
      spec: {
        title: "Title",
        deliverables: [],
        acceptanceCriteria: ["Criterion"],
      },
    }),
  );
  assert.equal(badSpec.status, 400);
  assert.match((await badSpec.json()).error, /deliverables/);
});

test("activate job-spec handler blocks a non-attested moderation result", async () => {
  const handler = createActivateJobSpecHandler({
    storeJobSpec: async (input) => ({
      uri: `https://market.example/job-specs/${input.jobSpecHashHex}.json`,
    }),
    attestTaskModeration: async () => ({
      attested: false,
      moderation: { verdict: "blocked" },
    }),
  });

  const response = await handler(
    request({
      taskPda: TASK_PDA,
      spec: {
        title: "Bad job",
        deliverables: ["Something unsafe"],
        acceptanceCriteria: ["No"],
      },
    }),
  );

  assert.equal(response.status, 422);
  const body = await response.json();
  assert.match(body.error, /did not attest/);
  assert.deepEqual(body.moderation, { verdict: "blocked" });
});

test("activate job-spec handler rejects non-POST methods", async () => {
  const handler = createActivateJobSpecHandler({
    storeJobSpec: async () => {
      throw new Error("store should not run");
    },
    attestTaskModeration: async () => {
      throw new Error("attestor should not run");
    },
  });

  const response = await handler(request(null, "GET"));
  assert.equal(response.status, 405);
});

test("activate job-spec handler rejects invalid JSON and oversized request bodies", async () => {
  const handler = createActivateJobSpecHandler({
    maxRequestBytes: 80,
    storeJobSpec: async () => {
      throw new Error("store should not run");
    },
    attestTaskModeration: async () => {
      throw new Error("attestor should not run");
    },
  });

  const invalidJson = await handler(rawRequest("{"));
  assert.equal(invalidJson.status, 400);
  assert.match((await invalidJson.json()).error, /valid JSON/);

  const oversized = await handler(
    rawRequest(
      JSON.stringify({
        taskPda: TASK_PDA,
        spec: {
          title: "Title",
          deliverables: ["Deliverable"],
          acceptanceCriteria: ["Criterion"],
        },
      }),
    ),
  );
  assert.equal(oversized.status, 413);
  assert.match((await oversized.json()).error, /too large/);

  const oversizedByHeader = await handler(
    rawRequest("{}", { "content-length": "999" }),
  );
  assert.equal(oversizedByHeader.status, 413);
});

test("activate job-spec handler rejects oversized canonical specs before storing", async () => {
  const handler = createActivateJobSpecHandler({
    maxCanonicalBytes: 12,
    storeJobSpec: async () => {
      throw new Error("store should not run");
    },
    attestTaskModeration: async () => {
      throw new Error("attestor should not run");
    },
  });

  const response = await handler(
    request({
      taskPda: TASK_PDA,
      spec: {
        title: "Title",
        deliverables: ["Deliverable"],
        acceptanceCriteria: ["Criterion"],
      },
    }),
  );

  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /too large/);
});

test("activate job-spec handler reports storage and attestation failures without leaking causes", async () => {
  const storageFailure = createActivateJobSpecHandler({
    storeJobSpec: async () => {
      throw new Error("store unavailable");
    },
    attestTaskModeration: async () => {
      throw new Error("attestor should not run");
    },
  });

  const baseBody = {
    taskPda: TASK_PDA,
    spec: {
      title: "Title",
      deliverables: ["Deliverable"],
      acceptanceCriteria: ["Criterion"],
    },
  };

  const storageResponse = await storageFailure(request(baseBody));
  assert.equal(storageResponse.status, 502);
  assert.equal((await storageResponse.json()).error, "Job-spec storage failed.");

  const emptyStorageUri = createActivateJobSpecHandler({
    storeJobSpec: async () => ({
      uri: "",
    }),
    attestTaskModeration: async () => {
      throw new Error("attestor should not run");
    },
  });

  const emptyUriResponse = await emptyStorageUri(request(baseBody));
  assert.equal(emptyUriResponse.status, 502);
  assert.equal(
    (await emptyUriResponse.json()).error,
    "Job-spec storage returned no URI.",
  );

  const attestationFailure = createActivateJobSpecHandler({
    storeJobSpec: async (input) => ({
      uri: `https://market.example/job-specs/${input.jobSpecHashHex}.json`,
    }),
    attestTaskModeration: async () => {
      throw new Error("attestor unavailable");
    },
  });

  const attestationResponse = await attestationFailure(request(baseBody));
  assert.equal(attestationResponse.status, 502);
  assert.equal(
    (await attestationResponse.json()).error,
    "Task moderation attestation failed.",
  );
});
