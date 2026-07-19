import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    // Programmatic surface (runtime pieces for embedding the worker loop).
    index: "src/index.ts",
    // The CLI entry. Its source carries the `#!/usr/bin/env node` shebang,
    // which tsup preserves so a pinned install can invoke `agenc-worker up`
    // directly without resolving mutable registry state at runtime.
    cli: "src/cli.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  sourcemap: false,
  // The SDK and the kit are deps/peers resolved by the consumer; never inline
  // them into this bundle. litesvm is test-only and must never be bundled.
  external: ["@solana/kit", "@tetsuo-ai/marketplace-sdk", "litesvm"],
});
