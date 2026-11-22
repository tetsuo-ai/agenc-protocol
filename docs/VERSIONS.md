# VERSIONS — surface-versioning compatibility matrix (P6.5)

One program ID (`HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`) can serve two
release profiles:

- the restricted **25-instruction canary** surface (`--features mainnet-canary`) —
  a conservative BUILD that still exists in the source; and
- the full production surface (revision 9 is 106 instructions with default
  features, deployed on mainnet 2026-11-21).

The revision-9 source (accountable review, `SURFACE_REVISION_CURRENT = 9`),
deployed on mainnet since 2026-11-21, has 106 production instructions and the
`feedAuthorityVotes` (revision 6), `taskCreationQuotas` (revision 7),
`feeQualifiedRatings` (revision 8) and `accountableReview` (revision 9)
capabilities. It retains the 25-instruction canary. An explicit
development-only `private-zk` feature adds three quarantined proof
instructions, producing a 109-instruction development build. It is not a
release surface and the deployment preflight rejects a production build or IDL
that contains it. Its client train (protocol 0.6.0, SDK 0.14.0 and the rest,
see [`VERSIONING.md`](./VERSIONING.md) §1.1.3) is published. See
[Revision 9 notes](./PROGRAM_SURFACE.md#revision-9-notes).

> **As of 2026-11-21 the full 106-instruction revision-9 surface is deployed on
> mainnet** (`surface_revision = 9` / `SURFACE_REVISION_ACCOUNTABLE_REVIEW`,
> release commit `154d286659592c799bd111bf416fdba7ccc704b4`, deployment slot
> 472177819, normalized executable hash
> `baf5be55c86f0a5c79eb52229a3412121a1a3c5f2a5699f4b24d75c7e8dc3608`,
> `disabled_task_type_mask = 0`. Private-ZK instructions are absent from the
> production ABI). The protocol was reopened at 2026-11-21 19:19:26 UTC
> (`update_launch_controls`, slot 472253687). The prior 104-instruction
> revision-8 surface (`surface_revision = 8` /
> `SURFACE_REVISION_FEE_QUALIFIED_RATINGS`, release commit `f39b383…`, slot
> 462468899, normalized executable hash `ffb8f3cb…`) was live 2026-10-28 to
> 2026-11-21. Revisions 6 and 7 were never stamped on mainnet on their own. The
> 101-instruction revision-5 surface (`surface_revision = 5` /
> `AUDIT_HARDENING`, slot 434489452, executable SHA-256
> `049a66e30da166c1e02ee379993425c32386f774fd9ff8861153e21900b496f2`) was live
> 2026-07-22 to 2026-10-28. The 99-instruction revision-4 surface
> (`surface_revision = 4` / `BATCH4`, slot 431918664) was live 2026-07-09 to
> 2026-07-22. The canary build is
> no longer what is live on mainnet; it remains the surface for any cluster still
> running `--features mainnet-canary`. Deploy SoT:
> [`MAINNET_MAINLINE.md`](./MAINNET_MAINLINE.md).

Because both surfaces can share one program ID, a client cannot tell which one is live
just from the address. P6.5 makes that knowable on-chain and answerable from the SDK.

## How a client asks "what is live?"

`ProtocolConfig` carries a `surface_revision: u16` (appended in P6.5):

| `surface_revision` | Meaning | `getDeployedSurface(rpc)` returns |
|--------------------|---------|-----------------------------------|
| `0` | Unstamped / conservative (canary, or a config not yet stamped) | every capability `false` (`listings:false`, … `goods:false`) |
| `1` (`SURFACE_REVISION_FULL`) | Full surface stamp (historically 84-ix Phase 9; P1.2 90-ix kept stamp 1) | full-surface capabilities `true`; **`goods: false`** |
| `2` (`SURFACE_REVISION_BATCH2`) | Batch-2: **94 ix** — store identity, moderation heartbeat, dispute/freeze-exit referrer legs, `rate_hire` rollup | full-surface capabilities `true`; **`goods: false`** |
| `3` (`SURFACE_REVISION_BATCH3`) | Batch-3 contest: **96 ix** — submission-rent return, contest rails (`distribute_ghost_share`, `reclaim_terminal_claim`, entry deposit, selection window) | full-surface capabilities `true`; **`goods: false`** |
| `4` (`SURFACE_REVISION_BATCH4`) | Batch-4 goods: **99 ix** — `create_goods_listing` / `purchase_good` / `update_goods_listing` (handlers require `surface_revision >= 4`) | full-surface capabilities `true`; **`goods: true`** |
| `5` (`SURFACE_REVISION_AUDIT_HARDENING`) | **Live on mainnet 2026-07-22 to 2026-10-28 (superseded).** 2026-07 audit-hardening contract: **101 production ix**; retires the three unaudited private-ZK entrypoints, adds orphan-child recovery, the O(1) bid-accept redesign (`promote_bid` / `demote_ineligible_best` / `settle_dispute_claim`), and an atomic release-boundary stamp, and tightens account/finalizer conventions | full-surface capabilities `true`; **`goods: true`** |
| `6` (`SURFACE_REVISION_AUTHORITY_FEED`) | **Never stamped on mainnet on its own; part of revision 8.** 102 production ix; wallet-authority feed receipts, legacy agent-vote writes retired, prospective wallet count separate from history | full-surface capabilities and `goods: true`; **`feedAuthorityVotes: true`** |
| `7` (`SURFACE_REVISION_TASK_QUOTAS`) | **Never stamped on mainnet on its own; part of revision 8.** 103 production ix; optional multisig-approved u32 wallet task quotas preserve default limits and usage | revision-6 capabilities plus **`taskCreationQuotas: true`** |
| `8` (`SURFACE_REVISION_FEE_QUALIFIED_RATINGS`) | **Live on mainnet 2026-10-28 to 2026-11-21 (superseded).** 104 production ix; each new listing or skill rating needs a recorded SOL protocol fee of at least 100,000 lamports; adds the one-time `repair_dispute_initiator_counter` | revision-7 capabilities plus **`feeQualifiedRatings: true`** |
| `9` (`SURFACE_REVISION_ACCOUNTABLE_REVIEW`) | **Live on mainnet since 2026-11-21.** 106 production ix; disputable freezes and dispute bonds, creator records, claim deposits and `release_claim`, `hire_from_listing` v3, compacted task markers, 2-of-3 moderation and suspension | revision-8 capabilities plus **`accountableReview: true`** (SDK 0.14); SDK 0.13 treats 9 as unknown and fails closed |

> **Goods is the first revision-gated capability.** Revisions ≥ 1 still imply the
> pre-goods full capability set (`listings`, `disputes`, `bonds`, …); only
> `goods` requires revision ≥ 4, `feedAuthorityVotes` revision 6,
> `taskCreationQuotas` revision 7, `feeQualifiedRatings` revision 8 and
> `accountableReview` revision 9.
> Unknown revisions fail closed, including revisions greater than the SDK's current value.

`getDeployedSurface` **tolerates the pre-migration on-chain layout**: before the
2026-06-11 migration the live mainnet `ProtocolConfig` was the OLD 349-byte layout with
no `surface_revision` (it is now the migrated 351-byte layout, stamped
revision `1` at migration time and `9` on mainnet today). The SDK reads the raw
account bytes and treats any account
shorter than the new 351-byte layout (or a missing account) as `surface_revision = 0` —
so it returns `listings: false` **without throwing**, never feeding an old account through
the new fixed-size codec.

Facade/client methods that need a full-surface-only capability call `assertCapability`
and throw a typed `SurfaceNotDeployedError` **before** building a transaction that would
otherwise fail with a raw "instruction not found" error.

## ProtocolConfig layout / migration

| | Bytes | Notes |
|---|---|---|
| Pre-P6.5 (`OLD_CONFIG_SIZE`) | **349** | the legacy config layout (the mainnet config before the 2026-06-11 migration) |
| P6.5 (`SIZE`) | **351** | `+2` for `surface_revision: u16`, appended at the END (append-only); the live mainnet config layout as of 2026-06-11 |

The live account is brought forward by **`migrate_protocol`** (realloc 349→351,
zero-init `surface_revision = 0`, multisig-gated, idempotent, version-ungated — call it
with `target_version == current_version` = `1` for the realloc-only path). Historical
revisions `0` to `8` remain selectable while paused through **`update_launch_controls`**
in this source. Its current revision `9` can be established only by
**`stamp_release_surface`**, which atomically verifies the reviewed ProtocolConfig,
singletons, ProgramData metadata, on-chain IDL, and upgrade-custody account.

A **fresh production deploy** initializes with `protocol_paused = true` and
`surface_revision = 0`; initialization alone is not proof that the reviewed
release singletons, IDL, and custody boundary are present. Production reaches
`SURFACE_REVISION_CURRENT` (`9` in this source) only through
`stamp_release_surface`. After that stamp, `update_launch_controls` may unpause
only when the resulting stored revision is CURRENT; rolling back to revision
`0` to `8` pauses conservatively and requires a new atomic stamp before another
unpause. Goods handlers are enabled at every revision `>= 4`. The restricted
**canary** has no atomic stamp instruction, remains at revision `0`, and may be
unpaused on that conservative surface.

## Compatibility matrix (program build ↔ SDK semver ↔ cluster)

> This matrix is the human-maintained source of truth for **on-chain surface
> detection**. For **published npm pin ranges** (which package versions speak the
> live wire), see [`VERSIONING.md`](./VERSIONING.md) §1.1 — that file is the
> consumer support contract.

| Program build | Live surface | Cluster | `surface_revision` | SDK semver | `listings` | `goods` |
|---|---|---|---|---|---|---|
| full (revision 9) | **106 ix** | **mainnet** (live since 2026-11-21) | `9` (ACCOUNTABLE_REVIEW) | `@tetsuo-ai/marketplace-sdk` **0.14.x** (revision-9 client) | `true` | `true` |
| full (revision 8, superseded) | **104 ix** | mainnet (live 2026-10-28 to 2026-11-21) | `8` (FEE_QUALIFIED_RATINGS) | `@tetsuo-ai/marketplace-sdk` **0.13.x** (revision-8 client) | `true` | `true` |
| full (revision 7) | **103 ix** | disposable local validation only; never stamped on mainnet on its own (part of revision 8) | `7` (TASK_QUOTAS) | same SDK **0.13.x** train | `true` | `true` |
| full (revision 6) | **102 ix** | disposable local validation only; never stamped on mainnet on its own (part of revision 8) | `6` (AUTHORITY_FEED) | same SDK **0.13.x** train | `true` | `true` |
| full (revision 5, superseded) | **101 ix** | mainnet (live 2026-07-22 to 2026-10-28) | `5` (AUDIT_HARDENING) | `@tetsuo-ai/marketplace-sdk` **0.12.x** (revision-5 client) | `true` | `true` |
| full (revision 4, superseded) | **99 ix** | mainnet (live 2026-07-09 → 2026-07-22) | `4` (BATCH4) | `@tetsuo-ai/marketplace-sdk` **0.8.x – 0.11.x** (goods facade: **≥ 0.11.0**) | `true` | `true` |
| explicit `private-zk` development build | 109 ix (107 at revision 8) | local development only | not releasable | unsupported | n/a | n/a |
| historical full builds | 84…99 ix | devnet / localnet | `1`…`4` | version-matched client required | `true` if ≥ 1 | `true` only if ≥ 4 |
| `mainnet-canary` | 25 ix | mainnet (HISTORICAL, pre-2026-06-11) | absent (349B) / `0` | ≥ 0.4.0 | `false` | `false` |

The revision-9 program is live on mainnet since 2026-11-21. Its coordinated
client set is protocol 0.6.0 and SDK 0.14.0 (regenerated 106-instruction
clients), published through the tag-driven release workflow before the unpause.
The revision-8 client set (protocol 0.5.2, SDK 0.13.0) spoke the live wire from
2026-10-28 to 2026-11-21. It now fails closed: SDK 0.13 treats revision 9 as an
unknown surface, and revision 9 changed the account lists of existing
instructions. The revision-5 client set (protocol 0.4.0, SDK 0.12.0) spoke the
live wire from 2026-07-22 to 2026-10-28. The prior published revision-4 pins
(`@tetsuo-ai/protocol` 0.3.0,
`@tetsuo-ai/marketplace-sdk` **0.8.x – 0.11.x**) spoke the revision-4 wire and
fail closed against revision 5. See [`VERSIONING.md`](./VERSIONING.md) §1.1 for
the published-pin support contract.

## Release runbook — `anchor idl init` per cluster (fetchable on-chain IDL)

The deployed IDL should be **fetchable truth per cluster**, so a client can confirm the
surface independently of this repo. Wire the following into the release runbook for any
program deploy/upgrade:

1. Build the surface for the target cluster:
   - mainnet canary: `npm run canary:build && npm run canary:idl && npm run canary:check-idl`
     (the IDL surface must stay at exactly **25** instructions — `check-canary-idl.mjs`).
   - dev/devnet full: `anchor build` then `npm run artifacts:refresh && npm run artifacts:check`.
2. Deploy the hash-approved binary, then run the canonical migration **verification/sweep**.
   `scripts/mainnet-upgrade.mjs` reads the live account sizes and runs only the idempotent
   migrations that are actually required; it must never assume a historical account count.
   Mainnet's `ProtocolConfig` is already 351 bytes and its Tasks are already 466 bytes, so
   the revision-5 cutover (2026-07-22) verified those layouts without reallocating
   them. Any newly discovered undersized account is a stop condition until the reviewed
   sweep plan accounts for it.

   **Historical context only:** the 2026-06-11 upgrade grew one 349-byte
   `ProtocolConfig` and 169 Tasks. During that specific binary-first migration window,
   `migrate_protocol` restored typed config reads and `migrate_task` grew each legacy Task.
   Both paths remain idempotent and multisig-gated for recovery, but those historical
   counts and ordering constraints are not instructions for revision 5 or every future
   upgrade.
3. Initialize/verify release singletons, then publish the on-chain IDL and fetch it
   back before advertising the revision. For the full mainnet surface, use
   `scripts/mainnet-upgrade.mjs`: it derives an ABI-complete docs-free projection
   from the hash-approved documented IDL, pins Anchor 0.32.1, verifies the live IDL
   authority and capacity, and checks every published non-`docs` value. Do not invoke
   `anchor idl init/upgrade` directly with the oversized documented full IDL.
4. **Stamp the surface last**: use `update_launch_controls(..., 4)` only for the
   historical revision-4 artifact. Establish the current revision (`9` in this
   source, `8` in the revision-8 source, `5` in the revision-5 source) only with
   the atomic
   `stamp_release_surface` rail after every reviewed dependency is verified and
   locked in that transaction; otherwise leave `0` or the last verified lower
   revision.
5. Update the matrix above (program build, cluster, `surface_revision`, SDK semver) and
   `docs/MAINNET_MAINLINE.md` in the same release window.

## Deprecation policy (written)

- **Append-only accounts.** `ProtocolConfig` / `Task` fields are never reordered or
  removed; new fields are appended and covered by a `migrate_*` instruction and a size
  `const_assert`. A removed field would invalidate the live-account prefix.
- **Surface revisions are monotonic and explicit.** Additive changes are preferred.
  Retiring an unsafe capability requires a new revision plus a coordinated client
  release; it never silently changes an existing revision's meaning. Revision 5 is the
  first such retirement: private-ZK was never advertised by `CapabilitySet`, and its
  three entrypoints are absent from the production build and IDL.
- **Conservative by default.** Any ambiguity (old layout, missing account, unknown
  revision) resolves to the smallest safe surface (`false`). Clients fail-closed via
  `SurfaceNotDeployedError`, never by emitting an instruction the cluster lacks.
- **SDK semver.** Adding `getDeployedSurface` and capability types is a **minor** bump
  (additive). Changing the meaning of an existing `CapabilitySet` field or an existing
  `surface_revision` is a **major** bump.
