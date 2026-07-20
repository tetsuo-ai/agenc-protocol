import assert from "node:assert/strict";
import { test } from "node:test";
import { values } from "@tetsuo-ai/marketplace-sdk";
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

test("activate job-spec handler stores a verifiable envelope and attests its canonical payload", async () => {
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
  assert.equal(storedInput.envelope.payload.taskPda, TASK_PDA);
  assert.equal(
    storedInput.envelope.payload.schema,
    "agenc.marketplace.starter.jobSpec.v1",
  );
  assert.ok(attestedInput.canonicalJson.includes("Summarize the source material"));
  assert.deepEqual(
    storedInput.envelope,
    {
      integrity: {
        algorithm: "sha256",
        canonicalization: "json-stable-v1",
        payloadHash: body.jobSpecHashHex,
      },
      payload: attestedInput.payload,
    },
  );
  assert.equal(
    (await values.canonicalJobSpecHash(storedInput.envelope.payload)).hex,
    body.jobSpecHashHex,
  );
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
  assert.equal((await badTask.json()).error, "Task PDA or job spec is invalid.");

  const base58LookingButWrongWidth = await handler(
    request({
      taskPda: "z".repeat(32),
      spec: {
        title: "Title",
        deliverables: ["Deliverable"],
        acceptanceCriteria: ["Criterion"],
      },
    }),
  );
  assert.equal(base58LookingButWrongWidth.status, 400);
  assert.equal(
    (await base58LookingButWrongWidth.json()).error,
    "Task PDA or job spec is invalid.",
  );

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
  assert.equal((await badSpec.json()).error, "Task PDA or job spec is invalid.");
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

test("activate job-spec handler applies its size limit to the complete hosted envelope", async () => {
  const canonicalPayloadBytes = new TextEncoder().encode(
    values.canonicalJobSpecJson({
      schema: "agenc.marketplace.starter.jobSpec.v1",
      taskPda: TASK_PDA,
      title: "Title",
      deliverables: ["Deliverable"],
      acceptanceCriteria: ["Criterion"],
    }),
  ).byteLength;
  const handler = createActivateJobSpecHandler({
    // The payload fits exactly, but its required integrity envelope does not.
    maxCanonicalBytes: canonicalPayloadBytes,
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

  let invalidUriAttestorCalls = 0;
  for (const uri of [
    "job-specs/spec.json",
    "ftp://market.example/job-specs/spec.json",
    "https://user:secret@[::1]/job-specs/spec.json",
    `https://market.example/${"x".repeat(300)}`,
  ]) {
    const invalidStorageUri = createActivateJobSpecHandler({
      storeJobSpec: async () => ({ uri }),
      attestTaskModeration: async () => {
        invalidUriAttestorCalls += 1;
        return { attested: true };
      },
    });

    const invalidUriResponse = await invalidStorageUri(request(baseBody));
    assert.equal(invalidUriResponse.status, 502);
    assert.equal(
      (await invalidUriResponse.json()).error,
      "Job-spec storage returned an invalid URI.",
    );
  }
  assert.equal(invalidUriAttestorCalls, 0);

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
