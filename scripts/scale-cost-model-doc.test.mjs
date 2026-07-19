import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const CONSTANTS_PATH = new URL(
  "../programs/agenc-coordination/src/instructions/constants.rs",
  import.meta.url,
);
const SCALE_MODEL_PATH = new URL(
  "../docs/SCALE_COST_MODEL.md",
  import.meta.url,
);

test("scale model documents the shipped dispute-safe worker invariant", async () => {
  const [constants, scaleModel] = await Promise.all([
    readFile(CONSTANTS_PATH, "utf8"),
    readFile(SCALE_MODEL_PATH, "utf8"),
  ]);

  const capMatch = constants.match(
    /pub const DISPUTE_SAFE_MAX_WORKERS:\s*u8\s*=\s*(\d+);/,
  );
  assert.ok(capMatch, "DISPUTE_SAFE_MAX_WORKERS declaration is missing");

  const workerCap = Number(capMatch[1]);
  assert.equal(workerCap, 4, "the shipped dispute-safe worker cap changed");
  assert.match(
    scaleModel,
    new RegExp(`DISPUTE_SAFE_MAX_WORKERS\\s*=\\s*${workerCap}`),
    "scale model must name the current code invariant and its value",
  );
  assert.match(
    scaleModel,
    /F2[^]*?SHIPPED[^]*?four-worker invariant[^]*?(?=\n- \*\*F3)/,
    "F2 must be marked shipped and describe the four-worker invariant",
  );

  for (const staleStatement of [
    "and `max_workers` may be up to **100**",
    "**R2: bound it explicitly**",
    "adopt R1/R2 as",
  ]) {
    assert.equal(
      scaleModel.includes(staleStatement),
      false,
      `scale model still contains stale remediation text: ${staleStatement}`,
    );
  }
});
