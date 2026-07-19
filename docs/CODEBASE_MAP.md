# Protocol Codebase Map

This file maps the full `agenc-protocol` repo for developers and AI agents.

## Top-Level Layout

```text
agenc-protocol/
  programs/agenc-coordination/   Anchor source (97 prod / 100 private-ZK / 25 canary)
  artifacts/anchor/              committed canonical IDL, types, and manifest
  packages/
    protocol/                    @tetsuo-ai/protocol — published IDL/types
    sdk-ts/                      @tetsuo-ai/marketplace-sdk — kit client + facade
    marketplace-react/           @tetsuo-ai/marketplace-react — React embed kit
    marketplace-tools/           @tetsuo-ai/marketplace-tools — agent tool adapters
    marketplace-mcp/             @tetsuo-ai/marketplace-mcp — MCP server
    marketplace-moderation/      @tetsuo-ai/marketplace-moderation — moderation canon
    agenc-cli/                   @tetsuo-ai/agenc-cli — init/dev/promote
    agenc-cli-alias/             thin `agenc` bin alias
    agenc-worker/                @tetsuo-ai/agenc-worker — claim/submit loop
  tests-integration/             litesvm integration tests (real .so)
  migrations/                    migration notes and helpers
  scripts/                       artifact sync, canary, localnet, mainnet, readiness
  zkvm/guest/                    public zkVM journal helper crate
  docs/                          repo-level developer docs (start: DOCS_INDEX.md)
  .github/workflows/             CI automation
  README.md
  package.json
  Anchor.toml
```

## Path Ownership

### Program surface

- `programs/agenc-coordination/src/lib.rs` - instruction entrypoints (full + canary modules)
- `programs/agenc-coordination/src/state.rs` - PDA/account model and version constants
- `programs/agenc-coordination/src/events.rs` - emitted events
- `programs/agenc-coordination/src/errors.rs` - protocol error codes
- `programs/agenc-coordination/src/instructions/` - instruction handlers and helpers
- `programs/agenc-coordination/src/utils/` - shared utilities
- `programs/agenc-coordination/fuzz/` - active model/property regression harness (76 tests)

### Canonical artifacts

- `artifacts/anchor/idl/agenc_coordination.json` (**97** production-candidate instructions)
- `artifacts/anchor/types/agenc_coordination.ts`
- `artifacts/anchor/manifest.json`
- `scripts/idl/verifier_router.json`
- Generated human reference: `docs/reference/INSTRUCTIONS.md`, `docs/reference/ERRORS.md`

### Published packages

| Package | Path | Role |
|---------|------|------|
| `@tetsuo-ai/protocol` | `packages/protocol` | IDL + types npm contract |
| `@tetsuo-ai/marketplace-sdk` | `packages/sdk-ts` | Codama client + facade + indexer |
| `@tetsuo-ai/marketplace-react` | `packages/marketplace-react` | React hooks/components |
| `@tetsuo-ai/marketplace-tools` | `packages/marketplace-tools` | prepare/discovery + AgentCard |
| `@tetsuo-ai/marketplace-mcp` | `packages/marketplace-mcp` | MCP tool server |
| `@tetsuo-ai/marketplace-moderation` | `packages/marketplace-moderation` | moderation canon |
| `@tetsuo-ai/agenc-cli` | `packages/agenc-cli` | developer CLI |
| `agenc-cli` (alias) | `packages/agenc-cli-alias` | `npx agenc` alias |
| `@tetsuo-ai/agenc-worker` | `packages/agenc-worker` | worker runtime |

Support matrix: [VERSIONING.md](./VERSIONING.md).

### Migration and zk surfaces

- `migrations/` - migration notes and helpers (live layout migrations live in
  `programs/.../instructions/migrate.rs`)
- `zkvm/guest/src/lib.rs` - canonical journal field layout for private completion

### Automation (selected)

- `scripts/sync-anchor-artifacts.mjs` - `target/` → committed artifact sync
- `scripts/sync-package-protocol-assets.mjs` - committed artifacts → protocol package
- `scripts/generate-idl-reference.mjs` / `check-idl-reference.mjs` - docs drift gate
- `scripts/localnet-up.mjs` / `localnet-down.mjs` / `localnet-status.mjs`
- `scripts/mainnet-*.mjs` / `scripts/credible-exit.mjs`
- `scripts/marketplace-devnet-*.mjs` / `validation-*.mjs`
- `packages/sdk-ts` scripts: `sdk:generate`, `sdk:drift`, testing-asset sync
- `.github/workflows/ci.yml` - formatting, artifact verification, package gates
- `.github/workflows/sdk.yml` - SDK drift / tests
- `.github/workflows/verify.yml` - verifiable builds on `protocol-v*` tags

## Ownership Boundaries

- This repo owns the public protocol source of truth **and** the published
  marketplace TypeScript packages listed above.
- Product apps (agenc.ag storefront, hosted control planes) and host-side
  proving infrastructure (`agenc-prover`) live outside this repo.
- Historical sibling names (`agenc-sdk`, `agenc-core`) may still appear in older
  plans; the monorepo packages under `packages/*` are the current consumer
  surface.

## Start Here By Change Type

- New instruction or PDA change: `programs/agenc-coordination/src/` and [PROGRAM_SURFACE.md](./PROGRAM_SURFACE.md)
- IDL or package artifact change: [ARTIFACT_PIPELINE.md](./ARTIFACT_PIPELINE.md)
- Surface versioning / npm pins: [VERSIONS.md](./VERSIONS.md) + [VERSIONING.md](./VERSIONING.md)
- Mainnet deploy state: [MAINNET_MAINLINE.md](./MAINNET_MAINLINE.md)
- ZK or private-completion change: [ZK_PRIVATE_FLOW.md](./ZK_PRIVATE_FLOW.md)
- CI/toolchain change: [VALIDATION.md](./VALIDATION.md)
