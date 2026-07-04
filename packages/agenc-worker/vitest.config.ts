import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests-e2e/**/*.test.ts"],
    environment: "node",
  },
});
