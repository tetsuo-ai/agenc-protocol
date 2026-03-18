# agenc-protocol

Public protocol source of truth for AgenC.

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
├── programs/agenc-coordination/
├── migrations/
├── zkvm/
│   ├── Cargo.toml
│   ├── Cargo.lock
│   └── guest/
├── artifacts/
│   └── anchor/
│       ├── idl/agenc_coordination.json
│       └── types/agenc_coordination.ts
└── scripts/
    ├── sync-anchor-artifacts.mjs
    └── idl/verifier_router.json
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

## Build

```bash
anchor build
```

## Refresh Protocol Artifacts

After a successful `anchor build`, refresh the committed artifact surface:

```bash
npm install
npm run artifacts:refresh
```

To verify that committed artifacts still match the latest local Anchor build:

```bash
npm run artifacts:check
```

## Publishable Artifact Package

Build the publishable protocol package:

```bash
npm install
npm run build
```

Validate pack/install smoke:

```bash
npm run pack:smoke
```

Run the full package validation set:

```bash
npm run validate
```

## Scope Rules

- Do not add runtime, MCP, app, or control-plane code here.
- Do not treat `target/` as the public artifact interface.
- Do not hand-edit `artifacts/anchor/*`; regenerate them from `anchor build`.
- Do not hand-edit `packages/protocol/src/generated/*`; regenerate them from the canonical artifacts.
