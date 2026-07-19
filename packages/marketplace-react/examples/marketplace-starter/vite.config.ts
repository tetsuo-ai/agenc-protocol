import { existsSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

function localPath(path: string): string {
  return fileURLToPath(new URL(path, import.meta.url));
}

export default defineConfig({
  build: {
    rollupOptions: {
      onwarn(warning, warn) {
        const normalized = warning.id?.replaceAll("\\", "/") ?? "";
        if (
          warning.code === "MODULE_LEVEL_DIRECTIVE" &&
          warning.message.includes('"use client"') &&
          normalized.includes("/node_modules/@tanstack/react-query/")
        ) {
          // This is a client-only SPA; the exact code/path guard leaves every
          // unrelated Rollup warning visible.
          return;
        }
        warn(warning);
      },
    },
  },
  resolve: {
    alias: hasLocalPackageSource()
      ? [
          {
            find: /^react$/,
            replacement: localPath("../../../../node_modules/react/index.js"),
          },
          {
            find: /^react\/jsx-runtime$/,
            replacement: localPath(
              "../../../../node_modules/react/jsx-runtime.js",
            ),
          },
          {
            find: /^react-dom$/,
            replacement: localPath(
              "../../../../node_modules/react-dom/index.js",
            ),
          },
          {
            find: /^react-dom\/client$/,
            replacement: localPath(
              "../../../../node_modules/react-dom/client.js",
            ),
          },
          {
            find: "@tetsuo-ai/marketplace-react/theme.css",
            replacement: localPath("../../src/theme/agenc-tokens.css"),
          },
          {
            find: "@tetsuo-ai/marketplace-react/components.css",
            replacement: localPath("../../src/components/agenc-components.css"),
          },
          {
            find: "@tetsuo-ai/marketplace-react/hooks",
            replacement: localPath("../../src/hooks/index.ts"),
          },
          {
            find: "@tetsuo-ai/marketplace-react/signers",
            replacement: localPath("../../src/signers/index.ts"),
          },
          {
            find: "@tetsuo-ai/marketplace-react",
            replacement: localPath("../../src/index.ts"),
          },
          {
            find: "@tetsuo-ai/marketplace-sdk",
            replacement: localPath("../../../sdk-ts/src/index.ts"),
          },
        ]
      : [],
  },
});

function hasLocalPackageSource(): boolean {
  return (
    existsSync(localPath("../../src/index.ts")) &&
    existsSync(localPath("../../../sdk-ts/src/index.ts"))
  );
}
