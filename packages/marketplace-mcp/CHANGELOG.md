# Changelog

All notable changes to `@tetsuo-ai/marketplace-mcp` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.3.0

### Minor Changes (breaking against pre-A1 programs)

- Rebuild on `@tetsuo-ai/marketplace-sdk@^0.7.0` +
  `@tetsuo-ai/marketplace-tools@^0.3.0` (WP-A1 roster-gate IDL) so the
  `prepare_*` tools emit instructions the upgraded mainnet program accepts
  (the 2026-07-02 upgrade added the optional `moderation_attestor` account to
  the three moderation consumption gates). 0.2.0 prepares are rejected
  fail-closed by the deployed program. The 13-prepare-tool surface (19 total
  with mutations enabled) and the readonly-by-default posture are unchanged.

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

### Patch Changes

- Updated dependencies
- Updated dependencies [68df233]
  - @tetsuo-ai/marketplace-tools@0.2.0

## [0.1.0] - 2026-06-10

### Added

- Initial release: an open-source, **npx-able** Model Context Protocol server for the
  AgenC marketplace (PLAN.md P5.1). `npx @tetsuo-ai/marketplace-mcp` boots a stdio MCP
  server.
- **Readonly by default.** Exposes the discovery/inspection/track-record tools from
  `@tetsuo-ai/marketplace-tools`: `list_listings`, `get_listing`, `list_open_tasks`,
  `get_task`, `get_agent_track_record`, `search`.
- **Keyless mutation opt-in.** With `AGENC_MCP_ENABLE_MUTATIONS=1` the server also
  exposes the `prepare_hire` / `prepare_claim` / `prepare_submit` tools, which BUILD an
  **unsigned** transaction and return it. The server holds no key, signs nothing, and
  broadcasts nothing — the caller signs the artifact with their own signer behind their
  own policy gate (mirroring the AgenC kit's signer-local, policy-gated philosophy).
- **Environment seam** (`resolveMcpConfig`): the read transport
  (`AGENC_RPC_URL` / `AGENC_MARKETPLACE_CLUSTER` / `AGENC_INDEXER_URL` /
  `AGENC_INDEXER_API_KEY` / `AGENC_PROGRAM_ADDRESS`) and the mutation opt-in
  (`AGENC_MCP_ENABLE_MUTATIONS`) are resolved from the process environment.
- **Programmatic API**: `createMarketplaceMcpServer`, `buildToolContext`,
  `resolveMcpConfig`, `selectTools` — build/embed the server in-process with an injected
  tool context.
- **Examples** (runnable against the local stack, `node examples/<name>.mts`):
  - `worker-bot.mts` — uses the SDK's `watchClaimableTasks` to claim a fresh task within
    milliseconds of creation, with no hand-tuned poll loop (PLAN.md P5.3).
  - `langchain-agent.mts` — a LangChain-style agent that browses listings and PREPARES
    (never signs) a hire using only the public packages (PLAN.md P5.2).
- ESM + CJS + `.d.ts` builds via tsup; vitest test suite (server registers the expected
  tools, readonly tools resolve real local-stack accounts, mutations are absent unless
  the opt-in is set, and a prepare tool returns an unsigned tx); TypeDoc-ready.

### Notes

- Built entirely on the **public** `@tetsuo-ai/marketplace-sdk` + the public
  `@tetsuo-ai/marketplace-tools` registry. No proprietary kit code; MIT-licensed.
- The server is the discovery/build surface only — it never holds funds or keys.
