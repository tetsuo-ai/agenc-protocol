import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKOUT_APP = path.resolve(HERE, "../../test-apps/checkout");
const PORT = 3200;

/**
 * Playwright config for the A3 checkout browser e2e.
 *
 * - globalSetup boots the sandbox + writes the checkout app's runtime config;
 *   globalTeardown stops the validator.
 * - webServer builds + serves the checkout SPA (Vite preview) on :3200.
 * - One Chromium project. In CI/sandbox the browser binary comes from the
 *   Playwright browser cache; set PLAYWRIGHT_CHROMIUM_EXECUTABLE to pin a
 *   specific chromium when the managed download is unavailable.
 *
 * The single spec drives the checkout through a REAL hire funded -> accepted
 * against the sandbox validator (the worker side runs in the test process via
 * the worker harness).
 */
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;

export default defineConfig({
  testDir: HERE,
  testMatch: /.*\.spec\.ts$/,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: path.join(HERE, "global-setup.mjs"),
  globalTeardown: path.join(HERE, "global-teardown.mjs"),
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    ...(chromiumExecutable
      ? { launchOptions: { executablePath: chromiumExecutable } }
      : {}),
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Serve the SPA with `vite dev` so `public/sandbox-config.json` (written by
    // globalSetup BEFORE this server starts) is read LIVE on each request — a
    // `build && preview` would bake whatever config existed at build time into
    // dist/, racing globalSetup's write. `reuseExistingServer: false` guarantees
    // we never serve a stale dev server from a prior run.
    command: "npm run dev",
    cwd: CHECKOUT_APP,
    url: `http://127.0.0.1:${PORT}/`,
    timeout: 180_000,
    reuseExistingServer: false,
  },
});
