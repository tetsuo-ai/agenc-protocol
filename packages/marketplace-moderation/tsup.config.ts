import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  sourcemap: false,
  // Zero runtime dependencies: the only import is Node's built-in `node:crypto`.
});
