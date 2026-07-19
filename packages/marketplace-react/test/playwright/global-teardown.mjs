/**
 * Playwright global teardown — stop the sandbox validator started by
 * global-setup. Safe when nothing is running. Set AGENC_KEEP_SANDBOX=1 to leave
 * the validator up (e.g. to re-run the spec quickly during development).
 */
import { stop } from "../sandbox-up.mjs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKOUT_PUBLIC = path.resolve(
  HERE,
  "../../test-apps/checkout/public/sandbox-config.json",
);
const CONTEXT_FILE = path.join(HERE, ".playwright-sandbox.json");

export default async function globalTeardown() {
  if (process.env.AGENC_KEEP_SANDBOX === "1") {
    console.log(
      "global-teardown: AGENC_KEEP_SANDBOX=1 — leaving the sandbox up.",
    );
    return;
  }
  await stop({ purge: true, removeState: true, quiet: true });
  await Promise.all([
    rm(CHECKOUT_PUBLIC, { force: true }),
    rm(CONTEXT_FILE, { force: true }),
  ]);
}
