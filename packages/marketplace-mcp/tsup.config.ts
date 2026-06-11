import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    // The npx-able CLI entry. Its source carries the `#!/usr/bin/env node`
    // shebang, which tsup preserves on the emitted `./dist/bin.js` so
    // `npx @tetsuo-ai/marketplace-mcp` boots the stdio MCP server directly.
    bin: "src/bin.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  sourcemap: false,
  // The SDK, the tools registry, the kit codecs, and the MCP SDK are
  // deps/peers resolved by the consumer; never inline them into this bundle.
  external: [
    "@solana/kit",
    "@tetsuo-ai/marketplace-sdk",
    "@tetsuo-ai/marketplace-tools",
    "@modelcontextprotocol/sdk",
  ],
});
