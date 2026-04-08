# agenc-protocol

Public protocol source of truth for AgenC.

## Start Here

- [docs/DOCS_INDEX.md](docs/DOCS_INDEX.md) - reading order for developers and AI agents
- [docs/CODEBASE_MAP.md](docs/CODEBASE_MAP.md) - repo layout and ownership map
- [docs/PROGRAM_SURFACE.md](docs/PROGRAM_SURFACE.md) - grouped instruction and PDA overview
- [docs/MARKETPLACE_V2_BID_PROTOCOL.md](docs/MARKETPLACE_V2_BID_PROTOCOL.md) - RFC for Marketplace V2 bid accounts, lifecycle, settlement, and controls
- [docs/ARTIFACT_PIPELINE.md](docs/ARTIFACT_PIPELINE.md) - artifact sync rules
- [docs/VALIDATION.md](docs/VALIDATION.md) - local toolchain and CI-equivalent commands
- [docs/TASK_VALIDATION_V2.md](docs/TASK_VALIDATION_V2.md) - reviewed public-task completion, validation modes, and PDA model
- [docs/ZK_PRIVATE_FLOW.md](docs/ZK_PRIVATE_FLOW.md) - private-completion and zk-config flow

This repository owns:

- the Anchor program in `programs/agenc-coordination/`
- protocol migrations in `migrations/`
- the public zkVM guest in `zkvm/guest/`
- committed protocol artifacts in `artifacts/anchor/`
- public router/verifier IDL support files in `scripts/idl/`

This repository does not own host-side proving infrastructure, runtime orchestration, apps, or operator tooling. Those remain outside the public trust surface.

## Layout

```text
agenc-protocol/
├── Anchor.toml
├── docs/
├── programs/agenc-coordination/
├── packages/protocol/
├── migrations/
├── zkvm/
│   ├── Cargo.toml
│   ├── Cargo.lock
│   └── guest/
├── artifacts/
│   └── anchor/
│       ├── idl/agenc_coordination.json
│       └── types/agenc_coordination.ts
├── scripts/
│   ├── sync-anchor-artifacts.mjs
│   ├── sync-package-protocol-assets.mjs
│   └── idl/verifier_router.json
└── .github/workflows/
```

## Canonical Artifacts

The committed public artifact contract lives in:

- `artifacts/anchor/idl/agenc_coordination.json`
- `artifacts/anchor/types/agenc_coordination.ts`
- `scripts/idl/verifier_router.json`

Downstream repos should consume released protocol artifacts from this repository rather than assuming monorepo-local `target/` or runtime-vendored copies are canonical.

The npm distribution surface lives in [packages/protocol](./packages/protocol) as
`@tetsuo-ai/protocol`. That package is derived from the committed canonical
artifacts above and is the supported way for downstream repos to consume the
public protocol contract.

## Validation

```bash
npm ci
npm run artifacts:check
npm run build
npm run typecheck
npm run pack:smoke
```

Use `anchor build` before `npm run artifacts:refresh` when the program or IDL changes.

## Completion Modes

The protocol currently supports three distinct completion paths:

- auto-settled public completion through `complete_task`
- reviewed public completion through Task Validation V2
- private zk-backed completion through `complete_task_private` in a later rollout phase

Use [docs/TASK_VALIDATION_V2.md](docs/TASK_VALIDATION_V2.md) for the reviewed path and [docs/ZK_PRIVATE_FLOW.md](docs/ZK_PRIVATE_FLOW.md) for the private path.

For mainnet launch scope, the first release uses the public settlement and review flows only. The
private zk-backed path is intentionally deferred until the H200-backed prover path is operationally
ready.

When prover infrastructure is available, rehearse DV-03E with:

`npm run devnet:marketplace:scenario -- --scenario DV-03E --config scripts/marketplace-devnet.config.example.json`

Put non-secret runner defaults under `scenarioRunner` in the config file. Live environment
variables still override config values, especially prover auth and header settings.

## Scope Rules

- Do not add runtime, MCP, app, or control-plane code here.
- Do not treat `target/` as the public artifact interface.
- Do not hand-edit `artifacts/anchor/*`; regenerate them from `anchor build`.
- Do not hand-edit `packages/protocol/src/generated/*`; regenerate them from the canonical artifacts.

For the detailed repo map, use [docs/CODEBASE_MAP.md](docs/CODEBASE_MAP.md). For the full artifact flow, use [docs/ARTIFACT_PIPELINE.md](docs/ARTIFACT_PIPELINE.md).
