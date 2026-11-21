import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";

import {
  buildRemoteProverConfig,
  buildRemoteProverConfigFromEnv,
  parseProverHeadersJson,
} from "./marketplace-devnet-scenario-shared.mjs";

// Review S-19, item 64: AGENC_PROVER_HEADERS_JSON can hold an Authorization
// header, and a JSON.parse error quotes its input. This file is a preflight-*
// test so the deployment-scripts suite runs it; the parser's other tests are in
// marketplace-devnet-scenario.test.mjs, which no suite runs.

// Synthetic stand-ins for a credential: none of them is a real token.
const TOKEN = "SynthTok-Qw3rTy7Z9x-NotAReal-K3y";
const QUOTED_BY_JSON_PARSE = [
  ["the token alone", TOKEN],
  ["a short bearer value, quoted whole", "Bearer Sk3yQ9zX"],
  ["an unquoted header value", `{"Authorization":Bearer ${TOKEN}}`],
  ["a header line instead of JSON", `Authorization: Bearer ${TOKEN}`],
];
const BAD_VALUES = [
  ...QUOTED_BY_JSON_PARSE,
  ["a missing closing brace", `{"Authorization":"Bearer ${TOKEN}"`],
  ["a trailing comma", `{"Authorization":"Bearer ${TOKEN}",}`],
];

// Every 6-character piece of `text`.
function pieces(text, size = 6) {
  const out = [];
  for (let index = 0; index + size <= text.length; index += 1) {
    out.push(text.slice(index, index + size));
  }
  return out;
}

function assertQuotesNone(error, value, label) {
  assert.equal(error.cause, undefined, label);
  for (const output of [error.message, String(error.stack), inspect(error)]) {
    for (const piece of pieces(value)) {
      assert.ok(!output.includes(piece), `${label}: output quotes ${JSON.stringify(piece)}`);
    }
  }
}

function caught(run) {
  let error;
  assert.throws(run, (thrown) => {
    error = thrown;
    return true;
  });
  return error;
}

test("S-19 item 64 precondition: a plain JSON.parse quotes the synthetic header values", () => {
  for (const [label, value] of QUOTED_BY_JSON_PARSE) {
    const error = caught(() => JSON.parse(value));
    assert.ok(
      pieces(value).some((piece) => error.message.includes(piece)),
      `${label}: ${error.message}`,
    );
  }
});

test("S-19 item 64: a bad AGENC_PROVER_HEADERS_JSON names the variable only", () => {
  for (const [label, value] of BAD_VALUES) {
    const direct = caught(() => parseProverHeadersJson(value));
    assert.equal(
      direct.message,
      "AGENC_PROVER_HEADERS_JSON must be valid JSON (value not shown)",
      label,
    );
    assertQuotesNone(direct, value, label);

    // The runner's entry point, with a synthetic API key set beside it.
    const fromEnv = caught(() =>
      buildRemoteProverConfigFromEnv({
        AGENC_PROVER_ENDPOINT: "https://prover.example.com",
        AGENC_PROVER_API_KEY: TOKEN,
        AGENC_PROVER_HEADERS_JSON: value,
      }),
    );
    assert.equal(fromEnv.message, direct.message, label);
    assertQuotesNone(fromEnv, value, label);
    assertQuotesNone(fromEnv, TOKEN, `${label} (the API key)`);

    // The same parser reads the config file's headers string.
    const fromConfig = caught(() =>
      buildRemoteProverConfig(
        { endpoint: "https://prover.example.com", headers: value },
        {},
      ),
    );
    assert.equal(
      fromConfig.message,
      "scenarioRunner.prover.headers must be valid JSON (value not shown)",
      label,
    );
    assertQuotesNone(fromConfig, value, label);
  }
});

test("S-19 item 64: a valid AGENC_PROVER_HEADERS_JSON still parses", () => {
  assert.deepEqual(
    parseProverHeadersJson(`{"Authorization":"Bearer ${TOKEN}","x-proof-mode":"remote"}`),
    { Authorization: `Bearer ${TOKEN}`, "x-proof-mode": "remote" },
  );
  assert.deepEqual(parseProverHeadersJson(""), {});
  assert.deepEqual(parseProverHeadersJson(undefined), {});
});
