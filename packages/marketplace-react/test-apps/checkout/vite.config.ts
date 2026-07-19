import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The checkout fixture is a plain Vite + React SPA. The workspace packages are
// `file:`-linked; Vite pre-bundles their ESM dist. `sandbox-config.json` is
// served from `public/` (written by the Playwright global-setup at run time).
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      // Model a production checkout entry point with independently cacheable
      // framework, chain-runtime, and AgenC chunks instead of one 572 kB file.
      output: {
        manualChunks(id) {
          const normalized = id.replaceAll("\\", "/");
          if (
            normalized.includes("/node_modules/react/") ||
            normalized.includes("/node_modules/react-dom/") ||
            normalized.includes("/node_modules/scheduler/") ||
            normalized.includes("/node_modules/@tanstack/")
          ) {
            return "react-vendor";
          }
          if (
            normalized.includes("/node_modules/@solana/") ||
            normalized.includes("/node_modules/@noble/") ||
            normalized.includes("/node_modules/@scure/") ||
            normalized.includes("/node_modules/base-x/") ||
            normalized.includes("/node_modules/bs58/")
          ) {
            return "solana-vendor";
          }
          if (
            normalized.includes("/packages/sdk-ts/dist/") ||
            normalized.includes("/packages/marketplace-react/dist/")
          ) {
            return "agenc-vendor";
          }
          return undefined;
        },
      },
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
  server: { port: 3200, strictPort: true },
  preview: { port: 3200, strictPort: true },
  resolve: {
    // Deduplicate React AND the marketplace package so the provider (imported
    // from the package root) and the hooks (imported from the "/hooks" subpath)
    // resolve to ONE AgencContext module instance. Without this, Vite's dep
    // pre-bundling can split root vs. subpath into separate optimized chunks,
    // each with its own context -> "useAgencContext must be used within
    // <AgencProvider>" even though both are under the provider.
    dedupe: [
      "react",
      "react-dom",
      "@tetsuo-ai/marketplace-react",
      "@tetsuo-ai/marketplace-sdk",
      "@tanstack/react-query",
    ],
  },
  optimizeDeps: {
    // Do NOT pre-bundle the workspace package; let Vite serve its ESM dist as a
    // single module graph so the root entry and the "/hooks"/"/components"
    // subpaths share the same internal modules (one AgencContext).
    exclude: ["@tetsuo-ai/marketplace-react"],
    include: ["@tetsuo-ai/marketplace-sdk"],
  },
});
