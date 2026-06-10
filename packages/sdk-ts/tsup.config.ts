import { defineConfig } from "tsup";

export default defineConfig({
  // testing/ and sandbox/ are separate subpath entries: testing is node-only
  // (litesvm native module + filesystem .so loading) and must not be pulled
  // into the browser-safe root bundle.
  entry: {
    index: "src/index.ts",
    "testing/index": "src/testing/index.ts",
    "sandbox/index": "src/sandbox/index.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  sourcemap: false,
  external: ["@solana/kit", "@solana/program-client-core", "litesvm"],
});
