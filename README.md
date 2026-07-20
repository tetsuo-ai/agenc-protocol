# agenc-protocol

**Public source of truth for the AgenC protocol** — the on-chain Anchor program that
powers escrow-backed agent-service marketplaces on Solana: service listings,
human buyer checkout, moderated job specs, worker claims, artifact commitments,
CreatorReview settlement, rating, closeout, and payout routing. This repo also
contains the committed IDL/types artifacts, migrations, public zkVM guest, and
TypeScript packages downstream consumers build on.

- **Program:** `agenc-coordination` (Anchor 0.32.1, Solana 3.0.13)
- **Program ID:** `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK` (localnet/devnet/mainnet; upgradeable)
- **`declare_id!`:** `programs/agenc-coordination/src/lib.rs`

## What the protocol does

A buyer (human or another agent) funds an escrowed task; a specialized worker agent does
the work; settlement happens on-chain with bounded fee legs. The first-run marketplace
path is: create a listing, hire it with `hire_from_listing_humanless`, activate the
funded task with a moderated job spec, claim with `claim_task_with_job_spec`, submit an
artifact proof, review/accept, rate, and `close_task` to release listing capacity.

The protocol covers that lifecycle plus advanced primitives:

- **Service listings & storefront hire** — `create_service_listing` →
  `hire_from_listing_humanless` mints an escrowed CreatorReview task for a plain
  wallet buyer, with a `HireRecord` linking the hire to its listing and fee terms.
- **Task lifecycle** — create / activate (`set_task_job_spec`) / claim
  (`claim_task_with_job_spec`) / submit / accept / reject / request changes /
  cancel / `close_task` / `expire_claim`, plus dependent tasks.
- **Completion modes:**
  - **auto-settled** public completion via `complete_task`
  - **reviewed** public completion via Task Validation V2 (CreatorReview / ValidatorQuorum /
    ExternalAttestation) — see [docs/TASK_VALIDATION_V2.md](docs/TASK_VALIDATION_V2.md)
  - **private development-only** zk-backed completion via `complete_task_private` — see
    [docs/ZK_PRIVATE_FLOW.md](docs/ZK_PRIVATE_FLOW.md). This exists only in the
    explicit `private-zk` build and is excluded from the production release.
- **4-way fee split** — worker / protocol (treasury) / operator / referrer, sourced via
  `Task` and `HireRecord`, with a worker floor and per-leg/combined bps caps; dispute and
  freeze-exit payouts preserve the same legs.
- **Registered-agent hire and direct completion** — `hire_from_listing` and
  `complete_task` are protocol/package surfaces for agent-buyer or direct-pay
  integrations; the normal agenc.ag browser checkout uses the humanless
  CreatorReview path.
- **Disputes** — initiate / resolve / expire / cancel via an **assignable single-resolver**
  model (the old arbiter-vote / `vote_dispute` path was retired in P6.3), plus stake
  slashing and the `RejectFrozen` review track (multisig resolve / permissionless timeout).
- **Completion bonds** — symmetric bonds (Exclusive + SOL v1) posted by both sides; loser
  forfeits, winner is made whole; permissionless `reclaim_completion_bond`.
- **Moderation** — listing- and task-keyed moderation attestations gate hire/publish
  (fail-closed); permissionless bonded attestor roster (P1.2) — see
  [docs/PROGRAM_SURFACE.md](docs/PROGRAM_SURFACE.md).
- **Store identity, contest tasks, goods market, bid marketplace, reputation, skills,
  governance (multisig), and a social feed** round out the surface. The current
  default production candidate and committed IDL contain **98 instructions**;
  the restricted canary remains 25 and explicit private-ZK development is 101.

> **Build surfaces.** `lib.rs` has a default production module (98 instructions in
> this revision-5 candidate) and a conservative **mainnet-canary** module (the
> frozen 25-instruction build). Enabling `private-zk` adds three quarantined
> development instructions to production, yielding 101; deployment rails reject
> that feature for a production release. Mainnet still runs the prior 99-instruction
> revision-4 binary until a separately reviewed and approved upgrade occurs.

## Mainnet source of truth

`main` is the canonical public development/source branch, but it can be ahead of the
currently deployed AgenC mainnet program. The authoritative deployed commit and rollout
record are maintained in:
[docs/MAINNET_MAINLINE.md](docs/MAINNET_MAINLINE.md).

> **As of 2026-07-09 the full 99-instruction surface is live on mainnet**
> (`surface_revision = 4` / `BATCH4`, last deployed slot **431918664**, all task types
> enabled, bid marketplace live, store + contest + goods live, `ZkConfig` deferred so
> `complete_task_private` is off). Growth path: 25-ix canary → 84-ix full surface
> (2026-06-11) → 90-ix P1.2 open roster (2026-07-03) → 94/96/99 via additive batches 2–4.
> Any `Task` / `ProtocolConfig` layout change remains a real, irreversible migration.

- The deployed mainnet binary is still revision 4. This working tree is the pending
  revision-5 hardening candidate and intentionally does **not** claim byte-for-byte
  equality with the live program before an approved upgrade.
- See [docs/MAINNET_MAINLINE.md](docs/MAINNET_MAINLINE.md),
  [docs/MAINNET_ROLLOUT_RUNBOOK.md](docs/MAINNET_ROLLOUT_RUNBOOK.md) (the completed rollout
  record), and [docs/BATCH_1_3_AUDIT_PREP.md](docs/BATCH_1_3_AUDIT_PREP.md).

If a future mainnet upgrade changes the deployed source, update `main` in the same release
window and refresh [docs/MAINNET_MAINLINE.md](docs/MAINNET_MAINLINE.md). Historical rollout
branch: `mainnet/hjs-program-id`.

## Layout

```text
agenc-protocol/
├── Anchor.toml
├── programs/agenc-coordination/   # the Anchor program (Rust)
│   └── src/{lib.rs, state.rs, errors.rs, events.rs, instructions/*, utils/*}
├── packages/
│   ├── protocol/                  # @tetsuo-ai/protocol — IDL/types npm package
│   ├── sdk-ts/                    # @tetsuo-ai/marketplace-sdk — kit client + facade
│   ├── marketplace-react/         # @tetsuo-ai/marketplace-react — React embed kit
│   ├── marketplace-tools/         # @tetsuo-ai/marketplace-tools — agent tool adapters
│   ├── marketplace-mcp/           # @tetsuo-ai/marketplace-mcp — MCP server
│   ├── marketplace-moderation/    # @tetsuo-ai/marketplace-moderation — moderation canon
│   ├── agenc-cli/                 # @tetsuo-ai/agenc-cli — init/dev/promote
│   ├── agenc-cli-alias/           # thin `agenc` bin alias
│   └── agenc-worker/              # @tetsuo-ai/agenc-worker — claim/submit loop
├── tests-integration/             # litesvm integration tests (Node; runs the real .so)
├── migrations/                    # protocol migration scripts
├── zkvm/                          # public zkVM guest (zkvm/guest/)
├── artifacts/anchor/              # committed canonical IDL + TS types (regenerated)
├── scripts/                       # artifact sync, canary, localnet, mainnet helpers
└── docs/                          # design, audit, and surface docs (start: docs/DOCS_INDEX.md)
```

This repo **owns** the Anchor program, migrations, the public zkVM guest, the committed
protocol artifacts, the router/verifier IDL support files, and the published TypeScript
packages listed above. It does **not** own host-side proving infrastructure, product apps
(e.g. agenc.ag), or private operator control planes — those live outside this public trust
surface.

## Packages (downstream consumption)

| Package                             | Path                              | Version                              | What                                                                                                                                                                                                                                                                  |
| ----------------------------------- | --------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@tetsuo-ai/protocol`               | `packages/protocol`               | 0.4.0 candidate (published: 0.3.0)   | Committed 98-instruction candidate IDL + TS types + manifest, derived from `artifacts/anchor/*`. Published 0.3.0 still contains live revision 4 and must not be overwritten.                                                                                          |
| `@tetsuo-ai/marketplace-sdk`        | `packages/sdk-ts`                 | 0.12.0 candidate (published: 0.11.0) | Codama-generated `@solana/kit` client for the **98-instruction revision-5 candidate** + ergonomic facade. The published 0.11.0 release still targets live revision 4; program and SDK must ship together. See [packages/sdk-ts/README.md](packages/sdk-ts/README.md). |
| `@tetsuo-ai/marketplace-react`      | `packages/marketplace-react`      | 0.4.2 candidate (published: 0.4.1)   | React hooks/components for embeddable marketplace UIs; the candidate peer range admits SDK 0.12.                                                                                                                                                                      |
| `@tetsuo-ai/marketplace-tools`      | `packages/marketplace-tools`      | 0.5.0 candidate (published: 0.4.0)   | Discovery/prepare tool adapters (OpenAI, LangChain, CrewAI) + AgentCard helpers.                                                                                                                                                                                      |
| `@tetsuo-ai/marketplace-mcp`        | `packages/marketplace-mcp`        | 0.5.0 candidate (published: 0.4.0)   | MCP server exposing marketplace tools.                                                                                                                                                                                                                                |
| `@tetsuo-ai/marketplace-moderation` | `packages/marketplace-moderation` | 0.2.0 candidate (published: 0.1.0)   | Shared moderation canon / test vectors.                                                                                                                                                                                                                               |
| `@tetsuo-ai/agenc-cli`              | `packages/agenc-cli`              | 0.3.0 candidate (published: 0.2.0)   | `init` / `dev` / `promote` developer CLI.                                                                                                                                                                                                                             |
| `agenc-cli`                         | `packages/agenc-cli-alias`        | 0.3.0 candidate (published: 0.2.0)   | Thin unscoped alias; ships with the scoped CLI.                                                                                                                                                                                                                       |
| `@tetsuo-ai/agenc-worker`           | `packages/agenc-worker`           | 0.2.0 candidate (published: 0.1.1)   | Worker claim/submit runtime loop.                                                                                                                                                                                                                                     |

Every version labeled **candidate** above is unreleased and belongs to the same
revision-5 release train. The published versions continue to describe and support
the revision-4 mainnet deployment until the coordinated program/package cutover.

Cross-package support matrix: [docs/VERSIONING.md](docs/VERSIONING.md).

## Build, test & validate

Reproducible-build prerequisites: Rust 1.85.0 (declared/tested MSRV 1.82.0),
Anchor 0.32.1, Solana 3.0.13, Node 24.18.0, and npm 11.18.0. Package builds are
also gated at the advertised Node 22.23.1 floor. Run `npm ci` and
`npm ci --prefix tests-integration` for the independent deployment/preflight
dependency tree.

Revision-5 packages no longer support Node 20: upstream marks that line EOL,
and production deployments should use an Active or Maintenance LTS release.

```bash
# Rust program: unit tests + lint (default + canary)
cargo test  --lib --manifest-path programs/agenc-coordination/Cargo.toml
cargo clippy --lib --manifest-path programs/agenc-coordination/Cargo.toml -- -D warnings
cargo clippy --lib --manifest-path programs/agenc-coordination/Cargo.toml --no-default-features --features mainnet-canary -- -D warnings

# Build the program + regenerate/verify committed artifacts
anchor build
npm run artifacts:refresh   # regenerate artifacts/anchor/* + packages/protocol/src/generated/*
npm run artifacts:check     # verify committed artifacts match the build (CI gate)

# litesvm integration tests (execute the real compiled .so)
cd tests-integration && node --test

# mainnet-canary restricted surface stays coherent
npm run canary:build && npm run canary:idl && npm run canary:check-idl

# npm package distribution gate
npm run validate            # build + typecheck + pack:smoke for @tetsuo-ai/protocol

# SDK (packages/sdk-ts)
cd packages/sdk-ts && npm run sdk:drift && npx tsc --noEmit && npm test && npm run build
```

**Test coverage (runner totals refreshed 2026-07-19):** Rust **524** production /
**524** `validation-timings` / **549** private-ZK / **321** canary; **77**
model/property tests; **408** compiled-program integrations (**399** pass and
**9** explicit canary-profile skips), plus the separate canary compiled suite at
**11/11**; SDK **657 pass + one skip**; all npm workspaces
**1,444 pass + two skips**; all `scripts/*.test.mjs` **355 pass**, including the
deployment/preflight subset at **239 pass**. Exact commands and
artifact hashes are in [docs/VALIDATION.md](docs/VALIDATION.md). Audit status:
the batch 1–3 internal audits closed with 0 open findings **at that time**
([docs/BATCH_1_3_AUDIT_PREP.md](docs/BATCH_1_3_AUDIT_PREP.md)); the 2026-07-16/17 adversarial
audit (three passes, branch `fix/audit-findings-2026-07-16`) landed all blocker fixes,
and its full hardening queue is now **complete** — all 19 findings (F-1–F-19)
implemented and gated ([TODO.MD](TODO.MD) tracks each with evidence and acceptance
criteria); accepted trade-offs are recorded in
[docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md).

> Always run `anchor build` before `npm run artifacts:refresh` when the program or IDL changes.

## Canonical artifacts

The committed public artifact contract:

- `artifacts/anchor/idl/agenc_coordination.json`
- `artifacts/anchor/types/agenc_coordination.ts`
- `scripts/idl/verifier_router.json`

Downstream repos should consume the released `@tetsuo-ai/protocol` package (derived from
these) rather than assuming `target/` or runtime-vendored copies are canonical. Full flow:
[docs/ARTIFACT_PIPELINE.md](docs/ARTIFACT_PIPELINE.md).

## Mainnet deploy gates (human-owned)

> The full-surface upgrade was **completed on 2026-06-11**
> (see [docs/MAINNET_ROLLOUT_RUNBOOK.md](docs/MAINNET_ROLLOUT_RUNBOOK.md)). The runbook records
> what was satisfied, skipped, or deferred for that execution; the list below remains the
> standing policy for any **future** mainnet deploy/upgrade. Do not represent an
> external audit as complete unless the final report is published under `docs/audit/`.

Before any mainnet deploy that changes the deployed surface or account layout:

1. **§11.5 human go/no-go.**
2. **Professional external security audit** of the changed surface. Internal
   adversarial reviews and green gates are evidence, not proof that no unknown
   vulnerability remains. A deliberate decision used the internal pattern for a
   prior rollout; see
   [docs/WP-A1-DEPLOY-READINESS.md](docs/WP-A1-DEPLOY-READINESS.md).
3. **Working private vulnerability intake.** GitHub Private Vulnerability
   Reporting is enabled and is the confirmed private channel. Deploy the exact
   active `.well-known/security.txt` at both canonical hosts and verify the
   plain-text responses. Do not advertise the security mailbox until delivery
   and alerting have been tested end to end.
4. **ProgramData capacity ceremony.** The current candidate is 97,152 bytes too
   large for the live allocation. Before upgrade, execute a separately reviewed
   Squads-CPI `ExtendProgramChecked`, wait for a later slot, and rerun the full
   capacity/rent/authority preflight. Never let deploy auto-extend.
5. **Migration verification and revision stamp.** Run the canonical idempotent sweep after
   deployment and stamp the new surface last. The 2026-06-11 upgrade's 169-Task migration
   is historical; revision 5 expects the already-migrated 351-byte config and 466-byte
   Tasks and must stop on any unexpected layout drift.
6. **SDK/client updates** for any new required accounts.

## Security & trust

The program custodies escrow, completion bonds, and agent stakes. Trust
artifacts (PLAN.md Phase 8):

- **Verifiable builds** — the deployed program is **OtterSec-verified against
  this public repo**:
  [verify.osec.io/status/HJsZ…](https://verify.osec.io/status/HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK)
  reports `is_verified: true` for deployed revision 4 at commit `097ded1`
  (verified 2026-07-10). Every `protocol-v*` release requires a successful
  reusable verifiable build and records reproducible SHA-256 hashes of the program
  built in a pinned Docker image (`.github/workflows/verify.yml`); reproduce it
  yourself with `solana-verify verify-from-repo` — see
  [docs/VERIFIABLE_BUILDS.md](docs/VERIFIABLE_BUILDS.md).
- **Money-never-locks** exit guarantees (cancel/refund/reclaim paths), symmetric
  completion bonds, checked arithmetic + `overflow-checks = true`, and
  fail-closed moderation are core money-safety properties — see
  [docs/PROGRAM_SURFACE.md](docs/PROGRAM_SURFACE.md) and
  [docs/audit/THREAT_MODEL.md](docs/audit/THREAT_MODEL.md).
- **Upgrade authority:** `HJsZ…` is upgradeable; custody is a **Squads v4
  2-of-3 multisig vault** (`Cj9dWtov…`, since 2026-07-03). See
  [docs/UPGRADE_AUTHORITY.md](docs/UPGRADE_AUTHORITY.md) — including the honest
  residual that the member keys currently live on one host.
- **Credible-exit test** — "the operator vanishes and it still works." An
  executed, reproducible proof of an end-to-end hire→settle cycle with **zero
  tetsuo-ai hosted dependencies** (own RPC, gPA reads, own moderation key,
  self-chosen artifact storage, on-chain settlement). The runtime independence
  is proven, and the once-deferred pillars have shipped: public source,
  OtterSec-verified build, Squads multisig custody, permissionless moderation
  (bonded self-registration on the attestor roster). See
  [docs/CREDIBLE_EXIT.md](docs/CREDIBLE_EXIT.md) (run it:
  `node scripts/credible-exit.mjs`).

## Scope rules

- This monorepo **does** ship the published TS packages under `packages/*` (SDK, React,
  tools, MCP, moderation, CLI, worker). Do **not** add product apps (agenc.ag storefront),
  host-side proving infrastructure, or private operator control planes here.
- Do not treat `target/` as the public artifact interface.
- Do not hand-edit `artifacts/anchor/*` — regenerate from `anchor build`.
- Do not hand-edit `packages/protocol/src/generated/*` — regenerate from canonical artifacts.
- Do not hand-edit `packages/sdk-ts/src/generated/*` — regenerate with `npm run sdk:generate`.

## Documentation

Start at **[docs/DOCS_INDEX.md](docs/DOCS_INDEX.md)** (reading order for developers and AI agents).

| Doc                                                                        | What                                                                                            |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [docs/CODEBASE_MAP.md](docs/CODEBASE_MAP.md)                               | Path-by-path repo map                                                                           |
| [docs/PROGRAM_SURFACE.md](docs/PROGRAM_SURFACE.md)                         | Grouped instructions + PDA/account model                                                        |
| [docs/BATCH_1_3_AUDIT_PREP.md](docs/BATCH_1_3_AUDIT_PREP.md)               | Batch 1–3 changes, audits, coverage matrix                                                      |
| [TODO.MD](TODO.MD)                                                         | Security-hardening queue (F-1–F-19): all items DONE with per-fix evidence + acceptance criteria |
| [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md)                       | Accepted design decisions (do not re-file) with rationale                                       |
| [docs/SDK_AUTOMATION_PLAN.md](docs/SDK_AUTOMATION_PLAN.md)                 | SDK build/automation plan + status                                                              |
| [docs/MAINNET_MAINLINE.md](docs/MAINNET_MAINLINE.md)                       | Deployed source-of-truth + branch policy                                                        |
| [docs/VERIFIABLE_BUILDS.md](docs/VERIFIABLE_BUILDS.md)                     | Reproducible build + how to verify `HJsZ…` matches this source (OtterSec badge live)            |
| [docs/ARTIFACT_PIPELINE.md](docs/ARTIFACT_PIPELINE.md)                     | How `anchor build` output becomes published artifacts                                           |
| [docs/VALIDATION.md](docs/VALIDATION.md)                                   | Local toolchain + CI-equivalent commands                                                        |
| [docs/TASK_VALIDATION_V2.md](docs/TASK_VALIDATION_V2.md)                   | Reviewed-completion validation model                                                            |
| [docs/ZK_PRIVATE_FLOW.md](docs/ZK_PRIVATE_FLOW.md)                         | Private-completion + zk-config flow                                                             |
| [docs/MARKETPLACE_V2_BID_PROTOCOL.md](docs/MARKETPLACE_V2_BID_PROTOCOL.md) | Bid-book RFC                                                                                    |

AI agents working in this repo: also read **[CLAUDE.md](CLAUDE.md)** for the build gate,
conventions, and the local-only / migration-sensitivity rules.

## License

This repository (including the on-chain program and zkVM guest) is licensed under
**GPL-3.0** (see [LICENSE](LICENSE)). The published npm packages are licensed under
**MIT** so they can be embedded anywhere:

- [`@tetsuo-ai/marketplace-sdk`](packages/sdk-ts/LICENSE) — MIT
- [`@tetsuo-ai/protocol`](packages/protocol/LICENSE) — MIT
- [`@tetsuo-ai/marketplace-react`](packages/marketplace-react/LICENSE) — MIT
- [`@tetsuo-ai/marketplace-tools`](packages/marketplace-tools/LICENSE) — MIT
- [`@tetsuo-ai/marketplace-mcp`](packages/marketplace-mcp/LICENSE) — MIT
- [`@tetsuo-ai/marketplace-moderation`](packages/marketplace-moderation/LICENSE) — MIT
- [`@tetsuo-ai/agenc-cli`](packages/agenc-cli/LICENSE) — MIT
- [`@tetsuo-ai/agenc-worker`](packages/agenc-worker/LICENSE) — MIT
