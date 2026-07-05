import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    // Programmatic surface (detection, init planning, the dev bot loop core,
    // split formatting, and the promote checklist — all embeddable).
    index: "src/index.ts",
    // The npx-able CLI entry. Its source carries the `#!/usr/bin/env node`
    // shebang, which tsup preserves on the emitted `./dist/cli.js` so
    // `npx @tetsuo-ai/agenc-cli init` runs directly.
    cli: "src/cli.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  sourcemap: false,
  // The SDK/worker runtime are deps resolved at install time; never inline
  // them into this bundle. The sdk regex also keeps its subpaths external
  // (`@tetsuo-ai/marketplace-sdk/testing` powers the in-process dev
  // sandbox). litesvm is a native module and must never be bundled.
  external: [
    "@solana/kit",
    /^@tetsuo-ai\/marketplace-sdk(\/.*)?$/,
    "@tetsuo-ai/agenc-worker",
    "litesvm",
  ],
});
