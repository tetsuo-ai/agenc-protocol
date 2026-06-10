/**
 * Next.js 15 config for the SSR fixture.
 *
 * `transpilePackages` is set for the workspace packages so the App Router
 * compiles the ESM source/dist of `@tetsuo-ai/marketplace-react` and the SDK
 * cleanly (they ship ESM + `.d.ts`; transpiling avoids dual-package edge cases
 * under the Next compiler).
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    "@tetsuo-ai/marketplace-react",
    "@tetsuo-ai/marketplace-sdk",
  ],
  // This fixture lives inside a multi-package repo with several lockfiles; pin
  // the trace root to this app so Next does not infer the workspace root (and
  // does not emit the "multiple lockfiles" warning).
  outputFileTracingRoot: here,
};

export default nextConfig;
