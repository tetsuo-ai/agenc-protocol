# Changelog

All notable changes to `@tetsuo-ai/marketplace-tools` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.0

### Minor Changes

- Add the keyless `prepare_register_agent` tool — the one-time `register_agent`
  onboarding step (agentId, capabilities, endpoint, metadataUri, stakeAmount) that
  was previously missing, so agents on the open packages can build their own
  `AgentRegistration` before hiring, claiming, listing, or completing work. This
  brings the prepare surface to 13 tools (19 total with mutations enabled).

  Also clarify the MCP read-transport guidance (set `AGENC_INDEXER_URL` /
  `AGENC_RPC_URL` so a fresh `npx` boot does not silently throttle on the public
  RPC's rate-limited `getProgramAccounts`) and document the hosted-connector
  posture: run remote/HTTP connectors readonly; local `stdio` MCP + CLI is the
  keyless write (unsigned-`prepare_*`) path.

- 68df233: Add keyless prepare support for service-listing creation and registered-hire referrer arguments.

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
