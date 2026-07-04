import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    // Programmatic surface (runtime pieces for embedding the worker loop).
    index: "src/index.ts",
    // The npx-able CLI entry. Its source carries the `#!/usr/bin/env node`
    // shebang, which tsup preserves on the emitted `./dist/cli.js` so
    // `npx @tetsuo-ai/agenc-worker up` boots the worker directly.
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
