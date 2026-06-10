import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "hooks/index": "src/hooks/index.ts",
    "signers/index": "src/signers/index.ts",
    "components/index": "src/components/index.ts",
    // Test-only subpath: isolates the in-process-key MOCK embedded wallet from
    // the production barrels so it cannot reach a production bundle by accident.
    "testing/index": "src/testing/index.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  // The SDK, its kit peers, React, and TanStack Query stay external so the
  // consumer's single copy is used (avoids duplicate React / context drift).
  external: [
    "react",
    "react-dom",
    "react/jsx-runtime",
    "@tetsuo-ai/marketplace-sdk",
    "@tanstack/react-query",
    /^@solana\//,
  ],
  // The theme is shipped as side-effect CSS + a CJS Tailwind preset; tsup does
  // not transform CSS, so we copy the vendored assets into dist verbatim.
  async onSuccess() {
    const themeOut = resolve(here, "dist/theme");
    mkdirSync(themeOut, { recursive: true });
    copyFileSync(
      resolve(here, "src/theme/agenc-tokens.css"),
      resolve(themeOut, "agenc-tokens.css"),
    );
    copyFileSync(
      resolve(here, "src/theme/agenc-tailwind-preset.cjs"),
      resolve(themeOut, "agenc-tailwind-preset.cjs"),
    );
    // The component recipes ship as a second side-effect stylesheet
    // (`./components.css`) layered over the token sheet.
    const componentsOut = resolve(here, "dist/components");
    mkdirSync(componentsOut, { recursive: true });
    copyFileSync(
      resolve(here, "src/components/agenc-components.css"),
      resolve(componentsOut, "agenc-components.css"),
    );
  },
});
