# Changelog

All notable changes to `@tetsuo-ai/marketplace-tools` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.4.0

### Minor Changes (breaking — the P1.2 open-roster flag-day cutover)

- Rebuild on `@tetsuo-ai/marketplace-sdk@^0.8.0` (90-instruction P1.2
  surface). The three gate tools change contract:
  `prepare_set_task_job_spec`, `prepare_hire`, and `prepare_hire_humanless`
  now REQUIRE a `moderator` input (base58 — the pubkey whose moderation
  attestation the gate consumes; get it from your attestation service, e.g.
  attest.agenc.ag `GET /v1/info` → `moderator`) and accept an optional
  `moderatorIsAttestor` boolean that attaches the
  `["moderation_attestor", moderator]` roster entry for registered attestors
  (unset = the global-authority path, roster slot passed as None).
- `listingSpecHash` is now REQUIRED on both hire tools — it derives the
  mandatory `moderation_block` BLOCK-floor account.
- `prepare_set_task_job_spec` accepts an optional `taskModeration` override
  and `prepare_hire` re-documents `listingModeration` as the legacy
  grace-window escape hatch for pre-upgrade records
  (`facade.findLegacyTaskModerationPda` / `findLegacyListingModerationPda`).
- Shape pins updated: set_task_job_spec 8→9 accounts, hire_from_listing
  13→14, hire_from_listing_humanless 12→13; new revert-sensitive pins for the
  encoded `moderator` arg and the roster/None slot.

## 0.3.0

### Minor Changes (breaking against pre-A1 programs)

- Rebuild on `@tetsuo-ai/marketplace-sdk@^0.7.0` (WP-A1 roster-gate IDL) so
  prepared instructions match the mainnet program as upgraded 2026-07-02:
  `prepare_set_task_job_spec` and the hire prepares now emit the optional
  `moderation_attestor` account (the gates are 8/13/12 accounts). 0.2.0
  (sdk 0.6.x) instructions are rejected fail-closed by the upgraded program —
  all consumers should move to 0.3.0. The 13-prepare-tool surface (19 total
  with mutations enabled) is unchanged.

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

  `prepare_register_agent` also guards the one fixed on-chain invariant it can
  cheaply catch: it rejects a `capabilities` of `0` up-front with
  `INVALID_CAPABILITIES` (`register_agent` enforces `capabilities != 0`), so a
  doomed instruction never reaches signing. Its schema now also documents that
  `stakeAmount` must meet the deployment's `config.min_agent_stake` (mainnet
  default `1_000_000` lamports), which the keyless builder cannot read and so
  does not guard.

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
