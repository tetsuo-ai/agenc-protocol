import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCredibleExitEnvironment,
  parseCredibleExitKeypair,
  redactUrl,
} from "./credible-exit.mjs";

test("credible-exit parsers never reflect malformed secret input", () => {
  const secret = "raw-secret-material-that-must-not-reach-logs";
  for (const parse of [
    () => parseCredibleExitEnvironment(secret, "/tmp/env.json"),
    () => parseCredibleExitKeypair(secret, "/tmp/authority.json", "authority"),
  ]) {
    assert.throws(
      parse,
      (error) =>
        !error.message.includes(secret) &&
        !error.message.includes("Unexpected token"),
    );
  }
});

test("credible-exit accepts canonical key bytes and required env fields", () => {
  const bytes = Array.from({ length: 64 }, (_, index) => index);
  assert.deepEqual(
    parseCredibleExitKeypair(
      JSON.stringify(bytes),
      "/tmp/moderator.json",
      "moderator",
    ),
    Uint8Array.from(bytes),
  );
  assert.deepEqual(
    parseCredibleExitEnvironment(
      JSON.stringify({ rpcUrl: "http://127.0.0.1:8899", programId: "program" }),
      "/tmp/env.json",
    ),
    { rpcUrl: "http://127.0.0.1:8899", programId: "program" },
  );
});

test("credible-exit redacts credentials, paths, and query parameters", () => {
  const secret = "provider-api-secret";
  const redacted = redactUrl(
    `https://user:${secret}@rpc.example.test/v2/${secret}?api-key=${secret}`,
  );
  assert.equal(redacted, "https://rpc.example.test");
  assert.equal(redacted.includes(secret), false);
});
