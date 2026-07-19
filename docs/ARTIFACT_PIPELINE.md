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

- a tagged/released artifact set that matches their target cluster, normally the
  published `@tetsuo-ai/protocol` package; or
- this repo's committed artifact surface only when intentionally integrating the
  pending candidate.

At current HEAD, committed artifacts describe the 97-instruction revision-5
candidate while published `@tetsuo-ai/protocol@0.3.0` describes the live
99-instruction revision-4 wire. They are deliberately not interchangeable before
the coordinated program/package release.

They should not treat local `target/` files or vendored copies in other repos as canonical.
