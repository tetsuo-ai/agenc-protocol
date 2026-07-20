# Protocol Validation

This file maps the local validation and CI flow for `agenc-protocol`.

For Marketplace V2 release readiness, local CI is necessary but not sufficient. The protocol-owned
devnet matrix lives in [./MARKETPLACE_V2_DEVNET_READINESS_MATRIX.md](./MARKETPLACE_V2_DEVNET_READINESS_MATRIX.md).

## Toolchain Pins

- Anchor `0.32.1`
- Solana `3.0.13`
- Rust `1.85.0` for reproducible host CI/release builds; the program crate's
  independently tested MSRV is `1.82.0`
- Node `24.18.0` with npm `11.18.0` for reproducible CI/release builds; Node
  `22.23.1` is the independently tested package compatibility floor

Node 20 is EOL and is not a supported revision-5 runtime. Production operators
must remain on an Active or Maintenance LTS Node release.

See `Anchor.toml`, `programs/agenc-coordination/Cargo.toml`, and `.github/workflows/ci.yml`.

## Core Commands

```bash
npm ci
npm ci --prefix tests-integration
npm run audit:tests-integration
cargo fmt --manifest-path programs/agenc-coordination/Cargo.toml --all --check
cargo fmt --manifest-path zkvm/guest/Cargo.toml --all --check
npm run artifacts:check
npm run build
npm run typecheck
npm run pack:smoke
npm run check:idl-reference
npm run test:deployment-scripts

cargo test --manifest-path programs/agenc-coordination/Cargo.toml --all-targets
cargo test --manifest-path programs/agenc-coordination/Cargo.toml --all-targets --features validation-timings
cargo test --manifest-path programs/agenc-coordination/Cargo.toml --all-targets --features private-zk
cargo test --manifest-path programs/agenc-coordination/Cargo.toml --all-targets --no-default-features --features mainnet-canary
cargo test --manifest-path programs/agenc-coordination/fuzz/Cargo.toml --all-targets

# This unnamed feature combination is deliberately rejected: use the default
# full surface, or add --features mainnet-canary for the restricted surface.
cargo check --manifest-path programs/agenc-coordination/Cargo.toml --no-default-features

node --test tests-integration/*.test.mjs
npm test --workspaces --if-present
```

Those are the same gates enforced by normal pull-request CI for Marketplace V2
work; the bare no-default command is an expected compile-fail assertion. CI
additionally builds the program fresh and runs `npm run artifacts:check:built`
(`--require-build`) plus the canary-IDL gate (`.github/workflows/idl-drift.yml`).

Current candidate evidence, measured from the commands and built artifacts on
2026-07-19:

| Gate                             | Result                                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Rust production/default          | 524 tests                                                                                                                          |
| Rust `validation-timings`        | 524 tests                                                                                                                          |
| Rust explicit `private-zk`       | 549 tests                                                                                                                          |
| Rust restricted `mainnet-canary` | 321 tests                                                                                                                          |
| Model/property suite             | 77 tests                                                                                                                           |
| Compiled-program litesvm         | 408 total: 399 pass, 9 explicit canary-profile skips; separate canary run 11 pass                                                  |
| SDK                              | 658 total: 657 pass, one environment-gated skip                                                                                    |
| All npm workspaces               | 1,446 total: 1,444 pass, two environment-gated skips                                                                               |
| Deployment/preflight scripts     | 239 pass                                                                                                                           |
| All `scripts/*.test.mjs`         | 355 pass (includes the deployment/preflight subset above)                                                                          |
| Production SBF                   | 2,280,376 bytes; SHA-256 `dd8aaf65ea56169459da77ac5e50f22c05d0c128b8fe2a314fc8bf7c4d2ace24`                                        |
| Candidate IDL                    | 98 instructions / 43 accounts / 99 events / 393 errors; SHA-256 `5ae986603626d0dfe9024c7dc180f184931622c350c0c32b4abf920a0d918f1b` |

These are candidate facts, not a claim that this binary is deployed: mainnet
still runs the verified revision-4 artifact at commit `097ded1` (99 instructions /
46 accounts / 104 events / 354 errors).
The candidate SBF hash above is local release evidence, not a deployed-program
hash claim; re-resolve and compare ProgramData immediately before and after any
approved upgrade.

Non-test Rust builds enforce `deny(unsafe_code)`. Production account handling
contains no lifetime transmute or unsafe block; the two remaining unsafe blocks
are test-only Anchor account-header fixtures.

`check:idl-reference` regenerates the IDL-derived reference docs
(`docs/reference/INSTRUCTIONS.md`, `docs/reference/ERRORS.md`) and fails when the
committed copies drift from `artifacts/anchor/idl/agenc_coordination.json`. After
an intentional IDL change, run `npm run docs:idl-reference` and commit the result.

## Devnet Marketplace Readiness

Use the devnet matrix when the change touches accepted-bid settlement, dispute settlement,
claim-expiry behavior, or any path that depends on appended `remaining_accounts`.

The matrix defines:

- required Marketplace V2 devnet scenarios
- exact settlement account ordering to validate on-chain
- minimum evidence bundle for each run
- release-readiness exit criteria

## Mainnet Release Scope

> Historical note (2026-07-17): the first mainnet release has shipped — the full
> 99-instruction surface (`surface_revision = 4`) is live since 2026-07-09.
> `complete_task_private` remains deferred: `ZkConfig` is not initialized on
> that live revision, and the pending revision-5 production build removes the
> entrypoint entirely. See [./ZK_PRIVATE_FLOW.md](./ZK_PRIVATE_FLOW.md). The
> scope bullets below are the original release-1 definition, kept for reference.

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

`validation-timings` changes only these timing constants. It does not enable
compute-unit logging, runtime profiling hooks, or a profiling-only Solana
dependency.

## Artifact Commands

- regenerate committed artifacts: `npm run artifacts:refresh`
- verify committed artifacts (no build required): `npm run artifacts:check`
- verify committed artifacts against a fresh build: `npm run artifacts:check:built`

## Optional Local Program Work

```bash
anchor build
```

Use `anchor build` before refreshing artifacts when the on-chain program or IDL changes.

## Fuzz Harness

`programs/agenc-coordination/fuzz/` is an active 77-test model/property regression
suite and a required CI/release gate. Its task, bid, dependency, completion,
dispute, timing, and reputation scenarios model the current single-resolver
dispute lifecycle; the retired `vote_dispute` target has been removed. Treat it
as complementary model coverage, not a replacement for compiled-program litesvm
transactions.

The compiled orphan-recovery suite covers every supported child kind, including
`TaskValidationVote`: exact submission/reviewer/PDA binding, live-parent refusal,
forged address/bump rejection, and rent return to the stored reviewer rather than
the cranker. `scripts/preflight-task-children-scan.mjs` independently mirrors the
vote discriminator/layout/PDA checks and the program's absent-parent semantics,
including dust-funded empty system PDAs.

The release regression suite also parses the workflows themselves. It requires a
successful reusable verifiable-build job before protocol publication, immutable
SHA-pinned external actions, validated executable hashes, and environment-based
shell inputs for tag-derived package/hash values. The release stays a draft until
the hash manifest is attached and npm publication succeeds. Every external
release mutation re-resolves the remote tag to the triggering commit and exact
fetched tag object, including annotated tags. An already-published npm version
fails closed because its integrity/provenance was not established by the current
run.

Both the protocol-tag release job and the IDL-drift job finish all production
artifact/package comparisons before building the shared-path canary SBF, then
build its frozen IDL and run the opt-in canary LiteSVM semantic suite with
`AGENC_CANARY_LITESVM=1`. The normal production wildcard suite can therefore
register its intentional opt-in canary skips from a clean checkout without requiring a
pre-existing ignored canary IDL.

The upgrade preflight separately checks loader-v3 ProgramData capacity and rent
semantics: pinned Solana CLI 3.0.13, genesis-checked RPC rent, mainnet's minimum
extension rule, no implicit auto-extension, and unchanged capacity across deploy.
Immediately before invoking the loader it also re-runs the cutover inventory and
requires explicit zero aggregates for open `TaskBid` accounts (Active or
BoundActive), all live `CompletionBond` principal, and every Task eligible for
deployed revision-4 `post_completion_bond`. The final aggregate covers Exclusive
SOL Tasks in Open, InProgress, or PendingValidation state with automatic or
manual-review completion, because that old custody entry is not pause-gated.
Missing aggregate fields fail closed; `protocol_paused` alone does not freeze
all legacy mutations during a multi-transaction upload.
The release-specific skill-rating rail also requires zero SkillRegistration,
PurchaseRecord, and SkillRating accounts. All three mainnet counts are zero, and
the snapshot is stable because deployed register/purchase/rate paths reject the
paused ProtocolConfig and these accounts have no close/retype path. A permissive
missing-author fallback is intentionally forbidden: legacy state never recorded
the original author wallet, so it cannot enforce the wallet-level self-rating
rule after revision 4 closes that AgentRegistration.
The task-dependency scanner exposes an explicit
`nonterminalDependentCount` plus Data/Ordering/Proof counts, all of which must be
zero. Deployed dependent-task creation is pause-gated, making the snapshot
stable; this prevents revision 4 from closing a Completed parent during upload
and leaving a child that the candidate cannot settle without that live parent.
The same cutover snapshot enumerates every exact-size ReputationStake account
without a discriminator filter, so a corrupted discriminator cannot disappear
from the inventory. It validates the full 74-byte layout, zero reserved bytes,
canonical stake and AgentRegistration PDA bindings, and each account's own rent
plus tracked `staked_amount` backing. Fully backed nonzero stake is compatible;
malformed state, principal without its agent identity, or a per-account deficit
blocks deployment even when aggregate balances appear sufficient.
The current candidate remains blocked on a separate 97,152-byte Squads-CPI
`ExtendProgramChecked` action in a slot before the binary upgrade.

The SDK drift gate snapshots a deterministic digest of every generated path and
byte, regenerates from the current IDL, and compares the before/after trees. This
still fails a stale clean checkout in CI while allowing a reviewed, intentionally
uncommitted generated tree to prove that a second generation is idempotent.
