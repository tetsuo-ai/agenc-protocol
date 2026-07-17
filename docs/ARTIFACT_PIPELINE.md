# Artifact Pipeline

This file describes how protocol artifacts move from local build output to committed and published surfaces.

## Canonical Flow

```text
anchor build
  -> local target/ output
  -> scripts/sync-anchor-artifacts.mjs
  -> artifacts/anchor/*
  -> scripts/sync-package-protocol-assets.mjs
  -> packages/protocol/src/generated/*
  -> npm package build / dist
```

## Rules

- `target/` is local build output, not the public contract
- `artifacts/anchor/*` is the committed canonical public artifact surface
- `packages/protocol/src/generated/*` is a derived copy used to publish `@tetsuo-ai/protocol`
- `scripts/idl/verifier_router.json` is repo-owned verifier-router support data and belongs in the committed public surface

## Commands

After a successful `anchor build`:

```bash
npm run artifacts:refresh
```

To verify committed artifacts:

```bash
npm run artifacts:check        # existence/shape check — passes without a local build
npm run artifacts:check:built  # full check against the current build (--require-build)
```

CI (`.github/workflows/idl-drift.yml`) builds the program fresh, runs the built
check, and enforces the canary-IDL gate, so `main` cannot carry a drifting IDL.

## Consumer Guidance

Downstream repos should consume released protocol artifacts from:

- this repo's committed artifact surface, or
- the published `@tetsuo-ai/protocol` package

They should not treat local `target/` files or vendored copies in other repos as canonical.

