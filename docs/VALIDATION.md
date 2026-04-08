# Protocol Validation

This file maps the local validation and CI flow for `agenc-protocol`.

For Marketplace V2 release readiness, local CI is necessary but not sufficient. The protocol-owned
devnet matrix lives in [./MARKETPLACE_V2_DEVNET_READINESS_MATRIX.md](./MARKETPLACE_V2_DEVNET_READINESS_MATRIX.md).

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

## Devnet Marketplace Readiness

Use the devnet matrix when the change touches accepted-bid settlement, dispute settlement,
claim-expiry behavior, or any path that depends on appended `remaining_accounts`.

The matrix defines:

- required Marketplace V2 devnet scenarios
- exact settlement account ordering to validate on-chain
- minimum evidence bundle for each run
- release-readiness exit criteria

## Mainnet Release Scope

- The first mainnet release includes the public settlement paths and Task Validation V2 review
  flows.
- The first mainnet release does not include `complete_task_private`.
- Keep `DV-03E` and H200-backed prover bring-up tracked as a later-phase readiness item; do not
  block release-1 on private-path proving unless the release scope changes.

The first harness commands are:

```bash
npm run devnet:marketplace:matrix
npm run devnet:marketplace:prepare -- --scenario DV-02 --config scripts/marketplace-devnet.config.example.json
npm run devnet:marketplace:prepare -- --scenario DV-03A --config scripts/marketplace-devnet.config.example.json
npm run devnet:marketplace:capture -- --bundle artifacts/devnet-readiness/DV-03A/<timestamp> --signature <tx_sig>
npm run devnet:marketplace:report
```

`prepare` creates the scenario bundle, writes the ordered `remaining_accounts` registry, and
captures pre-state snapshots. Execute the devnet transactions separately, then use `capture` to
persist post-state, lamport deltas, optional transaction evidence, and `ordering-check.json` for
the terminal instruction when signatures are supplied. `capture` also writes `event-summary.json`
and `verdict.json` so each bundle has a direct pass/fail outcome. `report` aggregates the latest
bundle per scenario into `artifacts/devnet-readiness/readiness-report.json`, including both the
full-matrix summary and the scoped `release1` and `postLaunch` summaries.

For DV-03E rehearsal runs, the scenario runner also accepts config-backed rpc, idl, wallet, and
prover defaults:

`npm run devnet:marketplace:scenario -- --scenario DV-03E --config scripts/marketplace-devnet.config.example.json`

Store non-secret defaults under `scenarioRunner`. Environment variables still override config
values, especially `AGENC_PROVER_ENDPOINT`, `AGENC_PROVER_API_KEY`,
`AGENC_PROVER_HEADERS_JSON`, and `AGENC_PROVER_TIMEOUT_MS`. This repo does not ship live prover
credentials or operator wallets, so DV-03E evidence remains pending until those inputs are
supplied.

When running against a dedicated validation deployment instead of the shared devnet program,
set these root fields in the harness config:

```json
{
  "idlPath": "<path-to-validation-idl>",
  "programId": "<validation-program-id>"
}
```

Before any validation deploy, run the read-only preflight and make sure it passes:

```bash
npm run devnet:validation:preflight -- --program-id <VALIDATION_PROGRAM_ID>
```

The preflight intentionally fails while the repo still points at the shared program ID. That is a
guardrail, not an error in the script. A separate validation deploy is only safe after these
surfaces all match the dedicated validation program ID:

- `programs/agenc-coordination/src/lib.rs`
- `Anchor.toml`
- the validation IDL used by the harness
- the harness `programId` setting

You can also override them directly on the CLI:

```bash
npm run devnet:marketplace:prepare -- \
  --scenario DV-05 \
  --config scripts/marketplace-devnet.config.example.json \
  --idl packages/protocol/src/generated/agenc_coordination.json \
  --program-id <VALIDATION_PROGRAM_ID>

npm run devnet:marketplace:capture -- \
  --bundle artifacts/devnet-readiness/DV-05/<timestamp> \
  --signature <tx_sig> \
  --idl packages/protocol/src/generated/agenc_coordination.json \
  --program-id <VALIDATION_PROGRAM_ID>
```

Use a validation build when you need short claim, dispute, and voting windows for the remaining
Marketplace V2 red cases:

```bash
anchor build -- --features validation-timings
cargo test test_protocol_timing_profile_matches_build_mode \
  --manifest-path programs/agenc-coordination/Cargo.toml \
  --features validation-timings
```

That build profile keeps shared-devnet behavior unchanged while producing a separate binary with:

- `max_claim_duration = 300`
- `max_dispute_duration = 600`
- `voting_period = 300`

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
