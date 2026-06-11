import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    // litesvm-backed e2e (worker-bot harness) can take a few seconds to boot.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
