import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["test/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    exclude: [
      "test/playwright/ssr-smoke.test.ts",
      // Imports @playwright/test (installed only in the nested
      // test/playwright workspace), so a clean root install must not pull it
      // into the vitest run. checkout.e2e.test.tsx stays includable: it is a
      // plain vitest suite that `test:localnet` targets explicitly and which
      // self-skips without AGENC_REACT_LOCALNET_E2E=1.
      "test/playwright/server-binding.test.ts",
      "**/node_modules/**",
      "dist/**",
    ],
  },
});
