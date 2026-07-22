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

Last complete aggregate gate snapshot, measured on 2026-07-19 before the current
revision-5 continuation:

| Gate                             | Result                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------- |
| Rust production/default          | 524 tests                                                                         |
| Rust `validation-timings`        | 524 tests                                                                         |
| Rust explicit `private-zk`       | 549 tests                                                                         |
| Rust restricted `mainnet-canary` | 321 tests                                                                         |
| Model/property suite             | 77 tests                                                                          |
| Compiled-program litesvm         | 408 total: 399 pass, 9 explicit canary-profile skips; separate canary run 11 pass |
| SDK                              | 658 total: 657 pass, one environment-gated skip                                   |
| All npm workspaces               | 1,446 total: 1,444 pass, two environment-gated skips                              |
| Deployment/preflight scripts     | 239 pass                                                                          |
| All `scripts/*.test.mjs`         | 355 pass (includes the deployment/preflight subset above)                         |

Those aggregate totals are historical and must not be combined with the final
revision-5 candidate as if they were one quiescent release run.

Current local candidate evidence, measured on 2026-07-21 during the
post-cutoff continuation (verified address-lookup-table transport resolver,
canary-profile dead-code gate in `utils/version.rs`). This is not a final
quiescent release snapshot:

| Gate                             | Latest local evidence / current status                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Rust production/default          | 533/533; strict Clippy and formatting pass                                                                                              |
| Rust `validation-timings`        | 533/533; strict Clippy pass                                                                                                             |
| Rust explicit `private-zk`       | 558/558; strict Clippy pass                                                                                                             |
| Rust restricted `mainnet-canary` | 323/323; strict Clippy pass (required gating the full-surface-only bootstrap version helper out of the canary build)                    |
| Model/property suite             | 77/77 with `PROPTEST_CASES=10000`                                                                                                       |
| Compiled-program LiteSVM         | Two consecutive production passes, each 413 total: 404 pass / 0 fail / 9 explicit canary-only skips; separate canary artifact 11/11     |
| SDK (`@tetsuo-ai/marketplace-sdk`) | Two consecutive Node 24 passes, 884 total: 883 pass / one intentional skip; drift, typecheck, build, examples all pass                |
| Other workspaces (Node 24)       | worker 273/273, CLI 146/146, tools 98/98, React 312 pass + one intentional skip, starter example 36/36                                  |
| Minimum toolchains               | Node 22.23.1 typecheck plus focused client/governance 100/100; Rust 1.82 profile checks unchanged from 2026-07-20                       |
| Deployment/preflight scripts     | 328/328 (expanded suite)                                                                                                                |
| All `scripts/*.test.mjs`         | Two consecutive Node 24 passes at 451/451                                                                                               |
| Package release train            | **OPEN:** late SDK/React/worker/CLI fixes invalidated prior SRIs; all-nine double-pack/rebind/smoke is pending                          |
| Supply/artifact checks           | npm production audit 0; built artifact sync, IDL reference, stack, and integration dependency audit pass                                |

These local gates do not substitute for protected CI, live revision-4
compatibility simulations, consumer convergence, or the controlled mainnet
ceremony.

Deployed revision-5 identities. Revision 5 was deployed 2026-07-22; the deployed
executable is byte-equal to the reviewed revision-5 candidate (thrice-reproduced:
the 2026-07-20 close-task fix build plus two 2026-07-21 rebuilds):

| Artifact       | Current local evidence                                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Production SBF | SHA-256 `049a66e30da166c1e02ee379993425c32386f774fd9ff8861153e21900b496f2`, 2,303,608 bytes, deployed 2026-07-22; ProgramData `E5w1ZkgC5ysWWBECHHzqsL4s6dDUoyWBnUMRptm5cEAw` |
| Canonical IDL  | 101 instructions / 43 accounts / 102 events / 405 errors; SHA-256 `8cfd094dc356f88678ba712a8a167a9fcd94cf3c33852ec1092a7a3ff491a82e` |

Mainnet now runs deployed revision 5 (executable `049a66…`, 2026-07-22); the
superseded revision-4 artifact was commit `097ded1` (99 instructions / 46
accounts / 104 events / 354 errors). Re-resolve and compare ProgramData against
the deployed executable hash when in doubt.

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

> Historical note (updated 2026-07-22): the mainnet surface has advanced through
> the full 99-instruction revision-4 surface (`surface_revision = 4`, live
> 2026-07-09 → 2026-07-22) to the **live 101-instruction revision-5 surface**
> (`surface_revision = 5`, deployed 2026-07-22). `complete_task_private` remains
> deferred: `ZkConfig` is not initialized, and revision-5 production removes the
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
is resumed only after its registry integrity and provenance match the exact
repository, workflow, ref, and commit; a mismatch or unverifiable provenance
fails closed.

Release routing is bound to the package id produced by the validated resolver,
not to a second interpretation of the raw tag prefix. The reusable protocol
verifier is selected only after an earlier trusted resolution job, every
package-specific step uses the resolved id, and every release-train id must map
to exactly one real routed gate step. The selected gate writes a one-time proof
only after its checks succeed; packaging fails closed unless a later workflow
step verifies that proof against the resolved id, name, directory, version, and
tag. The preflight derives completion ids from the actual workflow steps rather
than trusting the separately declared identity list, so adding a train package
and static identity without an implemented gate is rejected. GitHub documents
job outputs through `needs` and permits `needs`/`if` on reusable-workflow jobs:
<https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/pass-job-outputs> and
<https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations>.
The dependency-DAG validator reads
`dependencies`, `optionalDependencies`, and `peerDependencies` independently,
rejects contradictory duplicate first-party ranges, and prohibits `npm:` aliases
to train packages. npm documents those aliases as package specs that can target a
different registry package, so inspecting only dependency keys is insufficient:
<https://docs.npmjs.com/cli/v11/using-npm/package-spec/>.

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
The revision-5 upgrade (2026-07-22) required a separate 120,384-byte top-level
legacy `ExtendProgram` action in a slot before the binary upgrade. Mainnet never
activated checked extension, and current Agave rejects legacy extension through
CPI, so this action could not be a Squads vault transaction; it was executed via
the pinned `scripts/program-extend-mainnet.mjs` rail with official Agave CLI
4.1.0, an explicitly funded payer, and two independent genesis-checked RPCs.

The SDK drift gate snapshots a deterministic digest of every generated path and
byte, regenerates from the current IDL, and compares the before/after trees. This
still fails a stale clean checkout in CI while allowing a reviewed, intentionally
uncommitted generated tree to prove that a second generation is idempotent.
