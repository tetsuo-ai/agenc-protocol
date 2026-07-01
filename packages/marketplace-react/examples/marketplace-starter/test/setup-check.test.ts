import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertStarterBackendEnv,
  mergeStarterEnv,
  parseStarterEnvFile,
  validateStarterSetupEnv,
} from "../server/setup-check.js";

const VALID_WALLET = "HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK";

const VALID_ENV = {
  VITE_AGENC_NETWORK: "devnet",
  VITE_AGENC_RPC_URL: "https://api.devnet.solana.com",
  VITE_AGENC_RPC_SUBSCRIPTIONS_URL: "wss://api.devnet.solana.com",
  VITE_AGENC_INDEXER_URL: "https://indexer.example",
  VITE_AGENC_BACKEND_URL: "https://market.example",
  VITE_AGENC_REFERRER_WALLET: VALID_WALLET,
  VITE_AGENC_REFERRER_FEE_BPS: "50",
  AGENC_JOB_SPEC_DIR: ".data/job-specs",
  AGENC_JOB_SPEC_PUBLIC_BASE_URL: "https://market.example/job-specs/",
  AGENC_TASK_MODERATION_ATTEST_URL:
    "https://attestor.example/api/task-moderation/attest",
  AGENC_TASK_MODERATION_ATTEST_TOKEN: "server-token",
} satisfies Record<string, string>;

function errorText(env: Record<string, string | undefined>): string {
  return validateStarterSetupEnv(env)
    .errors.map((entry) => `${entry.variable}: ${entry.message}`)
    .join("\n");
}

test("valid starter setup env returns normalized frontend and backend config", () => {
  const check = validateStarterSetupEnv(VALID_ENV);

  assert.equal(check.ok, true);
  assert.deepEqual(check.config?.frontend, {
    network: "devnet",
    rpcUrl: "https://api.devnet.solana.com",
    rpcSubscriptionsUrl: "wss://api.devnet.solana.com",
    indexerUrl: "https://indexer.example",
    backendUrl: "https://market.example",
    referrer: {
      wallet: VALID_WALLET,
      feeBps: 50,
    },
  });
  assert.deepEqual(check.config?.backend, {
    jobSpecDir: ".data/job-specs",
    jobSpecPublicBaseUrl: "https://market.example/job-specs/",
    taskModerationAttestUrl:
      "https://attestor.example/api/task-moderation/attest",
    taskModerationAttestToken: "server-token",
  });
  assert.match(check.warnings[0]!.message, /wallet signing/);
});

test("missing required frontend and backend vars produce setup errors", () => {
  const errors = errorText({});

  assert.match(errors, /VITE_AGENC_NETWORK is required/);
  assert.match(errors, /VITE_AGENC_RPC_URL is required/);
  assert.match(errors, /VITE_AGENC_INDEXER_URL is required/);
  assert.match(errors, /VITE_AGENC_BACKEND_URL is required/);
  assert.match(errors, /AGENC_JOB_SPEC_DIR is required/);
  assert.match(errors, /AGENC_JOB_SPEC_PUBLIC_BASE_URL is required/);
  assert.match(errors, /AGENC_TASK_MODERATION_ATTEST_URL is required/);
});

test("invalid starter setup values fail closed with named env errors", () => {
  const cases: Array<{
    name: string;
    patch: Record<string, string | undefined>;
    expected: RegExp;
  }> = [
    {
      name: "localnet",
      patch: { VITE_AGENC_NETWORK: "localnet" },
      expected: /localnet is not wired/,
    },
    {
      name: "unsupported network",
      patch: { VITE_AGENC_NETWORK: "testnet" },
      expected: /must be "devnet" or "mainnet"/,
    },
    {
      name: "bad rpc url",
      patch: { VITE_AGENC_RPC_URL: "ftp://rpc.example" },
      expected: /VITE_AGENC_RPC_URL must be an absolute http:\/https: URL/,
    },
    {
      name: "bad subscriptions url",
      patch: { VITE_AGENC_RPC_SUBSCRIPTIONS_URL: "ftp://rpc.example" },
      expected:
        /VITE_AGENC_RPC_SUBSCRIPTIONS_URL must be an absolute ws:\/wss:\/http:\/https: URL/,
    },
    {
      name: "bad backend url",
      patch: { VITE_AGENC_BACKEND_URL: "/api/agenc" },
      expected: /VITE_AGENC_BACKEND_URL must be an absolute http:\/https: URL/,
    },
    {
      name: "referrer fee without wallet",
      patch: {
        VITE_AGENC_REFERRER_WALLET: undefined,
        VITE_AGENC_REFERRER_FEE_BPS: "25",
      },
      expected: /VITE_AGENC_REFERRER_WALLET is required/,
    },
    {
      name: "referrer wallet without fee",
      patch: {
        VITE_AGENC_REFERRER_WALLET: VALID_WALLET,
        VITE_AGENC_REFERRER_FEE_BPS: undefined,
      },
      expected: /VITE_AGENC_REFERRER_FEE_BPS is required/,
    },
    {
      name: "invalid referrer wallet",
      patch: { VITE_AGENC_REFERRER_WALLET: "not-a-wallet" },
      expected: /VITE_AGENC_REFERRER_WALLET must be a valid Solana address/,
    },
    {
      name: "decimal referrer fee",
      patch: { VITE_AGENC_REFERRER_FEE_BPS: "1.5" },
      expected: /VITE_AGENC_REFERRER_FEE_BPS must be an integer/,
    },
    {
      name: "out of range referrer fee",
      patch: { VITE_AGENC_REFERRER_FEE_BPS: "2001" },
      expected: /VITE_AGENC_REFERRER_FEE_BPS must be between 0 and 2000/,
    },
    {
      name: "bad job spec base url",
      patch: { AGENC_JOB_SPEC_PUBLIC_BASE_URL: "file:///tmp/specs" },
      expected:
        /AGENC_JOB_SPEC_PUBLIC_BASE_URL must be an absolute http:\/https: URL/,
    },
    {
      name: "bad attestation url",
      patch: { AGENC_TASK_MODERATION_ATTEST_URL: "ws://attestor.example" },
      expected:
        /AGENC_TASK_MODERATION_ATTEST_URL must be an absolute http:\/https: URL/,
    },
  ];

  for (const { name, patch, expected } of cases) {
    assert.match(errorText({ ...VALID_ENV, ...patch }), expected, name);
  }
});

test("assertStarterBackendEnv returns normalized backend config or throws", () => {
  assert.deepEqual(assertStarterBackendEnv(VALID_ENV), {
    jobSpecDir: ".data/job-specs",
    jobSpecPublicBaseUrl: "https://market.example/job-specs/",
    taskModerationAttestUrl:
      "https://attestor.example/api/task-moderation/attest",
    taskModerationAttestToken: "server-token",
  });

  assert.throws(
    () =>
      assertStarterBackendEnv({
        ...VALID_ENV,
        AGENC_TASK_MODERATION_ATTEST_URL: "ftp://attestor.example",
      }),
    /AGENC_TASK_MODERATION_ATTEST_URL/,
  );
});

test("parseStarterEnvFile supports simple dotenv-like assignments", () => {
  assert.deepEqual(
    parseStarterEnvFile(`
      # comment
      export VITE_AGENC_NETWORK = "devnet"
      VITE_AGENC_BACKEND_URL='https://market.example/path=a'
      VALUE_WITH_EQUALS=value=with=equals
      INVALID LINE
    `),
    {
      VITE_AGENC_NETWORK: "devnet",
      VITE_AGENC_BACKEND_URL: "https://market.example/path=a",
      VALUE_WITH_EQUALS: "value=with=equals",
    },
  );
});

test("mergeStarterEnv lets process env override env-file values", () => {
  assert.deepEqual(
    mergeStarterEnv(
      {
        VITE_AGENC_NETWORK: "devnet",
        VITE_AGENC_RPC_URL: "https://file.example",
      },
      {
        VITE_AGENC_NETWORK: "mainnet",
        VITE_AGENC_RPC_URL: undefined,
        VITE_AGENC_INDEXER_URL: "https://process.example",
      },
    ),
    {
      VITE_AGENC_NETWORK: "mainnet",
      VITE_AGENC_RPC_URL: "https://file.example",
      VITE_AGENC_INDEXER_URL: "https://process.example",
    },
  );
});
