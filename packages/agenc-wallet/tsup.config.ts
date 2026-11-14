import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    // The wallet itself plus the socket server.
    index: "src/index.ts",
    // The dependency-free client: types, socket client, agent tools.
    "client/index": "src/client/index.ts",
    // `agenc-wallet serve|status`. Its source carries the node shebang.
    cli: "src/cli.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  sourcemap: false,
  // Resolved by the consumer; never inline. litesvm is an optional native
  // module used only by the sandbox.
  external: [
    "@solana/kit",
    "@tetsuo-ai/marketplace-sdk",
    "@tetsuo-ai/agenc-worker",
    "litesvm",
  ],
});
