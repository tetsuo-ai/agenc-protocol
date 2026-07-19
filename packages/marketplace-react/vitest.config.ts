import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["test/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    exclude: [
      "test/playwright/ssr-smoke.test.ts",
      "**/node_modules/**",
      "dist/**",
    ],
  },
});
