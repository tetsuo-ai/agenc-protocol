import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertProductionSbf,
  FORBIDDEN_PROFILE_MARKERS,
  getIdlInstructionLogNames,
  PRODUCTION_PROFILE_MARKER,
} from "./sbf-profile.mjs";

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const source = path.resolve(
  packageDir,
  "../../programs/agenc-coordination/target/deploy/agenc_coordination.so",
);
const idlPath = path.resolve(
  packageDir,
  "../../artifacts/anchor/idl/agenc_coordination.json",
);
const productionSbf = readFileSync(source);
const expectedInstructionNames = getIdlInstructionLogNames(
  JSON.parse(readFileSync(idlPath, "utf8")),
);
const options = { expectedInstructionNames, sourceLabel: "test SBF" };

function replaceBytes(bytes, from, to) {
  assert.equal(
    from.length,
    to.length,
    "test replacement must preserve ELF size",
  );
  const copy = Buffer.from(bytes);
  const offset = copy.indexOf(Buffer.from(from));
  assert.notEqual(offset, -1, `fixture must contain ${from}`);
  copy.set(Buffer.from(to), offset);
  return copy;
}

function injectForbiddenMarker(marker) {
  const victim = expectedInstructionNames
    .map((name) => `Instruction: ${name}`)
    .find((candidate) => candidate.length >= marker.length);
  assert.ok(
    victim,
    `fixture needs a marker at least ${marker.length} bytes long`,
  );
  return replaceBytes(productionSbf, victim, marker.padEnd(victim.length, "_"));
}

test("accepts the current full default-production SBF and complete IDL surface", () => {
  assert.doesNotThrow(() => assertProductionSbf(productionSbf, options));
});

test("rejects marker text that is not a structurally valid SBF ELF", () => {
  const bytes = Buffer.from(
    [PRODUCTION_PROFILE_MARKER, ...expectedInstructionNames].join("\0"),
  );
  assert.throws(() => assertProductionSbf(bytes, options), /ELF64/u);
});

test("rejects truncated or trailing ELF data", () => {
  assert.throws(
    () => assertProductionSbf(productionSbf.subarray(0, -1), options),
    /section-header table|incomplete ELF data/u,
  );
  assert.throws(
    () =>
      assertProductionSbf(
        Buffer.concat([productionSbf, Buffer.of(0)]),
        options,
      ),
    /trailing or incomplete ELF data/u,
  );
});

test("rejects a structurally intact ELF missing one reviewed instruction", () => {
  const marker = `Instruction: ${expectedInstructionNames.at(-1)}`;
  const replacement = "_".repeat(marker.length);
  assert.throws(
    () =>
      assertProductionSbf(
        replaceBytes(productionSbf, marker, replacement),
        options,
      ),
    new RegExp(marker),
  );
});

test("rejects every unsupported development build marker", () => {
  for (const marker of FORBIDDEN_PROFILE_MARKERS) {
    const bytes = marker.startsWith("AGENC_SBF_PROFILE=")
      ? replaceBytes(productionSbf, PRODUCTION_PROFILE_MARKER, marker)
      : injectForbiddenMarker(marker);
    assert.throws(
      () => assertProductionSbf(bytes, options),
      new RegExp(marker),
      marker,
    );
  }
});
