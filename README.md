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
- **Completion modes (three):**
  - **auto-settled** public completion via `complete_task`
  - **reviewed** public completion via Task Validation V2 (CreatorReview / ValidatorQuorum /
    ExternalAttestation) — see [docs/TASK_VALIDATION_V2.md](docs/TASK_VALIDATION_V2.md)
  - **private** zk-backed completion via `complete_task_private` — see
    [docs/ZK_PRIVATE_FLOW.md](docs/ZK_PRIVATE_FLOW.md) (deferred until the prover path is ready)
- **3-way fee split** — worker / protocol (treasury) / operator, sourced via `HireRecord`,
  with a worker floor and bps caps; enforced on the dispute payout paths too so settlement
  can't bypass the split.
- **Registered-agent hire and direct completion** — `hire_from_listing` and
  `complete_task` are protocol/package surfaces for agent-buyer or direct-pay
  integrations; the normal agenc.ag browser checkout uses the humanless
  CreatorReview path.
- **Disputes** — initiate / vote / resolve / expire / cancel, arbiter quorum, stake
  slashing, plus the `RejectFrozen` review track (multisig resolve / permissionless timeout).
- **Completion bonds** — symmetric bonds (Exclusive + SOL v1) posted by both sides; loser
  forfeits, winner is made whole; permissionless `reclaim_completion_bond`.
- **Moderation** — listing- and task-keyed moderation attestations gate hire/publish
  (fail-closed) — see [docs/PROGRAM_SURFACE.md](docs/PROGRAM_SURFACE.md).
- **Bid marketplace, reputation, skills, governance (multisig), and a social feed** round
  out the surface (84 instructions total).

> **Two program surfaces.** `lib.rs` has two `#[program]` modules: the full/dev module
> (everything, **live on mainnet as of 2026-06-11**) and the conservative
> **mainnet-canary** module (the restricted 25-instruction build, retained in source but
> no longer what is live). New feature work is gated to the full module; `migrate_task` is
> in both.

## Mainnet source of truth

`main` is the canonical public source-of-truth branch for the currently **deployed** AgenC
mainnet program.

> **As of 2026-06-11 the full 84-instruction surface is live on mainnet**
> (`surface_revision = FULL (1)`, all task types enabled, bid marketplace live, `ZkConfig`
> deferred so `complete_task_private` is off). Mainnet is **no longer the canary**: the
> Phase 9 upgrade migrated the 169 live Task accounts (382B → 466B, 0 failures) and the
> `ProtocolConfig` (349B → 351B). Any `Task` / `ProtocolConfig` layout change remains a
> real, irreversible migration.

- The current `main` tree matches the deployed mainnet (full-surface) program source.
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
│   ├── protocol/                  # @tetsuo-ai/protocol — committed IDL/types, npm dist
│   └── sdk-ts/                    # @tetsuo-ai/marketplace-sdk — kit client + facade (SDK)
├── tests-integration/             # litesvm integration tests (Node; runs the real .so)
├── migrations/                    # protocol migration scripts
├── zkvm/                          # public zkVM guest (zkvm/guest/)
├── artifacts/anchor/              # committed canonical IDL + TS types (regenerated)
├── scripts/                       # artifact sync, canary IDL check, devnet readiness
└── docs/                          # design, audit, and surface docs (start: docs/DOCS_INDEX.md)
```

This repo **owns** the Anchor program, migrations, the public zkVM guest, the committed
protocol artifacts, and the router/verifier IDL support files. It does **not** own
host-side proving infrastructure, runtime orchestration, apps, or operator tooling — those
live outside the public trust surface.

## Packages (downstream consumption)

| Package | Path | What |
|---------|------|------|
| `@tetsuo-ai/protocol` | `packages/protocol` | The committed canonical IDL + TS types + manifest. The supported way for downstream repos to consume the protocol contract. Derived from `artifacts/anchor/*`. |
| `@tetsuo-ai/marketplace-sdk` | `packages/sdk-ts` | The embeddable marketplace SDK: a **Codama-generated `@solana/kit` client** for all 84 instructions + an ergonomic facade. The facade intentionally omits only `claim_task` (fail-closed) and `complete_task_private` (ZK gated). See [packages/sdk-ts/README.md](packages/sdk-ts/README.md). |

## Build, test & validate

Prereqs: Rust + the Anchor/Solana toolchain (Anchor 0.32.1, Solana 3.0.13), Node ≥18, `npm ci`.

```bash
# Rust program: unit tests + lint (default + canary)
cargo test  --lib --manifest-path programs/agenc-coordination/Cargo.toml
cargo clippy --lib --manifest-path programs/agenc-coordination/Cargo.toml -- -D warnings
cargo clippy --lib --manifest-path programs/agenc-coordination/Cargo.toml --features mainnet-canary -- -D warnings

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

**Test coverage (last verified):** **232** Rust unit tests · **149** litesvm integration
tests (real on-chain execution) · **98** SDK tests (89 structural + 9 on-chain e2e). Five
internal adversarial/docs-grounded audits, **0 open findings** (see
[docs/BATCH_1_3_AUDIT_PREP.md](docs/BATCH_1_3_AUDIT_PREP.md)).

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
2. **Adversarial security review** of the changed surface (the standing gate —
   a deliberate decision replaced an external audit; see
   [docs/WP-A1-DEPLOY-READINESS.md](docs/WP-A1-DEPLOY-READINESS.md) for the
   executed pattern).
3. **The irreversible task-layout migration choreography** — binary-first → migrate all
   live tasks → version-bump last; multisig/upgrade-authority gated. (The 2026-06-11
   upgrade migrated 169 tasks.)
4. **SDK/client updates** for any new required accounts.

## Security & trust

The program custodies escrow, completion bonds, and agent stakes. Trust
artifacts (PLAN.md Phase 8):

- **Verifiable builds** — the deployed program is **OtterSec-verified against
  this public repo**:
  [verify.osec.io/status/HJsZ…](https://verify.osec.io/status/HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK)
  reports `is_verified: true` at the deployed commit (since 2026-07-03). Every
  `protocol-v*` release also records a reproducible SHA-256 of the program
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

- Do not add runtime, MCP, app, or control-plane code here.
- Do not treat `target/` as the public artifact interface.
- Do not hand-edit `artifacts/anchor/*` — regenerate from `anchor build`.
- Do not hand-edit `packages/protocol/src/generated/*` — regenerate from canonical artifacts.
- Do not hand-edit `packages/sdk-ts/src/generated/*` — regenerate with `npm run sdk:generate`.

## Documentation

Start at **[docs/DOCS_INDEX.md](docs/DOCS_INDEX.md)** (reading order for developers and AI agents).

| Doc | What |
|-----|------|
| [docs/CODEBASE_MAP.md](docs/CODEBASE_MAP.md) | Path-by-path repo map |
| [docs/PROGRAM_SURFACE.md](docs/PROGRAM_SURFACE.md) | Grouped instructions + PDA/account model |
| [docs/BATCH_1_3_AUDIT_PREP.md](docs/BATCH_1_3_AUDIT_PREP.md) | Batch 1–3 changes, audits, coverage matrix |
| [docs/SDK_AUTOMATION_PLAN.md](docs/SDK_AUTOMATION_PLAN.md) | SDK build/automation plan + status |
| [docs/MAINNET_MAINLINE.md](docs/MAINNET_MAINLINE.md) | Deployed source-of-truth + branch policy |
| [docs/VERIFIABLE_BUILDS.md](docs/VERIFIABLE_BUILDS.md) | Reproducible build + how to verify `HJsZ…` matches this source (OtterSec badge live) |
| [docs/ARTIFACT_PIPELINE.md](docs/ARTIFACT_PIPELINE.md) | How `anchor build` output becomes published artifacts |
| [docs/VALIDATION.md](docs/VALIDATION.md) | Local toolchain + CI-equivalent commands |
| [docs/TASK_VALIDATION_V2.md](docs/TASK_VALIDATION_V2.md) | Reviewed-completion validation model |
| [docs/ZK_PRIVATE_FLOW.md](docs/ZK_PRIVATE_FLOW.md) | Private-completion + zk-config flow |
| [docs/MARKETPLACE_V2_BID_PROTOCOL.md](docs/MARKETPLACE_V2_BID_PROTOCOL.md) | Bid-book RFC |

AI agents working in this repo: also read **[CLAUDE.md](CLAUDE.md)** for the build gate,
conventions, and the local-only / migration-sensitivity rules.

## License

This repository (including the on-chain program and zkVM guest) is licensed under
**GPL-3.0** (see [LICENSE](LICENSE)). The published npm packages are licensed under
**MIT** so they can be embedded anywhere:

- [`@tetsuo-ai/marketplace-sdk`](packages/sdk-ts/LICENSE) — MIT
- [`@tetsuo-ai/protocol`](packages/protocol/LICENSE) — MIT
