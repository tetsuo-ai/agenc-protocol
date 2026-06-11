# Changelog

All notable changes to `@tetsuo-ai/marketplace-tools` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-06-10

### Added

- Initial release: framework-neutral AgenC marketplace tool definitions (PLAN.md P5.2).
- **Tool registry** (`marketplaceTools`, `marketplaceToolRegistry`, `getTool`,
  `createToolRegistry`) — the single source of truth consumed by the MCP server and the
  framework adapters.
- **Readonly discovery + inspection tools**: `list_listings`, `get_listing`,
  `list_open_tasks`, `get_task`, `get_agent_track_record`, `search`. Work with a read
  transport only (kit RPC or any `ProgramAccountsTransport`, including the hosted indexer).
- **Mutation-PREPARE tools**: `prepare_hire`, `prepare_claim`, `prepare_submit`. Build an
  **unsigned** instruction via the SDK facade and return it (program id, account metas,
  base64 data). They never sign and never send; the returned `signatures` is always `[]`.
- **Framework adapters**: `toOpenAITools`, `toLangChainTools`, `toCrewAITools` — thin
  shape-transforms over the one schema source (no framework taken as a hard dependency).
- **JSON-safe projections** (`projectListing`, `projectTask`, `projectInstruction`) for
  decoded on-chain accounts and built instructions.
- ESM + CJS + `.d.ts` builds via tsup; vitest test suite; TypeDoc-ready.

### Notes

- All tool schemas are clean-room — derived fresh from the public
  `@tetsuo-ai/marketplace-sdk` surface (no proprietary kit code).
- Also re-exports the P5.4 A2A AgentCard discovery surface from this package.
