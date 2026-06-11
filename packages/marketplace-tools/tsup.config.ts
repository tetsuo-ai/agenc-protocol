import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  sourcemap: false,
  // The SDK and kit codecs are peers/deps resolved by the consumer; never
  // inline them into this bundle.
  external: ["@solana/kit", "@tetsuo-ai/marketplace-sdk"],
});
