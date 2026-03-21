# Protocol Validation

This file maps the local validation and CI flow for `agenc-protocol`.

## Toolchain Pins

- Anchor `0.32.1`
- Solana `3.0.13`
- Rust `1.79` for the program crate
- Node `20` in CI

See `Anchor.toml`, `programs/agenc-coordination/Cargo.toml`, and `.github/workflows/ci.yml`.

## Core Commands

```bash
npm ci
cargo fmt --manifest-path programs/agenc-coordination/Cargo.toml --all --check
cargo fmt --manifest-path zkvm/guest/Cargo.toml --all --check
cargo test --manifest-path programs/agenc-coordination/fuzz/Cargo.toml bid_marketplace
npm run artifacts:check
npm run build
npm run typecheck
npm run pack:smoke
```

Those are the same gates enforced by CI for Marketplace V2 work.

## Artifact Commands

- regenerate committed artifacts: `npm run artifacts:refresh`
- verify committed artifacts: `npm run artifacts:check`

## Optional Local Program Work

```bash
anchor build
```

Use `anchor build` before refreshing artifacts when the on-chain program or IDL changes.

## Fuzz Harness

The program also ships a property/invariant harness under `programs/agenc-coordination/fuzz/`. Treat it as the place for invariant-oriented testing and threat-model assertions when touching state transitions or safety properties.

For Marketplace V2 bid flow changes, run:

```bash
cargo test --manifest-path programs/agenc-coordination/fuzz/Cargo.toml bid_marketplace
```
