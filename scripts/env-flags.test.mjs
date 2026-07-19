import assert from "node:assert/strict";
import test from "node:test";

import { parseBinaryEnvFlag } from "./env-flags.mjs";

test("binary environment flags accept only unset, 0, and 1", () => {
  assert.equal(parseBinaryEnvFlag({}, "SKIP"), false);
  assert.equal(parseBinaryEnvFlag({ SKIP: "0" }, "SKIP"), false);
  assert.equal(parseBinaryEnvFlag({ SKIP: "1" }, "SKIP"), true);

  for (const value of ["", "false", "true", " 0", "1 ", "2", "yes"]) {
    assert.throws(
      () => parseBinaryEnvFlag({ SKIP: value }, "SKIP"),
      /must be unset, "0", or "1"/,
    );
  }
});

test("skip flags share identical parsing semantics", () => {
  for (const name of ["SKIP_BID_MARKETPLACE", "SKIP_MODERATION"]) {
    assert.equal(parseBinaryEnvFlag({ [name]: "0" }, name), false);
    assert.equal(parseBinaryEnvFlag({ [name]: "1" }, name), true);
    assert.throws(() => parseBinaryEnvFlag({ [name]: "false" }, name));
  }
});
