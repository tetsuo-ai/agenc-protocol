import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["test/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    exclude: [
      // Playwright-runner suites: they import @playwright/test (installed
      // only in the nested test/playwright workspace), so a clean root
      // install must not pull them into the vitest run.
      "test/playwright/**",
      "**/node_modules/**",
      "dist/**",
    ],
  },
});
