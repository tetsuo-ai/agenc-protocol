# Changelog

All notable changes to `@tetsuo-ai/marketplace-mcp` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
