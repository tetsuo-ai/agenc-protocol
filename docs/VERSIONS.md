# VERSIONS — surface-versioning compatibility matrix (P6.5)

One program ID (`HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`) can serve **two
instruction surfaces**:

- the restricted **25-instruction canary** surface (`--features mainnet-canary`) —
  a conservative BUILD that still exists in the source; and
- the **full surface** (99 instructions at the current revision, default features).

> **As of 2026-07-09 the revision-4 99-instruction surface is live on mainnet**
> (`surface_revision = 4`, contests and goods included, all task types enabled,
> bid marketplace live, `ZkConfig` deferred). The canary build is no longer what is live on mainnet; it
> remains the surface for any cluster still running `--features mainnet-canary`.

Because both surfaces can share one program ID, a client cannot tell which one is live
just from the address. P6.5 makes that knowable on-chain and answerable from the SDK.

## How a client asks "what is live?"

`ProtocolConfig` carries a `surface_revision: u16` (appended in P6.5):

| `surface_revision` | Meaning | `getDeployedSurface(rpc)` returns |
|--------------------|---------|-----------------------------------|
| `0` | Unstamped / conservative (canary, or a config not yet stamped) | every capability `false` (`listings:false`, …) |
| `1` (`SURFACE_REVISION_FULL`) | Historical base full surface: 84 ix | all base full-surface capabilities `true`; `goods:false` |
| `2` (`SURFACE_REVISION_BATCH2`) | Batch-2 surface: 94 ix — store identity, moderation liveness deadman, dispute/freeze-exit referrer legs, `rate_hire` rollup | base capabilities `true`; `goods:false` |
| `3` (`SURFACE_REVISION_BATCH3`) | Batch-3 contest surface: 96 ix — submission-rent return, contests, ghost-share distribution, and terminal-claim reclaim | base capabilities `true`; `goods:false` |
| `4` (`SURFACE_REVISION_BATCH4`) | Current surface: 99 ix — finite goods listings, direct purchase, and permanent sale receipts | every capability `true`, including `goods:true` |

`getDeployedSurface` **tolerates the pre-migration on-chain layout**: before the
2026-06-11 migration the live mainnet `ProtocolConfig` was the OLD 349-byte layout with
no `surface_revision` (it is now the migrated 351-byte layout stamped
revision `1`). The SDK reads the raw account bytes and treats any account
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
with `target_version == current_version` = `1` for the realloc-only path). An operator
then stamps the real revision via **`update_launch_controls`** (existing multisig
config-update authority; rejects unknown revisions with `InvalidSurfaceRevision`).

A **fresh full-surface deploy** stamps `SURFACE_REVISION_FULL` in
`initialize_protocol`, so it advertises the base full capabilities with no manual step.
Goods handlers remain disabled until an operator stamps revision `4`; a fresh **canary**
deploy stamps `0`.

## Compatibility matrix (program build ↔ SDK semver ↔ cluster)

> This matrix is the human-maintained source of truth; the release workflow updates it
> in the same window as a deploy or an SDK publish.

| Program build | Live surface | Cluster | `surface_revision` | SDK semver | `getDeployedSurface().listings` |
|---|---|---|---|---|---|
| full | **99 ix** | **mainnet** (live as of 2026-07-09) | `4` (BATCH4) | `@tetsuo-ai/marketplace-sdk` 0.8.x–0.11.x; goods facade in 0.11.x | `true` |
| full | 99 ix | devnet / localnet | `1`–`4` | 0.8.x–0.11.x | `true` (goods only at revision 4) |
| full | 84 ix | mainnet (HISTORICAL, 2026-06-11 to 2026-07-02) | `1` (FULL) | ≥ 0.6.0 | `true` |
| `mainnet-canary` | 25 ix | mainnet (HISTORICAL, pre-2026-06-11) | absent (349B) / `0` | ≥ 0.4.0 | `false` (fallback) |

Current local release targets at the time of writing: `@tetsuo-ai/protocol` `0.3.0`,
`@tetsuo-ai/marketplace-sdk` `0.11.0`. The SDK includes `getDeployedSurface`, the
99-instruction generated client, referrer fields, contest helpers, and the
revision-gated goods facade.

## Release runbook — `anchor idl init` per cluster (fetchable on-chain IDL)

The deployed IDL should be **fetchable truth per cluster**, so a client can confirm the
surface independently of this repo. Wire the following into the release runbook for any
program deploy/upgrade:

1. Build the surface for the target cluster:
   - mainnet canary: `npm run canary:build && npm run canary:idl && npm run canary:check-idl`
     (the IDL surface must stay at exactly **25** instructions — `check-canary-idl.mjs`).
   - dev/devnet full: `anchor build` then `npm run artifacts:refresh && npm run artifacts:check`.
2. Publish the on-chain IDL for that cluster (first deploy) / upgrade it (subsequent):
   ```bash
   # first time on a cluster:
   anchor idl init   <PROGRAM_ID> -f target/idl/agenc_coordination.json --provider.cluster <devnet|mainnet>
   # later upgrades on that cluster:
   anchor idl upgrade <PROGRAM_ID> -f target/idl/agenc_coordination.json --provider.cluster <devnet|mainnet>
   ```
   Publish the IDL that matches the surface actually live on the target cluster.
   Mainnet now runs the full surface, so publish the full `agenc_coordination.json`
   there; only a cluster still running the `--features mainnet-canary` build takes the
   25-instruction `agenc_coordination.canary.json`. The on-chain IDL must match the
   surface that is actually live.
3. Run the **169-task + single-config migration choreography** (binary-first → migrate
   all live accounts → version/surface stamp last). `migrate_protocol` reallocs the
   config; `migrate_task` reallocs the live tasks (169 at the 2026-06-11 mainnet
   upgrade). Both are idempotent and multisig-gated.

   **Precondition — `migrate_protocol` MUST be the FIRST post-deploy call.** Because
   `ProtocolConfig` grew (349B → 351B) when `surface_revision` was appended, after the new
   binary is deployed but BEFORE `migrate_protocol` runs, the single live config account is
   still 349 bytes (this was the state during the 2026-06-11 upgrade). Every instruction
   that takes a **typed** `Account<ProtocolConfig>` then
   fails at Anchor account resolution with `AccountDidNotDeserialize` (borsh: "Unexpected
   length of input") — it cannot deserialize a 349B buffer into the now-351B struct. So the
   normal surface is effectively frozen until the config is grown. Run `migrate_protocol`
   (the realloc-only path, `target_version == current_version == 1`) first to restore normal
   operation, then sweep the tasks.

   `migrate_protocol` and `migrate_task` are themselves **order-independent** between each
   other: both take the config as a RAW `UncheckedAccount` and hand-decode it
   size-tolerantly, so `migrate_task` succeeds against BOTH the 349B (pre-`migrate_protocol`)
   and 351B (post) config. The natural "migrate the tasks, then the config" order is
   therefore safe. The first-call constraint above is about restoring the rest of the live
   surface (every typed-`Account<ProtocolConfig>` instruction), not about the migration pair.
4. **Stamp the surface**: `update_launch_controls(..., surface_revision)` —
   stamp the highest revision actually verified live (`4` for the current mainnet
   surface); otherwise leave `0` or the last verified lower revision.
5. Update the matrix above (program build, cluster, `surface_revision`, SDK semver) and
   `docs/MAINNET_MAINLINE.md` in the same release window.

## Deprecation policy (written)

- **Append-only accounts.** `ProtocolConfig` / `Task` fields are never reordered or
  removed; new fields are appended and covered by a `migrate_*` instruction and a size
  `const_assert`. A removed field would invalidate the live-account prefix.
- **Surface revisions are monotonic and additive.** A new `surface_revision` only adds
  capabilities; `getDeployedSurface` maps any revision `≥ SURFACE_REVISION_FULL` to the
  full set, and unknown/lower values fall back to the conservative set. Retiring a
  capability is a NEW revision plus an SDK minor that maps it — never a silent change of
  an existing revision's meaning.
- **Conservative by default.** Any ambiguity (old layout, missing account, unknown
  revision) resolves to the smallest safe surface (`false`). Clients fail-closed via
  `SurfaceNotDeployedError`, never by emitting an instruction the cluster lacks.
- **SDK semver.** Adding `getDeployedSurface` and capability types is a **minor** bump
  (additive). Changing the meaning of an existing `CapabilitySet` field or an existing
  `surface_revision` is a **major** bump.
