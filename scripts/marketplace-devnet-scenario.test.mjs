import test from "node:test";
import assert from "node:assert/strict";

import {
  SCENARIOS,
  buildRemoteProverConfig,
  buildRemoteProverConfigFromEnv,
  mergeProverHeaders,
  parsePositiveTimeoutMs,
  parseProverHeadersJson,
} from "./marketplace-devnet-scenario-shared.mjs";

test("DV-03E scenario metadata is wired into the runner", () => {
  assert.equal(SCENARIOS["DV-03E"]?.evidenceInstruction, "complete_task_private");
  assert.deepEqual(SCENARIOS["DV-03E"]?.orderedInstructionList, [
    "register_agent",
    "create_task",
    "create_dependent_task",
    "initialize_bid_book",
    "create_bid",
    "accept_bid",
    "complete_task_private",
  ]);
});

test("parsePositiveTimeoutMs accepts positive integers", () => {
  assert.equal(parsePositiveTimeoutMs("1500"), 1500);
  assert.equal(parsePositiveTimeoutMs(undefined), undefined);
});

test("parsePositiveTimeoutMs rejects non-positive values", () => {
  assert.throws(
    () => parsePositiveTimeoutMs("0"),
    /AGENC_PROVER_TIMEOUT_MS must be a positive integer/,
  );
  assert.throws(
    () => parsePositiveTimeoutMs("-10"),
    /AGENC_PROVER_TIMEOUT_MS must be a positive integer/,
  );
  assert.throws(
    () => parsePositiveTimeoutMs("abc"),
    /AGENC_PROVER_TIMEOUT_MS must be a positive integer/,
  );
});

test("parseProverHeadersJson parses a JSON object of string headers", () => {
  assert.deepEqual(
    parseProverHeadersJson('{"x-proof-mode":"remote","x-env":"validation"}'),
    {
      "x-proof-mode": "remote",
      "x-env": "validation",
    },
  );
});

test("parseProverHeadersJson rejects invalid JSON shapes", () => {
  assert.throws(
    () => parseProverHeadersJson("[1,2,3]"),
    /AGENC_PROVER_HEADERS_JSON must be a JSON object/,
  );
  assert.throws(
    () => parseProverHeadersJson('{"x-proof-mode":123}'),
    /must be a non-empty string/,
  );
});

test("mergeProverHeaders lets explicit overrides win", () => {
  assert.deepEqual(
    mergeProverHeaders(
      { Authorization: "Bearer default", "x-proof-mode": "remote" },
      { Authorization: "Bearer override" },
    ),
    {
      Authorization: "Bearer override",
      "x-proof-mode": "remote",
    },
  );
});

test("buildRemoteProverConfigFromEnv converts API key into bearer auth", () => {
  const config = buildRemoteProverConfigFromEnv({
    AGENC_PROVER_ENDPOINT: "https://prover.example.com",
    AGENC_PROVER_API_KEY: "secret-token",
  });

  assert.deepEqual(config, {
    kind: "remote",
    endpoint: "https://prover.example.com",
    headers: {
      Authorization: "Bearer secret-token",
    },
  });
});

test("buildRemoteProverConfigFromEnv merges header overrides and timeout", () => {
  const config = buildRemoteProverConfigFromEnv({
    AGENC_PROVER_ENDPOINT: "https://prover.example.com/",
    AGENC_PROVER_API_KEY: "default-token",
    AGENC_PROVER_TIMEOUT_MS: "450000",
    AGENC_PROVER_HEADERS_JSON:
      '{"Authorization":"Bearer override-token","x-proof-mode":"remote"}',
  });

  assert.deepEqual(config, {
    kind: "remote",
    endpoint: "https://prover.example.com/",
    timeoutMs: 450000,
    headers: {
      Authorization: "Bearer override-token",
      "x-proof-mode": "remote",
    },
  });
});

test("buildRemoteProverConfig uses config defaults and alternate api key env vars", () => {
  const config = buildRemoteProverConfig(
    {
      endpoint: "https://prover.example.com",
      timeoutMs: 300000,
      headers: {
        "x-proof-mode": "remote",
        "x-prover-env": "validation",
      },
      apiKeyEnvVar: "DV03E_PROVER_API_KEY",
    },
    {
      DV03E_PROVER_API_KEY: "config-token",
    },
  );

  assert.deepEqual(config, {
    kind: "remote",
    endpoint: "https://prover.example.com",
    timeoutMs: 300000,
    headers: {
      Authorization: "Bearer config-token",
      "x-proof-mode": "remote",
      "x-prover-env": "validation",
    },
  });
});

test("buildRemoteProverConfig lets env override configured endpoint timeout and headers", () => {
  const config = buildRemoteProverConfig(
    {
      endpoint: "https://config-prover.example.com",
      timeoutMs: 300000,
      headers: {
        Authorization: "Bearer config-token",
        "x-proof-mode": "configured",
      },
      apiKeyEnvVar: "DV03E_PROVER_API_KEY",
    },
    {
      DV03E_PROVER_API_KEY: "config-token",
      AGENC_PROVER_ENDPOINT: "https://env-prover.example.com",
      AGENC_PROVER_TIMEOUT_MS: "450000",
      AGENC_PROVER_HEADERS_JSON:
        '{"Authorization":"Bearer override-token","x-proof-mode":"remote"}',
    },
  );

  assert.deepEqual(config, {
    kind: "remote",
    endpoint: "https://env-prover.example.com",
    timeoutMs: 450000,
    headers: {
      Authorization: "Bearer override-token",
      "x-proof-mode": "remote",
    },
  });
});

test("buildRemoteProverConfigFromEnv requires a secure endpoint", () => {
  assert.throws(
    () => buildRemoteProverConfigFromEnv({}),
    /AGENC_PROVER_ENDPOINT is required for DV-03E/,
  );
  assert.throws(
    () =>
      buildRemoteProverConfigFromEnv({
        AGENC_PROVER_ENDPOINT: "https://user:secret@example.com",
      }),
    /must not include credentials/,
  );
});
