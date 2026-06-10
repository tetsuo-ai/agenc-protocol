/**
 * Local marketplace sandbox — `@tetsuo-ai/marketplace-sdk/testing`.
 *
 * Boot the REAL compiled agenc-coordination program in litesvm (the Solana VM,
 * in-process) and drive the full marketplace flow — register, list, moderate,
 * hire, claim, settle — with zero RPC, zero secrets, and no validator, through
 * the exact same `createMarketplaceClient` pipeline production uses.
 *
 * **NODE-ONLY — the sanctioned exception to the browser-safe rule.** The root
 * package barrel (`@tetsuo-ai/marketplace-sdk`) forbids node built-ins; THIS
 * subpath deliberately uses `node:fs` / `node:path` / `node:url` (to load the
 * packaged `.so`) plus the `litesvm` native module, and is shipped as a
 * separate entry so bundlers never pull it into browser builds. Never
 * re-export it from the root barrel.
 *
 * `litesvm` is an **optional peerDependency**: it is imported normally here,
 * so consumers must `npm install litesvm` (devDependency is fine) to use this
 * subpath. Everything else in the package works without it.
 *
 * @example
 * ```ts
 * import { startLocalMarketplace } from "@tetsuo-ai/marketplace-sdk/testing";
 *
 * const market = await startLocalMarketplace();
 * const provider = await market.fundedSigner();
 * const client = market.clientFor(provider);
 * // ...full flow; see startLocalMarketplace docs.
 * ```
 *
 * @module
 */
export {
  DEFAULT_FUNDING_LAMPORTS,
  DEFAULT_UNIX_TIMESTAMP,
  startLocalMarketplace,
  type LocalMarketplace,
  type LocalModerator,
  type StartLocalMarketplaceOptions,
} from "./local-marketplace.js";
export { createLiteSvmTransport } from "./litesvm-transport.js";
export {
  seedModerationConfig,
  seedProtocolConfig,
  type SeedProtocolConfigOptions,
} from "./seed.js";
export {
  resolveTestingProgramSo,
  TESTING_PROGRAM_SO_FILENAME,
} from "./program-asset.js";
