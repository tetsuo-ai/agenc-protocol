import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NEXT_APP = path.resolve(HERE, "../../test-apps/next-ssr");
const PORT = 3100;

/**
 * Deterministic PR smoke for the static Next fixture. Unlike the full checkout
 * config, this does not boot a validator or handle wallet secrets. The Next app
 * reads its committed account fixture, so a real Chromium hydration check can
 * run on every pull request after a clean install.
 */
export default defineConfig({
  testDir: HERE,
  testMatch: "ssr-smoke.test.ts",
  timeout: 45_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run start",
    cwd: NEXT_APP,
    env: { NEXT_TELEMETRY_DISABLED: "1" },
    url: `http://127.0.0.1:${PORT}/`,
    timeout: 60_000,
    reuseExistingServer: false,
  },
});
