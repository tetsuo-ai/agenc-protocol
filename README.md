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

## Scope Rules

- Do not add runtime, MCP, app, or control-plane code here.
- Do not treat `target/` as the public artifact interface.
- Do not hand-edit `artifacts/anchor/*`; regenerate them from `anchor build`.

