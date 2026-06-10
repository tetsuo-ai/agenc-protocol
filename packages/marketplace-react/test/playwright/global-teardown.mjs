/**
 * Playwright global teardown — stop the sandbox validator started by
 * global-setup. Safe when nothing is running. Set AGENC_KEEP_SANDBOX=1 to leave
 * the validator up (e.g. to re-run the spec quickly during development).
 */
import { stop } from "../sandbox-up.mjs";

export default async function globalTeardown() {
  if (process.env.AGENC_KEEP_SANDBOX === "1") {
    console.log("global-teardown: AGENC_KEEP_SANDBOX=1 — leaving the sandbox up.");
    return;
  }
  await stop({ quiet: true });
}
