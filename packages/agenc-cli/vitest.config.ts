import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests-e2e/**/*.test.ts"],
    environment: "node",
    // The litesvm e2e drives the full hire -> claim -> submit -> accept loop
    // against the real compiled program; give it headroom on cold machines.
    testTimeout: 120_000,
  },
});
