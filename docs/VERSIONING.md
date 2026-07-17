# VERSIONING — cross-package support matrix & deprecation contract (WP-D3)

> **STATUS: ACTIVE CONTRACT (written 2026-07-03).** This document is the
> human-maintained source of truth for **which published package versions speak the
> wire of the live mainnet program**, and the release contract every future breaking
> change must follow. It complements [`VERSIONS.md`](./VERSIONS.md) (the P6.5
> *on-chain* surface-revision mechanism — how a client detects what is deployed);
> this file is the *off-chain* matrix — which npm versions a consumer may pin, and
> what happens to old pins when the program changes.

Program: `agenc-coordination` — `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`,
Solana **mainnet**. Upgradeable (2-of-3 multisig upgrade authority, see
[`UPGRADE_AUTHORITY.md`](./UPGRADE_AUTHORITY.md)); one program ID across every
surface revision, so **the address alone never tells you the wire format** — the
matrix below and `getDeployedSurface` do.

---

## 1. Support matrix

### 1.1 Current compatible set (as of 2026-07-09)

The live program wire is the **full 99-instruction surface**
(`surface_revision = 4`, batch-4 goods; last deployed 2026-07-09, slot
431918664, via the Squads 2-of-3), with **356 program error variants
(6000–6355)**. Its gate shapes descend from the **P1.2 hardened open roster**
build (deployed 2026-07-03, slot 430491216): moderation-consumption gates at
**9/14/13 accounts** with a required trailing `moderator: Pubkey` argument.
The **batch-2 upgrade** (2026-07-05, `surface_revision = 2`) was **additive** —
**90 → 94 instructions** (store identity lifecycle + `moderation_heartbeat`) and
the dispute referrer legs — with **no flag-day wire change**: every P1.2-wire
client keeps working, which is why the sdk range below spans several minor lines.
The **batch-3 upgrade** (2026-07-05, `surface_revision = 3`) added the contest
model (**94 → 96 instructions**, submission-rent return + ghost-split +
`reclaim_terminal_claim`) with two narrow additive ABI extensions (optional
accounts appended). The **batch-4 upgrade** (2026-07-09, `surface_revision = 4`)
added the **goods market** (**96 → 99 instructions**: `create_goods_listing`,
`purchase_good`, `update_goods_listing` — rivalrous direct-buy with per-unit
`SaleReceipt` provenance and the protocol fee on every sale), fully additive;
the goods surface is revision-gated, so pre-0.11 SDKs simply do not expose it.
The authoritative per-instruction wire reference (accounts, flags, PDA seeds,
args) is generated from the committed IDL at
[`reference/INSTRUCTIONS.md`](./reference/INSTRUCTIONS.md) (errors:
[`reference/ERRORS.md`](./reference/ERRORS.md)); `npm run check:idl-reference`
keeps it from drifting.

**This is the wire-compatible published set today:**

| Package | Compatible range | Notes |
|---|---|---|
| `@tetsuo-ai/protocol` | **0.3.x** (latest 0.3.0) | generated IDL + types for the 99-ix surface (356 error variants); 0.3.0 shipped with batch-4 |
| `@tetsuo-ai/marketplace-sdk` | **0.8.x – 0.11.x** (latest 0.11.0) | 0.8.0 = the P1.2 wire cutover; 0.9.0 adds the additive batch-2 store surface; 0.10.0 adds the batch-3 contest facade; 0.10.1 decoder hardening; **0.11.0 adds the batch-4 goods facade + the revision-gated `goods` capability** |
| `@tetsuo-ai/marketplace-react` | **0.4.x** (latest 0.4.1) | |
| `@tetsuo-ai/marketplace-tools` | **0.4.x** (latest 0.4.0) | |
| `@tetsuo-ai/marketplace-mcp` | **0.4.x** (latest 0.4.0) | |
| `@tetsuo-ai/marketplace-moderation` | **0.1.x** (latest 0.1.0) | first published alongside the roster work |
| `@tetsuo-ai/agenc-cli` | **0.2.x** (latest 0.2.0) | CLI against the live 99-ix surface |
| `@tetsuo-ai/agenc-worker` | **0.1.x** (latest 0.1.1) | worker daemon against the live 99-ix surface |
| `@tetsuo-ai/store-core` | **0.5.x – 0.6.x** (latest 0.6.0) | 0.5.x speaks the same wire; 0.6.0 is additive |
| `create-agenc-store` | **0.5.x – 0.6.x** (latest 0.6.0) | scaffolds the template pins below |

Every published major/minor **below** these ranges fails **closed** against mainnet
today (transactions reject at Borsh decode or account resolution — no funds at
risk, but the flow is down). See §1.2 for exactly which upgrade broke which range.

### 1.2 Break-event history (why this document exists)

| Date | Event | Program surface | Gate shapes | What broke (fails closed since that date) | Deprecation window given |
|---|---|---|---|---|---|
| 2026-06-11 | **Full-surface upgrade** (Phase 9, [`MAINNET_ROLLOUT_RUNBOOK.md`](./MAINNET_ROLLOUT_RUNBOOK.md)) | 25 ix → **84 ix**, `surface_revision` stamped FULL | — | sdk **0.3.0** Borsh-broke; templates in the wild still scaffolded that pin | **ZERO** — no announcement preceded the deploy |
| 2026-07-02 | **WP-A1 roster gates** | 84 ix (gate hardening) | **8/13/12** accounts | sdk **≤0.6.x**, react **≤0.2.x**, tools+mcp **≤0.2.0** | Same-day lockstep republish (sdk 0.7.0, react/tools/mcp 0.3.0, store 0.3.0); no advance notice |
| 2026-07-03 | **P1.2 hardened open roster** ([`P1_2_OPEN_ROSTER_SPEC.md`](./P1_2_OPEN_ROSTER_SPEC.md)) | 84 ix → **90 ix** | **9/14/13** accounts + required trailing `moderator` arg | sdk **0.7.x**, react/tools/mcp **0.3.x**, store-core **≤0.4.x** | Same-day lockstep republish (§2.6 runbook pattern): sdk 0.8.0, react/tools/mcp 0.4.0, store-core/create 0.4.0 |
| 2026-07-05 | **Batch-2 store + heartbeat** | 90 → **94 ix**, `surface_revision = 2` | additive (no flag-day gate change) | none (old pins keep working) | sdk **0.9.0** additive facade |
| 2026-07-05 | **Batch-3 contest** ([`design/batch-3-contest-tasks.md`](./design/batch-3-contest-tasks.md)) | 94 → **96 ix**, `surface_revision = 3` | additive optional accounts | none | sdk **0.10.0** / **0.10.1** additive facade |
| 2026-07-09 | **Batch-4 goods** ([`design/batch-4-goods.md`](./design/batch-4-goods.md)) | 96 → **99 ix**, `surface_revision = 4` | goods handlers require rev ≥ 4 | none for pre-goods flows; goods needs sdk **≥ 0.11.0** | sdk **0.11.0**, protocol **0.3.0** |

The 2026-06-11 row is the motivating failure: a flag-day wire change shipped with
no deprecation window while the old sdk pin was still being scaffolded by public
templates. The contract in §2 exists so that never happens again.

---

## 2. The contract going forward

### 2.1 Capability detection is REQUIRED in first-party consumers

Every first-party consumer (react/tools/mcp packages, store-core, the store
templates, agenc.ag, the marketplace kit) MUST gate surface-dependent flows on the
SDK's capability API instead of assuming a deploy state:

- `getDeployedSurface(rpc)` — reads the live `ProtocolConfig.surface_revision`
  size-tolerantly and returns a `CapabilitySet` (never throws on old layouts).
- `capabilitiesForRevision(revision)` — pure mapping, for tests/offline use.
- `assertCapability(surface, capability)` — throws a typed
  `SurfaceNotDeployedError` **before** a transaction that the cluster would reject.

All three are exported from the `@tetsuo-ai/marketplace-sdk` root (implementation:
[`packages/sdk-ts/src/facade/surface.ts`](../packages/sdk-ts/src/facade/surface.ts),
re-exported in [`packages/sdk-ts/src/index.ts`](../packages/sdk-ts/src/index.ts)).
Mechanism details and the revision table: [`VERSIONS.md`](./VERSIONS.md).

### 2.2 Breaking wire changes are announced BEFORE the program deploys

A breaking wire change (instruction args, account order/count, seeds, layout) MUST,
**before** the on-chain deploy:

1. update the §1 support matrix in this file (new row in §1.2, new ranges in §1.1);
2. carry an explicit breaking-change announcement **in the release notes of the npm
   versions** that implement the new wire, **and in the marketplace binary release
   notes** (`tetsuo-ai/agenc-marketplace-releases`).

The model is the P1.2 cutover choreography —
[`MAINNET_ROLLOUT_RUNBOOK.md`](./MAINNET_ROLLOUT_RUNBOOK.md) **§2.6**: packages
regenerated and tested on-branch first, program upgrade, then immediate lockstep
publish to minimize the skew window, then dependent services (attest.agenc.ag)
redeployed on the new client.

### 2.3 Deprecation-window policy

- **Additive changes** (new instruction, appended account field behind a migration,
  new SDK export — e.g. sdk 0.8.1's `settlementReceiptUrl`): **no window needed**.
  Publish as a minor/patch; old clients keep working.
- **Flag-day wire changes** (old clients fail closed, as in all three §1.2 events):
  - ALL first-party packages are republished **the same day** (lockstep), per §2.6
    of the runbook;
  - the old majors/minors are documented as **fail-closed immediately** in §1.2 —
    no grace period is promised for the old wire, because the program cannot serve
    both shapes;
  - the quickstart and the store templates/`create-agenc-store` pins are bumped
    **the same day**, so nothing public scaffolds a dead pin (the 2026-06-11
    failure mode).
- **On-chain account layouts** remain append-only with migrations — that policy
  lives in [`VERSIONS.md`](./VERSIONS.md) ("Deprecation policy") and is unchanged.

### 2.4 Template/starter pins must sit inside the matrix (enforced)

The `agenc-store-templates` repo (source of the three store templates and the
`create-agenc-store` scaffolder) enforces this mechanically: `npm run check:pins`
(`scripts/check-pins.mjs`) asserts every `@tetsuo-ai/marketplace-*` and
`@tetsuo-ai/store-core` pin's minimum resolvable version falls inside the §1.1
ranges, and fails with instructions to update its `SUPPORT_MATRIX` constant
alongside any lockstep republish.

CI is deliberately disabled in these repos (cost), so this check runs as part of
the **pre-release gate** (the local check-script pass before any publish/deploy),
not GitHub Actions. A lockstep republish (§2.3) MUST include: bump template pins →
update the script's `SUPPORT_MATRIX` → `npm run check:pins` green → publish.

---

## 3. Maintenance

Update this file **in the same release window** as any of:

- a program deploy that changes the wire (add a §1.2 row, rewrite §1.1);
- a lockstep npm republish (rewrite §1.1 ranges);
- a change to the capability-detection exports (§2.1 links).

Related: [`VERSIONS.md`](./VERSIONS.md) (on-chain surface detection),
[`MAINNET_MAINLINE.md`](./MAINNET_MAINLINE.md) (live deployment record),
[`MAINNET_ROLLOUT_RUNBOOK.md`](./MAINNET_ROLLOUT_RUNBOOK.md) (deploy choreography,
§2.6 flag-day pattern), [`P1_2_OPEN_ROSTER_SPEC.md`](./P1_2_OPEN_ROSTER_SPEC.md)
(the current wire's spec).
